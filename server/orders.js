/* =========================================================
   ORDERS
   - Prices and totals are always computed here from the database.
     Prices sent by a browser are ignored for customer orders.
   - Each order item stores a snapshot (name, SKU, price, tax rate),
     so later product edits never change an existing order.
   - Order numbers come from a transactional counter.
========================================================= */

import { db, FieldValue, Timestamp } from "./firebase.js";
import { Validator } from "./validate.js";
import { HttpError, badRequest, conflict, notFound } from "./http.js";
import { auditEntry, auditRef } from "./audit.js";
import { actorOf } from "./auth.js";
import { computeTotals, effectiveUnitPrice, formatINR, GST_RATES, isPaise } from "../shared/pricing.js";
import {
  MAX_LINE_QTY, MAX_ORDER_LINES, ORDER_STATUSES, ORDER_TRANSITIONS, normalizeSku
} from "../shared/constants.js";
import { getSettings, taxContext } from "./settings.js";
import { availabilityOf, isOrderable } from "./products.js";
import { customerIdForPhone, customerUpsert, parseCustomer } from "./customers.js";
import { assertAvailable, deductInTx, releaseInTx, reserveInTx } from "./inventory.js";

const orders = () => db().collection("orders");
const SYSTEM = { uid: "customer", email: "" };

/* ---------------------------------------------------------
   HELPERS
--------------------------------------------------------- */

function iso(value) {
  if (!value) return null;
  if (typeof value.toDate === "function") return value.toDate().toISOString();
  return value;
}

function parseItems(raw, { admin = false } = {}) {
  if (!Array.isArray(raw) || raw.length === 0) throw badRequest("Add at least one product to the order.");
  if (raw.length > MAX_ORDER_LINES) throw badRequest(`An order can contain up to ${MAX_ORDER_LINES} products.`);

  const merged = new Map();
  const errors = {};
  raw.forEach((item, index) => {
    const sku = normalizeSku(item?.sku);
    const qty = Number(item?.qty);
    if (!sku) errors[`items.${index}`] = "Product code is missing.";
    else if (!Number.isInteger(qty) || qty < 1) errors[`items.${index}`] = `Quantity for ${sku} must be a whole number of at least 1.`;
    else if (qty > MAX_LINE_QTY) errors[`items.${index}`] = `Quantity for ${sku} is too large.`;
    if (errors[`items.${index}`]) return;

    const line = merged.get(sku) || { sku, qty: 0 };
    line.qty += qty;
    if (admin) {
      if (item.unitPrice !== undefined && item.unitPrice !== null && item.unitPrice !== "") {
        if (!isPaise(item.unitPrice)) errors[`items.${index}`] = `Price for ${sku} must be a valid amount.`;
        else line.unitPrice = item.unitPrice;
      }
      if (item.gstRate !== undefined && item.gstRate !== null && item.gstRate !== "") {
        const rate = Number(item.gstRate);
        if (!GST_RATES.includes(rate)) errors[`items.${index}`] = `GST rate for ${sku} is not valid.`;
        else line.gstRate = rate;
      }
    }
    merged.set(sku, line);
  });
  if (Object.keys(errors).length) throw badRequest("Some order lines are not valid.", { fields: errors });
  return [...merged.values()];
}

// Read phase: resolve SKUs to products inside a transaction.
async function readProductsBySku(tx, lines) {
  const indexSnaps = await Promise.all(lines.map(line => tx.get(db().collection("skuIndex").doc(line.sku))));
  const missing = lines.filter((line, i) => !indexSnaps[i].exists).map(line => line.sku);
  if (missing.length) throw badRequest(`These products are no longer available: ${missing.join(", ")}.`, { missing });
  const refs = indexSnaps.map(snap => db().collection("products").doc(snap.get("productId")));
  const productSnaps = await Promise.all(refs.map(ref => tx.get(ref)));
  return productSnaps.map((snap, i) => {
    if (!snap.exists) throw badRequest(`Product ${lines[i].sku} is no longer available.`);
    return { ref: snap.ref, data: snap.data(), line: lines[i] };
  });
}

