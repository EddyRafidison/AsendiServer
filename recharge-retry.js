"use strict";

async function markPendingRechargeBatchesDueTx(tx, username, excludedBatchId = null) {
  const safeUsername = String(username || "").trim();
  if (!safeUsername) return 0;
  const now = String(Date.now());
  const params = [now, now, safeUsername];
  let exclusion = "";
  if (excludedBatchId != null) {
    exclusion = " AND id<>?";
    params.push(String(excludedBatchId));
  }
  const [result] = await tx.query(
    `UPDATE users_usdt_deposit_batches
     SET next_attempt_at_ms=?,updated_at_ms=?
     WHERE username=? AND remaining_amount>0
       AND status IN ('pending_credit','pending_reserve','pending_weekly','pending_support')${exclusion}`,
    params,
  );
  return Number(result.affectedRows || 0);
}

module.exports = { markPendingRechargeBatchesDueTx };
