/* =========================================================
   INVENTORY
   Stock policy (see shared/constants.js ORDER_TRANSITIONS):
     - Customer submission:  availability check only (no reservation)
     - Order confirmed:      reservedQty += qty   (movement "reserve")
     - Order dispatched:     stockQty -= qty, reservedQty -= qty ("deduct")
     - Order cancelled:      reservedQty -= qty   ("release"), only before dispatch
   Stock is deducted exactly once, at dispatch.
   available = stockQty - reservedQty, and can never go negative.

   Products imported from the old catalogue have no verified stock count,
   so trackStock=false until an "initial" entry is recorded.
========================================================= */

import { db, FieldValue } from "./firebase.js";
import { Validator } from "./validate.js";
import { badRequest, conflict, notFound } from "./http.js";
import { actorOf } from "./auth.js";

const movements = () => db().collection("inventoryMovements");

function movementDoc(product, productId, change) {
  return {
    productId,
    sku: product.sku,
    productName: product.name,
    type: change.type,
    qtyChange: change.qtyChange,
    stockBefore: change.stockBefore,
    stockAfter: change.stockAfter,
    reservedBefore: change.reservedBefore,
    reservedAfter: change.reservedAfter,
    reason: change.reason || "",
    orderId: change.orderId || null,
    orderNo: change.orderNo || null,
    actor: change.actor || { uid: "system", email: "" },
    at: FieldValue.serverTimestamp()
  };
}

/* ---------------------------------------------------------
   MANUAL ADJUSTMENTS
--------------------------------------------------------- */

export async function adjustStock(productId, input, admin) {
  const v = new Validator(input);
  const type = v.oneOf("type", ["initial", "increase", "decrease", "correction"], { required: true, label: "Adjustment type" });
  const qty = v.int("qty", { required: true, min: 0, max: 10_000_000, label: "Quantity" });
  const reason = v.string("reason", { required: true, min: 3, max: 300, label: "Reason" });
  const threshold = v.has("lowStockThreshold") ? v.int("lowStockThreshold", { min: 0, max: 1_000_000, nullable: true }) : undefined;
  if ((type === "increase" || type === "decrease") && qty === 0) v.fail("qty", "Quantity must be more than zero.");
  v.assert();

  const actor = actorOf(admin);
  const ref = db().collection("products").doc(productId);

  return db().runTransaction(async tx => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw notFound("Product not found.");
    const product = snap.data();

    const stockBefore = product.trackStock ? product.stockQty || 0 : 0;
    const reserved = product.reservedQty || 0;
    let stockAfter;

    if (type === "initial") {
      if (product.trackStock) throw conflict("Initial stock is already recorded. Use increase, decrease or correction.");
      stockAfter = qty;
    } else {
      if (!product.trackStock) throw conflict("Record the initial stock count for this product first.");
      if (type === "increase") stockAfter = stockBefore + qty;
      if (type === "decrease") stockAfter = stockBefore - qty;
      if (type === "correction") stockAfter = qty;
    }

    if (stockAfter < 0) throw badRequest("Stock cannot go below zero.", { fields: { qty: "Stock cannot go below zero." } });
    if (stockAfter < reserved) {
      throw conflict(`${reserved} unit(s) are reserved for confirmed orders. Stock cannot be set below ${reserved}.`, { fields: { qty: `Minimum is ${reserved} (reserved for orders).` } });
    }

    const update = {
      trackStock: true,
      stockQty: stockAfter,
      reservedQty: reserved,
      updatedAt: FieldValue.serverTimestamp(),
      updatedBy: actor
    };
    if (threshold !== undefined) update.lowStockThreshold = threshold;
    if (type === "initial") {
      update.needsReview = (product.needsReview || []).filter(item => item.field !== "stock");
    }

    tx.update(ref, update);
    const movementRef = movements().doc();
    tx.set(movementRef, movementDoc(product, productId, {
      type, qtyChange: stockAfter - stockBefore, stockBefore, stockAfter,
      reservedBefore: reserved, reservedAfter: reserved, reason, actor
    }));

    return { productId, stockQty: stockAfter, reservedQty: reserved, available: stockAfter - reserved, movementId: movementRef.id };
  });
}

