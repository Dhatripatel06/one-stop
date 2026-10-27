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

const mode = firebaseMode();
console.log(`Index check — ${mode} project ${process.env.FIREBASE_PROJECT_ID}${mode === "emulator" ? " (the emulator does not enforce indexes; this proves nothing)" : ""}`);

// Configuration problems are reported once, not per query.
try {
  db();
} catch (error) {
  console.log(`  ✖ configuration: ${error.message}`);
  process.exit(2);
}

// Deployed composite indexes and their build state (needs datastore.indexes.list).
if (mode === "live") {
  try {
    const { getApp } = await import("firebase-admin/app");
    const { access_token: token } = await getApp().options.credential.getAccessToken();
    const response = await fetch(`https://firestore.googleapis.com/v1/projects/${process.env.FIREBASE_PROJECT_ID}/databases/(default)/collectionGroups/-/indexes`, { headers: { Authorization: `Bearer ${token}` } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const { indexes = [] } = await response.json();
    console.log(`Deployed composite indexes: ${indexes.length}`);
    for (const index of indexes) {
      const fields = index.fields.filter(f => f.fieldPath !== "__name__").map(f => `${f.fieldPath} ${f.order === "DESCENDING" ? "↓" : "↑"}`).join(", ");
      console.log(`  ${index.state === "READY" ? "✔" : "…"} ${index.state.padEnd(8)} ${index.name.split("/")[5]}: ${fields}`);
    }
  } catch (error) {
    console.log(`  (index states unavailable with this account: ${error.message}; query checks below still apply)`);
  }
}

console.log("Queries:");
let failed = 0;
for (const [name, query] of QUERIES) {
  try {
    await query();
    console.log(`  ✔ ${name}`);
  } catch (error) {
    failed += 1;
    const message = error.message || "";
    const reason =
      /currently building/i.test(message) ? "index still building — wait a few minutes and re-run"
      : /requires an index/i.test(message) ? "missing index — deploy firestore.indexes.json"
      : [7, 16].includes(error.code) || /PERMISSION_DENIED|UNAUTHENTICATED/.test(message) ? `authentication/permission error (${message.split("\n")[0]})`
      : `query error — check the application code (${message.split("\n")[0]})`;
    console.log(`  ✖ ${name}: ${reason}`);
  }
}
process.exit(failed ? 1 : 0);
