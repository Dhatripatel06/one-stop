/* Orders — list, create, edit pending orders, status workflow, invoicing. */

import { api } from "../api.js";
import { refreshPendingCount } from "../main.js";
import {
  confirmDialog, date, errorState, esc, field, fromRupeesInput, money, openModal, orderBadge, phoneDisplay,
  selectField, setBusy, showFormErrors, toRupeesInput, toast, toastError, icons
} from "../ui.js";
import { GST_RATES, INDIAN_STATES, stateName } from "../../shared/pricing.js";
import { ORDER_STATUSES, ORDER_TRANSITIONS } from "../../shared/constants.js";
import { invoiceHtml } from "./invoices.js";

export async function render(el, ctx) {
  const [id] = ctx.params;
  if (id === "new") return renderNew(el, ctx);
  if (id) return renderDetail(el, ctx, id);
  return renderList(el, ctx);
}

/* =========================================================
   LIST
========================================================= */

async function renderList(el, ctx) {
  const status = ctx.query.get("status") || "";
  const q = ctx.query.get("q") || "";
  el.innerHTML = `
    <div class="page-head">
      <div><h1>Orders</h1><p>Website orders arrive as “Pending confirmation”.</p></div>
      <div class="page-actions"><a class="btn btn-primary" href="#/orders/new">+ New order</a></div>
    </div>
    <div class="toolbar">
      <form id="search-form" class="grow" style="display:flex;gap:8px">
        <input class="input" type="search" name="q" value="${esc(q)}" placeholder="Order number, customer name or phone" aria-label="Search orders">
        <button class="btn btn-outline" type="submit">Search</button>
      </form>
      <select class="select" id="status" style="width:auto" aria-label="Status">
        <option value="">All statuses</option>
        ${Object.entries(ORDER_STATUSES).map(([k, v]) => `<option value="${k}" ${status === k ? "selected" : ""}>${esc(v)}</option>`).join("")}
      </select>
    </div>
    <section class="card"><div id="rows"><div class="loading">Loading orders…</div></div><div id="more" class="pagination" hidden></div></section>`;

  const go = (s, query) => ctx.navigate(`orders?${new URLSearchParams({ ...(s ? { status: s } : {}), ...(query ? { q: query } : {}) })}`);
  el.querySelector("#status").addEventListener("change", e => go(e.target.value, q));
  el.querySelector("#search-form").addEventListener("submit", e => { e.preventDefault(); go(status, e.target.elements.q.value.trim()); });

  const items = [];
  const load = async before => {
    try {
      const params = new URLSearchParams({ limit: "25", ...(status ? { status } : {}), ...(q ? { q } : {}), ...(before ? { before } : {}) });
      const data = await api.get(`/admin/orders?${params}`);
      if (!ctx.isCurrent()) return;
      items.push(...data.items);
      draw(data.next);
    } catch (error) {
      el.querySelector("#rows").innerHTML = errorState(error, () => render(el, ctx));
    }
  };

  const draw = next => {
    el.querySelector("#rows").innerHTML = items.length ? `
      <div class="table-wrap"><table class="table responsive">
        <thead><tr><th>Order</th><th>Customer</th><th>Items</th><th class="right">Total</th><th>Status</th><th>Invoice</th><th>Date</th></tr></thead>
        <tbody>${items.map(o => `
          <tr class="clickable" data-id="${esc(o.id)}">
            <td class="cell-main"><a class="name" href="#/orders/${esc(o.id)}">${esc(o.orderNo)}</a> <span class="muted small">${o.source === "web" ? "Website" : "Admin"}</span></td>
            <td data-label="Customer">${esc(o.customer?.name)}<div class="muted small">${esc(o.customer?.business || phoneDisplay(o.customer?.phone))}</div></td>
            <td data-label="Items" class="num">${o.totals?.itemCount ?? ""}</td>
            <td data-label="Total" class="right num">${o.totals?.grandTotal === null ? '<span class="muted">Price pending</span>' : money(o.totals?.grandTotal)}</td>
            <td data-label="Status">${orderBadge(o.status)}</td>
            <td data-label="Invoice">${o.invoiceNo ? esc(o.invoiceNo) : '<span class="muted">—</span>'}</td>
            <td data-label="Date" class="nowrap">${date(o.createdAt, true)}</td>
          </tr>`).join("")}
        </tbody></table></div>` : `<div class="empty"><h3>No orders found</h3><p>${q || status ? "Try a different search or status." : "Orders from the website and orders you create appear here."}</p></div>`;
    const more = el.querySelector("#more");
    more.hidden = !next;
    more.innerHTML = next ? `<span class="muted">${items.length} shown</span><button class="btn btn-outline btn-sm" type="button" id="load-more">Load more</button>` : "";
    el.querySelector("#load-more")?.addEventListener("click", e => { setBusy(e.currentTarget, true); load(next); });
  };

  el.querySelector("#rows").addEventListener("click", e => {
    const row = e.target.closest("tr[data-id]");
    if (row && !e.target.closest("a")) ctx.navigate(`orders/${row.dataset.id}`);
  });
  load();
}

