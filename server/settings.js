/* =========================================================
   BUSINESS SETTINGS
   Only verified business details are pre-filled. Legal details such as
   address, GSTIN and tax rates stay empty until the owner enters them.
========================================================= */

import { db, FieldValue } from "./firebase.js";
import { Validator } from "./validate.js";
import { auditEntry, auditRef } from "./audit.js";
import { GST_RATES } from "../shared/pricing.js";
import { GSTIN_PATTERN, normalizePhone } from "../shared/constants.js";

export const DEFAULT_SETTINGS = {
  businessName: "ONE STOP SOLUTION (OSS)",
  tagline: "Every Problem One Solution",
  phone: "9499806747",
  whatsapp: "919499806747",
  instagram: "onestopsolution4325",
  email: "",
  address: "",
  stateCode: "",
  gstin: "",
  // Tax is off until the owner configures GST registration and rates.
  taxMode: "none",
  pricesIncludeTax: true,
  defaultGstRate: null,
  roundOff: true,
  // From the existing catalogue: "₹500 Minimum Order Quantity (MOQ)".
  minOrderValue: 50000,
  invoicePrefix: "OSS",
  invoiceTerms: "",
  invoiceNotes: "",
  paymentDetails: "",
  logo: "538820.jpg"
};

const ref = () => db().collection("settings").doc("business");

export async function getSettings(tx) {
  const snap = tx ? await tx.get(ref()) : await ref().get();
  return { ...DEFAULT_SETTINGS, ...(snap.exists ? snap.data() : {}) };
}

export function publicSettings(settings) {
  return {
    businessName: settings.businessName,
    tagline: settings.tagline,
    phone: settings.phone,
    whatsapp: settings.whatsapp,
    instagram: settings.instagram,
    email: settings.email,
    address: settings.address,
    taxMode: settings.taxMode,
    pricesIncludeTax: settings.pricesIncludeTax,
    minOrderValue: settings.minOrderValue,
    logo: settings.logo
  };
}

export function taxContext(settings, placeOfSupply) {
  return {
    mode: settings.taxMode === "gst" ? "gst" : "none",
    pricesIncludeTax: Boolean(settings.pricesIncludeTax),
    defaultRate: settings.defaultGstRate,
    interState: Boolean(settings.stateCode && placeOfSupply && placeOfSupply !== settings.stateCode)
  };
}

export async function updateSettings(input, admin) {
  const v = new Validator(input);
  const update = {
    businessName: v.string("businessName", { required: true, max: 120, label: "Business name" }),
    tagline: v.string("tagline", { max: 160 }),
    phone: v.string("phone", { max: 20 }),
    whatsapp: v.string("whatsapp", { max: 20, transform: normalizePhone, pattern: /^\d{10,15}$/, label: "WhatsApp number" }),
    instagram: v.string("instagram", { max: 60, transform: s => s.replace(/^@/, "") }),
    email: v.string("email", { max: 120, pattern: /^[^\s@]+@[^\s@]+\.[^\s@]+$/, label: "Email" }),
    address: v.string("address", { max: 500 }),
    stateCode: v.string("stateCode", { max: 2, pattern: /^\d{2}$/, label: "State" }),
    gstin: v.string("gstin", { max: 15, transform: s => s.toUpperCase(), pattern: GSTIN_PATTERN, label: "GSTIN" }),
    taxMode: v.oneOf("taxMode", ["none", "gst"], { fallback: "none" }),
    pricesIncludeTax: v.bool("pricesIncludeTax", true),
    defaultGstRate: v.number("defaultGstRate", { allowed: GST_RATES, label: "Default GST rate" }),
    roundOff: v.bool("roundOff", true),
    minOrderValue: v.money("minOrderValue", { label: "Minimum order value" }) ?? 0,
    invoicePrefix: v.string("invoicePrefix", { required: true, max: 10, pattern: /^[A-Z0-9-]+$/, transform: s => s.toUpperCase(), label: "Invoice prefix" }),
    invoiceTerms: v.string("invoiceTerms", { max: 1500 }),
    invoiceNotes: v.string("invoiceNotes", { max: 1000 }),
    paymentDetails: v.string("paymentDetails", { max: 1000 })
  };

  if (update.taxMode === "gst") {
    if (!update.gstin) v.fail("gstin", "GSTIN is required before GST can be charged.");
    if (!update.stateCode) v.fail("stateCode", "Business state is required for GST.");
    if (update.gstin && update.stateCode && update.gstin.slice(0, 2) !== update.stateCode) {
      v.fail("stateCode", "State must match the first two digits of the GSTIN.");
    }
  }
  v.assert();

  await db().runTransaction(async tx => {
    tx.set(ref(), { ...update, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    tx.set(auditRef(), auditEntry({ uid: admin.uid, email: admin.email }, "settings.update", "settings", "business", update));
  });
  return getSettings();
}
