/* =========================================================
   CLOUDINARY (product image storage and delivery)
   Server-only. The API secret never leaves this module: browsers receive
   a short-lived upload signature for one specific public ID, upload the
   file directly to Cloudinary, then ask the API to confirm the result.

   Env: CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET
        (or CLOUDINARY_URL=cloudinary://key:secret@cloud)
        CLOUDINARY_FOLDER (default "oss/products")
========================================================= */

import crypto from "node:crypto";
import { HttpError } from "./http.js";

export const ALLOWED_FORMATS = ["jpg", "jpeg", "png", "webp"];
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const SIGNATURE_TTL_SECONDS = 15 * 60;

export function cloudinaryConfig({ required = true } = {}) {
  let cloudName = process.env.CLOUDINARY_CLOUD_NAME;
  let apiKey = process.env.CLOUDINARY_API_KEY;
  let apiSecret = process.env.CLOUDINARY_API_SECRET;
  if ((!cloudName || !apiKey || !apiSecret) && process.env.CLOUDINARY_URL) {
    const match = process.env.CLOUDINARY_URL.match(/^cloudinary:\/\/([^:]+):([^@]+)@(.+)$/);
    if (match) [, apiKey, apiSecret, cloudName] = match;
  }
  const folder = (process.env.CLOUDINARY_FOLDER || "oss/products").replace(/^\/+|\/+$/g, "");
  const ok = Boolean(cloudName && apiKey && apiSecret);
  if (!ok && required) {
    throw new HttpError(503, "Image uploads are not configured: set CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY and CLOUDINARY_API_SECRET on the server.");
  }
  return ok ? { cloudName, apiKey, apiSecret, folder } : null;
}

export function isConfigured() {
  return Boolean(cloudinaryConfig({ required: false }));
}

/* ---------------------------------------------------------
   SIGNATURES (https://cloudinary.com/documentation/authentication_signatures)
--------------------------------------------------------- */

export function signParams(params, apiSecret) {
  const toSign = Object.keys(params)
    .filter(key => params[key] !== undefined && params[key] !== null && params[key] !== "" && !["file", "cloud_name", "resource_type", "api_key"].includes(key))
    .sort()
    .map(key => `${key}=${Array.isArray(params[key]) ? params[key].join(",") : params[key]}`)
    .join("&");
  return crypto.createHash("sha1").update(toSign + apiSecret).digest("hex");
}

// Upload responses carry signature = sha1("public_id=...&version=..." + secret).
export function verifyUploadSignature({ public_id: publicId, version, signature }, apiSecret) {
  if (!publicId || !version || !signature) return false;
  const expected = signParams({ public_id: publicId, version }, apiSecret);
  return expected.length === String(signature).length && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(String(signature)));
}

/* ---------------------------------------------------------
   URLS
--------------------------------------------------------- */

// Parses https://res.cloudinary.com/<cloud>/image/upload/[transformations/][v123/]<public_id>.<ext>
export function parseCloudinaryUrl(value) {
  let url;
  try { url = new URL(String(value)); } catch { return null; }
  if (url.protocol !== "https:" || url.hostname !== "res.cloudinary.com") return null;
  const match = url.pathname.match(/^\/([^/]+)\/image\/upload\/(?:.*?\/)?v(\d+)\/(.+)\.([a-z0-9]+)$/i);
  if (!match) return null;
  return { cloudName: match[1], version: match[2], publicId: decodeURIComponent(match[3]), format: match[4].toLowerCase() };
}

export function isOwnCloudinaryUrl(value) {
  const parsed = parseCloudinaryUrl(value);
  const config = cloudinaryConfig({ required: false });
  return Boolean(parsed && config && parsed.cloudName === config.cloudName);
}

/* ---------------------------------------------------------
   UPLOADS
--------------------------------------------------------- */

