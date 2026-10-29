/* Offline (walk-in) invoices against the Firebase emulators.
   Run: npm run test:integration   (starts emulators automatically) */

import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { clearFirestore, client, createUser, db, startServer } from "./helpers.js";

let server, owner, staff, viewer, anon;
const ids = {};
let seqCounter = 0;
const rid = () => `test-request-${Date.now()}-${++seqCounter}-abcdef`;
const lastFour = invoiceNo => Number(invoiceNo.slice(-4));

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

  // Tracked, untracked and unpriced products.
  const tracked = await owner.post("/admin/products", { sku: "OFF_001", name: "Steel Bottle", newCategoryName: "Bottles", price: 25000 });
  assert.equal(tracked.status, 200, JSON.stringify(tracked.data));
  ids.tracked = tracked.data.id;
  const stock = await owner.post(`/admin/products/${ids.tracked}/stock`, { type: "initial", qty: 10, reason: "Opening count" });
  assert.equal(stock.status, 200, JSON.stringify(stock.data));
  const untracked = await owner.post("/admin/products", { sku: "OFF_002", name: "Lunch Box", categoryId: "bottles", price: 7550 });
  assert.equal(untracked.status, 200, JSON.stringify(untracked.data));
  const unpriced = await owner.post("/admin/products", { sku: "OFF_003", name: "Price On Request Item", categoryId: "bottles" });
  assert.equal(unpriced.status, 200, JSON.stringify(unpriced.data));
});

after(async () => {
  await server?.close();
});

const stockOf = async id => (await db().collection("products").doc(id).get()).get("stockQty");

describe("offline invoices: access", () => {
  test("anonymous users and non-admins are refused", async () => {
    const body = { customer: { name: "Walk In" }, items: [{ sku: "OFF_002", qty: 1 }] };
    assert.equal((await anon.get("/admin/offline-invoices")).status, 401);
    assert.equal((await anon.post("/admin/offline-invoices", body)).status, 401);
    assert.equal((await anon.post("/admin/offline-invoices/preview", body)).status, 401);
    assert.equal((await viewer.get("/admin/offline-invoices")).status, 403);
    assert.equal((await viewer.post("/admin/offline-invoices", body)).status, 403);
    const count = await db().collection("invoices").count().get();
    assert.equal(count.data().count, 0, "nothing was written");
  });
});

