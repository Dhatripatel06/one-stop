/* Customers — search, history, balances, edit, reorder. */

import { api } from "../api.js";
import { date, errorState, esc, field, icons, money, openModal, orderBadge, paymentBadge, phoneDisplay, selectField, setBusy, showFormErrors, toast } from "../ui.js";
import { INDIAN_STATES } from "../../shared/pricing.js";

export async function render(el, ctx) {
  const [id] = ctx.params;
  return id ? renderDetail(el, ctx, id) : renderList(el, ctx);
}

async function renderList(el, ctx) {
  let customers;
  try { customers = await api.get("/admin/customers"); }
  catch (error) { el.innerHTML = errorState(error, () => render(el, ctx)); return; }
  if (!ctx.isCurrent()) return;
  let q = "";

  el.innerHTML = `
    <div class="page-head"><div><h1>Customers</h1><p>One record per phone number. Created automatically from orders.</p></div></div>
    <div class="toolbar"><input class="input grow" type="search" id="q" placeholder="Search name, business, phone, email or GSTIN" aria-label="Search customers"></div>
    <section class="card"><div id="rows"></div></section>`;

  const draw = () => {
    const query = q.toLowerCase();
    const digits = q.replace(/\D/g, "");
    const list = customers.filter(c => !query ||
      [c.name, c.business, c.email, c.gstin].some(v => String(v || "").toLowerCase().includes(query)) ||
      (digits.length >= 3 && c.phone.includes(digits)));
    el.querySelector("#rows").innerHTML = list.length ? `
      <div class="table-wrap"><table class="table responsive">
        <thead><tr><th>Customer</th><th>Phone</th><th class="right">Orders</th><th class="right">Billed</th><th class="right">Outstanding</th><th>Last order</th></tr></thead>
        <tbody>${list.map(c => `
          <tr class="clickable" data-id="${esc(c.id)}">
            <td class="cell-main"><a class="name" href="#/customers/${esc(c.id)}">${esc(c.name)}</a>${c.business ? `<div class="muted small">${esc(c.business)}</div>` : ""}</td>
            <td data-label="Phone" class="nowrap">${esc(phoneDisplay(c.phone))}</td>
            <td data-label="Orders" class="right num">${c.orderCount || 0}</td>
            <td data-label="Billed" class="right num">${money(c.totalBilled || 0)}</td>
            <td data-label="Outstanding" class="right num">${c.outstanding > 0 ? `<span class="badge amber">${money(c.outstanding)}</span>` : money(0)}</td>
            <td data-label="Last order" class="nowrap">${date(c.lastOrderAt)}</td>
          </tr>`).join("")}
        </tbody></table></div>` : '<div class="empty"><h3>No customers found</h3><p>Customers are added when an order is placed.</p></div>';
  };
  el.querySelector("#q").addEventListener("input", e => { q = e.target.value.trim(); draw(); });
  el.querySelector("#rows").addEventListener("click", e => {
    const row = e.target.closest("tr[data-id]");
    if (row && !e.target.closest("a")) ctx.navigate(`customers/${row.dataset.id}`);
  });
  draw();
}

