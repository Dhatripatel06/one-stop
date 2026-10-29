import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = file => fs.readFileSync(new URL(`../../${file}`, import.meta.url), "utf8");
const TAGLINE = "Every Problem, One Solution";

test("homepage shows the exact tagline and no 'Wholesale Catalogue' heading", () => {
  const html = read("index.html");
  assert.match(html, new RegExp(`<p class="hero-tagline">${TAGLINE}</p>`));
  assert.doesNotMatch(html, /wholesale catalogue/i);
  assert.doesNotMatch(read("js/ui.js"), /wholesale catalogue/i);
});

test("the image-based 'Shop by Category' section stays removed; filters remain", () => {
  const html = read("index.html");
  assert.doesNotMatch(html, /shop by category/i);
  assert.match(html, /id="category-chips"/);
  assert.match(html, /id="category-quick"/);
  assert.match(read("app.js"), /state\.category !== "all" && product\.categoryId !== state\.category/);
});

test("default tagline (server and storefront) includes the comma", () => {
  assert.match(read("server/settings.js"), new RegExp(`tagline: "${TAGLINE}"`));
  assert.match(read("js/ui.js"), new RegExp(`tagline: "${TAGLINE}"`));
});
