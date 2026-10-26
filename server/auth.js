/* =========================================================
   ADMIN AUTHENTICATION & AUTHORIZATION
   The browser signs in with Firebase Auth and sends its ID token.
   A user is an administrator when:
     - their UID is listed in ADMIN_UIDS (bootstrap owner), or
     - an active document exists at admins/{uid}.
========================================================= */

import { auth, db } from "./firebase.js";
import { HttpError } from "./http.js";

function bootstrapOwners() {
  return String(process.env.ADMIN_UIDS || "")
    .split(",")
    .map(value => value.trim())
    .filter(Boolean);
}

export async function requireAdmin(req, { role } = {}) {
  const header = String(req.headers.authorization || "");
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) throw new HttpError(401, "Sign in to continue.");

  let decoded;
  try {
    decoded = await auth().verifyIdToken(match[1], true);
  } catch {
    throw new HttpError(401, "Your session has expired. Please sign in again.");
  }

  let adminRole = null;
  if (bootstrapOwners().includes(decoded.uid)) {
    adminRole = "owner";
  } else {
    const snap = await db().collection("admins").doc(decoded.uid).get();
    if (snap.exists && snap.get("active") !== false) adminRole = snap.get("role") || "staff";
  }

  if (!adminRole) throw new HttpError(403, "This account is not authorized for OSS Admin.");
  if (role === "owner" && adminRole !== "owner") {
    throw new HttpError(403, "Only the owner can perform this action.");
  }

  return { uid: decoded.uid, email: decoded.email || "", role: adminRole };
}

export function actorOf(admin) {
  return { uid: admin.uid, email: admin.email };
}
