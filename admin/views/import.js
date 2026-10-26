/* CSV import — preview first, then commit. Existing SKUs are only updated on request. */

import { api } from "../api.js";
import { esc, setBusy, toast, toastError } from "../ui.js";

const ACTION = { create: ["green", "New"], update: ["amber", "SKU exists"], error: ["red", "Error"] };
const OUTCOME = { created: ["green", "Created"], updated: ["amber", "Updated"], skipped: ["", "Skipped"], failed: ["red", "Failed"] };

export async function render(el) {
  let csv = "";
  el.innerHTML = `
    <div class="page-head">
      <div><a href="#/products" class="muted small">← Products</a><h1>Import products from CSV</h1>
      <p>Columns: <code>sku, name, category</code> (required) and optionally <code>subcategory, description, price, salePrice, gstRate, hsn, minQty, unit, status, manualStatus, lowStockThreshold, featured, images, specs</code>. Prices in rupees. Separate images with “|” and specs with “;”. Stock is not imported — use Inventory.</p></div>
    </div>
    <section class="card card-pad" style="margin-bottom:16px">
      <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center">
        <input type="file" id="file" accept=".csv,text/csv" class="input" style="max-width:360px">
        <button class="btn btn-primary" type="button" id="preview-btn" disabled>Check file</button>
        <span class="muted small">Tip: export the current catalogue first to get a correctly formatted file.</span>
      </div>
    </section>
    <div id="result"></div>`;

  const result = el.querySelector("#result");
  el.querySelector("#file").addEventListener("change", async e => {
    const file = e.target.files[0];
    csv = file ? await file.text() : "";
    el.querySelector("#preview-btn").disabled = !csv;
    result.innerHTML = "";
  });

  el.querySelector("#preview-btn").addEventListener("click", async e => {
    setBusy(e.currentTarget, true);
    try {
      const preview = await api.post("/admin/products/import", { csv, mode: "preview" });
      const { summary } = preview;
      result.innerHTML = `
        <section class="card">
          <div class="card-head"><h2>Check results</h2><span class="muted">${summary.total} rows · ${summary.create} new · ${summary.update} existing · ${summary.errors} with errors</span></div>
          <div class="table-wrap"><table class="table responsive"><thead><tr><th>Row</th><th>SKU</th><th>Name</th><th>Result</th><th>Details</th></tr></thead><tbody>
          ${preview.rows.map(r => `<tr><td class="cell-main">${r.row}</td><td data-label="SKU">${esc(r.sku)}</td><td data-label="Name">${esc(r.name)}</td><td data-label="Result"><span class="badge ${ACTION[r.action][0]}">${ACTION[r.action][1]}</span></td>
            <td data-label="Details" class="small">${r.errors.length ? `<span style="color:var(--danger)">${r.errors.map(esc).join("<br>")}</span>` : r.action === "update" ? `Matches existing “${esc(r.existingName)}”` : r.newCategory ? `New category “${esc(r.newCategory)}” will be created` : ""}</td></tr>`).join("")}
          </tbody></table></div>
          <div class="pagination">
            ${summary.errors ? '<span class="notice error">Fix the rows with errors and check the file again.</span>' : `
              <label class="check"><input type="checkbox" id="update-existing"> Update the ${summary.update} existing product(s) with values from this file</label>
              <button class="btn btn-primary" type="button" id="commit-btn">Import ${summary.create} new${summary.update ? " (+ updates if ticked)" : ""}</button>`}
          </div>
        </section>`;

      result.querySelector("#commit-btn")?.addEventListener("click", async ev => {
        setBusy(ev.currentTarget, true);
        try {
          const done = await api.post("/admin/products/import", { csv, mode: "commit", updateExisting: result.querySelector("#update-existing").checked });
          const counts = done.results.reduce((acc, r) => ({ ...acc, [r.outcome]: (acc[r.outcome] || 0) + 1 }), {});
          toast(`Import finished: ${counts.created || 0} created, ${counts.updated || 0} updated, ${counts.skipped || 0} skipped, ${counts.failed || 0} failed.`, counts.failed ? "error" : "success");
          result.innerHTML = `<section class="card"><div class="card-head"><h2>Import finished</h2><a class="btn btn-outline btn-sm" href="#/products">View products</a></div>
            <div class="table-wrap"><table class="table responsive"><thead><tr><th>Row</th><th>SKU</th><th>Outcome</th><th>Message</th></tr></thead><tbody>
            ${done.results.map(r => `<tr><td class="cell-main">${r.row}</td><td data-label="SKU">${esc(r.sku)}</td><td data-label="Outcome"><span class="badge ${OUTCOME[r.outcome][0]}">${OUTCOME[r.outcome][1]}</span></td><td data-label="Message" class="small">${esc(r.message || "")}</td></tr>`).join("")}
            </tbody></table></div></section>`;
        } catch (error) {
          toastError(error);
          setBusy(ev.currentTarget, false);
        }
      });
    } catch (error) {
      toastError(error);
    }
    setBusy(e.currentTarget, false);
  });
}
