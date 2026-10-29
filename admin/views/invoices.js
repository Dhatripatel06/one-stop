/* Invoices — list, preview, PDF, payments, cancellation, WhatsApp sharing.
   The detail view also serves offline (walk-in) invoices, which have no order. */

import { api } from "../api.js";
import {
  confirmDialog, date, downloadBlob, errorState, esc, field, fromRupeesInput, icons, money, openModal,
  paymentBadge, phoneDisplay, selectField, setBusy, showFormErrors, toRupeesInput, toast, toastError
} from "../ui.js";
import { amountInWords, stateName } from "../../shared/pricing.js";
import { INVOICE_THANK_YOU, PAYMENT_METHODS, balanceDueText, invoiceDate, invoiceTermsFor, isValidPhone, normalizePhone, separateShippingAddress } from "../../shared/constants.js";

export async function render(el, ctx) {
  const [id] = ctx.params;
  return id ? renderDetail(el, ctx, id) : renderList(el, ctx);
}

/* =========================================================
   INVOICE DOCUMENT (screen + print), mirrors the PDF layout
========================================================= */

export function invoiceHtml(inv) {
  const s = inv.seller || {};
  const c = inv.customer || {};
  const t = inv.totals || {};
  const gst = inv.taxSnapshot?.mode === "gst";
  const lines = inv.lines || [];
  const terms = invoiceTermsFor(inv);
  return `
    <article class="invoice-sheet">
      <div class="inv-top"></div>
      ${inv.status === "cancelled" ? `<p><span class="inv-stamp cancelled">CANCELLED</span> ${esc(inv.cancelReason || "")}</p>` : ""}
      ${inv.preview ? '<p><span class="inv-stamp preview">PREVIEW — not valid until issued</span></p>' : ""}
      <div class="inv-head">
        <div class="inv-seller">
          <img src="${esc(s.logo || "538820.jpg")}" alt="">
          <div>
            <h2>${esc(s.businessName)}</h2>
            <div class="tag">${esc(s.tagline)}</div>
            ${s.address ? `<p>${esc(s.address)}</p>` : ""}
            <p>${[s.phone && `Phone/WhatsApp: ${esc(s.phone)}`, s.email && esc(s.email)].filter(Boolean).join(" · ")}</p>
            ${s.instagram ? `<p>Instagram: @${esc(s.instagram)}</p>` : ""}
            ${s.gstin ? `<p>GSTIN: ${esc(s.gstin)}${s.stateCode ? ` · State: ${esc(stateName(s.stateCode))} (${esc(s.stateCode)})` : ""}</p>` : ""}
          </div>
        </div>
        <div class="inv-title">
          <h1>${esc(inv.documentTitle)}</h1>
          <dl><dt>Invoice No.</dt><dd>${esc(inv.invoiceNo)}</dd><dt>Invoice date</dt><dd>${invoiceDate(inv.issuedAt)}</dd>${inv.orderNo ? `<dt>Order No.</dt><dd>${esc(inv.orderNo)}</dd>` : ""}</dl>
        </div>
      </div>
      <div class="inv-parties">
        <div>
          <h3>Bill to</h3>
          <p><strong>${esc(c.name)}</strong></p>
          ${c.business ? `<p>${esc(c.business)}</p>` : ""}
          ${c.billingAddress ? `<p style="white-space:pre-line">${esc(c.billingAddress)}</p>` : ""}
          ${c.phone ? `<p>Phone: ${esc(phoneDisplay(c.phone))}</p>` : ""}
          ${c.email ? `<p>${esc(c.email)}</p>` : ""}
          ${c.gstin ? `<p>GSTIN: ${esc(c.gstin)}</p>` : ""}
        </div>
        <div>
          <h3>Ship to</h3>
          <p style="white-space:pre-line">${esc(separateShippingAddress(c) || "Same as billing address")}</p>
          ${inv.placeOfSupply ? `<p>Place of supply: ${esc(stateName(inv.placeOfSupply))} (${esc(inv.placeOfSupply)})</p>` : ""}
        </div>
      </div>
      <table class="inv-table">
        <thead><tr><th>#</th><th>Particulars</th><th>Rate</th><th>Qnt</th>${gst ? "<th>Taxable</th><th>GST</th><th>Tax</th>" : "<th>Discount</th>"}<th>Amount</th></tr></thead>
        <tbody>${lines.map((l, i) => `
          <tr>
            <td>${i + 1}</td>
            <td><strong>${esc(l.name)}</strong><div class="sub">${esc(l.sku)}${l.hsn ? ` · HSN ${esc(l.hsn)}` : ""}${gst && l.discount ? ` · Disc. ${money(l.discount)}` : ""}</div></td>
            <td>${money(!gst && l.listPrice > l.unitPrice ? l.listPrice : l.unitPrice)}</td>
            <td>${l.qty} ${esc(l.unit || "")}</td>
            ${gst ? `<td>${money(l.taxable)}</td><td>${l.gstRate ?? 0}%</td><td>${money(l.taxAmount)}</td>` : `<td>${l.discount ? `-${money(l.discount)}` : "—"}</td>`}
            <td><strong>${money(l.total)}</strong></td>
          </tr>`).join("")}
        </tbody>
      </table>
      <div class="inv-bottom">
        <div>
          <h3 class="small muted" style="text-transform:uppercase;letter-spacing:.08em">Amount in words</h3>
          <p style="margin:2px 0 12px">${esc(amountInWords(t.grandTotal || 0))}</p>
          ${gst && t.taxBreakdown?.length ? `
            <table class="table" style="font-size:12px"><thead><tr><th>Rate</th><th class="right">Taxable</th>${inv.taxSnapshot.interState ? '<th class="right">IGST</th>' : '<th class="right">CGST</th><th class="right">SGST</th>'}</tr></thead>
            <tbody>${t.taxBreakdown.map(r => `<tr><td>${r.rate}%</td><td class="right">${money(r.taxable)}</td>${inv.taxSnapshot.interState ? `<td class="right">${money(r.igst)}</td>` : `<td class="right">${money(r.cgst)}</td><td class="right">${money(r.sgst)}</td>`}</tr>`).join("")}</tbody></table>
            ${inv.taxSnapshot.pricesIncludeTax ? '<p class="small muted">Prices are inclusive of GST.</p>' : ""}` : ""}
        </div>
        <dl class="totals">
          <div><dt>Subtotal</dt><dd>${money(t.gross)}</dd></div>
          ${t.discount ? `<div><dt>Discount</dt><dd>-${money(t.discount)}</dd></div>` : ""}
          ${gst ? `<div><dt>Taxable amount</dt><dd>${money(t.taxable)}</dd></div>${t.cgst ? `<div><dt>CGST</dt><dd>${money(t.cgst)}</dd></div>` : ""}${t.sgst ? `<div><dt>SGST</dt><dd>${money(t.sgst)}</dd></div>` : ""}${t.igst ? `<div><dt>IGST</dt><dd>${money(t.igst)}</dd></div>` : ""}` : ""}
          ${t.roundOff ? `<div><dt>Round off</dt><dd>${t.roundOff > 0 ? "+" : "-"}${money(Math.abs(t.roundOff))}</dd></div>` : ""}
          <div class="grand"><dt>Grand total</dt><dd>${money(t.grandTotal)}</dd></div>
          <div><dt>Amount paid</dt><dd>${money(inv.amountPaid || 0)}</dd></div>
          <div><dt><strong>Balance due</strong></dt><dd><strong>${esc(balanceDueText(inv, money))}</strong></dd></div>
          ${inv.status !== "cancelled" && !inv.preview ? `<div><dt>Payment status</dt><dd>${paymentBadge(inv.paymentStatus)}</dd></div>` : ""}
        </dl>
      </div>
      <div class="inv-notes">
        ${inv.paymentDetails ? `<div><h3>Payment details</h3>${esc(inv.paymentDetails)}</div>` : ""}
        ${inv.notes ? `<div><h3>Notes</h3>${esc(inv.notes)}</div>` : ""}
        ${inv.terms ? `<div><h3>Additional terms</h3>${esc(inv.terms)}</div>` : ""}
        ${inv.replaces ? `<div><h3>Replaces</h3>This invoice replaces cancelled invoice ${esc(inv.replaces.invoiceNo)}.</div>` : ""}
      </div>
      <section class="inv-terms" aria-label="${esc(terms.title)}">
        <h3>${esc(terms.title)}</h3>
        <p class="inv-terms-head">${esc(terms.headline)}</p>
        ${terms.lines.map(line => `<p>${esc(line)}</p>`).join("")}
      </section>
      <p class="inv-thanks">${esc(INVOICE_THANK_YOU)}</p>
      <p class="inv-foot small muted">This is a computer-generated ${esc(String(inv.documentTitle).toLowerCase())}.</p>
    </article>`;
}

