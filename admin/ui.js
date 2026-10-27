/* =========================================================
   ADMIN UI HELPERS
========================================================= */

import { formatINR, paiseToRupeesString, rupeesToPaise } from "../shared/pricing.js";
import { AVAILABILITY, ORDER_STATUSES } from "../shared/constants.js";

export function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[ch]));
}

export const money = (paise, fallback = "—") => (paise === null || paise === undefined ? fallback : formatINR(paise));
export const toRupeesInput = paise => (paise === null || paise === undefined ? "" : paiseToRupeesString(paise).replace(/\.00$/, ""));
export const fromRupeesInput = value => rupeesToPaise(value);

export function date(value, withTime = false) {
  if (!value) return "—";
  return new Date(value).toLocaleString("en-IN", {
    day: "2-digit", month: "short", year: "numeric",
    ...(withTime ? { hour: "2-digit", minute: "2-digit" } : {}),
    timeZone: "Asia/Kolkata"
  });
}

export const phoneDisplay = phone => String(phone || "").replace(/^91(\d{5})(\d{5})$/, "+91 $1 $2");

const svg = d => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
export const icons = {
  dashboard: svg('<rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/>'),
  products: svg('<path d="M21 8 12 3 3 8v8l9 5 9-5V8Z"/><path d="m3 8 9 5 9-5M12 13v8"/>'),
  categories: svg('<path d="M4 6h16M4 12h10M4 18h6"/>'),
  inventory: svg('<path d="M3 21V8l9-5 9 5v13"/><path d="M7 21v-8h10v8M7 17h10"/>'),
  orders: svg('<path d="M6 7h12l1 13H5L6 7Z"/><path d="M9 7a3 3 0 0 1 6 0"/>'),
  invoices: svg('<path d="M7 3h10v18l-2.5-1.5L12 21l-2.5-1.5L7 21V3Z"/><path d="M10 8h4M10 12h4"/>'),
  customers: svg('<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0M16 4.5a3.5 3.5 0 0 1 0 7M21.5 20a6.5 6.5 0 0 0-4-6"/>'),
  settings: svg('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z"/>'),
  images: svg('<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="m4 18 5-5 4 4 3-3 4 4"/>'),
  upload: svg('<path d="M12 16V4M7 9l5-5 5 5M4 20h16"/>'),
  download: svg('<path d="M12 4v12M7 11l5 5 5-5M4 20h16"/>'),
  plus: svg('<path d="M12 5v14M5 12h14"/>'),
  menu: svg('<path d="M4 7h16M4 12h16M4 17h16"/>'),
  close: svg('<path d="M6 6l12 12M18 6 6 18"/>'),
  print: svg('<path d="M7 9V3h10v6M7 17H4v-7h16v7h-3"/><rect x="7" y="14" width="10" height="7"/>'),
  link: svg('<path d="M10 14a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1M14 10a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1"/>'),
  logout: svg('<path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3M10 17l-5-5 5-5M5 12h11"/>'),
  collapse: svg('<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16M15 10l-2 2 2 2"/>'),
  grid: svg('<rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="4" width="7" height="7" rx="1.5"/><rect x="4" y="13" width="7" height="7" rx="1.5"/><rect x="13" y="13" width="7" height="7" rx="1.5"/>'),
  list: svg('<path d="M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01"/>'),
  share: svg('<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="m8.6 13.5 6.8 4M15.4 6.5l-6.8 4"/>'),
  whatsapp: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2a10 10 0 0 0-8.6 15.1L2 22l5-1.3A10 10 0 1 0 12 2Zm4.5 12.1c-.2-.1-1.5-.7-1.7-.8-.2-.1-.4-.1-.6.1l-.8 1c-.1.2-.3.2-.5.1a6.7 6.7 0 0 1-3.3-2.9c-.2-.4.2-.4.7-1.3.1-.2 0-.3 0-.4l-.8-1.8c-.2-.5-.4-.4-.6-.4h-.5a1 1 0 0 0-.7.3 3 3 0 0 0-.9 2.2 5.2 5.2 0 0 0 1.1 2.7 11.8 11.8 0 0 0 4.5 4c1.7.7 2.4.8 3.2.6.5-.1 1.5-.6 1.7-1.2.2-.6.2-1.1.2-1.2-.1-.1-.3-.2-.5-.3Z"/></svg>'
};

/* ---------------- badges ---------------- */

const ORDER_COLORS = { pending: "amber", confirmed: "blue", processing: "blue", dispatched: "gold", completed: "green", cancelled: "red" };
export const orderBadge = status => `<span class="badge ${ORDER_COLORS[status] || ""}">${esc(ORDER_STATUSES[status] || status)}</span>`;

const AVAIL_COLORS = { in_stock: "green", low_stock: "amber", coming_soon: "blue", out_of_stock: "red" };
export const availabilityBadge = a => `<span class="badge ${AVAIL_COLORS[a] || ""}">${esc(AVAILABILITY[a] || a)}</span>`;

const PAY = { unpaid: ["red", "Unpaid"], partial: ["amber", "Partially paid"], paid: ["green", "Paid"] };
export const paymentBadge = s => `<span class="badge ${PAY[s]?.[0] || ""}">${esc(PAY[s]?.[1] || s)}</span>`;

const PRODUCT_STATUS = { active: ["green", "Active"], inactive: ["", "Hidden"], archived: ["red", "Archived"] };
export const productStatusBadge = s => `<span class="badge ${PRODUCT_STATUS[s]?.[0] || ""}">${esc(PRODUCT_STATUS[s]?.[1] || s)}</span>`;

/* ---------------- toast ---------------- */

