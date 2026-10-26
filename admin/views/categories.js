/* Categories — create, rename, subcategories, reorder, archive. */

import { api } from "../api.js";
import { errorState, esc, field, openModal, selectField, setBusy, showFormErrors, toast, toastError } from "../ui.js";

export async function render(el, ctx) {
  let categories;
  try {
    categories = await api.get("/admin/categories");
  } catch (error) {
    el.innerHTML = errorState(error, () => render(el, ctx));
    return;
  }
  if (!ctx.isCurrent()) return;

  const tops = categories.filter(c => !c.parentId);
  const childrenOf = id => categories.filter(c => c.parentId === id);
  const reload = () => render(el, ctx);

  el.innerHTML = `<div id="cat-root">
    <div class="page-head">
      <div><h1>Categories</h1><p>Order here controls the order on the website. Archived categories are hidden.</p></div>
      <div class="page-actions"><button class="btn btn-primary" type="button" data-create>+ New category</button></div>
    </div>
    <section class="card">
      <div class="table-wrap"><table class="table responsive">
        <thead><tr><th>Category</th><th class="right">Products</th><th>Status</th><th class="right">Actions</th></tr></thead>
        <tbody>${tops.map((c, i) => `
          <tr>
            <td class="cell-main"><strong class="name">${esc(c.name)}</strong>${c.description ? `<div class="muted small">${esc(c.description)}</div>` : ""}
              ${childrenOf(c.id).map(s => `<div class="small" style="margin-top:4px;padding-left:12px">↳ ${esc(s.name)} <span class="muted">(${s.productCount})</span> ${s.archived ? '<span class="badge red">Archived</span>' : ""}
                <button class="btn btn-ghost btn-sm" type="button" data-edit="${esc(s.id)}">Edit</button>
                ${s.archived ? `<button class="btn btn-ghost btn-sm" type="button" data-restore="${esc(s.id)}">Restore</button>` : `<button class="btn btn-ghost btn-sm" type="button" data-archive="${esc(s.id)}">Archive</button>`}</div>`).join("")}
            </td>
            <td data-label="Products" class="right num">${c.productCount}</td>
            <td data-label="Status">${c.archived ? '<span class="badge red">Archived</span>' : '<span class="badge green">Active</span>'}</td>
            <td class="right nowrap">
              <button class="btn btn-ghost btn-sm" type="button" data-move="${i}" data-dir="-1" ${i === 0 ? "disabled" : ""} aria-label="Move ${esc(c.name)} up">↑</button>
              <button class="btn btn-ghost btn-sm" type="button" data-move="${i}" data-dir="1" ${i === tops.length - 1 ? "disabled" : ""} aria-label="Move ${esc(c.name)} down">↓</button>
              <button class="btn btn-outline btn-sm" type="button" data-sub="${esc(c.id)}">+ Sub</button>
              <button class="btn btn-outline btn-sm" type="button" data-edit="${esc(c.id)}">Edit</button>
              ${c.archived ? `<button class="btn btn-outline btn-sm" type="button" data-restore="${esc(c.id)}">Restore</button>` : `<button class="btn btn-danger btn-sm" type="button" data-archive="${esc(c.id)}">Archive</button>`}
            </td>
          </tr>`).join("") || '<tr><td colspan="4"><div class="empty">No categories yet.</div></td></tr>'}
        </tbody></table></div>
    </section></div>`;

  const formModal = ({ title, category = null, parentId = null }) => {
    const modal = openModal({
      title,
      size: "narrow",
      body: `<form id="cat-form" novalidate><div class="form-grid">
        ${field({ name: "name", label: "Name", value: category?.name || "", required: true, full: true, attrs: 'maxlength="80"' })}
        ${field({ name: "description", label: "Description", value: category?.description || "", type: "textarea", full: true, attrs: 'maxlength="500" rows="3"' })}
        </div><div class="notice error" id="cat-error" hidden style="margin-top:12px"></div></form>`,
      foot: '<button class="btn btn-outline" type="button" data-close>Cancel</button><button class="btn btn-primary" type="submit" form="cat-form" id="cat-save">Save</button>'
    });
    modal.$("#cat-form").addEventListener("submit", async e => {
      e.preventDefault();
      const f = e.target.elements;
      const button = modal.$("#cat-save");
      setBusy(button, true);
      try {
        if (category) await api.patch(`/admin/categories/${encodeURIComponent(category.id)}`, { name: f.name.value, description: f.description.value });
        else await api.post("/admin/categories", { name: f.name.value, description: f.description.value, parentId });
        toast("Category saved.", "success");
        modal.close();
        reload();
      } catch (error) {
        showFormErrors(e.target, error);
        modal.$("#cat-error").textContent = error.message;
        modal.$("#cat-error").hidden = false;
        setBusy(button, false);
      }
    });
    modal.$('[name="name"]').focus();
  };

  const archive = async category => {
    const sameLevel = categories.filter(c => !c.archived && c.id !== category.id && Boolean(c.parentId) === Boolean(category.parentId) && (!category.parentId || c.parentId === category.parentId));
    const modal = openModal({
      title: `Archive “${category.name}”?`,
      size: "narrow",
      body: `<form id="arch-form">
        <p style="margin-top:0">${category.productCount ? `<strong>${category.productCount}</strong> product(s) use this category. Choose where to move them. Products are never deleted.` : "No products use this category. It will be hidden from the website."}</p>
        ${category.productCount ? selectField({ name: "reassignTo", label: "Move products to", full: true, options: [["", "Choose a category"], ...sameLevel.map(c => [c.id, c.name])] }) : ""}
        <div class="notice error" id="arch-error" hidden style="margin-top:12px"></div></form>`,
      foot: '<button class="btn btn-outline" type="button" data-close>Cancel</button><button class="btn btn-danger" type="submit" form="arch-form" id="arch-save">Archive</button>'
    });
    modal.$("#arch-form").addEventListener("submit", async e => {
      e.preventDefault();
      const reassignTo = e.target.elements.reassignTo?.value || null;
      if (category.productCount && !reassignTo) {
        modal.$("#arch-error").textContent = "Choose a category to move the products into.";
        modal.$("#arch-error").hidden = false;
        return;
      }
      setBusy(modal.$("#arch-save"), true);
      try {
        const result = await api.post(`/admin/categories/${encodeURIComponent(category.id)}/archive`, { reassignTo });
        toast(`Category archived${result.moved ? `; ${result.moved} product(s) moved` : ""}.`, "success");
        modal.close();
        reload();
      } catch (error) {
        modal.$("#arch-error").textContent = error.message;
        modal.$("#arch-error").hidden = false;
        setBusy(modal.$("#arch-save"), false);
      }
    });
  };

  el.querySelector("#cat-root").addEventListener("click", async e => {
    const t = e.target.closest("button");
    if (!t) return;
    const find = id => categories.find(c => c.id === id);
    if (t.matches("[data-create]")) formModal({ title: "New category" });
    else if (t.dataset.sub) formModal({ title: `New subcategory in ${find(t.dataset.sub).name}`, parentId: t.dataset.sub });
    else if (t.dataset.edit) formModal({ title: "Edit category", category: find(t.dataset.edit) });
    else if (t.dataset.archive) archive(find(t.dataset.archive));
    else if (t.dataset.restore) {
      try { await api.post(`/admin/categories/${encodeURIComponent(t.dataset.restore)}/restore`); toast("Category restored."); reload(); }
      catch (error) { toastError(error); }
    } else if (t.dataset.move !== undefined) {
      const ids = tops.map(c => c.id);
      const i = Number(t.dataset.move);
      const j = i + Number(t.dataset.dir);
      [ids[i], ids[j]] = [ids[j], ids[i]];
      t.disabled = true;
      try { await api.post("/admin/categories/reorder", { ids }); reload(); }
      catch (error) { toastError(error); t.disabled = false; }
    }
  });
}
