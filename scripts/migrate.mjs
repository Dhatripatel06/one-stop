/* =========================================================
   LEGACY CATALOGUE MIGRATION
   Converts the original catalogue (products.json + legacy Firestore
   "products" documents) into the v2 schema used by the API.

   node scripts/migrate.mjs                 dry run, prints the report
   node scripts/migrate.mjs --apply         writes to Firestore
   node scripts/migrate.mjs --seed-legacy   (emulator only) resets the
        emulator and loads data/legacy-firestore-products.json to simulate
        production before migrating
   node scripts/migrate.mjs --include-snapshot
        also uses data/legacy-firestore-products.json (the old project's
        Firestore products, e.g. OSS_039/OSS_040) as a source — for a new,
        empty Firebase project
   Live writes need: --apply --confirm-project=<FIREBASE_PROJECT_ID>
   Credentials and FIREBASE_PROJECT_ID are read from .env.local.

   Rules:
   - Nothing is invented: prices, stock counts and descriptions that do
     not exist in the sources stay empty and are flagged for review.
   - Existing document IDs are kept. Already-migrated products are skipped.
   - Image paths from products.json win: they were visually verified.
     Legacy Firestore .webp paths point at other products' photos.
   - Images stay in the codebase; Firestore stores root-relative paths
     such as /OSS_001.jpg.
========================================================= */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = new Set(process.argv.slice(2));
const APPLY = args.has("--apply");
const INCLUDE_SNAPSHOT = args.has("--include-snapshot");
const confirmArg = process.argv.find(a => a.startsWith("--confirm-project="));

if (args.has("--emulator") || args.has("--seed-legacy")) {
  process.env.FIREBASE_MODE = "emulator";
  process.env.FIRESTORE_EMULATOR_HOST ||= "127.0.0.1:8080";
  process.env.FIREBASE_PROJECT_ID = process.env.EMULATOR_PROJECT_ID || "demo-oss";
} else {
  const { loadEnv } = await import("./load-env.mjs");
  loadEnv();
}

const { db, FieldValue, firebaseMode } = await import("../server/firebase.js");
const { toPublicPath } = await import("../server/local-images.js");

const MODE = firebaseMode();
console.log(`Target: ${MODE === "emulator" ? "Firebase emulator" : "LIVE Firebase"} project ${process.env.FIREBASE_PROJECT_ID}${APPLY ? "" : " (dry run — nothing will be written)"}`);
if (APPLY && MODE === "live" && confirmArg !== `--confirm-project=${process.env.FIREBASE_PROJECT_ID}`) {
  console.error(`Refusing to write to a live project without --confirm-project=${process.env.FIREBASE_PROJECT_ID}.`);
  process.exit(1);
}
const { categoryIdFor } = await import("../server/categories.js");
const { DEFAULT_SETTINGS } = await import("../server/settings.js");

const STATUS_MAP = { "in stock": "in_stock", "coming soon": "coming_soon", "out of stock": "out_of_stock" };

// Image checks performed during the audit (see docs/IMPORT_REPORT.md).
const IMAGE_NOTES = {
  OSS_039: "Image is a third-party marketplace photo (brand mark \"HOWOKE\", Amazon-style file name) hotlinked from i.ibb.co. Replace with a business-owned photo or confirm reuse rights."
};

function readJson(file) {
  return JSON.parse(fs.readFileSync(path.join(root, file), "utf8"));
}

function fromFirestoreRest(doc) {
  const value = v => v.stringValue ?? v.integerValue ?? v.doubleValue ?? v.booleanValue ?? v.timestampValue ?? null;
  const fields = Object.fromEntries(Object.entries(doc.fields || {}).map(([k, v]) => [k, value(v)]));
  return { id: doc.name.split("/").pop(), ...fields };
}

