"use strict";

const DAY_MS = 24 * 60 * 60 * 1000;

const ACCOUNT_SECURITY_POLICIES = Object.freeze({
  password_change: Object.freeze({ maxFailed: 3, maxSuccessful: 1 }),
  seed_change: Object.freeze({ maxFailed: 3, maxSuccessful: 1 }),
  account_recovery: Object.freeze({ maxRequests: 2 }),
  device_registration: Object.freeze({ maxFailed: 5, maxSuccessful: 5 }),
});

function countRecentEvents(events, nowMs = Date.now(), windowMs = DAY_MS) {
  const cutoff = nowMs - windowMs;
  const counts = { failed: 0, successful: 0, request: 0 };
  for (const event of events || []) {
    const createdAt = Number(event.created_at_ms);
    if (!Number.isFinite(createdAt) || createdAt < cutoff || createdAt > nowMs) continue;
    if (event.outcome === "failed") counts.failed += 1;
    else if (event.outcome === "successful") counts.successful += 1;
    else if (event.outcome === "request") counts.request += 1;
  }
  return counts;
}

function evaluateAccountActionLimit(action, counts) {
  const policy = ACCOUNT_SECURITY_POLICIES[action];
  if (!policy) throw new RangeError("Unknown account security action");

  if (action === "account_recovery") {
    return {
      allowed: Number(counts.request || 0) < policy.maxRequests,
      reason: "request_limit",
    };
  }

  const failed = Number(counts.failed || 0);
  const successful = Number(counts.successful || 0);
  return {
    allowed: successful < policy.maxSuccessful,
    canRecordFailure: failed < policy.maxFailed,
    reason: successful >= policy.maxSuccessful ? "success_limit" : (failed >= policy.maxFailed ? "failure_limit" : null),
  };
}

async function lockAccountSecurityActionTx(tx, username, action) {
  await tx.execute(
    `INSERT IGNORE INTO account_security_action_locks(username,action,updated_at_ms)
     VALUES(?,?,?)`,
    [username, action, String(Date.now())],
  );
  const [rows] = await tx.execute(
    `SELECT username FROM account_security_action_locks
     WHERE username=? AND action=? LIMIT 1 FOR UPDATE`,
    [username, action],
  );
  if (!rows.length) throw new Error("Unable to lock account security action");
  await tx.execute(
    "UPDATE account_security_action_locks SET updated_at_ms=? WHERE username=? AND action=?",
    [String(Date.now()), username, action],
  );
}

async function getRecentAccountSecurityEventsTx(tx, username, action, nowMs = Date.now()) {
  const [rows] = await tx.execute(
    `SELECT outcome
     FROM account_security_events
     WHERE username=? AND action=? AND created_at_ms>=? AND created_at_ms<=?
     FOR UPDATE`,
    [username, action, String(nowMs - DAY_MS), String(nowMs)],
  );
  const counts = { failed: 0, successful: 0, request: 0 };
  for (const row of rows) {
    if (Object.prototype.hasOwnProperty.call(counts, row.outcome)) counts[row.outcome] += 1;
  }
  return counts;
}

async function recordAccountSecurityEventTx(tx, username, action, outcome, nowMs = Date.now()) {
  if (!ACCOUNT_SECURITY_POLICIES[action]) throw new RangeError("Unknown account security action");
  if (!(["failed", "successful", "request"].includes(outcome))) {
    throw new RangeError("Invalid account security event outcome");
  }
  await tx.execute(
    `INSERT INTO account_security_events(username,action,outcome,created_at_ms)
     VALUES(?,?,?,?)`,
    [username, action, outcome, String(nowMs)],
  );
}

async function consumeAccountApiRateLimit(db, username, action, limit, windowMs, nowMs = Date.now()) {
  if (!username || typeof username !== "string") return true;
  if (!Number.isInteger(limit) || limit <= 0 || !Number.isInteger(windowMs) || windowMs <= 0) {
    throw new RangeError("Invalid account API rate limit");
  }

  const windowStartMs = Math.floor(nowMs / windowMs) * windowMs;
  await db.executeAsync(
    `INSERT IGNORE INTO account_api_rate_limits
      (username,action,window_start_ms,request_count,updated_at_ms)
     VALUES(?,?,?,0,?)`,
    [username, action, String(windowStartMs), String(nowMs)],
  );
  const result = await db.executeAsync(
    `UPDATE account_api_rate_limits
     SET request_count=request_count+1,updated_at_ms=?
     WHERE username=? AND action=? AND window_start_ms=? AND request_count<?`,
    [String(nowMs), username, action, String(windowStartMs), limit],
  );
  return result.affectedRows === 1;
}

module.exports = {
  DAY_MS,
  ACCOUNT_SECURITY_POLICIES,
  countRecentEvents,
  evaluateAccountActionLimit,
  lockAccountSecurityActionTx,
  getRecentAccountSecurityEventsTx,
  recordAccountSecurityEventTx,
  consumeAccountApiRateLimit,
};
