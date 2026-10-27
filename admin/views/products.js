/* Products — list, create, edit, archive, delete. */

import { api } from "../api.js";
import {
  availabilityBadge, clearFormErrors, confirmDialog, downloadBlob, errorState, esc, field, fromRupeesInput,
  icons, money, openModal, productStatusBadge, selectField, setBusy, showFormErrors, toRupeesInput, toast, toastError
} from "../ui.js";
import { GST_RATES } from "../../shared/pricing.js";

const PAGE_SIZE = 25;
const VIEW_KEY = "oss.admin.productsView";
const thumbUrl = (src, w) => (src || "/images/placeholder.svg").replace("/image/upload/", `/image/upload/f_auto,q_auto,c_limit,w_${w}/`);

export async function render(el, ctx) {
  const [id] = ctx.params;
  if (id) return renderEditor(el, ctx, id === "new" ? null : id);
  return renderList(el, ctx);
}

/* =========================================================
   LIST
========================================================= */

async function renderList(el, ctx) {
  let products, categories;
  try {
    [products, categories] = await Promise.all([api.get("/admin/products"), api.get("/admin/categories")]);
  } catch (error) {
    el.innerHTML = errorState(error, () => render(el, ctx));
    return;
  }
  if (!ctx.isCurrent()) return;

  const state = {
    q: ctx.query.get("q") || "",
    category: ctx.query.get("category") || "",
    status: ctx.query.get("status") || "",
    filter: ctx.query.get("filter") || "",
    sort: ctx.query.get("sort") || "sku",
    page: 1,
    view: (() => { try { return localStorage.getItem(VIEW_KEY) || "grid"; } catch { return "grid"; } })()
  };
  const topCategories = categories.filter(c => !c.parentId);

  el.innerHTML = `
    <div class="page-head">
      <div><h1>Products</h1><p>${products.length} products in the catalogue.</p></div>
      <div class="page-actions">
        <button class="btn btn-outline" type="button" id="export-btn">${icons.download}Export CSV</button>
        <a class="btn btn-outline" href="#/import">${icons.upload}Import CSV</a>
        <a class="btn btn-primary" href="#/products/new">${icons.plus}Add product</a>
      </div>
    </div>
    <div class="toolbar">
      <input class="input grow" type="search" id="q" placeholder="Search by name, SKU or category" value="${esc(state.q)}" aria-label="Search products">
      <select class="select" id="category" style="width:auto" aria-label="Category"><option value="">All categories</option>${topCategories.map(c => `<option value="${esc(c.id)}" ${state.category === c.id ? "selected" : ""}>${esc(c.name)}</option>`).join("")}</select>
      <select class="select" id="status" style="width:auto" aria-label="Status">
        <option value="">All statuses</option><option value="active">Active</option><option value="inactive">Hidden</option><option value="archived">Archived</option>
      </select>
      <select class="select" id="filter" style="width:auto" aria-label="Filter">
        <option value="">All products</option><option value="review">Needs review</option><option value="photo">Photo missing</option><option value="unpriced">No price</option><option value="untracked">Stock not counted</option><option value="unavailable">Out of stock / coming soon</option>
      </select>
      <select class="select" id="sort" style="width:auto" aria-label="Sort">
        <option value="sku">Sort: SKU</option><option value="name">Name</option><option value="price">Price</option><option value="stock">Available stock</option><option value="updated">Recently updated</option>
      </select>
      <div class="view-toggle" role="group" aria-label="Layout">
        <button class="btn btn-ghost btn-icon" type="button" data-view="grid" aria-label="Grid view" title="Grid view">${icons.grid}</button>
        <button class="btn btn-ghost btn-icon" type="button" data-view="table" aria-label="Table view" title="Table view">${icons.list}</button>
      </div>
    </div>
    <section class="card"><div id="list"></div></section>`;

  ["status", "filter", "sort"].forEach(key => { el.querySelector(`#${key}`).value = state[key]; });

  const filtered = () => {
    const q = state.q.trim().toLowerCase();
    let list = products.filter(p => {
      if (q && !`${p.sku} ${p.name} ${p.categoryName} ${p.subcategoryName || ""}`.toLowerCase().includes(q)) return false;
      if (state.category && p.categoryId !== state.category) return false;
      if (state.status && p.status !== state.status) return false;
      const photoProblem = p.imageStatus === "missing" || p.imageStatus === "none";
      if (state.filter === "review" && !p.needsReview.length && !photoProblem) return false;
      if (state.filter === "photo" && !photoProblem) return false;
      if (state.filter === "unpriced" && p.price !== null) return false;
      if (state.filter === "untracked" && p.trackStock) return false;
      if (state.filter === "unavailable" && !["out_of_stock", "coming_soon"].includes(p.availability)) return false;
      return true;
    });
    const sorters = {
      sku: (a, b) => a.sku.localeCompare(b.sku, "en", { numeric: true }),
      name: (a, b) => a.name.localeCompare(b.name),
      price: (a, b) => (a.effectivePrice ?? Infinity) - (b.effectivePrice ?? Infinity),
      stock: (a, b) => (a.availableQty ?? Infinity) - (b.availableQty ?? Infinity),
      updated: (a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))
    };
    return list.sort(sorters[state.sort]);
  };

  const draw = () => {
    const list = filtered();
    const pages = Math.max(1, Math.ceil(list.length / PAGE_SIZE));
    state.page = Math.min(state.page, pages);
    const slice = list.slice((state.page - 1) * PAGE_SIZE, state.page * PAGE_SIZE);
    const box = el.querySelector("#list");
    if (!list.length) {
      box.innerHTML = `<div class="empty"><h3>No products found</h3><p>Try another search or filter.</p></div>`;
      return;
    }
    el.querySelectorAll("[data-view]").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.view === state.view)));
    const flags = p => `${p.imageStatus === "missing" ? '<span class="badge red">Photo file missing</span>' : p.imageStatus === "none" ? '<span class="badge amber">No photo</span>' : ""}${p.needsReview.length ? `<span class="badge amber">Review: ${esc(p.needsReview.map(r => r.field).join(", "))}</span>` : ""}`;
    const body = state.view === "grid" ? `
      <div class="product-tiles">${slice.map(p => `
        <article class="ptile" data-id="${esc(p.id)}">
          <div class="ptile-img">
            <img src="${esc(thumbUrl(p.images[0], 400))}" alt="" loading="lazy" onerror="this.src='/images/placeholder.svg'">
            <div class="ptile-status">${productStatusBadge(p.status)}${p.featured ? ' <span class="badge gold">Featured</span>' : ""}</div>
          </div>
          <div class="ptile-body">
            <span class="ptile-sku">${esc(p.sku)}</span>
            <a class="name" href="#/products/${esc(p.id)}">${esc(p.name)}</a>
            <span class="muted small">${esc(p.categoryName)}${p.subcategoryName ? ` / ${esc(p.subcategoryName)}` : ""}</span>
            <dl class="ptile-facts">
              <div><dt>Price</dt><dd class="num">${p.effectivePrice === null ? '<span class="muted">On request</span>' : money(p.effectivePrice)}</dd></div>
              <div><dt>Stock</dt><dd class="num">${p.trackStock ? `${p.availableQty}${p.reservedQty ? ` <span class="muted small">(${p.reservedQty} reserved)</span>` : ""}` : '<span class="muted">Not counted</span>'}</dd></div>
            </dl>
            <div class="ptile-badges">${availabilityBadge(p.availability)}${flags(p)}</div>
          </div>
        </article>`).join("")}
      </div>` : `
      <div class="table-wrap"><table class="table responsive">
        <thead><tr><th>Product</th><th>Category</th><th class="right">Price</th><th class="right">Stock</th><th>Availability</th><th>Status</th></tr></thead>
        <tbody>${slice.map(p => `
          <tr class="clickable" data-id="${esc(p.id)}">
            <td class="cell-main"><div class="cell-product">
              <img class="thumb" src="${esc((p.images[0] || "/images/placeholder.svg").replace("/image/upload/", "/image/upload/f_auto,q_auto,c_limit,w_120/"))}" alt="" loading="lazy" onerror="this.src='/images/placeholder.svg'">
              <div><a class="name" href="#/products/${esc(p.id)}">${esc(p.name)}</a><div class="muted small">${esc(p.sku)}${p.imageStatus === "missing" ? ' · <span class="badge red">Photo file missing</span>' : p.imageStatus === "none" ? ' · <span class="badge amber">No photo</span>' : ""}${p.needsReview.length ? ` · <span class="badge amber">Review: ${esc(p.needsReview.map(r => r.field).join(", "))}</span>` : ""}</div></div>
            </div></td>
            <td data-label="Category">${esc(p.categoryName)}${p.subcategoryName ? `<div class="muted small">${esc(p.subcategoryName)}</div>` : ""}</td>
            <td data-label="Price" class="right num">${p.effectivePrice === null ? '<span class="muted">On request</span>' : money(p.effectivePrice)}${p.salePrice !== null && p.salePrice !== undefined ? `<div class="muted small"><s>${money(p.price)}</s></div>` : ""}</td>
            <td data-label="Stock" class="right num">${p.trackStock ? `${p.availableQty}${p.reservedQty ? `<div class="muted small">${p.reservedQty} reserved</div>` : ""}` : '<span class="muted">Not counted</span>'}</td>
            <td data-label="Availability">${availabilityBadge(p.availability)}</td>
            <td data-label="Status">${productStatusBadge(p.status)}${p.featured ? ' <span class="badge gold">Featured</span>' : ""}</td>
          </tr>`).join("")}
        </tbody></table></div>`;
    box.innerHTML = `${body}
      <div class="pagination">
        <span class="muted">Showing ${(state.page - 1) * PAGE_SIZE + 1}–${Math.min(state.page * PAGE_SIZE, list.length)} of ${list.length}</span>
        <div style="display:flex;gap:6px">
          <button class="btn btn-outline btn-sm" type="button" data-page="-1" ${state.page === 1 ? "disabled" : ""}>Previous</button>
          <button class="btn btn-outline btn-sm" type="button" data-page="1" ${state.page === pages ? "disabled" : ""}>Next</button>
        </div>
      </div>`;
  };

  el.querySelector("#q").addEventListener("input", e => { state.q = e.target.value; state.page = 1; draw(); });
  ["category", "status", "filter", "sort"].forEach(key => el.querySelector(`#${key}`).addEventListener("change", e => { state[key] = e.target.value; state.page = 1; draw(); }));
  el.querySelector("#list").addEventListener("click", e => {
    const pager = e.target.closest("[data-page]");
    if (pager) { state.page += Number(pager.dataset.page); draw(); el.scrollIntoView(); return; }
    const row = e.target.closest("[data-id]");
    if (row && !e.target.closest("a")) ctx.navigate(`products/${row.dataset.id}`);
  });
  el.querySelector(".view-toggle").addEventListener("click", e => {
    const button = e.target.closest("[data-view]");
    if (!button) return;
    state.view = button.dataset.view;
    try { localStorage.setItem(VIEW_KEY, state.view); } catch { /* ignore */ }
    draw();
  });
  el.querySelector("#export-btn").addEventListener("click", async e => {
    setBusy(e.currentTarget, true);
    try {
      downloadBlob(await api.blob("/admin/products/export.csv"), `oss-products-${new Date().toISOString().slice(0, 10)}.csv`);
    } catch (error) { toastError(error); }
    setBusy(e.currentTarget, false);
  });
  draw();
}