async function seedLegacy() {
  if (!process.env.FIRESTORE_EMULATOR_HOST) throw new Error("--seed-legacy only runs against the emulator.");
  // Start from an empty emulator database.
  const reset = await fetch(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${process.env.FIREBASE_PROJECT_ID}/databases/(default)/documents`, { method: "DELETE" });
  if (!reset.ok) throw new Error(`Could not reset the Firestore emulator (${reset.status}).`);
  const snapshot = readJson("data/legacy-firestore-products.json");
  const batch = db().batch();
  for (const doc of snapshot.documents) {
    const { id, createdAt, updatedAt, ...data } = fromFirestoreRest(doc);
    batch.set(db().collection("products").doc(id), {
      ...data,
      ...(createdAt ? { createdAt: new Date(createdAt) } : {}),
      ...(updatedAt ? { updatedAt: new Date(updatedAt) } : {})
    });
  }
  await batch.commit();
  console.log(`Seeded ${snapshot.documents.length} legacy product documents into the emulator.`);
}

function localImage(code) {
  for (const ext of ["jpg", "jpeg", "png", "webp"]) {
    if (fs.existsSync(path.join(root, `${code}.${ext}`))) return `${code}.${ext}`;
  }
  return null;
}

async function main() {
  if (args.has("--seed-legacy")) await seedLegacy();

  const master = readJson("products.json");
  const masterByCode = new Map(master.map((p, i) => [p.code.toUpperCase(), { ...p, order: i }]));

  const snap = await db().collection("products").get();
  const legacyDocs = [];
  const migrated = new Set();
  for (const doc of snap.docs) {
    const data = doc.data();
    if (data.schemaVersion === 2) migrated.add(String(data.sku).toUpperCase());
    else legacyDocs.push({ id: doc.id, ...data });
  }
  if (INCLUDE_SNAPSHOT) {
    const existingIds = new Set(snap.docs.map(doc => doc.id));
    for (const doc of readJson("data/legacy-firestore-products.json").documents) {
      const item = fromFirestoreRest(doc);
      if (existingIds.has(item.id)) continue;
      legacyDocs.push({ ...item, fromSnapshot: true });
    }
  }
  const legacyByCode = new Map();
  const duplicates = [];
  for (const doc of legacyDocs) {
    const code = String(doc.code || doc.id).trim().toUpperCase();
    if (legacyByCode.has(code)) duplicates.push({ code, ids: [legacyByCode.get(code).id, doc.id] });
    else legacyByCode.set(code, doc);
  }

  const codes = [...new Set([...masterByCode.keys(), ...legacyByCode.keys()])]
    .sort((a, b) => a.localeCompare(b, "en", { numeric: true }));

  const report = { imported: [], images: [], conflicts: [], missing: [], review: [], skipped: [], duplicates };
  const categories = new Map();
  const products = [];

  for (const code of codes) {
    if (migrated.has(code)) { report.skipped.push(code); continue; }
    const base = masterByCode.get(code);
    const live = legacyByCode.get(code);
    const liveLabel = live?.fromSnapshot ? "Firestore snapshot (oss-digital-catalog)" : "Firestore";
    const source = base && live ? `products.json + ${liveLabel}` : base ? "products.json" : `${liveLabel} (added by admin)`;

    let name = (base?.name || live?.name || "").trim();
    if (base && live && live.name && live.name.trim() !== base.name.trim()) {
      const sameIgnoringCase = live.name.trim().toUpperCase() === base.name.trim().toUpperCase();
      report.conflicts.push({ code, field: "name", values: [`products.json: ${base.name}`, `Firestore: ${live.name}`], resolution: sameIgnoringCase ? "Same text, different letter case — used the upper-case Firestore version to match the rest of the catalogue." : "Kept the Firestore (admin-edited) name." });
      name = live.name.trim();
    }

    const categoryName = (live?.category || base?.category || "Other").trim();
    if (base && live && live.category && live.category !== base.category) {
      report.conflicts.push({ code, field: "category", values: [base.category, live.category], resolution: "Kept the Firestore (admin-edited) category." });
    }
    if (!categories.has(categoryName)) categories.set(categoryName, categories.size);

    // Images
    let image = base?.image || null;
    let imageStatus = "verified";
    const liveImage = live?.image || "";
    if (base && liveImage && liveImage !== base.image) {
      report.conflicts.push({ code, field: "image", values: [`products.json: ${base.image}`, `Firestore: ${liveImage}`], resolution: `Kept ${base.image}: visually confirmed to show "${name}". ${liveImage} is a byte-identical copy of a different product's photo.` });
    }
    if (!base) {
      const local = localImage(code);
      if (local) {
        image = local;
        report.images.push({ code, image, note: `Copied from the hotlinked URL (${liveImage}) into the project.` });
      } else {
        image = liveImage || null;
        imageStatus = "needs_review";
      }
    }
    if (image && !image.startsWith("http") && !fs.existsSync(path.join(root, image))) {
      report.missing.push({ code, field: "image", note: `${image} is missing from the project.` });
      imageStatus = "needs_review";
    }
    if (IMAGE_NOTES[code]) imageStatus = "needs_review";
    if (image) report.images.push({ code, image, status: imageStatus });

    const statusText = String(live?.status || live?.stock || base?.status || "In Stock").toLowerCase();
    const needsReview = [
      { field: "price", note: "No verified price in the existing catalogue. Add a price or leave as \"Price on request\"." },
      { field: "stock", note: "No verified stock count. Record the initial stock in Inventory to enable stock tracking." }
    ];
    if (imageStatus === "needs_review") needsReview.push({ field: "image", note: IMAGE_NOTES[code] || "Image could not be verified." });

    const moqText = live?.moq || base?.moq || "";
    if (moqText && !/₹\s*500/.test(moqText)) {
      report.conflicts.push({ code, field: "moq", values: [moqText], resolution: "Non-standard MOQ text kept in legacy data; review minimum quantity." });
    }

    products.push({
      id: live?.id || code,
      code,
      source,
      doc: {
        schemaVersion: 2,
        sku: code,
        name,
        description: "",
        categoryId: categoryIdFor(categoryName),
        categoryName,
        subcategoryId: null,
        subcategoryName: "",
        price: null,
        salePrice: null,
        gstRate: null,
        hsn: "",
        minQty: 1,
        unit: "pcs",
        trackStock: false,
        stockQty: 0,
        reservedQty: 0,
        lowStockThreshold: null,
        manualStatus: STATUS_MAP[statusText] || "in_stock",
        status: "active",
        featured: false,
        sortOrder: base ? base.order : 1000 + products.length,
        specs: [],
        images: image ? [toPublicPath(image) || image] : [],
        orderCount: 0,
        needsReview,
        legacy: {
          code,
          name: live?.name ?? base?.name ?? null,
          category: live?.category ?? base?.category ?? null,
          image: liveImage || base?.image || null,
          status: live?.status ?? base?.status ?? null,
          moq: moqText || null
        },
        importedFrom: source,
        // Only a real creation date is kept; most legacy records have none.
        // Timestamp from Firestore, or an ISO string from the snapshot file.
        createdAt: !live?.createdAt ? null : typeof live.createdAt.toDate === "function" ? live.createdAt : new Date(live.createdAt),
        importedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp()
      }
    });

    report.imported.push({ code, name, category: categoryName, source, image: image || "—", imageStatus });
    if (needsReview.some(r => r.field === "image")) report.review.push({ code, issue: needsReview.find(r => r.field === "image").note });
  }

  report.missing.push({ code: "all", field: "price, sale price, GST rate, HSN", note: "Not present in any source." });
  report.missing.push({ code: "all", field: "stock quantity", note: "Only a status (\"In Stock\") exists; no counts." });
  report.missing.push({ code: "all", field: "description, specifications", note: "Not present in any source." });

  // --- write
  if (APPLY) {
    const writes = [];
    for (const [name, order] of categories) {
      const id = categoryIdFor(name);
      writes.push(b => b.set(db().collection("categories").doc(id), {
        name, description: "", parentId: null, sortOrder: order, archived: false,
        createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp()
      }, { merge: true }));
    }
    for (const p of products) {
      writes.push(b => b.set(db().collection("products").doc(p.id), p.doc));
      writes.push(b => b.set(db().collection("skuIndex").doc(p.code), { productId: p.id }));
    }
    const settingsRef = db().collection("settings").doc("business");
    const settingsSnap = await settingsRef.get();
    if (!settingsSnap.exists) writes.push(b => b.set(settingsRef, { ...DEFAULT_SETTINGS, createdAt: FieldValue.serverTimestamp() }));
    writes.push(b => b.set(db().collection("auditLog").doc(), {
      action: "migration.v2", entity: "catalogue", entityId: "*", actor: { uid: "system", email: "" },
      details: { products: products.length, categories: categories.size }, at: FieldValue.serverTimestamp()
    }));

    for (let i = 0; i < writes.length; i += 400) {
      const batch = db().batch();
      writes.slice(i, i + 400).forEach(write => write(batch));
      await batch.commit();
    }
  }

  // Keep the last full report when there is nothing left to migrate.
  if (products.length) writeReport(report, categories);
  console.log(`${APPLY ? "Migrated" : "Dry run:"} ${products.length} products, ${categories.size} categories. Skipped ${report.skipped.length} already-migrated.`);
  if (!APPLY) console.log("Run with --apply to write these changes.");
}

