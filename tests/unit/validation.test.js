import { test } from "node:test";
import assert from "node:assert/strict";
import { isValidPhone, normalizePhone, normalizeSku, SKU_PATTERN, GSTIN_PATTERN } from "../../shared/constants.js";
import { cleanImageUrl } from "../../server/validate.js";
import { parseCsv } from "../../server/csv.js";
import { detectType, isPrivateAddress } from "../../server/images.js";
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

test("image URLs: local assets and https only", () => {
  assert.equal(cleanImageUrl("OSS_001.jpg"), "OSS_001.jpg");
  assert.equal(cleanImageUrl("https://example.com/a.webp"), "https://example.com/a.webp");
  assert.equal(cleanImageUrl("http://example.com/a.jpg"), null);
  assert.equal(cleanImageUrl("javascript:alert(1)"), null);
  assert.equal(cleanImageUrl("../secret.jpg"), null);
  assert.equal(cleanImageUrl("https://user:pass@example.com/a.jpg"), null);
  assert.equal(cleanImageUrl("data:image/png;base64,AAAA"), null);
});

test("CSV parser handles quotes, commas and newlines", () => {
  const rows = parseCsv('﻿sku,name\r\nOSS_1,"Bottle, steel"\nOSS_2,"Say ""hi""\nline 2"\n');
  assert.deepEqual(rows, [["sku", "name"], ["OSS_1", "Bottle, steel"], ["OSS_2", 'Say "hi"\nline 2']]);
});

test("private network addresses are blocked for image import", () => {
  for (const ip of ["127.0.0.1", "10.1.2.3", "192.168.1.1", "172.16.0.1", "169.254.169.254", "::1", "fd00::1", "::ffff:127.0.0.1"]) {
    assert.ok(isPrivateAddress(ip), ip);
  }
  assert.ok(!isPrivateAddress("142.250.183.14"));
});

test("image type detection uses file signatures", () => {
  assert.equal(detectType(Buffer.from([0xff, 0xd8, 0xff, 0xe0])).type, "image/jpeg");
  assert.equal(detectType(Buffer.from("RIFF0000WEBPVP8 ")).type, "image/webp");
  assert.equal(detectType(Buffer.from("<svg onload=alert(1)>")), null);
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
