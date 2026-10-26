import { test } from "node:test";
import assert from "node:assert/strict";
import {
  amountInWords, computeLine, computeTotals, effectiveUnitPrice, formatINR, paymentStatus, rupeesToPaise
} from "../../shared/pricing.js";

test("formatINR uses Indian digit grouping", () => {
  assert.equal(formatINR(123456789), "₹12,34,567.89");
  assert.equal(formatINR(50000), "₹500.00");
  assert.equal(formatINR(50000, { decimals: "auto" }), "₹500");
  assert.equal(formatINR(5, { symbol: false }), "0.05");
  assert.equal(formatINR(-129950), "-₹1,299.50");
});

test("rupeesToPaise parses rupee strings exactly", () => {
  assert.equal(rupeesToPaise("1,299.50"), 129950);
  assert.equal(rupeesToPaise("₹ 849.5"), 84950);
  assert.equal(rupeesToPaise("0.1"), 10);
  assert.equal(rupeesToPaise(""), null);
  assert.ok(Number.isNaN(rupeesToPaise("12.345")));
  assert.ok(Number.isNaN(rupeesToPaise("-5")));
  assert.ok(Number.isNaN(rupeesToPaise("abc")));
});

test("effectiveUnitPrice prefers a valid lower sale price", () => {
  assert.equal(effectiveUnitPrice({ price: 1000, salePrice: 800 }), 800);
  assert.equal(effectiveUnitPrice({ price: 1000, salePrice: 1200 }), 1000);
  assert.equal(effectiveUnitPrice({ price: null, salePrice: 800 }), null);
});

test("totals without GST", () => {
  const t = computeTotals([
    { qty: 2, listPrice: 100000, unitPrice: 90000 },
    { qty: 3, listPrice: null, unitPrice: 25050 }
  ], { mode: "none" });
  assert.equal(t.gross, 200000 + 75150);
  assert.equal(t.discount, 20000);
  assert.equal(t.subtotal, 180000 + 75150);
  assert.equal(t.tax, 0);
  assert.equal(t.grandTotal, 255150);
  assert.equal(t.priced, true);
});

test("GST exclusive, intra-state splits into CGST + SGST", () => {
  const line = computeLine({ qty: 1, unitPrice: 10000, gstRate: 18 }, { mode: "gst", pricesIncludeTax: false, interState: false });
  assert.equal(line.taxable, 10000);
  assert.equal(line.taxAmount, 1800);
  assert.equal(line.cgst, 900);
  assert.equal(line.sgst, 900);
  assert.equal(line.igst, 0);
  assert.equal(line.total, 11800);
});

test("GST inclusive, inter-state uses IGST and keeps the price", () => {
  const line = computeLine({ qty: 1, unitPrice: 11800, gstRate: 18 }, { mode: "gst", pricesIncludeTax: true, interState: true });
  assert.equal(line.taxable, 10000);
  assert.equal(line.igst, 1800);
  assert.equal(line.total, 11800);
});

test("odd tax amounts split without losing a paisa", () => {
  const line = computeLine({ qty: 1, unitPrice: 1001, gstRate: 5 }, { mode: "gst", pricesIncludeTax: false });
  assert.equal(line.taxAmount, 50);
  assert.equal(line.cgst + line.sgst, line.taxAmount);
});

test("default GST rate applies when a line has none", () => {
  const t = computeTotals([{ qty: 1, unitPrice: 10000, gstRate: null }], { mode: "gst", pricesIncludeTax: false, defaultRate: 12 });
  assert.equal(t.tax, 1200);
  assert.deepEqual(t.taxBreakdown.map(r => r.rate), [12]);
});

test("round off to nearest rupee", () => {
  const t = computeTotals([{ qty: 1, unitPrice: 10049 }], { mode: "none" }, { roundOff: true });
  assert.equal(t.grandTotal, 10000);
  assert.equal(t.roundOff, -49);
  const up = computeTotals([{ qty: 1, unitPrice: 10050 }], { mode: "none" }, { roundOff: true });
  assert.equal(up.grandTotal, 10100);
});

test("unpriced lines make the order unpriced", () => {
  const t = computeTotals([{ qty: 1, unitPrice: 1000 }, { qty: 2, unitPrice: null }], { mode: "none" });
  assert.equal(t.priced, false);
  assert.equal(t.grandTotal, null);
});

test("amount in words (Indian system)", () => {
  assert.equal(amountInWords(299800), "Rupees Two Thousand Nine Hundred Ninety Eight Only");
  assert.equal(amountInWords(1234567850), "Rupees One Crore Twenty Three Lakh Forty Five Thousand Six Hundred Seventy Eight and Fifty Paise Only");
  assert.equal(amountInWords(0), "Rupees Zero Only");
});

test("payment status", () => {
  assert.equal(paymentStatus(1000, 0), "unpaid");
  assert.equal(paymentStatus(1000, 400), "partial");
  assert.equal(paymentStatus(1000, 1000), "paid");
});
