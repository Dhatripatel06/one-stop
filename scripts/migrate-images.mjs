/* =========================================================
   MIGRATE PRODUCT IMAGES TO CLOUDINARY
   Moves each product's existing project-folder photo (/OSS_001.jpg …) into
   Cloudinary and re-points the product at it, keeping the product-to-image
   mapping exactly as it is.

     node scripts/migrate-images.mjs                   dry run (reads only)
     node scripts/migrate-images.mjs --apply           uploads + updates Firestore
     node scripts/migrate-images.mjs --only OSS_001,OSS_002
     node scripts/migrate-images.mjs --emulator --apply   Firestore emulator

   Live Firestore additionally needs --confirm-project=<FIREBASE_PROJECT_ID>.
   Credentials come from .env.local / .env (never printed).

   Safe to re-run:
   - public IDs are stable (<folder>/<SKU>) and never overwritten, so a second
     run reuses the first upload
   - products already on Cloudinary are skipped
   - the old paths are kept on the product as `legacyImages` for rollback
   - nothing is deleted from the repository or from Cloudinary
========================================================= */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const has = flag => args.includes(flag);
const valueOf = name => args.find(a => a.startsWith(`${name}=`))?.slice(name.length + 1)
  ?? (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);

const APPLY = has("--apply");
const ONLY = (valueOf("--only") || "").split(",").map(s => s.trim().toUpperCase()).filter(Boolean);

if (has("--emulator")) {
  process.env.FIREBASE_MODE = "emulator";
  process.env.FIRESTORE_EMULATOR_HOST ||= "127.0.0.1:8080";
  process.env.FIREBASE_PROJECT_ID = process.env.EMULATOR_PROJECT_ID || "demo-oss";
}
const { loadEnv } = await import("./load-env.mjs");
// An explicit --emulator run must not pick up live Firebase settings from .env.
loadEnv([".env.local", ".env"], has("--emulator") ? /^CLOUDINARY_/ : null);

const { db, FieldValue, firebaseMode } = await import("../server/firebase.js");
const cloud = await import("../server/cloudinary.js");
const { assetIdFor } = await import("../server/image-assets.js");
const { normalizeImagePath } = await import("../server/local-images.js");

const MODE = firebaseMode();
const config = cloud.cloudinaryConfig();
console.log(`Firestore : ${MODE === "emulator" ? "emulator" : "LIVE"} project ${process.env.FIREBASE_PROJECT_ID}`);
console.log(`Cloudinary: cloud "${config.cloudName}", folder "${config.folder}"`);
console.log(APPLY ? "Mode      : APPLY (uploads and writes)\n" : "Mode      : dry run — nothing will be uploaded or written\n");

if (APPLY && MODE === "live") {
  const expected = `--confirm-project=${process.env.FIREBASE_PROJECT_ID}`;
  if (!args.includes(expected)) {
    console.error(`Refusing to change a live project without ${expected}.`);
    process.exit(1);
  }
}

const SYSTEM = { uid: "system", email: "migrate-images" };
const snap = await db().collection("products").get();
const products = snap.docs
  .map(doc => ({ ref: doc.ref, id: doc.id, ...doc.data() }))
  .filter(p => !ONLY.length || ONLY.includes(String(p.sku).toUpperCase()))
  .sort((a, b) => String(a.sku).localeCompare(String(b.sku), "en", { numeric: true }));

const report = { migrated: [], skipped: [], missing: [], failed: [], review: [] };

