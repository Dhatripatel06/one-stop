/* =========================================================
   PRODUCTS
   - SKUs are unique: every product owns a document at skuIndex/{SKU},
     created and checked inside the same transaction as the product.
   - Stock quantities are NOT editable here; they change only through
     inventory.js so every change is recorded as a movement.
========================================================= */

import { db, FieldValue } from "./firebase.js";
import { Validator } from "./validate.js";
import { imageStatus, localImageExists, normalizeImagePath, toPublicPath } from "./local-images.js";
import { releaseProductImages, resolveProductImages } from "./image-assets.js";
import { badRequest, conflict, notFound } from "./http.js";
import { auditEntry, auditRef } from "./audit.js";
import { actorOf } from "./auth.js";
import { GST_RATES, effectiveUnitPrice } from "../shared/pricing.js";
import { MANUAL_STATUSES, PRODUCT_STATUSES, SKU_PATTERN, normalizeSku } from "../shared/constants.js";
import { categoryIdFor, prepareCategoryInTx } from "./categories.js";

const products = () => db().collection("products");
const skuIndex = sku => db().collection("skuIndex").doc(sku);

/* ---------------------------------------------------------
   AVAILABILITY
--------------------------------------------------------- */

export function availableQty(product) {
  if (!product.trackStock) return null;
  return Math.max(0, (product.stockQty || 0) - (product.reservedQty || 0));
}

export function availabilityOf(product) {
  if (!product.trackStock) {
    return MANUAL_STATUSES.includes(product.manualStatus) ? product.manualStatus : "in_stock";
  }
  const available = availableQty(product);
  if (available <= 0) return product.manualStatus === "coming_soon" ? "coming_soon" : "out_of_stock";
  const threshold = product.lowStockThreshold;
  if (Number.isInteger(threshold) && available <= threshold) return "low_stock";
  return "in_stock";
}

export function isOrderable(product) {
  const availability = availabilityOf(product);
  return product.status === "active" && (availability === "in_stock" || availability === "low_stock");
}

function toIso(value) {
  if (!value) return null;
  if (typeof value.toDate === "function") return value.toDate().toISOString();
  return value;
}

/* ---------------------------------------------------------
   SERIALISERS
--------------------------------------------------------- */

// Legacy records store "OSS_001.jpg"; responses always use "/OSS_001.jpg".
function publicImages(images) {
  return (images || []).map(toPublicPath).filter(Boolean);
}

export function adminView(id, data) {
  const images = publicImages(data.images);
  return {
    id,
    ...data,
    images,
    imageStatus: imageStatus(images),
    specs: data.specs || [],
    needsReview: data.needsReview || [],
    availability: availabilityOf(data),
    availableQty: availableQty(data),
    effectivePrice: effectiveUnitPrice(data),
    createdAt: toIso(data.createdAt),
    updatedAt: toIso(data.updatedAt)
  };
}

// Only what a customer needs. Exact stock counts and internal notes stay private.
export function publicView(id, data) {
  const availability = availabilityOf(data);
  return {
    id,
    sku: data.sku,
    name: data.name,
    description: data.description || "",
    categoryId: data.categoryId,
    categoryName: data.categoryName,
    subcategoryId: data.subcategoryId || null,
    subcategoryName: data.subcategoryName || "",
    price: data.price ?? null,
    salePrice: data.salePrice ?? null,
    effectivePrice: effectiveUnitPrice(data),
    minQty: data.minQty || 1,
    unit: data.unit || "pcs",
    specs: data.specs || [],
    // Only photos that exist; the website shows a placeholder otherwise.
    images: publicImages(data.images).filter(src => normalizeImagePath(src).kind === "external" || localImageExists(src)),
    availability,
    orderable: isOrderable(data),
    featured: Boolean(data.featured),
    sortOrder: data.sortOrder ?? 9999,
    createdAt: toIso(data.createdAt)
  };
}

/* ---------------------------------------------------------
   PUBLIC CATALOGUE
--------------------------------------------------------- */

export async function listPublicProducts() {
  const snap = await products().where("status", "==", "active").get();
  return snap.docs
    .map(doc => publicView(doc.id, doc.data()))
    .sort((a, b) => a.sortOrder - b.sortOrder || a.sku.localeCompare(b.sku, "en", { numeric: true }));
}

export async function getPublicProductBySku(sku) {
  const snap = await products().where("sku", "==", normalizeSku(sku)).limit(1).get();
  const doc = snap.docs[0];
  if (!doc || doc.get("status") !== "active") throw notFound("This product is not available.");
  return publicView(doc.id, doc.data());
}

