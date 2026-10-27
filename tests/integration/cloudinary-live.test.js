/* Live Cloudinary checks (real network, real account from .env).
   Run:  CLOUDINARY_LIVE_TESTS=1 node --test tests/integration/cloudinary-live.test.js
   Needs the Firestore + Auth emulators. Everything is uploaded under the folder
   "oss-test" and deleted afterwards. Production folders are never touched. */

import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { LIVE_CLOUDINARY, clearFirestore, client, createUser, db, startServer } from "./helpers.js";
import * as cloud from "../../server/cloudinary.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const enabled = LIVE_CLOUDINARY && cloud.isConfigured();
const created = new Set();
let server, owner, staff, anon;
const ids = {};

const photo = fs.readFileSync(path.join(root, "OSS_001.jpg"));

async function uploadDirect(sku, bytes = photo, { type = "image/jpeg", name = "photo.jpg", tamper } = {}) {
  const signed = await owner.post("/admin/images/signature", { sku });
  assert.equal(signed.status, 200, JSON.stringify(signed.data));
  const form = new FormData();
  for (const [key, value] of Object.entries(signed.data.fields)) form.append(key, tamper?.[key] ?? value);
  form.append("file", new Blob([bytes], { type }), name);
  const response = await fetch(signed.data.uploadUrl, { method: "POST", body: form });
  const body = await response.json();
  if (body.public_id) created.add(body.public_id);
  return { response, body, publicId: signed.data.fields.public_id };
}

before(async () => {
  if (!enabled) return;
  await clearFirestore();
  server = await startServer();
  owner = client(server.base, await createUser("it-owner", "it-owner@oss.test"));
  staff = client(server.base, await createUser("it-staff", "it-staff@oss.test", "staff"));
  anon = client(server.base);
  const product = await owner.post("/admin/products", { sku: "LIVE_1", name: "Live Image Test", newCategoryName: "Live" });
  ids.product = product.data.id;
});

after(async () => {
  for (const publicId of created) {
    try { await cloud.destroy(publicId); } catch (error) { console.error(`cleanup failed for ${publicId}: ${error.message}`); }
  }
  await server?.close();
});

