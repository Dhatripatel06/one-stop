import { test } from "node:test";
import assert from "node:assert/strict";

// Regression: the production function crashed at import time (ERR_REQUIRE_ESM
// from firebase-admin → jwks-rsa → jose) on a Node.js runtime without
// require(esm). Loading the entry point must work, and a missing or invalid
// configuration must give a JSON diagnostic instead of crashing.

const ENV = ["FIREBASE_PROJECT_ID", "FIREBASE_MODE", "FIREBASE_SERVICE_ACCOUNT", "FIREBASE_CLIENT_EMAIL", "FIREBASE_PRIVATE_KEY",
  "GOOGLE_APPLICATION_CREDENTIALS", "FIREBASE_USE_APPLICATION_DEFAULT", "FIRESTORE_EMULATOR_HOST", "FIREBASE_AUTH_EMULATOR_HOST",
  "FIREBASE_STORAGE_EMULATOR_HOST", "FIREBASE_WEB_API_KEY", "FIREBASE_WEB_APP_ID"];

async function call(handler, path, headers = {}) {
  const res = {
    statusCode: 200, headers: {}, body: "", writableEnded: false,
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
    end(chunk = "") { this.body += chunk; this.writableEnded = true; }
  };
  await handler({ method: "GET", url: `/api/index?path=${path}`, headers, socket: {} }, res);
  return { status: res.statusCode, json: JSON.parse(res.body) };
}

async function withEnv(values, fn) {
  const saved = Object.fromEntries(ENV.map(k => [k, process.env[k]]));
  for (const k of ENV) delete process.env[k];
  Object.assign(process.env, values);
  try { await fn(); } finally {
    for (const k of ENV) saved[k] === undefined ? delete process.env[k] : (process.env[k] = saved[k]);
  }
}

test("the API entry point loads on this Node.js", async () => {
  const { default: handler } = await import("../../api/index.js");
  assert.equal(typeof handler, "function");
});

test("missing or invalid configuration returns a diagnostic, not a crash", async () => {
  const { default: handler } = await import("../../api/index.js");

  await withEnv({}, async () => {
    const health = await call(handler, "health");
    assert.equal(health.status, 503);
    assert.equal(health.json.ok, false);
    assert.match(health.json.error, /FIREBASE_PROJECT_ID is not set/);
    assert.deepEqual(Object.keys(health.json.ready).sort(), ["adminSignIn", "images", "invoiceLinks", "ownerConfigured"]);

    const catalog = await call(handler, "catalog");
    assert.equal(catalog.status, 503);
    assert.equal(catalog.json.code, "backend_not_configured");

    assert.equal((await call(handler, "config")).status, 503);
  });

  // Live project without credentials: reported, never an emulator fallback.
  await withEnv({ FIREBASE_PROJECT_ID: "one-stop-72ee5", FIREBASE_MODE: "live" }, async () => {
    const health = await call(handler, "health");
    assert.equal(health.status, 503);
    assert.equal(health.json.projectId, "one-stop-72ee5");
    assert.match(health.json.error, /Live Firebase is not configured/);
  });

  // Live mode with an emulator variable present refuses instead of switching.
  await withEnv({ FIREBASE_PROJECT_ID: "one-stop-72ee5", FIREBASE_MODE: "live", FIRESTORE_EMULATOR_HOST: "127.0.0.1:8080" }, async () => {
    const health = await call(handler, "health");
    assert.equal(health.status, 503);
    assert.equal(health.json.mode, null);
    assert.match(health.json.error, /emulator variables are set/);
  });

  // Admin routes still demand a token before touching Firebase.
  await withEnv({}, async () => {
    assert.equal((await call(handler, "admin/products")).status, 401);
  });
});