/* =========================================================
   LINE EDITOR (new orders and pending orders)
========================================================= */

function lineEditor(container, products, initial, { onChange } = {}) {
  const lines = initial.map(l => ({ ...l }));
  const bySku = new Map(products.map(p => [p.sku, p]));

  const draw = () => {
    container.innerHTML = `
      <div class="line-edit muted small" style="font-weight:700"><span>Product</span><span>Qty</span><span>Unit price (₹)</span><span>GST</span><span></span></div>
      ${lines.map((l, i) => {
        const p = bySku.get(l.sku);
        return `
          <div class="line-edit" data-i="${i}">
            <div style="min-width:0"><strong style="display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(p?.name || l.name || l.sku)}</strong>
              <span class="muted small">${esc(l.sku)}${p ? ` · ${p.trackStock ? `${p.availableQty} available` : "stock not counted"} · catalogue ${p.effectivePrice === null ? "price on request" : money(p.effectivePrice)}` : ""}${p && p.minQty > 1 ? ` · min ${p.minQty}` : ""}</span></div>
            <input class="input" type="number" min="1" step="1" value="${l.qty}" data-k="qty" aria-label="Quantity for ${esc(l.sku)}">
            <input class="input" inputmode="decimal" value="${esc(l.priceText ?? toRupeesInput(l.unitPrice))}" placeholder="${p?.effectivePrice !== null && p?.effectivePrice !== undefined ? toRupeesInput(p.effectivePrice) : "Required"}" data-k="price" aria-label="Unit price for ${esc(l.sku)}">
            <select class="select" data-k="gst" aria-label="GST rate for ${esc(l.sku)}"><option value="">Default</option>${GST_RATES.map(r => `<option value="${r}" ${String(l.gstRate ?? "") === String(r) ? "selected" : ""}>${r}%</option>`).join("")}</select>
            <button class="btn btn-ghost btn-icon" type="button" data-remove aria-label="Remove ${esc(l.sku)}">✕</button>
          </div>`;
      }).join("") || '<p class="muted">No products added yet.</p>'}
      <div style="margin-top:12px">
        <label class="label" for="picker-q">Add product</label>
        <input class="input" id="picker-q" placeholder="Search by name or SKU" autocomplete="off">
        <div class="picker-results" id="picker-results" hidden></div>
      </div>`;

    const picker = container.querySelector("#picker-q");
    const results = container.querySelector("#picker-results");
    picker.addEventListener("input", () => {
      const q = picker.value.trim().toLowerCase();
      const matches = q ? products.filter(p => p.status === "active" && `${p.sku} ${p.name}`.toLowerCase().includes(q)).slice(0, 12) : [];
      results.hidden = !matches.length;
      results.innerHTML = matches.map(p => `<button type="button" data-pick="${esc(p.sku)}"><img src="${esc(p.images[0] || "/images/placeholder.svg")}" alt=""><span style="flex:1"><strong>${esc(p.name)}</strong><br><span class="muted small">${esc(p.sku)} · ${p.effectivePrice === null ? "price on request" : money(p.effectivePrice)} · ${esc(p.availability.replace(/_/g, " "))}</span></span></button>`).join("");
    });
    results.addEventListener("click", e => {
      const pick = e.target.closest("[data-pick]");
      if (!pick) return;
      const p = bySku.get(pick.dataset.pick);
      const existing = lines.find(l => l.sku === p.sku);
      if (existing) existing.qty += p.minQty || 1;
      else lines.push({ sku: p.sku, qty: p.minQty || 1, unitPrice: null, gstRate: null });
      draw();
      onChange?.();
      container.querySelector("#picker-q").focus();
    });
  };

  container.addEventListener("input", e => {
    const row = e.target.closest("[data-i]");
    if (!row) return;
    const l = lines[Number(row.dataset.i)];
    if (e.target.dataset.k === "qty") l.qty = Number(e.target.value);
    if (e.target.dataset.k === "price") l.priceText = e.target.value;
    onChange?.();
  });
  container.addEventListener("change", e => {
    const row = e.target.closest("[data-i]");
    if (row && e.target.dataset.k === "gst") { lines[Number(row.dataset.i)].gstRate = e.target.value === "" ? null : Number(e.target.value); onChange?.(); }
  });
  container.addEventListener("click", e => {
    if (!e.target.closest("[data-remove]")) return;
    lines.splice(Number(e.target.closest("[data-i]").dataset.i), 1);
    draw();
    onChange?.();
  });

  draw();

  return {
    // Returns API items or throws a readable error.
    items() {
      if (!lines.length) throw new Error("Add at least one product.");
      return lines.map(l => {
        if (!Number.isInteger(l.qty) || l.qty < 1) throw new Error(`Quantity for ${l.sku} must be a whole number of at least 1.`);
        const text = l.priceText ?? toRupeesInput(l.unitPrice);
        const unitPrice = text === "" ? null : fromRupeesInput(text);
        if (Number.isNaN(unitPrice)) throw new Error(`Price for ${l.sku} is not a valid amount.`);
        return { sku: l.sku, qty: l.qty, ...(unitPrice !== null ? { unitPrice } : {}), ...(l.gstRate !== null && l.gstRate !== undefined ? { gstRate: l.gstRate } : {}) };
      });
    }
  };
}

