/* =========================================================
   OSS PRICING & TAX
   Shared by the browser (estimates) and the server (authoritative).
   All amounts are integer paise. 100 paise = ₹1.
========================================================= */

export const GST_RATES = [0, 0.25, 3, 5, 12, 18, 28, 40];

// Indian GST state codes, used for place of supply.
export const INDIAN_STATES = [
  ["01", "Jammu and Kashmir"], ["02", "Himachal Pradesh"], ["03", "Punjab"],
  ["04", "Chandigarh"], ["05", "Uttarakhand"], ["06", "Haryana"],
  ["07", "Delhi"], ["08", "Rajasthan"], ["09", "Uttar Pradesh"],
  ["10", "Bihar"], ["11", "Sikkim"], ["12", "Arunachal Pradesh"],
  ["13", "Nagaland"], ["14", "Manipur"], ["15", "Mizoram"],
  ["16", "Tripura"], ["17", "Meghalaya"], ["18", "Assam"],
  ["19", "West Bengal"], ["20", "Jharkhand"], ["21", "Odisha"],
  ["22", "Chhattisgarh"], ["23", "Madhya Pradesh"], ["24", "Gujarat"],
  ["26", "Dadra and Nagar Haveli and Daman and Diu"], ["27", "Maharashtra"],
  ["29", "Karnataka"], ["30", "Goa"], ["31", "Lakshadweep"],
  ["32", "Kerala"], ["33", "Tamil Nadu"], ["34", "Puducherry"],
  ["35", "Andaman and Nicobar Islands"], ["36", "Telangana"],
  ["37", "Andhra Pradesh"], ["38", "Ladakh"], ["97", "Other Territory"]
];

export function stateName(code) {
  const found = INDIAN_STATES.find(([c]) => c === code);
  return found ? found[1] : "";
}

/* ---------------------------------------------------------
   MONEY
--------------------------------------------------------- */

