/* =========================================================
   ADMIN USERS (owner only)
   Admins must already have a Firebase Authentication account.
========================================================= */

import { auth, db, FieldValue } from "./firebase.js";
import { badRequest, notFound } from "./http.js";
import { audit } from "./audit.js";
import { actorOf } from "./auth.js";

const admins = () => db().collection("admins");

export async function listAdmins() {
  const owners = String(process.env.ADMIN_UIDS || "").split(",").map(s => s.trim()).filter(Boolean);
  const snap = await admins().get();
  const list = snap.docs.map(doc => ({ uid: doc.id, ...doc.data(), createdAt: doc.get("createdAt")?.toDate?.().toISOString() || null }));
  for (const uid of owners) {
    if (!list.some(a => a.uid === uid)) {
      let email = "";
      try { email = (await auth().getUser(uid)).email || ""; } catch { /* user may not exist in this project */ }
      list.unshift({ uid, email, role: "owner", active: true, bootstrap: true });
    }
  }
  return list;
}

export async function addAdmin(input, admin) {
  const email = String(input?.email || "").trim().toLowerCase();
  const role = input?.role === "owner" ? "owner" : "staff";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw badRequest("Enter a valid email address.", { fields: { email: "Enter a valid email address." } });

  let user;
  try {
    user = await auth().getUserByEmail(email);
  } catch {
    throw notFound("No Firebase account uses this email. Create the user in Firebase Authentication first.");
  }
  await admins().doc(user.uid).set({ email, role, active: true, createdAt: FieldValue.serverTimestamp(), createdBy: actorOf(admin) });
  await audit(actorOf(admin), "admin.add", "admin", user.uid, { email, role });
  return { uid: user.uid, email, role, active: true };
}

export async function removeAdmin(uid, admin) {
  if (uid === admin.uid) throw badRequest("You cannot remove your own access.");
  const ref = admins().doc(uid);
  const snap = await ref.get();
  if (!snap.exists) throw notFound("Admin not found. Bootstrap owners are managed with the ADMIN_UIDS setting.");
  await ref.delete();
  await audit(actorOf(admin), "admin.remove", "admin", uid, { email: snap.get("email") });
  return { removed: true };
}

export async function listAudit({ limit = 100 } = {}) {
  const snap = await db().collection("auditLog").orderBy("at", "desc").limit(Math.min(Number(limit) || 100, 300)).get();
  return snap.docs.map(doc => ({ id: doc.id, ...doc.data(), at: doc.get("at")?.toDate?.().toISOString() || null }));
}
