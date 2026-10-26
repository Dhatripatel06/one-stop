/* =========================================================
   INVOICES & PAYMENTS
   - Issued only for confirmed (or later) orders — never for quotations.
   - Numbers are sequential per Indian financial year, from a
     transactional counter: OSS/2026-27/0001.
   - Issued invoices are immutable. Lines and totals are never updated;
     a correction means cancelling and issuing a new invoice.
   - Only payment fields, share status and cancellation can change.
========================================================= */

import crypto from "node:crypto";
import { db, FieldValue, Timestamp } from "./firebase.js";
import { Validator } from "./validate.js";
import { HttpError, badRequest, conflict, notFound } from "./http.js";
import { auditEntry, auditRef } from "./audit.js";
import { actorOf } from "./auth.js";
import { computeTotals, paymentStatus } from "../shared/pricing.js";
import { INVOICEABLE_STATUSES, PAYMENT_METHODS } from "../shared/constants.js";
import { getSettings, taxContext } from "./settings.js";

const invoices = () => db().collection("invoices");
const payments = () => db().collection("payments");

function iso(value) {
  if (!value) return null;
  if (typeof value.toDate === "function") return value.toDate().toISOString();
  return value;
}

export function financialYear(date = new Date()) {
  // India: April to March. Uses IST so 31 March late evening counts correctly.
  const ist = new Date(date.getTime() + 5.5 * 60 * 60 * 1000);
  const year = ist.getUTCFullYear();
  const start = ist.getUTCMonth() >= 3 ? year : year - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, "0")}`;
}

/* ---------------------------------------------------------
   BUILD (shared by preview and issue)
--------------------------------------------------------- */

function buildInvoiceData(order, items, settings, placeOfSupply) {
  const pos = placeOfSupply || order.placeOfSupply || order.customer?.stateCode || "";
  if (settings.taxMode === "gst" && !pos) {
    throw badRequest("Select the place of supply (customer state) to calculate GST.", { fields: { placeOfSupply: "Required for GST." } });
  }
  const tax = taxContext(settings, pos);
  const sorted = [...items].sort((a, b) => a.lineNo - b.lineNo);
  const totals = computeTotals(sorted, tax, { roundOff: settings.roundOff });
  if (!totals.priced) throw conflict("Every item needs a price before an invoice can be issued.");

  const { lines, ...summary } = totals;
  return {
    documentTitle: tax.mode === "gst" && settings.gstin ? "Tax Invoice" : "Invoice",
    seller: {
      businessName: settings.businessName,
      tagline: settings.tagline,
      phone: settings.phone,
      whatsapp: settings.whatsapp,
      email: settings.email,
      address: settings.address,
      gstin: settings.gstin,
      stateCode: settings.stateCode,
      instagram: settings.instagram,
      logo: settings.logo
    },
    customer: order.customer,
    placeOfSupply: pos,
    lines: lines.map(line => ({
      lineNo: line.lineNo,
      productId: line.productId,
      sku: line.sku,
      name: line.name,
      hsn: line.hsn || "",
      unit: line.unit || "pcs",
      qty: line.qty,
      listPrice: line.listPrice,
      unitPrice: line.unitPrice,
      gross: line.gross,
      discount: line.discount,
      taxable: line.taxable,
      gstRate: line.gstRate,
      cgst: line.cgst,
      sgst: line.sgst,
      igst: line.igst,
      taxAmount: line.taxAmount,
      total: line.total
    })),
    totals: summary,
    taxSnapshot: { mode: tax.mode, pricesIncludeTax: tax.pricesIncludeTax, interState: tax.interState },
    terms: settings.invoiceTerms || "",
    notes: settings.invoiceNotes || "",
    paymentDetails: settings.paymentDetails || ""
  };
}

export async function previewInvoice(orderId, input) {
  const ref = db().collection("orders").doc(orderId);
  const [snap, items, settings] = await Promise.all([ref.get(), ref.collection("items").get(), getSettings()]);
  if (!snap.exists) throw notFound("Order not found.");
  const order = snap.data();
  const data = buildInvoiceData(order, items.docs.map(doc => doc.data()), settings, input?.placeOfSupply);
  return {
    ...data,
    preview: true,
    invoiceNo: "(assigned when issued)",
    orderId,
    orderNo: order.orderNo,
    status: "preview",
    issuedAt: new Date().toISOString(),
    amountPaid: 0,
    balanceDue: data.totals.grandTotal,
    paymentStatus: "unpaid"
  };
}

/* ---------------------------------------------------------
   ISSUE
--------------------------------------------------------- */

export async function issueInvoice(orderId, input, admin) {
  const actor = actorOf(admin);
  const v = new Validator(input);
  const placeOfSupply = v.string("placeOfSupply", { max: 2, pattern: /^\d{2}$/, label: "Place of supply" });
  v.assert();

  const orderRef = db().collection("orders").doc(orderId);
  const invoiceRef = invoices().doc();

  await db().runTransaction(async tx => {
    // ---- reads
    const snap = await tx.get(orderRef);
    if (!snap.exists) throw notFound("Order not found.");
    const order = snap.data();
    const itemSnaps = await tx.get(orderRef.collection("items"));
    const settings = await getSettings(tx);
    const fy = financialYear();
    const counterRef = db().collection("counters").doc(`invoices-${fy}`);
    const counter = await tx.get(counterRef);
    const customerRef = db().collection("customers").doc(order.customerId);
    const customer = await tx.get(customerRef);
    const existing = order.invoiceId ? await tx.get(invoices().doc(order.invoiceId)) : null;

    // ---- validation
    if (!INVOICEABLE_STATUSES.includes(order.status)) {
      throw conflict("Confirm the order before issuing an invoice. Pending orders are quotations, not invoices.");
    }
    if (existing?.exists && existing.get("status") === "issued") {
      throw conflict(`Invoice ${existing.get("invoiceNo")} is already active for this order.`);
    }
    const data = buildInvoiceData(order, itemSnaps.docs.map(doc => doc.data()), settings, placeOfSupply);

    // ---- writes
    const seq = (counter.exists ? counter.get("seq") : 0) + 1;
    const invoiceNo = `${settings.invoicePrefix || "OSS"}/${fy}/${String(seq).padStart(4, "0")}`;
    tx.set(counterRef, { seq }, { merge: true });

    tx.set(invoiceRef, {
      ...data,
      invoiceNo,
      fy,
      seq,
      orderId,
      orderNo: order.orderNo,
      customerId: order.customerId,
      status: "issued",
      amountPaid: 0,
      balanceDue: data.totals.grandTotal,
      paymentStatus: "unpaid",
      share: { status: "ready", events: [] },
      replaces: order.previousInvoice || null,
      issuedAt: FieldValue.serverTimestamp(),
      issuedBy: actor
    });
    tx.update(orderRef, {
      invoiceId: invoiceRef.id,
      invoiceNo,
      placeOfSupply: data.placeOfSupply,
      updatedAt: FieldValue.serverTimestamp()
    });
    if (customer.exists) {
      tx.update(customerRef, { totalBilled: FieldValue.increment(data.totals.grandTotal), updatedAt: FieldValue.serverTimestamp() });
    }
    tx.set(auditRef(), auditEntry(actor, "invoice.issue", "invoice", invoiceRef.id, { invoiceNo, orderNo: order.orderNo, grandTotal: data.totals.grandTotal }));
  });

  return getInvoice(invoiceRef.id);
}

/* ---------------------------------------------------------
   CANCEL
--------------------------------------------------------- */

export async function cancelInvoice(id, input, admin) {
  const actor = actorOf(admin);
  const v = new Validator(input);
  const reason = v.string("reason", { required: true, min: 3, max: 300, label: "Reason" });
  v.assert();

  const ref = invoices().doc(id);
  await db().runTransaction(async tx => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw notFound("Invoice not found.");
    const invoice = snap.data();
    const customerRef = db().collection("customers").doc(invoice.customerId);
    const customer = await tx.get(customerRef);

    if (invoice.status !== "issued") throw conflict("This invoice is already cancelled.");
    if ((invoice.amountPaid || 0) > 0) {
      throw conflict("Payments are recorded against this invoice. Void those payments before cancelling it.");
    }

    tx.update(ref, {
      status: "cancelled",
      balanceDue: 0,
      cancelReason: reason,
      cancelledAt: FieldValue.serverTimestamp(),
      cancelledBy: actor
    });
    if (customer.exists) {
      tx.update(customerRef, { totalBilled: FieldValue.increment(-invoice.totals.grandTotal), updatedAt: FieldValue.serverTimestamp() });
    }
    tx.update(db().collection("orders").doc(invoice.orderId), {
      invoiceId: null,
      invoiceNo: null,
      previousInvoice: { id, invoiceNo: invoice.invoiceNo },
      updatedAt: FieldValue.serverTimestamp()
    });
    tx.set(auditRef(), auditEntry(actor, "invoice.cancel", "invoice", id, { invoiceNo: invoice.invoiceNo, reason }));
  });
  return getInvoice(id);
}

/* ---------------------------------------------------------
   PAYMENTS
--------------------------------------------------------- */

export async function recordPayment(invoiceId, input, admin) {
  const actor = actorOf(admin);
  const v = new Validator(input);
  const amount = v.money("amount", { required: true, label: "Amount" });
  const method = v.oneOf("method", Object.keys(PAYMENT_METHODS), { required: true, label: "Method" });
  const reference = v.string("reference", { max: 120 });
  const note = v.string("note", { max: 300 });
  const date = v.string("date", { pattern: /^\d{4}-\d{2}-\d{2}$/, label: "Payment date" }) || new Date().toISOString().slice(0, 10);
  if (amount === 0) v.fail("amount", "Amount must be more than zero.");
  v.assert();

  const ref = invoices().doc(invoiceId);
  const paymentRef = payments().doc();

  await db().runTransaction(async tx => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw notFound("Invoice not found.");
    const invoice = snap.data();
    const customerRef = db().collection("customers").doc(invoice.customerId);
    const customer = await tx.get(customerRef);

    if (invoice.status !== "issued") throw conflict("Payments can only be recorded on an active invoice.");
    if (amount > invoice.balanceDue) {
      throw badRequest("Amount is more than the balance due.", { fields: { amount: "Amount is more than the balance due." } });
    }

    const amountPaid = (invoice.amountPaid || 0) + amount;
    tx.set(paymentRef, {
      invoiceId, invoiceNo: invoice.invoiceNo, orderId: invoice.orderId, customerId: invoice.customerId,
      amount, method, reference, note, date, status: "recorded",
      recordedAt: FieldValue.serverTimestamp(), recordedBy: actor
    });
    tx.update(ref, {
      amountPaid,
      balanceDue: invoice.totals.grandTotal - amountPaid,
      paymentStatus: paymentStatus(invoice.totals.grandTotal, amountPaid)
    });
    if (customer.exists) tx.update(customerRef, { totalPaid: FieldValue.increment(amount) });
    tx.set(auditRef(), auditEntry(actor, "payment.record", "invoice", invoiceId, { invoiceNo: invoice.invoiceNo, amount, method }));
  });
  return getInvoice(invoiceId);
}

export async function voidPayment(paymentId, input, admin) {
  const actor = actorOf(admin);
  const v = new Validator(input);
  const reason = v.string("reason", { required: true, min: 3, max: 300, label: "Reason" });
  v.assert();

  const paymentRef = payments().doc(paymentId);
  let invoiceId;
  await db().runTransaction(async tx => {
    const paymentSnap = await tx.get(paymentRef);
    if (!paymentSnap.exists) throw notFound("Payment not found.");
    const payment = paymentSnap.data();
    invoiceId = payment.invoiceId;
    const ref = invoices().doc(payment.invoiceId);
    const snap = await tx.get(ref);
    const customerRef = db().collection("customers").doc(payment.customerId);
    const customer = await tx.get(customerRef);
    if (payment.status === "void") throw conflict("This payment is already void.");

    const invoice = snap.data();
    const amountPaid = Math.max(0, (invoice.amountPaid || 0) - payment.amount);
    tx.update(paymentRef, { status: "void", voidReason: reason, voidedAt: FieldValue.serverTimestamp(), voidedBy: actor });
    tx.update(ref, {
      amountPaid,
      balanceDue: invoice.status === "issued" ? invoice.totals.grandTotal - amountPaid : 0,
      paymentStatus: paymentStatus(invoice.totals.grandTotal, amountPaid)
    });
    if (customer.exists) tx.update(customerRef, { totalPaid: FieldValue.increment(-payment.amount) });
    tx.set(auditRef(), auditEntry(actor, "payment.void", "invoice", payment.invoiceId, { paymentId, amount: payment.amount, reason }));
  });
  return getInvoice(invoiceId);
}

/* ---------------------------------------------------------
   READ
--------------------------------------------------------- */

function invoiceView(doc) {
  const data = doc.data();
  return {
    id: doc.id,
    ...data,
    issuedAt: iso(data.issuedAt),
    cancelledAt: iso(data.cancelledAt),
    share: {
      ...(data.share || { status: "ready", events: [] }),
      events: (data.share?.events || []).map(event => ({ ...event, at: iso(event.at) }))
    }
  };
}

export async function getInvoice(id) {
  const [snap, paymentSnap] = await Promise.all([
    invoices().doc(id).get(),
    payments().where("invoiceId", "==", id).get()
  ]);
  if (!snap.exists) throw notFound("Invoice not found.");
  return {
    ...invoiceView(snap),
    payments: paymentSnap.docs
      .map(doc => ({ id: doc.id, ...doc.data(), recordedAt: iso(doc.get("recordedAt")), voidedAt: iso(doc.get("voidedAt")) }))
      .sort((a, b) => String(a.recordedAt).localeCompare(String(b.recordedAt)))
  };
}

export async function getInvoiceDoc(id) {
  const snap = await invoices().doc(id).get();
  if (!snap.exists) throw notFound("Invoice not found.");
  return invoiceView(snap);
}

export async function listInvoices({ q, paymentStatus: payStatus, limit = 25, before } = {}) {
  const size = Math.min(Number(limit) || 25, 100);
  const query = String(q || "").trim();
  if (query) {
    const upper = query.toUpperCase();
    const field = upper.startsWith("ORD-") ? "orderNo" : "invoiceNo";
    const snap = await invoices().where(field, "==", upper).get();
    return { items: snap.docs.map(invoiceView), next: null };
  }
  let ref = payStatus
    ? invoices().where("status", "==", "issued").where("paymentStatus", "==", payStatus).orderBy("issuedAt", "desc")
    : invoices().orderBy("issuedAt", "desc");
  if (before) ref = ref.startAfter(Timestamp.fromDate(new Date(before)));
  const snap = await ref.limit(size).get();
  const items = snap.docs.map(invoiceView);
  return { items, next: items.length === size ? items[items.length - 1].issuedAt : null };
}

/* ---------------------------------------------------------
   SHARING
   WhatsApp click-to-chat links cannot attach files, so we never claim an
   invoice was delivered. Events record what the admin did; "sent" is set
   only when the admin confirms it themselves.
--------------------------------------------------------- */

const SHARE_EVENTS = ["download", "native_share", "whatsapp_link", "copy_link", "print"];

export async function recordShareEvent(id, input, admin) {
  const actor = actorOf(admin);
  const ref = invoices().doc(id);
  const type = String(input?.type || "");
  const markSent = input?.markSent === true;
  if (!markSent && !SHARE_EVENTS.includes(type)) throw badRequest("Unknown share action.");

  await db().runTransaction(async tx => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw notFound("Invoice not found.");
    const share = snap.get("share") || { status: "ready", events: [] };
    const events = [...(share.events || []), { type: markSent ? "marked_sent" : type, at: Timestamp.now(), by: actor.email || actor.uid }].slice(-50);
    let status = share.status || "ready";
    if (markSent) status = "sent_confirmed";
    else if (status === "ready" && (type === "native_share" || type === "whatsapp_link")) status = "share_opened";
    tx.update(ref, { share: { status, events } });
  });
  return getInvoiceDoc(id);
}

function linkSecret() {
  const secret = process.env.INVOICE_LINK_SECRET;
  if (!secret || secret.length < 32) {
    throw new HttpError(503, "Secure invoice links are not configured (INVOICE_LINK_SECRET must be at least 32 characters).");
  }
  return secret;
}

export function signInvoiceLink(id, expiresAt) {
  return crypto.createHmac("sha256", linkSecret()).update(`${id}.${expiresAt}`).digest("base64url");
}

export function createShareLink(id, baseUrl, days = 7) {
  const expiresAt = Math.floor(Date.now() / 1000) + Math.min(Math.max(Number(days) || 7, 1), 30) * 86400;
  const sig = signInvoiceLink(id, expiresAt);
  return {
    url: `${baseUrl}/api/invoice-pdf?id=${encodeURIComponent(id)}&exp=${expiresAt}&sig=${sig}`,
    expiresAt: new Date(expiresAt * 1000).toISOString()
  };
}

export function verifyShareLink(id, exp, sig) {
  const expiresAt = Number(exp);
  if (!id || !Number.isInteger(expiresAt) || !sig) return false;
  if (expiresAt < Date.now() / 1000) return false;
  const expected = Buffer.from(signInvoiceLink(id, expiresAt));
  const given = Buffer.from(String(sig));
  return expected.length === given.length && crypto.timingSafeEqual(expected, given);
}
