/* =========================================================
   FIREBASE ADMIN (trusted server only)
   Credentials come from environment variables — never from the browser.
========================================================= */

import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore, FieldValue, Timestamp } from "firebase-admin/firestore";
import { getAuth } from "firebase-admin/auth";
import { getStorage } from "firebase-admin/storage";

export { FieldValue, Timestamp };

export class ConfigError extends Error {}

const usingEmulator = Boolean(process.env.FIRESTORE_EMULATOR_HOST);

function readServiceAccount() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (raw) {
    const text = raw.trim().startsWith("{")
      ? raw
      : Buffer.from(raw, "base64").toString("utf8");
    return JSON.parse(text);
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

  const projectId = process.env.FIREBASE_PROJECT_ID || process.env.GCLOUD_PROJECT;
  const storageBucket = process.env.FIREBASE_STORAGE_BUCKET || (projectId ? `${projectId}.firebasestorage.app` : undefined);
  const account = readServiceAccount();

  if (account) {
    app = initializeApp({ credential: cert(account), projectId: account.projectId || account.project_id || projectId, storageBucket });
  } else if (usingEmulator && projectId) {
    app = initializeApp({ projectId, storageBucket });
  } else {
    throw new ConfigError(
      "Backend is not configured: set FIREBASE_SERVICE_ACCOUNT (or FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL and FIREBASE_PRIVATE_KEY)."
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
  return usingEmulator;
}
