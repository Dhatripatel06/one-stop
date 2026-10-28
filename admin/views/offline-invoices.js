/* Offline Invoices — bill walk-in and phone customers directly, without a
   website order. The server re-reads products and recalculates every total;
   this screen only shows the server's figures. */

import { api } from "../api.js";
import {
  date, errorState, esc, field, icons, money, paymentBadge, phoneDisplay, selectField, setBusy, showFormErrors, toast, toastError
} from "../ui.js";
import { isValidPhone, normalizePhone } from "../../shared/constants.js";
import { lineEditor, stateOptions } from "./orders.js";
import { renderDetail } from "./invoices.js";

export async function render(el, ctx) {
  const [id] = ctx.params;
  if (id === "new") return renderNew(el, ctx);
  if (id) {
    const created = ctx.query.get("created") === "1";
    await renderDetail(el, ctx, id, {
      back: "offline-invoices",
      backLabel: "Offline Invoices",
      banner: created ? `
        <div class="notice success offline-created no-print">
          <span><strong>Invoice created and saved.</strong> Download the PDF or send it to the customer on WhatsApp. Nothing has been sent yet.</span>
          <span class="offline-created-actions">
            <button class="btn btn-wa btn-sm" type="button" data-proxy="#share-wa">${icons.whatsapp}Send on WhatsApp</button>
            <a class="btn btn-outline btn-sm" href="#/offline-invoices/new">${icons.plus}New invoice</a>
          </span>
        </div>` : ""
    });
    // The banner's WhatsApp button runs the same share flow as the card below.
    el.querySelector("[data-proxy]")?.addEventListener("click", e => el.querySelector(e.currentTarget.dataset.proxy)?.click());
    return;
  }
  return renderList(el, ctx);
}

/* =========================================================
   LIST
========================================================= */

const SHARE_SHORT = {
  ready: ["", "Not shared"],
  share_opened: ["amber", "WhatsApp opened"],
  sent_confirmed: ["green", "Marked sent"]
};

async function renderList(el, ctx) {
  const q = ctx.query.get("q") || "";
  el.innerHTML = `
    <div class="page-head">
      <div><h1>Offline Invoices</h1><p>Bill walk-in and phone customers directly. No website order or checkout needed.</p></div>
      <div class="page-actions"><a class="btn btn-primary btn-lg" href="#/offline-invoices/new">${icons.plus}New invoice</a></div>
    </div>
    <div class="toolbar">
      <form id="search-form" class="grow" style="display:flex;gap:8px">
        <input class="input" type="search" name="q" value="${esc(q)}" placeholder="Invoice number, customer name or phone" aria-label="Search offline invoices">
        <button class="btn btn-outline" type="submit">Search</button>
        ${q ? '<a class="btn btn-ghost" href="#/offline-invoices">Clear</a>' : ""}
      </form>
    </div>
    <section class="card"><div id="rows"><div class="loading">Loading…</div></div><div class="pagination" id="more" hidden></div></section>`;

  el.querySelector("#search-form").addEventListener("submit", e => {
    e.preventDefault();
    const value = e.target.elements.q.value.trim();
    ctx.navigate(`offline-invoices${value ? `?${new URLSearchParams({ q: value })}` : ""}`);
  });

  const items = [];
  const load = async before => {
    try {
      const data = await api.get(`/admin/offline-invoices?${new URLSearchParams({ limit: "25", ...(q ? { q } : {}), ...(before ? { before } : {}) })}`);
      if (!ctx.isCurrent()) return;
      items.push(...data.items);
      el.querySelector("#rows").innerHTML = items.length ? `
        <div class="table-wrap"><table class="table responsive">
          <thead><tr><th>Invoice</th><th>Customer</th><th class="right">Total</th><th class="right">Balance</th><th>Payment</th><th>WhatsApp</th><th>Date</th></tr></thead>
          <tbody>${items.map(i => {
            const [color, label] = SHARE_SHORT[i.share?.status] || SHARE_SHORT.ready;
            return `
            <tr class="clickable" data-id="${esc(i.id)}">
              <td class="cell-main"><a class="name" href="#/offline-invoices/${esc(i.id)}">${esc(i.invoiceNo)}</a>${i.status === "cancelled" ? ' <span class="badge red">Cancelled</span>' : ""}</td>
              <td data-label="Customer">${esc(i.customer?.name)}<div class="muted small">${esc(i.customer?.business || phoneDisplay(i.customer?.phone) || "No phone")}</div></td>
              <td data-label="Total" class="right num">${money(i.totals?.grandTotal)}</td>
              <td data-label="Balance" class="right num">${i.status === "cancelled" ? "—" : money(i.balanceDue)}</td>
              <td data-label="Payment">${i.status === "cancelled" ? "—" : paymentBadge(i.paymentStatus)}</td>
              <td data-label="WhatsApp"><span class="badge ${color}">${label}</span></td>
              <td data-label="Date" class="nowrap">${date(i.issuedAt, true)}</td>
            </tr>`;
          }).join("")}
          </tbody></table></div>` : `
        <div class="empty">
          <h3>${q ? "No offline invoices match your search" : "No offline invoices yet"}</h3>
          <p>${q ? "Search by invoice number (e.g. OSS/2026-27/0012), customer name or phone." : "Create an invoice for a walk-in customer in under a minute."}</p>
          ${q ? "" : `<a class="btn btn-primary" href="#/offline-invoices/new">${icons.plus}New invoice</a>`}
        </div>`;
      const more = el.querySelector("#more");
      more.hidden = !data.next;
      more.innerHTML = data.next ? `<span class="muted">${items.length} shown</span><button class="btn btn-outline btn-sm" type="button" id="load-more">Load more</button>` : "";
      el.querySelector("#load-more")?.addEventListener("click", e => { setBusy(e.currentTarget, true); load(data.next); });
    } catch (error) {
      el.querySelector("#rows").innerHTML = errorState(error, () => render(el, ctx));
    }
  };
  el.querySelector("#rows").addEventListener("click", e => {
    const row = e.target.closest("tr[data-id]");
    if (row && !e.target.closest("a")) ctx.navigate(`offline-invoices/${row.dataset.id}`);
  });
  load();
}