/* =========================================================
   EDITOR
========================================================= */

async function renderEditor(el, ctx, id) {
  let product = null, categories;
  try {
    [product, categories] = await Promise.all([id ? api.get(`/admin/products/${encodeURIComponent(id)}`) : null, api.get("/admin/categories")]);
  } catch (error) {
    el.innerHTML = errorState(error, () => render(el, ctx));
    return;
  }
  if (!ctx.isCurrent()) return;

  const p = product || { sku: "", name: "", description: "", categoryId: "", subcategoryId: "", price: null, salePrice: null, gstRate: null, hsn: "", minQty: 1, unit: "pcs", lowStockThreshold: null, manualStatus: "in_stock", status: "active", featured: false, sortOrder: 9999, specs: [], images: [], needsReview: [] };
  let images = [...(p.images || [])];
  const active = categories.filter(c => !c.archived);
  const tops = active.filter(c => !c.parentId);
  const imageOpts = ctx.config?.images || { configured: false };

  el.innerHTML = `
    <div class="page-head">
      <div><a href="#/products" class="muted small">← Products</a><h1>${product ? esc(product.name) : "Add product"}</h1>${product ? `<p>${esc(product.sku)} · ${productStatusBadge(product.status)} ${availabilityBadge(product.availability)}</p>` : ""}</div>
      ${product ? `<div class="page-actions">
        <a class="btn btn-outline" href="product.html?sku=${encodeURIComponent(product.sku)}" target="_blank" rel="noopener">View on site ↗</a>
        <a class="btn btn-outline" href="#/inventory/${esc(product.id)}">Stock & history</a>
      </div>` : ""}
    </div>

    ${p.needsReview?.length ? `<div class="notice warn" style="margin-bottom:16px"><strong>Needs review:</strong><ul style="margin:6px 0 0;padding-left:18px">${p.needsReview.map(r => `<li><strong>${esc(r.field)}</strong> — ${esc(r.note)} <button type="button" class="btn btn-ghost btn-sm" data-resolve="${esc(r.field)}">Mark checked</button></li>`).join("")}</ul></div>` : ""}

    <form id="product-form" novalidate>
      <div class="detail-grid">
        <div class="grid">
          <section class="card card-pad">
            <h2>Product details</h2>
            <div class="form-grid">
              ${field({ name: "name", label: "Product name", value: p.name, required: true, full: true, attrs: 'maxlength="160"' })}
              <div class="field">
                <label for="f-sku">SKU / product code</label>
                <input class="input" id="f-sku" name="sku" value="${esc(p.sku)}" maxlength="32" style="text-transform:uppercase" ${product ? "" : 'placeholder="Leave blank to generate (OSS_###)"'}>
                <span class="hint">Letters, numbers, _ and -. Must be unique.</span>
                <span class="error" data-for="sku"></span>
              </div>
              ${field({ name: "unit", label: "Unit", value: p.unit || "pcs", hint: "e.g. pcs, set, box", attrs: 'maxlength="20"' })}
              <div class="field">
                <label for="f-categoryId">Category</label>
                <select class="select" id="f-categoryId" name="categoryId">
                  <option value="">Select a category</option>
                  ${tops.map(c => `<option value="${esc(c.id)}" ${p.categoryId === c.id ? "selected" : ""}>${esc(c.name)}</option>`).join("")}
                  <option value="__new">+ Create new category…</option>
                </select>
                <span class="error" data-for="categoryId"></span>
              </div>
              <div class="field" id="new-category-field" hidden>
                <label for="f-newCategoryName">New category name</label>
                <input class="input" id="f-newCategoryName" name="newCategoryName" maxlength="80">
                <span class="error" data-for="newCategoryName"></span>
              </div>
              <div class="field" id="subcategory-field">
                <label for="f-subcategoryId">Subcategory <span class="muted" style="font-weight:500">(optional)</span></label>
                <select class="select" id="f-subcategoryId" name="subcategoryId"></select>
                <span class="error" data-for="subcategoryId"></span>
              </div>
              ${field({ name: "description", label: "Description", value: p.description, type: "textarea", full: true, attrs: 'maxlength="4000" rows="5"' })}
              <div class="field full">
                <label for="f-specs">Specifications <span class="muted" style="font-weight:500">(optional)</span></label>
                <textarea class="textarea" id="f-specs" name="specs" rows="4" placeholder="One per line, e.g.&#10;Capacity: 2 litres&#10;Material: BPA-free plastic">${esc((p.specs || []).map(s => s.label ? `${s.label}: ${s.value}` : s.value).join("\n"))}</textarea>
                <span class="hint">Enter only verified details. Format: Label: value</span>
                <span class="error" data-for="specs"></span>
              </div>
            </div>
          </section>

          <section class="card card-pad">
            <h2>Images</h2>
            <p class="muted small" style="margin:-6px 0 12px">Images are stored in Cloudinary and linked to this product in Firestore. The first image is the main photo.</p>
            ${!imageOpts.configured ? '<p class="notice error" style="margin:0 0 12px">Image uploads are not configured on the server (Cloudinary credentials missing). Existing images still display.</p>' : ""}
            ${product?.imageStatus === "missing" ? '<p class="notice warn" style="margin:0 0 12px">The main image cannot be found, so the website shows a placeholder. Upload a replacement.</p>' : ""}
            ${product?.imageStatus === "none" ? '<p class="notice warn" style="margin:0 0 12px">This product has no photo yet; the website shows a placeholder.</p>' : ""}
            <div class="images-grid" id="images"></div>
            <span class="error field" data-for="images" style="color:var(--danger);font-weight:600;font-size:12px"></span>
            <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:12px">
              <label class="btn btn-primary" for="image-file" ${imageOpts.configured ? "" : 'aria-disabled="true" style="pointer-events:none;opacity:.5"'}>${icons.upload}Upload photo</label>
              <input type="file" id="image-file" accept="image/jpeg,image/png,image/webp" hidden>
              <button class="btn btn-outline" type="button" id="pick-image" ${imageOpts.configured ? "" : "disabled"}>Choose from image library</button>
            </div>
            <div class="image-add">
              <div class="field">
                <label for="image-url">Or add from a link</label>
                <input class="input" id="image-url" placeholder="https://…" autocomplete="off" spellcheck="false" inputmode="url">
                <span class="hint">The image is copied into Cloudinary, so the product never depends on the other website.</span>
              </div>
              <button class="btn btn-outline" type="button" id="preview-url" style="margin-top:22px" ${imageOpts.configured ? "" : "disabled"}>Preview</button>
            </div>
            <div id="url-preview"></div>
            <p class="muted small" id="upload-status" role="status" style="margin:8px 0 0"></p>
          </section>
        </div>

        <div class="grid">
          <section class="card card-pad">
            <h2>Price</h2>
            <div class="form-grid">
              ${field({ name: "price", label: "Regular price", value: toRupeesInput(p.price), prefix: "₹", attrs: 'inputmode="decimal" placeholder="Price on request"', full: true, hint: "Leave empty to show “Price on request”." })}
              ${field({ name: "salePrice", label: "Discounted price", value: toRupeesInput(p.salePrice), prefix: "₹", attrs: 'inputmode="decimal"', full: true })}
              ${selectField({ name: "gstRate", label: "GST rate", value: p.gstRate ?? "", required: false, options: [["", "Use default (Settings)"], ...GST_RATES.map(r => [r, `${r}%`])] })}
              ${field({ name: "hsn", label: "HSN code", value: p.hsn, attrs: 'inputmode="numeric" maxlength="8"' })}
              ${field({ name: "minQty", label: "Minimum order qty", value: p.minQty || 1, type: "number", required: true, attrs: 'min="1" step="1"' })}
            </div>
          </section>

          <section class="card card-pad">
            <h2>Availability</h2>
            <div class="form-grid">
              ${selectField({ name: "status", label: "Publication", value: p.status, options: [["active", "Active — shown on website"], ["inactive", "Hidden from website"], ...(product ? [["archived", "Archived"]] : [])], full: true })}
              ${selectField({ name: "manualStatus", label: p.trackStock ? "When out of stock, show" : "Stock status", value: p.manualStatus, options: p.trackStock ? [["out_of_stock", "Out of stock"], ["coming_soon", "Coming soon"]] : [["in_stock", "In stock"], ["coming_soon", "Coming soon"], ["out_of_stock", "Out of stock"]], full: true, hint: p.trackStock ? "Availability is calculated from stock." : "Used until you record an initial stock count in Inventory." })}
              ${field({ name: "lowStockThreshold", label: "Low-stock alert at", value: p.lowStockThreshold ?? "", type: "number", attrs: 'min="0" step="1"', full: true })}
              <label class="check full"><input type="checkbox" name="featured" ${p.featured ? "checked" : ""}> Feature on the homepage</label>
              ${field({ name: "sortOrder", label: "Display order", value: p.sortOrder === 9999 ? "" : p.sortOrder ?? "", type: "number", attrs: 'min="0" step="1"', full: true, hint: "Lower numbers appear first." })}
            </div>
            ${product ? `<dl class="kv" style="margin-top:14px"><dt>Stock</dt><dd>${product.trackStock ? `${product.stockQty} on hand · ${product.reservedQty} reserved · ${product.availableQty} available` : "Not counted yet"}</dd><dt>In orders</dt><dd>${product.orderCount || 0}</dd></dl>` : ""}
          </section>

          <div class="card card-pad" style="display:grid;gap:8px">
            <div class="notice error" id="form-error" hidden></div>
            <button class="btn btn-primary btn-lg btn-block" type="submit" id="save-btn">${product ? "Save changes" : "Create product"}</button>
            ${product ? `
              ${product.status === "archived"
                ? '<button class="btn btn-outline btn-block" type="button" id="restore-btn">Restore product</button>'
                : '<button class="btn btn-outline btn-block" type="button" id="archive-btn">Archive product</button>'}
              <button class="btn btn-danger btn-block" type="button" id="delete-btn" ${product.orderCount ? 'disabled title="Used in orders — archive instead"' : ""}>Delete permanently</button>
              ${product.orderCount ? '<span class="muted small">This product appears in orders, so it can only be archived.</span>' : ""}` : ""}
          </div>
        </div>
      </div>
    </form>`;

  const form = el.querySelector("#product-form");
  const categorySelect = form.querySelector("#f-categoryId");
  const subSelect = form.querySelector("#f-subcategoryId");

  const fillSubcategories = () => {
    const subs = active.filter(c => c.parentId === categorySelect.value);
    subSelect.innerHTML = `<option value="">None</option>${subs.map(c => `<option value="${esc(c.id)}" ${p.subcategoryId === c.id ? "selected" : ""}>${esc(c.name)}</option>`).join("")}`;
    el.querySelector("#subcategory-field").hidden = subs.length === 0;
    el.querySelector("#new-category-field").hidden = categorySelect.value !== "__new";
  };
  categorySelect.addEventListener("change", fillSubcategories);
  fillSubcategories();

  // Current form values in API shape (prices in paise).
  const collect = () => {
    const f = form.elements;
    const isNewCategory = f.categoryId.value === "__new";
    return {
      name: f.name.value.trim(),
      sku: f.sku.value.trim(),
      unit: f.unit.value.trim(),
      description: f.description.value,
      specs: f.specs.value,
      price: fromRupeesInput(f.price.value),
      salePrice: fromRupeesInput(f.salePrice.value),
      gstRate: f.gstRate.value === "" ? null : Number(f.gstRate.value),
      hsn: f.hsn.value.trim(),
      minQty: f.minQty.value,
      status: f.status.value,
      manualStatus: f.manualStatus.value,
      lowStockThreshold: f.lowStockThreshold.value,
      featured: f.featured.checked,
      sortOrder: f.sortOrder.value,
      images: [...images],
      ...(isNewCategory ? { newCategoryName: f.newCategoryName.value } : { categoryId: f.categoryId.value }),
      subcategoryId: isNewCategory ? "" : f.subcategoryId.value
    };
  };

  /* ---- images ---- */
  const isCloudinary = src => /^https:\/\/res\.cloudinary\.com\//.test(src);
  const thumb = src => isCloudinary(src) ? src.replace("/image/upload/", "/image/upload/f_auto,q_auto,c_limit,w_300/") : src;
  const statusLine = el.querySelector("#upload-status");
  let replaceIndex = null;

  const drawImages = () => {
    el.querySelector("#images").innerHTML = images.length ? images.map((src, i) => `
      <div class="img-tile" data-index="${i}" title="${esc(src)}">
        <img src="${esc(thumb(src))}" alt="Image ${i + 1}" onerror="this.parentElement.classList.add('broken')">
        ${i === 0 ? '<span class="tag">Main</span>' : ""}
        ${isCloudinary(src) ? "" : '<span class="badge amber" title="Stored in the project folder, not yet in Cloudinary. Run the image migration or upload a replacement." style="position:absolute;left:6px;top:32px">Local file</span>'}
        <div class="tools">
          ${i > 0 ? `<button type="button" data-img="first" title="Make main image" aria-label="Make main image">★</button><button type="button" data-img="left" aria-label="Move left">‹</button>` : ""}
          ${i < images.length - 1 ? '<button type="button" data-img="right" aria-label="Move right">›</button>' : ""}
          ${imageOpts.configured ? '<button type="button" data-img="replace" title="Replace with a new photo" aria-label="Replace image">⟳</button>' : ""}
          <button type="button" data-img="remove" title="Remove from this product" aria-label="Remove image">✕</button>
        </div>
      </div>`).join("") : '<div class="muted small">No images yet — the website shows a placeholder.</div>';
  };
  drawImages();
  // Snapshot of the loaded values, used to send only changed fields.
  const initial = collect();

  const addImage = url => {
    if (replaceIndex !== null) {
      images[replaceIndex] = url;
      replaceIndex = null;
    } else {
      if (images.includes(url)) return toast("This image is already on the product.");
      if (images.length >= 8) return toast("Up to 8 images are allowed.", "error");
      images.push(url);
    }
    drawImages();
    toast("Image ready. Save the product to keep this change.");
  };

  el.querySelector("#images").addEventListener("click", e => {
    const button = e.target.closest("[data-img]");
    if (!button) return;
    const i = Number(button.closest("[data-index]").dataset.index);
    const action = button.dataset.img;
    if (action === "replace") {
      replaceIndex = i;
      el.querySelector("#image-file").click();
      return;
    }
    if (action === "remove") images.splice(i, 1);
    if (action === "first") images.unshift(images.splice(i, 1)[0]);
    if (action === "left") [images[i - 1], images[i]] = [images[i], images[i - 1]];
    if (action === "right") [images[i + 1], images[i]] = [images[i], images[i + 1]];
    drawImages();
  });

  // Signed upload: the server signs one upload for one public ID; the file
  // goes straight from the browser to Cloudinary; the server then verifies it.
  el.querySelector("#image-file").addEventListener("change", async e => {
    const file = e.target.files[0];
    e.target.value = "";
    if (!file) { replaceIndex = null; return; }
    if (!/^image\/(jpeg|png|webp)$/.test(file.type)) { replaceIndex = null; return toast("Choose a JPEG, PNG or WebP image.", "error"); }
    const label = el.querySelector('label[for="image-file"]');
    label.classList.add("is-loading");
    try {
      statusLine.textContent = "Preparing photo…";
      const blob = await resizeImage(file);
      statusLine.textContent = "Uploading to Cloudinary…";
      const signed = await api.post("/admin/images/signature", { sku: form.sku.value });
      if (blob.size > signed.maxBytes) throw new Error("This photo is too large even after resizing.");
      const data = new FormData();
      for (const [key, value] of Object.entries(signed.fields)) data.append(key, value);
      data.append("file", blob, file.name.replace(/\.[^.]+$/, "") + ".jpg");
      let response;
      try {
        response = await fetch(signed.uploadUrl, { method: "POST", body: data });
      } catch {
        throw new Error("Could not reach Cloudinary. Check your internet connection and try again.");
      }
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(`Cloudinary rejected the upload: ${result?.error?.message || response.status}`);
      statusLine.textContent = "Verifying upload…";
      const asset = await api.post("/admin/images/confirm", result);
      addImage(asset.url);
      statusLine.textContent = "Uploaded. Save the product to keep it.";
    } catch (error) {
      replaceIndex = null;
      statusLine.textContent = "";
      toastError(error);
    }
    label.classList.remove("is-loading");
  });

  const urlInput = el.querySelector("#image-url");
  const previewBox = el.querySelector("#url-preview");
  el.querySelector("#preview-url").addEventListener("click", () => {
    const value = urlInput.value.trim();
    if (/^[a-z]:[\\/]/i.test(value) || value.includes("\\")) {
      previewBox.innerHTML = '<p class="notice error" style="margin-top:8px">That is a file on this computer. Use “Upload photo” instead.</p>';
      return;
    }
    if (!/^https:\/\//i.test(value)) {
      previewBox.innerHTML = '<p class="notice error" style="margin-top:8px">Enter an https:// image link.</p>';
      return;
    }
    previewBox.innerHTML = `
      <div class="preview-box">
        <img src="${esc(value)}" alt="Preview" id="preview-img">
        <div style="flex:1;min-width:0"><div class="small" id="preview-status">Loading preview…</div><div class="muted small" style="word-break:break-all">${esc(value)}</div></div>
        <button class="btn btn-primary btn-sm" type="button" id="add-url" disabled>Copy to Cloudinary & add</button>
      </div>`;
    const img = previewBox.querySelector("#preview-img");
    img.onload = () => {
      previewBox.querySelector("#preview-status").textContent = `Image loaded (${img.naturalWidth}×${img.naturalHeight}). Check that it shows this product and that you may use it.`;
      previewBox.querySelector("#add-url").disabled = false;
    };
    img.onerror = () => { previewBox.querySelector("#preview-status").innerHTML = '<span style="color:var(--danger)">This image could not be loaded. Check the link.</span>'; };
    previewBox.querySelector("#add-url").addEventListener("click", async ev => {
      setBusy(ev.currentTarget, true);
      try {
        const asset = await api.post("/admin/images/import-url", { url: value, sku: form.sku.value });
        addImage(asset.url);
        urlInput.value = "";
        previewBox.innerHTML = "";
      } catch (error) {
        toastError(error);
        setBusy(ev.currentTarget, false);
      }
    });
  });

  el.querySelector("#pick-image").addEventListener("click", async e => {
    const button = e.currentTarget;
    setBusy(button, true);
    let list;
    try { list = (await api.get("/admin/images/assets")).filter(a => a.status !== "deleted"); }
    catch (error) { toastError(error); setBusy(button, false); return; }
    setBusy(button, false);
    const modal = openModal({
      title: "Image library",
      size: "wide",
      body: `<input class="input" id="pick-q" type="search" placeholder="Filter by name or product" style="margin-bottom:12px" aria-label="Filter images">
        <div class="images-grid" id="pick-grid" style="grid-template-columns:repeat(auto-fill,minmax(130px,1fr))"></div>`
    });
    const drawPick = q => {
      const query = q.trim().toLowerCase();
      const shown = list.filter(a => !query || a.publicId.toLowerCase().includes(query));
      modal.$("#pick-grid").innerHTML = shown.map(a => `
        <button type="button" class="img-tile" data-pick="${esc(a.url)}" style="padding:0;cursor:pointer;${images.includes(a.url) ? "outline:3px solid var(--navy);" : ""}" title="${esc(a.publicId)}">
          <img src="${esc(thumb(a.url))}" alt="" loading="lazy">
          <span class="tag" style="max-width:calc(100% - 12px);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(a.publicId.split("/").pop())}</span>
          <span class="badge ${a.status === "in_use" ? "green" : "amber"}" style="position:absolute;right:6px;bottom:6px">${a.status === "in_use" ? `${a.productIds.length} product${a.productIds.length === 1 ? "" : "s"}` : "Unused"}</span>
        </button>`).join("") || '<p class="muted">No uploaded images yet.</p>';
    };
    drawPick("");
    modal.$("#pick-q").addEventListener("input", ev => drawPick(ev.target.value));
    modal.$("#pick-grid").addEventListener("click", ev => {
      const pick = ev.target.closest("[data-pick]");
      if (!pick) return;
      addImage(pick.dataset.pick);
      modal.close();
    });
  });

  /* ---- review flags ---- */
  el.querySelectorAll("[data-resolve]").forEach(button => button.addEventListener("click", async () => {
    try {
      await api.patch(`/admin/products/${encodeURIComponent(product.id)}`, { resolveReview: [button.dataset.resolve] });
      toast("Marked as checked.", "success");
      render(el, ctx);
    } catch (error) { toastError(error); }
  }));

  /* ---- save ---- */
  form.addEventListener("submit", async e => {
    e.preventDefault();
    clearFormErrors(form);
    const errorBox = el.querySelector("#form-error");
    errorBox.hidden = true;
    const f = form.elements;
    const price = fromRupeesInput(f.price.value);
    const salePrice = fromRupeesInput(f.salePrice.value);
    if (Number.isNaN(price) || Number.isNaN(salePrice)) {
      showFormErrors(form, { details: { fields: { ...(Number.isNaN(price) ? { price: "Enter a valid amount, e.g. 249 or 249.50." } : {}), ...(Number.isNaN(salePrice) ? { salePrice: "Enter a valid amount." } : {}) } } });
      return;
    }
    const isNewCategory = f.categoryId.value === "__new";
    const all = collect();
    if (isNewCategory && !all.newCategoryName.trim()) {
      showFormErrors(form, { details: { fields: { newCategoryName: "Enter the new category name." } } });
      return;
    }

    let body;
    if (product) {
      // Send only what changed, so fields edited elsewhere are not overwritten.
      body = {};
      for (const [key, value] of Object.entries(all)) {
        if (JSON.stringify(value) !== JSON.stringify(initial[key])) body[key] = value;
      }
      if ("categoryId" in body || "newCategoryName" in body) body.subcategoryId = all.subcategoryId;
      if (!Object.keys(body).length) {
        toast("No changes to save.");
        return;
      }
      body.expectedUpdatedAt = product.updatedAt;
    } else {
      body = { ...all, generateSku: !all.sku };
      if (!body.sku) delete body.sku;
    }

    const button = el.querySelector("#save-btn");
    setBusy(button, true);
    try {
      const saved = product
        ? await api.patch(`/admin/products/${encodeURIComponent(product.id)}`, body)
        : await api.post("/admin/products", body);
      toast(product
        ? "Saved to Firestore. The website shows the change within about 10 seconds."
        : `Product ${saved.sku} created and saved to Firestore.`, "success");
      if (product) render(el, ctx);
      else ctx.navigate(`products/${saved.id}`);
    } catch (error) {
      // The form keeps everything the admin typed.
      showFormErrors(form, error);
      errorBox.innerHTML = `${esc(error.message)}${error.details?.stale ? ' <button type="button" class="btn btn-outline btn-sm" id="reload-product">Reload latest (discards your edits)</button>' : ""}`;
      errorBox.hidden = false;
      el.querySelector("#reload-product")?.addEventListener("click", () => render(el, ctx));
      setBusy(button, false);
    }
  });

  /* ---- archive / restore / delete ---- */
  el.querySelector("#archive-btn")?.addEventListener("click", async () => {
    const ok = await confirmDialog({ title: "Archive product?", message: `${esc(product.name)} will be hidden from the website. Its order and stock history is kept, and you can restore it later.`, confirmText: "Archive" });
    if (!ok) return;
    try { await api.patch(`/admin/products/${encodeURIComponent(product.id)}`, { status: "archived" }); toast("Product archived."); render(el, ctx); }
    catch (error) { toastError(error); }
  });
  el.querySelector("#restore-btn")?.addEventListener("click", async () => {
    try { await api.patch(`/admin/products/${encodeURIComponent(product.id)}`, { status: "inactive" }); toast("Product restored as hidden. Set it to Active to show it on the website."); render(el, ctx); }
    catch (error) { toastError(error); }
  });
  el.querySelector("#delete-btn")?.addEventListener("click", async () => {
    const typed = await confirmDialog({ title: "Delete product permanently?", message: `This cannot be undone. Type <strong>${esc(product.sku)}</strong> to confirm.`, confirmText: "Delete", danger: true, input: { label: "SKU", required: true } });
    if (typed === false) return;
    if (typed.toUpperCase() !== product.sku) return toast("SKU did not match. Product not deleted.", "error");
    try { await api.del(`/admin/products/${encodeURIComponent(product.id)}`); toast("Product deleted."); ctx.navigate("products"); }
    catch (error) { toastError(error); }
  });
}

/* Resize large photos in the browser so uploads stay small (max 1600px JPEG). */
function resizeImage(file, max = 1600) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      const scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(img.naturalWidth * scale);
      canvas.height = Math.round(img.naturalHeight * scale);
      const g = canvas.getContext("2d");
      g.fillStyle = "#fff";
      g.fillRect(0, 0, canvas.width, canvas.height);
      g.drawImage(img, 0, 0, canvas.width, canvas.height);
      canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error("This photo could not be processed.")), "image/jpeg", 0.86);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("This file could not be read as an image.")); };
    img.src = url;
  });
}
