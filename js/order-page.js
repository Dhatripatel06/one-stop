/* =========================================================
   ORDER PAGE
   The browser sends only SKUs, quantities and customer details.
   The server re-validates everything and calculates all prices.
========================================================= */

import { api, getCatalog } from "./api.js";
import { cart } from "./cart.js";
import {
  DEFAULT_BUSINESS, FALLBACK_IMAGE, bindCartControls, displayName, escapeHtml, icon,
  imageOf, money, productUrl, renderLayout, stepperHtml, toast, waUrl
} from "./ui.js";
import { INDIAN_STATES } from "../shared/pricing.js";

const $ = selector => document.querySelector(selector);
const root = () => $("#order-root");
const LAST_ORDER = "oss.lastOrder";
const DRAFT = "oss.orderForm";

let products = new Map();
let business = DEFAULT_BUSINESS;
let lineProblems = {};

/* ---------------- helpers ---------------- */

function lines() {
  return cart.items().map(item => ({ ...item, product: products.get(item.sku) || null }));
}

function estimate(list) {
  const priced = list.filter(line => line.product && line.product.effectivePrice !== null);
  const unpriced = list.length - priced.length;
  const subtotal = priced.reduce((sum, line) => sum + line.product.effectivePrice * line.qty, 0);
  return { subtotal, unpriced, allPriced: unpriced === 0 && list.length > 0 };
}

function enquiryMessage(list) {
  return `Hi ${business.businessName},\n\nI'm interested in the following products:\n\n${list.map((line, i) => `${i + 1}. ${line.product?.name || line.sku} (${line.sku}) × ${line.qty}`).join("\n")}\n\nPlease share details and rates.`;
}

function loadDraft() {
  try { return JSON.parse(localStorage.getItem(DRAFT) || "{}"); } catch { return {}; }
}

function saveDraft(form) {
  const data = Object.fromEntries(new FormData(form));
  delete data.website;
  data.sameAsBilling = form.elements.sameAsBilling.checked ? "on" : "off";
  try { localStorage.setItem(DRAFT, JSON.stringify(data)); } catch { /* ignore */ }
}

/* ---------------- render: cart ---------------- */

function lineHtml(line) {
  const p = line.product;
  if (!p) {
    return `
      <div class="line-item" data-line="${escapeHtml(line.sku)}">
        <img src="${FALLBACK_IMAGE}" alt="">
        <div><h3>${escapeHtml(line.sku)}</h3><p class="meta">This product is no longer available.</p></div>
        <div class="line-controls"><button class="remove-btn" type="button" data-remove="${escapeHtml(line.sku)}">Remove</button></div>
      </div>`;
  }
  const problem = lineProblems[line.sku] || (!p.orderable ? `${p.availability === "coming_soon" ? "Coming soon" : "Out of stock"} — please remove it.` : line.qty < p.minQty ? `Minimum order is ${p.minQty} ${p.unit}.` : "");
  const total = p.effectivePrice !== null ? money(p.effectivePrice * line.qty) : "Price on request";
  return `
    <div class="line-item" data-line="${escapeHtml(line.sku)}">
      <a href="${productUrl(p)}"><img src="${escapeHtml(imageOf(p))}" alt="" loading="lazy" onerror="this.onerror=null;this.src='${FALLBACK_IMAGE}'"></a>
      <div>
        <h3><a href="${productUrl(p)}">${escapeHtml(displayName(p.name))}</a></h3>
        <p class="meta">${escapeHtml(p.sku)} · ${p.effectivePrice !== null ? `${money(p.effectivePrice)} each` : "Price on request"}${p.minQty > 1 ? ` · Min. ${p.minQty}` : ""}</p>
      </div>
      <div class="line-controls">
        ${stepperHtml(p.sku, line.qty, p.minQty, { label: `quantity of ${displayName(p.name)}` })}
        <span class="line-total">${total}</span>
        <button class="remove-btn" type="button" data-remove="${escapeHtml(p.sku)}">Remove</button>
      </div>
      ${problem ? `<p class="line-problem" role="alert">${escapeHtml(problem)}</p>` : ""}
    </div>`;
}

