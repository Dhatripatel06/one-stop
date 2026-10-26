/* =========================================================
   CATEGORIES & SUBCATEGORIES
   A subcategory is a category document with parentId set.
   Category IDs are slugs derived from the name at creation time.
========================================================= */

import { db, FieldValue } from "./firebase.js";
import { Validator } from "./validate.js";
import { badRequest, conflict, notFound } from "./http.js";
import { auditEntry, auditRef } from "./audit.js";
import { actorOf } from "./auth.js";

const categories = () => db().collection("categories");

export function categoryIdFor(name, parentId) {
  const slug = String(name).toLowerCase().normalize("NFKD")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "category";
  return parentId ? `${parentId}--${slug}` : slug;
}

function view(doc, counts = {}) {
  const data = doc.data();
  return {
    id: doc.id,
    name: data.name,
    description: data.description || "",
    parentId: data.parentId || null,
    sortOrder: data.sortOrder ?? 9999,
    archived: Boolean(data.archived),
    productCount: counts[doc.id] || 0
  };
}

async function productCounts({ activeOnly }) {
  const query = activeOnly
    ? db().collection("products").where("status", "==", "active")
    : db().collection("products").where("status", "in", ["active", "inactive"]);
  const snap = await query.select("categoryId", "subcategoryId").get();
  const counts = {};
  for (const doc of snap.docs) {
    const { categoryId, subcategoryId } = doc.data();
    if (categoryId) counts[categoryId] = (counts[categoryId] || 0) + 1;
    if (subcategoryId) counts[subcategoryId] = (counts[subcategoryId] || 0) + 1;
  }
  return counts;
}

function sortCategories(list) {
  return list.sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
}

export async function listPublicCategories() {
  const [snap, counts] = await Promise.all([categories().get(), productCounts({ activeOnly: true })]);
  return sortCategories(snap.docs.map(doc => view(doc, counts)))
    .filter(category => !category.archived && category.productCount > 0);
}

export async function listAdminCategories() {
  const [snap, counts] = await Promise.all([categories().get(), productCounts({ activeOnly: false })]);
  return sortCategories(snap.docs.map(doc => view(doc, counts)));
}

/* ---------------------------------------------------------
   Transaction helper used when a product form creates a
   category on the fly. Performs reads only; returns a write
   function the caller runs after all reads are complete.
--------------------------------------------------------- */

export async function prepareCategoryInTx(tx, name, parentId, actor) {
  const clean = String(name || "").trim().slice(0, 80);
  if (!clean) throw badRequest("Category name is required.");
  const id = categoryIdFor(clean, parentId);
  const ref = categories().doc(id);
  const snap = await tx.get(ref);

  if (snap.exists) {
    return { category: { id, name: snap.get("name") }, write: () => {} };
  }

  return {
    category: { id, name: clean },
    write: () => {
      tx.set(ref, {
        name: clean,
        description: "",
        parentId: parentId || null,
        sortOrder: 9999,
        archived: false,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp()
      });
      tx.set(auditRef(), auditEntry(actor, "category.create", "category", id, { name: clean, parentId: parentId || null }));
    }
  };
}

/* ---------------------------------------------------------
   ADMIN WRITES
--------------------------------------------------------- */

export async function createCategory(input, admin) {
  const v = new Validator(input);
  const name = v.string("name", { required: true, max: 80, label: "Category name" });
  const description = v.string("description", { max: 500 });
  const parentId = v.string("parentId", { max: 80 }) || null;
  v.assert();

  const id = categoryIdFor(name, parentId);
  const actor = actorOf(admin);

  await db().runTransaction(async tx => {
    const ref = categories().doc(id);
    const [snap, parent] = await Promise.all([
      tx.get(ref),
      parentId ? tx.get(categories().doc(parentId)) : Promise.resolve(null)
    ]);
    if (snap.exists) throw conflict("A category with this name already exists.", { fields: { name: "This category already exists." } });
    if (parentId && (!parent.exists || parent.get("parentId"))) {
      throw badRequest("Parent category not found.", { fields: { parentId: "Choose a top-level category." } });
    }
    tx.set(ref, {
      name, description, parentId, sortOrder: 9999, archived: false,
      createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp()
    });
    tx.set(auditRef(), auditEntry(actor, "category.create", "category", id, { name, parentId }));
  });

  return { id, name, description, parentId };
}

