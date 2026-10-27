/* Image library — Cloudinary images registered in Firestore, and cleanup of unused ones. */

import { api } from "../api.js";
import { confirmDialog, date, errorState, esc, toast, toastError } from "../ui.js";

const STATUS = { in_use: ["green", "In use"], unused: ["amber", "Unused"], deleted: ["red", "Deleted"] };
const thumb = url => url.replace("/image/upload/", "/image/upload/f_auto,q_auto,c_limit,w_300/");
const kb = bytes => (bytes ? `${Math.round(bytes / 1024)} KB` : "");

export async function render(el, ctx) {
  const status = ctx.query.get("status") || "";
  let assets, products;
  try {
    [assets, products] = await Promise.all([
      api.get(`/admin/images/assets${status ? `?status=${encodeURIComponent(status)}` : ""}`),
      api.get("/admin/products")
    ]);
  } catch (error) {
    el.innerHTML = errorState(error, () => render(el, ctx));
    return;
  }
  if (!ctx.isCurrent()) return;
  const skuOf = new Map(products.map(p => [p.id, p.sku]));
  const owner = ctx.admin.role === "owner";
  const legacy = products.filter(p => p.status !== "archived" && p.images.some(src => !src.startsWith("https://res.cloudinary.com/")));

  el.innerHTML = `
    <div id="images-root">
      <div class="page-head">
        <div><h1>Images</h1><p>Product photos stored in Cloudinary. Removing a photo from a product marks it unused; it is only deleted from Cloudinary when the owner deletes it here.</p></div>
      </div>
      ${ctx.config?.images?.configured === false ? '<p class="notice error">Cloudinary is not configured on the server. Uploads and deletions are unavailable.</p>' : ""}
      ${legacy.length ? `<p class="notice warn">${legacy.length} product(s) still use images from the project folder. Run the image migration (see README) to move them to Cloudinary.</p>` : ""}
      <div class="toolbar">
        <select class="select" id="status" style="width:auto" aria-label="Status">
          <option value="">All images</option><option value="in_use">In use</option><option value="unused">Unused</option><option value="deleted">Deleted</option>
        </select>
        <span class="muted">${assets.length} image${assets.length === 1 ? "" : "s"}</span>
      </div>
      <section class="card card-pad">
        ${assets.length ? `<div class="images-grid" style="grid-template-columns:repeat(auto-fill,minmax(170px,1fr))">
          ${assets.map(a => `
            <div style="display:grid;gap:6px">
              <div class="img-tile">${a.status === "deleted" ? '<div class="empty small" style="padding:30px 6px">Deleted from Cloudinary</div>' : `<img src="${esc(thumb(a.url))}" alt="" loading="lazy">`}</div>
              <div class="small" style="word-break:break-all"><strong>${esc(a.publicId.split("/").pop())}</strong></div>
              <div class="small muted">${esc([a.width && a.height ? `${a.width}×${a.height}` : "", kb(a.bytes), date(a.createdAt)].filter(Boolean).join(" · "))}</div>
              <div><span class="badge ${STATUS[a.status]?.[0] || ""}">${STATUS[a.status]?.[1] || esc(a.status)}</span>
                ${a.productIds.map(id => `<a class="small" href="#/products/${esc(id)}">${esc(skuOf.get(id) || id)}</a>`).join(" ")}</div>
              ${owner && a.status === "unused" ? `<button class="btn btn-danger btn-sm" type="button" data-delete="${esc(a.id)}">Delete from Cloudinary</button>` : ""}
            </div>`).join("")}
        </div>` : '<div class="empty"><h3>No images</h3><p>Images uploaded from the product editor appear here.</p></div>'}
      </section>
    </div>`;

  el.querySelector("#status").value = status;
  el.querySelector("#status").addEventListener("change", e => ctx.navigate(`images${e.target.value ? `?status=${e.target.value}` : ""}`));
  el.querySelector("#images-root").addEventListener("click", async e => {
    const button = e.target.closest("[data-delete]");
    if (!button) return;
    const ok = await confirmDialog({
      title: "Delete this image from Cloudinary?",
      message: "It is not used by any product. Old orders that showed this photo will show a placeholder instead. This cannot be undone.",
      confirmText: "Delete permanently",
      danger: true
    });
    if (!ok) return;
    button.disabled = true;
    try {
      await api.del(`/admin/images/assets/${encodeURIComponent(button.dataset.delete)}`);
      toast("Image deleted from Cloudinary.", "success");
      render(el, ctx);
    } catch (error) {
      toastError(error);
      button.disabled = false;
    }
  });
}