export function isPaise(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

// "1,299.50" / "1299.5" / 1299.5 -> 129950. Returns null for empty input.
export function rupeesToPaise(input) {
  if (input === null || input === undefined) return null;
  const text = String(input).replace(/[₹,\s]/g, "");
  if (text === "") return null;
  if (!/^\d+(\.\d{1,2})?$/.test(text)) return NaN;
  const [whole, fraction = ""] = text.split(".");
  return Number(whole) * 100 + Number((fraction + "00").slice(0, 2));
}

export function paiseToRupeesString(paise) {
  if (paise === null || paise === undefined) return "";
  const sign = paise < 0 ? "-" : "";
  const abs = Math.abs(paise);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

// Indian digit grouping: 1234567.8 -> "12,34,567.80"
export function formatINR(paise, { symbol = true, decimals = true } = {}) {
  if (paise === null || paise === undefined || Number.isNaN(paise)) return "";
  const sign = paise < 0 ? "-" : "";
  const abs = Math.abs(Math.round(paise));
  const whole = String(Math.floor(abs / 100));
  const last3 = whole.slice(-3);
  const rest = whole.slice(0, -3);
  const grouped = rest
    ? `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ",")},${last3}`
    : last3;
  const fraction = String(abs % 100).padStart(2, "0");
  const showFraction = decimals === true || (decimals === "auto" && fraction !== "00");
  return `${sign}${symbol ? "₹" : ""}${grouped}${showFraction ? `.${fraction}` : ""}`;
}

/* ---------------------------------------------------------
   PRODUCT PRICE
--------------------------------------------------------- */

// The price a customer pays per unit, before tax handling.
export function effectiveUnitPrice(product) {
  const price = product?.price;
  const sale = product?.salePrice;
  if (!isPaise(price)) return null;
  if (isPaise(sale) && sale < price) return sale;
  return price;
}

/* ---------------------------------------------------------
   TOTALS
   lines: [{ qty, listPrice, unitPrice, gstRate }]
     listPrice  undiscounted unit price (paise) — optional
     unitPrice  price actually charged per unit (paise) or null
   tax: { mode: "none" | "gst", pricesIncludeTax, interState, defaultRate }
--------------------------------------------------------- */

function round(value) {
  // Half away from zero; avoids banker's rounding surprises on invoices.
  return Math.sign(value) * Math.round(Math.abs(value));
}

export function computeLine(line, tax = {}) {
  const qty = line.qty;
  const unitPrice = line.unitPrice;

  if (!isPaise(unitPrice)) {
    return {
      qty, unitPrice: null, listPrice: line.listPrice ?? null,
      gross: null, discount: null, net: null,
      gstRate: null, taxable: null, taxAmount: null,
      cgst: null, sgst: null, igst: null, total: null,
      priced: false
    };
  }

  const listPrice = isPaise(line.listPrice) && line.listPrice > unitPrice
    ? line.listPrice
    : unitPrice;

  const gross = listPrice * qty;
  const net = unitPrice * qty;
  const discount = gross - net;

  const gstEnabled = tax.mode === "gst";
  const rate = gstEnabled
    ? Number(line.gstRate ?? tax.defaultRate ?? 0)
    : 0;

  let taxable = net;
  let taxAmount = 0;

  if (gstEnabled && rate > 0) {
    if (tax.pricesIncludeTax) {
      taxable = round((net * 100) / (100 + rate));
      taxAmount = net - taxable;
    } else {
      taxAmount = round((net * rate) / 100);
    }
  }

  let cgst = 0, sgst = 0, igst = 0;
  if (taxAmount > 0) {
    if (tax.interState) {
      igst = taxAmount;
    } else {
      cgst = Math.floor(taxAmount / 2);
      sgst = taxAmount - cgst;
    }
  }

  return {
    qty, unitPrice, listPrice,
    gross, discount, net,
    gstRate: gstEnabled ? rate : null,
    taxable, taxAmount, cgst, sgst, igst,
    total: taxable + taxAmount,
    priced: true
  };
}

export function computeTotals(lines, tax = {}, { roundOff = false } = {}) {
  const computed = lines.map(line => ({ ...line, ...computeLine(line, tax) }));
  const priced = computed.every(line => line.priced);

  const sum = key => computed.reduce((acc, line) => acc + (line[key] || 0), 0);

  const breakdownMap = new Map();
  for (const line of computed) {
    if (!line.priced || tax.mode !== "gst") continue;
    const key = String(line.gstRate ?? 0);
    const entry = breakdownMap.get(key) || { rate: line.gstRate ?? 0, taxable: 0, cgst: 0, sgst: 0, igst: 0, tax: 0 };
    entry.taxable += line.taxable;
    entry.cgst += line.cgst;
    entry.sgst += line.sgst;
    entry.igst += line.igst;
    entry.tax += line.taxAmount;
    breakdownMap.set(key, entry);
  }

  const beforeRound = sum("total");
  const rounded = roundOff ? Math.round(beforeRound / 100) * 100 : beforeRound;

  return {
    lines: computed,
    priced,
    itemCount: computed.length,
    totalQty: computed.reduce((acc, line) => acc + line.qty, 0),
    gross: sum("gross"),
    discount: sum("discount"),
    subtotal: sum("net"),
    taxable: sum("taxable"),
    cgst: sum("cgst"),
    sgst: sum("sgst"),
    igst: sum("igst"),
    tax: sum("taxAmount"),
    taxBreakdown: [...breakdownMap.values()].sort((a, b) => a.rate - b.rate),
    roundOff: rounded - beforeRound,
    grandTotal: priced ? rounded : null
  };
}

/* ---------------------------------------------------------
   PAYMENT STATUS
--------------------------------------------------------- */

export function paymentStatus(grandTotal, amountPaid) {
  if (!amountPaid) return "unpaid";
  if (amountPaid >= grandTotal) return "paid";
  return "partial";
}

/* ---------------------------------------------------------
   AMOUNT IN WORDS (Indian system)
--------------------------------------------------------- */

const ONES = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten",
  "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen"];
const TENS = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];

function twoDigits(n) {
  if (n < 20) return ONES[n];
  return `${TENS[Math.floor(n / 10)]}${n % 10 ? ` ${ONES[n % 10]}` : ""}`;
}

function threeDigits(n) {
  const hundred = Math.floor(n / 100);
  const rest = n % 100;
  return [hundred ? `${ONES[hundred]} Hundred` : "", rest ? twoDigits(rest) : ""]
    .filter(Boolean).join(" ");
}

export function amountInWords(paise) {
  const rupees = Math.floor(Math.abs(paise) / 100);
  const fraction = Math.abs(paise) % 100;
  if (rupees === 0 && fraction === 0) return "Rupees Zero Only";

  const parts = [];
  const crore = Math.floor(rupees / 10000000);
  const lakh = Math.floor((rupees % 10000000) / 100000);
  const thousand = Math.floor((rupees % 100000) / 1000);
  const rest = rupees % 1000;

  if (crore) parts.push(`${threeDigits(crore)} Crore`);
  if (lakh) parts.push(`${twoDigits(lakh)} Lakh`);
  if (thousand) parts.push(`${twoDigits(thousand)} Thousand`);
  if (rest) parts.push(threeDigits(rest));

  let words = `Rupees ${parts.join(" ") || "Zero"}`;
  if (fraction) words += ` and ${twoDigits(fraction)} Paise`;
  return `${words} Only`;
}
