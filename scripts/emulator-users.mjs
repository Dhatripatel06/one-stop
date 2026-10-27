/* =========================================================
   Creates test accounts in the Firebase Auth emulator (never production).
   owner@oss.test  (uid owner-test-uid — add to ADMIN_UIDS)
   staff@oss.test  (admins/{uid} role staff)
   viewer@oss.test (signed in but NOT an admin)
   Password for all: Test@12345
========================================================= */

process.env.FIREBASE_MODE = "emulator";
process.env.FIRESTORE_EMULATOR_HOST ||= "127.0.0.1:8080";
process.env.FIREBASE_AUTH_EMULATOR_HOST ||= "127.0.0.1:9099";
process.env.FIREBASE_PROJECT_ID = process.env.EMULATOR_PROJECT_ID || "demo-oss";

const { auth, db } = await import("../server/firebase.js");

if (!process.env.FIREBASE_AUTH_EMULATOR_HOST) throw new Error("Emulator only.");

const users = [
  { uid: "owner-test-uid", email: "owner@oss.test" },
  { uid: "staff-test-uid", email: "staff@oss.test", role: "staff" },
  { uid: "viewer-test-uid", email: "viewer@oss.test" }
];

for (const user of users) {
  try { await auth().deleteUser(user.uid); } catch { /* not present */ }
  await auth().createUser({ uid: user.uid, email: user.email, password: "Test@12345", emailVerified: true });
  if (user.role) await db().collection("admins").doc(user.uid).set({ email: user.email, role: user.role, active: true });
  console.log(`created ${user.email}`);
}
process.exit(0);
