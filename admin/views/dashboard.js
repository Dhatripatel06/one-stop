/* Dashboard — all figures come from /api/admin/dashboard (persisted data). */

import { api } from "../api.js";
import { date, errorState, esc, money, orderBadge } from "../ui.js";

export async function render(el, ctx) {
  const from = ctx.query.get("from") || "";
  const to = ctx.query.get("to") || "";
  let data;
  try {
    data = await api.get(`/admin/dashboard?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
  } catch (error) {
    el.innerHTML = errorState(error, () => render(el, ctx));
    return;
  }
  if (!ctx.isCurrent()) return;
  const p = data.products;

  el.innerHTML = `
    <div class="page-head">
      <div><h1>Dashboard</h1><p>Live figures from your catalogue, orders and invoices.</p></div>
      <div class="page-actions">
        <a class="btn btn-outline" href="#/orders/new">+ New order</a>
        <a class="btn btn-primary" href="#/products/new">+ Add product</a>
      </div>
    </div>

    <div class="stats">
      <a class="stat ${data.orders.awaitingConfirmation ? "warn" : ""}" href="#/orders?status=pending"><div class="label">Awaiting confirmation</div><div class="value">${data.orders.awaitingConfirmation}</div><div class="hint">New orders to review</div></a>
      <a class="stat" href="#/orders?status=confirmed"><div class="label">Orders to fulfil</div><div class="value">${data.orders.toFulfil}</div><div class="hint">Confirmed or processing</div></a>
      <a class="stat" href="#/invoices"><div class="label">Sales (${esc(date(data.period.from))} – ${esc(date(data.period.to))})</div><div class="value">${money(data.sales.total)}</div><div class="hint">${data.sales.invoices} invoice${data.sales.invoices === 1 ? "" : "s"} issued</div></a>
      <a class="stat ${data.outstanding.total ? "warn" : ""}" href="#/invoices?paymentStatus=unpaid"><div class="label">Outstanding payments</div><div class="value">${money(data.outstanding.total)}</div><div class="hint">${data.outstanding.invoices} invoice${data.outstanding.invoices === 1 ? "" : "s"} with balance due</div></a>
    </div>

    <div class="stats">
      <a class="stat" href="#/products?status=active"><div class="label">Active products</div><div class="value">${p.active}</div></a>
      <a class="stat ${p.lowStock ? "warn" : ""}" href="#/inventory?filter=low"><div class="label">Low stock</div><div class="value">${p.lowStock}</div></a>
      <a class="stat ${p.outOfStock ? "danger" : ""}" href="#/inventory?filter=out"><div class="label">Out of stock</div><div class="value">${p.outOfStock}</div></a>
      <a class="stat" href="#/inventory?filter=untracked"><div class="label">Stock not counted</div><div class="value">${p.untracked}</div><div class="hint">Record initial stock to track</div></a>
      <a class="stat" href="#/products?filter=review"><div class="label">Needs review</div><div class="value">${p.needsReview}</div><div class="hint">${p.unpriced} without a price${p.missingImages ? ` · ${p.missingImages} without a photo` : ""}</div></a>
    </div>

    <form class="card card-pad toolbar" id="period-form" style="margin-bottom:16px">
      <strong style="margin-right:auto">Sales period</strong>
      <label class="sr-only" for="from">From</label><input class="input" type="date" id="from" value="${esc(data.period.from)}" style="width:auto">
      <span class="muted">to</span>
      <label class="sr-only" for="to">To</label><input class="input" type="date" id="to" value="${esc(data.period.to)}" style="width:auto">
      <button class="btn btn-outline" type="submit">Apply</button>
    </form>

    <div class="grid grid-3">
      <section class="card">
        <div class="card-head"><h2>Recent orders</h2><a href="#/orders" class="btn btn-ghost btn-sm">View all</a></div>
        ${data.recentOrders.length ? `
          <div class="table-wrap"><table class="table responsive"><thead><tr><th>Order</th><th>Customer</th><th>Status</th><th class="right">Total</th><th>Date</th></tr></thead><tbody>
          ${data.recentOrders.map(o => `
            <tr class="clickable" data-href="#/orders/${esc(o.id)}">
              <td class="cell-main"><a href="#/orders/${esc(o.id)}" class="name">${esc(o.orderNo)}</a></td>
              <td data-label="Customer">${esc(o.customer)}</td>
              <td data-label="Status">${orderBadge(o.status)}</td>
              <td data-label="Total" class="right num">${o.grandTotal === null ? '<span class="muted">Price pending</span>' : money(o.grandTotal)}</td>
              <td data-label="Date" class="nowrap">${date(o.createdAt, true)}</td>
            </tr>`).join("")}
          </tbody></table></div>` : `<div class="empty"><h3>No orders yet</h3><p>Orders from the website and orders you create appear here.</p></div>`}
      </section>

      <section class="card">
        <div class="card-head"><h2>Stock alerts</h2><a href="#/inventory" class="btn btn-ghost btn-sm">Inventory</a></div>
        ${[...p.outOfStockItems.map(i => ({ ...i, kind: "out" })), ...p.lowStockItems.map(i => ({ ...i, kind: "low" }))].map(i => `
          <a href="#/inventory/${esc(i.id)}" style="display:flex;gap:10px;align-items:center;padding:10px 18px;border-bottom:1px solid var(--line);text-decoration:none;color:inherit">
            <img src="${esc(i.image || "/images/placeholder.svg")}" alt="" style="width:36px;height:36px;object-fit:contain">
            <span style="flex:1;min-width:0"><strong style="display:block;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(i.name)}</strong><span class="muted small">${esc(i.sku)}</span></span>
            <span class="badge ${i.kind === "out" ? "red" : "amber"}">${i.kind === "out" ? "Out" : `${i.available} left`}</span>
          </a>`).join("") || `<div class="empty"><p>${p.untracked === p.active ? "Stock tracking starts once you record initial stock counts in Inventory." : "No stock alerts."}</p></div>`}
      </section>
    </div>`;

  el.querySelector("#period-form").addEventListener("submit", event => {
    event.preventDefault();
    ctx.navigate(`dashboard?from=${el.querySelector("#from").value}&to=${el.querySelector("#to").value}`);
  });
  el.querySelectorAll("tr[data-href]").forEach(row => row.addEventListener("click", event => {
    if (!event.target.closest("a")) location.hash = row.dataset.href;
  }));
}
