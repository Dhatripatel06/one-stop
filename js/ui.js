/* =========================================================
   SHARED UI (customer site): layout, product cards, helpers
========================================================= */

import { cart } from "./cart.js";
import { formatINR } from "../shared/pricing.js";
import { AVAILABILITY } from "../shared/constants.js";

export const FALLBACK_IMAGE = "/images/placeholder.svg";

export const DEFAULT_BUSINESS = {
  businessName: "ONE STOP SOLUTION (OSS)",
  tagline: "Every Problem, One Solution",
  phone: "9499806747",
  whatsapp: "919499806747",
  instagram: "onestopsolution4325",
  minOrderValue: 50000
};

/* ---------------- icons ---------------- */

const path = d => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
export const icon = {
  search: path('<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>'),
  bag: path('<path d="M6 7h12l1 13H5L6 7Z"/><path d="M9 7a3 3 0 0 1 6 0"/>'),
  menu: path('<path d="M4 7h16M4 12h16M4 17h16"/>'),
  close: path('<path d="M6 6l12 12M18 6 6 18"/>'),
  check: path('<path d="m5 12 5 5 9-10"/>'),
  arrow: path('<path d="M5 12h14M13 6l6 6-6 6"/>'),
  truck: path('<path d="M3 7h11v9H3zM14 10h4l3 3v3h-7"/><circle cx="7" cy="17.5" r="1.5"/><circle cx="17" cy="17.5" r="1.5"/>'),
  shield: path('<path d="M12 3 5 6v6c0 4.5 3 7.5 7 9 4-1.5 7-4.5 7-9V6l-7-3Z"/><path d="m9 12 2 2 4-4"/>'),
  grid: path('<rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="4" width="7" height="7" rx="1.5"/><rect x="4" y="13" width="7" height="7" rx="1.5"/><rect x="13" y="13" width="7" height="7" rx="1.5"/>'),
  headset: path('<path d="M4 14v-2a8 8 0 0 1 16 0v2"/><rect x="3" y="14" width="4" height="6" rx="1.5"/><rect x="17" y="14" width="4" height="6" rx="1.5"/>'),
  phone: path('<path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2Z"/>'),
  instagram: path('<rect x="3" y="3" width="18" height="18" rx="5"/><circle cx="12" cy="12" r="4"/><circle cx="17.5" cy="6.5" r="1" fill="currentColor"/>'),
  info: path('<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>'),
  plus: path('<path d="M12 5v14M5 12h14"/>'),
  copy: path('<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>'),
  whatsapp: `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2a10 10 0 0 0-8.6 15.1L2 22l5-1.3A10 10 0 1 0 12 2Zm0 18.2a8.2 8.2 0 0 1-4.2-1.2l-.3-.2-3 .8.8-2.9-.2-.3A8.2 8.2 0 1 1 12 20.2Zm4.5-6.1c-.2-.1-1.5-.7-1.7-.8-.2-.1-.4-.1-.6.1l-.8 1c-.1.2-.3.2-.5.1a6.7 6.7 0 0 1-3.3-2.9c-.2-.4.2-.4.7-1.3.1-.2 0-.3 0-.4l-.8-1.8c-.2-.5-.4-.4-.6-.4h-.5a1 1 0 0 0-.7.3 3 3 0 0 0-.9 2.2 5.2 5.2 0 0 0 1.1 2.7 11.8 11.8 0 0 0 4.5 4c1.7.7 2.4.8 3.2.6.5-.1 1.5-.6 1.7-1.2.2-.6.2-1.1.2-1.2-.1-.1-.3-.2-.5-.3Z"/></svg>`
};

/* ---------------- text helpers ---------------- */

export function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[ch]));
}

const KEEP_UPPER = new Set(["USB", "LED", "HD", "OSS", "MOQ", "UV", "AC", "DC", "TV", "PVC", "ABS", "GPS", "SIM", "CAD"]);
const SMALL = new Set(["and", "with", "in", "of", "for", "on", "to", "the", "a", "or"]);