// Offline invoices have no order. Invoices issued before `source` existed all came from orders.
export const isOffline = inv => inv?.source === "offline";

/* =========================================================
   LIST
========================================================= */

async function renderList(el, ctx) {
  const pay = ctx.query.get("paymentStatus") || "";
  const q = ctx.query.get("q") || "";
  el.innerHTML = `
    <div class="page-head"><div><h1>Invoices</h1><p>Issued invoices cannot be edited. Corrections are made by cancelling and re-issuing.</p></div></div>
    <div class="toolbar">
      <form id="search-form" class="grow" style="display:flex;gap:8px"><input class="input" type="search" name="q" value="${esc(q)}" placeholder="Invoice number (OSS/2026-27/0001) or order number" aria-label="Search invoices"><button class="btn btn-outline" type="submit">Search</button></form>
      <select class="select" id="pay" style="width:auto" aria-label="Payment status"><option value="">All invoices</option><option value="unpaid">Unpaid</option><option value="partial">Partially paid</option><option value="paid">Paid</option></select>
    </div>
    <section class="card"><div id="rows"><div class="loading">Loading…</div></div><div class="pagination" id="more" hidden></div></section>`;
  el.querySelector("#pay").value = pay;
  el.querySelector("#pay").addEventListener("change", e => ctx.navigate(`invoices?${new URLSearchParams(e.target.value ? { paymentStatus: e.target.value } : {})}`));
  el.querySelector("#search-form").addEventListener("submit", e => { e.preventDefault(); ctx.navigate(`invoices?${new URLSearchParams({ q: e.target.elements.q.value.trim() })}`); });

  const items = [];
  const load = async before => {
    try {
      const data = await api.get(`/admin/invoices?${new URLSearchParams({ limit: "25", ...(pay ? { paymentStatus: pay } : {}), ...(q ? { q } : {}), ...(before ? { before } : {}) })}`);
      if (!ctx.isCurrent()) return;
      items.push(...data.items);
      el.querySelector("#rows").innerHTML = items.length ? `
        <div class="table-wrap"><table class="table responsive">
          <thead><tr><th>Invoice</th><th>Customer</th><th>Order</th><th class="right">Total</th><th class="right">Balance</th><th>Payment</th><th>Date</th></tr></thead>
          <tbody>${items.map(i => `
            <tr class="clickable" data-id="${esc(i.id)}">
              <td class="cell-main"><a class="name" href="#/invoices/${esc(i.id)}">${esc(i.invoiceNo)}</a>${i.status === "cancelled" ? ' <span class="badge red">Cancelled</span>' : ""}</td>
              <td data-label="Customer">${esc(i.customer?.name)}</td>
              <td data-label="Order">${isOffline(i) ? '<span class="badge gold">Offline</span>' : esc(i.orderNo)}</td>
              <td data-label="Total" class="right num">${money(i.totals?.grandTotal)}</td>
              <td data-label="Balance" class="right num">${i.status === "cancelled" ? "—" : money(i.balanceDue)}</td>
              <td data-label="Payment">${i.status === "cancelled" ? "—" : paymentBadge(i.paymentStatus)}</td>
              <td data-label="Date" class="nowrap">${date(i.issuedAt)}</td>
            </tr>`).join("")}
          </tbody></table></div>` : `<div class="empty"><h3>No invoices found</h3><p>Invoices are issued from a confirmed order, or directly under <a href="#/offline-invoices">Offline Invoices</a>.</p></div>`;
      const more = el.querySelector("#more");
      more.hidden = !data.next;
      more.innerHTML = data.next ? `<span class="muted">${items.length} shown</span><button class="btn btn-outline btn-sm" type="button" id="load-more">Load more</button>` : "";
      el.querySelector("#load-more")?.addEventListener("click", () => load(data.next));
    } catch (error) {
      el.querySelector("#rows").innerHTML = errorState(error, () => render(el, ctx));
    }
  };
  el.querySelector("#rows").addEventListener("click", e => {
    const row = e.target.closest("tr[data-id]");
    if (row && !e.target.closest("a")) ctx.navigate(`invoices/${row.dataset.id}`);
  });
  load();
}

