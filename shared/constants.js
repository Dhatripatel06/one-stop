/* =========================================================
   OSS SHARED CONSTANTS
========================================================= */

export const ORDER_STATUSES = {
  pending: "Pending confirmation",
  confirmed: "Confirmed",
  processing: "Processing",
  dispatched: "Dispatched",
  completed: "Completed",
  cancelled: "Cancelled"
};

// Allowed status transitions. Stock policy:
//   confirm  -> reserve stock for tracked products
//   dispatch -> deduct reserved stock (the single deduction point)
//   cancel   -> release reservation (only possible before dispatch)
export const ORDER_TRANSITIONS = {
  pending: ["confirmed", "cancelled"],
  confirmed: ["processing", "dispatched", "cancelled"],
  processing: ["dispatched", "cancelled"],
  dispatched: ["completed"],
  completed: [],
  cancelled: []
};

export const INVOICEABLE_STATUSES = ["confirmed", "processing", "dispatched", "completed"];

export const AVAILABILITY = {
  in_stock: "In Stock",
  low_stock: "Low Stock",
  coming_soon: "Coming Soon",
  out_of_stock: "Out of Stock"
};

export const MANUAL_STATUSES = ["in_stock", "coming_soon", "out_of_stock"];

export const PRODUCT_STATUSES = ["active", "inactive", "archived"];

export const MOVEMENT_TYPES = {
  initial: "Initial stock entry",
  increase: "Stock increase",
  decrease: "Stock decrease",
  correction: "Manual correction",
  reserve: "Reserved for order",
  release: "Reservation released",
  deduct: "Dispatched (deducted)",
  sale: "Offline sale (deducted)",
  sale_reversal: "Offline sale cancelled (restored)"
};

export const PAYMENT_METHODS = {
  cash: "Cash",
  upi: "UPI",
  bank_transfer: "Bank transfer",
  cheque: "Cheque",
  card: "Card",
  other: "Other"
};

// Standard sale terms printed on every invoice (online and offline). They are
// copied onto each invoice when it is issued, so later wording changes never
// alter an invoice that was already given to a customer.
export const INVOICE_TERMS = {
  title: "Terms & Conditions",
  headline: "NO RETURN | NO REFUND | NO EXCHANGE",
  lines: [
    "Goods once sold will not be taken back or exchanged.",
    "Deposit amounts are non-refundable in case of order cancellation."
  ]
};

export const INVOICE_THANK_YOU = "Thank you for doing business with us.";

// Wording only: the stored balance (0 once cancelled) is shown with a note.
export function balanceDueText(invoice, format) {
  const amount = format(invoice.balanceDue ?? invoice.totals?.grandTotal);
  return invoice.status === "cancelled" ? `${amount} (Invoice cancelled)` : amount;
}

// Terms to print: the copy stored on the invoice, or the standard terms for
// invoices issued before terms were stored. Stored records are never rewritten.
export function invoiceTermsFor(invoice) {
  return invoice?.standardTerms || INVOICE_TERMS;
}

// Invoice dates as DD-MM-YYYY, shared by the PDF and the on-screen invoice.
// Plain YYYY-MM-DD dates are reordered as text so they can never shift a day;
// timestamps are read on the IST calendar day they happened.
export function invoiceDate(value) {
  if (!value) return "";
  const plain = typeof value === "string" && /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (plain) return `${plain[3]}-${plain[2]}-${plain[1]}`;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "2-digit", year: "numeric", timeZone: "Asia/Kolkata" })
    .formatToParts(d).map(p => [p.type, p.value]));
  return `${parts.day}-${parts.month}-${parts.year}`;
}

// Ship-to text only when it differs from billing. Website checkout stores the
// billing address as the shipping address when "same as billing" is ticked.
export function separateShippingAddress(customer = {}) {
  const normalize = value => String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
  const shipping = String(customer.shippingAddress || "").trim();
  if (!shipping || normalize(shipping) === normalize(customer.billingAddress)) return "";
  return shipping;
}

// Where an invoice came from. Invoices issued before this field existed have
// no `source`; they were all issued from an order.
export const INVOICE_SOURCES = {
  order: "Order",
  offline: "Offline / walk-in"
};

export const SKU_PATTERN =/^[A-Z0-9][A-Z0-9_-]{1,31}$/;

export const MAX_ORDER_LINES = 60;
export const MAX_LINE_QTY = 100000;

export function normalizeSku(value) {
  return String(value ?? "").trim().toUpperCase().replace(/\s+/g, "_");
}

// Indian mobile numbers are stored as 12 digits with the 91 prefix.
export function normalizePhone(value) {
  let digits = String(value ?? "").replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("0")) digits = digits.slice(1);
  if (digits.length === 10) digits = `91${digits}`;
  return digits;
}

export function isValidPhone(digits) {
  return /^91[6-9]\d{9}$/.test(digits) || /^\d{11,15}$/.test(digits) && !digits.startsWith("91");
}

export const GSTIN_PATTERN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
