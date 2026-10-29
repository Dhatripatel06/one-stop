import { test } from "node:test";
import assert from "node:assert/strict";
import { INVOICE_TERMS, balanceDueText, invoiceDate, invoiceTermsFor, separateShippingAddress } from "../../shared/constants.js";
import { formatINR } from "../../shared/pricing.js";
import PDFDocument from "pdfkit";
import { renderInvoicePdf } from "../../server/invoice-pdf.js";
import { invoiceHtml } from "../../admin/views/invoices.js";

test("invoices issued before terms were stored still get the standard terms", () => {
  assert.equal(invoiceTermsFor({}), INVOICE_TERMS);
  assert.equal(invoiceTermsFor({ status: "cancelled" }), INVOICE_TERMS);
  const stored = { title: "T", headline: "H", lines: ["L"] };
  assert.equal(invoiceTermsFor({ standardTerms: stored }), stored, "a stored copy wins");
  assert.equal(INVOICE_TERMS.headline, "NO RETURN | NO REFUND | NO EXCHANGE");
  assert.deepEqual(INVOICE_TERMS.lines, [
    "Goods once sold will not be taken back or exchanged.",
    "Deposit amounts are non-refundable in case of order cancellation."
  ]);
});

test("ship-to is only printed when it differs from billing", () => {
  assert.equal(separateShippingAddress({ billingAddress: "Top3", shippingAddress: "Top3" }), "");
  assert.equal(separateShippingAddress({ billingAddress: "12 Road\nCity", shippingAddress: "12  Road City " }), "", "whitespace-only differences");
  assert.equal(separateShippingAddress({ billingAddress: "A", shippingAddress: "" }), "");
  assert.equal(separateShippingAddress({ shippingAddress: "Godown 7" }), "Godown 7");
  assert.equal(separateShippingAddress({ billingAddress: "Shop 1", shippingAddress: "Godown 7" }), "Godown 7");
});

const base = {
  documentTitle: "Invoice",
  seller: { businessName: "ONE STOP SOLUTION (OSS)", tagline: "Every Problem, One Solution", phone: "9499806747" },
  invoiceNo: "TEST/2026-27/0001", issuedAt: "2026-10-27T06:00:00Z",
  customer: { name: "Sample Buyer", billingAddress: "Sample address", shippingAddress: "Sample address" },
  lines: [{ lineNo: 1, sku: "SAMPLE_1", name: "SAMPLE ITEM", qty: 1, unit: "pcs", listPrice: 7500, unitPrice: 7500, gross: 7500, discount: 0, taxable: 7500, taxAmount: 0, total: 7500 }],
  totals: { gross: 7500, discount: 0, taxable: 7500, roundOff: 0, grandTotal: 7500 },
  taxSnapshot: { mode: "none" },
  amountPaid: 0, paymentStatus: "unpaid"
};

test("PDFs render for legacy cancelled, online and offline invoices", async () => {
  const cases = [
    { ...base, orderNo: "ORD-2026-00001", status: "cancelled", cancelReason: "Sample reason", balanceDue: 0 },
    { ...base, orderNo: "ORD-2026-00002", status: "issued", balanceDue: 7500, standardTerms: INVOICE_TERMS, source: "order" },
    { ...base, orderNo: null, status: "issued", balanceDue: 7500, standardTerms: INVOICE_TERMS, source: "offline" }
  ];
  for (const invoice of cases) {
    const pdf = await renderInvoicePdf(invoice);
    assert.equal(pdf.subarray(0, 5).toString(), "%PDF-");
    assert.equal((pdf.toString("latin1").match(/\/Type \/Page\b/g) || []).length, 1, "terms fit on one page");
  }
});

// Records every string drawn, with its position, while one invoice renders.
async function drawnText(invoice) {
  const original = PDFDocument.prototype.text;
  const drawn = [];
  PDFDocument.prototype.text = function (value, x, y, ...rest) {
    drawn.push({ value: String(value), x, y });
    return original.call(this, value, x, y, ...rest);
  };
  try {
    await renderInvoicePdf(invoice);
  } finally {
    PDFDocument.prototype.text = original;
  }
  return drawn;
}

const HEADINGS = ["Particulars", "Rate", "Qnt", "Amount"];

