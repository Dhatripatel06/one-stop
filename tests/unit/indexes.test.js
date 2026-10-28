import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

// The Firestore emulator ignores composite indexes, so these queries passed
// every integration test yet failed in production (website orders and the
// admin dashboard). Each compound query shape must have a declared index.
const REQUIRED = [
  // orders.js createPublicOrder: per-phone rate limit (equality + range)
  ["orders", ["customerId ASCENDING", "createdAt ASCENDING"]],
  // orders.js listOrders, customers.js getCustomer
  ["orders", ["status ASCENDING", "createdAt DESCENDING"]],
  ["orders", ["customerId ASCENDING", "createdAt DESCENDING"]],
  ["invoices", ["customerId ASCENDING", "issuedAt DESCENDING"]],
  // invoices.js listInvoices by payment status
  ["invoices", ["status ASCENDING", "paymentStatus ASCENDING", "issuedAt DESCENDING"]],
  // invoices.js listOfflineInvoices
  ["invoices", ["source ASCENDING", "issuedAt DESCENDING"]],
  // inventory.js listMovements by product
  ["inventoryMovements", ["productId ASCENDING", "at DESCENDING"]],
  // dashboard.js sum() aggregations: the summed field must be in the index
  ["invoices", ["status ASCENDING", "issuedAt ASCENDING", "totals.grandTotal ASCENDING"]],
  ["invoices", ["paymentStatus ASCENDING", "status ASCENDING", "balanceDue ASCENDING"]]
];

test("firestore.indexes.json declares an index for every compound query", () => {
  const { indexes } = JSON.parse(fs.readFileSync(new URL("../../firestore.indexes.json", import.meta.url), "utf8"));
  const declared = new Set(indexes.map(i => `${i.collectionGroup}: ${i.fields.map(f => `${f.fieldPath} ${f.order}`).join(", ")}`));
  for (const [collection, fields] of REQUIRED) {
    const key = `${collection}: ${fields.join(", ")}`;
    assert.ok(declared.has(key), `missing index ${key}`);
  }
});
