import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { execFileSync } from "node:child_process";

// The repo root is the Vercel output directory, so anything not excluded is
// public. These rules keep customer documents and credentials out of it.
const lines = file => fs.readFileSync(new URL(`../../${file}`, import.meta.url), "utf8").split(/\r?\n/).map(l => l.trim());

test(".vercelignore and .gitignore exclude customer documents and credentials", () => {
  for (const file of [".vercelignore", ".gitignore"]) {
    const rules = lines(file);
    for (const rule of ["*.pdf", "*.csv", "*.xlsx", "*service-account*.json", "one-stop-72ee5-*.json", ".env"]) {
      assert.ok(rules.includes(rule), `${file} must list ${rule}`);
    }
  }
});

test("no PDF, spreadsheet or key file is tracked by Git", () => {
  const tracked = execFileSync("git", ["ls-files"], { encoding: "utf8" }).split("\n");
  const bad = tracked.filter(f => /\.(pdf|xlsx?|csv|docx)$/i.test(f) || /(service-account|firebase-adminsdk|one-stop-72ee5-).*\.json$/i.test(f));
  assert.deepEqual(bad.filter(f => fs.existsSync(f)), [], "private files are tracked and present in the working tree");
});