function writeReport(report, categories) {
  const lines = [];
  lines.push("# OSS Catalogue Import Report", "");
  lines.push(`Generated: ${new Date().toISOString()}`, "");
  lines.push("Sources, in priority order: local project files (products.json, images), legacy Firestore `products` collection (snapshot in `data/legacy-firestore-products.json`), live site https://oss-vert.vercel.app (identical to the repository apart from line endings), Instagram @onestopsolution4325 (only profile metadata is public: 36 posts; post content requires login and was not accessed).", "");
  lines.push(`## Products imported (${report.imported.length})`, "");
  lines.push("| SKU | Name | Category | Source | Image | Image check |", "|---|---|---|---|---|---|");
  for (const p of report.imported) lines.push(`| ${p.code} | ${p.name} | ${p.category} | ${p.source} | ${p.image.startsWith("http") ? "external URL" : p.image} | ${p.imageStatus === "verified" ? "✅ matches product" : "⚠️ needs review"} |`);
  lines.push("", `## Categories created (${categories.size})`, "", [...categories.keys()].map(c => `- ${c}`).join("\n"), "");
  lines.push("## Images", "");
  lines.push("All 38 `OSS_###.jpg` files were inspected visually and each shows the product named in products.json.", "");
  lines.push("Seven `.webp` files (OSS_008, 011, 013, 016, 020, 022, 024) are byte-identical copies of other products' photos (e.g. `OSS_008.webp` = `OSS_014.jpg`, the solar flood light). They are not used. `538822.jpg` is an identical copy of the logo `538820.jpg`. No files were deleted or renamed.", "");
  for (const i of report.images.filter(i => i.note)) lines.push(`- ${i.code}: ${i.note}`);
  lines.push("", `## Conflicting records (${report.conflicts.length})`, "");
  for (const c of report.conflicts) lines.push(`- **${c.code} · ${c.field}** — ${c.values.join(" vs ")}. ${c.resolution}`);
  if (report.duplicates.length) {
    lines.push("", "## Duplicate Firestore documents", "");
    for (const d of report.duplicates) lines.push(`- ${d.code}: documents ${d.ids.join(", ")} (first one used)`);
  } else {
    lines.push("", "## Duplicate records", "", "None found (no SKU appears in more than one Firestore document).");
  }
  lines.push("", "## Missing information", "");
  for (const m of report.missing) lines.push(`- ${m.code === "all" ? "All products" : m.code}: **${m.field}** — ${m.note}`);
  lines.push("", "## Items requiring administrator verification", "");
  lines.push("- **Every product:** price and initial stock count (shown on the admin dashboard as \"Needs review\" and \"Stock not counted\").");
  lines.push("- **Minimum order:** the catalogue states \"₹500 Minimum Order Quantity (MOQ)\". This is a minimum order *value* and is configured once in Settings (₹500). Per-product minimum quantities default to 1.");
  for (const r of report.review) lines.push(`- **${r.code}:** ${r.issue}`);
  if (report.skipped.length) lines.push("", `## Skipped (already migrated): ${report.skipped.join(", ")}`);
  fs.mkdirSync(path.join(root, "docs"), { recursive: true });
  fs.writeFileSync(path.join(root, "docs", "IMPORT_REPORT.md"), lines.join("\n") + "\n");
}

main().then(() => process.exit(0)).catch(error => {
  console.error(error);
  process.exit(1);
});
