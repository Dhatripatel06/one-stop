/* Server-side authorization for every owner-only route, plus revoked and
   deactivated sessions. Emulator only: npm run test:integration */

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { clearFirestore, createUser, db, startServer } from "./helpers.js";
import { auth } from "../../server/firebase.js";

// Owner-only routes are read from the router so new ones are covered automatically.
const OWNER_ROUTES = [...fs.readFileSync(new URL("../../server/router.js", import.meta.url), "utf8")
  .matchAll(/add\("([A-Z]+)", "([^"]+)",[^\n]*OWNER\);/g)]
  .map(([, method, pattern]) => [method, pattern.replace(/:[a-zA-Z]+/g, "x")]);

let server, tokens;

const call = (token, method, path, body) => fetch(`${server.base}/api${path}`, {
  method,
  headers: { Authorization: `Bearer ${token}`, ...(method === "GET" ? {} : { "Content-Type": "application/json" }) },
  body: method === "GET" ? undefined : JSON.stringify(body ?? {})
}).then(res => res.status);

before(async () => {
  await clearFirestore();
  server = await startServer();
  const [owner, staff] = await Promise.all([
    createUser("auth-owner", "auth-owner@oss.test", "owner"),
    createUser("auth-staff", "auth-staff@oss.test", "staff")
  ]);
  tokens = { owner, staff };
});

after(() => server?.close());

test("the router declares the expected owner-only routes", () => {
  assert.ok(OWNER_ROUTES.length >= 7, `found ${OWNER_ROUTES.length}`);
});

test("staff get 403 on every owner-only route; the owner passes the role check", async () => {
  for (const [method, path] of OWNER_ROUTES) {
    assert.equal(await call(tokens.staff, method, path), 403, `staff ${method} ${path}`);
    const ownerStatus = await call(tokens.owner, method, path);
    assert.ok(![401, 403].includes(ownerStatus), `owner ${method} ${path} got ${ownerStatus}`);
  }
});

test("a revoked session is rejected", async () => {
  const token = await createUser("auth-revoked", "auth-revoked@oss.test", "staff");
  assert.equal(await call(token, "GET", "/admin/me"), 200);
  await new Promise(resolve => setTimeout(resolve, 1100)); // revocation has one-second resolution
  await auth().revokeRefreshTokens("auth-revoked");
  assert.equal(await call(token, "GET", "/admin/me"), 401);
});

test("deactivated and removed admins are refused", async () => {
  const token = await createUser("auth-former", "auth-former@oss.test", "staff");
  assert.equal(await call(token, "GET", "/admin/me"), 200);
  await db().collection("admins").doc("auth-former").update({ active: false });
  assert.equal(await call(token, "GET", "/admin/me"), 403);
  await db().collection("admins").doc("auth-former").delete();
  assert.equal(await call(token, "GET", "/admin/products"), 403);
});