describe("Cloudinary live", { skip: !enabled && "set CLOUDINARY_LIVE_TESTS=1 with Cloudinary credentials in .env" }, () => {
  test("browser-style signed upload, then server verification", async () => {
    const { response, body, publicId } = await uploadDirect("LIVE_1");
    assert.equal(response.status, 200, JSON.stringify(body));
    assert.equal(body.public_id, publicId, "Cloudinary used the public ID the server chose");
    assert.match(body.secure_url, new RegExp(`^https://res\\.cloudinary\\.com/${process.env.CLOUDINARY_CLOUD_NAME}/image/upload/`));

    const confirmed = await staff.post("/admin/images/confirm", body);
    assert.equal(confirmed.status, 200, JSON.stringify(confirmed.data));
    assert.equal(confirmed.data.publicId, publicId);
    assert.equal(confirmed.data.url, body.secure_url);
    assert.equal(confirmed.data.status, "unused");
    assert.ok(confirmed.data.width > 100 && confirmed.data.bytes > 1000);
    ids.first = confirmed.data;

    const again = await owner.post("/admin/images/confirm", body);
    assert.equal(again.status, 200);
    assert.equal((await owner.get("/admin/images/assets")).data.filter(a => a.publicId === publicId).length, 1, "confirming twice does not duplicate");
  });

  test("a response signature from another upload cannot be reused", async () => {
    const { body } = await uploadDirect("LIVE_1");
    const forged = await owner.post("/admin/images/confirm", { ...body, public_id: ids.first.publicId });
    assert.equal(forged.status, 400);
  });

  test("attach to a product: URL and public ID persist in Firestore and the image is delivered", async () => {
    const res = await owner.patch(`/admin/products/${ids.product}`, { images: [ids.first.url] });
    assert.equal(res.status, 200, JSON.stringify(res.data));
    assert.deepEqual(res.data.imageAssets, [{ url: ids.first.url, publicId: ids.first.publicId }]);
    const stored = (await db().collection("products").doc(ids.product).get()).data();
    assert.equal(stored.images[0], ids.first.url);
    assert.equal(stored.imageAssets[0].publicId, ids.first.publicId);

    const pub = await anon.get("/products/LIVE_1");
    assert.equal(pub.data.product.images[0], ids.first.url);

    const original = await fetch(ids.first.url);
    assert.equal(original.status, 200);
    assert.match(original.headers.get("content-type"), /^image\//);

    // The same transformation the customer site applies: resized, best format.
    const resized = ids.first.url.replace("/image/upload/", "/image/upload/f_auto,q_auto,c_limit,w_300/");
    const small = await fetch(resized, { headers: { Accept: "image/webp,image/*" } });
    assert.equal(small.status, 200);
    assert.match(small.headers.get("content-type"), /^image\//);
    const smallBytes = (await small.arrayBuffer()).byteLength;
    const fullBytes = (await original.arrayBuffer()).byteLength;
    assert.ok(smallBytes < fullBytes, `resized (${smallBytes}) is smaller than original (${fullBytes})`);
  });

  test("replace the product image, then delete the unused one from Cloudinary", async () => {
    const { body } = await uploadDirect("LIVE_1");
    const second = (await owner.post("/admin/images/confirm", body)).data;
    const replaced = await owner.patch(`/admin/products/${ids.product}`, { images: [second.url] });
    assert.equal(replaced.status, 200);
    assert.deepEqual(replaced.data.images, [second.url]);

    const list = (await owner.get("/admin/images/assets")).data;
    assert.equal(list.find(a => a.publicId === ids.first.publicId).status, "unused");
    assert.equal(list.find(a => a.publicId === second.publicId).status, "in_use");

    const blocked = await owner.del(`/admin/images/assets/${second.id}`);
    assert.equal(blocked.status, 409, "in-use images cannot be deleted");

    assert.equal((await staff.del(`/admin/images/assets/${ids.first.id}`)).status, 403);
    const deleted = await owner.del(`/admin/images/assets/${ids.first.id}`);
    assert.equal(deleted.status, 200, JSON.stringify(deleted.data));
    assert.equal(deleted.data.status, "deleted");
    await assert.rejects(() => cloud.getResource(ids.first.publicId), /not found/i, "Cloudinary no longer has the file");
    assert.equal((await owner.del(`/admin/images/assets/${ids.first.id}`)).status, 409, "already deleted");
    const reuse = await owner.patch(`/admin/products/${ids.product}`, { images: [ids.first.url] });
    assert.equal(reuse.status, 400, "a deleted image cannot be attached again");
  });

  test("copying an image from a link into Cloudinary", async () => {
    const res = await owner.post("/admin/images/import-url", { url: "https://res.cloudinary.com/demo/image/upload/sample.jpg", sku: "LIVE_1" });
    assert.equal(res.status, 200, JSON.stringify(res.data));
    created.add(res.data.publicId);
    assert.equal(res.data.source, "url");
    assert.ok(res.data.url.includes(`/${process.env.CLOUDINARY_CLOUD_NAME}/`), "stored in our account, not the source's");
    assert.equal((await fetch(res.data.url)).status, 200);
  });

  describe("failures are reported clearly", () => {
    test("a link that is not an image is refused by Cloudinary with a readable message", async () => {
      const res = await owner.post("/admin/images/import-url", { url: "https://example.com/" });
      assert.ok([400, 502].includes(res.status), String(res.status));
      assert.match(res.data.error, /Cloudinary/);
    });

    test("a tampered upload signature is rejected by Cloudinary", async () => {
      const { response, body } = await uploadDirect("LIVE_1", photo, { tamper: { signature: "0".repeat(40) } });
      assert.equal(response.status, 401);
      assert.match(body.error.message, /signature/i);
    });

    test("a disallowed file type is rejected even with a valid signature", async () => {
      const { response, body } = await uploadDirect("LIVE_1", Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>"), { type: "image/svg+xml", name: "x.svg" });
      assert.notEqual(response.status, 200, JSON.stringify(body));
    });

    test("wrong server credentials produce a clear error, not a crash", async () => {
      const saved = process.env.CLOUDINARY_API_SECRET;
      process.env.CLOUDINARY_API_SECRET = "definitely-wrong";
      try {
        const res = await owner.post("/admin/images/import-url", { url: "https://res.cloudinary.com/demo/image/upload/sample.jpg" });
        assert.equal(res.status, 502);
        assert.match(res.data.error, /rejected the credentials/);
      } finally {
        process.env.CLOUDINARY_API_SECRET = saved;
      }
    });

    test("an unreachable Cloudinary is reported as a connection problem", async () => {
      const realFetch = globalThis.fetch;
      globalThis.fetch = (url, init) => (String(url).includes("api.cloudinary.com") ? Promise.reject(new TypeError("fetch failed")) : realFetch(url, init));
      try {
        const res = await owner.post("/admin/images/import-url", { url: "https://res.cloudinary.com/demo/image/upload/sample.jpg" });
        assert.equal(res.status, 502);
        assert.match(res.data.error, /Could not reach Cloudinary/);
      } finally {
        globalThis.fetch = realFetch;
      }
    });
  });

  describe("migrating the existing catalogue", () => {
    const run = (...args) => execFileSync(process.execPath, ["scripts/migrate-images.mjs", "--emulator", ...args], {
      cwd: root, env: { ...process.env, CLOUDINARY_FOLDER: "oss-test" }, encoding: "utf8"
    });

    test("dry run changes nothing; --apply moves the image and keeps the mapping; re-running is a no-op", async () => {
      const made = await owner.post("/admin/products", { sku: "LIVE_MIG", name: "Migrated Product", categoryId: "live" });
      const ref = db().collection("products").doc(made.data.id);
      await ref.update({ images: ["OSS_001.jpg"] });

      const dry = run("--only", "LIVE_MIG");
      assert.match(dry, /would upload \/OSS_001\.jpg → oss-test\/LIVE_MIG/);
      assert.deepEqual((await ref.get()).get("images"), ["OSS_001.jpg"]);

      const applied = run("--apply", "--only", "LIVE_MIG");
      created.add("oss-test/LIVE_MIG");
      assert.match(applied, /Migrated: 1/);
      const product = (await ref.get()).data();
      assert.match(product.images[0], new RegExp(`^https://res\\.cloudinary\\.com/${process.env.CLOUDINARY_CLOUD_NAME}/image/upload/.+/oss-test/LIVE_MIG\\.jpg$|oss-test/LIVE_MIG`));
      assert.deepEqual(product.legacyImages, ["OSS_001.jpg"], "old path kept for rollback");
      assert.equal(product.imageAssets[0].publicId, "oss-test/LIVE_MIG");
      const asset = (await db().collection("imageAssets").doc("oss-test__LIVE_MIG").get()).data();
      assert.equal(asset.status, "in_use");
      assert.deepEqual(asset.productIds, [made.data.id]);
      assert.equal(asset.migratedFrom, "/OSS_001.jpg");
      assert.equal((await fetch(product.images[0])).status, 200);

      const pub = await anon.get("/products/LIVE_MIG");
      assert.equal(pub.data.product.images[0], product.images[0], "the website serves the migrated image");

      const again = run("--apply", "--only", "LIVE_MIG");
      assert.match(again, /Migrated: 0/);
      assert.match(again, /already on Cloudinary/);
      assert.deepEqual((await ref.get()).get("images"), product.images);
    });

    test("a live Firestore project is never written without an explicit confirmation", () => {
      assert.throws(() => execFileSync(process.execPath, ["scripts/migrate-images.mjs", "--apply"], {
        cwd: root,
        env: { PATH: process.env.PATH, FIREBASE_PROJECT_ID: "example-project", FIREBASE_SERVICE_ACCOUNT: "{}", CLOUDINARY_CLOUD_NAME: "x", CLOUDINARY_API_KEY: "x", CLOUDINARY_API_SECRET: "x" },
        encoding: "utf8", stdio: "pipe"
      }), /./);
    });
  });
});
