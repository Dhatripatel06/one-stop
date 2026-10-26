/* =========================================================
   ORDER LIST (cart)
   Only SKUs and quantities are kept in the browser. Prices, stock and
   totals are always taken from the server when the order is placed.
========================================================= */

const KEY = "oss.order.v1";

function read() {
  try {
    const data = JSON.parse(localStorage.getItem(KEY) || "[]");
    return Array.isArray(data) ? data.filter(item => item && item.sku && Number.isInteger(item.qty) && item.qty > 0) : [];
  } catch {
    return [];
  }
}

function write(items) {
  try {
    localStorage.setItem(KEY, JSON.stringify(items));
  } catch {
    // Storage may be unavailable (private mode); the cart still works for this page view.
  }
  memory = items;
  window.dispatchEvent(new CustomEvent("cart:change", { detail: { items } }));
}

let memory = read();

export const cart = {
  items() {
    return memory.map(item => ({ ...item }));
  },
  qty(sku) {
    return memory.find(item => item.sku === sku)?.qty || 0;
  },
  count() {
    return memory.length;
  },
  totalUnits() {
    return memory.reduce((sum, item) => sum + item.qty, 0);
  },
  set(sku, qty) {
    const clean = Math.max(0, Math.min(100000, Math.floor(Number(qty) || 0)));
    const items = memory.filter(item => item.sku !== sku);
    if (clean > 0) {
      const index = memory.findIndex(item => item.sku === sku);
      const entry = { sku, qty: clean };
      if (index === -1) items.push(entry);
      else items.splice(index, 0, entry);
    }
    write(items);
  },
  add(sku, qty = 1) {
    this.set(sku, this.qty(sku) + qty);
  },
  remove(sku) {
    this.set(sku, 0);
  },
  clear() {
    write([]);
  }
};

// Keep tabs in sync.
window.addEventListener("storage", event => {
  if (event.key === KEY) {
    memory = read();
    window.dispatchEvent(new CustomEvent("cart:change", { detail: { items: memory } }));
  }
});