/* ---------------------------------------------------------
   ADMIN READS
--------------------------------------------------------- */

export async function listAdminProducts() {
  const snap = await products().get();
  return snap.docs
    .map(doc => adminView(doc.id, doc.data()))
    .sort((a, b) => (a.sortOrder ?? 9999) - (b.sortOrder ?? 9999) || a.sku.localeCompare(b.sku, "en", { numeric: true }));
}

export async function getAdminProduct(id) {
  const snap = await products().doc(id).get();
  if (!snap.exists) throw notFound("Product not found.");
  return adminView(snap.id, snap.data());
}

/* ---------------------------------------------------------
   INPUT
--------------------------------------------------------- */

function parseSpecs(raw, v) {
  if (raw === undefined) return undefined;
  const list = Array.isArray(raw)
    ? raw
    : String(raw || "").split("\n").map(line => {
      const index = line.indexOf(":");
      return index > 0 ? { label: line.slice(0, index), value: line.slice(index + 1) } : { label: "", value: line };
    });
  const clean = list
    .map(item => ({ label: String(item?.label ?? "").trim().slice(0, 60), value: String(item?.value ?? "").trim().slice(0, 300) }))
    .filter(item => item.label || item.value);
  if (clean.length > 30) v.fail("specs", "Up to 30 specifications are allowed.");
  return clean;
}

function parseImages(raw, v) {
  if (raw === undefined) return undefined;
  const list = Array.isArray(raw) ? raw : String(raw || "").split(/[\n|]/);
  const clean = [];
  for (const item of list) {
    const text = String(item ?? "").trim();
    if (!text) continue;
    const image = normalizeImagePath(text);
    if (!image) {
      v.fail("images", `"${text.slice(0, 60)}" is not a valid image. Upload images through the admin panel.`);
      continue;
    }
    if (!clean.includes(image.path)) clean.push(image.path);
  }
  if (clean.length > 8) v.fail("images", "Up to 8 images are allowed.");
  return clean;
}

// Parses fields shared by create, update and CSV import.
// `partial` = only validate fields that are present (updates).
export function parseProductInput(input, { partial = false } = {}) {
  const v = new Validator(input);
  const out = {};
  const want = field => !partial || v.has(field);

  if (want("sku")) out.sku = v.string("sku", { required: !partial && !v.bool("generateSku"), max: 32, transform: normalizeSku, pattern: SKU_PATTERN, label: "SKU" });
  if (want("name")) out.name = v.string("name", { required: true, max: 160, label: "Product name" });
  if (want("description")) out.description = v.string("description", { max: 4000 });
  if (want("unit")) out.unit = v.string("unit", { max: 20 }) || "pcs";
  if (want("hsn")) out.hsn = v.string("hsn", { max: 8, pattern: /^\d{4,8}$/, label: "HSN code" });

  if (want("price")) out.price = v.money("price", { label: "Price" });
  if (want("salePrice")) out.salePrice = v.money("salePrice", { label: "Discounted price" });
  if (want("gstRate")) out.gstRate = v.number("gstRate", { allowed: GST_RATES, label: "GST rate" });

  if (want("minQty")) out.minQty = v.int("minQty", { min: 1, max: 100000, label: "Minimum order quantity" }) ?? 1;
  if (want("lowStockThreshold")) out.lowStockThreshold = v.int("lowStockThreshold", { min: 0, max: 1000000, nullable: true, label: "Low-stock threshold" });
  if (want("manualStatus")) out.manualStatus = v.oneOf("manualStatus", MANUAL_STATUSES, { fallback: "in_stock" });
  if (want("status")) out.status = v.oneOf("status", PRODUCT_STATUSES, { fallback: "active" });
  if (want("featured")) out.featured = v.bool("featured");
  if (want("sortOrder")) out.sortOrder = v.int("sortOrder", { min: 0, max: 100000, nullable: true }) ?? 9999;

  if (want("specs")) out.specs = parseSpecs(input.specs, v) ?? [];
  if (want("images")) out.images = parseImages(input.images, v) ?? [];

  if (want("categoryId")) out.categoryId = v.string("categoryId", { max: 80 });
  if (want("subcategoryId")) out.subcategoryId = v.string("subcategoryId", { max: 80 });
  const newCategoryName = v.string("newCategoryName", { max: 80, label: "New category" });

  if (!partial && !out.categoryId && !newCategoryName) v.fail("categoryId", "Choose a category or create a new one.");
  if (out.salePrice !== undefined && out.salePrice !== null) {
    if (out.price === null || out.price === undefined) v.fail("salePrice", "Set the regular price before a discounted price.");
    else if (out.salePrice >= out.price) v.fail("salePrice", "Discounted price must be lower than the regular price.");
  }

  v.assert();
  for (const key of Object.keys(out)) if (out[key] === undefined) delete out[key];
  return { fields: out, newCategoryName };
}