function summaryHtml(list) {
  const est = estimate(list);
  const min = business.minOrderValue || 0;
  const belowMin = est.allPriced && min && est.subtotal < min;
  return `
    <h2>Order summary</h2>
    <dl class="totals">
      <div><dt>Products</dt><dd>${list.length}</dd></div>
      <div><dt>Total units</dt><dd>${list.reduce((s, l) => s + l.qty, 0)}</dd></div>
      ${est.subtotal ? `<div><dt>Estimated value${est.unpriced ? " (priced items)" : ""}</dt><dd>${money(est.subtotal)}</dd></div>` : ""}
      ${est.unpriced ? `<div><dt>Price on request</dt><dd>${est.unpriced} item${est.unpriced === 1 ? "" : "s"}</dd></div>` : ""}
      ${est.allPriced ? `<div class="grand"><dt>Estimated total</dt><dd>${money(est.subtotal)}</dd></div>` : ""}
    </dl>
    <p class="notice" style="margin-top:1rem">${est.allPriced
      ? `Final prices${business.taxMode === "gst" && !business.pricesIncludeTax ? ", GST" : ""} and delivery are confirmed with your invoice.`
      : "We will confirm prices and availability with you on WhatsApp after you submit."}
      ${min ? ` Minimum order value: ${money(min)}.` : ""}</p>
    ${belowMin ? `<p class="notice warn" style="margin-top:.75rem">Add ${money(min - est.subtotal)} more to reach the minimum order value.</p>` : ""}
    <a class="btn btn-ghost btn-block" style="margin-top:1rem" href="${waUrl(business.whatsapp, enquiryMessage(list))}" target="_blank" rel="noopener">${icon.whatsapp}Just send an enquiry on WhatsApp</a>`;
}

function formHtml() {
  const d = loadDraft();
  const v = key => escapeHtml(d[key] || "");
  return `
    <form class="panel" id="order-form" novalidate>
      <h2>Your details</h2>
      <div class="notice error" id="form-error" role="alert" hidden></div>
      <div class="form-grid">
        <div class="field"><label for="f-name">Your name</label><input class="input" id="f-name" name="name" autocomplete="name" required maxlength="100" value="${v("name")}"><p class="field-error" data-error="name"></p></div>
        <div class="field"><label for="f-phone">Mobile / WhatsApp number</label><input class="input" id="f-phone" name="phone" type="tel" inputmode="tel" autocomplete="tel" required maxlength="16" placeholder="10-digit mobile number" value="${v("phone")}"><p class="field-error" data-error="phone"></p></div>
        <div class="field"><label for="f-business">Business name <span class="opt">(optional)</span></label><input class="input" id="f-business" name="business" autocomplete="organization" maxlength="120" value="${v("business")}"><p class="field-error" data-error="business"></p></div>
        <div class="field"><label for="f-email">Email <span class="opt">(optional)</span></label><input class="input" id="f-email" name="email" type="email" autocomplete="email" maxlength="120" value="${v("email")}"><p class="field-error" data-error="email"></p></div>
        <div class="field"><label for="f-gstin">GSTIN <span class="opt">(optional)</span></label><input class="input" id="f-gstin" name="gstin" maxlength="15" style="text-transform:uppercase" value="${v("gstin")}"><p class="field-error" data-error="gstin"></p></div>
        <div class="field"><label for="f-state">State <span class="opt">(optional)</span></label>
          <select id="f-state" name="stateCode"><option value="">Select state</option>${INDIAN_STATES.map(([code, name]) => `<option value="${code}" ${d.stateCode === code ? "selected" : ""}>${escapeHtml(name)}</option>`).join("")}</select>
          <p class="field-error" data-error="stateCode"></p></div>
        <div class="field full"><label for="f-billing">Billing address <span class="opt">(optional)</span></label><textarea class="textarea" id="f-billing" name="billingAddress" autocomplete="street-address" maxlength="500">${v("billingAddress")}</textarea><p class="field-error" data-error="billingAddress"></p></div>
        <label class="checkbox full"><input type="checkbox" id="f-same" name="sameAsBilling" ${d.sameAsBilling === "off" ? "" : "checked"}> Deliver to the billing address</label>
        <div class="field full" id="shipping-field" ${d.sameAsBilling === "off" ? "" : "hidden"}><label for="f-shipping">Delivery address</label><textarea class="textarea" id="f-shipping" name="shippingAddress" maxlength="500">${v("shippingAddress")}</textarea><p class="field-error" data-error="shippingAddress"></p></div>
        <div class="field full"><label for="f-notes">Order notes <span class="opt">(optional)</span></label><textarea class="textarea" id="f-notes" name="notes" maxlength="1000" placeholder="Colours, delivery timing or anything else we should know">${v("notes")}</textarea></div>
        <div class="sr-only" aria-hidden="true"><label for="f-website">Website</label><input id="f-website" name="website" tabindex="-1" autocomplete="off"></div>
      </div>
      <button class="btn btn-primary btn-lg btn-block" type="submit" id="submit-btn" style="margin-top:1.25rem">Submit order</button>
      <p class="field-hint" style="margin-top:.75rem;text-align:center">Submitting saves your order and gives you an order number. Nothing is charged online.</p>
    </form>`;
}

