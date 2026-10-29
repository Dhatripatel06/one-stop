# ONE STOP SOLUTION (OSS) — Catalogue, Inventory, Orders & Billing

*Every Problem, One Solution*

A customer-facing wholesale catalogue with WhatsApp ordering, plus a protected admin panel for products, categories, stock, orders, customers and GST-ready invoices.

- **Customer site:** `index.html` (catalogue), `product.html?sku=OSS_014`, `order.html`
- **Admin panel:** `admin.html` (Firebase Authentication sign-in)
- **Backend:** one Vercel serverless function (`api/index.js` → `server/`) using the Firebase Admin SDK
- **Database:** Firebase Firestore (source of truth for all business data)
- **Product images:** Cloudinary (file storage and delivery); Firestore stores each image's URL and public ID

## Architecture

```
Browser (static HTML + ES modules, no build step)
   │  /api/*  (JSON; admin calls carry a Firebase ID token)
   ▼
api/index.js ── server/router.js ── products · categories · inventory · orders
                                    invoices · customers · dashboard · csv · image registry
   │  firebase-admin (service account from env vars)
   │  Cloudinary API (signs uploads; API secret stays here)
   ▼
Firestore  ·  Firebase Auth            Cloudinary (images)
```

* Browsers never write to Firestore. `firestore.rules` and `storage.rules` deny all direct client access; every write goes through the API, which validates input, checks permissions and recalculates prices.
* Money is stored as integer paise. Totals, discounts and GST are computed in `shared/pricing.js`. The browser uses the same code for estimates only; the server's figures are the ones that count.
* Order items and invoice lines store snapshots (name, SKU, price, tax), so editing a product never changes past documents.

### Firestore collections

| Collection | Purpose |
|---|---|
| `products` | Catalogue (SKU, prices in paise, GST rate, min qty, stock, `images` URLs, `imageAssets` URL + public ID, status, review flags) |
| `imageAssets/{publicId}` | Every Cloudinary image: URL, public ID, size, status (`in_use` / `unused` / `deleted`) and the products using it |
| `skuIndex/{SKU}` | Uniqueness guard for SKUs (written in the same transaction as the product) |
| `categories` | Categories and subcategories (`parentId`), sort order, archived flag |
| `inventoryMovements` | Every stock change: type, before/after, reason, who, linked order |
| `orders` + `orders/{id}/items` | Orders, status history, price snapshots, reservations |
| `customers/c_<phone>` | One record per phone number, with billed/paid totals |
| `invoices` | Immutable issued invoices (lines, totals, seller/customer snapshot), payment and share status |
| `payments` | Payments recorded against invoices (voidable by the owner) |
| `counters` | Transactional sequences for order, invoice and SKU numbers |
| `settings/business` | Business details, tax configuration, invoice text |
| `admins/{uid}` | Admin users and roles (owner / staff) |
| `auditLog` | Who did what, and when |

## Business rules

**Stock** (`server/inventory.js`)
- Imported products have no verified count, so `trackStock` stays false until an **initial stock** entry is recorded. Until then, the manual status (In stock / Coming soon / Out of stock) is shown.
- Customer submission → availability check only. **Confirm** → reserves stock. **Dispatch** → deducts stock (the only deduction point). **Cancel** (before dispatch) → releases the reservation.
- Available = on hand − reserved, never negative. Every change uses a Firestore transaction, so concurrent confirmations cannot oversell.
- Manual adjustments (increase / decrease / correction) require a reason and record the admin's email.

**Orders**: Pending confirmation → Confirmed → Processing → Dispatched → Completed, plus Cancelled. Website orders may include "price on request" items; the admin sets prices before confirming. The minimum order value (₹500, from the original catalogue) applies to fully priced website orders.

**Invoices** (`server/invoices.js`)
- Issued only for confirmed (or later) orders. A pending order is a quotation, not an invoice.
- Numbered per Indian financial year with a transactional counter: `OSS/2026-27/0001`.
- Never edited after issue. To correct one, cancel it with a reason (only once it has no payments) and issue a new invoice, which records what it replaces.
- GST is **off by default**. Turning it on in Settings requires a GSTIN and business state. CGST+SGST or IGST is chosen by comparing the place of supply with the business state. The title is "Tax Invoice" only when GST is enabled with a GSTIN.