for (const [label, taxSnapshot] of [["non-GST", { mode: "none" }], ["GST", { mode: "gst", interState: false }]]) {
  test(`${label} item table reads Particulars | Rate | Qnt | Amount with values under their headings`, async () => {
    const line = { ...base.lines[0], qty: 3, unitPrice: 2500, listPrice: 2500, gross: 7500, taxable: 7500, total: 7500, gstRate: 0 };
    const drawn = await drawnText({ ...base, taxSnapshot, lines: [line], status: "issued", balanceDue: 7500, source: "offline" });

    const headings = HEADINGS.map(h => drawn.find(d => d.value === h));
    headings.forEach((h, i) => assert.ok(h, `${HEADINGS[i]} heading is drawn`));
    assert.equal(drawn.some(d => d.value === "Qty" || d.value === "Item"), false, "old labels are gone");
    const xs = headings.map(h => h.x);
    assert.deepEqual([...xs].sort((a, b) => a - b), xs, "headings run left to right in the required order");
    assert.ok(headings.every(h => h.y === headings[0].y), "headings share one row");

    // Each value sits in the same column as its heading.
    const row = drawn.filter(d => d.y > headings[0].y && d.y < headings[0].y + 40);
    const under = heading => row.find(d => d.x === heading.x)?.value;
    assert.equal(under(headings[0]), "SAMPLE ITEM");
    assert.equal(under(headings[1]), "₹25.00", "rate");
    assert.equal(under(headings[2]), "3 pcs", "quantity");
    assert.equal(under(headings[3]), "₹75.00", "amount");
  });
}

test("invoice dates print as DD-MM-YYYY on the IST calendar day", () => {
  assert.equal(invoiceDate("2026-10-29T06:00:00Z"), "29-10-2026");
  assert.equal(invoiceDate("2026-10-28T19:00:00Z"), "29-10-2026", "00:30 IST is already the 29th");
  assert.equal(invoiceDate("2026-10-29T18:00:00Z"), "29-10-2026", "23:30 IST is still the 29th");
  assert.equal(invoiceDate(new Date("2026-01-05T04:00:00Z")), "05-01-2026", "zero-padded");
  assert.equal(invoiceDate("2026-10-29"), "29-10-2026", "stored payment dates are reordered, never shifted");
  assert.equal(invoiceDate(""), "");
  assert.equal(invoiceDate(null), "");
});

test("the PDF shows the stored issue date and payment dates as DD-MM-YYYY", async () => {
  const drawn = await drawnText({
    ...base, issuedAt: "2026-10-28T19:00:00Z", status: "issued", balanceDue: 2500, amountPaid: 5000, source: "order",
    payments: [{ date: "2026-10-29", method: "upi", amount: 5000, status: "recorded" }]
  });
  const label = drawn.find(d => d.value === "Invoice Date");
  const value = drawn.find(d => d.y === label.y && d.x > label.x);
  assert.equal(value.value, "29-10-2026", "uses issuedAt, not today");
  assert.ok(drawn.some(d => d.value.startsWith("29-10-2026  ·  ")), "payment line uses the same format");
});

for (const [label, taxSnapshot] of [["non-GST", { mode: "none" }], ["GST", { mode: "gst", interState: false }]]) {
  test(`${label} on-screen invoice matches the PDF: Particulars | Rate | Qnt | Amount and DD-MM-YYYY`, () => {
    const line = { ...base.lines[0], qty: 3, unitPrice: 2500, listPrice: 2500, total: 7500 };
    const html = invoiceHtml({ ...base, taxSnapshot, issuedAt: "2026-10-28T19:00:00Z", lines: [line], status: "issued", balanceDue: 7500, source: "offline" });
    const cells = tag => [...html.matchAll(new RegExp(`<${tag}>(.*?)</${tag}>`, "gs"))].map(m => m[1].replace(/<[^>]+>/g, "").trim());
    const headings = cells("th").filter(h => ["#", "Particulars", "Rate", "Qnt", "Discount", "Taxable", "GST", "Tax", "Amount"].includes(h));
    const order = HEADINGS.map(h => headings.indexOf(h));
    assert.ok(order.every(i => i >= 0), "all headings present");
    assert.deepEqual([...order].sort((a, b) => a - b), order, "headings in the required order");
    assert.equal(headings.includes("Qty") || headings.includes("Item"), false);

    const row = cells("td").slice(0, headings.length);
    assert.equal(row[headings.indexOf("Rate")], "₹25.00");
    assert.equal(row[headings.indexOf("Qnt")], "3 pcs");
    assert.equal(row[headings.indexOf("Amount")], "₹75.00");
    assert.match(html, /<dt>Invoice date<\/dt><dd>29-10-2026<\/dd>/);
  });
}

test("cancelled invoices label the balance; amounts are unchanged", () => {
  const cancelled = { status: "cancelled", balanceDue: 0, amountPaid: 0, totals: { grandTotal: 7500 } };
  assert.equal(balanceDueText(cancelled, formatINR), "₹0.00 (Invoice cancelled)");
  assert.equal(cancelled.balanceDue, 0);
  assert.equal(cancelled.totals.grandTotal, 7500);
  assert.equal(balanceDueText({ status: "issued", balanceDue: 2500, totals: { grandTotal: 7500 } }, formatINR), "₹25.00");
  assert.equal(balanceDueText({ status: "issued", totals: { grandTotal: 7500 } }, formatINR), "₹75.00", "falls back to the total like before");
});
