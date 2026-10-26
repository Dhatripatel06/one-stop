/* =========================================================
   OSS DIGITAL CATALOGUE — HOME & CATALOGUE
   Products come from the persistent backend (/api/catalog).
========================================================= */

import { getCatalog } from "./js/api.js";
import { cart } from "./js/cart.js";
import {
  DEFAULT_BUSINESS, bindCartControls, cardActionsHtml, displayName, escapeHtml, icon,
  imageOf, money, observeReveal, productCardHtml, renderLayout, skeletonCards, waUrl
} from "./js/ui.js";

const $ = selector => document.querySelector(selector);

const state = {
  products: [],
  categories: [],
  business: DEFAULT_BUSINESS,
  q: "",
  category: "all",
  availability: "all",
  sort: "recommended"
};

/* ---------------- URL state ---------------- */

function readUrl() {
  const params = new URLSearchParams(location.search);
  state.q = params.get("q") || "";
  state.category = params.get("category") || "all";
  state.availability = params.get("availability") || "all";
  state.sort = params.get("sort") || "recommended";
}

function writeUrl() {
  const params = new URLSearchParams();
  if (state.q) params.set("q", state.q);
  if (state.category !== "all") params.set("category", state.category);
  if (state.availability !== "all") params.set("availability", state.availability);
  if (state.sort !== "recommended") params.set("sort", state.sort);
  const query = params.toString();
  history.replaceState(null, "", `${location.pathname}${query ? `?${query}` : ""}${location.hash}`);
}

/* ---------------- filtering ---------------- */

const compact = value => String(value).toLowerCase().replace(/[^a-z0-9]/g, "");

function matches(product, query) {
  if (!query) return true;
  const text = `${product.name} ${product.categoryName} ${product.subcategoryName}`.toLowerCase();
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.every(word => text.includes(word))) return true;
  // Product codes: "OSS_014", "oss 14", "oss014" and "014" all find OSS_014.
  const code = compact(product.sku);
  const q = compact(query);
  if (!q) return false;
  if (code.includes(q)) return true;
  const digits = query.replace(/\D/g, "");
  return digits.length > 0 && digits === query.replace(/^\s*oss[\s_-]*/i, "").trim() && Number(code.replace(/\D/g, "")) === Number(digits);
}

function visibleProducts() {
  let list = state.products.filter(product => {
    if (state.category !== "all" && product.categoryId !== state.category) return false;
    if (state.availability === "available" && !product.orderable) return false;
    if (state.availability === "coming_soon" && product.availability !== "coming_soon") return false;
    if (state.availability === "out_of_stock" && product.availability !== "out_of_stock") return false;
    return matches(product, state.q.trim());
  });

  const priceKey = p => p.effectivePrice ?? null;
  const byPrice = dir => (a, b) => {
    const pa = priceKey(a), pb = priceKey(b);
    if (pa === null && pb === null) return 0;
    if (pa === null) return 1; // "price on request" last
    if (pb === null) return -1;
    return dir * (pa - pb);
  };

  const sorters = {
    recommended: (a, b) => Number(b.orderable) - Number(a.orderable) || a.sortOrder - b.sortOrder || a.sku.localeCompare(b.sku, "en", { numeric: true }),
    name: (a, b) => displayName(a.name).localeCompare(displayName(b.name)),
    "price-asc": byPrice(1),
    "price-desc": byPrice(-1),
    code: (a, b) => a.sku.localeCompare(b.sku, "en", { numeric: true })
  };
  list = [...list].sort(sorters[state.sort] || sorters.recommended);
  return list;
}

/* ---------------- rendering ---------------- */

function renderChips() {
  const chips = [{ id: "all", name: "All products", productCount: state.products.length }, ...state.categories];
  $("#category-chips").innerHTML = chips.map(c => `
    <button type="button" class="chip" data-category="${escapeHtml(c.id)}" aria-pressed="${state.category === c.id}">
      ${escapeHtml(c.name)}<span class="count">${c.productCount}</span>
    </button>`).join("");
}