function validateOrderable(entries) {
  const problems = [];
  for (const { data, line } of entries) {
    if (data.status !== "active") problems.push(`${data.sku} is not currently offered.`);
    else if (!isOrderable(data)) problems.push(`${data.sku} is ${availabilityOf(data) === "coming_soon" ? "coming soon" : "out of stock"}.`);
    else if (line.qty < (data.minQty || 1)) problems.push(`${data.sku} has a minimum order of ${data.minQty} ${data.unit || "pcs"}.`);
  }
  if (problems.length) throw badRequest(problems.join(" "), { problems });
  assertAvailable(entries.map(entry => ({ data: entry.data, qty: entry.line.qty })));
}

function buildItems(entries, { admin = false } = {}) {
  return entries.map(({ ref, data, line }, index) => {
    const catalogue = effectiveUnitPrice(data);
    const adminPrice = admin && line.unitPrice !== undefined ? line.unitPrice : undefined;
    const unitPrice = adminPrice ?? catalogue;
    return {
      lineNo: index + 1,
      productId: ref.id,
      sku: data.sku,
      name: data.name,
      image: (data.images || [])[0] || "",
      unit: data.unit || "pcs",
      hsn: data.hsn || "",
      qty: line.qty,
      // An admin price below the catalogue price shows as a discount on the invoice.
      listPrice: adminPrice !== undefined ? Math.max(adminPrice, data.price ?? 0) : data.price ?? null,
      unitPrice: unitPrice ?? null,
      gstRate: line.gstRate ?? data.gstRate ?? null,
      priceSource: adminPrice !== undefined ? "admin" : catalogue !== null ? "catalogue" : "on_request",
      reservedQty: 0
    };
  });
}

function priceOrder(items, settings, placeOfSupply) {
  const tax = taxContext(settings, placeOfSupply);
  const totals = computeTotals(items, tax, { roundOff: settings.roundOff });
  const { lines, ...summary } = totals;
  const pricedItems = items.map((item, i) => {
    const line = lines[i];
    return {
      ...item,
      gstRate: line.gstRate,
      gross: line.gross, discount: line.discount, net: line.net,
      taxable: line.taxable, taxAmount: line.taxAmount,
      cgst: line.cgst, sgst: line.sgst, igst: line.igst, total: line.total
    };
  });
  return {
    items: pricedItems,
    totals: summary,
    taxSnapshot: { mode: tax.mode, pricesIncludeTax: tax.pricesIncludeTax, interState: tax.interState }
  };
}

async function nextOrderNumber(tx) {
  const year = new Date().getFullYear();
  const ref = db().collection("counters").doc(`orders-${year}`);
  const snap = await tx.get(ref);
  const seq = (snap.exists ? snap.get("seq") : 0) + 1;
  return {
    orderNo: `ORD-${year}-${String(seq).padStart(5, "0")}`,
    write: () => tx.set(ref, { seq }, { merge: true })
  };
}

function historyEntry(status, actor, note = "") {
  return { status, at: Timestamp.now(), by: actor.email || actor.uid, note };
}

/* ---------------------------------------------------------
   CREATE
--------------------------------------------------------- */

async function createOrderInternal({ customer, lines, notes, placeOfSupply, source, actor, adminPricing, enforceMinimum }) {
  const orderRef = orders().doc();

  const result = await db().runTransaction(async tx => {
    // ---- reads
    const settings = await getSettings(tx);
    const entries = await readProductsBySku(tx, lines);
    const number = await nextOrderNumber(tx);
    const upsert = customerUpsert(tx, customer, { overwrite: source === "admin" });
    await upsert.read();

    // ---- validation
    validateOrderable(entries);
    const pos = placeOfSupply || customer.stateCode || "";
    const priced = priceOrder(buildItems(entries, { admin: adminPricing }), settings, pos);

    if (enforceMinimum && priced.totals.priced && settings.minOrderValue && priced.totals.subtotal < settings.minOrderValue) {
      throw badRequest(`The minimum order value is ${formatINR(settings.minOrderValue, { decimals: "auto" })}. Your order is ${formatINR(priced.totals.subtotal, { decimals: "auto" })}.`);
    }

    // ---- writes
    number.write();
    upsert.write({ orderCount: FieldValue.increment(1), lastOrderAt: FieldValue.serverTimestamp() });

    const order = {
      orderNo: number.orderNo,
      status: "pending",
      source,
      customerId: upsert.ref.id,
      customer,
      placeOfSupply: pos,
      notes: notes || "",
      adminNotes: "",
      totals: priced.totals,
      taxSnapshot: priced.taxSnapshot,
      stockReserved: false,
      invoiceId: null,
      invoiceNo: null,
      statusHistory: [historyEntry("pending", actor, source === "web" ? "Submitted from website" : "Created by admin")],
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
      createdBy: actor
    };
    tx.set(orderRef, order);
    priced.items.forEach(item => tx.set(orderRef.collection("items").doc(), item));
    entries.forEach(({ ref }) => tx.update(ref, { orderCount: FieldValue.increment(1) }));
    tx.set(auditRef(), auditEntry(actor, "order.create", "order", orderRef.id, { orderNo: order.orderNo, source }));

    return { order, items: priced.items };
  });

  return { id: orderRef.id, ...result.order, items: result.items, createdAt: new Date().toISOString(), statusHistory: undefined };
}