// Catalogue names are stored in capitals. Show them in readable title case,
// keeping codes like "2L", "60W" or "USB" intact.
export function displayName(name) {
  const text = String(name ?? "");
  if (text !== text.toUpperCase()) return text;
  return text.split(/(\s+)/).map((word, index) => {
    if (/^\s+$/.test(word) || !word) return word;
    const bare = word.replace(/[^A-Za-z]/g, "");
    if (/\d/.test(word) || KEEP_UPPER.has(bare)) return word;
    const lower = word.toLowerCase();
    if (index > 0 && SMALL.has(lower)) return lower;
    return lower.replace(/(^|[-(/])([a-z])/g, (m, p, c) => p + c.toUpperCase());
  }).join("");
}

export function money(paise, opts) {
  return formatINR(paise, { decimals: "auto", ...opts });
}

export function productUrl(product) {
  return `product.html?sku=${encodeURIComponent(product.sku)}`;
}

// Cloudinary images are resized and served in the best format for the browser.
export function imageUrl(src, width) {
  if (!src) return FALLBACK_IMAGE;
  const match = String(src).match(/^(https:\/\/res\.cloudinary\.com\/[^/]+\/image\/upload\/)(.+)$/);
  if (!match || !width) return src;
  return `${match[1]}f_auto,q_auto,c_limit,w_${width}/${match[2]}`;
}

export function imageOf(product, width) {
  return imageUrl(product?.images?.[0] || product?.image, width);
}

export function waUrl(number, message) {
  return `https://wa.me/${encodeURIComponent(number)}?text=${encodeURIComponent(message)}`;
}

export function productEnquiryMessage(product, business = DEFAULT_BUSINESS) {
  return `Hi ${business.businessName},\n\nI'm interested in ${product.name} (${product.sku}).\n\nPlease share details and rates.`;
}

/* ---------------- price & availability ---------------- */

export function priceHtml(product) {
  if (product.effectivePrice === null || product.effectivePrice === undefined) {
    return `<span class="price-request">Price on request</span>`;
  }
  const was = product.salePrice !== null && product.salePrice !== undefined && product.price > product.effectivePrice
    ? `<span class="price-was">${money(product.price)}</span>` : "";
  const unit = product.unit && product.unit !== "pcs" ? ` <span class="card-note">/ ${escapeHtml(product.unit)}</span>` : "";
  return `<span class="price">${money(product.effectivePrice)}</span>${was}${unit}`;
}

export function badgeHtml(availability) {
  return `<span class="badge badge-${escapeHtml(availability)}">${escapeHtml(AVAILABILITY[availability] || "")}</span>`;
}

/* ---------------- product card ---------------- */

export function stepperHtml(sku, qty, min = 1, { large = false, label = "Quantity" } = {}) {
  return `
    <div class="stepper${large ? " stepper-lg" : ""}" data-stepper="${escapeHtml(sku)}">
      <button type="button" data-step="-1" aria-label="Decrease ${escapeHtml(label)}">−</button>
      <input type="number" inputmode="numeric" min="0" max="100000" step="1" value="${qty}" aria-label="${escapeHtml(label)}" data-min="${min}">
      <button type="button" data-step="1" aria-label="Increase ${escapeHtml(label)}">+</button>
    </div>`;
}

export function cardActionsHtml(product, business) {
  const qty = cart.qty(product.sku);
  const wa = `<a class="btn btn-outline btn-sm btn-icon btn-wa-outline" href="${waUrl(business.whatsapp, productEnquiryMessage(product, business))}" target="_blank" rel="noopener" aria-label="Ask about ${escapeHtml(displayName(product.name))} on WhatsApp">${icon.whatsapp}</a>`;
  if (!product.orderable) {
    return `<button type="button" class="btn btn-outline btn-sm" disabled>${product.availability === "coming_soon" ? "Coming soon" : "Unavailable"}</button>${wa}`;
  }
  if (qty > 0) return `${stepperHtml(product.sku, qty, product.minQty, { label: `quantity of ${displayName(product.name)}` })}${wa}`;
  return `<button type="button" class="btn btn-primary btn-sm" data-add="${escapeHtml(product.sku)}">${icon.plus}<span>Add to order</span></button>${wa}`;
}

export function productCardHtml(product, business = DEFAULT_BUSINESS) {
  const name = displayName(product.name);
  const moq = product.minQty > 1 ? `<span class="moq">MOQ ${product.minQty} ${escapeHtml(product.unit || "pcs")}</span>` : "";
  return `
    <article class="card" data-sku="${escapeHtml(product.sku)}">
      <a class="card-media" href="${productUrl(product)}" tabindex="-1" aria-hidden="true">
        <img src="${escapeHtml(imageOf(product, 600))}" alt="" loading="lazy" decoding="async" width="400" height="400" onerror="this.onerror=null;this.src='${FALLBACK_IMAGE}'">
        ${product.availability !== "in_stock" ? badgeHtml(product.availability) : ""}
      </a>
      <div class="card-body">
        <div class="card-meta"><span class="cat">${escapeHtml(product.categoryName)}</span><span class="sku">${escapeHtml(product.sku)}</span></div>
        <h3 class="card-title"><a href="${productUrl(product)}">${escapeHtml(name)}</a></h3>
        <div class="card-price">${priceHtml(product)}${moq}</div>
        <div class="card-actions" data-actions="${escapeHtml(product.sku)}">${cardActionsHtml(product, business)}</div>
      </div>
    </article>`;
}

export function skeletonCards(count = 8) {
  return Array.from({ length: count }, () => `<div class="skeleton-card" aria-hidden="true"><div class="s-img"></div><div class="s-line"></div><div class="s-line" style="width:60%"></div></div>`).join("");
}

/* ---------------- stepper & add behaviour ---------------- */

// Delegated handling for "Add" buttons and steppers anywhere in `root`.
export function bindCartControls(root, findProduct, onChange) {
  root.addEventListener("click", event => {
    const add = event.target.closest("[data-add]");
    if (add) {
      const product = findProduct(add.dataset.add);
      if (!product) return;
      cart.set(product.sku, Math.max(product.minQty || 1, 1));
      toast(`${displayName(product.name)} added to your order`, "success");
      onChange?.(product.sku);
      return;
    }
    const step = event.target.closest("[data-step]");
    if (step) {
      const wrap = step.closest("[data-stepper]");
      const product = findProduct(wrap.dataset.stepper);
      if (!product) return;
      const input = wrap.querySelector("input");
      const min = product.minQty || 1;
      let next = (Number(input.value) || 0) + Number(step.dataset.step);
      if (Number(step.dataset.step) < 0 && next < min) next = 0;
      if (Number(step.dataset.step) > 0 && next < min) next = min;
      cart.set(product.sku, next);
      onChange?.(product.sku);
    }
  });

  root.addEventListener("change", event => {
    const input = event.target.closest("[data-stepper] input");
    if (!input) return;
    const wrap = input.closest("[data-stepper]");
    const product = findProduct(wrap.dataset.stepper);
    if (!product) return;
    let value = Math.floor(Number(input.value) || 0);
    const min = product.minQty || 1;
    if (value > 0 && value < min) {
      toast(`Minimum order for this product is ${min} ${product.unit || "pcs"}.`, "error");
      value = min;
    }
    cart.set(product.sku, value);
    onChange?.(product.sku);
  });
}

/* ---------------- toast ---------------- */

export function toast(message, type = "") {
  let stack = document.querySelector(".toast-stack");
  if (!stack) {
    stack = document.createElement("div");
    stack.className = "toast-stack";
    stack.setAttribute("role", "status");
    stack.setAttribute("aria-live", "polite");
    document.body.append(stack);
  }
  const el = document.createElement("div");
  el.className = `toast ${type}`;
  el.textContent = message;
  stack.append(el);
  setTimeout(() => el.remove(), 3200);
}

/* ---------------- layout ---------------- */

export function renderLayout(active = "", business = DEFAULT_BUSINESS) {
  const header = document.getElementById("site-header");
  const footer = document.getElementById("site-footer");
  const phoneDisplay = String(business.phone).replace(/(\d{5})(\d{5})/, "$1 $2");
  // On the home page the hero shows the logo, name and tagline at full size,
  // so the header brand drops the tagline there to avoid repeating it.
  const isHome = active === "catalogue";

  if (header) {
    header.outerHTML = `
      <div class="topbar">
        <div class="container">
          <div class="topbar-links">
            <a href="${waUrl(business.whatsapp, `Hi ${business.businessName},\n\n`)}" target="_blank" rel="noopener">${icon.whatsapp}<span><span class="sr-only">WhatsApp </span>${escapeHtml(phoneDisplay)}</span></a>
            <a href="https://www.instagram.com/${escapeHtml(business.instagram)}/" target="_blank" rel="noopener">${icon.instagram}<span><span class="sr-only">Instagram </span>@${escapeHtml(business.instagram)}</span></a>
          </div>
        </div>
      </div>
      <header class="site-header" id="site-header">
        <div class="container header-inner">
          <a class="brand" href="index.html" aria-label="${escapeHtml(business.businessName)} home">
            <img src="538820.jpg" alt="" width="44" height="44">
            <span class="brand-name"><strong>One Stop Solution</strong>${isHome ? "" : `<span>${escapeHtml(business.tagline)}</span>`}</span>
          </a>
          <nav class="main-nav" id="main-nav" aria-label="Main">
            <a href="index.html#catalogue" ${active === "catalogue" ? 'aria-current="page"' : ""}>Catalogue</a>
            <a href="index.html#how-to-order">How to order</a>
            <a href="index.html#contact">Contact</a>
          </nav>
          <form class="header-search" role="search" action="index.html#catalogue">
            ${icon.search}
            <label class="sr-only" for="site-search">Search products</label>
            <input id="site-search" name="q" type="search" placeholder="Search name or code" autocomplete="off">
          </form>
          <div class="header-actions">
            <a class="cart-link" href="order.html" aria-label="Your order">
              ${icon.bag}<span class="cart-label">Your order</span><span class="cart-count" data-cart-count hidden>0</span>
            </a>
            <button class="btn btn-ghost btn-icon nav-toggle" type="button" aria-controls="main-nav" aria-expanded="false" aria-label="Menu">${icon.menu}</button>
          </div>
        </div>
      </header>`;

    const headerEl = document.getElementById("site-header");
    const toggle = headerEl.querySelector(".nav-toggle");
    const nav = headerEl.querySelector("#main-nav");
    const setMenu = open => {
      nav.classList.toggle("is-open", open);
      toggle.setAttribute("aria-expanded", String(open));
      toggle.setAttribute("aria-label", open ? "Close menu" : "Menu");
      toggle.innerHTML = open ? icon.close : icon.menu;
    };
    toggle.addEventListener("click", () => {
      const open = !nav.classList.contains("is-open");
      setMenu(open);
      if (open) nav.querySelector("a")?.focus();
    });
    nav.addEventListener("click", event => {
      if (event.target.closest("a")) setMenu(false);
    });
    document.addEventListener("keydown", event => {
      if (event.key === "Escape" && nav.classList.contains("is-open")) { setMenu(false); toggle.focus(); }
    });
    document.addEventListener("click", event => {
      // composedPath(): the toggle swaps its icon, so event.target may already be detached.
      if (nav.classList.contains("is-open") && !event.composedPath().includes(headerEl)) setMenu(false);
    });
    const onScroll = () => headerEl.classList.toggle("is-scrolled", window.scrollY > 8);
    window.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
  }

  if (footer) {
    footer.outerHTML = `
      <footer class="site-footer" id="site-footer">
        <div class="container">
          <div class="footer-top">
            <a class="footer-mark" href="index.html"><img src="538820.jpg" alt="" width="64" height="64"><span>One Stop Solution</span></a>
            <p class="footer-tag">${escapeHtml(business.tagline)}</p>
          </div>
          <div class="footer-grid">
            <div class="footer-col">
              <h2>About</h2>
              <p>Wholesale catalogue. Build your order online and confirm it with us on WhatsApp.</p>
            </div>
            <nav class="footer-col" aria-label="Footer">
              <h2>Browse</h2>
              <ul>
                <li><a href="index.html#catalogue">Catalogue</a></li>
                <li><a href="index.html#how-to-order">How to order</a></li>
                <li><a href="order.html">Your order</a></li>
              </ul>
            </nav>
            <div class="footer-col">
              <h2>Contact</h2>
              <ul>
                <li><a href="${waUrl(business.whatsapp, `Hi ${business.businessName},\n\n`)}" target="_blank" rel="noopener">WhatsApp ${escapeHtml(phoneDisplay)}</a></li>
                <li><a href="tel:+${escapeHtml(business.whatsapp)}">Call ${escapeHtml(phoneDisplay)}</a></li>
                <li><a href="https://www.instagram.com/${escapeHtml(business.instagram)}/" target="_blank" rel="noopener">Instagram @${escapeHtml(business.instagram)}</a></li>
              </ul>
            </div>
          </div>
          <div class="footer-base"><span>© ${new Date().getFullYear()} ${escapeHtml(business.businessName)}</span></div>
        </div>
      </footer>`;
  }

  updateCartCount();
  window.addEventListener("cart:change", updateCartCount);
}

export function updateCartCount() {
  document.querySelectorAll("[data-cart-count]").forEach(el => {
    const count = cart.count();
    const changed = el.textContent !== String(count);
    el.textContent = String(count);
    el.hidden = count === 0;
    if (changed && count) { el.classList.remove("bump"); void el.offsetWidth; el.classList.add("bump"); }
  });
}

export function observeReveal(root = document) {
  const items = root.querySelectorAll(".reveal:not(.is-visible)");
  if (!("IntersectionObserver" in window)) { items.forEach(el => el.classList.add("is-visible")); return; }
  const io = new IntersectionObserver(entries => {
    entries.forEach(entry => {
      if (entry.isIntersecting) { entry.target.classList.add("is-visible"); io.unobserve(entry.target); }
    });
  }, { rootMargin: "0px 0px -8% 0px" });
  items.forEach(el => io.observe(el));
}