function renderGrid() {
  const grid = $("#product-grid");
  const list = visibleProducts();
  grid.setAttribute("aria-busy", "false");

  const total = state.products.length;
  $("#result-count").innerHTML = list.length === total
    ? `<strong>${total}</strong> products`
    : `Showing <strong>${list.length}</strong> of ${total} products`;

  if (!list.length) {
    grid.innerHTML = `
      <div class="empty-state">
        <h3>No products match your search</h3>
        <p>${state.q ? `Nothing found for “${escapeHtml(state.q)}”. ` : ""}Try a different name or product code, or ask us on WhatsApp.</p>
        <div style="display:flex;gap:.5rem;justify-content:center;flex-wrap:wrap">
          <button class="btn btn-outline" type="button" data-reset>Clear filters</button>
          <a class="btn btn-wa" href="${waUrl(state.business.whatsapp, `Hi ${state.business.businessName},\n\nI'm looking for: ${state.q}`)}" target="_blank" rel="noopener">${icon.whatsapp}Ask on WhatsApp</a>
        </div>
      </div>`;
    return;
  }
  grid.innerHTML = list.map(p => productCardHtml(p, state.business)).join("");
}

function renderHero() {
  const withImages = state.products.filter(p => p.images.length);
  const featured = withImages.filter(p => p.featured);
  // One product from each of the largest categories gives a varied first impression.
  const picks = [...featured];
  for (const category of [...state.categories].sort((a, b) => b.productCount - a.productCount)) {
    if (picks.length >= 4) break;
    const product = withImages.find(p => p.categoryId === category.id && !picks.includes(p));
    if (product) picks.push(product);
  }
  $("#hero-mosaic").innerHTML = picks.slice(0, 4).map(p => `
    <a class="hero-tile" href="product.html?sku=${encodeURIComponent(p.sku)}" tabindex="-1">
      <img src="${escapeHtml(imageOf(p))}" alt="" width="400" height="400" fetchpriority="high">
      <figcaption>${escapeHtml(displayName(p.name))}</figcaption>
    </a>`).join("");

  $("#hero-lead").textContent = `Browse ${state.products.length} products across ${state.categories.length} categories — build your order and confirm it with us on WhatsApp.`;
  $("#hero-wa").href = waUrl(state.business.whatsapp, `Hi ${state.business.businessName},\n\n`);
}

function renderCategories() {
  $("#categories-sub").textContent = `${state.categories.length} categories · ${state.products.length} products`;
  $("#category-rail").innerHTML = state.categories.map(c => {
    const product = state.products.find(p => p.categoryId === c.id && p.images.length);
    return `
      <button type="button" class="category-tile reveal" data-category-tile="${escapeHtml(c.id)}">
        <span class="thumb">${product ? `<img src="${escapeHtml(imageOf(product))}" alt="" loading="lazy" width="200" height="150">` : ""}</span>
        <span class="label"><strong>${escapeHtml(c.name)}</strong><span>${c.productCount} product${c.productCount === 1 ? "" : "s"}</span></span>
      </button>`;
  }).join("");
}

function renderSpotlights() {
  const featured = state.products.filter(p => p.featured).slice(0, 8);
  $("#featured").hidden = featured.length === 0;
  $("#featured-grid").innerHTML = featured.map(p => productCardHtml(p, state.business)).join("");

  // Only products with a real creation date; imported legacy items have none.
  const recent = state.products.filter(p => p.createdAt).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 4);
  $("#new-arrivals").hidden = recent.length < 3;
  $("#new-grid").innerHTML = recent.length >= 3 ? recent.map(p => productCardHtml(p, state.business)).join("") : "";
}

function renderBusiness() {
  const b = state.business;
  if (b.minOrderValue) {
    $("#moq-note").textContent = `Minimum order value ${money(b.minOrderValue)}. Add products to your order and send it to us — we confirm prices and availability on WhatsApp.`;
  }
  const phone = String(b.phone).replace(/(\d{5})(\d{5})/, "$1 $2");
  const items = [
    `<li><a href="${waUrl(b.whatsapp, `Hi ${b.businessName},\n\n`)}" target="_blank" rel="noopener"><span class="icon">${icon.whatsapp}</span><span><small>WhatsApp orders & enquiries</small>${escapeHtml(phone)}</span></a></li>`,
    `<li><a href="tel:+${escapeHtml(b.whatsapp)}"><span class="icon">${icon.phone}</span><span><small>Call us</small>${escapeHtml(phone)}</span></a></li>`,
    `<li><a href="https://www.instagram.com/${escapeHtml(b.instagram)}/" target="_blank" rel="noopener"><span class="icon">${icon.instagram}</span><span><small>Instagram</small>@${escapeHtml(b.instagram)}</span></a></li>`
  ];
  if (b.email) items.push(`<li><a href="mailto:${escapeHtml(b.email)}"><span class="icon">${icon.info}</span><span><small>Email</small>${escapeHtml(b.email)}</span></a></li>`);
  if (b.address) items.push(`<li><div><span class="icon">${icon.truck}</span><span><small>Address</small>${escapeHtml(b.address)}</span></div></li>`);
  $("#contact-list").innerHTML = items.join("");
}

function renderOrderBar() {
  const count = cart.count();
  const bar = $("#order-bar");
  bar.classList.toggle("is-visible", count > 0);
  $("#order-bar-summary").innerHTML = `<strong>${count}</strong> product${count === 1 ? "" : "s"} · ${cart.totalUnits()} units in your order`;
}

function refreshActions(sku) {
  const product = state.products.find(p => p.sku === sku);
  if (!product) return;
  document.querySelectorAll(`[data-actions="${CSS.escape(sku)}"]`).forEach(el => {
    el.innerHTML = cardActionsHtml(product, state.business);
  });
}

function renderAll() {
  renderHero();
  renderCategories();
  renderSpotlights();
  renderChips();
  renderGrid();
  renderBusiness();
  renderOrderBar();
  observeReveal();
}

/* ---------------- events ---------------- */

function bindEvents() {
  const search = $("#site-search");
  search.value = state.q;
  let timer;
  search.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      state.q = search.value;
      writeUrl();
      renderGrid();
    }, 120);
  });
  search.form.addEventListener("submit", event => {
    event.preventDefault();
    state.q = search.value;
    writeUrl();
    renderGrid();
    $("#catalogue").scrollIntoView();
  });

  $("#category-chips").addEventListener("click", event => {
    const chip = event.target.closest("[data-category]");
    if (!chip) return;
    state.category = chip.dataset.category;
    writeUrl();
    renderChips();
    renderGrid();
  });

  $("#category-rail").addEventListener("click", event => {
    const tile = event.target.closest("[data-category-tile]");
    if (!tile) return;
    state.category = tile.dataset.categoryTile;
    writeUrl();
    renderChips();
    renderGrid();
    $("#catalogue").scrollIntoView();
    document.querySelector(`[data-category="${CSS.escape(state.category)}"]`)?.scrollIntoView({ inline: "center", block: "nearest" });
  });

  const availability = $("#availability-filter");
  const sort = $("#sort");
  availability.value = state.availability;
  sort.value = state.sort;
  availability.addEventListener("change", () => { state.availability = availability.value; writeUrl(); renderGrid(); });
  sort.addEventListener("change", () => { state.sort = sort.value; writeUrl(); renderGrid(); });

  document.addEventListener("click", event => {
    if (!event.target.closest("[data-reset]")) return;
    Object.assign(state, { q: "", category: "all", availability: "all" });
    search.value = "";
    availability.value = "all";
    writeUrl();
    renderChips();
    renderGrid();
  });

  bindCartControls(document.querySelector("main"), sku => state.products.find(p => p.sku === sku), refreshActions);
  window.addEventListener("cart:change", renderOrderBar);
}

/* ---------------- start ---------------- */

async function init() {
  readUrl();
  renderLayout("catalogue");
  $("#product-grid").innerHTML = skeletonCards(8);
  bindEvents();

  try {
    const data = await getCatalog();
    state.products = data.products;
    state.categories = data.categories;
    state.business = { ...DEFAULT_BUSINESS, ...data.settings };
    if (state.category !== "all" && !state.categories.some(c => c.id === state.category)) state.category = "all";
    renderAll();
  } catch (error) {
    console.error("Catalogue error:", error);
    $("#product-grid").setAttribute("aria-busy", "false");
    $("#product-grid").innerHTML = `
      <div class="empty-state">
        <h3>The catalogue could not be loaded</h3>
        <p>${escapeHtml(error.message)}</p>
        <div style="display:flex;gap:.5rem;justify-content:center;flex-wrap:wrap">
          <button class="btn btn-primary" type="button" onclick="location.reload()">Try again</button>
          <a class="btn btn-wa" href="${waUrl(DEFAULT_BUSINESS.whatsapp, `Hi ${DEFAULT_BUSINESS.businessName},\n\n`)}" target="_blank" rel="noopener">${icon.whatsapp}Order on WhatsApp</a>
        </div>
      </div>`;
    $("#result-count").textContent = "";
    $("#hero-mosaic").innerHTML = "";
    renderBusiness();
  }
}

init();
