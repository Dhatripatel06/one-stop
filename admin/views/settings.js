/* Settings — business details, tax, invoices, admin users, audit log. */

import { api } from "../api.js";
import { confirmDialog, date, errorState, esc, field, fromRupeesInput, selectField, setBusy, showFormErrors, toRupeesInput, toast, toastError } from "../ui.js";
import { GST_RATES, INDIAN_STATES } from "../../shared/pricing.js";

export async function render(el, ctx) {
  const owner = ctx.admin.role === "owner";
  let settings, admins = [], audit = [];
  try {
    [settings, admins, audit] = await Promise.all([
      api.get("/admin/settings"),
      owner ? api.get("/admin/admins") : [],
      owner ? api.get("/admin/audit?limit=60") : []
    ]);
  } catch (error) {
    el.innerHTML = errorState(error, () => render(el, ctx));
    return;
  }
  if (!ctx.isCurrent()) return;
  const s = settings;
  const ro = owner ? "" : "disabled";

  el.innerHTML = `
    <div class="page-head"><div><h1>Settings</h1><p>${owner ? "Only verified legal details should be entered here — they appear on invoices." : "Only the owner can change settings."}</p></div></div>
    <form id="settings-form" novalidate>
      <fieldset style="border:0;padding:0;margin:0" ${ro}>
      <div class="grid grid-2">
        <section class="card card-pad">
          <h2>Business</h2>
          <div class="form-grid">
            ${field({ name: "businessName", label: "Business name", value: s.businessName, required: true, full: true })}
            ${field({ name: "tagline", label: "Tagline", value: s.tagline, full: true })}
            ${field({ name: "phone", label: "Phone (shown)", value: s.phone })}
            ${field({ name: "whatsapp", label: "WhatsApp number", value: s.whatsapp, hint: "Receives website order messages." })}
            ${field({ name: "email", label: "Email", value: s.email, type: "email" })}
            ${field({ name: "instagram", label: "Instagram handle", value: s.instagram })}
            ${field({ name: "address", label: "Business address", value: s.address, type: "textarea", full: true, hint: "Printed on invoices. Leave blank until verified." })}
          </div>
        </section>
        <section class="card card-pad">
          <h2>Tax (GST)</h2>
          <div class="form-grid">
            ${selectField({ name: "taxMode", label: "GST on invoices", value: s.taxMode, full: true, options: [["none", "Not charged (no GST lines on invoices)"], ["gst", "Charge GST"]], hint: "Enable only when the business is GST-registered. Confirm rates with your accountant." })}
            ${field({ name: "gstin", label: "GSTIN", value: s.gstin, attrs: 'maxlength="15" style="text-transform:uppercase"' })}
            ${selectField({ name: "stateCode", label: "Business state", value: s.stateCode, required: false, options: [["", "Not set"], ...INDIAN_STATES.map(([c, n]) => [c, `${n} (${c})`])] })}
            ${selectField({ name: "defaultGstRate", label: "Default GST rate", value: s.defaultGstRate ?? "", required: false, options: [["", "Not set (0%)"], ...GST_RATES.map(r => [r, `${r}%`])], hint: "Used when a product has no rate of its own." })}
            ${selectField({ name: "pricesIncludeTax", label: "Catalogue prices are", value: String(s.pricesIncludeTax), options: [["true", "Inclusive of GST"], ["false", "Exclusive of GST (GST added)"]] })}
          </div>
        </section>
        <section class="card card-pad">
          <h2>Orders & invoices</h2>
          <div class="form-grid">
            ${field({ name: "minOrderValue", label: "Minimum order value", value: toRupeesInput(s.minOrderValue), prefix: "₹", attrs: 'inputmode="decimal"', hint: "Applied to website orders when all items are priced." })}
            ${field({ name: "invoicePrefix", label: "Invoice number prefix", value: s.invoicePrefix, required: true, hint: "e.g. OSS → OSS/2026-27/0001" })}
            <label class="check full"><input type="checkbox" name="roundOff" ${s.roundOff ? "checked" : ""}> Round invoice totals to the nearest rupee</label>
            ${field({ name: "paymentDetails", label: "Payment details (UPI / bank)", value: s.paymentDetails, type: "textarea", full: true })}
            ${field({ name: "invoiceNotes", label: "Invoice notes", value: s.invoiceNotes, type: "textarea", full: true })}
            ${field({ name: "invoiceTerms", label: "Terms & conditions", value: s.invoiceTerms, type: "textarea", full: true })}
          </div>
        </section>
        <section class="card card-pad" style="align-self:start">
          <h2>Save</h2>
          <div class="notice error" id="settings-error" hidden style="margin-bottom:10px"></div>
          ${owner ? '<button class="btn btn-primary btn-lg btn-block" type="submit" id="save-settings">Save settings</button>' : '<p class="muted">Read-only for staff accounts.</p>'}
          <p class="muted small">Changes apply to new invoices only. Issued invoices keep the details they were issued with.</p>
        </section>
      </div>
      </fieldset>
    </form>

    ${owner ? `
    <div class="grid grid-2" style="margin-top:16px">
      <section class="card">
        <div class="card-head"><h2>Admin users</h2></div>
        <div style="padding:14px 18px">
          ${admins.map(a => `<div style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--line)"><span style="flex:1;min-width:0;word-break:break-all"><strong>${esc(a.email || a.uid)}</strong><br><span class="muted small">${a.role === "owner" ? "Owner" : "Staff"}${a.bootstrap ? " · set by ADMIN_UIDS" : ""}</span></span>${!a.bootstrap && a.uid !== ctx.admin.uid ? `<button class="btn btn-danger btn-sm" type="button" data-remove-admin="${esc(a.uid)}">Remove</button>` : ""}</div>`).join("")}
          <form id="admin-form" class="form-grid" style="margin-top:14px" novalidate>
            ${field({ name: "email", label: "Add admin by email", type: "email", required: true, full: true, hint: "The person needs a Firebase Authentication account first." })}
            ${selectField({ name: "role", label: "Role", value: "staff", options: [["staff", "Staff — orders, products, inventory"], ["owner", "Owner — everything incl. settings"]] })}
            <div class="field" style="align-self:end"><button class="btn btn-outline" type="submit">Add admin</button></div>
          </form>
        </div>
      </section>
      <section class="card">
        <div class="card-head"><h2>Audit log</h2><span class="muted small">Latest ${audit.length}</span></div>
        <div style="max-height:420px;overflow-y:auto">
          ${audit.map(a => `<div style="padding:8px 18px;border-bottom:1px solid var(--line);font-size:12.5px"><strong>${esc(a.action)}</strong> <span class="muted">${esc(a.entity)} ${esc(a.details?.sku || a.details?.orderNo || a.details?.invoiceNo || "")}</span><br><span class="muted">${date(a.at, true)} · ${esc(a.actor?.email || a.actor?.uid)}</span></div>`).join("") || '<div class="empty"><p>No activity yet.</p></div>'}
        </div>
      </section>
    </div>` : ""}`;

  if (!owner) return;

  el.querySelector("#settings-form").addEventListener("submit", async e => {
    e.preventDefault();
    const f = e.target.elements;
    const errorBox = el.querySelector("#settings-error");
    errorBox.hidden = true;
    const minOrderValue = fromRupeesInput(f.minOrderValue.value);
    if (Number.isNaN(minOrderValue)) return showFormErrors(e.target, { details: { fields: { minOrderValue: "Enter a valid amount." } } });
    const body = {
      businessName: f.businessName.value, tagline: f.tagline.value, phone: f.phone.value, whatsapp: f.whatsapp.value,
      email: f.email.value, instagram: f.instagram.value, address: f.address.value,
      taxMode: f.taxMode.value, gstin: f.gstin.value, stateCode: f.stateCode.value,
      defaultGstRate: f.defaultGstRate.value === "" ? null : Number(f.defaultGstRate.value),
      pricesIncludeTax: f.pricesIncludeTax.value === "true",
      minOrderValue: minOrderValue ?? 0, invoicePrefix: f.invoicePrefix.value, roundOff: f.roundOff.checked,
      paymentDetails: f.paymentDetails.value, invoiceNotes: f.invoiceNotes.value, invoiceTerms: f.invoiceTerms.value
    };
    const button = el.querySelector("#save-settings");
    setBusy(button, true);
    try {
      await api.put("/admin/settings", body);
      toast("Settings saved.", "success");
      render(el, ctx);
    } catch (error) {
      showFormErrors(e.target, error);
      errorBox.textContent = error.message;
      errorBox.hidden = false;
      setBusy(button, false);
    }
  });

  el.querySelector("#admin-form").addEventListener("submit", async e => {
    e.preventDefault();
    const f = e.target.elements;
    try {
      await api.post("/admin/admins", { email: f.email.value, role: f.role.value });
      toast("Admin added.", "success");
      render(el, ctx);
    } catch (error) {
      showFormErrors(e.target, error);
      toastError(error);
    }
  });

  el.querySelectorAll("[data-remove-admin]").forEach(button => button.addEventListener("click", async () => {
    const ok = await confirmDialog({ title: "Remove admin access?", message: "This person will no longer be able to use OSS Admin.", confirmText: "Remove", danger: true });
    if (!ok) return;
    try { await api.del(`/admin/admins/${encodeURIComponent(button.dataset.removeAdmin)}`); toast("Admin removed."); render(el, ctx); }
    catch (error) { toastError(error); }
  }));
}
