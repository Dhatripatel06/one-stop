/* =========================================================
   PRODUCTION CONFIGURATION CHECK
   Verifies the server environment for the live deployment without
   printing any value: only variable names and pass/fail.

     node scripts/check-production.mjs            env from .env.local / .env
     node scripts/check-production.mjs --connect  also reads (never writes)
          live Firestore, Auth and Cloudinary with those credentials

   Exits 1 when anything required is missing or inconsistent.
========================================================= */

const CONNECT = process.argv.includes("--connect");
const EXPECTED_PROJECT = "one-stop-72ee5";

const { loadEnv } = await import("./load-env.mjs");
loadEnv();

const problems = [];
const ok = [];
const env = name => (process.env[name] || "").trim();
const check = (name, pass, message) => (pass ? ok.push(name) : problems.push(`${name}: ${message}`));

// ---- Firebase project and mode
check("FIREBASE_PROJECT_ID", env("FIREBASE_PROJECT_ID") === EXPECTED_PROJECT,
  `must be ${EXPECTED_PROJECT}${env("FIREBASE_PROJECT_ID") ? ` (is ${env("FIREBASE_PROJECT_ID")})` : " (not set)"}`);
for (const name of ["FIRESTORE_EMULATOR_HOST", "FIREBASE_AUTH_EMULATOR_HOST", "FIREBASE_STORAGE_EMULATOR_HOST"]) {
  check(name, !env(name), "must not be set in production");
}
check("FIREBASE_MODE", ["", "live"].includes(env("FIREBASE_MODE").toLowerCase()), 'must be "live" (or unset)');

// ---- Service account (shape and project only)
const { parseServiceAccount } = await import("../server/firebase.js");
let account = null;
if (env("FIREBASE_SERVICE_ACCOUNT")) {
  try { account = parseServiceAccount(env("FIREBASE_SERVICE_ACCOUNT")); ok.push("FIREBASE_SERVICE_ACCOUNT"); }
  catch (error) { problems.push(error.message); }
} else if (env("FIREBASE_CLIENT_EMAIL") && env("FIREBASE_PRIVATE_KEY")) {
  account = { project_id: EXPECTED_PROJECT, client_email: env("FIREBASE_CLIENT_EMAIL"), private_key: env("FIREBASE_PRIVATE_KEY") };
  check("FIREBASE_PRIVATE_KEY", /BEGIN PRIVATE KEY/.test(account.private_key), "does not look like a PEM private key");
} else {
  problems.push("FIREBASE_SERVICE_ACCOUNT: not set (or FIREBASE_CLIENT_EMAIL + FIREBASE_PRIVATE_KEY)");
}
if (account) {
  const project = account.project_id || String(account.client_email).split("@")[1]?.split(".")[0];
  check("service account project", project === EXPECTED_PROJECT, `belongs to ${project}, not ${EXPECTED_PROJECT}`);
}

// ---- Web sign-in config (public values, but must belong to the same project)
check("FIREBASE_WEB_API_KEY", /^AIza[0-9A-Za-z_-]{35}$/.test(env("FIREBASE_WEB_API_KEY")), "missing or not a Firebase web API key");
check("FIREBASE_WEB_APP_ID", env("FIREBASE_WEB_APP_ID").startsWith("1:143723467630:web:"), `missing or not a web app of ${EXPECTED_PROJECT}`);
if (env("FIREBASE_AUTH_DOMAIN")) check("FIREBASE_AUTH_DOMAIN", env("FIREBASE_AUTH_DOMAIN") === `${EXPECTED_PROJECT}.firebaseapp.com`, `should be ${EXPECTED_PROJECT}.firebaseapp.com`);

// ---- Access, invoices, site
const owners = env("ADMIN_UIDS").split(",").map(s => s.trim()).filter(Boolean);
check("ADMIN_UIDS", owners.length > 0 && owners.every(uid => /^[A-Za-z0-9]{20,128}$/.test(uid)), "needs at least one Firebase Auth UID");
check("INVOICE_LINK_SECRET", env("INVOICE_LINK_SECRET").length >= 32, "must be at least 32 characters");
check("PUBLIC_SITE_URL", /^https:\/\/[^/\s]+\/?$/.test(env("PUBLIC_SITE_URL")), "must be the https:// site address");

// ---- Cloudinary
const { cloudinaryConfig } = await import("../server/cloudinary.js");
const cloud = cloudinaryConfig({ required: false });
check("CLOUDINARY_*", Boolean(cloud), "set CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET (or CLOUDINARY_URL)");

// ---- Optional live read-only connection test
if (CONNECT && !problems.length) {
  process.env.FIREBASE_MODE = "live";
  const { db, auth } = await import("../server/firebase.js");
  try {
    const snap = await db().collection("products").limit(1).get();
    ok.push(`Firestore read (${snap.size ? "catalogue has data" : "catalogue empty"})`);
  } catch (error) { problems.push(`Firestore read failed: ${error.code || ""} ${error.message.split("\n")[0]}`); }
  for (const uid of owners) {
    try { await auth().getUser(uid); ok.push(`ADMIN_UIDS entry …${uid.slice(-4)} exists in Auth`); }
    catch (error) { problems.push(`ADMIN_UIDS entry …${uid.slice(-4)}: ${error.code || error.message}`); }
  }
  try {
    const basic = Buffer.from(`${cloud.apiKey}:${cloud.apiSecret}`).toString("base64");
    const response = await fetch(`https://api.cloudinary.com/v1_1/${cloud.cloudName}/usage`, { headers: { Authorization: `Basic ${basic}` }, signal: AbortSignal.timeout(15000) });
    check("Cloudinary credentials", response.ok, `rejected (HTTP ${response.status})`);
  } catch (error) { problems.push(`Cloudinary unreachable: ${error.message}`); }
}

console.log(`Production config for ${EXPECTED_PROJECT}${CONNECT ? " (with live read-only connection)" : ""}`);
for (const name of ok) console.log(`  ✔ ${name}`);
for (const problem of problems) console.log(`  ✖ ${problem}`);
process.exit(problems.length ? 1 : 0);