/* =========================================================
   DETAIL
========================================================= */

const SHARE_STATUS = {
  ready: ["blue", "Invoice ready to share"],
  share_opened: ["amber", "Share opened — delivery not confirmed"],
  sent_confirmed: ["green", "Marked as sent"]
};

export function shareMessage(inv, link) {
  const c = inv.customer || {};
  const business = inv.seller?.businessName || "ONE STOP SOLUTION (OSS)";
  if (isOffline(inv)) {
    return [
      `Hello ${c.name},`,
      "",
      `Thank you for shopping with ${business}.`,
      "",
      `Your invoice ${inv.invoiceNo} has been generated.`,
      "",
      `Invoice Total: ${money(inv.totals?.grandTotal)}`,
      inv.balanceDue > 0 && inv.balanceDue !== inv.totals?.grandTotal ? `Balance due: ${money(inv.balanceDue)}` : "",
      "",
      link ? `Please find your invoice here (link valid until ${date(link.expiresAt)}):\n${link.url}` : "Your invoice PDF is attached.",
      "",
      INVOICE_THANK_YOU,
      "",
      business
    ].filter((line, i, all) => !(line === "" && all[i - 1] === "")).join("\n");
  }
  return [
    `Hello ${c.name},`,
    "",
    `Thank you for your order with ${inv.seller?.businessName || "ONE STOP SOLUTION (OSS)"}.`,
    "",
    `Invoice: ${inv.invoiceNo}`,
    `Order: ${inv.orderNo}`,
    `Date: ${date(inv.issuedAt)}`,
    `Amount: ${money(inv.totals?.grandTotal)}`,
    inv.balanceDue > 0 && inv.balanceDue !== inv.totals?.grandTotal ? `Balance due: ${money(inv.balanceDue)}` : "",
    "",
    link ? `Download your invoice (link valid until ${date(link.expiresAt)}):\n${link.url}` : "Your invoice PDF is attached.",
    "",
    "Thank you!"
  ].filter((line, i, all) => !(line === "" && all[i - 1] === "")).join("\n");
}