// Public endpoint: anyone can submit; everything is validated and priced here.
export async function createPublicOrder(input) {
  if (input?.website) throw new HttpError(400, "Order could not be submitted.");
  const customer = parseCustomer(input?.customer || {}, { prefix: "customer." });
  const lines = parseItems(input?.items);
  const v = new Validator(input);
  const notes = v.string("notes", { max: 1000, label: "Notes" });
  v.assert();

  // Per-phone limit, shared across serverless instances.
  const since = Timestamp.fromMillis(Date.now() - 60 * 60 * 1000);
  const recent = await orders()
    .where("customerId", "==", customerIdForPhone(customer.phone))
    .where("createdAt", ">=", since)
    .count().get();
  if (recent.data().count >= 5) throw new HttpError(429, "Too many orders from this number in the last hour. Please contact us on WhatsApp.");

  const order = await createOrderInternal({
    customer, lines, notes, placeOfSupply: customer.stateCode,
    source: "web", actor: SYSTEM, adminPricing: false, enforceMinimum: true
  });

  // Customers see their own submission only — no internal fields.
  return {
    id: order.id,
    orderNo: order.orderNo,
    status: order.status,
    customer: { name: order.customer.name, phone: order.customer.phone },
    items: order.items.map(item => ({ sku: item.sku, name: item.name, qty: item.qty, unit: item.unit, unitPrice: item.unitPrice, total: item.total })),
    totals: order.totals,
    createdAt: order.createdAt
  };
}

export async function createAdminOrder(input, admin) {
  const customer = parseCustomer(input?.customer || {}, { prefix: "customer." });
  const lines = parseItems(input?.items, { admin: true });
  const v = new Validator(input);
  const notes = v.string("notes", { max: 1000 });
  const placeOfSupply = v.string("placeOfSupply", { max: 2, pattern: /^\d{2}$/, label: "Place of supply" });
  v.assert();
  return createOrderInternal({
    customer, lines, notes, placeOfSupply,
    source: "admin", actor: actorOf(admin), adminPricing: true, enforceMinimum: false
  });
}

/* ---------------------------------------------------------
   READ
--------------------------------------------------------- */

function orderView(doc) {
  const data = doc.data();
  return {
    id: doc.id,
    ...data,
    createdAt: iso(data.createdAt),
    updatedAt: iso(data.updatedAt),
    statusHistory: (data.statusHistory || []).map(entry => ({ ...entry, at: iso(entry.at) }))
  };
}

export async function getOrder(id) {
  const ref = orders().doc(id);
  const [snap, items, invoices] = await Promise.all([
    ref.get(),
    ref.collection("items").orderBy("lineNo").get(),
    db().collection("invoices").where("orderId", "==", id).get()
  ]);
  if (!snap.exists) throw notFound("Order not found.");
  return {
    ...orderView(snap),
    items: items.docs.map(doc => ({ id: doc.id, ...doc.data() })),
    invoices: invoices.docs
      .map(doc => ({ id: doc.id, invoiceNo: doc.get("invoiceNo"), status: doc.get("status"), issuedAt: iso(doc.get("issuedAt")), grandTotal: doc.get("totals")?.grandTotal }))
      .sort((a, b) => String(b.issuedAt).localeCompare(String(a.issuedAt)))
  };
}

