/* =========================================================
   LOCAL DEVELOPMENT SERVER
   Serves the static site and the same API router Vercel runs.
   By default it talks to the Firebase emulators (npm run emulators).
   Usage: node scripts/dev-server.mjs [--port 3000]
========================================================= */

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Minimal .env loader (no dependency).
for (const file of [".env.local", ".env"]) {
  const full = path.join(root, file);
  if (!fs.existsSync(full)) continue;
  for (const line of fs.readFileSync(full, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (match && process.env[match[1]] === undefined) process.env[match[1]] = match[2].replace(/^["']|["']$/g, "");
  }
}

if (process.env.USE_EMULATORS !== "0") {
  process.env.FIRESTORE_EMULATOR_HOST ||= "127.0.0.1:8080";
  process.env.FIREBASE_AUTH_EMULATOR_HOST ||= "127.0.0.1:9099";
  process.env.FIREBASE_STORAGE_EMULATOR_HOST ||= "127.0.0.1:9199";
  process.env.FIREBASE_PROJECT_ID ||= "demo-oss";
  process.env.FIREBASE_STORAGE_BUCKET ||= "demo-oss.appspot.com";
  process.env.INVOICE_LINK_SECRET ||= "local-development-secret-not-for-production-use";
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
  console.log(process.env.FIRESTORE_EMULATOR_HOST ? `Using Firebase emulators (project ${process.env.FIREBASE_PROJECT_ID}).` : "Using live Firebase credentials from the environment.");
});