function stateOptions(value) {
  return [["", "Not set"], ...INDIAN_STATES.map(([c, n]) => [c, `${n} (${c})`])];
}

/* =========================================================
   NEW ORDER
========================================================= */

async function renderNew(el, ctx) {
  let products;
  const customerId = ctx.query.get("customer");
  let customer = null;
  try {
    [products, customer] = await Promise.all([
      api.get("/admin/products"),
      customerId ? api.get(`/admin/customers/${encodeURIComponent(customerId)}`).then(r => r.customer) : null
    ]);
  } catch (error) {
    el.innerHTML = errorState(error, () => render(el, ctx));
    return;
  }
  if (!ctx.isCurrent()) return;
  const c = customer || {};

  el.innerHTML = `
    <div class="page-head"><div><a href="#/orders" class="muted small">← Orders</a><h1>New order</h1><p>Prices you enter here override catalogue prices for this order only.</p></div></div>
    <form id="new-order" novalidate>
      <div class="detail-grid">
        <div class="grid">
          <section class="card card-pad"><h2>Products</h2><div id="lines"></div></section>
          <section class="card card-pad"><h2>Notes</h2>${field({ name: "notes", label: "Order notes", type: "textarea", full: true, attrs: 'maxlength="1000" rows="3"' })}</section>
        </div>
        <div class="grid">
          <section class="card card-pad">
            <h2>Customer</h2>
            <div class="field" style="margin-bottom:12px">
              <label for="cust-search">Find existing customer</label>
              <input class="input" id="cust-search" placeholder="Name, business or phone" autocomplete="off">
              <div class="picker-results" id="cust-results" hidden></div>
            </div>
            <div class="form-grid" id="cust-fields">
              ${field({ name: "customer.name", label: "Name", value: c.name || "", required: true, full: true })}
              ${field({ name: "customer.phone", label: "Mobile number", value: c.phone ? c.phone.replace(/^91/, "") : "", required: true, full: true, attrs: 'inputmode="tel"' })}
              ${field({ name: "customer.business", label: "Business name", value: c.business || "", full: true })}
              ${field({ name: "customer.email", label: "Email", value: c.email || "", type: "email", full: true })}
              ${field({ name: "customer.gstin", label: "GSTIN", value: c.gstin || "", full: true, attrs: 'style="text-transform:uppercase" maxlength="15"' })}
              ${selectField({ name: "customer.stateCode", label: "State", value: c.stateCode || "", options: stateOptions(), full: true, required: false })}
              ${field({ name: "customer.billingAddress", label: "Billing address", value: c.billingAddress || "", type: "textarea", full: true, attrs: 'rows="2"' })}
              ${field({ name: "customer.shippingAddress", label: "Shipping address", value: c.shippingAddress || "", type: "textarea", full: true, attrs: 'rows="2"' })}
            </div>
          </section>
          <div class="card card-pad" style="display:grid;gap:8px">
            <div class="notice error" id="form-error" hidden></div>
            <button class="btn btn-primary btn-lg btn-block" type="submit" id="create-btn">Create order</button>
            <span class="muted small">The order is created as “Pending confirmation”. Confirm it to reserve stock.</span>
          </div>
        </div>
      </div>
    </form>`;

  const editor = lineEditor(el.querySelector("#lines"), products, []);
  const form = el.querySelector("#new-order");

  const search = el.querySelector("#cust-search");
  const results = el.querySelector("#cust-results");
  let timer;
  search.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const q = search.value.trim();
      if (q.length < 2) { results.hidden = true; return; }
      try {
        const list = (await api.get(`/admin/customers?q=${encodeURIComponent(q)}`)).slice(0, 8);
        results.hidden = !list.length;
        results.innerHTML = list.map(x => `<button type="button" data-cust="${esc(x.id)}"><span><strong>${esc(x.name)}</strong>${x.business ? ` · ${esc(x.business)}` : ""}<br><span class="muted small">${esc(phoneDisplay(x.phone))}</span></span></button>`).join("");
        results.onclick = e => {
          const pick = e.target.closest("[data-cust]");
          if (!pick) return;
          const x = list.find(i => i.id === pick.dataset.cust);
          const set = (k, v) => { form.elements[`customer.${k}`].value = v || ""; };
          set("name", x.name); set("phone", x.phone.replace(/^91/, "")); set("business", x.business); set("email", x.email);
          set("gstin", x.gstin); set("stateCode", x.stateCode); set("billingAddress", x.billingAddress); set("shippingAddress", x.shippingAddress);
          results.hidden = true;
          search.value = "";
          toast(`Using ${x.name}'s saved details.`);
        };
      } catch (error) { toastError(error); }
    }, 250);
  });

  form.addEventListener("submit", async e => {
    e.preventDefault();
    const errorBox = el.querySelector("#form-error");
    errorBox.hidden = true;
    let items;
    try { items = editor.items(); } catch (error) { errorBox.textContent = error.message; errorBox.hidden = false; return; }
    const f = form.elements;
    const customerBody = {};
    for (const k of ["name", "phone", "business", "email", "gstin", "stateCode", "billingAddress", "shippingAddress"]) customerBody[k] = f[`customer.${k}`].value;
    const button = el.querySelector("#create-btn");
    setBusy(button, true);
    try {
      const order = await api.post("/admin/orders", { customer: customerBody, items, notes: f.notes.value, placeOfSupply: customerBody.stateCode });
      toast(`Order ${order.orderNo} created.`, "success");
      refreshPendingCount();
      ctx.navigate(`orders/${order.id}`);
    } catch (error) {
      showFormErrors(form, error);
      errorBox.textContent = error.message;
      errorBox.hidden = false;
      setBusy(button, false);
    }
  });
}

