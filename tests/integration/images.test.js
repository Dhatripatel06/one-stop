/* Product image API — offline checks (no Cloudinary network calls).
   Registry documents are written directly to Firestore to stand in for
   images that were uploaded; the real upload/delivery path is covered by
   cloudinary-live.test.js. */

import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { clearFirestore, client, createUser, db, startServer } from "./helpers.js";
import { signParams, verifyUploadSignature } from "../../server/cloudinary.js";

const SECRET = process.env.CLOUDINARY_API_SECRET;
const CLOUD = process.env.CLOUDINARY_CLOUD_NAME;
let server, owner, staff, viewer, anon;
const ids = {};

const urlFor = publicId => `https://res.cloudinary.com/${CLOUD}/image/upload/v1730000000/${publicId}.jpg`;

// Stand-in for an uploaded image: a registry document like confirmUpload creates.
async function registerAsset(publicId) {
  const id = publicId.replace(/\//g, "__");
  await db().collection("imageAssets").doc(id).set({
    publicId, url: urlFor(publicId), version: 1730000000, format: "jpg", width: 800, height: 800, bytes: 1000,
    status: "unused", productIds: [], source: "upload", uploadedBy: { uid: "it-owner", email: "it-owner@oss.test" }
  });
  return { id, publicId, url: urlFor(publicId) };
}

before(async () => {
  await clearFirestore();
  server = await startServer();
  const [o, s, v] = await Promise.all([
    createUser("it-owner", "it-owner@oss.test"),
    createUser("it-staff", "it-staff@oss.test", "staff"),
    createUser("it-viewer", "it-viewer@oss.test")
  ]);
  owner = client(server.base, o);
  staff = client(server.base, s);
  viewer = client(server.base, v);
  anon = client(server.base);
  const created = await owner.post("/admin/products", { sku: "IMG_1", name: "Image Test", newCategoryName: "Images" });
  ids.product = created.data.id;
  const second = await owner.post("/admin/products", { sku: "IMG_2", name: "Image Test Two", categoryId: "images" });
  ids.product2 = second.data.id;
});

after(async () => {
  await server?.close();
});

describe("image endpoints require an administrator", () => {
  const calls = [
    ["POST", "/admin/images/signature", {}],
    ["POST", "/admin/images/confirm", { public_id: "oss/products/x", version: 1, signature: "x" }],
    ["POST", "/admin/images/import-url", { url: "https://example.com/a.jpg" }],
    ["GET", "/admin/images/assets"],
    ["DELETE", "/admin/images/assets/anything"]
  ];
  for (const [method, path, body] of calls) {
    test(`${method} ${path}: anonymous → 401, signed-in non-admin → 403`, async () => {
      const call = (c) => (method === "GET" ? c.get(path) : method === "DELETE" ? c.del(path) : c.post(path, body));
      assert.equal((await call(anon)).status, 401);
      assert.equal((await call(viewer)).status, 403);
    });
  }

  test("only the owner can delete library images", async () => {
    const asset = await registerAsset("oss/products/IMG_OWNERONLY");
    const res = await staff.del(`/admin/images/assets/${asset.id}`);
    assert.equal(res.status, 403);
    assert.equal((await db().collection("imageAssets").doc(asset.id).get()).get("status"), "unused");
  });

  test("the removed Firebase Storage upload routes are gone", async () => {
    assert.equal((await owner.post("/admin/images", { data: "x" })).status, 404);
    assert.equal((await owner.post("/admin/images/local", { data: "x" })).status, 404);
  });
});

describe("signed uploads never expose the secret", () => {
  test("signature is bound to one public ID and verifies with the server secret", async () => {
    const res = await staff.post("/admin/images/signature", { sku: "img_1" });
    assert.equal(res.status, 200, JSON.stringify(res.data));
    const { uploadUrl, fields } = res.data;
    assert.equal(uploadUrl, `https://api.cloudinary.com/v1_1/${CLOUD}/image/upload`);
    assert.match(fields.public_id, new RegExp(`^${process.env.CLOUDINARY_FOLDER}/IMG_1-[a-z0-9]+$`));
    assert.equal(fields.api_key, process.env.CLOUDINARY_API_KEY);
    assert.equal(fields.allowed_formats, "jpg,jpeg,png,webp");
    assert.equal(fields.overwrite, "false");
    const { signature, api_key, ...params } = fields;
    assert.equal(signature, signParams(params, SECRET));
    // The secret appears nowhere in the response.
    assert.ok(!JSON.stringify(res.data).includes(SECRET));
  });

  test("every signature uses a different public ID", async () => {
    const a = await owner.post("/admin/images/signature", { sku: "IMG_1" });
    const b = await owner.post("/admin/images/signature", { sku: "IMG_1" });
    assert.notEqual(a.data.fields.public_id, b.data.fields.public_id);
  });

  test("the public config exposes no secret and reports Cloudinary as configured", async () => {
    const res = await anon.get("/config");
    assert.equal(res.status, 200);
    assert.deepEqual(res.data.images, { provider: "cloudinary", configured: true, placeholder: "/images/placeholder.svg" });
    assert.ok(!JSON.stringify(res.data).includes(SECRET));
    assert.ok(!JSON.stringify((await anon.get("/catalog")).data).includes(SECRET));
  });

  test("confirm rejects forged or foreign uploads before contacting Cloudinary", async () => {
    const folder = process.env.CLOUDINARY_FOLDER;
    const outside = await owner.post("/admin/images/confirm", { public_id: "someone/else/photo", version: 1, signature: "0".repeat(40) });
    assert.equal(outside.status, 400);
    assert.match(outside.data.error, /not uploaded through the OSS admin panel/);
    const forged = await owner.post("/admin/images/confirm", { public_id: `${folder}/IMG_1-abc`, version: 1730000000, signature: "0".repeat(40) });
    assert.equal(forged.status, 400);
    assert.match(forged.data.error, /could not be verified/);
    const valid = { public_id: `${folder}/IMG_1-abc`, version: 1730000000 };
    assert.ok(verifyUploadSignature({ ...valid, signature: signParams(valid, SECRET) }, SECRET));
    assert.ok(!verifyUploadSignature({ ...valid, signature: signParams(valid, "wrong-secret") }, SECRET));
  });

  test("importing from a link validates the address and refuses our own Cloudinary images", async () => {
    assert.equal((await owner.post("/admin/images/import-url", { url: "http://example.com/a.jpg" })).status, 400);
    assert.equal((await owner.post("/admin/images/import-url", { url: "not a url" })).status, 400);
    const own = await owner.post("/admin/images/import-url", { url: urlFor("oss/products/ANY") });
    assert.equal(own.status, 400);
    assert.match(own.data.error, /already in Cloudinary/);
  });
});

describe("products reference registered images only", () => {
  test("an image that was never uploaded through the admin cannot be attached", async () => {
    const res = await owner.patch(`/admin/products/${ids.product}`, { images: [urlFor("oss/products/NOT_REGISTERED")] });
    assert.equal(res.status, 400);
    assert.ok(res.data.details.fields.images);
    const foreign = await owner.patch(`/admin/products/${ids.product}`, { images: ["https://res.cloudinary.com/someone-else/image/upload/v1/a.jpg"] });
    assert.equal(foreign.status, 400);
    const other = await owner.patch(`/admin/products/${ids.product}`, { images: ["https://example.com/hotlink.jpg"] });
    assert.equal(other.status, 400);
    const local = await owner.patch(`/admin/products/${ids.product}`, { images: ["/OSS_001.jpg"] });
    assert.equal(local.status, 400, "new product images must come from Cloudinary");
    assert.equal((await owner.get(`/admin/products/${ids.product}`)).data.images.length, 0, "nothing was saved");
  });

  test("attaching stores the URL and public ID in Firestore and marks the image in use", async () => {
    const a = await registerAsset("oss/products/IMG_1-first");
    const res = await owner.patch(`/admin/products/${ids.product}`, { images: [a.url] });
    assert.equal(res.status, 200, JSON.stringify(res.data));
    assert.deepEqual(res.data.images, [a.url]);
    assert.deepEqual(res.data.imageAssets, [{ url: a.url, publicId: a.publicId }]);
    assert.equal(res.data.imageStatus, "ok");
    const doc = (await db().collection("imageAssets").doc(a.id).get()).data();
    assert.equal(doc.status, "in_use");
    assert.deepEqual(doc.productIds, [ids.product]);
    ids.first = a;
  });

  test("the customer site receives the Cloudinary URL", async () => {
    const pub = await anon.get("/products/IMG_1");
    assert.equal(pub.data.product.images[0], ids.first.url);
    const catalog = await anon.get("/catalog");
    assert.equal(catalog.data.products.find(p => p.sku === "IMG_1").images[0], ids.first.url);
  });

  test("replacing an image releases the old one and claims the new one", async () => {
    const b = await registerAsset("oss/products/IMG_1-second");
    const res = await owner.patch(`/admin/products/${ids.product}`, { images: [b.url] });
    assert.equal(res.status, 200);
    assert.deepEqual(res.data.images, [b.url]);
    const oldDoc = (await db().collection("imageAssets").doc(ids.first.id).get()).data();
    assert.equal(oldDoc.status, "unused");
    assert.deepEqual(oldDoc.productIds, []);
    const newDoc = (await db().collection("imageAssets").doc(b.id).get()).data();
    assert.equal(newDoc.status, "in_use");
    ids.second = b;
  });

  test("an image shared by two products stays in use until both let go", async () => {
    const shared = ids.second;
    await owner.patch(`/admin/products/${ids.product2}`, { images: [shared.url] });
    let doc = (await db().collection("imageAssets").doc(shared.id).get()).data();
    assert.deepEqual([...doc.productIds].sort(), [ids.product, ids.product2].sort());
    await owner.patch(`/admin/products/${ids.product}`, { images: [] });
    doc = (await db().collection("imageAssets").doc(shared.id).get()).data();
    assert.equal(doc.status, "in_use");
    assert.deepEqual(doc.productIds, [ids.product2]);
  });

  test("removing the last reference marks the image unused; the file is kept", async () => {
    const res = await owner.patch(`/admin/products/${ids.product2}`, { images: [] });
    assert.equal(res.status, 200);
    const doc = (await db().collection("imageAssets").doc(ids.second.id).get()).data();
    assert.equal(doc.status, "unused");
    assert.deepEqual(doc.productIds, []);
    const list = await owner.get("/admin/images/assets?status=unused");
    assert.ok(list.data.some(a => a.id === ids.second.id));
  });

  test("an image still in use cannot be deleted", async () => {
    await owner.patch(`/admin/products/${ids.product}`, { images: [ids.second.url] });
    const res = await owner.del(`/admin/images/assets/${ids.second.id}`);
    assert.equal(res.status, 409);
    assert.match(res.data.error, /still used by 1 product/);
    assert.equal((await db().collection("imageAssets").doc(ids.second.id).get()).get("status"), "in_use");
  });

  test("deleting a product releases its images", async () => {
    const c = await registerAsset("oss/products/IMG_3-only");
    const made = await owner.post("/admin/products", { sku: "IMG_3", name: "Temp", categoryId: "images", images: [c.url] });
    assert.equal(made.status, 200, JSON.stringify(made.data));
    assert.equal((await db().collection("imageAssets").doc(c.id).get()).get("status"), "in_use");
    const del = await owner.del(`/admin/products/${made.data.id}`);
    assert.equal(del.status, 200);
    const doc = (await db().collection("imageAssets").doc(c.id).get()).data();
    assert.equal(doc.status, "unused");
    assert.deepEqual(doc.productIds, []);
  });

  test("legacy project-folder images stay until replaced, and can be kept while adding new ones", async () => {
    const legacy = await owner.post("/admin/products", { sku: "IMG_LEG", name: "Legacy", categoryId: "images" });
    await db().collection("products").doc(legacy.data.id).update({ images: ["OSS_001.jpg"] });
    const read = await owner.get(`/admin/products/${legacy.data.id}`);
    assert.deepEqual(read.data.images, ["/OSS_001.jpg"], "stored name is served as a root path");
    assert.equal(read.data.imageStatus, "ok");
    const extra = await registerAsset("oss/products/IMG_LEG-new");
    const res = await owner.patch(`/admin/products/${legacy.data.id}`, { images: ["/OSS_001.jpg", extra.url] });
    assert.equal(res.status, 200, JSON.stringify(res.data));
    assert.deepEqual(res.data.images, ["/OSS_001.jpg", extra.url]);
    assert.deepEqual(res.data.imageAssets.map(a => a.publicId), [extra.publicId]);
  });

  test("a missing legacy file is flagged so the site shows a placeholder", async () => {
    const m = await owner.post("/admin/products", { sku: "IMG_MISS", name: "Missing", categoryId: "images" });
    await db().collection("products").doc(m.data.id).update({ images: ["/does-not-exist.jpg"] });
    assert.equal((await owner.get(`/admin/products/${m.data.id}`)).data.imageStatus, "missing");
    const pub = await anon.get("/products/IMG_MISS");
    assert.deepEqual(pub.data.product.images, []);
  });

  test("concurrent edits are refused instead of overwriting", async () => {
    const current = await owner.get(`/admin/products/${ids.product}`);
    const first = await owner.patch(`/admin/products/${ids.product}`, { description: "A", expectedUpdatedAt: current.data.updatedAt });
    assert.equal(first.status, 200);
    const second = await staff.patch(`/admin/products/${ids.product}`, { description: "B", expectedUpdatedAt: current.data.updatedAt });
    assert.equal(second.status, 409);
    assert.equal(second.data.details.stale, true);
    assert.equal((await owner.get(`/admin/products/${ids.product}`)).data.description, "A");
  });

  test("saving only some fields leaves the rest untouched", async () => {
    const before = (await owner.get(`/admin/products/${ids.product}`)).data;
    await owner.patch(`/admin/products/${ids.product}`, { price: 12345 });
    const after = (await owner.get(`/admin/products/${ids.product}`)).data;
    assert.equal(after.price, 12345);
    assert.deepEqual(after.images, before.images);
    assert.equal(after.description, before.description);
    assert.equal(after.categoryId, before.categoryId);
    assert.equal(after.minQty, before.minQty);
    assert.equal(after.status, before.status);
  });
});

describe("when Cloudinary is not configured", () => {
  test("uploads report a clear 503 and the config says so; existing images still load", async () => {
    const saved = { name: process.env.CLOUDINARY_CLOUD_NAME, key: process.env.CLOUDINARY_API_KEY, secret: process.env.CLOUDINARY_API_SECRET };
    delete process.env.CLOUDINARY_CLOUD_NAME;
    delete process.env.CLOUDINARY_API_KEY;
    delete process.env.CLOUDINARY_API_SECRET;
    try {
      const sig = await owner.post("/admin/images/signature", { sku: "IMG_1" });
      assert.equal(sig.status, 503);
      assert.match(sig.data.error, /CLOUDINARY_CLOUD_NAME/);
      assert.equal((await anon.get("/config")).data.images.configured, false);
      assert.equal((await anon.get("/catalog")).status, 200);
    } finally {
      process.env.CLOUDINARY_CLOUD_NAME = saved.name;
      process.env.CLOUDINARY_API_KEY = saved.key;
      process.env.CLOUDINARY_API_SECRET = saved.secret;
    }
  });
});
