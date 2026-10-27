/* =========================================================
   DASHBOARD — every number is computed from stored data.
========================================================= */

import { AggregateField } from "firebase-admin/firestore";
import { db, Timestamp } from "./firebase.js";
import { availabilityOf, availableQty } from "./products.js";
import { imageStatus, toPublicPath } from "./local-images.js";

async function countWhere(field, value) {
  const snap = await db().collection("orders").where(field, "==", value).count().get();
  return snap.data().count;
}

function istDayStart(dateText) {
  return new Date(`${dateText}T00:00:00+05:30`);
}

export async function getDashboard({ from, to } = {}) {
  const today = new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
  const monthStart = `${today.slice(0, 8)}01`;
  const fromText = /^\d{4}-\d{2}-\d{2}$/.test(from || "") ? from : monthStart;
  const toText = /^\d{4}-\d{2}-\d{2}$/.test(to || "") ? to : today;
  const start = istDayStart(fromText);
  const end = new Date(istDayStart(toText).getTime() + 86400000);

  const [productSnap, pending, confirmed, processing, dispatched, sales, outstanding, recent] = await Promise.all([
    db().collection("products").get(),
    countWhere("status", "pending"),
    countWhere("status", "confirmed"),
    countWhere("status", "processing"),
    countWhere("status", "dispatched"),
    db().collection("invoices")
      .where("status", "==", "issued")
      .where("issuedAt", ">=", Timestamp.fromDate(start))
      .where("issuedAt", "<", Timestamp.fromDate(end))
      .aggregate({ total: AggregateField.sum("totals.grandTotal"), count: AggregateField.count() })
      .get(),
    db().collection("invoices")
      .where("status", "==", "issued")
      .where("paymentStatus", "in", ["unpaid", "partial"])
      .aggregate({ total: AggregateField.sum("balanceDue"), count: AggregateField.count() })
      .get(),
    db().collection("orders").orderBy("createdAt", "desc").limit(6).get()
  ]);

  const productsList = productSnap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
  const active = productsList.filter(p => p.status === "active");
  const lowStock = active.filter(p => availabilityOf(p) === "low_stock");
  const outOfStock = active.filter(p => availabilityOf(p) === "out_of_stock");
  const untracked = active.filter(p => !p.trackStock);
  const imageProblem = p => ["missing", "none"].includes(imageStatus((p.images || []).map(toPublicPath).filter(Boolean)));
  const missingImages = productsList.filter(p => p.status !== "archived" && imageProblem(p));
  const needsReview = productsList.filter(p => p.status !== "archived" && ((p.needsReview || []).length || imageProblem(p)));
  const unpriced = active.filter(p => p.price === null || p.price === undefined);

  const brief = p => ({ id: p.id, sku: p.sku, name: p.name, available: availableQty(p), threshold: p.lowStockThreshold ?? null, image: toPublicPath((p.images || [])[0]) || "" });

  return {
    period: { from: fromText, to: toText },
    products: {
      active: active.length,
      lowStock: lowStock.length,
      outOfStock: outOfStock.length,
      untracked: untracked.length,
      needsReview: needsReview.length,
      unpriced: unpriced.length,
      missingImages: missingImages.length,
      lowStockItems: lowStock.slice(0, 10).map(brief),
      outOfStockItems: outOfStock.slice(0, 10).map(brief)
    },
    orders: {
      awaitingConfirmation: pending,
      toFulfil: confirmed + processing,
      dispatched
    },
    sales: { total: sales.data().total || 0, invoices: sales.data().count || 0 },
    outstanding: { total: outstanding.data().total || 0, invoices: outstanding.data().count || 0 },
    recentOrders: recent.docs.map(doc => ({
      id: doc.id,
      orderNo: doc.get("orderNo"),
      status: doc.get("status"),
      customer: doc.get("customer")?.name || "",
      grandTotal: doc.get("totals")?.grandTotal ?? null,
      createdAt: doc.get("createdAt")?.toDate?.().toISOString() || null
    }))
  };
}
