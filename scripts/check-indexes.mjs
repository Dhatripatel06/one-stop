/* =========================================================
   FIRESTORE INDEX CHECK (read-only)
   The emulator does not enforce composite indexes, so a missing index only
   shows up in production. This runs every compound query shape the API uses
   against the configured project and reports any that Firestore rejects.

     node scripts/check-indexes.mjs        credentials from .env.local / .env

   Reads only; dummy filter values match no documents.
========================================================= */

const { loadEnv } = await import("./load-env.mjs");
loadEnv();

const { AggregateField, Timestamp } = await import("firebase-admin/firestore");
const { db, firebaseMode } = await import("../server/firebase.js");

const since = Timestamp.fromMillis(Date.now() - 864e5);
const orders = () => db().collection("orders");
const invoices = () => db().collection("invoices");

// [where the query lives, query]
const QUERIES = [
  ["orders.js createPublicOrder rate limit", () => orders().where("customerId", "==", "_").where("createdAt", ">=", since).count().get()],
  ["orders.js listOrders by status", () => orders().where("status", "==", "pending").orderBy("createdAt", "desc").limit(1).get()],
  ["orders.js / customers.js orders by customer", () => orders().where("customerId", "==", "_").orderBy("createdAt", "desc").limit(1).get()],
  ["customers.js invoices by customer", () => invoices().where("customerId", "==", "_").orderBy("issuedAt", "desc").limit(1).get()],
  ["invoices.js listInvoices by payment status", () => invoices().where("status", "==", "issued").where("paymentStatus", "==", "unpaid").orderBy("issuedAt", "desc").limit(1).get()],
  ["inventory.js movements by product", () => db().collection("inventoryMovements").where("productId", "==", "_").orderBy("at", "desc").limit(1).get()],
  ["dashboard.js sales total", () => invoices().where("status", "==", "issued").where("issuedAt", ">=", since).where("issuedAt", "<", Timestamp.now())
    .aggregate({ total: AggregateField.sum("totals.grandTotal"), count: AggregateField.count() }).get()],
  ["dashboard.js outstanding balance", () => invoices().where("status", "==", "issued").where("paymentStatus", "in", ["unpaid", "partial"])
    .aggregate({ total: AggregateField.sum("balanceDue"), count: AggregateField.count() }).get()]
];

console.log(`Index check — ${firebaseMode()} project ${process.env.FIREBASE_PROJECT_ID}${firebaseMode() === "emulator" ? " (the emulator does not enforce indexes; this proves nothing)" : ""}`);
let failed = 0;
for (const [name, query] of QUERIES) {
  try {
    await query();
    console.log(`  ✔ ${name}`);
  } catch (error) {
    failed += 1;
    const missing = /requires an index/i.test(error.message);
    console.log(`  ✖ ${name}: ${missing ? "missing index (deploy firestore.indexes.json; new indexes take a few minutes to build)" : error.message.split("\n")[0]}`);
  }
}
process.exit(failed ? 1 : 0);
