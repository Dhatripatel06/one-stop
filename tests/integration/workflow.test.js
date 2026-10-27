/* End-to-end API workflow against the Firebase emulators.
   Run: npm run test:integration   (starts emulators automatically) */

import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { clearFirestore, client, createUser, customer, db, startServer } from "./helpers.js";

let server, owner, staff, viewer, anon;
const ids = {};

before(async () => {
  await clearFirestore();
  server = await startServer();
  const [ownerToken, staffToken, viewerToken] = await Promise.all([
    createUser("it-owner", "it-owner@oss.test"),
    createUser("it-staff", "it-staff@oss.test", "staff"),
    createUser("it-viewer", "it-viewer@oss.test")
  ]);
  owner = client(server.base, ownerToken);
  staff = client(server.base, staffToken);
  viewer = client(server.base, viewerToken);
  anon = client(server.base);
});

after(async () => {
  await server?.close();
});

describe("authorization", () => {
  test("admin API rejects anonymous users", async () => {
    assert.equal((await anon.get("/admin/products")).status, 401);
  });
  test("admin API rejects signed-in non-admins", async () => {
    assert.equal((await viewer.get("/admin/products")).status, 403);
  });
  test("forged tokens are rejected", async () => {
    const forged = client(server.base, "eyJhbGciOiJub25lIn0.eyJ1aWQiOiJpdC1vd25lciJ9.");
    assert.equal((await forged.get("/admin/me")).status, 401);
  });
  test("staff cannot change owner-only settings", async () => {
    const res = await staff.put("/admin/settings", { businessName: "Hacked", invoicePrefix: "X" });
    assert.equal(res.status, 403);
  });
  test("owner identity", async () => {
    const res = await owner.get("/admin/me");
    assert.equal(res.status, 200);
    assert.equal(res.data.role, "owner");
  });
});

describe("products and categories", () => {
  test("create a product with a new category", async () => {
    const res = await owner.post("/admin/products", {
      sku: "it_001", name: "Steel Bottle", newCategoryName: "Water Bottle",
      price: 25000, minQty: 2
    });
    assert.equal(res.status, 200, JSON.stringify(res.data));
    assert.equal(res.data.sku, "IT_001");
    assert.equal(res.data.categoryId, "water-bottle");
    ids.p1 = res.data.id;
  });

  test("generated SKUs and second product", async () => {
    const res = await staff.post("/admin/products", { generateSku: true, name: "Popcorn Maker", categoryId: "water-bottle", price: 84950 });
    assert.equal(res.status, 200, JSON.stringify(res.data));
    assert.match(res.data.sku, /^OSS_\d{3}$/);
    ids.p2 = res.data.id;
    ids.p2sku = res.data.sku;
    const unpriced = await owner.post("/admin/products", { sku: "IT_003", name: "Price On Request Item", categoryId: "water-bottle" });
    assert.equal(unpriced.status, 200);
    ids.p3 = unpriced.data.id;
  });

  test("duplicate SKU is refused (create and rename)", async () => {
    const dup = await owner.post("/admin/products", { sku: "IT_001", name: "Copy", categoryId: "water-bottle" });
    assert.equal(dup.status, 409);
    assert.ok(dup.data.details.fields.sku);
    const rename = await owner.patch(`/admin/products/${ids.p2}`, { sku: "it_001" });
    assert.equal(rename.status, 409);
  });

  test("validation errors are reported per field", async () => {
    const res = await owner.post("/admin/products", { sku: "IT_X", name: "", categoryId: "water-bottle", price: 1000, salePrice: 2000, images: ["javascript:alert(1)"] });
    assert.equal(res.status, 400);
    assert.ok(res.data.details.fields.name);
    assert.ok(res.data.details.fields.salePrice);
    assert.ok(res.data.details.fields.images);
  });

  test("exact stock is not exposed publicly", async () => {
    const pub = await anon.get("/products/IT_001");
    assert.equal(pub.status, 200);
    assert.equal(pub.data.product.stockQty, undefined);
    assert.equal(pub.data.product.reservedQty, undefined);
  });

  test("public catalogue only lists active products", async () => {
    await owner.patch(`/admin/products/${ids.p3}`, { status: "inactive" });
    const res = await anon.get("/catalog");
    assert.equal(res.status, 200);
    const skus = res.data.products.map(p => p.sku);
    assert.ok(skus.includes("IT_001"));
    assert.ok(!skus.includes("IT_003"));
    assert.equal((await anon.get("/products/IT_003")).status, 404);
    await owner.patch(`/admin/products/${ids.p3}`, { status: "active" });
  });

  test("category in use cannot be archived without reassignment", async () => {
    const res = await owner.post("/admin/categories/water-bottle/archive", {});
    assert.equal(res.status, 409);
  });
});