**Sharing on WhatsApp**: a `wa.me` link cannot attach files, so the app never claims an invoice was delivered.
- Phones (Web Share API with files): the PDF goes through the native share sheet; you pick WhatsApp and the customer.
- Desktop: the PDF downloads and WhatsApp opens with a prefilled message to the customer. You can include a **signed download link that expires in 7 days** (requires `INVOICE_LINK_SECRET`).
- Status moves from "Invoice ready to share" to "Share opened — delivery not confirmed". It becomes "Marked as sent" only when an admin confirms it.
- Sending PDFs automatically would need the WhatsApp Business Platform (Cloud API) with a verified business number and approved templates. That is not integrated.

## Product images (Cloudinary)

All product images live in Cloudinary. Firestore is still the source of truth: each product stores the image URL (`images`) and its public ID (`imageAssets`), and every image has a record in `imageAssets`.

**Upload flow (admin → product editor → *Upload photo*)**

1. The browser asks the API for a signature (`POST /admin/images/signature`). Only signed-in administrators get one. It is valid for one new public ID such as `oss/products/OSS_041-abc123`, for JPEG/PNG/WebP only, and never overwrites.
2. The browser uploads the (resized) photo **directly to Cloudinary** with that signature.
3. The browser sends Cloudinary's response to the API (`POST /admin/images/confirm`). The server verifies Cloudinary's signature, re-checks the file with Cloudinary (type, size ≤ 8 MB) and registers it in `imageAssets`.
4. Saving the product links it. A product can only reference registered images, so a pasted URL cannot point a product at someone else's file.

The Cloudinary **API secret is only ever on the server** (`CLOUDINARY_API_SECRET`). Browsers receive a one-off upload signature, never the secret; `npm run build` fails if the secret pattern appears in a browser-delivered file.

**Other things the editor can do:** add an image from a link (Cloudinary copies it, so the product never depends on the other site), pick from the image library, replace an image (⟳), reorder, set the main image, remove it from the product.

**Cleanup:** removing an image from a product marks it *unused*; nothing is deleted automatically. The **Images** page lists in-use / unused / deleted images, and the owner can delete unused ones from Cloudinary (in-use images cannot be deleted). Old orders keep the image URL they had when they were placed.

**Delivery:** the customer site requests Cloudinary URLs with `f_auto,q_auto,c_limit,w_…` so each device gets a correctly sized image in the best format.

**Old project-folder photos (`/OSS_001.jpg` …):** these keep working until migrated. Products still pointing at them show "Not yet in Cloudinary" in the editor; a missing file shows a placeholder and is flagged for review.

### Migrating the existing images (needs approval — not run on live data)

```bash
node scripts/migrate-images.mjs                  # dry run: lists what would be uploaded
node scripts/migrate-images.mjs --apply --confirm-project=<FIREBASE_PROJECT_ID>
npm run migrate:images -- --only OSS_001,OSS_002 # optional: a few products first
```

