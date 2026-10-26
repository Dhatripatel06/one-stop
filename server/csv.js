/* =========================================================
   PRODUCT CSV IMPORT / EXPORT
   Import is two-step: "preview" validates every row and reports what
   would happen; "commit" applies it. Rows whose SKU already exists are
   only updated when the admin explicitly opts in (updateExisting).
   Stock is not imported — use Inventory so every change is recorded.
========================================================= */

import { db } from "./firebase.js";
import { HttpError, badRequest } from "./http.js";
import { paiseToRupeesString } from "../shared/pricing.js";
import { normalizeSku } from "../shared/constants.js";
import { createProduct, listAdminProducts, parseProductInput, updateProduct } from "./products.js";
import { categoryIdFor } from "./categories.js";

export const CSV_COLUMNS = [
  "sku", "name", "category", "subcategory", "description", "price", "salePrice", "gstRate", "hsn",
  "minQty", "unit", "status", "manualStatus", "lowStockThreshold", "featured", "images", "specs", "stockQty"
];

function escapeCell(value) {
  const text = value === null || value === undefined ? "" : String(value);
  // Neutralise spreadsheet formulas.
  const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export async function exportProductsCsv() {
  const list = await listAdminProducts();
  const rows = list.map(p => [
    p.sku, p.name, p.categoryName, p.subcategoryName || "", p.description || "",
    paiseToRupeesString(p.price), paiseToRupeesString(p.salePrice), p.gstRate ?? "", p.hsn || "",
    p.minQty || 1, p.unit || "pcs", p.status, p.manualStatus || "in_stock", p.lowStockThreshold ?? "",
    p.featured ? "yes" : "", (p.images || []).join(" | "),
    (p.specs || []).map(s => `${s.label}: ${s.value}`).join(" ; "),
    p.trackStock ? p.stockQty : ""
  ]);
  return "﻿" + [CSV_COLUMNS, ...rows].map(row => row.map(escapeCell).join(",")).join("\r\n");
}

export function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  const input = String(text || "").replace(/^﻿/, "");

  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    if (quoted) {
      if (ch === '"' && input[i + 1] === '"') { cell += '"'; i += 1; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") { row.push(cell); cell = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && input[i + 1] === "\n") i += 1;
      row.push(cell); rows.push(row); row = []; cell = "";
    } else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter(r => r.some(c => c.trim() !== ""));
}

function rowToInput(header, cells) {
  const raw = {};
  header.forEach((key, i) => { raw[key] = (cells[i] ?? "").trim().replace(/^'(?=[=+\-@])/, ""); });
  return {
    raw,
    input: {
      sku: raw.sku,
      name: raw.name,
      description: raw.description,
      price: raw.price,
      salePrice: raw.salePrice,
      gstRate: raw.gstRate,
      hsn: raw.hsn,
      minQty: raw.minQty || 1,
      unit: raw.unit || "pcs",
      status: raw.status || "active",
      manualStatus: raw.manualStatus || "in_stock",
      lowStockThreshold: raw.lowStockThreshold,
      featured: /^(yes|true|1)$/i.test(raw.featured || ""),
      images: raw.images ? raw.images.split("|").map(s => s.trim()).filter(Boolean) : [],
      specs: raw.specs ? raw.specs.split(";").map(s => {
        const i = s.indexOf(":");
        return i > 0 ? { label: s.slice(0, i).trim(), value: s.slice(i + 1).trim() } : { label: "", value: s.trim() };
      }) : []
    }
  };
}

async function analyse(csvText) {
  const rows = parseCsv(csvText);
  if (rows.length < 2) throw badRequest("The CSV file has no product rows.");
  if (rows.length > 1001) throw badRequest("Import up to 1000 products at a time.");
  const header = rows[0].map(h => h.trim());
  const missing = ["sku", "name", "category"].filter(col => !header.includes(col));
  if (missing.length) throw badRequest(`Missing required column(s): ${missing.join(", ")}.`);

  const [existingProducts, categorySnap] = await Promise.all([listAdminProducts(), db().collection("categories").get()]);
  const bySku = new Map(existingProducts.map(p => [p.sku, p]));
  const categories = new Map(categorySnap.docs.map(doc => [doc.id, { id: doc.id, ...doc.data() }]));
  const seen = new Set();

  return rows.slice(1).map((cells, index) => {
    const { raw, input } = rowToInput(header, cells);
    const result = { row: index + 2, sku: normalizeSku(raw.sku), name: raw.name, errors: [], action: "create" };

    try {
      parseProductInput({ ...input, categoryId: "placeholder" });
    } catch (error) {
      if (error instanceof HttpError && error.details?.fields) result.errors.push(...Object.values(error.details.fields));
      else throw error;
    }
    if (!raw.category) result.errors.push("Category is required.");
    if (seen.has(result.sku)) result.errors.push("This SKU appears more than once in the file.");
    seen.add(result.sku);

    const categoryId = raw.category ? categoryIdFor(raw.category) : null;
    const category = categoryId ? categories.get(categoryId) : null;
    if (category?.archived) result.errors.push(`Category "${raw.category}" is archived.`);
    result.newCategory = raw.category && !category ? raw.category : null;

    let subcategoryId = null;
    if (raw.subcategory) {
      subcategoryId = categoryIdFor(raw.subcategory, categoryId);
      if (!categories.has(subcategoryId)) result.errors.push(`Subcategory "${raw.subcategory}" does not exist under "${raw.category}". Create it first.`);
    }

    const existing = bySku.get(result.sku);
    if (existing) {
      result.action = "update";
      result.existingId = existing.id;
      result.existingName = existing.name;
    }
    if (result.errors.length) result.action = "error";

    result.payload = {
      ...input,
      ...(category ? { categoryId: category.id } : { newCategoryName: raw.category }),
      subcategoryId: subcategoryId || ""
    };
    return result;
  });
}

export async function importProductsCsv(input, admin) {
  const csvText = String(input?.csv || "");
  const mode = input?.mode === "commit" ? "commit" : "preview";
  const updateExisting = input?.updateExisting === true;
  const rows = await analyse(csvText);

  const summary = {
    total: rows.length,
    create: rows.filter(r => r.action === "create").length,
    update: rows.filter(r => r.action === "update").length,
    errors: rows.filter(r => r.action === "error").length
  };
  const strip = r => ({ row: r.row, sku: r.sku, name: r.name, action: r.action, errors: r.errors, newCategory: r.newCategory, existingName: r.existingName });

  if (mode === "preview") return { mode, summary, rows: rows.map(strip) };
  if (summary.errors) throw badRequest("Fix the rows with errors before importing.", { rows: rows.filter(r => r.errors.length).map(strip) });

  const results = [];
  for (const row of rows) {
    if (row.action === "update" && !updateExisting) {
      results.push({ ...strip(row), outcome: "skipped", message: "SKU exists — not updated." });
      continue;
    }
    try {
      if (row.action === "create") {
        await createProduct(row.payload, admin);
        results.push({ ...strip(row), outcome: "created" });
      } else {
        await updateProduct(row.existingId, row.payload, admin);
        results.push({ ...strip(row), outcome: "updated" });
      }
    } catch (error) {
      results.push({ ...strip(row), outcome: "failed", message: error.message });
    }
  }
  return { mode, summary, results };
}