// `back` = list to return to: invoices (default) or offline-invoices.
export async function renderDetail(el, ctx, id, { back = "invoices", backLabel = "Invoices", banner = "" } = {}) {
  let inv;
  try {
    inv = await api.get(`/admin/invoices/${encodeURIComponent(id)}`);
  } catch (error) {
    el.innerHTML = errorState(error, () => renderDetail(el, ctx, id, { back, backLabel }));
    return;
  }
  if (!ctx.isCurrent()) return;
  const reload = () => renderDetail(el, ctx, id, { back, backLabel });
  const active = inv.status === "issued";
  const share = inv.share || { status: "ready", events: [] };
  const [shareColor, shareLabel] = SHARE_STATUS[share.status] || SHARE_STATUS.ready;
  const lastEvent = share.events[share.events.length - 1];
  const filename = `${inv.invoiceNo.replace(/[^A-Za-z0-9-]+/g, "-")}.pdf`;
  const canNativeShare = typeof navigator.canShare === "function" && navigator.canShare({ files: [new File([new Blob(["x"])], "t.pdf", { type: "application/pdf" })] });
  const offline = isOffline(inv);
  const phone = normalizePhone(inv.customer?.phone);
  const phoneOk = Boolean(phone) && isValidPhone(phone);
  const origin = offline
    ? '<span class="badge gold">Offline invoice</span>'
    : `Order <a href="#/orders/${esc(inv.orderId)}">${esc(inv.orderNo)}</a>`;

  el.innerHTML = `
    <div class="page-head">
      <div><a href="#/${esc(back)}" class="muted small">← ${esc(backLabel)}</a><h1>${esc(inv.documentTitle)} ${esc(inv.invoiceNo)}</h1>
        <p>${active ? paymentBadge(inv.paymentStatus) : '<span class="badge red">Cancelled</span>'} · ${origin} · Issued ${date(inv.issuedAt, true)}</p></div>
      <div class="page-actions no-print">
        <button class="btn btn-outline" type="button" id="pdf-btn">${icons.download}Download PDF</button>
        <button class="btn btn-outline" type="button" id="print-btn">${icons.print}Print</button>
      </div>
    </div>

    ${banner}
    <div class="detail-grid">
      <div>${invoiceHtml(inv)}</div>
      <div class="grid no-print">
        ${active ? `
        <section class="card card-pad">
          <h2>Share with customer</h2>
          <p style="margin:0 0 10px"><span class="badge ${shareColor}" id="share-status">${shareLabel}</span>${lastEvent ? `<span class="muted small" style="display:block;margin-top:6px">Last action: ${esc(lastEvent.type.replace(/_/g, " "))} · ${date(lastEvent.at, true)} · ${esc(lastEvent.by)}</span>` : ""}</p>
          ${phoneOk ? "" : `<p class="notice warn" style="margin:0 0 10px">${inv.customer?.phone ? `The mobile number on this invoice (${esc(inv.customer.phone)}) is not a valid WhatsApp number.` : "No mobile number was given for this customer."} WhatsApp will open without a recipient — choose the contact yourself.</p>`}
          <button class="btn btn-wa btn-lg btn-block" type="button" id="share-wa">${icons.whatsapp}${offline ? "Send Invoice on WhatsApp" : "Share Invoice on WhatsApp"}</button>
          <label class="check" style="margin-top:10px"><input type="checkbox" id="include-link" ${canNativeShare ? "" : "checked"}> Include a secure download link (expires in 7 days)</label>
          <p class="muted small" style="margin:8px 0 0">${canNativeShare
            ? "On this device the PDF is attached through your phone's share menu — choose WhatsApp and the customer."
            : "WhatsApp links cannot attach files. The PDF will download, and WhatsApp opens with a message to the customer — attach the downloaded PDF before sending, or rely on the secure link."}</p>
          <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:12px">
            ${canNativeShare ? '<button class="btn btn-outline btn-sm" type="button" id="share-wa-link">Download PDF & open chat</button>' : ""}
            <button class="btn btn-outline btn-sm" type="button" id="copy-link">${icons.link}Copy secure link</button>
            ${share.status !== "sent_confirmed" ? '<button class="btn btn-ghost btn-sm" type="button" id="mark-sent">I sent it — mark as sent</button>' : ""}
          </div>
          <div id="share-help"></div>
        </section>

        <section class="card card-pad">
          <h2>Payments</h2>
          <dl class="totals" style="margin-bottom:12px">
            <div><dt>Grand total</dt><dd>${money(inv.totals.grandTotal)}</dd></div>
            <div><dt>Paid</dt><dd>${money(inv.amountPaid)}</dd></div>
            <div class="grand"><dt>Balance due</dt><dd>${money(inv.balanceDue)}</dd></div>
          </dl>
          ${inv.payments.length ? `<ul class="timeline" style="margin-bottom:12px">${inv.payments.map(p => `<li><span>${p.status === "void" ? "<s>" : ""}<strong>${money(p.amount)}</strong> · ${esc(PAYMENT_METHODS[p.method] || p.method)} · ${esc(p.date)}${p.status === "void" ? "</s> <span class=\"badge red\">Void</span>" : ""}<br><span class="muted small">${esc(p.reference || "")}${p.note ? ` ${esc(p.note)}` : ""} · ${esc(p.recordedBy?.email || "")}</span>${p.status !== "void" && ctx.admin.role === "owner" ? ` <button class="btn btn-ghost btn-sm" type="button" data-void="${esc(p.id)}">Void</button>` : ""}</span></li>`).join("")}</ul>` : ""}
          ${inv.balanceDue > 0 ? '<button class="btn btn-primary btn-block" type="button" id="pay-btn">Record payment</button>' : '<p class="notice success" style="margin:0">Fully paid.</p>'}
        </section>

        <section class="card card-pad">
          <h2>Corrections</h2>
          <p class="muted small" style="margin-top:0">Issued invoices are never edited. To correct one, cancel it with a reason and ${offline ? "create a corrected offline invoice. Cancelling puts any deducted stock back." : "issue a new invoice from the order."}</p>
          <button class="btn btn-danger btn-block" type="button" id="cancel-btn" ${inv.amountPaid > 0 ? "disabled" : ""}>Cancel invoice</button>
          ${inv.amountPaid > 0 ? '<p class="muted small">Void the recorded payments before cancelling.</p>' : ""}
        </section>` : `
        <section class="card card-pad"><h2>Cancelled</h2><p>${esc(inv.cancelReason || "")}</p><p class="muted small">Cancelled ${date(inv.cancelledAt, true)} by ${esc(inv.cancelledBy?.email || "")}</p>${offline
          ? `<a class="btn btn-primary btn-block" href="#/offline-invoices/new?from=${encodeURIComponent(inv.id)}">Create corrected invoice</a>`
          : `<a class="btn btn-outline btn-block" href="#/orders/${esc(inv.orderId)}">Go to order</a>`}</section>`}
      </div>
    </div>`;

  const getPdf = async () => api.blob(`/admin/invoices/${encodeURIComponent(inv.id)}/pdf`);
  const recordEvent = async body => {
    try { await api.post(`/admin/invoices/${encodeURIComponent(inv.id)}/share-events`, body); } catch { /* tracking only */ }
  };
  const getLink = async () => {
    try {
      return await api.post(`/admin/invoices/${encodeURIComponent(inv.id)}/share-link`, { days: 7 });
    } catch (error) {
      toast(error.status === 503 ? "Secure links are not configured on the server (INVOICE_LINK_SECRET). Share the PDF instead." : error.message, "error");
      return null;
    }
  };

  el.querySelector("#pdf-btn").addEventListener("click", async e => {
    setBusy(e.currentTarget, true);
    try { downloadBlob(await getPdf(), filename); recordEvent({ type: "download" }); }
    catch (error) { toastError(error); }
    setBusy(e.currentTarget, false);
  });
  el.querySelector("#print-btn").addEventListener("click", () => { recordEvent({ type: "print" }); window.print(); });

  if (!active) return;

  const openWhatsAppChat = async (blob, link) => {
    downloadBlob(blob, filename);
    // Only a validated number is put in the link; otherwise WhatsApp asks who to send to.
    const url = `https://wa.me/${phoneOk ? phone : ""}?text=${encodeURIComponent(shareMessage(inv, link))}`;
    const win = window.open(url, "_blank");
    if (win) win.opener = null;
    await recordEvent({ type: "whatsapp_link" });
    el.querySelector("#share-help").innerHTML = `<p class="notice" style="margin:12px 0 0">
      <strong>${esc(filename)}</strong> was downloaded. ${win ? "WhatsApp opened" : "Open WhatsApp"} with your message${phoneOk ? ` to ${esc(phoneDisplay(phone))}` : ""}. Attach the PDF (📎 → Document) before sending${link ? ", or send the message with the secure link" : ""}. Nothing is sent until you press send in WhatsApp.
      <a class="btn btn-wa btn-sm" style="margin-top:8px" href="${esc(url)}" target="_blank" rel="noopener">${icons.whatsapp}Open WhatsApp chat</a></p>`;
  };

  const markOpened = () => {
    el.querySelector("#share-status").className = "badge amber";
    el.querySelector("#share-status").textContent = SHARE_STATUS.share_opened[1];
  };

  el.querySelector("#share-wa").addEventListener("click", async e => {
    const button = e.currentTarget;
    setBusy(button, true);
    const includeLink = el.querySelector("#include-link").checked;
    try {
      const [blob, link] = await Promise.all([getPdf(), includeLink ? getLink() : null]);
      const file = new File([blob], filename, { type: "application/pdf" });
      if (canNativeShare && navigator.canShare({ files: [file] })) {
        try {
          await navigator.share({ files: [file], title: `${inv.documentTitle} ${inv.invoiceNo}`, text: shareMessage(inv, link) });
          await recordEvent({ type: "native_share" });
          markOpened();
          toast("Share menu completed. Check WhatsApp to confirm the customer received it.");
        } catch (error) {
          if (error.name !== "AbortError") await openWhatsAppChat(blob, link).then(markOpened);
        }
      } else {
        await openWhatsAppChat(blob, link);
        markOpened();
      }
    } catch (error) {
      toastError(error);
    }
    setBusy(button, false);
  });

  el.querySelector("#share-wa-link")?.addEventListener("click", async e => {
    const button = e.currentTarget;
    setBusy(button, true);
    try {
      const [blob, link] = await Promise.all([getPdf(), el.querySelector("#include-link").checked ? getLink() : null]);
      await openWhatsAppChat(blob, link);
      markOpened();
    } catch (error) { toastError(error); }
    setBusy(button, false);
  });

  el.querySelector("#copy-link").addEventListener("click", async () => {
    const link = await getLink();
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link.url);
      toast(`Secure link copied. Valid until ${date(link.expiresAt)}.`, "success");
    } catch {
      openModal({ title: "Secure invoice link", size: "narrow", body: `<p class="small muted">Valid until ${date(link.expiresAt)}.</p><textarea class="textarea" readonly>${esc(link.url)}</textarea>` });
    }
    recordEvent({ type: "copy_link" });
  });

  el.querySelector("#mark-sent")?.addEventListener("click", async () => {
    const ok = await confirmDialog({ title: "Mark invoice as sent?", message: "Only do this after you have checked that the customer received the invoice on WhatsApp.", confirmText: "Mark as sent" });
    if (!ok) return;
    await recordEvent({ markSent: true });
    toast("Invoice marked as sent.", "success");
    reload();
  });

  el.querySelector("#pay-btn")?.addEventListener("click", () => {
    const modal = openModal({
      title: `Record payment — ${inv.invoiceNo}`,
      size: "narrow",
      body: `<form id="pay-form" novalidate><div class="form-grid">
        ${field({ name: "amount", label: "Amount", value: toRupeesInput(inv.balanceDue), prefix: "₹", required: true, full: true, attrs: 'inputmode="decimal"', hint: `Balance due: ${money(inv.balanceDue)}` })}
        ${selectField({ name: "method", label: "Method", value: "upi", options: Object.entries(PAYMENT_METHODS), full: true })}
        ${field({ name: "date", label: "Payment date", type: "date", value: new Date().toISOString().slice(0, 10), required: true, full: true })}
        ${field({ name: "reference", label: "Reference / transaction ID", full: true, attrs: 'maxlength="120"' })}
        ${field({ name: "note", label: "Note", full: true, attrs: 'maxlength="300"' })}
      </div><div class="notice error" id="pay-error" hidden style="margin-top:12px"></div></form>`,
      foot: '<button class="btn btn-outline" type="button" data-close>Cancel</button><button class="btn btn-primary" type="submit" form="pay-form" id="pay-save">Record payment</button>'
    });
    modal.$("#pay-form").addEventListener("submit", async e => {
      e.preventDefault();
      const f = e.target.elements;
      const amount = fromRupeesInput(f.amount.value);
      if (amount === null || Number.isNaN(amount)) return showFormErrors(e.target, { details: { fields: { amount: "Enter a valid amount." } } });
      setBusy(modal.$("#pay-save"), true);
      try {
        await api.post(`/admin/invoices/${encodeURIComponent(inv.id)}/payments`, { amount, method: f.method.value, date: f.date.value, reference: f.reference.value, note: f.note.value });
        toast("Payment recorded.", "success");
        modal.close();
        reload();
      } catch (error) {
        showFormErrors(e.target, error);
        modal.$("#pay-error").textContent = error.message;
        modal.$("#pay-error").hidden = false;
        setBusy(modal.$("#pay-save"), false);
      }
    });
  });

  el.querySelectorAll("[data-void]").forEach(button => button.addEventListener("click", async () => {
    const reason = await confirmDialog({ title: "Void this payment?", message: "The payment stays in the history marked as void, and the balance due increases.", confirmText: "Void payment", danger: true, input: { label: "Reason", required: true, min: 3, requiredMessage: "Enter a reason (at least 3 characters)." } });
    if (reason === false) return;
    try { await api.post(`/admin/payments/${encodeURIComponent(button.dataset.void)}/void`, { reason }); toast("Payment voided."); reload(); }
    catch (error) { toastError(error); }
  }));

  el.querySelector("#cancel-btn")?.addEventListener("click", async () => {
    const reason = await confirmDialog({ title: `Cancel invoice ${esc(inv.invoiceNo)}?`, message: offline ? "The invoice stays on record marked CANCELLED and any stock it deducted is put back. You can then create a corrected invoice." : "The invoice stays on record marked CANCELLED. You can then issue a new invoice from the order.", confirmText: "Cancel invoice", danger: true, input: { label: "Reason for cancellation", required: true, min: 3, requiredMessage: "Enter a reason (at least 3 characters)." } });
    if (reason === false) return;
    try { await api.post(`/admin/invoices/${encodeURIComponent(inv.id)}/cancel`, { reason }); toast("Invoice cancelled."); reload(); }
    catch (error) { toastError(error); }
  });
}
