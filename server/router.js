/* =========================================================
   API ROUTER
   One serverless function serves every /api route (Vercel's Hobby plan
   limits the number of functions).
========================================================= */

import { ConfigError, backendStatus, isEmulator } from "./firebase.js";
import { HttpError, clientIp, rateLimit, readJsonBody, sendJson } from "./http.js";
import { requireAdmin } from "./auth.js";
import * as products from "./products.js";
import * as categories from "./categories.js";
import * as inventory from "./inventory.js";
import * as orders from "./orders.js";
import * as invoices from "./invoices.js";
import * as customers from "./customers.js";
import * as dashboard from "./dashboard.js";
import * as settings from "./settings.js";
import * as csv from "./csv.js";
import * as admins from "./admins.js";
import * as imageAssets from "./image-assets.js";
import { isConfigured as cloudinaryConfigured } from "./cloudinary.js";
import { renderInvoicePdf } from "./invoice-pdf.js";

/* ---------------------------------------------------------
   PUBLIC CONFIG
   The Firebase web config is public by design; it only identifies the
   project. Access is controlled by Auth, the API and security rules.
--------------------------------------------------------- */

function imageOptions() {
  return { provider: "cloudinary", configured: cloudinaryConfigured(), placeholder: "/images/placeholder.svg" };
}

// Web config for Firebase Auth sign-in in the admin panel. No defaults for a
// live project: missing values are reported instead of falling back.
function webConfig() {
  if (isEmulator()) {
    return {
      mode: "emulator",
      firebase: { apiKey: "demo-key", authDomain: "localhost", projectId: process.env.FIREBASE_PROJECT_ID },
      authEmulator: `http://${process.env.FIREBASE_AUTH_EMULATOR_HOST || "127.0.0.1:9099"}`,
      images: imageOptions()
    };
  }
  const firebase = {
    apiKey: process.env.FIREBASE_WEB_API_KEY,
    authDomain: process.env.FIREBASE_AUTH_DOMAIN || (process.env.FIREBASE_PROJECT_ID ? `${process.env.FIREBASE_PROJECT_ID}.firebaseapp.com` : undefined),
    projectId: process.env.FIREBASE_PROJECT_ID,
    appId: process.env.FIREBASE_WEB_APP_ID
  };
  const missing = [["FIREBASE_WEB_API_KEY", firebase.apiKey], ["FIREBASE_PROJECT_ID", firebase.projectId], ["FIREBASE_WEB_APP_ID", firebase.appId]]
    .filter(([, value]) => !value).map(([name]) => name);
  if (missing.length) {
    throw new HttpError(503, `Admin sign-in is not configured. Register a web app in Firebase and set: ${missing.join(", ")}.`);
  }
  return { mode: "live", firebase, authEmulator: null, images: imageOptions() };
}

function baseUrl(req) {
  if (process.env.PUBLIC_SITE_URL) return process.env.PUBLIC_SITE_URL.replace(/\/$/, "");
  const proto = req.headers["x-forwarded-proto"] || (isEmulator() ? "http" : "https");
  return `${proto}://${req.headers["x-forwarded-host"] || req.headers.host}`;
}

