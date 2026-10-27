/* =========================================================
   OSS ADMIN — boot, sign-in, layout and routing
   Authorization is enforced by the API on every request; the browser
   only decides what to show.
========================================================= */

import { initializeApp } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js";
import {
  getAuth, connectAuthEmulator, onAuthStateChanged, signInWithEmailAndPassword, signOut, sendPasswordResetEmail
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js";
import { api, setUnauthorizedHandler, setUser } from "./api.js";
import { esc, icons, toast } from "./ui.js";

const app = document.getElementById("app");
let auth = null;
let me = null;
let emulator = false;
let loginMessage = "";
let appConfig = null;

const NAV = [
  ["dashboard", "Dashboard", icons.dashboard],
  ["orders", "Orders", icons.orders],
  ["invoices", "Invoices", icons.invoices],
  ["products", "Products", icons.products],
  ["inventory", "Inventory", icons.inventory],
  ["categories", "Categories", icons.categories],
  ["images", "Images", icons.images],
  ["customers", "Customers", icons.customers],
  ["settings", "Settings", icons.settings]
];

const VIEWS = {
  dashboard: () => import("./views/dashboard.js"),
  orders: () => import("./views/orders.js"),
  invoices: () => import("./views/invoices.js"),
  products: () => import("./views/products.js"),
  inventory: () => import("./views/inventory.js"),
  categories: () => import("./views/categories.js"),
  customers: () => import("./views/customers.js"),
  settings: () => import("./views/settings.js"),
  import: () => import("./views/import.js"),
  images: () => import("./views/images.js")
};

/* ---------------- sign in ---------------- */

const AUTH_ERRORS = {
  "auth/invalid-email": "Invalid email address.",
  "auth/invalid-credential": "Incorrect email or password.",
  "auth/wrong-password": "Incorrect email or password.",
  "auth/user-not-found": "Incorrect email or password.",
  "auth/user-disabled": "This account is disabled.",
  "auth/too-many-requests": "Too many attempts. Please wait and try again.",
  "auth/network-request-failed": "Network error. Check your internet connection."
};

function renderLogin(message = "") {
  app.innerHTML = `
    <div class="login">
      <form class="login-card" id="login-form" novalidate>
        <img src="538820.jpg" alt="OSS logo">
        <h1>OSS Admin</h1>
        <p class="sub">ONE STOP SOLUTION</p>
        <div class="field" style="margin-bottom:12px"><label for="login-email">Email</label><input class="input" type="email" id="login-email" autocomplete="username" required></div>
        <div class="field" style="margin-bottom:16px"><label for="login-password">Password</label><input class="input" type="password" id="login-password" autocomplete="current-password" required></div>
        <button class="btn btn-primary btn-lg btn-block" type="submit" id="login-btn">Sign in</button>
        <p class="notice error" id="login-error" role="alert" style="margin-top:12px" ${message ? "" : "hidden"}>${esc(message)}</p>
        <button class="btn btn-ghost btn-block" type="button" id="forgot-btn" style="margin-top:8px">Forgot password?</button>
        ${emulator ? '<span class="env-badge">Local test environment (Firebase emulator)</span>' : ""}
      </form>
    </div>`;

  const form = document.getElementById("login-form");
  const errorBox = document.getElementById("login-error");
  const showError = text => { errorBox.textContent = text; errorBox.hidden = !text; };

  form.addEventListener("submit", async event => {
    event.preventDefault();
    const email = document.getElementById("login-email").value.trim();
    const password = document.getElementById("login-password").value;
    if (!email || !password) return showError("Enter your email and password.");
    const button = document.getElementById("login-btn");
    button.classList.add("is-loading");
    button.disabled = true;
    showError("");
    try {
      await signInWithEmailAndPassword(auth, email, password);
    } catch (error) {
      showError(AUTH_ERRORS[error.code] || error.message || "Sign-in failed.");
      button.classList.remove("is-loading");
      button.disabled = false;
    }
  });

  document.getElementById("forgot-btn").addEventListener("click", async () => {
    const email = document.getElementById("login-email").value.trim();
    if (!email) return showError("Enter your email above, then choose “Forgot password?”.");
    try {
      await sendPasswordResetEmail(auth, email);
      showError("");
      toast("If this email has an account, a reset link has been sent.", "success");
    } catch (error) {
      showError(AUTH_ERRORS[error.code] || error.message);
    }
  });
}

/* ---------------- shell ---------------- */

function renderShell() {
  app.innerHTML = `
    ${emulator ? '<div class="env-banner">Local test environment — data is stored in the Firebase emulator, not the live database.</div>' : ""}
    <div class="mobile-bar">
      <button type="button" id="menu-btn" aria-label="Open menu" aria-controls="sidebar" aria-expanded="false">${icons.menu}</button>
      <img src="538820.jpg" alt=""><strong>OSS Admin</strong>
    </div>
    <div class="shell">
      <aside class="sidebar" id="sidebar">
        <div class="side-brand"><img src="538820.jpg" alt=""><div><strong>ONE STOP SOLUTION</strong><span>Admin</span></div></div>
        <nav class="side-nav" aria-label="Admin">
          ${NAV.map(([key, label, icon]) => `<a href="#/${key}" data-nav="${key}">${icon}<span>${label}</span>${key === "orders" ? '<span class="pill" id="pending-pill" hidden></span>' : ""}</a>`).join("")}
        </nav>
        <div class="side-foot">
          <span class="who">${esc(me.email)}<br><span class="muted" style="color:rgba(255,255,255,.6)">${me.role === "owner" ? "Owner" : "Staff"}</span></span>
          <span class="muted" style="color:rgba(255,255,255,.6)">${emulator ? "Emulator data" : `Firebase: ${esc(appConfig?.firebase?.projectId || "")}`}</span>
          <a href="index.html" target="_blank" rel="noopener">View public catalogue ↗</a>
          <button type="button" id="logout-btn">Sign out</button>
        </div>
      </aside>
      <div class="main"><main class="content" id="view" tabindex="-1"></main></div>
    </div>`;

  const sidebar = document.getElementById("sidebar");
  const menu = document.getElementById("menu-btn");
  menu.addEventListener("click", () => {
    const open = sidebar.classList.toggle("is-open");
    menu.setAttribute("aria-expanded", String(open));
  });
  sidebar.addEventListener("click", event => {
    if (event.target.closest("a")) { sidebar.classList.remove("is-open"); menu.setAttribute("aria-expanded", "false"); }
  });
  document.getElementById("logout-btn").addEventListener("click", () => signOut(auth));
}

export async function refreshPendingCount() {
  try {
    const data = await api.get("/admin/orders?status=pending&limit=100");
    const pill = document.getElementById("pending-pill");
    if (!pill) return;
    pill.textContent = data.items.length >= 100 ? "99+" : String(data.items.length);
    pill.hidden = data.items.length === 0;
  } catch { /* non-critical */ }
}

/* ---------------- router ---------------- */

function parseHash() {
  const hash = location.hash.replace(/^#\/?/, "") || "dashboard";
  const [pathPart, queryPart = ""] = hash.split("?");
  const parts = pathPart.split("/").filter(Boolean).map(decodeURIComponent);
  return { view: parts[0] || "dashboard", params: parts.slice(1), query: new URLSearchParams(queryPart) };
}

export function navigate(path) {
  location.hash = `#/${path}`;
}

let renderToken = 0;

async function route() {
  if (!me) return;
  const { view, params, query } = parseHash();
  const loader = VIEWS[view] || VIEWS.dashboard;
  document.querySelectorAll("[data-nav]").forEach(a => {
    a.toggleAttribute("aria-current", a.dataset.nav === view || (view === "import" && a.dataset.nav === "products"));
    if (a.hasAttribute("aria-current")) a.setAttribute("aria-current", "page");
  });

  const el = document.getElementById("view");
  const token = ++renderToken;
  el.innerHTML = '<div class="loading">Loading…</div>';
  try {
    const module = await loader();
    if (token !== renderToken) return;
    await module.render(el, { params, query, admin: me, navigate, config: appConfig, isCurrent: () => token === renderToken });
    if (token === renderToken) el.focus({ preventScroll: true });
  } catch (error) {
    console.error(error);
    if (token === renderToken) el.innerHTML = `<div class="card empty"><h3>Something went wrong</h3><p>${esc(error.message)}</p></div>`;
  }
}

window.addEventListener("hashchange", () => { window.scrollTo(0, 0); route(); });

/* ---------------- boot ---------------- */

async function boot() {
  let config;
  try {
    const response = await fetch("/api/config");
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `Configuration unavailable (${response.status}).`);
    config = data;
  } catch (error) {
    app.innerHTML = `<div class="login"><div class="login-card"><h1>Admin unavailable</h1><p class="sub">${esc(error.message)}</p><button class="btn btn-primary btn-block" onclick="location.reload()">Try again</button></div></div>`;
    return;
  }

  appConfig = config;
  emulator = Boolean(config.authEmulator);
  auth = getAuth(initializeApp(config.firebase));
  if (config.authEmulator) connectAuthEmulator(auth, config.authEmulator, { disableWarnings: true });

  setUnauthorizedHandler(() => {
    if (me) toast("Your session has expired. Please sign in again.", "error");
    signOut(auth);
  });

  onAuthStateChanged(auth, async user => {
    setUser(user);
    me = null;
    if (!user) {
      renderLogin(loginMessage);
      loginMessage = "";
      return;
    }
    app.innerHTML = '<div class="loading" style="padding-top:30vh">Checking access…</div>';
    try {
      me = await api.get("/admin/me");
      renderShell();
      route();
      refreshPendingCount();
    } catch (error) {
      loginMessage = error.status === 403 ? "This account is not authorized for OSS Admin." : error.message;
      setUser(null);
      await signOut(auth);
    }
  });
}

boot();
