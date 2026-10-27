/* =========================================================
   PROJECT CHECK (also used as the build step on Vercel)
   The site has no bundler; this verifies it is deployable:
   - every JS module parses
   - config / data JSON is valid
   - local files referenced by HTML, imports and products.json exist
   - no server secrets appear in browser-delivered files
   - images/manifest.json lists the product images in the project
     (`--build` regenerates it; plain `check` only verifies it)
========================================================= */

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BUILD = process.argv.includes("--build");
const problems = [];
const SKIP = new Set(["node_modules", ".git", ".vercel", ".emulator-data", "tests"]);

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

const files = walk(root);
const rel = file => path.relative(root, file).replace(/\\/g, "/");
const jsFiles = files.filter(f => /\.(m?js)$/.test(f));

// 1. Syntax
for (const file of jsFiles) {
  const result = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  if (result.status !== 0) problems.push(`Syntax error in ${rel(file)}:\n${result.stderr.trim()}`);
}

// 2. JSON
for (const name of ["package.json", "vercel.json", "firebase.json", "firestore.indexes.json", "products.json", ".firebaserc"]) {
  try { JSON.parse(fs.readFileSync(path.join(root, name), "utf8")); }
  catch (error) { problems.push(`Invalid JSON in ${name}: ${error.message}`); }
}

// 3. HTML references
for (const file of files.filter(f => f.endsWith(".html"))) {
  const html = fs.readFileSync(file, "utf8");
  for (const [, ref] of html.matchAll(/(?:src|href)="([^"#?]+)"/g)) {
    if (/^(https?:|mailto:|tel:|data:|\/\/)/.test(ref) || ref.startsWith("#")) continue;
    if (!fs.existsSync(path.join(path.dirname(file), ref))) problems.push(`${rel(file)} references missing file ${ref}`);
  }
}

// 4. Relative imports in modules
for (const file of jsFiles) {
  const code = fs.readFileSync(file, "utf8");
  for (const [, spec] of code.matchAll(/(?:import\s[^'"]*?from\s*|import\s*\(\s*|export\s[^'"]*?from\s*)["'](\.{1,2}\/[^"']+)["']/g)) {
    if (!fs.existsSync(path.resolve(path.dirname(file), spec))) problems.push(`${rel(file)} imports missing module ${spec}`);
  }
}

// 5. Catalogue images
const products = JSON.parse(fs.readFileSync(path.join(root, "products.json"), "utf8"));
for (const product of products) {
  if (product.image && !fs.existsSync(path.join(root, product.image))) problems.push(`products.json: ${product.code} image ${product.image} is missing`);
}

// 6. No server secrets in browser files
const browserFiles = files.filter(f => /\.(html|css|js)$/.test(f) && !rel(f).startsWith("server/") && !rel(f).startsWith("api/") && !rel(f).startsWith("scripts/"));
const SECRET = /(BEGIN (RSA )?PRIVATE KEY|"private_key"\s*:|private_key_id|FIREBASE_PRIVATE_KEY\s*=|INVOICE_LINK_SECRET\s*=|CLOUDINARY_API_SECRET\s*=|cloudinary:\/\/[^\s:'"]+:[^\s@'"]+@|client_secret)/;
for (const file of browserFiles) {
  if (SECRET.test(fs.readFileSync(file, "utf8"))) problems.push(`Possible secret in browser-delivered file ${rel(file)}`);
}
for (const name of [".env", ".env.local"]) {
  if (fs.existsSync(path.join(root, name))) {
    const ignored = fs.readFileSync(path.join(root, ".gitignore"), "utf8").split(/\r?\n/).includes(name);
    if (!ignored) problems.push(`${name} exists but is not listed in .gitignore`);
  }
}

// 7. Product image manifest (used by the deployed API to validate image paths)
const { writeManifest, listLocalImages } = await import("../server/local-images.js");
const manifestFile = path.join(root, "images", "manifest.json");
const before = fs.existsSync(manifestFile) ? fs.readFileSync(manifestFile, "utf8") : "";
if (BUILD) {
  writeManifest();
} else {
  const onDisk = listLocalImages();
  const listed = before ? JSON.parse(before).images : [];
  if (JSON.stringify(onDisk) !== JSON.stringify(listed)) problems.push("images/manifest.json is out of date. Run npm run build.");
}

// 8. The API must load on this Node.js. Vercel builds and runs the function on
//    the same version, so a runtime that cannot load firebase-admin (its
//    jwks-rsa dependency require()s the ESM-only `jose`) fails here instead of
//    crashing every /api request in production.
const adminEngines = JSON.parse(fs.readFileSync(path.join(root, "node_modules", "firebase-admin", "package.json"), "utf8")).engines?.node || "";
const minMajor = Number(adminEngines.match(/\d+/)?.[0] || 0);
if (Number(process.versions.node.split(".")[0]) < minMajor) {
  problems.push(`Node.js ${process.version} is older than firebase-admin requires (${adminEngines}). Set "engines.node" in package.json.`);
}
try {
  await import(pathToFileURL(path.join(root, "api", "index.js")).href);
} catch (error) {
  problems.push(`The API cannot load on Node.js ${process.version}: ${error.code || ""} ${error.message.split("\n")[0]}`);
}

if (problems.length) {
  console.error(`✖ ${problems.length} problem(s):\n- ${problems.join("\n- ")}`);
  process.exit(1);
}
const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
console.log(`✔ Project check passed: ${jsFiles.length} JS modules, ${files.filter(f => f.endsWith(".html")).length} HTML pages, ${manifest.images.length} product images in the manifest.`);