/* =========================================================
   DETAIL
========================================================= */

const NEXT_ACTIONS = {
  confirmed: ["Confirm order", "btn-primary", "Reserves stock for tracked products. Prices are locked."],
  processing: ["Start processing", "btn-outline", ""],
  dispatched: ["Mark dispatched", "btn-primary", "Deducts reserved stock. A dispatched order cannot be cancelled."],
  completed: ["Mark completed", "btn-primary", ""],
  cancelled: ["Cancel order", "btn-danger", "Releases any reserved stock."]
};

async function renderDetail(el, ctx, id) {
  let order;
  try {
    order = await api.get(`/admin/orders/${encodeURIComponent(id)}`);
  } catch (error) {
    el.innerHTML = errorState(error, () => render(el, ctx));
    return;
  }
  if (!ctx.isCurrent()) return;

  const t = order.totals || {};
  const c = order.customer || {};
  const pending = order.status === "pending";
  const flow = ["pending", "confirmed", "processing", "dispatched", "completed"];
  const currentIndex = flow.indexOf(order.status);
  const activeInvoice = order.invoices.find(i => i.status === "issued");
  const reload = () => render(el, ctx);
  const waCustomer = `https://wa.me/${encodeURIComponent(c.phone || "")}?text=${encodeURIComponent(`Hello ${c.name},\n\nRegarding your order ${order.orderNo} with ONE STOP SOLUTION (OSS):\n\n`)}`;

  el.innerHTML = `
    <div class="page-head">
      <div><a href="#/orders" class="muted small">← Orders</a><h1>Order ${esc(order.orderNo)}</h1><p>${orderBadge(order.status)} · ${order.source === "web" ? "Website order" : "Created by admin"} · ${date(order.createdAt, true)}</p></div>
      <div class="page-actions" id="actions">
        ${(ORDER_TRANSITIONS[order.status] || []).map(s => `<button class="btn ${NEXT_ACTIONS[s][1]}" type="button" data-status="${s}">${NEXT_ACTIONS[s][0]}</button>`).join("")}
      </div>
    </div>

    ${order.status !== "cancelled" ? `<div class="status-steps" style="margin-bottom:16px">${flow.map((s, i) => `<span class="${i < currentIndex ? "done" : i === currentIndex ? "current" : ""}">${esc(ORDER_STATUSES[s])}</span>`).join("")}</div>` : `<div class="notice error" style="margin-bottom:16px">Cancelled${order.cancelReason ? `: ${esc(order.cancelReason)}` : ""}</div>`}

    ${pending && !t.priced ? '<div class="notice warn" style="margin-bottom:16px">Some items have no price. Click <strong>Edit items & prices</strong> to set prices before confirming.</div>' : ""}

    <div class="detail-grid">
      <div class="grid">
        <section class="card">
          <div class="card-head"><h2>Items</h2>${pending ? '<button class="btn btn-outline btn-sm" type="button" id="edit-items">Edit items & prices</button>' : ""}</div>
          <div class="table-wrap"><table class="table responsive">
            <thead><tr><th>Product</th><th class="right">Qty</th><th class="right">Unit price</th><th class="right">Discount</th>${order.taxSnapshot?.mode === "gst" ? '<th class="right">GST</th>' : ""}<th class="right">Total</th><th>Stock</th></tr></thead>
            <tbody>${order.items.map(i => `
              <tr>
                <td class="cell-main"><div class="cell-product"><img class="thumb" src="${esc(i.image || "/images/placeholder.svg")}" alt=""><div><span class="name">${esc(i.name)}</span><div class="muted small">${esc(i.sku)}${i.priceSource === "admin" ? " · custom price" : ""}</div></div></div></td>
                <td data-label="Qty" class="right num">${i.qty} ${esc(i.unit || "")}</td>
                <td data-label="Unit price" class="right num">${i.unitPrice === null ? '<span class="badge amber">Not set</span>' : money(i.unitPrice)}</td>
                <td data-label="Discount" class="right num">${i.discount ? `-${money(i.discount)}` : "—"}</td>
                ${order.taxSnapshot?.mode === "gst" ? `<td data-label="GST" class="right num">${i.gstRate ?? 0}%</td>` : ""}
                <td data-label="Total" class="right num"><strong>${money(i.total)}</strong></td>
                <td data-label="Stock" class="small">${i.reservedQty ? `<span class="badge blue">${i.reservedQty} reserved</span>` : i.deductedQty ? `<span class="badge green">${i.deductedQty} dispatched</span>` : '<span class="muted">—</span>'}</td>
              </tr>`).join("")}
            </tbody></table></div>
          <div style="padding:14px 18px;border-top:1px solid var(--line);display:flex;justify-content:flex-end">
            <dl class="totals" style="min-width:260px">
              <div><dt>Subtotal</dt><dd>${money(t.gross)}</dd></div>
              ${t.discount ? `<div><dt>Discount</dt><dd>-${money(t.discount)}</dd></div>` : ""}
              ${order.taxSnapshot?.mode === "gst" ? `<div><dt>Taxable</dt><dd>${money(t.taxable)}</dd></div>${t.cgst ? `<div><dt>CGST</dt><dd>${money(t.cgst)}</dd></div><div><dt>SGST</dt><dd>${money(t.sgst)}</dd></div>` : ""}${t.igst ? `<div><dt>IGST</dt><dd>${money(t.igst)}</dd></div>` : ""}` : ""}
              ${t.roundOff ? `<div><dt>Round off</dt><dd>${money(t.roundOff)}</dd></div>` : ""}
              <div class="grand"><dt>Total</dt><dd>${t.grandTotal === null ? "Prices pending" : money(t.grandTotal)}</dd></div>
            </dl>
          </div>
        </section>

        <section class="card card-pad">
          <h2>Invoice</h2>
          ${activeInvoice
            ? `<p style="margin-top:0">Invoice <strong>${esc(activeInvoice.invoiceNo)}</strong> issued ${date(activeInvoice.issuedAt)}.</p><a class="btn btn-primary" href="#/invoices/${esc(activeInvoice.id)}">Open invoice & share</a>`
            : ["confirmed", "processing", "dispatched", "completed"].includes(order.status)
              ? `<p style="margin-top:0" class="muted">No invoice yet. Preview it first; the invoice number is assigned when you issue it.</p><button class="btn btn-primary" type="button" id="preview-invoice">Preview & issue invoice</button>`
              : `<p class="muted" style="margin:0">${pending ? "Confirm the order to issue an invoice. A pending order is a quotation, not an invoice." : "This order cannot be invoiced."}</p>`}
          ${order.invoices.filter(i => i.status === "cancelled").length ? `<p class="small muted" style="margin-bottom:0">Cancelled invoices: ${order.invoices.filter(i => i.status === "cancelled").map(i => `<a href="#/invoices/${esc(i.id)}">${esc(i.invoiceNo)}</a>`).join(", ")}</p>` : ""}
        </section>

        <section class="card card-pad">
          <h2>Notes</h2>
          ${order.notes ? `<p style="margin-top:0;white-space:pre-line"><strong>Customer notes:</strong> ${esc(order.notes)}</p>` : ""}
          <form id="notes-form" class="field"><label for="admin-notes">Internal notes (not shown to customer)</label><textarea class="textarea" id="admin-notes" name="adminNotes" maxlength="2000">${esc(order.adminNotes || "")}</textarea><div><button class="btn btn-outline btn-sm" type="submit">Save notes</button></div></form>
        </section>
      </div>

      <div class="grid">
        <section class="card card-pad">
          <h2>Customer</h2>
          <dl class="kv">
            <dt>Name</dt><dd><a href="#/customers/${esc(order.customerId)}">${esc(c.name)}</a></dd>
            ${c.business ? `<dt>Business</dt><dd>${esc(c.business)}</dd>` : ""}
            <dt>Phone</dt><dd>${esc(phoneDisplay(c.phone))}</dd>
            ${c.email ? `<dt>Email</dt><dd>${esc(c.email)}</dd>` : ""}
            ${c.gstin ? `<dt>GSTIN</dt><dd>${esc(c.gstin)}</dd>` : ""}
            <dt>Place of supply</dt><dd>${order.placeOfSupply ? `${esc(stateName(order.placeOfSupply))} (${esc(order.placeOfSupply)})` : '<span class="muted">Not set</span>'}</dd>
            ${c.billingAddress ? `<dt>Billing</dt><dd style="white-space:pre-line">${esc(c.billingAddress)}</dd>` : ""}
            ${c.shippingAddress ? `<dt>Shipping</dt><dd style="white-space:pre-line">${esc(c.shippingAddress)}</dd>` : ""}
          </dl>
          <a class="btn btn-wa btn-block" style="margin-top:14px" href="${waCustomer}" target="_blank" rel="noopener">${icons.whatsapp}Chat with customer</a>
        </section>
        <section class="card card-pad">
          <h2>History</h2>
          <ul class="timeline">${(order.statusHistory || []).map(h => `<li><span><strong>${esc(ORDER_STATUSES[h.status] || h.status)}</strong> · ${date(h.at, true)}<br><span class="muted small">${esc(h.by)}${h.note ? ` — ${esc(h.note)}` : ""}</span></span></li>`).join("")}</ul>
        </section>
      </div>
    </div>`;

  /* ---- status actions ---- */
  el.querySelector("#actions").addEventListener("click", async e => {
    const button = e.target.closest("[data-status]");
    if (!button) return;
    const status = button.dataset.status;
    const [label, , explain] = NEXT_ACTIONS[status];
    let note = "";
    if (status === "cancelled") {
      note = await confirmDialog({ title: `Cancel order ${esc(order.orderNo)}?`, message: explain, confirmText: "Cancel order", danger: true, input: { label: "Reason for cancelling", required: true, requiredMessage: "Please give a reason." } });
      if (note === false) return;
    } else {
      const ok = await confirmDialog({ title: `${label}?`, message: explain || `Order ${esc(order.orderNo)} will be marked “${esc(ORDER_STATUSES[status])}”.`, confirmText: label });
      if (!ok) return;
    }
    setBusy(button, true);
    try {
      await api.post(`/admin/orders/${encodeURIComponent(order.id)}/status`, { status, note });
      toast(`Order ${ORDER_STATUSES[status].toLowerCase()}.`, "success");
      refreshPendingCount();
      reload();
    } catch (error) {
      toastError(error);
      setBusy(button, false);
    }
  });

  /* ---- notes ---- */
  el.querySelector("#notes-form").addEventListener("submit", async e => {
    e.preventDefault();
    try { await api.patch(`/admin/orders/${encodeURIComponent(order.id)}`, { adminNotes: e.target.elements.adminNotes.value }); toast("Notes saved.", "success"); }
    catch (error) { toastError(error); }
  });

  /* ---- edit items ---- */
  el.querySelector("#edit-items")?.addEventListener("click", async () => {
    let products;
    try { products = await api.get("/admin/products"); } catch (error) { return toastError(error); }
    const modal = openModal({
      title: `Edit order ${order.orderNo}`,
      size: "wide",
      body: `<div id="edit-lines"></div>
        <div class="form-grid" style="margin-top:16px">${selectField({ name: "placeOfSupply", label: "Place of supply (for GST)", value: order.placeOfSupply || "", options: stateOptions(), required: false })}</div>
        <p class="muted small">Leave a price empty to use the catalogue price. Items without any price must be priced before confirming.</p>
        <div class="notice error" id="edit-error" hidden></div>`,
      foot: '<button class="btn btn-outline" type="button" data-close>Cancel</button><button class="btn btn-primary" type="button" id="edit-save">Save changes</button>'
    });
    const editor = lineEditor(modal.$("#edit-lines"), products, order.items.map(i => ({
      sku: i.sku, name: i.name, qty: i.qty,
      unitPrice: i.priceSource === "admin" ? i.unitPrice : null,
      gstRate: i.gstRate
    })));
    modal.$("#edit-save").addEventListener("click", async e => {
      const errorBox = modal.$("#edit-error");
      errorBox.hidden = true;
      let items;
      try { items = editor.items(); } catch (error) { errorBox.textContent = error.message; errorBox.hidden = false; return; }
      setBusy(e.currentTarget, true);
      try {
        await api.patch(`/admin/orders/${encodeURIComponent(order.id)}`, { items, placeOfSupply: modal.$('[name="placeOfSupply"]').value });
        toast("Order updated.", "success");
        modal.close();
        reload();
      } catch (error) {
        errorBox.textContent = error.message;
        errorBox.hidden = false;
        setBusy(e.currentTarget, false);
      }
    });
  });

  /* ---- invoice preview & issue ---- */
  el.querySelector("#preview-invoice")?.addEventListener("click", () => openInvoicePreview(order, ctx));
}