for (const product of products) {
  const sku = product.sku;
  const current = product.images || [];
  const todo = current.map(src => normalizeImagePath(src)).filter(Boolean);

  if (!todo.length) { report.skipped.push([sku, "no image"]); continue; }
  if (todo.every(item => cloud.parseCloudinaryUrl(item.path))) { report.skipped.push([sku, "already on Cloudinary"]); continue; }

  const newImages = [];
  const newAssets = [];
  const assetWrites = [];
  let failed = false;

  for (const [index, item] of todo.entries()) {
    if (cloud.parseCloudinaryUrl(item.path)) { newImages.push(item.path); continue; }
    if (item.kind !== "local") {
      // Not copied automatically: the owner must confirm the right to reuse a third-party photo.
      report.review.push([sku, `${item.path} is hosted elsewhere and was left as it is. Upload a photo you own (or confirm you may reuse it) in the admin panel.`]);
      failed = true;
      break;
    }
    const file = path.join(root, item.path.replace(/^\//, ""));
    if (!file.startsWith(root) || !fs.existsSync(file)) {
      report.missing.push([sku, item.path]);
      failed = true;
      break;
    }

    const publicId = `${config.folder}/${sku}${index ? `-${index + 1}` : ""}`;
    if (!APPLY) {
      console.log(`  would upload ${item.path} → ${publicId}`);
      newImages.push(item.path);
      continue;
    }

    try {
      const ext = path.extname(file).slice(1).toLowerCase().replace("jpg", "jpeg");
      const dataUri = `data:image/${ext};base64,${fs.readFileSync(file).toString("base64")}`;
      const uploaded = await cloud.uploadFromServer(dataUri, { publicId, tags: "oss-product,migrated" });
      const resource = await cloud.getResource(uploaded.public_id);
      const asset = {
        publicId: resource.public_id,
        url: resource.secure_url,
        version: Number(resource.version),
        format: resource.format,
        width: resource.width || null,
        height: resource.height || null,
        bytes: resource.bytes || null,
        status: "in_use",
        productIds: [product.id],
        source: "migration",
        migratedFrom: item.path,
        uploadedBy: SYSTEM,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp()
      };
      assetWrites.push([assetIdFor(resource.public_id), asset]);
      newImages.push(resource.secure_url);
      newAssets.push({ url: resource.secure_url, publicId: resource.public_id });
      console.log(`  ${sku}: ${item.path} → ${resource.secure_url}`);
    } catch (error) {
      // With overwrite=false an existing public ID is returned as-is (re-runs reuse it), so reaching here is a real failure.
      report.failed.push([sku, `${item.path}: ${error.message}`]);
      failed = true;
      break;
    }
  }

  if (failed) continue;
  if (!APPLY) { report.migrated.push([sku, todo.map(t => t.path).join(", ")]); continue; }

  const batch = db().batch();
  for (const [id, asset] of assetWrites) batch.set(db().collection("imageAssets").doc(id), asset, { merge: true });
  batch.update(product.ref, {
    images: newImages,
    imageAssets: newAssets,
    legacyImages: current,
    updatedAt: FieldValue.serverTimestamp()
  });
  batch.set(db().collection("auditLog").doc(), {
    action: "image.migrate", entity: "product", entityId: product.id, actor: SYSTEM,
    details: { sku, from: current, to: newImages }, at: FieldValue.serverTimestamp()
  });
  await batch.commit();
  report.migrated.push([sku, newImages.join(", ")]);
}

console.log(`\n${APPLY ? "Migrated" : "Would migrate"}: ${report.migrated.length}`);
console.log(`Skipped : ${report.skipped.length}${report.skipped.length ? ` (${[...new Set(report.skipped.map(s => s[1]))].join("; ")})` : ""}`);
if (report.review.length) console.log(`Needs your review (${report.review.length}):\n${report.review.map(([s, m]) => `  ${s}: ${m}`).join("\n")}`);
if (report.missing.length) console.log(`Missing files (${report.missing.length}):\n${report.missing.map(([s, f]) => `  ${s}: ${f}`).join("\n")}`);
if (report.failed.length) console.log(`Failed (${report.failed.length}):\n${report.failed.map(([s, m]) => `  ${s}: ${m}`).join("\n")}`);
if (!APPLY) console.log("\nRun with --apply to upload and update Firestore.");
process.exit(report.failed.length || report.missing.length ? 1 : 0);
