/* =========================================================
   PRODUCT IMAGES (Firebase Storage)
   - Uploads are checked by file signature, not just by extension.
   - Remote URLs can be copied into Storage so the catalogue does not
     depend on third-party hotlinks. Private and local network
     addresses are refused to prevent server-side request forgery.
========================================================= */

import crypto from "node:crypto";
import dns from "node:dns/promises";
import net from "node:net";
import { bucket } from "./firebase.js";
import { HttpError, badRequest } from "./http.js";
import { audit } from "./audit.js";
import { actorOf } from "./auth.js";
import { normalizeSku } from "../shared/constants.js";

const MAX_BYTES = 4 * 1024 * 1024;

function detectType(buffer) {
  if (buffer.length > 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return { ext: "jpg", type: "image/jpeg" };
  if (buffer.length > 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { ext: "png", type: "image/png" };
  if (buffer.length > 12 && buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP") return { ext: "webp", type: "image/webp" };
  return null;
}

function publicUrl(bucketName, objectPath, token) {
  const encoded = encodeURIComponent(objectPath);
  const emulator = process.env.FIREBASE_STORAGE_EMULATOR_HOST;
  const base = emulator ? `http://${emulator.replace(/^https?:\/\//, "")}` : "https://firebasestorage.googleapis.com";
  return `${base}/v0/b/${bucketName}/o/${encoded}?alt=media&token=${token}`;
}

async function store(buffer, sku, actor, source) {
  const detected = detectType(buffer);
  if (!detected) throw badRequest("Only JPEG, PNG or WebP images are allowed.");
  if (buffer.length > MAX_BYTES) throw badRequest("Images must be 4 MB or smaller.");

  let target;
  try {
    target = bucket();
    if (!target.name) throw new Error("no bucket");
  } catch {
    throw new HttpError(503, "Image storage is not configured. Set FIREBASE_STORAGE_BUCKET, or paste an image URL instead.");
  }

  const folder = normalizeSku(sku) || "unassigned";
  const objectPath = `product-images/${folder}/${Date.now()}-${crypto.randomBytes(4).toString("hex")}.${detected.ext}`;
  const token = crypto.randomUUID();

  try {
    await target.file(objectPath).save(buffer, {
      resumable: false,
      contentType: detected.type,
      metadata: {
        cacheControl: "public, max-age=31536000, immutable",
        metadata: { firebaseStorageDownloadTokens: token, uploadedBy: actor.email || actor.uid, source }
      }
    });
  } catch (error) {
    console.error("Storage upload failed:", error);
    throw new HttpError(502, "The image could not be saved to storage. Check that Firebase Storage is enabled for this project.");
  }

  await audit(actor, "image.upload", "image", objectPath, { sku: folder, source, bytes: buffer.length });
  return { url: publicUrl(target.name, objectPath, token), path: objectPath, bytes: buffer.length, contentType: detected.type };
}

export async function uploadImage(input, admin) {
  const data = String(input?.data || "").replace(/^data:[^;]+;base64,/, "");
  if (!data) throw badRequest("Choose an image to upload.");
  const buffer = Buffer.from(data, "base64");
  return store(buffer, input?.sku, actorOf(admin), "upload");
}

/* ---------------------------------------------------------
   REMOTE IMPORT
--------------------------------------------------------- */

function isPrivateAddress(address) {
  if (net.isIPv4(address)) {
    const [a, b] = address.split(".").map(Number);
    return a === 10 || a === 127 || a === 0 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) ||
      a >= 224;
  }
  const lower = address.toLowerCase();
  if (lower.startsWith("::ffff:")) return isPrivateAddress(lower.slice(7));
  return lower === "::1" || lower === "::" || lower.startsWith("fc") || lower.startsWith("fd") || lower.startsWith("fe80");
}

async function assertPublicHost(url) {
  if (url.protocol !== "https:") throw badRequest("Only https:// image links can be imported.");
  if (url.username || url.password) throw badRequest("Image links must not contain credentials.");
  const records = await dns.lookup(url.hostname, { all: true }).catch(() => []);
  if (!records.length) throw badRequest("The image host could not be found.");
  if (records.some(record => isPrivateAddress(record.address))) throw badRequest("This image address is not allowed.");
}

export async function fetchRemoteImage(rawUrl) {
  let url;
  try {
    url = new URL(String(rawUrl || "").trim());
  } catch {
    throw badRequest("Enter a valid image URL.");
  }

  for (let hop = 0; hop < 4; hop += 1) {
    await assertPublicHost(url);
    const response = await fetch(url, {
      redirect: "manual",
      signal: AbortSignal.timeout(10000),
      headers: { "User-Agent": "OSS-Catalog-ImageImport/1.0", Accept: "image/*" }
    }).catch(() => {
      throw badRequest("The image could not be downloaded.");
    });

    if (response.status >= 300 && response.status < 400 && response.headers.get("location")) {
      url = new URL(response.headers.get("location"), url);
      continue;
    }
    if (!response.ok) throw badRequest(`The image could not be downloaded (HTTP ${response.status}).`);

    const declared = Number(response.headers.get("content-length") || 0);
    if (declared > MAX_BYTES) throw badRequest("The image is larger than 4 MB.");

    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > MAX_BYTES) throw badRequest("The image is larger than 4 MB.");
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }
  throw badRequest("The image link redirects too many times.");
}

export async function importImageFromUrl(input, admin) {
  const buffer = await fetchRemoteImage(input?.url);
  return store(buffer, input?.sku, actorOf(admin), "url-import");
}

export { isPrivateAddress, detectType };
