/* Test harness: runs the real API router against the Firebase emulators. */

import http from "node:http";

process.env.FIRESTORE_EMULATOR_HOST ||= "127.0.0.1:8080";
process.env.FIREBASE_AUTH_EMULATOR_HOST ||= "127.0.0.1:9099";
process.env.FIREBASE_STORAGE_EMULATOR_HOST ||= "127.0.0.1:9199";
process.env.FIREBASE_PROJECT_ID ||= "demo-oss";
process.env.FIREBASE_STORAGE_BUCKET ||= "demo-oss.appspot.com";
process.env.INVOICE_LINK_SECRET ||= "integration-test-secret-0123456789abcdef";
process.env.ADMIN_UIDS = "it-owner";
process.env.ORDER_RATE_LIMIT = "1000";

const { handle } = await import("../../server/router.js");
const { auth, db } = await import("../../server/firebase.js");

export { db };

export async function clearFirestore() {
  const res = await fetch(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${process.env.FIREBASE_PROJECT_ID}/databases/(default)/documents`, { method: "DELETE" });
  if (!res.ok) throw new Error(`Could not clear Firestore emulator: ${res.status}`);
}

export async function startServer() {
  const server = http.createServer((req, res) => handle(req, res));
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, close: () => new Promise(resolve => server.close(resolve)) };
}

const PASSWORD = "Test@12345";

export async function createUser(uid, email, role) {
  try { await auth().deleteUser(uid); } catch { /* not present */ }
  await auth().createUser({ uid, email, password: PASSWORD });
  if (role) await db().collection("admins").doc(uid).set({ email, role, active: true });
  const res = await fetch(`http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=demo-key`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: PASSWORD, returnSecureToken: true })
  });
  const data = await res.json();
  if (!data.idToken) throw new Error(`Sign-in failed for ${email}: ${JSON.stringify(data)}`);
  return data.idToken;
}

export function client(base, token) {
  const call = async (method, path, body) => {
    const res = await fetch(`${base}/api${path}`, {
      method,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body !== undefined ? { "Content-Type": "application/json" } : {})
      },
      body: body !== undefined ? JSON.stringify(body) : undefined
    });
    const type = res.headers.get("content-type") || "";
    const data = type.includes("json") ? await res.json() : Buffer.from(await res.arrayBuffer());
    return { status: res.status, data, headers: res.headers };
  };
  return {
    get: path => call("GET", path),
    post: (path, body = {}) => call("POST", path, body),
    patch: (path, body = {}) => call("PATCH", path, body),
    put: (path, body = {}) => call("PUT", path, body),
    del: path => call("DELETE", path)
  };
}

export const customer = (phone = "9876543210", extra = {}) => ({ name: "Test Buyer", phone, ...extra });
