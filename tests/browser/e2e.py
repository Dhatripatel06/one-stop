"""
Browser end-to-end tests (Playwright, Chromium).

Prerequisites (local, emulator data only):
    npm run emulators            # terminal 1 (JDK 21+)
    npm run seed:emulator        # resets + seeds the emulator
    CLOUDINARY_FOLDER=oss-test ADMIN_UIDS=owner-test-uid npm run dev   # terminal 2
    python tests/browser/e2e.py [base_url]

Image checks upload to the real Cloudinary account from .env, under the
throw-away folder "oss-test" (start the dev server with CLOUDINARY_FOLDER=oss-test),
and delete what they upload. They are skipped when Cloudinary is not configured.

Screenshots are written to tests/browser/screenshots/ (git-ignored).
"""

import os
import re
import sys
from playwright.sync_api import sync_playwright, expect

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:3000"
OUT = os.path.join(os.path.dirname(__file__), "screenshots")
os.makedirs(OUT, exist_ok=True)
PASSWORD = "Test@12345"
PHOTO_A = os.path.join(os.path.dirname(__file__), "..", "..", "OSS_035.jpg")
PHOTO_B = os.path.join(os.path.dirname(__file__), "..", "..", "OSS_036.jpg")
results = []


def check(name, fn):
    try:
        fn()
        results.append((name, True, ""))
        print(f"  PASS  {name}")
    except Exception as error:  # noqa: BLE001 - report every failure and continue
        results.append((name, False, str(error).splitlines()[0][:300]))
        print(f"  FAIL  {name}: {str(error).splitlines()[0][:300]}")


def cloudinary_configured():
    import json
    import urllib.request
    with urllib.request.urlopen(f"{BASE}/api/config") as response:
        return bool(json.load(response).get("images", {}).get("configured"))


def skip(name, reason):
    results.append((name, True, f"skipped: {reason}"))
    print(f"  SKIP  {name} ({reason})")


def no_overflow(page, label):
    width = page.viewport_size["width"]
    scroll = page.evaluate("document.documentElement.scrollWidth")
    assert scroll <= width, f"{label}: horizontal overflow {scroll}px > {width}px"


def admin_login(page, email):
    page.goto(f"{BASE}/admin.html", wait_until="networkidle")
    page.fill("#login-email", email)
    page.fill("#login-password", PASSWORD)
    page.click("#login-btn")