async function renderDetail(el, ctx, id) {
  let data;
  try { data = await api.get(`/admin/customers/${encodeURIComponent(id)}`); }
  catch (error) { el.innerHTML = errorState(error, () => render(el, ctx)); return; }
  if (!ctx.isCurrent()) return;
  const c = data.customer;

  el.innerHTML = `
    <div class="page-head">
      <div><a href="#/customers" class="muted small">← Customers</a><h1>${esc(c.name)}</h1><p>${esc(c.business || "")} ${esc(phoneDisplay(c.phone))}</p></div>
      <div class="page-actions">
        <a class="btn btn-wa" href="https://wa.me/${esc(c.phone)}" target="_blank" rel="noopener">${icons.whatsapp}WhatsApp</a>
        <button class="btn btn-outline" type="button" id="edit-btn">Edit details</button>
        <a class="btn btn-primary" href="#/orders/new?customer=${encodeURIComponent(c.id)}">+ New order for customer</a>
      </div>
    </div>
    <div class="stats">
      <div class="stat"><div class="label">Orders</div><div class="value">${c.orderCount || 0}</div></div>
      <div class="stat"><div class="label">Total billed</div><div class="value">${money(c.totalBilled || 0)}</div></div>
      <div class="stat"><div class="label">Paid</div><div class="value">${money(c.totalPaid || 0)}</div></div>
      <div class="stat ${c.outstanding > 0 ? "warn" : ""}"><div class="label">Outstanding</div><div class="value">${money(c.outstanding)}</div></div>
    </div>
    <div class="detail-grid">
      <div class="grid">
        <section class="card"><div class="card-head"><h2>Orders</h2></div>
          ${data.orders.length ? `<div class="table-wrap"><table class="table responsive"><thead><tr><th>Order</th><th>Status</th><th class="right">Total</th><th>Invoice</th><th>Date</th></tr></thead><tbody>
          ${data.orders.map(o => `<tr><td class="cell-main"><a class="name" href="#/orders/${esc(o.id)}">${esc(o.orderNo)}</a></td><td data-label="Status">${orderBadge(o.status)}</td><td data-label="Total" class="right num">${o.grandTotal === null ? '<span class="muted">Price pending</span>' : money(o.grandTotal)}</td><td data-label="Invoice">${esc(o.invoiceNo || "—")}</td><td data-label="Date">${date(o.createdAt)}</td></tr>`).join("")}
          </tbody></table></div>` : '<div class="empty"><p>No orders.</p></div>'}
        </section>
        <section class="card"><div class="card-head"><h2>Invoices</h2></div>
          ${data.invoices.length ? `<div class="table-wrap"><table class="table responsive"><thead><tr><th>Invoice</th><th class="right">Total</th><th class="right">Balance</th><th>Payment</th><th>Date</th></tr></thead><tbody>
          ${data.invoices.map(i => `<tr><td class="cell-main"><a class="name" href="#/invoices/${esc(i.id)}">${esc(i.invoiceNo)}</a>${i.status === "cancelled" ? ' <span class="badge red">Cancelled</span>' : ""}</td><td data-label="Total" class="right num">${money(i.grandTotal)}</td><td data-label="Balance" class="right num">${i.status === "cancelled" ? "—" : money(i.balanceDue)}</td><td data-label="Payment">${i.status === "cancelled" ? "—" : paymentBadge(i.paymentStatus)}</td><td data-label="Date">${date(i.issuedAt)}</td></tr>`).join("")}
          </tbody></table></div>` : '<div class="empty"><p>No invoices.</p></div>'}
        </section>
      </div>
      <section class="card card-pad"><h2>Details</h2>
        <dl class="kv">
          <dt>Phone</dt><dd>${esc(phoneDisplay(c.phone))}</dd>
          <dt>Email</dt><dd>${esc(c.email || "—")}</dd>
          <dt>GSTIN</dt><dd>${esc(c.gstin || "—")}</dd>
          <dt>State</dt><dd>${esc(c.stateCode || "—")}</dd>
          <dt>Billing</dt><dd style="white-space:pre-line">${esc(c.billingAddress || "—")}</dd>
          <dt>Shipping</dt><dd style="white-space:pre-line">${esc(c.shippingAddress || "—")}</dd>
          <dt>Customer since</dt><dd>${date(c.createdAt)}</dd>
        </dl>
      </section>
    </div>`;

  el.querySelector("#edit-btn").addEventListener("click", () => {
    const modal = openModal({
      title: "Edit customer",
      body: `<form id="cust-form" novalidate><div class="form-grid">
        ${field({ name: "name", label: "Name", value: c.name, required: true })}
        ${field({ name: "business", label: "Business name", value: c.business || "" })}
        ${field({ name: "email", label: "Email", value: c.email || "", type: "email" })}
        ${field({ name: "gstin", label: "GSTIN", value: c.gstin || "", attrs: 'maxlength="15" style="text-transform:uppercase"' })}
        ${selectField({ name: "stateCode", label: "State", value: c.stateCode || "", required: false, options: [["", "Not set"], ...INDIAN_STATES.map(([code, n]) => [code, n])] })}
        <div></div>
        ${field({ name: "billingAddress", label: "Billing address", value: c.billingAddress || "", type: "textarea", full: true })}
        ${field({ name: "shippingAddress", label: "Shipping address", value: c.shippingAddress || "", type: "textarea", full: true })}
      </div><p class="muted small">The phone number identifies the customer and cannot be changed. Past orders and invoices keep the details they were created with.</p><div class="notice error" id="cust-error" hidden></div></form>`,
      foot: '<button class="btn btn-outline" type="button" data-close>Cancel</button><button class="btn btn-primary" type="submit" form="cust-form" id="cust-save">Save</button>'
    });
    modal.$("#cust-form").addEventListener("submit", async e => {
      e.preventDefault();
      const body = Object.fromEntries(new FormData(e.target));
      setBusy(modal.$("#cust-save"), true);
      try {
        await api.patch(`/admin/customers/${encodeURIComponent(c.id)}`, body);
        toast("Customer saved.", "success");
        modal.close();
        render(el, ctx);
      } catch (error) {
        showFormErrors(e.target, error);
        modal.$("#cust-error").textContent = error.message;
        modal.$("#cust-error").hidden = false;
        setBusy(modal.$("#cust-save"), false);
      }
    });
  });
}