/* ---------------------------------------------------------
   SKU GENERATION
--------------------------------------------------------- */

async function nextSkuInTx(tx) {
  const counterRef = db().collection("counters").doc("sku");
  const counter = await tx.get(counterRef);
  let next = counter.exists ? counter.get("next") : null;

  if (!next) {
    const all = await tx.get(db().collection("skuIndex"));
    const highest = all.docs
      .map(doc => Number((doc.id.match(/^OSS_(\d+)$/) || [])[1] || 0))
      .reduce((a, b) => Math.max(a, b), 0);
    next = highest + 1;
  }

  // Skip any number already taken (e.g. a manually entered SKU).
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const sku = `OSS_${String(next).padStart(3, "0")}`;
    const taken = await tx.get(skuIndex(sku));
    if (!taken.exists) {
      const value = next + 1;
      return { sku, write: () => tx.set(counterRef, { next: value }, { merge: true }) };
    }
    next += 1;
  }
  throw conflict("Could not generate a unique SKU. Please enter one manually.");
}

/* ---------------------------------------------------------
   CATEGORY RESOLUTION
--------------------------------------------------------- */

// Reads only. Returns the category fields and deferred writes (if a new
// category has to be created) because transactions must read before writing.
async function resolveCategories(tx, fields, newCategoryName, actor) {
  const result = {};
  const writes = [];
  if (newCategoryName) {
    const prepared = await prepareCategoryInTx(tx, newCategoryName, null, actor);
    writes.push(prepared.write);
    result.categoryId = prepared.category.id;
    result.categoryName = prepared.category.name;
  } else if (fields.categoryId !== undefined) {
    const snap = await tx.get(db().collection("categories").doc(fields.categoryId));
    if (!snap.exists || snap.get("parentId")) throw badRequest("Choose a valid category.", { fields: { categoryId: "Choose a valid category." } });
    if (snap.get("archived")) throw badRequest("This category is archived.", { fields: { categoryId: "This category is archived." } });
    result.categoryId = snap.id;
    result.categoryName = snap.get("name");
  }

  if (fields.subcategoryId !== undefined) {
    if (!fields.subcategoryId) {
      result.subcategoryId = null;
      result.subcategoryName = "";
    } else {
      const snap = await tx.get(db().collection("categories").doc(fields.subcategoryId));
      const parent = result.categoryId ?? fields.categoryId;
      if (!snap.exists || (parent && snap.get("parentId") !== parent)) {
        throw badRequest("Subcategory does not belong to the selected category.", { fields: { subcategoryId: "Choose a subcategory of the selected category." } });
      }
      result.subcategoryId = snap.id;
      result.subcategoryName = snap.get("name");
    }
  }
  return { result, writes };
}

/* ---------------------------------------------------------
   CREATE
--------------------------------------------------------- */

export async function createProduct(input, admin) {
  const { fields, newCategoryName } = parseProductInput(input);
  const actor = actorOf(admin);
  const ref = products().doc();

  await db().runTransaction(async tx => {
    let sku = fields.sku;
    const writes = [];
    if (sku) {
      const existing = await tx.get(skuIndex(sku));
      if (existing.exists) throw conflict(`SKU ${sku} is already used by another product.`, { fields: { sku: "This SKU already exists." } });
    } else {
      const generated = await nextSkuInTx(tx);
      sku = generated.sku;
      writes.push(generated.write);
    }

    const { result: category, writes: categoryWrites } = await resolveCategories(tx, fields, newCategoryName, actor);
    writes.push(...categoryWrites);
    const resolved = await resolveProductImages(tx, ref.id, fields.images || [], {});
    writes.push(resolved.write);

    const product = {
      description: "", unit: "pcs", hsn: "", price: null, salePrice: null, gstRate: null,
      minQty: 1, lowStockThreshold: null, manualStatus: "in_stock", status: "active",
      featured: false, sortOrder: 9999, specs: [], images: [],
      ...fields,
      ...category,
      images: resolved.images,
      imageAssets: resolved.imageAssets,
      sku,
      trackStock: false,
      stockQty: 0,
      reservedQty: 0,
      orderCount: 0,
      needsReview: [],
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
      createdBy: actor,
      updatedBy: actor
    };

    writes.forEach(write => write());
    tx.set(skuIndex(sku), { productId: ref.id });
    tx.set(ref, product);
    tx.set(auditRef(), auditEntry(actor, "product.create", "product", ref.id, { sku, name: product.name }));
  });

  return getAdminProduct(ref.id);
}