with sync_playwright() as p:
    browser = p.chromium.launch()
    errors = []

    # ------------------------------------------------------------ customer
    print("Customer site")
    ctx = browser.new_context(viewport={"width": 1366, "height": 900})
    page = ctx.new_page()
    page.on("pageerror", lambda e: errors.append(f"pageerror: {e}"))

    def load_catalogue():
        page.goto(BASE, wait_until="networkidle")
        expect(page.locator("#product-grid .card")).to_have_count(40)
        assert "40" in page.text_content("#result-count")
    check("1. products load from the persistent backend", load_catalogue)

    def search_sku():
        page.fill("#site-search", "OSS_014")
        expect(page.locator("#product-grid .card")).to_have_count(1)
        assert "Solar" in page.text_content("#product-grid .card-title")
        page.fill("#site-search", "oss 14")
        expect(page.locator("#product-grid .card")).to_have_count(1)
        page.fill("#site-search", "")
    check("2. search by SKU (OSS_014, 'oss 14')", search_sku)

    def filter_category():
        page.click('[data-category="water-bottle"]')
        expect(page.locator("#product-grid .card")).to_have_count(5)
        metas = page.locator("#product-grid .card-meta").all_text_contents()
        assert all("Water Bottle" in m for m in metas), metas
        page.click('[data-category="all"]')
    check("3. filter by category", filter_category)

    def correct_image():
        page.goto(f"{BASE}/product.html?sku=OSS_014", wait_until="networkidle")
        src = page.get_attribute("#gallery-main img", "src")
        assert src == "/OSS_014.jpg", src
        assert page.evaluate("document.querySelector('#gallery-main img').naturalWidth") > 0
    check("4. product shows its own photograph", correct_image)

    def invalid_qty():
        page.fill("#qty-input", "0")
        expect(page.locator("#qty-error")).to_be_visible()
        expect(page.locator("#add-btn")).to_be_disabled()
        page.fill("#qty-input", "2")
        expect(page.locator("#add-btn")).to_be_enabled()
        page.click("#add-btn")
    check("9a. invalid quantity blocked in the browser", invalid_qty)

    def place_order():
        page.goto(BASE, wait_until="networkidle")
        page.click('[data-add="OSS_002"]')
        page.goto(f"{BASE}/order.html", wait_until="networkidle")
        expect(page.locator(".line-item")).to_have_count(2)
        page.reload(wait_until="load")
        expect(page.locator(".line-item")).to_have_count(2)  # cart survives refresh
        page.fill("#f-name", "Browser Test")
        page.fill("#f-phone", "12345")
        page.click("#submit-btn")
        expect(page.locator('[data-error="phone"]')).not_to_be_empty()
        page.fill("#f-phone", "9812345678")
        page.click("#submit-btn")
        page.wait_for_selector(".order-no")
        assert re.match(r"ORD-\d{4}-\d{5}", page.text_content(".order-no"))
        href = page.get_attribute(".btn-wa", "href")
        assert "wa.me/919499806747" in href and "ORD-" in href
        page.screenshot(path=f"{OUT}/customer-order-success.png")
    check("10. multi-product order submitted, WhatsApp message prefilled", place_order)
    ctx.close()

    # ------------------------------------------------------------ admin
    print("Admin panel")
    ctx = browser.new_context(viewport={"width": 1366, "height": 900}, accept_downloads=True)
    page = ctx.new_page()
    page.on("pageerror", lambda e: errors.append(f"pageerror: {e}"))

    def unauthorized():
        admin_login(page, "viewer@oss.test")
        expect(page.locator("#login-error")).to_contain_text("not authorized")
    check("17. non-admin account is refused", unauthorized)

    CLOUDINARY = cloudinary_configured()
    uploaded = {}

    def create_product():
        admin_login(page, "owner@oss.test")
        page.wait_for_selector(".stats")
        page.goto(f"{BASE}/admin.html#/products/new")
        page.wait_for_selector("#product-form")
        page.fill('[name="name"]', "Browser Test Product")
        page.fill('[name="sku"]', "OSS_900")
        page.select_option('[name="categoryId"]', "home-and-kitchen")
        page.fill('[name="price"]', "499")
        if CLOUDINARY:
            page.set_input_files("#image-file", PHOTO_A)
            page.wait_for_selector('#images .img-tile img[src*="res.cloudinary.com"]', timeout=60000)
            uploaded["a"] = page.get_attribute("#images .img-tile img", "src")
        page.click("#save-btn")
        page.wait_for_url(re.compile(r"#/products/[^n]"))
        page.wait_for_selector("text=OSS_900")
        uploaded["id"] = page.url.split("#/products/")[1]
    check("5. create a product (with a signed Cloudinary upload and preview)", create_product)

    def duplicate_sku():
        page.goto(f"{BASE}/admin.html#/products/new")
        page.wait_for_selector("#product-form")
        page.fill('[name="name"]', "Duplicate")
        page.fill('[name="sku"]', "OSS_900")
        page.select_option('[name="categoryId"]', "home-and-kitchen")
        page.click("#save-btn")
        expect(page.locator('.error[data-for="sku"]')).to_contain_text("already exists")
    check("8. duplicate SKU is refused in the form", duplicate_sku)

    def update_image():
        if not CLOUDINARY:
            return
        page.goto(f"{BASE}/admin.html#/products/{uploaded['id']}")
        page.wait_for_selector("#images .img-tile")
        # Replace the main photo with a different one.
        with page.expect_file_chooser() as chooser:
            page.click('#images [data-index="0"] [data-img="replace"]')
        chooser.value.set_files(PHOTO_B)
        page.wait_for_function(
            "(previous) => document.querySelector('#images .img-tile img').src !== previous", arg=uploaded["a"], timeout=60000)
        page.click("#save-btn")
        page.wait_for_selector(".toast.success")
        page.reload(wait_until="load")
        page.wait_for_selector("#images img")
        replaced = page.get_attribute("#images .img-tile img", "src")
        assert "res.cloudinary.com" in replaced and replaced != uploaded["a"], replaced
        uploaded["b"] = replaced
        # The customer site shows the new image, resized and delivered by Cloudinary.
        page.goto(f"{BASE}/product.html?sku=OSS_900", wait_until="networkidle")
        shown = page.get_attribute("#gallery-main img", "src")
        assert "res.cloudinary.com" in shown and "f_auto" in shown, shown
        assert page.evaluate("document.querySelector('#gallery-main img').naturalWidth") > 0
    check("6+19. replace a product image; change persists after refresh and reaches the site", update_image)

    def image_library_cleanup():
        if not CLOUDINARY:
            return
        page.goto(f"{BASE}/admin.html#/products/{uploaded['id']}")
        page.wait_for_selector("#images .img-tile")
        page.click('#images [data-index="0"] [data-img="remove"]')
        page.click("#save-btn")
        page.wait_for_selector(".toast.success")
        page.goto(f"{BASE}/admin.html#/images?status=unused")
        page.wait_for_selector("[data-delete]")
        count = page.locator("[data-delete]").count()
        assert count >= 2, f"expected the replaced and removed images to be unused, got {count}"
        for _ in range(count):
            page.locator("[data-delete]:not([disabled])").first.click()
            page.click("[data-ok]")
            page.wait_for_selector("text=Image deleted from Cloudinary.")
            # the list reloads after each deletion; wait for it before the next click
            page.wait_for_function("() => document.querySelectorAll('[data-delete][disabled]').length === 0")
            page.wait_for_timeout(300)
        assert page.locator("[data-delete]").count() == 0
        page.goto(f"{BASE}/admin.html#/images?status=deleted")
        page.wait_for_selector("text=Deleted from Cloudinary")
    check("6b. removed images become unused and the owner can delete them", image_library_cleanup)

    def update_stock():
        page.goto(f"{BASE}/admin.html#/inventory/OSS_002")
        page.click("#adjust")
        page.fill('[name="qty"]', "5")
        page.fill('[name="reason"]', "Opening stock count")
        page.click("#adjust-save")
        page.wait_for_selector(".toast.success")
        page.wait_for_timeout(500)
        values = page.locator(".stat .value").all_text_contents()
        assert values[0] == "5" and values[2] == "5", values
        assert "Opening stock count" in page.text_content(".card")
    check("7. stock updated with recorded movement", update_stock)

    def order_invoice_share():
        page.goto(f"{BASE}/admin.html#/orders?status=pending")
        page.wait_for_selector("tr[data-id]")
        page.locator("tr[data-id]").first.click()
        page.wait_for_selector("#actions")
        page.click("#edit-items")
        page.wait_for_selector("#edit-save")
        for price_input in page.locator('dialog [data-k="price"]').all():
            price_input.fill("250")
        page.click("#edit-save")
        page.wait_for_selector(".toast.success")
        page.click('[data-status="confirmed"]')
        page.click("[data-ok]")
        page.wait_for_selector("text=Order confirmed.")
        page.wait_for_selector("#preview-invoice")
        page.click("#preview-invoice")
        page.wait_for_selector("dialog .invoice-sheet")
        page.click("#issue-btn")
        page.click("[data-ok]")
        page.wait_for_selector("#share-wa")
        number = page.text_content("h1")
        assert re.search(r"OSS/\d{4}-\d{2}/\d{4}", number), number
        page.screenshot(path=f"{OUT}/admin-invoice.png", full_page=True)
        with page.expect_download() as download:
            page.click("#pdf-btn")
        assert download.value.suggested_filename.endswith(".pdf")
        with ctx.expect_page() as popup:
            with page.expect_download():
                page.click("#share-wa")
        assert "whatsapp.com" in popup.value.url or "wa.me" in popup.value.url, popup.value.url
        popup.value.close()
        expect(page.locator("#share-status")).to_contain_text("delivery not confirmed")
        # Reopen the invoice from the list.
        page.goto(f"{BASE}/admin.html#/invoices")
        page.wait_for_selector("tr[data-id]")
        page.locator("tr[data-id]").first.click()
        page.wait_for_selector(".invoice-sheet")
        assert number.split()[-1] in page.text_content("h1")
    check("11-15. confirm, invoice, PDF, WhatsApp share, reopen", order_invoice_share)

    def cancel_restores_stock():
        page.goto(f"{BASE}/admin.html#/inventory/OSS_002")
        page.wait_for_selector(".stat .value")
        reserved_before = int(page.locator(".stat .value").nth(1).text_content())
        assert reserved_before >= 1, reserved_before
        page.goto(f"{BASE}/admin.html#/invoices")
        page.locator("tr[data-id]").first.click()
        page.wait_for_selector("#cancel-btn")
        page.click("#cancel-btn")
        page.fill("#confirm-input", "Test correction")
        page.click("[data-ok]")
        page.wait_for_selector("text=Invoice cancelled.")
        page.click("text=Go to order")
        page.wait_for_selector('[data-status="cancelled"]')
        page.click('[data-status="cancelled"]')
        page.fill("#confirm-input", "Customer cancelled")
        page.click("[data-ok]")
        page.wait_for_selector("text=Order cancelled.")
        page.goto(f"{BASE}/admin.html#/inventory/OSS_002")
        page.wait_for_selector(".stat .value")
        page.wait_for_timeout(400)
        assert page.locator(".stat .value").nth(1).text_content() == "0"
        assert "Reservation released" in page.text_content("main")
    check("16. cancelling releases reserved stock", cancel_restores_stock)

    def staff_settings_readonly():
        page.click("#logout-btn")
        page.wait_for_selector("#login-email")
        page.fill("#login-email", "staff@oss.test")
        page.fill("#login-password", PASSWORD)
        page.click("#login-btn")
        page.wait_for_selector(".stats")
        page.goto(f"{BASE}/admin.html#/settings")
        page.wait_for_selector("text=Only the owner can change settings.")
        assert page.locator("#save-settings").count() == 0
    check("17b. staff cannot edit owner settings", staff_settings_readonly)
    ctx.close()

    # ------------------------------------------------------------ responsive
    print("Responsive layout")
    for width, height, label in [(375, 812, "mobile"), (768, 1024, "tablet"), (1366, 900, "desktop"), (1920, 1080, "wide")]:
        def responsive(width=width, height=height, label=label):
            c = browser.new_context(viewport={"width": width, "height": height})
            pg = c.new_page()
            for path in ["/", "/product.html?sku=OSS_022", "/order.html"]:
                pg.goto(BASE + path, wait_until="networkidle")
                no_overflow(pg, f"{label} {path}")
            pg.goto(BASE, wait_until="networkidle")
            pg.screenshot(path=f"{OUT}/home-{label}.png")
            admin_login(pg, "owner@oss.test")
            pg.wait_for_selector(".stats")
            for route in ["dashboard", "products", "orders", "invoices", "inventory", "customers", "settings", "products/OSS_001"]:
                pg.goto(f"{BASE}/admin.html#/{route}")
                pg.wait_for_selector("#view h1")
                pg.wait_for_timeout(250)
                no_overflow(pg, f"{label} admin {route}")
            pg.screenshot(path=f"{OUT}/admin-{label}.png", full_page=True)
            if width < 960:
                pg.click("#menu-btn")
                expect(pg.locator("#sidebar")).to_have_class(re.compile("is-open"))
                pg.click('[data-nav="orders"]')
                pg.wait_for_selector("#view h1:has-text('Orders')")
            c.close()
        check(f"18. no horizontal overflow — {label} ({width}px), public + admin", responsive)

    browser.close()

failed = [r for r in results if not r[1]]
if errors:
    print("\nJavaScript errors:", *errors, sep="\n  ")
print(f"\n{len(results) - len(failed)}/{len(results)} browser checks passed.")
sys.exit(1 if failed or errors else 0)