async function openInvoicePreview(order, ctx) {
  const modal = openModal({
    title: `Invoice preview — ${order.orderNo}`,
    size: "wide",
    body: `
      <div class="form-grid" style="margin-bottom:14px">${selectField({ name: "pos", label: "Place of supply", value: order.placeOfSupply || order.customer?.stateCode || "", options: stateOptions(), required: false, hint: "Required when GST is enabled. Determines CGST+SGST or IGST." })}</div>
      <div id="preview"><div class="loading">Preparing preview…</div></div>
      <div class="notice error" id="issue-error" hidden style="margin-top:12px"></div>`,
    foot: '<button class="btn btn-outline" type="button" data-close>Close</button><button class="btn btn-primary" type="button" id="issue-btn" disabled>Issue invoice</button>'
  });
  const pos = modal.$('[name="pos"]');
  const load = async () => {
    modal.$("#issue-btn").disabled = true;
    modal.$("#issue-error").hidden = true;
    try {
      const preview = await api.post(`/admin/orders/${encodeURIComponent(order.id)}/invoice-preview`, { placeOfSupply: pos.value });
      modal.$("#preview").innerHTML = invoiceHtml(preview);
      modal.$("#issue-btn").disabled = false;
    } catch (error) {
      modal.$("#preview").innerHTML = "";
      modal.$("#issue-error").textContent = error.message;
      modal.$("#issue-error").hidden = false;
    }
  };
  pos.addEventListener("change", load);
  load();

  modal.$("#issue-btn").addEventListener("click", async e => {
    const ok = await confirmDialog({ title: "Issue this invoice?", message: "An invoice number will be assigned and the invoice cannot be edited afterwards. Corrections require cancelling and re-issuing.", confirmText: "Issue invoice" });
    if (!ok) return;
    setBusy(e.currentTarget, true);
    try {
      const invoice = await api.post(`/admin/orders/${encodeURIComponent(order.id)}/invoice`, { placeOfSupply: pos.value });
      toast(`Invoice ${invoice.invoiceNo} issued.`, "success");
      modal.close();
      ctx.navigate(`invoices/${invoice.id}`);
    } catch (error) {
      modal.$("#issue-error").textContent = error.message;
      modal.$("#issue-error").hidden = false;
      setBusy(e.currentTarget, false);
    }
  });
}