function sendPdf(res, buffer, filename, { cache = "private, no-store" } = {}) {
  res.statusCode = 200;
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename="${filename}"`);
  res.setHeader("Cache-Control", cache);
  res.setHeader("X-Robots-Tag", "noindex");
  res.end(buffer);
}

function pdfName(invoice) {
  return `${invoice.invoiceNo.replace(/[^A-Za-z0-9-]+/g, "-")}.pdf`;
}

async function invoicePdf(id) {
  const invoice = await invoices.getInvoice(id);
  return { invoice, buffer: await renderInvoicePdf(invoice) };
}

/* ---------------------------------------------------------
   ROUTES
   handler(ctx) -> body | undefined (when it wrote the response itself)
--------------------------------------------------------- */

const routes = [];
const add = (method, pattern, handler, { admin = false, role } = {}) => {
  const keys = [];
  const regex = new RegExp(`^${pattern.replace(/:([a-zA-Z]+)/g, (_, key) => { keys.push(key); return "([^/]+)"; })}$`);
  routes.push({ method, regex, keys, handler, admin, role });
};

// ---- public
add("GET", "/health", ({ res }) => {
  const status = backendStatus();
  // Readiness flags only — never values.
  const ready = {
    adminSignIn: Boolean(process.env.FIREBASE_WEB_API_KEY && process.env.FIREBASE_WEB_APP_ID) || status.mode === "emulator",
    ownerConfigured: Boolean(String(process.env.ADMIN_UIDS || "").trim()),
    invoiceLinks: String(process.env.INVOICE_LINK_SECRET || "").length >= 32,
    images: cloudinaryConfigured()
  };
  sendJson(res, status.configured ? 200 : 503, { ok: status.configured, ...status, ready, time: new Date().toISOString() }, { "Cache-Control": "no-store" });
});
add("GET", "/config", () => webConfig());

add("GET", "/catalog", async ({ res }) => {
  const [list, cats, biz] = await Promise.all([products.listPublicProducts(), categories.listPublicCategories(), settings.getSettings()]);
  // Short shared cache so admin changes reach customers within seconds.
  res.setHeader("Cache-Control", "public, max-age=0, s-maxage=10, stale-while-revalidate=30");
  return { products: list, categories: cats, settings: settings.publicSettings(biz) };
});

add("GET", "/products/:sku", async ({ params, res }) => {
  const product = await products.getPublicProductBySku(decodeURIComponent(params.sku));
  const [all, biz] = await Promise.all([products.listPublicProducts(), settings.getSettings()]);
  const related = all.filter(p => p.categoryId === product.categoryId && p.id !== product.id).slice(0, 8);
  res.setHeader("Cache-Control", "public, max-age=0, s-maxage=10, stale-while-revalidate=30");
  return { product, related, settings: settings.publicSettings(biz) };
});

add("POST", "/orders", async ({ req, body }) => {
  rateLimit(`order:${clientIp(req)}`, { limit: Number(process.env.ORDER_RATE_LIMIT) || 8, windowMs: 10 * 60 * 1000 });
  return orders.createPublicOrder(body);
});

add("GET", "/invoice-pdf", async ({ query, res, req }) => {
  rateLimit(`pdf:${clientIp(req)}`, { limit: 60, windowMs: 10 * 60 * 1000 });
  const id = query.get("id");
  if (!invoices.verifyShareLink(id, query.get("exp"), query.get("sig"))) {
    throw new HttpError(403, "This invoice link is invalid or has expired. Please ask ONE STOP SOLUTION for a new link.");
  }
  const { invoice, buffer } = await invoicePdf(id);
  sendPdf(res, buffer, pdfName(invoice));
});

// ---- admin
const A = { admin: true };
const OWNER = { admin: true, role: "owner" };

add("GET", "/admin/me", ({ admin }) => admin, A);
add("GET", "/admin/dashboard", ({ query }) => dashboard.getDashboard({ from: query.get("from"), to: query.get("to") }), A);

add("GET", "/admin/products", () => products.listAdminProducts(), A);
add("POST", "/admin/products", ({ body, admin }) => products.createProduct(body, admin), A);
add("GET", "/admin/products/export.csv", async ({ res }) => {
  const text = await csv.exportProductsCsv();
  res.statusCode = 200;
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="oss-products-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.end(text);
}, A);
add("POST", "/admin/products/import", ({ body, admin }) => csv.importProductsCsv(body, admin), A);
add("GET", "/admin/products/:id", ({ params }) => products.getAdminProduct(params.id), A);
add("PATCH", "/admin/products/:id", ({ params, body, admin }) => products.updateProduct(params.id, body, admin), A);
add("DELETE", "/admin/products/:id", ({ params, admin }) => products.deleteProduct(params.id, admin), A);
add("POST", "/admin/products/:id/stock", ({ params, body, admin }) => inventory.adjustStock(params.id, body, admin), A);

add("GET", "/admin/inventory/movements", ({ query }) => inventory.listMovements({
  productId: query.get("productId") || undefined, limit: query.get("limit"), before: query.get("before") || undefined
}), A);

add("GET", "/admin/categories", () => categories.listAdminCategories(), A);
add("POST", "/admin/categories", ({ body, admin }) => categories.createCategory(body, admin), A);
add("POST", "/admin/categories/reorder", ({ body, admin }) => categories.reorderCategories(body, admin), A);
add("PATCH", "/admin/categories/:id", ({ params, body, admin }) => categories.updateCategory(params.id, body, admin), A);
add("POST", "/admin/categories/:id/archive", ({ params, body, admin }) => categories.archiveCategory(params.id, body, admin), A);
add("POST", "/admin/categories/:id/restore", ({ params, admin }) => categories.restoreCategory(params.id, admin), A);

// Product images: Cloudinary, uploaded by the browser with a server signature.
add("POST", "/admin/images/signature", ({ body }) => imageAssets.uploadSignature(body), A);
add("POST", "/admin/images/confirm", ({ body, admin }) => imageAssets.confirmUpload(body, admin), A);
add("POST", "/admin/images/import-url", ({ body, admin }) => imageAssets.importFromUrl(body, admin), A);
add("GET", "/admin/images/assets", ({ query }) => imageAssets.listAssets({ status: query.get("status") || undefined }), A);
add("DELETE", "/admin/images/assets/:id", ({ params, admin }) => imageAssets.deleteAsset(params.id, admin), OWNER);

add("GET", "/admin/orders", ({ query }) => orders.listOrders({
  status: query.get("status") || undefined, q: query.get("q") || undefined,
  limit: query.get("limit"), before: query.get("before") || undefined
}), A);
add("POST", "/admin/orders", ({ body, admin }) => orders.createAdminOrder(body, admin), A);
add("GET", "/admin/orders/:id", ({ params }) => orders.getOrder(params.id), A);
add("PATCH", "/admin/orders/:id", ({ params, body, admin }) => orders.updatePendingOrder(params.id, body, admin), A);
add("POST", "/admin/orders/:id/status", ({ params, body, admin }) => orders.transitionOrder(params.id, body, admin), A);
add("POST", "/admin/orders/:id/invoice-preview", ({ params, body }) => invoices.previewInvoice(params.id, body), A);
add("POST", "/admin/orders/:id/invoice", ({ params, body, admin }) => invoices.issueInvoice(params.id, body, admin), A);

add("GET", "/admin/invoices", ({ query }) => invoices.listInvoices({
  q: query.get("q") || undefined, paymentStatus: query.get("paymentStatus") || undefined,
  limit: query.get("limit"), before: query.get("before") || undefined
}), A);
add("GET", "/admin/invoices/:id", ({ params }) => invoices.getInvoice(params.id), A);
add("GET", "/admin/invoices/:id/pdf", async ({ params, res }) => {
  const { invoice, buffer } = await invoicePdf(params.id);
  sendPdf(res, buffer, pdfName(invoice));
}, A);
add("POST", "/admin/invoices/:id/cancel", ({ params, body, admin }) => invoices.cancelInvoice(params.id, body, admin), A);
add("POST", "/admin/invoices/:id/payments", ({ params, body, admin }) => invoices.recordPayment(params.id, body, admin), A);
add("POST", "/admin/invoices/:id/share-link", async ({ params, body, req }) => {
  await invoices.getInvoiceDoc(params.id);
  return invoices.createShareLink(params.id, baseUrl(req), body?.days);
}, A);
add("POST", "/admin/invoices/:id/share-events", ({ params, body, admin }) => invoices.recordShareEvent(params.id, body, admin), A);
add("POST", "/admin/payments/:id/void", ({ params, body, admin }) => invoices.voidPayment(params.id, body, admin), OWNER);

add("GET", "/admin/customers", ({ query }) => customers.listCustomers({ q: query.get("q") || "" }), A);
add("GET", "/admin/customers/:id", ({ params }) => customers.getCustomer(params.id), A);
add("PATCH", "/admin/customers/:id", ({ params, body, admin }) => customers.updateCustomer(params.id, body, admin), A);

add("GET", "/admin/settings", () => settings.getSettings(), A);
add("PUT", "/admin/settings", ({ body, admin }) => settings.updateSettings(body, admin), OWNER);

add("GET", "/admin/admins", () => admins.listAdmins(), OWNER);
add("POST", "/admin/admins", ({ body, admin }) => admins.addAdmin(body, admin), OWNER);
add("DELETE", "/admin/admins/:uid", ({ params, admin }) => admins.removeAdmin(params.uid, admin), OWNER);
add("GET", "/admin/audit", ({ query }) => admins.listAudit({ limit: query.get("limit") }), OWNER);

/* ---------------------------------------------------------
   DISPATCH
--------------------------------------------------------- */

export async function handle(req, res, pathname) {
  const url = new URL(req.url, "http://localhost");
  const path = (pathname ?? url.pathname.replace(/^\/api/, "")).replace(/\/+$/, "") || "/";
  const method = req.method === "HEAD" ? "GET" : req.method;

  res.setHeader("X-Content-Type-Options", "nosniff");

  try {
    let matched = null;
    let methodMismatch = false;
    for (const route of routes) {
      const match = route.regex.exec(path);
      if (!match) continue;
      if (route.method !== method) { methodMismatch = true; continue; }
      matched = { route, params: Object.fromEntries(route.keys.map((key, i) => [key, decodeURIComponent(match[i + 1])])) };
      break;
    }
    if (!matched) throw new HttpError(methodMismatch ? 405 : 404, methodMismatch ? "Method not allowed." : "Not found.");

    const { route, params } = matched;
    if (route.admin) res.setHeader("Cache-Control", "private, no-store");
    const admin = route.admin ? await requireAdmin(req, { role: route.role }) : null;
    const body = ["POST", "PUT", "PATCH", "DELETE"].includes(method) ? await readJsonBody(req) : undefined;

    const result = await route.handler({ req, res, params, query: url.searchParams, body, admin });
    if (!res.writableEnded) sendJson(res, 200, result ?? { ok: true });
  } catch (error) {
    if (res.writableEnded) return;
    if (error instanceof HttpError) {
      sendJson(res, error.status, { error: error.message, details: error.details || null });
    } else if (error instanceof ConfigError) {
      sendJson(res, 503, { error: error.message, code: "backend_not_configured" });
    } else {
      console.error("API error:", req.method, path, error);
      const missingIndex = /requires an index/i.test(error?.message || "");
      sendJson(res, 500, {
        error: missingIndex
          ? "A database index is still being created. Deploy firestore.indexes.json and try again in a few minutes."
          : "Something went wrong on the server. Please try again."
      });
    }
  }
}