describe("inventory", () => {
  test("stock changes require initial count, reason, and never go negative", async () => {
    const noInit = await owner.post(`/admin/products/${ids.p1}/stock`, { type: "increase", qty: 5, reason: "Purchase" });
    assert.equal(noInit.status, 409);
    const noReason = await owner.post(`/admin/products/${ids.p1}/stock`, { type: "initial", qty: 10 });
    assert.equal(noReason.status, 400);
    const init = await owner.post(`/admin/products/${ids.p1}/stock`, { type: "initial", qty: 10, reason: "Opening count", lowStockThreshold: 2 });
    assert.equal(init.status, 200);
    assert.equal(init.data.stockQty, 10);
    const negative = await owner.post(`/admin/products/${ids.p1}/stock`, { type: "decrease", qty: 11, reason: "Damaged" });
    assert.equal(negative.status, 400);
    const inc = await staff.post(`/admin/products/${ids.p1}/stock`, { type: "increase", qty: 2, reason: "Supplier delivery" });
    assert.equal(inc.data.stockQty, 12);
    const fix = await owner.post(`/admin/products/${ids.p1}/stock`, { type: "correction", qty: 10, reason: "Stock count" });
    assert.equal(fix.data.stockQty, 10);
    await owner.post(`/admin/products/${ids.p2}/stock`, { type: "initial", qty: 3, reason: "Opening count" });
  });

  test("every change is recorded with who and why", async () => {
    const res = await owner.get(`/admin/inventory/movements?productId=${ids.p1}`);
    assert.equal(res.data.items.length, 3);
    const inc = res.data.items.find(m => m.type === "increase");
    assert.equal(inc.actor.email, "it-staff@oss.test");
    assert.equal(inc.reason, "Supplier delivery");
    assert.equal(inc.stockBefore, 10);
    assert.equal(inc.stockAfter, 12);
  });
});