/* ---------------------------------------------------------
   ORDER-DRIVEN CHANGES (called inside order transactions)
   `entries` = [{ ref, data, qty }] where data is the product as read in tx.
   These functions only write; callers must have done all reads already.
--------------------------------------------------------- */

// Throws if any tracked product cannot cover its quantity.
export function assertAvailable(entries) {
  const shortages = [];
  for (const { data, qty } of entries) {
    if (!data.trackStock) continue;
    const available = (data.stockQty || 0) - (data.reservedQty || 0);
    if (available < qty) shortages.push({ sku: data.sku, name: data.name, requested: qty, available: Math.max(0, available) });
  }
  if (shortages.length) {
    const list = shortages.map(s => `${s.sku} (requested ${s.requested}, available ${s.available})`).join(", ");
    throw conflict(`Not enough stock for: ${list}.`, { shortages });
  }
}

export function reserveInTx(tx, entries, order, actor) {
  for (const { ref, data, qty } of entries) {
    if (!data.trackStock) continue;
    const reservedBefore = data.reservedQty || 0;
    const reservedAfter = reservedBefore + qty;
    tx.update(ref, { reservedQty: reservedAfter, updatedAt: FieldValue.serverTimestamp() });
    tx.set(movements().doc(), movementDoc(data, ref.id, {
      type: "reserve", qtyChange: 0, stockBefore: data.stockQty || 0, stockAfter: data.stockQty || 0,
      reservedBefore, reservedAfter, reason: `Order ${order.orderNo} confirmed`, orderId: order.id, orderNo: order.orderNo, actor
    }));
    data.reservedQty = reservedAfter;
  }
}

export function releaseInTx(tx, entries, order, actor, reason) {
  for (const { ref, data, reserved } of entries) {
    if (!reserved) continue;
    const reservedBefore = data.reservedQty || 0;
    const reservedAfter = Math.max(0, reservedBefore - reserved);
    tx.update(ref, { reservedQty: reservedAfter, updatedAt: FieldValue.serverTimestamp() });
    tx.set(movements().doc(), movementDoc(data, ref.id, {
      type: "release", qtyChange: 0, stockBefore: data.stockQty || 0, stockAfter: data.stockQty || 0,
      reservedBefore, reservedAfter, reason: reason || `Order ${order.orderNo} cancelled`, orderId: order.id, orderNo: order.orderNo, actor
    }));
    data.reservedQty = reservedAfter;
  }
}

export function deductInTx(tx, entries, order, actor) {
  for (const { ref, data, reserved } of entries) {
    if (!reserved) continue;
    const stockBefore = data.stockQty || 0;
    const reservedBefore = data.reservedQty || 0;
    const stockAfter = stockBefore - reserved;
    const reservedAfter = Math.max(0, reservedBefore - reserved);
    if (stockAfter < 0) throw conflict(`Stock for ${data.sku} would become negative. Check inventory before dispatching.`);
    tx.update(ref, { stockQty: stockAfter, reservedQty: reservedAfter, updatedAt: FieldValue.serverTimestamp() });
    tx.set(movements().doc(), movementDoc(data, ref.id, {
      type: "deduct", qtyChange: -reserved, stockBefore, stockAfter,
      reservedBefore, reservedAfter, reason: `Order ${order.orderNo} dispatched`, orderId: order.id, orderNo: order.orderNo, actor
    }));
    data.stockQty = stockAfter;
    data.reservedQty = reservedAfter;
  }
}

/* ---------------------------------------------------------
   HISTORY
--------------------------------------------------------- */

export async function listMovements({ productId, limit = 50, before } = {}) {
  let query = movements().orderBy("at", "desc");
  if (productId) query = movements().where("productId", "==", productId).orderBy("at", "desc");
  if (before) query = query.startAfter(new Date(before));
  const snap = await query.limit(Math.min(Number(limit) || 50, 200)).get();
  const items = snap.docs.map(doc => {
    const data = doc.data();
    return { id: doc.id, ...data, at: data.at?.toDate?.().toISOString() || null };
  });
  return { items, next: items.length ? items[items.length - 1].at : null };
}