function renderCart() {
  const list = lines();
  if (!list.length) {
    root().innerHTML = `
      <div class="page-title"><h1>Your order</h1></div>
      <div class="empty-state panel">
        <h3>Your order list is empty</h3>
        <p>Browse the catalogue and add the products you need.</p>
        <a class="btn btn-primary" href="index.html#catalogue">Browse catalogue</a>
      </div>`;
    return;
  }

  const existingForm = $("#order-form");
  if (existingForm) {
    // Re-render only the cart parts so the form keeps focus and input.
    $("#cart-lines").innerHTML = list.map(lineHtml).join("");
    $("#cart-summary").innerHTML = summaryHtml(list);
    $("#cart-count").textContent = `${list.length} product${list.length === 1 ? "" : "s"}`;
    return;
  }

  root().innerHTML = `
    <div class="page-title"><h1>Your order</h1><p>Review quantities, add your details and submit. We confirm everything with you on WhatsApp.</p></div>
    <div class="checkout">
      <div>
        <section class="panel" aria-labelledby="items-title">
          <h2 id="items-title">Products <span class="field-hint" id="cart-count">${list.length} product${list.length === 1 ? "" : "s"}</span></h2>
          <div id="cart-lines">${list.map(lineHtml).join("")}</div>
          <a class="link-arrow" href="index.html#catalogue" style="margin-top:1rem">+ Add more products</a>
        </section>
        ${formHtml()}
      </div>
      <aside class="panel panel-sticky" id="cart-summary" aria-label="Order summary">${summaryHtml(list)}</aside>
    </div>`;
  bindForm();
}

/* ---------------- submit ---------------- */

function clearErrors(form) {
  form.querySelectorAll(".field").forEach(f => f.classList.remove("has-error"));
  form.querySelectorAll("[data-error]").forEach(e => { e.textContent = ""; });
  $("#form-error").hidden = true;
}

function showFieldErrors(form, fields) {
  let first = null;
  for (const [key, message] of Object.entries(fields)) {
    const name = key.replace(/^customer\./, "");
    const target = form.querySelector(`[data-error="${CSS.escape(name)}"]`);
    if (target) {
      target.textContent = message;
      target.closest(".field")?.classList.add("has-error");
      first ||= form.querySelector(`[name="${CSS.escape(name)}"]`);
    }
  }
  first?.focus();
}

function bindForm() {
  const form = $("#order-form");
  const same = $("#f-same");
  same.addEventListener("change", () => { $("#shipping-field").hidden = same.checked; saveDraft(form); });
  form.addEventListener("input", () => saveDraft(form));

  form.addEventListener("submit", async event => {
    event.preventDefault();
    clearErrors(form);
    const data = Object.fromEntries(new FormData(form));
    const errors = {};
    if (!data.name || data.name.trim().length < 2) errors.name = "Please enter your name.";
    const digits = String(data.phone || "").replace(/\D/g, "");
    if (!/^(?:91|0)?[6-9]\d{9}$/.test(digits)) errors.phone = "Enter a valid 10-digit mobile number.";
    if (Object.keys(errors).length) return showFieldErrors(form, errors);

    const list = lines();
    const unavailable = list.filter(l => !l.product || !l.product.orderable);
    if (unavailable.length) {
      $("#form-error").textContent = "Remove unavailable products before submitting.";
      $("#form-error").hidden = false;
      return;
    }

    const button = $("#submit-btn");
    button.classList.add("is-loading");
    button.disabled = true;
    lineProblems = {};
    try {
      const order = await api("/orders", {
        method: "POST",
        body: {
          customer: {
            name: data.name, phone: data.phone, business: data.business, email: data.email,
            gstin: data.gstin, stateCode: data.stateCode, billingAddress: data.billingAddress,
            shippingAddress: same.checked ? data.billingAddress : data.shippingAddress
          },
          items: list.map(l => ({ sku: l.sku, qty: l.qty })),
          notes: data.notes,
          website: data.website
        }
      });
      cart.clear();
      try { sessionStorage.setItem(LAST_ORDER, JSON.stringify(order)); } catch { /* ignore */ }
      history.replaceState(null, "", `order.html?placed=${encodeURIComponent(order.orderNo)}`);
      renderSuccess(order);
      window.scrollTo({ top: 0 });
    } catch (error) {
      if (error.details?.fields) showFieldErrors(form, error.details.fields);
      for (const problem of error.details?.problems || []) {
        const sku = problem.split(" ")[0];
        lineProblems[sku] = problem;
      }
      for (const shortage of error.details?.shortages || []) {
        lineProblems[shortage.sku] = `Only ${shortage.available} available right now.`;
      }
      if (Object.keys(lineProblems).length) renderCart();
      $("#form-error").textContent = error.message;
      $("#form-error").hidden = false;
      $("#form-error").scrollIntoView({ block: "center" });
    } finally {
      button.classList.remove("is-loading");
      button.disabled = false;
    }
  });
}

