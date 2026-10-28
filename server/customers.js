/* =========================================================
   CUSTOMERS
   One record per phone number (customers/c_<digits>) to avoid duplicates.
   Orders and invoices keep their own customer snapshot, so editing a
   customer never changes past documents.
========================================================= */

import { db, FieldValue } from "./firebase.js";
import { Validator } from "./validate.js";
import { badRequest, notFound } from "./http.js";
import { auditEntry, auditRef } from "./audit.js";
import { actorOf } from "./auth.js";
import { GSTIN_PATTERN, isValidPhone, normalizePhone } from "../shared/constants.js";

export const customers = () => db().collection("customers");

export function customerIdForPhone(phone) {
  return `c_${normalizePhone(phone)}`;
}

// `phoneRequired: false` is for walk-in (offline) invoices, where the customer
// may not give a number. Website and admin orders always need one.
export function parseCustomer(input, { prefix = "", phoneRequired = true } = {}) {
  const v = new Validator(input);
  const customer = {
    name: v.string("name", { required: true, min: 2, max: 100, label: "Name" }),
    business: v.string("business", { max: 120, label: "Business name" }),
    phone: v.string("phone", { required: phoneRequired, max: 20, transform: normalizePhone, label: "Phone number" }),
    email: v.string("email", { max: 120, pattern: /^[^\s@]+@[^\s@]+\.[^\s@]+$/, label: "Email" }),
    gstin: v.string("gstin", { max: 15, transform: s => s.toUpperCase().replace(/\s/g, ""), pattern: GSTIN_PATTERN, label: "GSTIN" }),
    billingAddress: v.string("billingAddress", { max: 500, label: "Billing address" }),
    shippingAddress: v.string("shippingAddress", { max: 500, label: "Shipping address" }),
    stateCode: v.string("stateCode", { max: 2, pattern: /^\d{2}$/, label: "State" })
  };
  if (customer.phone && !isValidPhone(customer.phone)) {
    v.fail("phone", phoneRequired ? "Enter a valid 10-digit mobile number." : "Enter a valid mobile number: 10 digits for India, or the full number with country code.");
  }
  if (customer.gstin && customer.stateCode && customer.gstin.slice(0, 2) !== customer.stateCode) {
    v.fail("stateCode", "State does not match the GSTIN.");
  }
  if (customer.gstin && !customer.stateCode) customer.stateCode = customer.gstin.slice(0, 2);
  if (Object.keys(v.errors).length) {
    const fields = {};
    for (const [key, message] of Object.entries(v.errors)) fields[`${prefix}${key}`] = message;
    throw badRequest("Please correct the highlighted fields.", { fields });
  }
  return customer;
}

// Transaction helper. Call read() during the read phase and write() afterwards.
// `overwrite` = admin edits; public orders only fill in missing details.
export function customerUpsert(tx, customer, { overwrite = false } = {}) {
  const ref = customers().doc(customerIdForPhone(customer.phone));
  let snap = null;
  return {
    ref,
    async read() {
      snap = await tx.get(ref);
      return snap;
    },
    write(extra = {}) {
      const now = FieldValue.serverTimestamp();
      if (!snap.exists) {
        tx.set(ref, {
          ...customer,
          orderCount: 0, totalBilled: 0, totalPaid: 0,
          createdAt: now, updatedAt: now, ...extra
        });
        return;
      }
      const current = snap.data();
      const update = { updatedAt: now, ...extra };
      for (const [key, value] of Object.entries(customer)) {
        if (!value) continue;
        if (overwrite || !current[key]) update[key] = value;
      }
      tx.update(ref, update);
    }
  };
}

function view(doc) {
  const data = doc.data();
  return {
    id: doc.id,
    ...data,
    outstanding: (data.totalBilled || 0) - (data.totalPaid || 0),
    createdAt: data.createdAt?.toDate?.().toISOString() || null,
    updatedAt: data.updatedAt?.toDate?.().toISOString() || null,
    lastOrderAt: data.lastOrderAt?.toDate?.().toISOString() || null
  };
}

export async function listCustomers({ q = "" } = {}) {
  const query = String(q).trim().toLowerCase();
  const snap = await customers().orderBy("updatedAt", "desc").limit(1000).get();
  let list = snap.docs.map(view);
  if (query) {
    const digits = query.replace(/\D/g, "");
    list = list.filter(customer =>
      [customer.name, customer.business, customer.email, customer.gstin].some(value => String(value || "").toLowerCase().includes(query)) ||
      (digits.length >= 3 && customer.phone.includes(digits)));
  }
  return list;
}

export async function getCustomer(id) {
  const snap = await customers().doc(id).get();
  if (!snap.exists) throw notFound("Customer not found.");
  const [orders, invoices] = await Promise.all([
    db().collection("orders").where("customerId", "==", id).orderBy("createdAt", "desc").limit(100).get(),
    db().collection("invoices").where("customerId", "==", id).orderBy("issuedAt", "desc").limit(100).get()
  ]);
  return {
    customer: view(snap),
    orders: orders.docs.map(doc => ({
      id: doc.id, orderNo: doc.get("orderNo"), status: doc.get("status"),
      grandTotal: doc.get("totals")?.grandTotal ?? null, createdAt: doc.get("createdAt")?.toDate?.().toISOString() || null,
      invoiceNo: doc.get("invoiceNo") || null
    })),
    invoices: invoices.docs.map(doc => ({
      id: doc.id, invoiceNo: doc.get("invoiceNo"), status: doc.get("status"), orderNo: doc.get("orderNo"),
      grandTotal: doc.get("totals")?.grandTotal ?? 0, amountPaid: doc.get("amountPaid") || 0,
      balanceDue: doc.get("balanceDue") || 0, paymentStatus: doc.get("paymentStatus"),
      issuedAt: doc.get("issuedAt")?.toDate?.().toISOString() || null
    }))
  };
}

export async function updateCustomer(id, input, admin) {
  const ref = customers().doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw notFound("Customer not found.");
  const customer = parseCustomer({ ...input, phone: snap.get("phone") });
  delete customer.phone;
  await ref.update({ ...customer, updatedAt: FieldValue.serverTimestamp() });
  await auditRef().set(auditEntry(actorOf(admin), "customer.update", "customer", id, { fields: Object.keys(customer) }));
  return getCustomer(id);
}