describe("offline invoices: create", () => {
  test("preview recalculates on the server and reports missing prices", async () => {
    const res = await owner.post("/admin/offline-invoices/preview", { items: [{ sku: "OFF_001", qty: 2 }, { sku: "OFF_003", qty: 1 }] });
    assert.equal(res.status, 200, JSON.stringify(res.data));
    assert.deepEqual(res.data.missingPrices, ["OFF_003"]);
    assert.equal(res.data.totals.priced, false);
    assert.equal(res.data.totals.grandTotal, null, "no invented total");
    assert.equal(res.data.lines[0].total, 50000);
  });

  test("creates an invoice without an order, phone or customer record", async () => {
    const res = await owner.post("/admin/offline-invoices", {
      requestId: rid(),
      customer: { name: "Walk-in Customer" },
      items: [{ sku: "OFF_001", qty: 2 }, { sku: "OFF_002", qty: 3 }],
      // Browser-sent totals are ignored; only unitPrice overrides are accepted from admins.
      totals: { grandTotal: 1 }
    });
    assert.equal(res.status, 200, JSON.stringify(res.data));
    const inv = res.data;
    assert.equal(inv.source, "offline");
    assert.equal(inv.orderId, null);
    assert.equal(inv.orderNo, null);
    assert.equal(inv.customerId, null);
    assert.match(inv.invoiceNo, /^OSS\/\d{4}-\d{2}\/\d{4}$/);
    assert.equal(inv.lines.length, 2);
    // 2 × ₹250 + 3 × ₹75.50 = ₹726.50 → rounded off to ₹727 (roundOff is on by default)
    assert.equal(inv.totals.subtotal, 72650);
    assert.equal(inv.totals.roundOff, 50);
    assert.equal(inv.totals.grandTotal, 72700);
    assert.equal(inv.balanceDue, 72700);
    assert.equal(inv.paymentStatus, "unpaid");
    assert.equal(inv.share.status, "ready", "creating is not sharing");
    assert.equal(inv.standardTerms.headline, "NO RETURN | NO REFUND | NO EXCHANGE");
    assert.deepEqual(inv.stockDeducted, [{ productId: ids.tracked, sku: "OFF_001", qty: 2 }]);
    assert.equal(await stockOf(ids.tracked), 8, "tracked stock deducted at sale");
    ids.walkIn = inv.id;
    ids.walkInNo = inv.invoiceNo;

    const orders = await db().collection("orders").count().get();
    assert.equal(orders.data().count, 0, "no fake online order");
    const moves = await db().collection("inventoryMovements").where("type", "==", "sale").get();
    assert.equal(moves.size, 1);
    assert.equal(moves.docs[0].get("invoiceNo"), inv.invoiceNo);
  });

  test("with a phone number, the customer record is created and billed", async () => {
    const res = await staff.post("/admin/offline-invoices", {
      requestId: rid(),
      customer: { name: "Ravi Traders", phone: "98765 43210", billingAddress: "12 Market Road\nBhavnagar" },
      items: [{ sku: "OFF_002", qty: 2, unitPrice: 7000 }]
    });
    assert.equal(res.status, 200, JSON.stringify(res.data));
    assert.equal(res.data.customer.phone, "919876543210");
    assert.equal(res.data.customerId, "c_919876543210");
    assert.equal(res.data.lines[0].discount, 1100, "admin price below catalogue shows as a discount");
    assert.equal(res.data.totals.grandTotal, 14000);
    const cust = await db().collection("customers").doc("c_919876543210").get();
    assert.equal(cust.get("totalBilled"), 14000);
    ids.ravi = res.data.id;
  });

  test("international numbers with a country code are accepted", async () => {
    const res = await owner.post("/admin/offline-invoices", {
      requestId: rid(), customer: { name: "Dubai Buyer", phone: "+971 50 123 4567" }, items: [{ sku: "OFF_002", qty: 1 }]
    });
    assert.equal(res.status, 200, JSON.stringify(res.data));
    assert.equal(res.data.customer.phone, "971501234567");
  });

  test("invalid input is refused with field errors and nothing is written", async () => {
    const before = (await db().collection("invoices").count().get()).data().count;
    const badPhone = await owner.post("/admin/offline-invoices", { requestId: rid(), customer: { name: "X Y", phone: "12345" }, items: [{ sku: "OFF_002", qty: 1 }] });
    assert.equal(badPhone.status, 400);
    assert.ok(badPhone.data.details.fields["customer.phone"]);
    const noName = await owner.post("/admin/offline-invoices", { requestId: rid(), customer: {}, items: [{ sku: "OFF_002", qty: 1 }] });
    assert.equal(noName.status, 400);
    assert.ok(noName.data.details.fields["customer.name"]);
    const noItems = await owner.post("/admin/offline-invoices", { requestId: rid(), customer: { name: "No Items" }, items: [] });
    assert.equal(noItems.status, 400);
    const unknown = await owner.post("/admin/offline-invoices", { requestId: rid(), customer: { name: "Unknown" }, items: [{ sku: "NOPE_999", qty: 1 }] });
    assert.equal(unknown.status, 400);
    const badQty = await owner.post("/admin/offline-invoices", { requestId: rid(), customer: { name: "Bad Qty" }, items: [{ sku: "OFF_002", qty: 1.5 }] });
    assert.equal(badQty.status, 400);
    const unpriced = await owner.post("/admin/offline-invoices", { requestId: rid(), customer: { name: "Unpriced" }, items: [{ sku: "OFF_003", qty: 1 }] });
    assert.equal(unpriced.status, 409, "no price is invented");
    const tooMany = await owner.post("/admin/offline-invoices", { requestId: rid(), customer: { name: "Too Many" }, items: [{ sku: "OFF_001", qty: 99 }] });
    assert.equal(tooMany.status, 409, "cannot sell more than tracked stock");
    const after = (await db().collection("invoices").count().get()).data().count;
    assert.equal(after, before);
    assert.equal(await stockOf(ids.tracked), 8);
  });

  test("an unpriced product can be billed once the owner enters a price", async () => {
    const res = await owner.post("/admin/offline-invoices", { requestId: rid(), customer: { name: "Priced Now" }, items: [{ sku: "OFF_003", qty: 2, unitPrice: 12000 }] });
    assert.equal(res.status, 200, JSON.stringify(res.data));
    assert.equal(res.data.totals.grandTotal, 24000);
  });

  test("a repeated submit returns the same invoice instead of a duplicate", async () => {
    const requestId = rid();
    const body = { requestId, customer: { name: "Double Click" }, items: [{ sku: "OFF_002", qty: 1 }] };
    const [a, b] = await Promise.all([owner.post("/admin/offline-invoices", body), owner.post("/admin/offline-invoices", body)]);
    assert.equal(a.status, 200, JSON.stringify(a.data));
    assert.equal(b.status, 200, JSON.stringify(b.data));
    assert.equal(a.data.id, b.data.id);
    assert.equal(a.data.invoiceNo, b.data.invoiceNo);
    const same = await db().collection("invoices").where("invoiceNo", "==", a.data.invoiceNo).get();
    assert.equal(same.size, 1);
  });

  test("concurrent invoices get unique sequential numbers", async () => {
    const results = await Promise.all(Array.from({ length: 5 }, (_, i) => owner.post("/admin/offline-invoices", {
      requestId: rid(), customer: { name: `Parallel ${i}` }, items: [{ sku: "OFF_002", qty: 1 }]
    })));
    results.forEach(r => assert.equal(r.status, 200, JSON.stringify(r.data)));
    const numbers = results.map(r => lastFour(r.data.invoiceNo)).sort((a, b) => a - b);
    assert.equal(new Set(numbers).size, 5);
    for (let i = 1; i < numbers.length; i += 1) assert.equal(numbers[i], numbers[i - 1] + 1);
  });

  test("online and offline invoices share one number sequence", async () => {
    const all = await db().collection("invoices").get();
    const highest = Math.max(...all.docs.map(d => d.get("seq")));
    assert.equal(all.size, highest, "no gaps or collisions so far");

    const order = await owner.post("/admin/orders", { customer: { name: "Online Buyer", phone: "9111111111" }, items: [{ sku: "OFF_002", qty: 1 }] });
    assert.equal(order.status, 200, JSON.stringify(order.data));
    assert.equal((await owner.post(`/admin/orders/${order.data.id}/status`, { status: "confirmed" })).status, 200);
    const online = await owner.post(`/admin/orders/${order.data.id}/invoice`, {});
    assert.equal(online.status, 200, JSON.stringify(online.data));
    assert.equal(online.data.source, "order");
    assert.equal(online.data.seq, highest + 1);
    ids.online = online.data.id;

    const offline = await owner.post("/admin/offline-invoices", { requestId: rid(), customer: { name: "After Online" }, items: [{ sku: "OFF_002", qty: 1 }] });
    assert.equal(offline.data.seq, highest + 2);
  });
});

