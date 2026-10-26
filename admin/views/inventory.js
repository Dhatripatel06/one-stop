/* Inventory — stock levels, adjustments and movement history. */

import { api } from "../api.js";
import { availabilityBadge, date, errorState, esc, field, openModal, selectField, setBusy, showFormErrors, toast } from "../ui.js";
import { MOVEMENT_TYPES } from "../../shared/constants.js";

export async function render(el, ctx) {
  const [id] = ctx.params;
  return id ? renderProduct(el, ctx, id) : renderList(el, ctx);
}

function movementRows(items, { showProduct = true } = {}) {
  if (!items.length) return '<div class="empty"><p>No stock movements recorded yet.</p></div>';
  return `
    <div class="table-wrap"><table class="table responsive">
      <thead><tr><th>When</th>${showProduct ? "<th>Product</th>" : ""}<th>Type</th><th class="right">Change</th><th class="right">Stock</th><th class="right">Reserved</th><th>Reason</th><th>By</th></tr></thead>
      <tbody>${items.map(m => `
        <tr>
          <td class="cell-main nowrap">${date(m.at, true)}</td>
          ${showProduct ? `<td data-label="Product"><a href="#/inventory/${esc(m.productId)}">${esc(m.sku)}</a> <span class="muted small">${esc(m.productName)}</span></td>` : ""}
          <td data-label="Type">${esc(MOVEMENT_TYPES[m.type] || m.type)}</td>
          <td data-label="Change" class="right num">${m.qtyChange > 0 ? `+${m.qtyChange}` : m.qtyChange || "—"}</td>
          <td data-label="Stock" class="right num">${m.stockBefore} → ${m.stockAfter}</td>
          <td data-label="Reserved" class="right num">${m.reservedBefore} → ${m.reservedAfter}</td>
          <td data-label="Reason">${esc(m.reason)}${m.orderId ? ` <a href="#/orders/${esc(m.orderId)}">${esc(m.orderNo)}</a>` : ""}</td>
          <td data-label="By" class="small">${esc(m.actor?.email || m.actor?.uid || "")}</td>
        </tr>`).join("")}
      </tbody></table></div>`;
}

export function openAdjustModal(product, onDone) {
  const tracked = product.trackStock;
  const modal = openModal({
    title: `Adjust stock — ${product.sku}`,
    size: "narrow",
    body: `
      <form id="adjust-form" novalidate>
        <p class="muted" style="margin-top:0">${esc(product.name)}</p>
        ${tracked ? `<div class="notice" style="margin-bottom:14px">On hand <strong>${product.stockQty}</strong> · Reserved <strong>${product.reservedQty}</strong> · Available <strong>${product.availableQty}</strong></div>` : '<div class="notice warn" style="margin-bottom:14px">Stock has not been counted for this product. Record the initial count to start tracking.</div>'}
        <div class="form-grid">
          ${selectField({ name: "type", label: "Adjustment", full: true, value: tracked ? "increase" : "initial", options: tracked
            ? [["increase", "Stock received (increase)"], ["decrease", "Stock removed (decrease)"], ["correction", "Correct to counted quantity"]]
            : [["initial", "Initial stock count"]] })}
          ${field({ name: "qty", label: "Quantity", type: "number", required: true, full: true, attrs: 'min="0" step="1" inputmode="numeric"', hint: tracked ? "For a correction, enter the actual counted quantity." : "" })}
          ${field({ name: "reason", label: "Reason", required: true, full: true, attrs: 'maxlength="300" placeholder="e.g. Purchase from supplier, damaged items, stock count"' })}
          ${field({ name: "lowStockThreshold", label: "Low-stock alert at", type: "number", value: product.lowStockThreshold ?? "", full: true, attrs: 'min="0" step="1"' })}
        </div>
        <div class="notice error" id="adjust-error" style="margin-top:12px" hidden></div>
      </form>`,
    foot: '<button class="btn btn-outline" type="button" data-close>Cancel</button><button class="btn btn-primary" type="submit" form="adjust-form" id="adjust-save">Save adjustment</button>'
  });

  modal.$("#adjust-form").addEventListener("submit", async e => {
    e.preventDefault();
    const f = e.target.elements;
    const button = modal.$("#adjust-save");
    setBusy(button, true);
    try {
      await api.post(`/admin/products/${encodeURIComponent(product.id)}/stock`, {
        type: f.type.value, qty: f.qty.value, reason: f.reason.value, lowStockThreshold: f.lowStockThreshold.value
      });
      toast("Stock updated.", "success");
      modal.close();
      onDone?.();
    } catch (error) {
      showFormErrors(e.target, error);
      modal.$("#adjust-error").textContent = error.message;
      modal.$("#adjust-error").hidden = false;
      setBusy(button, false);
    }
  });
  modal.$('[name="qty"]').focus();
}