/* ---------------------------------------------------------
   UPDATE
--------------------------------------------------------- */

export async function updateProduct(id, input, admin) {
  const { fields, newCategoryName } = parseProductInput(input, { partial: true });
  const actor = actorOf(admin);
  const ref = products().doc(id);

  // Allow clearing review flags explicitly after the owner checks a product.
  const clearReview = Array.isArray(input?.resolveReview) ? input.resolveReview.map(String) : null;

  await db().runTransaction(async tx => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw notFound("Product not found.");
    const current = snap.data();

    // Optimistic concurrency: refuse to save over changes made on another device.
    if (input?.expectedUpdatedAt && toIso(current.updatedAt) !== input.expectedUpdatedAt) {
      throw conflict("This product was changed by someone else after you opened it. Reload to see the latest version, then reapply your changes.", { stale: true });
    }

    const update = { ...fields };
    const merged = { ...current, ...update };

    if (merged.salePrice !== null && merged.salePrice !== undefined) {
      if (merged.price === null || merged.price === undefined || merged.salePrice >= merged.price) {
        throw badRequest("Discounted price must be lower than the regular price.", { fields: { salePrice: "Discounted price must be lower than the regular price." } });
      }
    }

    const skuChanged = update.sku && update.sku !== current.sku;
    if (skuChanged) {
      const taken = await tx.get(skuIndex(update.sku));
      if (taken.exists && taken.get("productId") !== id) {
        throw conflict(`SKU ${update.sku} is already used by another product.`, { fields: { sku: "This SKU already exists." } });
      }
    }

    const { result: category, writes } = await resolveCategories(tx, {
      ...fields,
      // Validate a subcategory against the product's current category when the category is unchanged.
      categoryId: fields.categoryId ?? (fields.subcategoryId !== undefined && !newCategoryName ? current.categoryId : undefined)
    }, newCategoryName, actor);
    Object.assign(update, category);
    if ((update.categoryId && update.categoryId !== current.categoryId) && fields.subcategoryId === undefined) {
      update.subcategoryId = null;
      update.subcategoryName = "";
    }

    if (fields.images !== undefined) {
      const resolved = await resolveProductImages(tx, id, fields.images, current);
      update.images = resolved.images;
      update.imageAssets = resolved.imageAssets;
      writes.push(resolved.write);
    }

    writes.forEach(write => write());
    if (skuChanged) {
      tx.delete(skuIndex(current.sku));
      tx.set(skuIndex(update.sku), { productId: id });
    }

    if (clearReview) {
      update.needsReview = (current.needsReview || []).filter(item => !clearReview.includes(item.field));
    }

    update.updatedAt = FieldValue.serverTimestamp();
    update.updatedBy = actor;

    tx.update(ref, update);
    tx.set(auditRef(), auditEntry(actor, "product.update", "product", id, {
      sku: update.sku || current.sku,
      changed: Object.keys(fields).concat(newCategoryName ? ["category"] : [])
    }));
  });

  return getAdminProduct(id);
}

/* ---------------------------------------------------------
   DELETE (only products never used in an order)
--------------------------------------------------------- */

export async function deleteProduct(id, admin) {
  const actor = actorOf(admin);
  const ref = products().doc(id);
  await db().runTransaction(async tx => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw notFound("Product not found.");
    const product = snap.data();
    if ((product.orderCount || 0) > 0) {
      throw conflict("This product appears in existing orders. Archive it instead so order history stays intact.");
    }
    if (product.trackStock && (product.stockQty || 0) > 0) {
      throw conflict("This product still has stock recorded. Archive it, or adjust stock to zero first.");
    }
    const release = await releaseProductImages(tx, id, product);
    release();
    tx.delete(skuIndex(product.sku));
    tx.delete(ref);
    tx.set(auditRef(), auditEntry(actor, "product.delete", "product", id, { sku: product.sku, name: product.name }));
  });
  return { deleted: true };
}

export { categoryIdFor };
