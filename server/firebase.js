/* =========================================================
   FIREBASE ADMIN (trusted server only)
   Credentials come from environment variables — never from the browser.

   Mode is decided explicitly and never switches silently:
     emulator  FIRESTORE_EMULATOR_HOST is set (local development)
     live      no emulator hosts; FIREBASE_PROJECT_ID + credentials required
   FIREBASE_MODE (optional) states the intent. If it disagrees with the
   environment the server refuses to start instead of guessing.
========================================================= */

import { initializeApp, cert, applicationDefault, getApps } from "firebase-admin/app";
import { getFirestore, FieldValue, Timestamp } from "firebase-admin/firestore";
import { getAuth } from "firebase-admin/auth";
import { getStorage } from "firebase-admin/storage";

export { FieldValue, Timestamp };

export class ConfigError extends Error {}

const EMULATOR_VARS = ["FIRESTORE_EMULATOR_HOST", "FIREBASE_AUTH_EMULATOR_HOST", "FIREBASE_STORAGE_EMULATOR_HOST"];

export function firebaseMode() {
  const emulatorVars = EMULATOR_VARS.filter(name => process.env[name]);
  const declared = (process.env.FIREBASE_MODE || "").trim().toLowerCase();

  if (declared && !["emulator", "live"].includes(declared)) {
    throw new ConfigError(`FIREBASE_MODE must be "emulator" or "live" (got "${declared}").`);
  }
  if (declared === "live" && emulatorVars.length) {
    throw new ConfigError(`FIREBASE_MODE=live but emulator variables are set (${emulatorVars.join(", ")}). Remove them to use the live project.`);
  }
  if (emulatorVars.length && !process.env.FIRESTORE_EMULATOR_HOST) {
    throw new ConfigError("Emulator mode needs FIRESTORE_EMULATOR_HOST as well; refusing to mix emulators with the live database.");
  }
  if (declared === "emulator" && !emulatorVars.length) {
    throw new ConfigError("FIREBASE_MODE=emulator but FIRESTORE_EMULATOR_HOST is not set. Start the emulators (npm run emulators); the live project is never used as a fallback.");
  }
  return emulatorVars.length ? "emulator" : "live";
}

function readServiceAccount() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (raw) {
    try {
      const text = raw.trim().startsWith("{") ? raw : Buffer.from(raw, "base64").toString("utf8");
      return JSON.parse(text);
    } catch {
      throw new ConfigError("FIREBASE_SERVICE_ACCOUNT is not valid JSON (raw or base64).");
    }
  }

  if (process.env.FIREBASE_CLIENT_EMAIL && process.env.FIREBASE_PRIVATE_KEY) {
    return {
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      // Vercel stores multi-line keys with literal "\n".
      privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n")
    };
  }

  return null;
}

let app = null;

function getApp() {
  if (app) return app;
  if (getApps().length) {
    app = getApps()[0];
    return app;
  }

  const mode = firebaseMode();
  const projectId = (process.env.FIREBASE_PROJECT_ID || "").trim();
  if (!projectId) {
    throw new ConfigError("FIREBASE_PROJECT_ID is not set. Use one-stop-72ee5 for the live project, or a demo-* ID with the emulators.");
  }
  const storageBucket = process.env.FIREBASE_STORAGE_BUCKET || `${projectId}.firebasestorage.app`;

  if (mode === "emulator") {
    app = initializeApp({ projectId, storageBucket });
    return app;
  }

  const account = readServiceAccount();
  if (account) {
    const accountProject = account.projectId || account.project_id;
    if (accountProject && accountProject !== projectId) {
      throw new ConfigError(`The service account belongs to "${accountProject}" but FIREBASE_PROJECT_ID is "${projectId}".`);
    }
    app = initializeApp({ credential: cert(account), projectId, storageBucket });
  } else if (process.env.GOOGLE_APPLICATION_CREDENTIALS || process.env.FIREBASE_USE_APPLICATION_DEFAULT === "1") {
    // Local live development with `gcloud auth application-default login` or a key file path.
    app = initializeApp({ credential: applicationDefault(), projectId, storageBucket });
  } else {
    throw new ConfigError(
      "Live Firebase is not configured: set FIREBASE_SERVICE_ACCOUNT (or FIREBASE_CLIENT_EMAIL + FIREBASE_PRIVATE_KEY, or GOOGLE_APPLICATION_CREDENTIALS)."
    );
  }
  return app;
}

let firestore = null;

export function db() {
  if (!firestore) {
    firestore = getFirestore(getApp());
    firestore.settings({ ignoreUndefinedProperties: true });
  }
  return firestore;
}

export function auth() {
  return getAuth(getApp());
}

export function bucket() {
  return getStorage(getApp()).bucket();
}

export function isEmulator() {
  return firebaseMode() === "emulator";
}

// Safe to expose: which mode and project the server is using (no secrets).
export function backendStatus() {
  try {
    return { mode: firebaseMode(), projectId: process.env.FIREBASE_PROJECT_ID || null, configured: Boolean(getApp()) };
  } catch (error) {
    return { mode: null, projectId: process.env.FIREBASE_PROJECT_ID || null, configured: false, error: error.message };
  }
}
