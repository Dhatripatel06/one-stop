/* =========================================================
   PRODUCT DETAIL PAGE
========================================================= */

import { api } from "./api.js";
import { cart } from "./cart.js";
import {
  DEFAULT_BUSINESS, FALLBACK_IMAGE, imageUrl, badgeHtml, bindCartControls, cardActionsHtml, displayName, escapeHtml,
  icon, money, priceHtml, productCardHtml, productEnquiryMessage, renderLayout, toast, waUrl
} from "./ui.js";

const $ = selector => document.querySelector(selector);
const sku = new URLSearchParams(location.search).get("sku") || "";

let product = null;
let related = [];
let business = DEFAULT_BUSINESS;

function availabilityText(p) {
  if (p.availability === "in_stock") return "Available to order";
  if (p.availability === "low_stock") return "Low stock — order soon";
  if (p.availability === "coming_soon") return "Coming soon — ask us on WhatsApp to reserve";
  return "Currently out of stock";
}

function render() {
  const name = displayName(product.name);
  document.title = `${name} (${product.sku}) — ONE STOP SOLUTION (OSS)`;
  $("#breadcrumb").innerHTML = `
    <a href="index.html">Home</a><span aria-hidden="true">/</span>
    <a href="index.html?category=${encodeURIComponent(product.categoryId)}#catalogue">${escapeHtml(product.categoryName)}</a><span aria-hidden="true">/</span>
    <span aria-current="page">${escapeHtml(product.sku)}</span>`;

  const images = product.images.length ? product.images : [FALLBACK_IMAGE];
  const inCart = cart.qty(product.sku);
  const min = product.minQty || 1;
  const specs = product.specs.filter(s => s.label || s.value);

  $("#product-root").setAttribute("aria-busy", "false");
  $("#product-root").innerHTML = `
    <div class="pdp">
      <div class="gallery${images.length > 1 ? " has-thumbs" : ""}">
        <div class="gallery-main" id="gallery-main">
          <img src="${escapeHtml(imageUrl(images[0], 1200))}" alt="${escapeHtml(name)}" width="800" height="800" onerror="this.onerror=null;this.src='${FALLBACK_IMAGE}'">
        </div>
        ${images.length > 1 ? `
          <div class="gallery-thumbs" role="group" aria-label="Product images">
            ${images.map((src, i) => `<button type="button" data-thumb="${i}" aria-current="${i === 0}" aria-label="Image ${i + 1} of ${images.length}"><img src="${escapeHtml(imageUrl(src, 200))}" alt="" loading="lazy"></button>`).join("")}
          </div>` : ""}
      </div>

      <div class="pdp-info">
        <div class="pdp-meta"><a href="index.html?category=${encodeURIComponent(product.categoryId)}#catalogue">${escapeHtml(product.categoryName)}</a>${product.subcategoryName ? `<span aria-hidden="true">/</span><span>${escapeHtml(product.subcategoryName)}</span>` : ""}</div>
        <h1>${escapeHtml(name)}</h1>
        <dl class="pdp-facts">
          <div><dt>Product code</dt><dd class="sku-pill">${escapeHtml(product.sku)}</dd></div>
          <div><dt>Minimum order</dt><dd>${min} ${escapeHtml(product.unit || "pcs")}</dd></div>
          <div><dt>Availability</dt><dd>${badgeHtml(product.availability)}</dd></div>
        </dl>
        <div class="card-price pdp-price">${priceHtml(product)}</div>
        <p class="pdp-status">${availabilityText(product)}</p>

        <div class="pdp-panel">
          ${product.orderable ? `
            <div>
              <label class="pdp-label" for="qty-input">Quantity${product.unit ? ` (${escapeHtml(product.unit)})` : ""}</label>
              <div class="pdp-buy">
                <div class="stepper stepper-lg" id="qty-stepper">
                  <button type="button" data-delta="-1" aria-label="Decrease quantity">−</button>
                  <input id="qty-input" type="number" inputmode="numeric" min="${min}" max="100000" step="1" value="${Math.max(inCart, min)}">
                  <button type="button" data-delta="1" aria-label="Increase quantity">+</button>
                </div>
                <button type="button" class="btn btn-primary btn-lg" id="add-btn">${icon.bag}<span>${inCart ? "Update order" : "Add to order"}</span></button>
              </div>
              <p class="field-error" id="qty-error" role="alert" hidden></p>
              <p class="field-hint">${min > 1 ? `Minimum order: ${min} ${escapeHtml(product.unit || "pcs")}. ` : ""}${business.minOrderValue ? `Minimum order value ${money(business.minOrderValue)}.` : ""}</p>
            </div>` : `
            <p class="notice ${product.availability === "coming_soon" ? "" : "warn"}">${availabilityText(product)}. You can still ask us about this product on WhatsApp.</p>`}
          <a class="btn btn-wa btn-lg btn-block" href="${waUrl(business.whatsapp, productEnquiryMessage(product, business))}" target="_blank" rel="noopener">${icon.whatsapp}Ask about this product on WhatsApp</a>
          ${inCart ? `<a class="link-arrow" href="order.html">${inCart} in your order — review order ${icon.arrow}</a>` : ""}
        </div>

        ${product.description ? `<div class="pdp-section"><h2>Description</h2><p class="pdp-desc">${escapeHtml(product.description)}</p></div>` : ""}

        ${specs.length ? `
          <div class="pdp-section">
            <h2>Specifications</h2>
            <table class="spec-table"><tbody>${specs.map(s => `<tr><th scope="row">${escapeHtml(s.label)}</th><td>${escapeHtml(s.value)}</td></tr>`).join("")}</tbody></table>
          </div>` : ""}

        <div class="pdp-section">
          <h2>How to order</h2>
          <ul class="info-list">
            <li>${icon.check}<span>Add this product to your order with the quantity you need.</span></li>
            <li>${icon.check}<span>Submit your order with your name and phone number to receive an order number.</span></li>
            <li>${icon.check}<span>${product.effectivePrice === null ? "We confirm the price, availability and delivery with you on WhatsApp." : "We confirm availability and delivery with you on WhatsApp, then share your invoice."}</span></li>
          </ul>
        </div>
      </div>
    </div>`;

  bindDetail(images);
}

