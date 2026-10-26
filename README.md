# ONE STOP SOLUTION (OSS) — Catalogue, Inventory, Orders & Billing

*Every Problem One Solution*

A customer-facing wholesale catalogue with WhatsApp ordering, plus a protected admin panel for products, categories, stock, orders, customers and GST-ready invoices.

- **Customer site:** `index.html` (catalogue), `product.html?sku=OSS_014`, `order.html`
- **Admin panel:** `admin.html` (Firebase Authentication sign-in)
- **Backend:** one Vercel serverless function (`api/index.js` → `server/`) using the Firebase Admin SDK
- **Database:** Firebase Firestore (the project's existing database); images in Firebase Storage or the repository

## Architecture

```
Browser (static HTML + ES modules, no build step)
   │  /api/*  (JSON; admin calls carry a Firebase ID token)
   ▼
api/index.js ── server/router.js ── products · categories · inventory · orders
                                    invoices · customers · dashboard · csv · images
   │  firebase-admin (service account from env vars)
   ▼
Firestore  ·  Firebase Auth  ·  Firebase Storage
```

* Browsers never write to Firestore. `firestore.rules` and `storage.rules` deny all direct client access; every write goes through the API, which validates input, checks permissions and recalculates prices.
* Money is stored as integer paise. Totals, discounts and GST are computed in `shared/pricing.js`. The browser uses the same code for estimates only; the server's figures are the ones that count.
* Order items and invoice lines store snapshots (name, SKU, price, tax), so editing a product never changes past documents.

### Firestore collections

| Collection | Purpose |
|---|---|
| `products` | Catalogue (SKU, prices in paise, GST rate, min qty, stock, images, status, review flags) |
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

## Local development

Requirements: Node 20+, **Java 21+** (for the Firebase emulators), Python 3 + Playwright (browser tests only).

```bash
npm install
npm run emulators                         # terminal 1 — Firestore, Auth, Storage emulators
npm run seed:emulator                     # loads the production snapshot + migrates + test users
ADMIN_UIDS=owner-test-uid npm run dev     # terminal 2 — http://localhost:3000
```

Emulator sign-ins (password `Test@12345`): `owner@oss.test` (owner), `staff@oss.test` (staff), and `viewer@oss.test` (not an admin, to check access is refused).

## Tests

| Command | What it covers |
|---|---|
| `npm test` | Unit tests: pricing, GST, rounding, amount in words, validation, CSV, SSRF guard, financial year, signed links |
| `npm run test:integration` | Starts the emulators and runs the full API workflow: auth, CRUD, duplicate SKUs, quantities, price tampering, overselling, reservations, invoices, payments, signed links |
| `npm run test:browser` | Playwright: customer and admin flows plus responsive checks at 375/768/1366/1920 px (needs the dev server and seeded emulator) |
| `npm run build` | Project check used by Vercel: syntax, JSON, local references, imports, no secrets in browser files |

## Deploying to production

Order matters. The current live site reads Firestore directly, and the new rules block that.

1. **Firebase console** (project `oss-digital-catalog`):
   - Create a service account key (Project settings → Service accounts).
   - Enable **Firebase Storage** if you want photo uploads.
   - Find the owner's Auth UID (Authentication → Users).
2. **Vercel → Environment Variables:** set the variables in `.env.example` (`FIREBASE_SERVICE_ACCOUNT`, `FIREBASE_PROJECT_ID`, `FIREBASE_STORAGE_BUCKET`, `ADMIN_UIDS`, `INVOICE_LINK_SECRET`, `PUBLIC_SITE_URL`).
3. **Deploy the code** to Vercel and check `/api/health` and `/api/catalog`. Until the migration runs, the catalogue is empty.
4. **Migrate the data** from a machine with the service account in `.env`:
   ```bash
   node scripts/migrate.mjs           # dry run — review docs/IMPORT_REPORT.md
   node scripts/migrate.mjs --apply   # converts legacy products in place (keeps IDs + a `legacy` copy)
   ```
   A snapshot of the legacy products taken before migration is in `data/legacy-firestore-products.json`.
5. **Deploy indexes and rules:**
   ```bash
   npx firebase login
   npx firebase deploy --only firestore:indexes,firestore:rules,storage --project oss-digital-catalog
   ```
   Indexes can take a few minutes to build. Order and invoice lists show a clear message until they are ready.
6. Sign in at `/admin.html`. Then, in Settings, enter the verified business address, GSTIN and tax settings (if registered), payment details and invoice terms. Add prices and initial stock counts (the dashboard lists what still needs review).

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
products.json, OSS_###.jpg, 538820.jpg original catalogue data and photos (unchanged)
docs/IMPORT_REPORT.md                  what was imported, conflicts, items to verify
```
