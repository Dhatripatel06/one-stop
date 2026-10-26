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
  deduct: "Dispatched (deducted)"
};

export const PAYMENT_METHODS = {
  cash: "Cash",
  upi: "UPI",
  bank_transfer: "Bank transfer",
  cheque: "Cheque",
  card: "Card",
  other: "Other"
};

export const SKU_PATTERN = /^[A-Z0-9][A-Z0-9_-]{1,31}$/;

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