export async function updateCategory(id, input, admin) {
  const v = new Validator(input);
  const name = v.has("name") ? v.string("name", { required: true, max: 80, label: "Category name" }) : undefined;
  const description = v.has("description") ? v.string("description", { max: 500 }) : undefined;
  v.assert();

  const actor = actorOf(admin);
  const ref = categories().doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw notFound("Category not found.");

  const update = { updatedAt: FieldValue.serverTimestamp() };
  if (name !== undefined) update.name = name;
  if (description !== undefined) update.description = description;

  const batch = db().batch();
  batch.update(ref, update);

  // Keep the denormalised name on products in sync. Order and invoice
  // snapshots are deliberately left untouched.
  if (name && name !== snap.get("name")) {
    const field = snap.get("parentId") ? "subcategoryId" : "categoryId";
    const nameField = snap.get("parentId") ? "subcategoryName" : "categoryName";
    const affected = await db().collection("products").where(field, "==", id).get();
    affected.docs.forEach(doc => batch.update(doc.ref, { [nameField]: name }));
  }
  batch.set(auditRef(), auditEntry(actor, "category.update", "category", id, { name, description }));
  await batch.commit();
  return { id, ...update, updatedAt: undefined };
}

export async function reorderCategories(input, admin) {
  const ids = Array.isArray(input?.ids) ? input.ids.map(String) : null;
  if (!ids || !ids.length || ids.length > 500) throw badRequest("Provide the category IDs in their new order.");
  const batch = db().batch();
  ids.forEach((id, index) => batch.update(categories().doc(id), { sortOrder: index }));
  batch.set(auditRef(), auditEntry(actorOf(admin), "category.reorder", "category", "*", { ids }));
  await batch.commit();
  return { ok: true };
}

// Archiving requires that no active/inactive product still uses the category,
// unless a reassignment target is supplied.
export async function archiveCategory(id, input, admin) {
  const actor = actorOf(admin);
  const reassignTo = input?.reassignTo ? String(input.reassignTo) : null;
  const ref = categories().doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw notFound("Category not found.");
  const isSub = Boolean(snap.get("parentId"));
  const field = isSub ? "subcategoryId" : "categoryId";

  const [inUse, children] = await Promise.all([
    db().collection("products").where(field, "==", id).get(),
    isSub ? Promise.resolve({ empty: true, docs: [] }) : categories().where("parentId", "==", id).get()
  ]);
  const liveProducts = inUse.docs.filter(doc => doc.get("status") !== "archived");

  if (!isSub && children.docs.some(doc => !doc.get("archived"))) {
    throw conflict("Archive or move this category's subcategories first.");
  }

  let target = null;
  if (liveProducts.length) {
    if (!reassignTo) {
      throw conflict(`${liveProducts.length} product(s) still use this category. Reassign them first.`, { productCount: liveProducts.length });
    }
    const targetSnap = await categories().doc(reassignTo).get();
    if (!targetSnap.exists || targetSnap.get("archived") || reassignTo === id) throw badRequest("Choose a valid category to move products into.");
    if (Boolean(targetSnap.get("parentId")) !== isSub) throw badRequest("Products must move to a category of the same level.");
    target = { id: targetSnap.id, name: targetSnap.get("name") };
  }

  const batch = db().batch();
  for (const doc of liveProducts) {
    batch.update(doc.ref, isSub
      ? { subcategoryId: target.id, subcategoryName: target.name }
      : { categoryId: target.id, categoryName: target.name, subcategoryId: null, subcategoryName: "" });
  }
  batch.update(ref, { archived: true, updatedAt: FieldValue.serverTimestamp() });
  batch.set(auditRef(), auditEntry(actor, "category.archive", "category", id, { reassignedTo: target?.id || null, moved: liveProducts.length }));
  await batch.commit();
  return { archived: true, moved: liveProducts.length };
}

export async function restoreCategory(id, admin) {
  const ref = categories().doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw notFound("Category not found.");
  await ref.update({ archived: false, updatedAt: FieldValue.serverTimestamp() });
  await auditRef().set(auditEntry(actorOf(admin), "category.restore", "category", id, {}));
  return { archived: false };
}
