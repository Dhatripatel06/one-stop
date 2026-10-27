import { test } from "node:test";
import assert from "node:assert/strict";
import { isValidPhone, normalizePhone, normalizeSku, SKU_PATTERN, GSTIN_PATTERN } from "../../shared/constants.js";
import { normalizeImagePath } from "../../server/local-images.js";
import { parseCloudinaryUrl, signParams, verifyUploadSignature } from "../../server/cloudinary.js";
import { firebaseMode } from "../../server/firebase.js";
import { parseCsv } from "../../server/csv.js";
import { financialYear, signInvoiceLink, verifyShareLink } from "../../server/invoices.js";

test("phone numbers normalise to 91 + 10 digits", () => {
  assert.equal(normalizePhone("98765 43210"), "919876543210");
  assert.equal(normalizePhone("+91-98765-43210"), "919876543210");
  assert.equal(normalizePhone("09876543210"), "919876543210");
  assert.ok(isValidPhone("919876543210"));
  assert.ok(!isValidPhone("911234567890"));
  assert.ok(!isValidPhone("12345"));
});

test("SKUs are upper-cased and validated", () => {
  assert.equal(normalizeSku(" oss_041 "), "OSS_041");
  assert.equal(normalizeSku("oss 41"), "OSS_41");
  assert.ok(SKU_PATTERN.test("OSS_041"));
  assert.ok(!SKU_PATTERN.test("_BAD"));
  assert.ok(!SKU_PATTERN.test("A"));
  assert.ok(!SKU_PATTERN.test("HAS SPACE"));
});

test("GSTIN format", () => {
  assert.ok(GSTIN_PATTERN.test("24AAACB1234C1Z5"));
  assert.ok(!GSTIN_PATTERN.test("24AAACB1234C1X5"));
});

test("image paths: root-relative project paths or https only", () => {
  assert.deepEqual(normalizeImagePath("OSS_001.jpg"), { kind: "local", path: "/OSS_001.jpg" });
  assert.deepEqual(normalizeImagePath("/OSS_001.jpg"), { kind: "local", path: "/OSS_001.jpg" });
  assert.deepEqual(normalizeImagePath("/images/products/OSS_041.webp"), { kind: "local", path: "/images/products/OSS_041.webp" });
  assert.deepEqual(normalizeImagePath("https://example.com/a.webp"), { kind: "external", path: "https://example.com/a.webp" });
  for (const bad of [
    "C:\\Users\\PC\\one_stop_solution\\OSS_001.jpg", "OSS_001.jpg\\..\\x.jpg", "C:/Users/PC/OSS_001.jpg", "/images/../server/auth.js",
    "../secret.jpg", "/server/firebase.js", "/images/products/a.svg", "/docs/x.jpg", "http://example.com/a.jpg",
    "javascript:alert(1)", "data:image/png;base64,AAAA", "//evil.example/a.jpg", "https://user:pass@example.com/a.jpg"
  ]) {
    assert.equal(normalizeImagePath(bad), null, bad);
  }
});

test("Cloudinary signatures match the documented algorithm", () => {
  // Example from https://cloudinary.com/documentation/authentication_signatures
  const sig = signParams({ eager: "w_400,h_300,c_pad|w_260,h_200,c_crop", public_id: "sample_image", timestamp: 1315060510 }, "abcd");
  assert.equal(sig, "bfd09f95f331f558cbd1320e67aa8d488770583e");
  // file, api_key, cloud_name and resource_type are never part of the signature
  assert.equal(signParams({ public_id: "a", timestamp: 1, api_key: "k", file: "x" }, "s"), signParams({ public_id: "a", timestamp: 1 }, "s"));
});

test("Cloudinary upload responses are verified", () => {
  const secret = "test-secret";
  const response = { public_id: "oss/products/OSS_001-abc", version: 1730000000 };
  response.signature = signParams(response, secret);
  assert.ok(verifyUploadSignature(response, secret));
  assert.ok(!verifyUploadSignature({ ...response, public_id: "oss/products/other" }, secret));
  assert.ok(!verifyUploadSignature({ ...response, signature: "0".repeat(40) }, secret));
  assert.ok(!verifyUploadSignature({ public_id: "x" }, secret));
});

test("Cloudinary URLs are parsed, including transformations", () => {
  assert.deepEqual(parseCloudinaryUrl("https://res.cloudinary.com/demo/image/upload/v1730000000/oss/products/OSS_001-abc.jpg"),
    { cloudName: "demo", version: "1730000000", publicId: "oss/products/OSS_001-abc", format: "jpg" });
  assert.equal(parseCloudinaryUrl("https://res.cloudinary.com/demo/image/upload/f_auto,q_auto,w_600/v12/oss/products/A.webp").publicId, "oss/products/A");
  assert.equal(parseCloudinaryUrl("http://res.cloudinary.com/demo/image/upload/v1/a.jpg"), null);
  assert.equal(parseCloudinaryUrl("https://evil.example/demo/image/upload/v1/a.jpg"), null);
});

test("Firebase mode never mixes emulator and live", () => {
  const saved = { ...process.env };
  const reset = () => { for (const k of ["FIREBASE_MODE", "FIRESTORE_EMULATOR_HOST", "FIREBASE_AUTH_EMULATOR_HOST", "FIREBASE_STORAGE_EMULATOR_HOST"]) delete process.env[k]; };
  try {
    reset();
    assert.equal(firebaseMode(), "live");
    process.env.FIRESTORE_EMULATOR_HOST = "127.0.0.1:8080";
    assert.equal(firebaseMode(), "emulator");
    process.env.FIREBASE_MODE = "live";
    assert.throws(() => firebaseMode(), /emulator variables are set/);
    reset();
    process.env.FIREBASE_MODE = "emulator";
    assert.throws(() => firebaseMode(), /never used as a fallback/);
    reset();
    process.env.FIREBASE_AUTH_EMULATOR_HOST = "127.0.0.1:9099";
    assert.throws(() => firebaseMode(), /refusing to mix/);
  } finally {
    reset();
    Object.assign(process.env, saved);
  }
});

test("CSV parser handles quotes, commas and newlines", () => {
  const rows = parseCsv('﻿sku,name\r\nOSS_1,"Bottle, steel"\nOSS_2,"Say ""hi""\nline 2"\n');
  assert.deepEqual(rows, [["sku", "name"], ["OSS_1", "Bottle, steel"], ["OSS_2", 'Say "hi"\nline 2']]);
});

test("financial year follows April–March in IST", () => {
  assert.equal(financialYear(new Date("2026-10-26T10:00:00Z")), "2026-27");
  assert.equal(financialYear(new Date("2027-03-31T17:00:00Z")), "2026-27");
  assert.equal(financialYear(new Date("2027-03-31T19:00:00Z")), "2027-28"); // 00:30 IST on 1 April
});

test("invoice share links are signed and expire", () => {
  process.env.INVOICE_LINK_SECRET = "x".repeat(40);
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const sig = signInvoiceLink("inv1", exp);
  assert.ok(verifyShareLink("inv1", String(exp), sig));
  assert.ok(!verifyShareLink("inv2", String(exp), sig), "other invoice");
  assert.ok(!verifyShareLink("inv1", String(exp + 1), sig), "tampered expiry");
  const past = Math.floor(Date.now() / 1000) - 10;
  assert.ok(!verifyShareLink("inv1", String(past), signInvoiceLink("inv1", past)), "expired");
});