describe("offline invoices: find, PDF, share", () => {
  test("the list shows offline invoices only, newest first", async () => {
    const res = await owner.get("/admin/offline-invoices?limit=100");
    assert.equal(res.status, 200, JSON.stringify(res.data));
    assert.ok(res.data.items.length >= 10);
    assert.ok(res.data.items.every(i => i.source === "offline"));
    assert.ok(!res.data.items.some(i => i.id === ids.online));
    const dates = res.data.items.map(i => i.issuedAt);
    assert.deepEqual(dates, [...dates].sort().reverse());
  });

  test("search by invoice number, customer name and phone", async () => {
    const byNo = await owner.get(`/admin/offline-invoices?q=${encodeURIComponent(ids.walkInNo)}`);
    assert.deepEqual(byNo.data.items.map(i => i.id), [ids.walkIn]);
    const byName = await owner.get("/admin/offline-invoices?q=ravi");
    assert.deepEqual(byName.data.items.map(i => i.id), [ids.ravi]);
    const byPhone = await owner.get("/admin/offline-invoices?q=98765");
    assert.deepEqual(byPhone.data.items.map(i => i.id), [ids.ravi]);
    const none = await owner.get("/admin/offline-invoices?q=nobody-here");
    assert.equal(none.data.items.length, 0);
  });

  test("open and download the PDF", async () => {
    const inv = await owner.get(`/admin/invoices/${ids.walkIn}`);
    assert.equal(inv.status, 200);
    assert.equal(inv.data.invoiceNo, ids.walkInNo);
    const pdf = await owner.get(`/admin/invoices/${ids.walkIn}/pdf`);
    assert.equal(pdf.status, 200);
    assert.equal(pdf.headers.get("content-type"), "application/pdf");
    assert.equal(pdf.data.subarray(0, 5).toString(), "%PDF-");
    assert.match(pdf.headers.get("content-disposition"), /OSS-\d{4}-\d{2}-\d{4}\.pdf/);
  });

  test("private invoice links: signed links work, tampered or missing ones do not", async () => {
    assert.equal((await anon.get(`/admin/invoices/${ids.walkIn}/pdf`)).status, 401);
    assert.equal((await viewer.get(`/admin/invoices/${ids.walkIn}/pdf`)).status, 403);
    assert.equal((await anon.get(`/invoice-pdf?id=${ids.walkIn}`)).status, 403);
    const link = await owner.post(`/admin/invoices/${ids.walkIn}/share-link`, { days: 7 });
    assert.equal(link.status, 200);
    const url = new URL(link.data.url);
    assert.equal((await anon.get(`/invoice-pdf${url.search}`)).status, 200);
    const other = new URL(link.data.url);
    other.searchParams.set("id", ids.ravi);
    assert.equal((await anon.get(`/invoice-pdf${other.search}`)).status, 403, "a link cannot be reused for another invoice");
    url.searchParams.set("sig", "x".repeat(43));
    assert.equal((await anon.get(`/invoice-pdf${url.search}`)).status, 403);
  });

  test("opening WhatsApp is recorded, but never as delivered", async () => {
    const res = await owner.post(`/admin/invoices/${ids.ravi}/share-events`, { type: "whatsapp_link" });
    assert.equal(res.status, 200);
    assert.equal(res.data.share.status, "share_opened");
  });
});