async function renderList(el, ctx) {
  let products, movements;
  try {
    [products, movements] = await Promise.all([api.get("/admin/products"), api.get("/admin/inventory/movements?limit=30")]);
  } catch (error) {
    el.innerHTML = errorState(error, () => render(el, ctx));
    return;
  }
  if (!ctx.isCurrent()) return;
  products = products.filter(p => p.status !== "archived");
  let filter = ctx.query.get("filter") || "all";
  let q = "";

  el.innerHTML = `
    <div class="page-head"><div><h1>Inventory</h1><p>Stock is deducted once, when an order is dispatched. Confirmed orders reserve stock.</p></div></div>
    <div class="toolbar">
      <input class="input grow" type="search" id="q" placeholder="Search by name or SKU" aria-label="Search">
      <select class="select" id="filter" style="width:auto" aria-label="Filter">
        <option value="all">All products</option><option value="tracked">Tracked</option><option value="untracked">Not counted</option><option value="low">Low stock</option><option value="out">Out of stock</option>
      </select>
    </div>
    <section class="card" style="margin-bottom:16px"><div id="stock-list"></div></section>
    <section class="card"><div class="card-head"><h2>Recent stock movements</h2></div>${movementRows(movements.items)}</section>`;
  el.querySelector("#filter").value = filter;

  const draw = () => {
    const list = products.filter(p => {
      if (q && !`${p.sku} ${p.name}`.toLowerCase().includes(q)) return false;
      if (filter === "tracked") return p.trackStock;
      if (filter === "untracked") return !p.trackStock;
      if (filter === "low") return p.availability === "low_stock";
      if (filter === "out") return p.availability === "out_of_stock";
      return true;
    }).sort((a, b) => a.sku.localeCompare(b.sku, "en", { numeric: true }));
    el.querySelector("#stock-list").innerHTML = list.length ? `
      <div class="table-wrap"><table class="table responsive">
        <thead><tr><th>Product</th><th class="right">On hand</th><th class="right">Reserved</th><th class="right">Available</th><th class="right">Alert at</th><th>Availability</th><th></th></tr></thead>
        <tbody>${list.map(p => `
          <tr>
            <td class="cell-main"><div class="cell-product"><img class="thumb" src="${esc(p.images[0] || "538820.jpg")}" alt="" loading="lazy"><div><a class="name" href="#/inventory/${esc(p.id)}">${esc(p.name)}</a><div class="muted small">${esc(p.sku)}</div></div></div></td>
            <td data-label="On hand" class="right num">${p.trackStock ? p.stockQty : "—"}</td>
            <td data-label="Reserved" class="right num">${p.trackStock ? p.reservedQty : "—"}</td>
            <td data-label="Available" class="right num"><strong>${p.trackStock ? p.availableQty : '<span class="muted" style="font-weight:500">Not counted</span>'}</strong></td>
            <td data-label="Alert at" class="right num">${p.lowStockThreshold ?? "—"}</td>
            <td data-label="Availability">${availabilityBadge(p.availability)}</td>
            <td class="right"><button class="btn btn-outline btn-sm" type="button" data-adjust="${esc(p.id)}">${p.trackStock ? "Adjust" : "Enter initial stock"}</button></td>
          </tr>`).join("")}
        </tbody></table></div>` : '<div class="empty"><p>No products match.</p></div>';
  };

  el.querySelector("#q").addEventListener("input", e => { q = e.target.value.trim().toLowerCase(); draw(); });
  el.querySelector("#filter").addEventListener("change", e => { filter = e.target.value; draw(); });
  el.querySelector("#stock-list").addEventListener("click", e => {
    const button = e.target.closest("[data-adjust]");
    if (button) openAdjustModal(products.find(p => p.id === button.dataset.adjust), () => render(el, ctx));
  });
  draw();
}

async function renderProduct(el, ctx, id) {
  let product, movements;
  try {
    [product, movements] = await Promise.all([api.get(`/admin/products/${encodeURIComponent(id)}`), api.get(`/admin/inventory/movements?productId=${encodeURIComponent(id)}&limit=100`)]);
  } catch (error) {
    el.innerHTML = errorState(error, () => render(el, ctx));
    return;
  }
  if (!ctx.isCurrent()) return;

  el.innerHTML = `
    <div class="page-head">
      <div><a href="#/inventory" class="muted small">← Inventory</a><h1>${esc(product.name)}</h1><p>${esc(product.sku)} · ${availabilityBadge(product.availability)}</p></div>
      <div class="page-actions"><a class="btn btn-outline" href="#/products/${esc(product.id)}">Edit product</a><button class="btn btn-primary" type="button" id="adjust">${product.trackStock ? "Adjust stock" : "Enter initial stock"}</button></div>
    </div>
    <div class="stats">
      <div class="stat"><div class="label">On hand</div><div class="value">${product.trackStock ? product.stockQty : "—"}</div></div>
      <div class="stat"><div class="label">Reserved for orders</div><div class="value">${product.trackStock ? product.reservedQty : "—"}</div></div>
      <div class="stat"><div class="label">Available</div><div class="value">${product.trackStock ? product.availableQty : "—"}</div><div class="hint">${product.trackStock ? "" : "Stock not counted yet"}</div></div>
      <div class="stat"><div class="label">Low-stock alert at</div><div class="value">${product.lowStockThreshold ?? "—"}</div></div>
    </div>
    <section class="card"><div class="card-head"><h2>Movement history</h2></div>${movementRows(movements.items, { showProduct: false })}</section>`;
  el.querySelector("#adjust").addEventListener("click", () => openAdjustModal(product, () => render(el, ctx)));
}
