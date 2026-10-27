/* =========================================================
   IMAGE ASSET REGISTRY (Firestore collection imageAssets)
   One document per Cloudinary image: URL, public ID, size, and the
   products that use it. Products may only reference registered images,
   so a pasted URL cannot point a product at someone else's file.

   status: "unused"  uploaded or no longer referenced by any product
           "in_use"  referenced by at least one product
           "deleted" removed from Cloudinary (record kept for history)
========================================================= */

import { db, FieldValue } from "./firebase.js";
import { HttpError, badRequest, conflict, notFound } from "./http.js";
import { auditEntry, auditRef } from "./audit.js";
import { actorOf } from "./auth.js";
import * as cloud from "./cloudinary.js";
import { normalizeImagePath } from "./local-images.js";

const assets = () => db().collection("imageAssets");
export const assetIdFor = publicId => String(publicId).replace(/\//g, "__");

function iso(value) {
  return value?.toDate ? value.toDate().toISOString() : value || null;
}

function view(doc) {
  const data = doc.data();
  return { id: doc.id, ...data, productIds: data.productIds || [], createdAt: iso(data.createdAt), updatedAt: iso(data.updatedAt), deletedAt: iso(data.deletedAt) };
}

function assetRecord(resource, source, actor) {
  return {
    publicId: resource.public_id,
    url: resource.secure_url,
    version: Number(resource.version),
    format: resource.format,
    width: resource.width || null,
    height: resource.height || null,
    bytes: resource.bytes || null,
    status: "unused",
    productIds: [],
    source,
    uploadedBy: actor,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp()
  };
}

async function checkResource(publicId) {
  const resource = await cloud.getResource(publicId);
  const problems = [];
  if (!cloud.ALLOWED_FORMATS.includes(String(resource.format).toLowerCase())) problems.push("Only JPEG, PNG or WebP images are allowed.");
  if (resource.bytes > cloud.MAX_IMAGE_BYTES) problems.push("Images must be 8 MB or smaller.");
  if (problems.length) {
    await cloud.destroy(publicId).catch(() => {});
    throw badRequest(problems.join(" "));
  }
  return resource;
}

/* ---------------------------------------------------------
   UPLOAD FLOW
--------------------------------------------------------- */

export function uploadSignature(input) {
  return cloud.createUploadSignature(input?.sku);
}

// Called by the admin panel after the browser uploaded directly to Cloudinary.
export async function confirmUpload(input, admin) {
  const config = cloud.cloudinaryConfig();
  const publicId = String(input?.public_id || "");
  if (!publicId.startsWith(`${config.folder}/`)) throw badRequest("This image was not uploaded through the OSS admin panel.");
  if (!cloud.verifyUploadSignature(input, config.apiSecret)) throw badRequest("The upload response could not be verified. Please upload the image again.");

  const resource = await checkResource(publicId);
  const ref = assets().doc(assetIdFor(publicId));
  const existing = await ref.get();
  if (!existing.exists) {
    await ref.set(assetRecord(resource, "upload", actorOf(admin)));
    await auditRef().set(auditEntry(actorOf(admin), "image.upload", "imageAsset", ref.id, { publicId, bytes: resource.bytes }));
  }
  return view(await ref.get());
}

// Cloudinary fetches the remote file itself, so our server never downloads it.
export async function importFromUrl(input, admin) {
  const url = String(input?.url || "").trim();
  if (!/^https:\/\//i.test(url)) throw badRequest("Enter an https:// image link.", { fields: { url: "Enter an https:// image link." } });
  if (cloud.isOwnCloudinaryUrl(url)) throw badRequest("This image is already in Cloudinary. Choose it from the image library instead.");
  const result = await cloud.uploadFromServer(url, { publicId: cloud.newPublicId(input?.sku) });
  const resource = await checkResource(result.public_id);
  const ref = assets().doc(assetIdFor(resource.public_id));
  await ref.set(assetRecord(resource, "url", actorOf(admin)));
  await auditRef().set(auditEntry(actorOf(admin), "image.import", "imageAsset", ref.id, { publicId: resource.public_id, from: url.slice(0, 200) }));
  return view(await ref.get());
}

export async function listAssets({ status } = {}) {
  const query = status ? assets().where("status", "==", status) : assets();
  const snap = await query.limit(500).get();
  return snap.docs.map(view).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

// Owner only. Refuses while any product still uses the image.
export async function deleteAsset(id, admin) {
  const ref = assets().doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw notFound("Image not found.");
  const asset = snap.data();
  if (asset.status === "deleted") throw conflict("This image was already deleted.");
  if ((asset.productIds || []).length) throw conflict(`This image is still used by ${asset.productIds.length} product(s). Remove it from those products first.`);

  await cloud.destroy(asset.publicId);
  await ref.update({ status: "deleted", deletedAt: FieldValue.serverTimestamp(), deletedBy: actorOf(admin), updatedAt: FieldValue.serverTimestamp() });
  await auditRef().set(auditEntry(actorOf(admin), "image.delete", "imageAsset", id, { publicId: asset.publicId }));
  return view(await ref.get());
}

/* ---------------------------------------------------------
   PRODUCT REFERENCES (used inside product transactions)
   Read phase: resolve the requested image list. Returns the clean lists
   and a write() to run after all reads.
--------------------------------------------------------- */

export async function resolveProductImages(tx, productId, requested, current = {}) {
  const currentImages = current.images || [];
  const currentAssets = current.imageAssets || [];
  const keptLegacy = new Set(currentImages.map(src => normalizeImagePath(src)?.path).filter(Boolean));

  const images = [];
  const imageAssets = [];
  const added = new Map();

  for (const src of requested) {
    const parsed = cloud.parseCloudinaryUrl(src);
    if (parsed) {
      const config = cloud.cloudinaryConfig();
      if (parsed.cloudName !== config.cloudName) throw badRequest("That Cloudinary image belongs to a different account.", { fields: { images: "Use images uploaded through this admin panel." } });
      const id = assetIdFor(parsed.publicId);
      if (!added.has(id)) {
        const snap = await tx.get(assets().doc(id));
        if (!snap.exists || snap.get("status") === "deleted") {
          throw badRequest("This image is not in the OSS image library. Upload it through the admin panel.", { fields: { images: "Upload images through the admin panel." } });
        }
        added.set(id, snap);
      }
      const snap = added.get(id);
      images.push(snap.get("url"));
      imageAssets.push({ url: snap.get("url"), publicId: snap.get("publicId") });
      continue;
    }
    // Images from before the Cloudinary migration may stay, but no new ones.
    const legacy = normalizeImagePath(src);
    if (legacy && keptLegacy.has(legacy.path)) {
      images.push(legacy.path);
      continue;
    }
    throw badRequest("New product images must be uploaded to Cloudinary through the admin panel.", { fields: { images: "Upload new images through the admin panel." } });
  }

  const keepIds = new Set(imageAssets.map(a => assetIdFor(a.publicId)));
  const removedIds = [...new Set(currentAssets.map(a => assetIdFor(a.publicId)))].filter(id => !keepIds.has(id));
  const removedSnaps = await Promise.all(removedIds.map(id => tx.get(assets().doc(id))));

  return {
    images,
    imageAssets,
    write() {
      for (const [id, snap] of added) {
        if ((snap.get("productIds") || []).includes(productId) && snap.get("status") === "in_use") continue;
        tx.update(assets().doc(id), { productIds: FieldValue.arrayUnion(productId), status: "in_use", updatedAt: FieldValue.serverTimestamp() });
      }
      for (const snap of removedSnaps) {
        if (!snap.exists) continue;
        const remaining = (snap.get("productIds") || []).filter(pid => pid !== productId);
        tx.update(snap.ref, {
          productIds: FieldValue.arrayRemove(productId),
          status: remaining.length ? "in_use" : "unused",
          updatedAt: FieldValue.serverTimestamp()
        });
      }
    }
  };
}

// Product deleted: release all its images.
export async function releaseProductImages(tx, productId, current) {
  const ids = [...new Set((current.imageAssets || []).map(a => assetIdFor(a.publicId)))];
  const snaps = await Promise.all(ids.map(id => tx.get(assets().doc(id))));
  return () => {
    for (const snap of snaps) {
      if (!snap.exists) continue;
      const remaining = (snap.get("productIds") || []).filter(pid => pid !== productId);
      tx.update(snap.ref, { productIds: FieldValue.arrayRemove(productId), status: remaining.length ? "in_use" : "unused", updatedAt: FieldValue.serverTimestamp() });
    }
  };
}

export function requireCloudinary() {
  if (!cloud.isConfigured()) throw new HttpError(503, "Image storage (Cloudinary) is not configured on the server.");
}