export function toast(message, type = "") {
  const box = document.getElementById("toasts");
  const el = document.createElement("div");
  el.className = `toast ${type}`;
  el.textContent = message;
  box.append(el);
  setTimeout(() => el.remove(), type === "error" ? 6000 : 3500);
}

export function toastError(error) {
  toast(error?.message || "Something went wrong.", "error");
}

/* ---------------- modal ---------------- */

export function openModal({ title, body = "", foot = "", size = "" }) {
  const dialog = document.createElement("dialog");
  dialog.className = `modal ${size}`;
  dialog.innerHTML = `
    <div class="modal-inner">
      <div class="modal-head"><h2>${esc(title)}</h2><button type="button" class="btn btn-ghost btn-icon" data-close aria-label="Close">${icons.close}</button></div>
      <div class="modal-body">${body}</div>
      ${foot ? `<div class="modal-foot">${foot}</div>` : ""}
    </div>`;
  document.body.append(dialog);
  const close = () => { dialog.close(); dialog.remove(); };
  dialog.addEventListener("click", event => {
    if (event.target.closest("[data-close]")) close();
  });
  dialog.addEventListener("cancel", event => { event.preventDefault(); close(); });
  dialog.showModal();
  return { dialog, close, $: selector => dialog.querySelector(selector) };
}

// Promise-based confirm; never uses window.confirm. With `input`, resolves to the entered text.
export function confirmDialog({ title, message = "", confirmText = "Confirm", danger = false, input = null }) {
  return new Promise(resolve => {
    const modal = openModal({
      title,
      size: "narrow",
      body: `${message ? `<p style="margin:0 0 12px">${message}</p>` : ""}
        ${input ? `<div class="field"><label for="confirm-input">${esc(input.label)}</label>${input.multiline ? `<textarea class="textarea" id="confirm-input" maxlength="300"></textarea>` : `<input class="input" id="confirm-input" maxlength="300">`}<p class="error" id="confirm-error"></p></div>` : ""}`,
      foot: `<button type="button" class="btn btn-outline" data-close>Cancel</button><button type="button" class="btn ${danger ? "btn-danger" : "btn-primary"}" data-ok>${esc(confirmText)}</button>`
    });
    let done = false;
    const finish = value => { if (!done) { done = true; resolve(value); } };
    modal.dialog.addEventListener("close", () => finish(false));
    modal.$("[data-ok]").addEventListener("click", () => {
      if (input) {
        const value = modal.$("#confirm-input").value.trim();
        if (input.required && value.length < (input.min || 1)) {
          modal.$("#confirm-error").textContent = input.requiredMessage || "This field is required.";
          return;
        }
        finish(value);
      } else {
        finish(true);
      }
      modal.close();
    });
    modal.$("#confirm-input")?.focus();
  });
}

/* ---------------- forms ---------------- */

export function setBusy(button, busy) {
  if (!button) return;
  button.classList.toggle("is-loading", busy);
  button.disabled = busy;
}

export function clearFormErrors(root) {
  root.querySelectorAll(".field.has-error").forEach(f => f.classList.remove("has-error"));
  root.querySelectorAll(".field .error[data-for]").forEach(e => { e.textContent = ""; });
}

// Maps API field errors (details.fields) onto `.error[data-for=name]` elements.
export function showFormErrors(root, error) {
  clearFormErrors(root);
  const fields = error?.details?.fields || {};
  let first = null;
  for (const [key, message] of Object.entries(fields)) {
    const target = root.querySelector(`.error[data-for="${CSS.escape(key)}"]`);
    if (!target) continue;
    target.textContent = message;
    target.closest(".field")?.classList.add("has-error");
    first ||= target.closest(".field")?.querySelector("input, select, textarea");
  }
  first?.focus();
  return Object.keys(fields).length > 0;
}

export function field({ name, label, value = "", type = "text", hint = "", required = false, attrs = "", full = false, prefix = "" }) {
  const id = `f-${name.replace(/\W/g, "-")}`;
  const input = type === "textarea"
    ? `<textarea class="textarea" id="${id}" name="${esc(name)}" ${attrs}>${esc(value)}</textarea>`
    : `<input class="input" id="${id}" name="${esc(name)}" type="${type}" value="${esc(value)}" ${required ? "required" : ""} ${attrs}>`;
  return `
    <div class="field${full ? " full" : ""}">
      <label for="${id}">${esc(label)}${required ? "" : ' <span class="muted" style="font-weight:500">(optional)</span>'}</label>
      ${prefix ? `<div class="input-prefix"><span>${esc(prefix)}</span>${input}</div>` : input}
      ${hint ? `<span class="hint">${hint}</span>` : ""}
      <span class="error" data-for="${esc(name)}"></span>
    </div>`;
}

export function selectField({ name, label, options, value = "", hint = "", full = false, required = true }) {
  const id = `f-${name.replace(/\W/g, "-")}`;
  return `
    <div class="field${full ? " full" : ""}">
      <label for="${id}">${esc(label)}${required ? "" : ' <span class="muted" style="font-weight:500">(optional)</span>'}</label>
      <select class="select" id="${id}" name="${esc(name)}">
        ${options.map(([v, l]) => `<option value="${esc(v)}" ${String(v) === String(value ?? "") ? "selected" : ""}>${esc(l)}</option>`).join("")}
      </select>
      ${hint ? `<span class="hint">${hint}</span>` : ""}
      <span class="error" data-for="${esc(name)}"></span>
    </div>`;
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

export function errorState(error, retry) {
  const id = `retry-${Math.random().toString(36).slice(2)}`;
  setTimeout(() => document.getElementById(id)?.addEventListener("click", retry));
  return `<div class="card empty"><h3>Could not load this page</h3><p>${esc(error?.message || "Unknown error")}</p><button class="btn btn-primary" id="${id}" type="button">Try again</button></div>`;
}