describe("customer orders", () => {
  test("invalid quantities are rejected", async () => {
    for (const qty of [0, -1, 1.5, "abc"]) {
      const res = await anon.post("/orders", { customer: customer(), items: [{ sku: "IT_001", qty }] });
      assert.equal(res.status, 400, `qty ${qty}`);
    }
    const belowMin = await anon.post("/orders", { customer: customer(), items: [{ sku: "IT_001", qty: 1 }, { sku: ids.p2sku, qty: 1 }] });
    assert.equal(belowMin.status, 400);
    assert.match(belowMin.data.error, /minimum order of 2/);
  });

  test("invalid customer details are rejected per field", async () => {
    const res = await anon.post("/orders", { customer: { name: "", phone: "123" }, items: [{ sku: "IT_001", qty: 2 }] });
    assert.equal(res.status, 400);
    assert.ok(res.data.details.fields["customer.name"]);
    assert.ok(res.data.details.fields["customer.phone"]);
  });

  test("minimum order value is enforced for priced orders", async () => {
    // 2 × ₹250 = ₹500 meets the default ₹500 minimum; 1 popcorn maker = ₹849.50 too.
    const res = await anon.post("/orders", { customer: customer("9000000001"), items: [{ sku: "IT_003", qty: 1 }] });
    assert.equal(res.status, 200, "unpriced orders are accepted for confirmation");
    await owner.put("/admin/settings", { businessName: "ONE STOP SOLUTION (OSS)", invoicePrefix: "OSS", minOrderValue: 100000 });
    const low = await anon.post("/orders", { customer: customer("9000000002"), items: [{ sku: "IT_001", qty: 2 }] });
    assert.equal(low.status, 400);
    assert.match(low.data.error, /minimum order value/i);
    await owner.put("/admin/settings", { businessName: "ONE STOP SOLUTION (OSS)", invoicePrefix: "OSS", minOrderValue: 50000 });
  });

  test("multi-product order is priced by the server, ignoring browser prices", async () => {
    const res = await anon.post("/orders", {
      customer: customer("9876543210", { business: "Buyer Traders", billingAddress: "1 Market Road" }),
      items: [
        { sku: "IT_001", qty: 4, unitPrice: 1, price: 1 },
        { sku: ids.p2sku, qty: 1, unitPrice: 1 }
      ],
      totals: { grandTotal: 100 }
    });
    assert.equal(res.status, 200, JSON.stringify(res.data));
    assert.match(res.data.orderNo, /^ORD-\d{4}-\d{5}$/);
    assert.equal(res.data.items.length, 2);
    assert.equal(res.data.items[0].unitPrice, 25000);
    assert.equal(res.data.totals.subtotal, 4 * 25000 + 84950);
    // ₹1,849.50 rounded to ₹1,850 (round-off on by default)
    assert.equal(res.data.totals.grandTotal, 185000);
    ids.order1 = res.data.id;
    ids.order1No = res.data.orderNo;
  });

  test("order items are stored separately with snapshots", async () => {
    const items = await db().collection("orders").doc(ids.order1).collection("items").get();
    assert.equal(items.size, 2);
    await owner.patch(`/admin/products/${ids.p1}`, { name: "Renamed Bottle", price: 99900 });
    const order = await owner.get(`/admin/orders/${ids.order1}`);
    const line = order.data.items.find(i => i.sku === "IT_001");
    assert.equal(line.name, "Steel Bottle", "editing the product does not change the order");
    assert.equal(line.unitPrice, 25000);
  });

  test("the same phone reuses one customer record", async () => {
    await anon.post("/orders", { customer: customer("+91 98765 43210", { name: "Someone Else" }), items: [{ sku: "IT_003", qty: 1 }] });
    const res = await owner.get("/admin/customers/c_919876543210");
    assert.equal(res.status, 200);
    assert.equal(res.data.customer.name, "Test Buyer", "public orders don't overwrite saved details");
    assert.equal(res.data.orders.length, 2);
  });

  test("out-of-stock products cannot be ordered", async () => {
    await owner.post("/admin/products", { sku: "IT_OOS", name: "Unavailable", categoryId: "water-bottle", price: 1000, manualStatus: "out_of_stock" });
    const res = await anon.post("/orders", { customer: customer("9111111111"), items: [{ sku: "IT_OOS", qty: 1 }] });
    assert.equal(res.status, 400);
    assert.match(res.data.error, /out of stock/);
  });

  test("honeypot submissions are refused", async () => {
    const res = await anon.post("/orders", { customer: customer(), items: [{ sku: "IT_001", qty: 2 }], website: "spam" });
    assert.equal(res.status, 400);
  });
});

