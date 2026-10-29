import { test } from "node:test";
import assert from "node:assert/strict";
import { INVOICE_TERMS, balanceDueText, invoiceTermsFor, separateShippingAddress } from "../../shared/constants.js";
import { formatINR } from "../../shared/pricing.js";
import { renderInvoicePdf } from "../../server/invoice-pdf.js";

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

test("cancelled invoices label the balance; amounts are unchanged", () => {
  const cancelled = { status: "cancelled", balanceDue: 0, amountPaid: 0, totals: { grandTotal: 7500 } };
  assert.equal(balanceDueText(cancelled, formatINR), "₹0.00 (Invoice cancelled)");
  assert.equal(cancelled.balanceDue, 0);
  assert.equal(cancelled.totals.grandTotal, 7500);
  assert.equal(balanceDueText({ status: "issued", balanceDue: 2500, totals: { grandTotal: 7500 } }, formatINR), "₹25.00");
  assert.equal(balanceDueText({ status: "issued", totals: { grandTotal: 7500 } }, formatINR), "₹75.00", "falls back to the total like before");
});
