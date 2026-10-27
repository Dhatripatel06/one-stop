/* Minimal .env loader for local scripts (no dependency).
   Values already present in the environment win. */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// `only` (optional RegExp) restricts which variable names are loaded.
export function loadEnv(files = [".env.local", ".env"], only = null) {
  for (const file of files) {
    const full = path.join(root, file);
    if (!fs.existsSync(full)) continue;
    for (const line of fs.readFileSync(full, "utf8").split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (match && (!only || only.test(match[1])) && process.env[match[1]] === undefined) process.env[match[1]] = match[2].replace(/^["']|["']$/g, "");
    }
  }
}