/* ---------------- success ---------------- */

function renderSuccess(order) {
  const message = `Hi ${business.businessName},\n\nI have placed order ${order.orderNo} on your website.\n\n${order.items.map((item, i) => `${i + 1}. ${item.name} (${item.sku}) × ${item.qty}`).join("\n")}\n\nName: ${order.customer.name}\n\nPlease confirm prices and availability.`;
  const total = order.totals?.grandTotal;
  root().innerHTML = `
    <div class="success-hero">
      <div class="tick">${icon.check}</div>
      <h1>Thank you — your order is saved</h1>
      <p class="hero-lead" style="margin:0 auto">Your order number is</p>
      <div class="order-no">${escapeHtml(order.orderNo)}</div>
      <p style="color:var(--muted);max-width:36rem;margin:0 auto 1.5rem">Status: <strong>Pending confirmation</strong>. We will confirm prices, availability and delivery with you. To speed things up, send your order to us on WhatsApp.</p>
      <div style="display:flex;gap:.75rem;justify-content:center;flex-wrap:wrap">
        <a class="btn btn-wa btn-lg" href="${waUrl(business.whatsapp, message)}" target="_blank" rel="noopener">${icon.whatsapp}Send order on WhatsApp</a>
        <a class="btn btn-outline btn-lg" href="index.html#catalogue">Continue browsing</a>
      </div>
    </div>
    <section class="panel" style="max-width:720px;margin:0 auto" aria-label="Order details">
      <h2>Order ${escapeHtml(order.orderNo)}</h2>
      ${order.items.map(item => `
        <div class="line-item" style="grid-template-columns:minmax(0,1fr) auto">
          <div><h3>${escapeHtml(displayName(item.name))}</h3><p class="meta">${escapeHtml(item.sku)} · Qty ${item.qty}${item.unitPrice !== null ? ` · ${money(item.unitPrice)} each` : " · Price to be confirmed"}</p></div>
          <span class="line-total">${item.total !== null ? money(item.total) : "—"}</span>
        </div>`).join("")}
      ${total !== null && total !== undefined ? `<dl class="totals" style="margin-top:1rem"><div class="grand"><dt>Order total</dt><dd>${money(total)}</dd></div></dl>` : `<p class="notice" style="margin-top:1rem">Prices will be confirmed with you before your invoice is issued.</p>`}
    </section>`;
}

/* ---------------- start ---------------- */

async function init() {
  renderLayout();
  const placed = new URLSearchParams(location.search).get("placed");
  if (placed) {
    try {
      const last = JSON.parse(sessionStorage.getItem(LAST_ORDER) || "null");
      if (last?.orderNo === placed) {
        root().setAttribute("aria-busy", "false");
        getCatalog().then(d => { business = { ...DEFAULT_BUSINESS, ...d.settings }; renderSuccess(last); }).catch(() => renderSuccess(last));
        return;
      }
    } catch { /* fall through */ }
  }

  try {
    const data = await getCatalog();
    products = new Map(data.products.map(p => [p.sku, p]));
    business = { ...DEFAULT_BUSINESS, ...data.settings };
    root().setAttribute("aria-busy", "false");
    renderCart();

    root().addEventListener("click", event => {
      const remove = event.target.closest("[data-remove]");
      if (remove) {
        cart.remove(remove.dataset.remove);
        delete lineProblems[remove.dataset.remove];
        toast("Removed from your order");
      }
    });
    bindCartControls(root(), sku => products.get(sku), sku => { delete lineProblems[sku]; });
    window.addEventListener("cart:change", renderCart);
  } catch (error) {
    root().setAttribute("aria-busy", "false");
    root().innerHTML = `<div class="empty-state panel" style="margin-top:2rem"><h3>Your order could not be loaded</h3><p>${escapeHtml(error.message)}</p><button class="btn btn-primary" type="button" onclick="location.reload()">Try again</button></div>`;
  }
}

init();