describe("stock reservation, overselling and cancellation", () => {
  test("pending orders cannot be confirmed without prices", async () => {
    const unpriced = await anon.post("/orders", { customer: customer("9222222222"), items: [{ sku: "IT_003", qty: 1 }] });
    const res = await owner.post(`/admin/orders/${unpriced.data.id}/status`, { status: "confirmed" });
    assert.equal(res.status, 409);
    // Admin sets the price, then confirmation works.
    const edit = await owner.patch(`/admin/orders/${unpriced.data.id}`, { items: [{ sku: "IT_003", qty: 1, unitPrice: 15000 }] });
    assert.equal(edit.status, 200);
    assert.equal(edit.data.totals.grandTotal, 15000);
    assert.equal((await owner.post(`/admin/orders/${unpriced.data.id}/status`, { status: "confirmed" })).status, 200);
  });

  test("concurrent confirmations cannot oversell", async () => {
    // IT_001 has 10 in stock. Two orders of 6 each: only one may be confirmed.
    const a = await anon.post("/orders", { customer: customer("9333333331"), items: [{ sku: "IT_001", qty: 6 }] });
    const b = await anon.post("/orders", { customer: customer("9333333332"), items: [{ sku: "IT_001", qty: 6 }] });
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    const results = await Promise.all([
      owner.post(`/admin/orders/${a.data.id}/status`, { status: "confirmed" }),
      owner.post(`/admin/orders/${b.data.id}/status`, { status: "confirmed" })
    ]);
    const statuses = results.map(r => r.status).sort();
    assert.deepEqual(statuses, [200, 409], JSON.stringify(results.map(r => r.data.error || "ok")));
    const product = await owner.get(`/admin/products/${ids.p1}`);
    assert.equal(product.data.stockQty, 10);
    assert.equal(product.data.reservedQty, 6);
    assert.equal(product.data.availableQty, 4);
    ids.reservedOrder = results[0].status === 200 ? a.data.id : b.data.id;
    ids.rejectedOrder = results[0].status === 200 ? b.data.id : a.data.id;
  });

  test("customers cannot order more than is available", async () => {
    const res = await anon.post("/orders", { customer: customer("9444444444"), items: [{ sku: "IT_001", qty: 5 }] });
    assert.equal(res.status, 409);
    assert.equal(res.data.details.shortages[0].available, 4);
  });

  test("cancelling a confirmed order releases its reservation", async () => {
    const res = await owner.post(`/admin/orders/${ids.reservedOrder}/status`, { status: "cancelled", note: "Customer changed mind" });
    assert.equal(res.status, 200);
    const product = await owner.get(`/admin/products/${ids.p1}`);
    assert.equal(product.data.reservedQty, 0);
    assert.equal(product.data.stockQty, 10);
    const noReason = await owner.post(`/admin/orders/${ids.rejectedOrder}/status`, { status: "cancelled" });
    assert.equal(noReason.status, 400);
  });

  test("dispatch deducts stock exactly once; dispatched orders cannot be cancelled", async () => {
    const confirm = await owner.post(`/admin/orders/${ids.order1}/status`, { status: "confirmed" });
    assert.equal(confirm.status, 200, JSON.stringify(confirm.data));
    let product = await owner.get(`/admin/products/${ids.p1}`);
    assert.equal(product.data.reservedQty, 4);
    assert.equal(product.data.stockQty, 10);

    assert.equal((await owner.post(`/admin/orders/${ids.order1}/status`, { status: "processing" })).status, 200);
    assert.equal((await owner.post(`/admin/orders/${ids.order1}/status`, { status: "dispatched" })).status, 200);
    product = await owner.get(`/admin/products/${ids.p1}`);
    assert.equal(product.data.stockQty, 6);
    assert.equal(product.data.reservedQty, 0);

    const again = await owner.post(`/admin/orders/${ids.order1}/status`, { status: "dispatched" });
    assert.equal(again.status, 409);
    const cancel = await owner.post(`/admin/orders/${ids.order1}/status`, { status: "cancelled", note: "Too late" });
    assert.equal(cancel.status, 409);
    product = await owner.get(`/admin/products/${ids.p1}`);
    assert.equal(product.data.stockQty, 6, "no second deduction");

    const movements = await owner.get(`/admin/inventory/movements?productId=${ids.p1}`);
    const forOrder = movements.data.items.filter(m => m.orderId === ids.order1);
    assert.deepEqual(forOrder.map(m => m.type).sort(), ["deduct", "reserve"]);
  });

  test("products used in orders can be archived but not deleted", async () => {
    const res = await owner.del(`/admin/products/${ids.p1}`);
    assert.equal(res.status, 409);
  });
});