export async function listOrders({ status, q, limit = 25, before } = {}) {
  const size = Math.min(Number(limit) || 25, 100);
  const query = String(q || "").trim();
  let ref = orders();

  if (query) {
    const upper = query.toUpperCase();
    let snap;
    if (/^ORD-/.test(upper)) {
      snap = await ref.where("orderNo", "==", upper).get();
    } else if (query.replace(/\D/g, "").length >= 10) {
      snap = await ref.where("customerId", "==", customerIdForPhone(query)).orderBy("createdAt", "desc").limit(100).get();
    } else {
      const recent = await ref.orderBy("createdAt", "desc").limit(500).get();
      const lower = query.toLowerCase();
      const items = recent.docs.map(orderView).filter(order =>
        `${order.customer?.name} ${order.customer?.business} ${order.orderNo}`.toLowerCase().includes(lower));
      return { items: status ? items.filter(o => o.status === status) : items, next: null };
    }
    const items = snap.docs.map(orderView);
    return { items: status ? items.filter(o => o.status === status) : items, next: null };
  }

  let built = status ? ref.where("status", "==", status).orderBy("createdAt", "desc") : ref.orderBy("createdAt", "desc");
  if (before) built = built.startAfter(Timestamp.fromDate(new Date(before)));
  const snap = await built.limit(size).get();
  const items = snap.docs.map(orderView);
  return { items, next: items.length === size ? items[items.length - 1].createdAt : null };
}

/* ---------------------------------------------------------
   EDIT (pending orders only)
--------------------------------------------------------- */

export async function updatePendingOrder(id, input, admin) {
  const actor = actorOf(admin);
  const ref = orders().doc(id);
  const lines = input?.items !== undefined ? parseItems(input.items, { admin: true }) : null;
  const v = new Validator(input);
  const placeOfSupply = v.has("placeOfSupply") ? v.string("placeOfSupply", { max: 2, pattern: /^\d{2}$/, label: "Place of supply" }) : undefined;
  const adminNotes = v.has("adminNotes") ? v.string("adminNotes", { max: 2000 }) : undefined;
  const notes = v.has("notes") ? v.string("notes", { max: 1000 }) : undefined;
  v.assert();
  const customer = input?.customer ? parseCustomer(input.customer, { prefix: "customer." }) : null;

  await db().runTransaction(async tx => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw notFound("Order not found.");
    const order = snap.data();

    const editingContent = lines || customer || placeOfSupply !== undefined;
    if (editingContent && order.status !== "pending") {
      throw conflict("Only orders awaiting confirmation can be edited. Cancel and re-create the order to change it.");
    }

    const settings = await getSettings(tx);
    const existingItems = await tx.get(ref.collection("items"));
    let entries = null;
    if (lines) entries = await readProductsBySku(tx, lines);

    const update = { updatedAt: FieldValue.serverTimestamp() };
    if (adminNotes !== undefined) update.adminNotes = adminNotes;
    if (notes !== undefined) update.notes = notes;

    if (editingContent) {
      const pos = placeOfSupply ?? (customer?.stateCode || order.placeOfSupply || "");
      let items;
      if (entries) {
        validateOrderable(entries);
        items = buildItems(entries, { admin: true });
      } else {
        items = existingItems.docs.map(doc => doc.data()).sort((a, b) => a.lineNo - b.lineNo);
      }
      const priced = priceOrder(items, settings, pos);
      update.totals = priced.totals;
      update.taxSnapshot = priced.taxSnapshot;
      update.placeOfSupply = pos;
      if (customer) {
        if (customer.phone !== order.customer.phone) throw badRequest("The customer's phone number cannot be changed on an existing order.");
        update.customer = customer;
      }
      existingItems.docs.forEach(doc => tx.delete(doc.ref));
      priced.items.forEach(item => tx.set(ref.collection("items").doc(), item));
      if (entries) {
        const before = new Set(existingItems.docs.map(doc => doc.get("productId")));
        entries.filter(entry => !before.has(entry.ref.id)).forEach(entry => tx.update(entry.ref, { orderCount: FieldValue.increment(1) }));
      }
    }

    tx.update(ref, update);
    tx.set(auditRef(), auditEntry(actor, "order.update", "order", id, { orderNo: order.orderNo, items: Boolean(lines), customer: Boolean(customer) }));
  });

  return getOrder(id);
}

/* ---------------------------------------------------------
   STATUS TRANSITIONS
--------------------------------------------------------- */