describe("offline invoices: payments and corrections", () => {
  test("payments work on an invoice without a customer record", async () => {
    const res = await owner.post(`/admin/invoices/${ids.walkIn}/payments`, { amount: 70000, method: "cash" });
    assert.equal(res.status, 200, JSON.stringify(res.data));
    assert.equal(res.data.paymentStatus, "partial");
    assert.equal(res.data.balanceDue, 2700);
    ids.payment = res.data.payments[0].id;
    const blocked = await owner.post(`/admin/invoices/${ids.walkIn}/cancel`, { reason: "Wrong items" });
    assert.equal(blocked.status, 409, "void payments first");
    const voided = await owner.post(`/admin/payments/${ids.payment}/void`, { reason: "Entered by mistake" });
    assert.equal(voided.status, 200, JSON.stringify(voided.data));
  });

  test("cancelling restores the deducted stock exactly once", async () => {
    assert.equal(await stockOf(ids.tracked), 8);
    const res = await owner.post(`/admin/invoices/${ids.walkIn}/cancel`, { reason: "Wrong items" });
    assert.equal(res.status, 200, JSON.stringify(res.data));
    assert.equal(res.data.status, "cancelled");
    assert.equal(await stockOf(ids.tracked), 10);
    const again = await owner.post(`/admin/invoices/${ids.walkIn}/cancel`, { reason: "Again" });
    assert.equal(again.status, 409);
    assert.equal(await stockOf(ids.tracked), 10);
  });

  test("a corrected invoice records what it replaces; active invoices cannot be replaced", async () => {
    const bad = await owner.post("/admin/offline-invoices", { requestId: rid(), replacesInvoiceId: ids.ravi, customer: { name: "X Y" }, items: [{ sku: "OFF_002", qty: 1 }] });
    assert.equal(bad.status, 409);
    const res = await owner.post("/admin/offline-invoices", { requestId: rid(), replacesInvoiceId: ids.walkIn, customer: { name: "Walk-in Customer" }, items: [{ sku: "OFF_001", qty: 1 }] });
    assert.equal(res.status, 200, JSON.stringify(res.data));
    assert.deepEqual(res.data.replaces, { id: ids.walkIn, invoiceNo: ids.walkInNo });
    assert.equal(await stockOf(ids.tracked), 9);
  });

  test("cancelling a customer's invoice reverses the billed total", async () => {
    const res = await owner.post(`/admin/invoices/${ids.ravi}/cancel`, { reason: "Duplicate" });
    assert.equal(res.status, 200, JSON.stringify(res.data));
    const cust = await db().collection("customers").doc("c_919876543210").get();
    assert.equal(cust.get("totalBilled"), 0);
  });

  test("a cancelled online invoice keeps its numbers and totals; no duplicate is created", async () => {
    const before = (await db().collection("invoices").count().get()).data().count;
    const res = await owner.post(`/admin/invoices/${ids.online}/cancel`, { reason: "xyz" });
    assert.equal(res.status, 200, JSON.stringify(res.data));
    const inv = res.data;
    assert.equal(inv.status, "cancelled");
    assert.match(inv.invoiceNo, /^OSS\/\d{4}-\d{2}\/\d{4}$/);
    assert.match(inv.orderNo, /^ORD-\d{4}-\d{5}$/);
    assert.equal(inv.totals.grandTotal, 7600, "the original amount (₹75.50, rounded off) stays on record");
    assert.equal(inv.amountPaid, 0);
    assert.equal(inv.balanceDue, 0, "nothing is owed on a cancelled invoice");
    assert.equal((await db().collection("invoices").count().get()).data().count, before);
    const pdf = await owner.get(`/admin/invoices/${ids.online}/pdf`);
    assert.equal(pdf.status, 200);
    assert.equal(pdf.data.subarray(0, 5).toString(), "%PDF-");
  });

  test("invoices stored before terms existed are still readable and render", async () => {
    const { FieldValue } = await import("firebase-admin/firestore");
    await db().collection("invoices").doc(ids.online).update({ standardTerms: FieldValue.delete(), source: FieldValue.delete() });
    const inv = await owner.get(`/admin/invoices/${ids.online}`);
    assert.equal(inv.status, 200);
    assert.equal(inv.data.standardTerms, undefined);
    const pdf = await owner.get(`/admin/invoices/${ids.online}/pdf`);
    assert.equal(pdf.status, 200);
    assert.equal(pdf.data.subarray(0, 5).toString(), "%PDF-");
    const list = await owner.get("/admin/offline-invoices?limit=100");
    assert.ok(!list.data.items.some(i => i.id === ids.online), "legacy online invoices never appear as offline");
  });

  test("issued offline invoices are not editable through the API", async () => {
    assert.equal((await owner.patch(`/admin/invoices/${ids.ravi}`, { totals: { grandTotal: 1 } })).status, 405);
    assert.equal((await owner.put(`/admin/invoices/${ids.ravi}`, {})).status, 405);
  });
});