describe("invoices", () => {
  test("pending orders cannot be invoiced", async () => {
    const pending = await anon.post("/orders", { customer: customer("9555555555"), items: [{ sku: ids.p2sku, qty: 1 }] });
    ids.pendingOrder = pending.data.id;
    const res = await owner.post(`/admin/orders/${pending.data.id}/invoice`, {});
    assert.equal(res.status, 409);
  });

  test("issue an invoice with correct totals", async () => {
    const res = await owner.post(`/admin/orders/${ids.order1}/invoice`, {});
    assert.equal(res.status, 200, JSON.stringify(res.data));
    assert.match(res.data.invoiceNo, /^OSS\/\d{4}-\d{2}\/0001$/);
    assert.equal(res.data.totals.grandTotal, 185000);
    assert.equal(res.data.balanceDue, 185000);
    assert.equal(res.data.documentTitle, "Invoice", "no GST registration configured");
    assert.equal(res.data.share.status, "ready");
    ids.invoice1 = res.data.id;
    const again = await owner.post(`/admin/orders/${ids.order1}/invoice`, {});
    assert.equal(again.status, 409, "one active invoice per order");
  });

  test("concurrent issues get unique sequential numbers", async () => {
    const orders = [];
    for (const phone of ["9666666661", "9666666662", "9666666663"]) {
      const o = await anon.post("/orders", { customer: customer(phone), items: [{ sku: "IT_003", qty: 1 }] });
      await owner.patch(`/admin/orders/${o.data.id}`, { items: [{ sku: "IT_003", qty: 1, unitPrice: 60000 }] });
      await owner.post(`/admin/orders/${o.data.id}/status`, { status: "confirmed" });
      orders.push(o.data.id);
    }
    const results = await Promise.all(orders.map(id => owner.post(`/admin/orders/${id}/invoice`, {})));
    results.forEach(r => assert.equal(r.status, 200, JSON.stringify(r.data)));
    const numbers = results.map(r => r.data.invoiceNo).sort();
    assert.equal(new Set(numbers).size, 3);
    assert.deepEqual(numbers.map(n => n.slice(-4)), ["0002", "0003", "0004"]);
  });

  test("reopening an invoice returns the stored document; PDF renders", async () => {
    const res = await owner.get(`/admin/invoices/${ids.invoice1}`);
    assert.equal(res.status, 200);
    assert.equal(res.data.lines[0].name, "Steel Bottle");
    const pdf = await owner.get(`/admin/invoices/${ids.invoice1}/pdf`);
    assert.equal(pdf.status, 200);
    assert.equal(pdf.headers.get("content-type"), "application/pdf");
    assert.equal(pdf.data.subarray(0, 5).toString(), "%PDF-");
    assert.equal(pdf.headers.get("cache-control"), "private, no-store");
  });

  test("invoices are not accessible without auth or a valid signed link", async () => {
    assert.equal((await anon.get(`/admin/invoices/${ids.invoice1}/pdf`)).status, 401);
    assert.equal((await anon.get(`/invoice-pdf?id=${ids.invoice1}`)).status, 403);
    const link = await owner.post(`/admin/invoices/${ids.invoice1}/share-link`, { days: 7 });
    assert.equal(link.status, 200);
    const url = new URL(link.data.url);
    const ok = await anon.get(`/invoice-pdf${url.search}`);
    assert.equal(ok.status, 200);
    assert.equal(ok.data.subarray(0, 5).toString(), "%PDF-");
    url.searchParams.set("exp", String(Number(url.searchParams.get("exp")) + 999999));
    assert.equal((await anon.get(`/invoice-pdf${url.search}`)).status, 403);
  });

  test("sharing never claims delivery until the admin confirms", async () => {
    let res = await owner.post(`/admin/invoices/${ids.invoice1}/share-events`, { type: "whatsapp_link" });
    assert.equal(res.data.share.status, "share_opened");
    res = await owner.post(`/admin/invoices/${ids.invoice1}/share-events`, { markSent: true });
    assert.equal(res.data.share.status, "sent_confirmed");
    assert.equal(res.data.share.events.length, 2);
  });

  test("payments: no overpayment, partial then paid, customer balance updates", async () => {
    const over = await owner.post(`/admin/invoices/${ids.invoice1}/payments`, { amount: 185001, method: "upi" });
    assert.equal(over.status, 400);
    const part = await owner.post(`/admin/invoices/${ids.invoice1}/payments`, { amount: 85000, method: "upi", reference: "UPI123" });
    assert.equal(part.data.paymentStatus, "partial");
    assert.equal(part.data.balanceDue, 100000);
    const cust = await owner.get("/admin/customers/c_919876543210");
    assert.equal(cust.data.customer.outstanding, 100000);
  });

  test("an invoice with payments cannot be cancelled until they are voided", async () => {
    const blocked = await owner.post(`/admin/invoices/${ids.invoice1}/cancel`, { reason: "Wrong price" });
    assert.equal(blocked.status, 409);
    const inv = await owner.get(`/admin/invoices/${ids.invoice1}`);
    const staffVoid = await staff.post(`/admin/payments/${inv.data.payments[0].id}/void`, { reason: "Entered twice" });
    assert.equal(staffVoid.status, 403, "only the owner can void payments");
    const voided = await owner.post(`/admin/payments/${inv.data.payments[0].id}/void`, { reason: "Entered twice" });
    assert.equal(voided.data.balanceDue, 185000);
    const cancelled = await owner.post(`/admin/invoices/${ids.invoice1}/cancel`, { reason: "Wrong price" });
    assert.equal(cancelled.status, 200);
    assert.equal(cancelled.data.status, "cancelled");
    assert.equal(cancelled.data.lines.length, 2, "cancelled invoices are kept");
  });

  test("re-issued invoice gets a new number and references the cancelled one", async () => {
    const res = await owner.post(`/admin/orders/${ids.order1}/invoice`, {});
    assert.equal(res.status, 200);
    assert.notEqual(res.data.invoiceNo, undefined);
    assert.match(res.data.invoiceNo, /0005$/);
    assert.equal(res.data.replaces.id, ids.invoice1);
  });

  test("GST invoices calculate tax from settings", async () => {
    const bad = await owner.put("/admin/settings", { businessName: "ONE STOP SOLUTION (OSS)", invoicePrefix: "OSS", taxMode: "gst" });
    assert.equal(bad.status, 400, "GSTIN and state are required for GST");
    const ok = await owner.put("/admin/settings", { businessName: "ONE STOP SOLUTION (OSS)", invoicePrefix: "OSS", taxMode: "gst", gstin: "24AAACB1234C1Z5", stateCode: "24", defaultGstRate: 18, pricesIncludeTax: false, roundOff: false, minOrderValue: 50000 });
    assert.equal(ok.status, 200, JSON.stringify(ok.data));
    const o = await anon.post("/orders", { customer: customer("9777777777", { stateCode: "27" }), items: [{ sku: ids.p2sku, qty: 1 }] });
    await owner.post(`/admin/orders/${o.data.id}/status`, { status: "confirmed" });
    const inv = await owner.post(`/admin/orders/${o.data.id}/invoice`, {});
    assert.equal(inv.status, 200, JSON.stringify(inv.data));
    assert.equal(inv.data.documentTitle, "Tax Invoice");
    assert.equal(inv.data.totals.taxable, 84950);
    assert.equal(inv.data.totals.igst, 15291, "inter-state (Maharashtra vs Gujarat) uses IGST");
    assert.equal(inv.data.totals.grandTotal, 84950 + 15291);
    await owner.put("/admin/settings", { businessName: "ONE STOP SOLUTION (OSS)", invoicePrefix: "OSS", taxMode: "none", minOrderValue: 50000 });
  });
});