export function newPublicId(sku) {
  const { folder } = cloudinaryConfig();
  const base = String(sku || "product").toUpperCase().replace(/[^A-Z0-9_-]/g, "").slice(0, 40) || "PRODUCT";
  return `${folder}/${base}-${Date.now().toString(36)}${crypto.randomBytes(3).toString("hex")}`;
}

// Parameters the browser sends to Cloudinary's upload API, signed for one public ID.
export function createUploadSignature(sku) {
  const config = cloudinaryConfig();
  const params = {
    public_id: newPublicId(sku),
    timestamp: Math.floor(Date.now() / 1000),
    overwrite: "false",
    allowed_formats: ALLOWED_FORMATS.join(","),
    tags: "oss-product"
  };
  return {
    uploadUrl: `https://api.cloudinary.com/v1_1/${config.cloudName}/image/upload`,
    fields: { ...params, api_key: config.apiKey, signature: signParams(params, config.apiSecret) },
    expiresAt: new Date((params.timestamp + SIGNATURE_TTL_SECONDS) * 1000).toISOString(),
    maxBytes: MAX_IMAGE_BYTES
  };
}

// `lookup` = the request names an existing image, so a 404 means that image is gone.
// For uploads a 404 means Cloudinary could not fetch the source link.
async function cloudinaryFetch(url, init, action, { lookup = false } = {}) {
  let response;
  try {
    response = await fetch(url, { ...init, signal: AbortSignal.timeout(30000) });
  } catch {
    throw new HttpError(502, `Could not reach Cloudinary to ${action}. Check the internet connection and try again.`);
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = data?.error?.message || `HTTP ${response.status}`;
    if (response.status === 401 || response.status === 403) throw new HttpError(502, `Cloudinary rejected the credentials while trying to ${action}.`);
    if (response.status === 404 && lookup) throw new HttpError(404, `Image not found in Cloudinary (${message}).`);
    if (response.status === 404) throw new HttpError(400, `Cloudinary could not fetch that link: ${message}. Check that it opens an image.`);
    throw new HttpError(response.status >= 500 ? 502 : 400, `Cloudinary could not ${action}: ${message}`);
  }
  return data;
}

// Server-side upload: `file` may be a remote https URL or a data: URI.
export async function uploadFromServer(file, { publicId, tags = "oss-product" } = {}) {
  const config = cloudinaryConfig();
  const params = {
    public_id: publicId,
    timestamp: Math.floor(Date.now() / 1000),
    overwrite: "false",
    allowed_formats: ALLOWED_FORMATS.join(","),
    tags
  };
  const body = new URLSearchParams({ ...params, file, api_key: config.apiKey, signature: signParams(params, config.apiSecret) });
  return cloudinaryFetch(`https://api.cloudinary.com/v1_1/${config.cloudName}/image/upload`, { method: "POST", body }, "upload the image");
}

// Admin API — authoritative details about an uploaded image.
export async function getResource(publicId) {
  const config = cloudinaryConfig();
  const auth = Buffer.from(`${config.apiKey}:${config.apiSecret}`).toString("base64");
  const path = publicId.split("/").map(encodeURIComponent).join("/");
  return cloudinaryFetch(`https://api.cloudinary.com/v1_1/${config.cloudName}/resources/image/upload/${path}`, {
    headers: { Authorization: `Basic ${auth}` }
  }, "check the uploaded image", { lookup: true });
}

export async function destroy(publicId) {
  const config = cloudinaryConfig();
  const params = { public_id: publicId, timestamp: Math.floor(Date.now() / 1000), invalidate: "true" };
  const body = new URLSearchParams({ ...params, api_key: config.apiKey, signature: signParams(params, config.apiSecret) });
  const result = await cloudinaryFetch(`https://api.cloudinary.com/v1_1/${config.cloudName}/image/destroy`, { method: "POST", body }, "delete the image", { lookup: true });
  if (result.result !== "ok" && result.result !== "not found") throw new HttpError(502, `Cloudinary did not delete the image (${result.result}).`);
  return result.result;
}
