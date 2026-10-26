/* =========================================================
   AUDIT LOG
========================================================= */

import { db, FieldValue } from "./firebase.js";

export function auditRef() {
  return db().collection("auditLog").doc();
}

export function auditEntry(actor, action, entity, entityId, details = {}) {
  return {
    action,
    entity,
    entityId,
    actor: actor || { uid: "system", email: "" },
    details,
    at: FieldValue.serverTimestamp()
  };
}

// Use inside a transaction: tx.set(auditRef(), auditEntry(...))
export async function audit(actor, action, entity, entityId, details) {
  await auditRef().set(auditEntry(actor, action, entity, entityId, details));
}