describe("unavailable integrations report accurately", () => {
  test("missing invoice link secret gives a clear 503", async () => {
    const saved = process.env.INVOICE_LINK_SECRET;
    delete process.env.INVOICE_LINK_SECRET;
    const res = await owner.post(`/admin/invoices/${ids.invoice1}/share-link`, {});
    process.env.INVOICE_LINK_SECRET = saved;
    assert.equal(res.status, 503);
    assert.match(res.data.error, /not configured/);
  });
});

describe("dashboard and CSV", () => {
  test("dashboard figures come from stored data", async () => {
    const res = await owner.get("/admin/dashboard");
    assert.equal(res.status, 200, JSON.stringify(res.data));
    assert.ok(res.data.products.active >= 4);
    assert.ok(res.data.orders.awaitingConfirmation >= 1);
    assert.ok(res.data.sales.invoices >= 4);
    assert.equal(typeof res.data.outstanding.total, "number");
  });

  test("CSV import previews conflicts and does not overwrite by default", async () => {
    const csv = "sku,name,category,price\nIT_001,Overwrite Attempt,Water Bottle,1.00\nIT_NEW,Imported Item,Imported Category,99.50\n";
    const preview = await owner.post("/admin/products/import", { csv, mode: "preview" });
    assert.equal(preview.status, 200);
    assert.deepEqual(preview.data.rows.map(r => r.action), ["update", "create"]);
    const commit = await owner.post("/admin/products/import", { csv, mode: "commit" });
    assert.deepEqual(commit.data.results.map(r => r.outcome), ["skipped", "created"]);
    const kept = await owner.get(`/admin/products/${ids.p1}`);
    assert.equal(kept.data.name, "Renamed Bottle");
    const created = await anon.get("/products/IT_NEW");
    assert.equal(created.data.product.price, 9950);
  });

  test("CSV export neutralises spreadsheet formulas", async () => {
    await owner.post("/admin/products", { sku: "IT_FORMULA", name: "=HYPERLINK(\"x\")", categoryId: "water-bottle" });
    const res = await owner.get("/admin/products/export.csv");
    assert.equal(res.status, 200);
    assert.ok(res.data.toString().includes("'=HYPERLINK"));
  });
});