function bindDetail(images) {
  const main = $("#gallery-main");
  main.addEventListener("click", () => main.classList.toggle("is-zoomed"));
  document.querySelectorAll("[data-thumb]").forEach(button => {
    button.addEventListener("click", () => {
      main.querySelector("img").src = imageUrl(images[Number(button.dataset.thumb)], 1200);
      main.classList.remove("is-zoomed");
      document.querySelectorAll("[data-thumb]").forEach(b => b.setAttribute("aria-current", String(b === button)));
    });
  });

  const input = $("#qty-input");
  if (!input) return;
  const min = product.minQty || 1;
  const error = $("#qty-error");

  const validate = () => {
    const value = Number(input.value);
    let message = "";
    if (!Number.isInteger(value) || value < 1) message = "Enter a whole number.";
    else if (value < min) message = `Minimum order for this product is ${min} ${product.unit || "pcs"}.`;
    else if (value > 100000) message = "For quantities this large, please contact us on WhatsApp.";
    error.textContent = message;
    error.hidden = !message;
    $("#add-btn").disabled = Boolean(message);
    return !message;
  };

  document.querySelectorAll("[data-delta]").forEach(button => {
    button.addEventListener("click", () => {
      input.value = Math.max(min, (Number(input.value) || min) + Number(button.dataset.delta));
      validate();
    });
  });
  input.addEventListener("input", validate);

  $("#add-btn").addEventListener("click", () => {
    if (!validate()) return;
    const had = cart.qty(product.sku);
    cart.set(product.sku, Number(input.value));
    toast(had ? "Quantity updated in your order" : `${displayName(product.name)} added to your order`, "success");
    render();
  });
}

function renderRelated() {
  $("#related").hidden = related.length === 0;
  $("#related-grid").innerHTML = related.slice(0, 4).map(p => productCardHtml(p, business)).join("");
}

async function init() {
  renderLayout();
  if (!sku) {
    location.replace("index.html#catalogue");
    return;
  }
  try {
    const data = await api(`/products/${encodeURIComponent(sku)}`);
    product = data.product;
    related = data.related;
    business = { ...DEFAULT_BUSINESS, ...data.settings };
    render();
    renderRelated();
    bindCartControls($("#related-grid"), s => related.find(p => p.sku === s), s => {
      const p = related.find(r => r.sku === s);
      document.querySelectorAll(`[data-actions="${CSS.escape(s)}"]`).forEach(el => { el.innerHTML = cardActionsHtml(p, business); });
    });
  } catch (error) {
    $("#product-root").setAttribute("aria-busy", "false");
    $("#product-root").innerHTML = `
      <div class="empty-state">
        <h3>${error.status === 404 ? "This product is not available" : "The product could not be loaded"}</h3>
        <p>${escapeHtml(error.message)}</p>
        <a class="btn btn-primary" href="index.html#catalogue">Browse the catalogue</a>
      </div>`;
  }
}

init();