export async function transitionOrder(id, input, admin) {
  const actor = actorOf(admin);
  const v = new Validator(input);
  const status = v.oneOf("status", Object.keys(ORDER_STATUSES), { required: true, label: "Status" });
  const note = v.string("note", { max: 500 });
  if (status === "cancelled" && !note) v.fail("note", "Please give a reason for cancelling.");
  v.assert();

  const ref = orders().doc(id);

  await db().runTransaction(async tx => {
    // ---- reads
    const snap = await tx.get(ref);
    if (!snap.exists) throw notFound("Order not found.");
    const order = { id, ...snap.data() };
    const allowed = ORDER_TRANSITIONS[order.status] || [];
    if (!allowed.includes(status)) {
      throw conflict(`An order that is "${ORDER_STATUSES[order.status]}" cannot be changed to "${ORDER_STATUSES[status]}".`);
    }

    const itemSnaps = await tx.get(ref.collection("items"));
    const items = itemSnaps.docs.map(doc => ({ ref: doc.ref, ...doc.data() }));
    const needsProducts = ["confirmed", "dispatched", "cancelled"].includes(status);
    const productSnaps = needsProducts
      ? await Promise.all(items.map(item => tx.get(db().collection("products").doc(item.productId))))
      : [];

    let invoice = null;
    if (status === "cancelled" && order.invoiceId) {
      invoice = await tx.get(db().collection("invoices").doc(order.invoiceId));
    }

    // ---- validation & writes
    const update = {
      status,
      updatedAt: FieldValue.serverTimestamp(),
      statusHistory: FieldValue.arrayUnion(historyEntry(status, actor, note))
    };

    if (status === "confirmed") {
      if (!order.totals?.priced) throw conflict("Set a price for every item before confirming the order.");
      const entries = items.map((item, i) => {
        if (!productSnaps[i].exists) throw conflict(`Product ${item.sku} no longer exists. Edit the order before confirming.`);
        return { ref: productSnaps[i].ref, data: productSnaps[i].data(), qty: item.qty, item };
      });
      for (const entry of entries) {
        if (entry.data.status === "archived") throw conflict(`Product ${entry.data.sku} is archived. Edit the order before confirming.`);
      }
      assertAvailable(entries);
      reserveInTx(tx, entries, order, actor);
      entries.forEach(entry => {
        if (entry.data.trackStock) tx.update(entry.item.ref, { reservedQty: entry.qty });
      });
      update.stockReserved = entries.some(entry => entry.data.trackStock);
      update.confirmedAt = FieldValue.serverTimestamp();
    }

    if (status === "dispatched") {
      const reservedEntries = [];
      const directEntries = [];
      items.forEach((item, i) => {
        const productSnap = productSnaps[i];
        if (!productSnap.exists) return;
        const entry = { ref: productSnap.ref, data: productSnap.data(), qty: item.qty, item };
        if (item.reservedQty > 0) reservedEntries.push({ ...entry, reserved: item.reservedQty });
        // Stock tracking started after confirmation: deduct directly, if available.
        else if (entry.data.trackStock) directEntries.push(entry);
      });
      assertAvailable(directEntries);
      deductInTx(tx, reservedEntries, order, actor);
      // Direct deduction: reserve then deduct so the movement history stays consistent.
      reserveInTx(tx, directEntries, order, actor);
      deductInTx(tx, directEntries.map(entry => ({ ...entry, reserved: entry.qty })), order, actor);
      [...reservedEntries, ...directEntries].forEach(entry => {
        tx.update(entry.item.ref, { reservedQty: 0, deductedQty: entry.qty });
      });
      update.stockReserved = false;
      update.dispatchedAt = FieldValue.serverTimestamp();
    }

    if (status === "cancelled") {
      if (invoice?.exists && invoice.get("status") === "issued") {
        throw conflict(`Invoice ${invoice.get("invoiceNo")} is active for this order. Cancel the invoice first.`);
      }
      const entries = [];
      items.forEach((item, i) => {
        if (item.reservedQty > 0 && productSnaps[i].exists) {
          entries.push({ ref: productSnaps[i].ref, data: productSnaps[i].data(), reserved: item.reservedQty, item });
        }
      });
      releaseInTx(tx, entries, order, actor, `Order ${order.orderNo} cancelled: ${note}`);
      entries.forEach(entry => tx.update(entry.item.ref, { reservedQty: 0 }));
      update.stockReserved = false;
      update.cancelledAt = FieldValue.serverTimestamp();
      update.cancelReason = note;
    }

    if (status === "completed") update.completedAt = FieldValue.serverTimestamp();

    tx.update(ref, update);
    tx.set(auditRef(), auditEntry(actor, `order.${status}`, "order", id, { orderNo: order.orderNo, from: order.status, note }));
  });

  return getOrder(id);
}