Each product keeps the same photo (`/OSS_014.jpg` → `oss/products/OSS_014`), the old path is saved as `legacyImages` for rollback, and nothing is deleted from the repository or Cloudinary. Re-running is safe. Photos hosted elsewhere (OSS_039's marketplace image) are **not** copied automatically — upload a photo you own, or confirm you may reuse it, in the admin panel.

## Local development

Requirements: Node 20+, **Java 21+** (for the Firebase emulators), Python 3 + Playwright (browser tests only).

```bash
npm install
npm run emulators                         # terminal 1 — Firestore + Auth emulators
npm run seed:emulator                     # loads the production snapshot + migrates + test users
ADMIN_UIDS=owner-test-uid npm run dev     # terminal 2 — http://localhost:3000
```

`npm run dev` always uses the emulators (project `demo-oss`) and refuses to start if they are not running — it never falls back to the live project. `npm run dev:live` is the explicit opt-in for the live Firebase project from `.env.local`, and prints a warning. Cloudinary uploads are real in both modes when credentials are in `.env`/`.env.local`; use `CLOUDINARY_FOLDER=oss-test` while experimenting.

Emulator sign-ins (password `Test@12345`): `owner@oss.test` (owner), `staff@oss.test` (staff), and `viewer@oss.test` (not an admin, to check access is refused).

## Tests

| Command | What it covers |
|---|---|
| `npm test` | Unit tests: pricing, GST, rounding, amount in words, validation, CSV, Cloudinary signatures and URL parsing, Firebase mode safety, financial year, signed links |
| `npm run test:integration` | Starts the emulators and runs the API workflow (auth, CRUD, duplicate SKUs, overselling, invoices, payments, signed links) and the image API offline (authorization, signature safety, registry linking, replace/remove/release, error handling) |
| `npm run test:cloudinary` | **Real Cloudinary account** (needs `.env` credentials and the emulators): signed upload, verification, delivery and resizing, replace, delete, import from a link, tampered signature, wrong credentials, outage, and the migration script. Uses the folder `oss-test` and deletes everything it uploads |
| `npm run test:browser` | Playwright: customer and admin flows, real image upload/replace/delete through the admin panel, and responsive checks at 375/768/1366/1920 px (start the dev server with `CLOUDINARY_FOLDER=oss-test`; it needs the seeded emulator) |
| `npm run build` | Project check used by Vercel: syntax, JSON, local references, imports, no secrets in browser files |

## Deploying to production

Order matters. The current live site reads Firestore directly, and the new rules block that.

1. **Firebase console** (project `one-stop-72ee5`):
   - Make sure Firestore and Authentication (Email/Password) are enabled, and register a **web app** (Project settings → Your apps) to get `FIREBASE_WEB_API_KEY` and `FIREBASE_WEB_APP_ID`.
   - Create a **dedicated service account** for the API (Google Cloud console → IAM → Service accounts) with only **Cloud Datastore User** (`roles/datastore.user`) and **Firebase Authentication Viewer** (`roles/firebaseauth.viewer`), then create a JSON key for it. The API only reads/writes Firestore and looks up users; it does not need the broader default `firebase-adminsdk` account.
   - Create the owner's sign-in (Authentication → Users) and note their UID.
   - Add the Vercel domain(s) to Authentication → Settings → **Authorized domains**, or admin sign-in fails with `auth/unauthorized-domain`.
   - Firebase Storage is **not** needed; images are in Cloudinary.
2. **Vercel → Environment Variables:** set the variables in `.env.example` (`FIREBASE_PROJECT_ID`, `FIREBASE_SERVICE_ACCOUNT`, `FIREBASE_WEB_API_KEY`, `FIREBASE_WEB_APP_ID`, `ADMIN_UIDS`, `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET`, `INVOICE_LINK_SECRET`, `PUBLIC_SITE_URL`) plus `FIREBASE_MODE=live`. Check them locally first with `npm run check:production` (add `--connect` for a read-only live connection test); it prints names and pass/fail, never values.
3. **Deploy the code** to Vercel and check `/api/health` (its `ready` flags show which integrations are configured) and `/api/catalog`. Until the migration runs, the catalogue is empty.
4. **Migrate the data** from a machine with the service account in `.env`. `one-stop-72ee5` starts empty, so the legacy snapshot is the source:
   ```bash
   node scripts/migrate.mjs --include-snapshot           # dry run — review docs/IMPORT_REPORT.md
   node scripts/migrate.mjs --include-snapshot --apply --confirm-project=one-stop-72ee5
   ```
   The snapshot of the old project's products is in `data/legacy-firestore-products.json`.
5. **Deploy indexes and rules:**
   ```bash
   npx firebase login
   npx firebase deploy --only firestore:indexes,firestore:rules --project one-stop-72ee5
   ```
   Always pass `--project one-stop-72ee5`. The signed-in Firebase account has no access to the old project `oss-digital-catalog`; commands aimed at it fail with `403 PERMISSION_DENIED`.
   Indexes can take a few minutes to build. Order and invoice lists show a clear message until they are ready.
6. **Move the images** with `node scripts/migrate-images.mjs` (dry run first, see above), then check the **Images** page.
7. Sign in at `/admin.html`. Then, in Settings, enter the verified business address, GSTIN and tax settings (if registered), payment details and invoice terms. Add prices and initial stock counts (the dashboard lists what still needs review).

## Project layout

```
index.html, app.js, style.css          customer catalogue (existing filenames kept)
product.html, order.html, js/          product page, order page, shared customer modules
admin.html, admin/                     admin panel (main.js router + views/*)
api/index.js                           Vercel function entry
server/                                API: validation, business logic, PDF (fonts in server/fonts, OFL)
shared/                                pricing/tax + constants used by browser and server
scripts/                               dev server, migration, emulator users, build check
tests/                                 unit, integration (emulator), browser (Playwright)
firestore.rules, storage.rules, firestore.indexes.json, firebase.json, vercel.json
products.json, OSS_###.jpg, 538820.jpg original catalogue data and photos (unchanged; the source for the Cloudinary migration)
images/                                placeholder.svg and manifest.json (list of the legacy project photos, written by npm run build)
docs/IMPORT_REPORT.md                  what was imported, conflicts, items to verify
```
