/* =========================================================
   LOCAL DEVELOPMENT SERVER
   Serves the static site and the same API router Vercel runs.
   Usage:
     npm run dev        emulator mode (default) — needs `npm run emulators`
     npm run dev:live   live Firebase project from .env.local (FIREBASE_PROJECT_ID
                        + service account). Never chosen automatically.
   Options: --port 3000
========================================================= */

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

import { loadEnv } from "./load-env.mjs";
loadEnv();

const LIVE = process.argv.includes("--live");
const EMULATOR_VARS = ["FIRESTORE_EMULATOR_HOST", "FIREBASE_AUTH_EMULATOR_HOST", "FIREBASE_STORAGE_EMULATOR_HOST"];

function fail(message) {
  console.error(`
✖ ${message}
`);
  process.exit(1);
}

if (LIVE) {
  process.env.FIREBASE_MODE = "live";
  const set = EMULATOR_VARS.filter(name => process.env[name]);
  if (set.length) fail(`Live mode requested but ${set.join(", ")} is set. Remove emulator variables to use the live project.`);
  if (!process.env.FIREBASE_PROJECT_ID) fail("Live mode needs FIREBASE_PROJECT_ID (one-stop-72ee5) in .env.local.");
} else {
  process.env.FIREBASE_MODE = "emulator";
  process.env.FIRESTORE_EMULATOR_HOST ||= "127.0.0.1:8080";
  process.env.FIREBASE_AUTH_EMULATOR_HOST ||= "127.0.0.1:9099";
  process.env.FIREBASE_STORAGE_EMULATOR_HOST ||= "127.0.0.1:9199";
  // A demo-* project ID guarantees the emulators never reach real resources,
  // even if .env.local names the live project.
  process.env.FIREBASE_PROJECT_ID = process.env.EMULATOR_PROJECT_ID || "demo-oss";
  process.env.FIREBASE_STORAGE_BUCKET = `${process.env.FIREBASE_PROJECT_ID}.appspot.com`;
  process.env.INVOICE_LINK_SECRET ||= "local-development-secret-not-for-production-use";
  try {
    await fetch(`http://${process.env.FIRESTORE_EMULATOR_HOST}/`, { signal: AbortSignal.timeout(3000) });
  } catch {
    fail(`The Firestore emulator is not running at ${process.env.FIRESTORE_EMULATOR_HOST}. Start it with "npm run emulators" (needs Java 21+). The live project is never used as a fallback; use "npm run dev:live" for that.`);
  }
}

const { handle } = await import("../server/router.js");

const portIndex = process.argv.indexOf("--port");
const port = Number(portIndex > -1 ? process.argv[portIndex + 1] : process.env.PORT || 3000);

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon"
};

// Mirrors what is deployed: no server code, tests, or secrets over HTTP.
const BLOCKED = /^\/(server|scripts|tests|node_modules|data|docs|\.)/;

function serveStatic(req, res) {
  const url = new URL(req.url, "http://localhost");
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === "/") pathname = "/index.html";
  if (BLOCKED.test(pathname) || pathname.includes("..") || /\.(env|log|md)$/i.test(pathname) || pathname.endsWith("package.json")) {
    res.statusCode = 404;
    return res.end("Not found");
  }
  const file = path.join(root, pathname);
  if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.statusCode = 404;
    res.setHeader("Content-Type", "text/plain");
    return res.end("Not found");
  }
  res.statusCode = 200;
  res.setHeader("Content-Type", TYPES[path.extname(file).toLowerCase()] || "application/octet-stream");
  res.setHeader("Cache-Control", "no-cache");
  fs.createReadStream(file).pipe(res);
}

http.createServer((req, res) => {
  if (req.url.startsWith("/api/") || req.url === "/api") {
    handle(req, res).catch(error => {
      console.error(error);
      if (!res.writableEnded) { res.statusCode = 500; res.end("Server error"); }
    });
    return;
  }
  serveStatic(req, res);
}).listen(port, () => {
  console.log(`OSS dev server: http://localhost:${port}`);
  if (LIVE) {
    console.log(`
⚠  LIVE Firebase project: ${process.env.FIREBASE_PROJECT_ID}. Changes you make are saved to the real database.
`);
  } else {
    console.log(`Using Firebase emulators (project ${process.env.FIREBASE_PROJECT_ID}). Nothing is written to a live project.`);
  }
  console.log(process.env.CLOUDINARY_API_SECRET || process.env.CLOUDINARY_URL ? "Cloudinary: configured (product image uploads are live, even in emulator mode)." : "Cloudinary: NOT configured — admin image uploads are disabled.");
});