/* =========================================================
   NEW INVOICE
========================================================= */

const CUSTOMER_FIELDS = ["name", "phone", "email", "business", "gstin", "stateCode", "billingAddress", "shippingAddress"];

function requestId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, "0")).join("");
}

// Mirrors the server: 10-digit Indian numbers get 91, others need the country code.
function phoneState(value) {
  const raw = String(value || "").trim();
  if (!raw) return { ok: true, text: "Optional. Needed to send the invoice on WhatsApp." };
  const digits = normalizePhone(raw);
  return isValidPhone(digits)
    ? { ok: true, valid: true, text: `WhatsApp number: +${digits}` }
    : { ok: false, text: "Not a valid mobile number. Use 10 digits for India, or the full number with country code." };
}

async function renderNew(el, ctx) {
  const fromId = ctx.query.get("from");
  let products, source = null;
  try {
    [products, source] = await Promise.all([
      api.get("/admin/products"),
      fromId ? api.get(`/admin/invoices/${encodeURIComponent(fromId)}`) : null
    ]);
  } catch (error) {
    el.innerHTML = errorState(error, () => render(el, ctx));
    return;
  }
  if (!ctx.isCurrent()) return;
  // A corrected copy is only allowed from a cancelled offline invoice.
  const replaces = source && source.source === "offline" && source.status === "cancelled" ? source : null;
  const c = replaces?.customer || {};
  const initialLines = replaces ? replaces.lines.map(l => ({ sku: l.sku, qty: l.qty, unitPrice: l.unitPrice, gstRate: null })) : [];

  el.innerHTML = `
    <div class="page-head">
      <div><a href="#/offline-invoices" class="muted small">← Offline Invoices</a><h1>New offline invoice</h1>
        <p>${replaces ? `Corrected copy of cancelled invoice <strong>${esc(replaces.invoiceNo)}</strong>.` : "For walk-in and phone customers. Prices you type override the catalogue price for this invoice only."}</p></div>
    </div>
    <form id="offline-form" novalidate>
      <div class="detail-grid">
        <div class="grid">
          <section class="card card-pad"><h2>Products</h2><div id="lines"></div></section>
          <section class="card card-pad">
            <h2>Customer</h2>
            <div class="field" style="margin-bottom:12px">
              <label for="cust-search">Find a saved customer <span class="muted" style="font-weight:500">(optional)</span></label>
              <input class="input" id="cust-search" placeholder="Name, business or phone" autocomplete="off">
              <div class="picker-results" id="cust-results" hidden></div>
            </div>
            <div class="form-grid">
              ${field({ name: "customer.name", label: "Customer name", value: c.name || "", required: true, attrs: 'autocomplete="off" maxlength="100"' })}
              ${field({ name: "customer.phone", label: "Mobile number", value: c.phone ? `+${c.phone}` : "", attrs: 'inputmode="tel" autocomplete="off" placeholder="+91 98765 43210"', hint: '<span id="phone-state"></span>' })}
              ${field({ name: "customer.email", label: "Email", value: c.email || "", type: "email", attrs: 'autocomplete="off"' })}
              ${field({ name: "customer.business", label: "Business name", value: c.business || "" })}
              ${field({ name: "customer.billingAddress", label: "Billing address", value: c.billingAddress || "", type: "textarea", attrs: 'rows="2" maxlength="500"' })}
              ${field({ name: "customer.shippingAddress", label: "Shipping address", value: c.shippingAddress || "", type: "textarea", attrs: 'rows="2" maxlength="500"', hint: "Leave empty if it is the same as billing." })}
            </div>
            <details class="offline-more"${c.gstin || c.stateCode ? " open" : ""}>
              <summary>GST details</summary>
              <div class="form-grid" style="margin-top:12px">
                ${field({ name: "customer.gstin", label: "Customer GSTIN", value: c.gstin || "", attrs: 'style="text-transform:uppercase" maxlength="15"' })}
                ${selectField({ name: "customer.stateCode", label: "State (place of supply)", value: c.stateCode || replaces?.placeOfSupply || "", options: stateOptions(), required: false })}
              </div>
            </details>
          </section>
          <section class="card card-pad">${field({ name: "notes", label: "Note on invoice", type: "textarea", full: true, attrs: 'maxlength="1000" rows="2"' })}</section>
        </div>
        <div class="grid offline-side">
          <section class="card card-pad" aria-live="polite">
            <h2>Summary</h2>
            <div id="summary"><p class="muted small" style="margin:0">Add products to see the total.</p></div>
          </section>
          <div class="card card-pad" style="display:grid;gap:8px">
            <div class="notice error" id="form-error" hidden></div>
            <button class="btn btn-primary btn-lg btn-block" type="submit" id="create-btn">Create Invoice</button>
            <span class="muted small">Saves the invoice with the next invoice number. Stock is deducted for products whose stock is counted. You can download it or send it on WhatsApp next.</span>
          </div>
        </div>
      </div>
    </form>`;

  const form = el.querySelector("#offline-form");
  const f = form.elements;
  const summary = el.querySelector("#summary");
  const createBtn = el.querySelector("#create-btn");
  const errorBox = el.querySelector("#form-error");
  const id = requestId();
  let lastPreview = null;
  let previewSeq = 0;

  /* ---- live totals from the server ---- */
  const drawSummary = p => {
    const t = p.totals;
    const gst = p.taxMode === "gst";
    summary.innerHTML = `
      <dl class="totals">
        <div><dt>Items</dt><dd>${t.itemCount} · ${t.totalQty} units</dd></div>
        ${t.priced ? `<div><dt>Subtotal</dt><dd>${money(t.gross)}</dd></div>` : ""}
        ${t.discount ? `<div><dt>Discount</dt><dd>-${money(t.discount)}</dd></div>` : ""}
        ${gst && t.tax ? `<div><dt>GST</dt><dd>${money(t.tax)}</dd></div>` : ""}
        ${t.roundOff ? `<div><dt>Round off</dt><dd>${t.roundOff > 0 ? "+" : "-"}${money(Math.abs(t.roundOff))}</dd></div>` : ""}
        <div class="grand"><dt>Invoice total</dt><dd>${t.priced ? money(t.grandTotal) : "—"}</dd></div>
      </dl>
      ${p.missingPrices.length ? `<p class="notice warn" style="margin:12px 0 0">No catalogue price for ${p.missingPrices.map(esc).join(", ")}. Enter a unit price for ${p.missingPrices.length === 1 ? "it" : "them"} to continue.</p>` : ""}
      ${p.needsPlaceOfSupply ? '<p class="notice warn" style="margin:12px 0 0">GST is on: choose the customer\'s state under “GST details”.</p>' : ""}`;
  };

  const refresh = async () => {
    const seq = ++previewSeq;
    let items;
    try { items = editor.items(); } catch (error) {
      lastPreview = null;
      summary.innerHTML = `<p class="muted small" style="margin:0">${esc(error.message)}</p>`;
      return;
    }
    summary.classList.add("is-stale");
    try {
      const p = await api.post("/admin/offline-invoices/preview", { items, placeOfSupply: f["customer.stateCode"].value });
      if (seq !== previewSeq || !ctx.isCurrent()) return;
      lastPreview = p;
      drawSummary(p);
    } catch (error) {
      if (seq !== previewSeq) return;
      lastPreview = null;
      summary.innerHTML = `<p class="notice error" style="margin:0">${esc(error.message)}</p>`;
    }
    summary.classList.remove("is-stale");
  };
  let timer;
  const schedule = () => { clearTimeout(timer); timer = setTimeout(refresh, 300); };

  const editor = lineEditor(el.querySelector("#lines"), products, initialLines, { onChange: schedule });
  f["customer.stateCode"].addEventListener("change", schedule);
  if (initialLines.length) refresh();

  /* ---- phone validation ---- */
  const phoneHint = el.querySelector("#phone-state");
  const showPhone = () => {
    const state = phoneState(f["customer.phone"].value);
    phoneHint.textContent = state.text;
    phoneHint.className = state.ok ? (state.valid ? "ok" : "") : "bad";
    // Clear an earlier "invalid number" error as soon as the number is fixed.
    if (state.ok) {
      const error = form.querySelector('.error[data-for="customer.phone"]');
      if (error) error.textContent = "";
      error?.closest(".field")?.classList.remove("has-error");
    }
    return state.ok;
  };
  f["customer.phone"].addEventListener("input", showPhone);
  showPhone();

  /* ---- saved customers ---- */
  const search = el.querySelector("#cust-search");
  const results = el.querySelector("#cust-results");
  let searchTimer;
  search.addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(async () => {
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
          for (const key of CUSTOMER_FIELDS) f[`customer.${key}`].value = key === "phone" ? `+${x.phone}` : x[key] || "";
          if (x.gstin || x.stateCode) form.querySelector(".offline-more").open = true;
          results.hidden = true;
          search.value = "";
          showPhone();
          schedule();
          toast(`Using ${x.name}'s saved details.`);
        };
      } catch (error) { toastError(error); }
    }, 250);
  });

  /* ---- create ---- */
  form.addEventListener("submit", async e => {
    e.preventDefault();
    errorBox.hidden = true;
    const fail = message => { errorBox.textContent = message; errorBox.hidden = false; };
    let items;
    try { items = editor.items(); } catch (error) { return fail(error.message); }
    if (!f["customer.name"].value.trim()) {
      showFormErrors(form, { details: { fields: { "customer.name": "Enter the customer's name." } } });
      return fail("Enter the customer's name.");
    }
    if (!showPhone()) {
      showFormErrors(form, { details: { fields: { "customer.phone": "Enter a valid mobile number, or leave it empty." } } });
      return fail("Check the mobile number.");
    }
    if (lastPreview?.missingPrices.length) return fail(`Enter a unit price for ${lastPreview.missingPrices.join(", ")}.`);

    const customer = {};
    for (const key of CUSTOMER_FIELDS) customer[key] = f[`customer.${key}`].value;
    setBusy(createBtn, true);
    try {
      const inv = await api.post("/admin/offline-invoices", {
        requestId: id,
        customer,
        items,
        notes: f.notes.value,
        placeOfSupply: customer.stateCode,
        ...(replaces ? { replacesInvoiceId: replaces.id } : {})
      });
      toast(`Invoice ${inv.invoiceNo} created.`, "success");
      ctx.navigate(`offline-invoices/${encodeURIComponent(inv.id)}?created=1`);
    } catch (error) {
      showFormErrors(form, error);
      fail(error.message);
      setBusy(createBtn, false);
    }
  });
}
