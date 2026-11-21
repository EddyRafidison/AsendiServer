"use strict";

async function recordRefundRequestEventTx(tx, event) {
  if (!event || event.requestId == null) return false;

  const eventKey = String(event.eventKey || "").trim().slice(0, 191);
  const eventType = String(event.eventType || "status_changed").trim().slice(0, 32);
  if (!eventKey || !eventType) throw new Error("Refund request audit events require an event key and event type.");

  await tx.query(
    `INSERT INTO user_usdt_refund_request_events
     (request_id,refund_id,event_key,event_type,actor_type,actor_username,old_status,new_status,
      reason,tx_hash,gross_amount,fee_amount,net_amount,created_at_ms)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON DUPLICATE KEY UPDATE event_key=VALUES(event_key)`,
    [
      String(event.requestId),
      event.refundId == null ? null : String(event.refundId),
      eventKey,
      eventType,
      String(event.actorType || "system").slice(0, 16),
      event.actorUsername == null ? null : String(event.actorUsername).slice(0, 64),
      event.oldStatus == null ? null : String(event.oldStatus).slice(0, 24),
      event.newStatus == null ? null : String(event.newStatus).slice(0, 24),
      event.reason == null ? null : String(event.reason).slice(0, 2000),
      event.txHash == null ? null : String(event.txHash).slice(0, 66),
      String(event.grossAmount ?? "0"),
      String(event.feeAmount ?? "0"),
      String(event.netAmount ?? "0"),
      String(event.createdAtMs ?? Date.now()),
    ],
  );
  return true;
}

module.exports = { recordRefundRequestEventTx };
