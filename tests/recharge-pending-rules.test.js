"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const routes = read("routes.js");
const db = read("db.js");
const limiter = read("http-rate-limiter.js");

function blockBetween(startMarker, endMarker) {
  const start = routes.indexOf(startMarker);
  assert.notEqual(start, -1, `Missing marker ${startMarker}`);
  const end = routes.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(end, -1, `Missing end marker ${endMarker}`);
  return routes.slice(start, end);
}

test("initial recharge credit is limited to 100 only before any tranche has been credited", () => {
  const block = blockBetween("async function processOneRechargeBatch", "async function processRechargeBatchQueue");
  assert.match(block, /creditedBefore\.isZero\(\)[\s\S]*?BigNumber\.minimum\(remainingAmount, MAX_RECHARGE_AMOUNT\)/);
  assert.match(block, /creditedBefore\.isZero\(\)[\s\S]*?: remainingAmount/);
  assert.match(block, /minimum_met_at_ms == null && totalAmount\.lt\(MIN_RECHARGE_AMOUNT\)/);
  assert.match(block, /const reasons = \["minimum_not_reached"\]/);
});

test("partial recharge tranches retain the frozen tfees rate and are recorded idempotently", () => {
  assert.match(db, /CREATE TABLE IF NOT EXISTS users_usdt_recharge_credits/);
  assert.match(db, /UNIQUE KEY uq_recharge_credit_sequence\(batch_id,credit_sequence\)/);
  assert.match(db, /UNIQUE KEY uq_recharge_credit_reference\(financial_reference\)/);
  assert.match(routes, /tfeesRatePercent: batch\.tfees_rate_percent/);
  assert.match(routes, /credited_amount=\?,remaining_amount=\?,credit_sequence=\?/);
  assert.match(routes, /remainingAfter\.isGreaterThan\(0\)/);
});

test("incoming recharge deducts no OneX BSC gas and only deducts tfees", () => {
  const apply = blockBetween("async function applyUserTopUp", "async function queueSystemDisbursement");
  assert.match(apply, /const actualBscFeeUsd = new BigNumber\(0\)/);
  assert.match(apply, /const netFeeAmountXtu = feeAmountXtu/);
  assert.match(apply, /tfeesRatePercent: appliedTfeesRate/);
});

test("pending recharge retries cover balance changes and FIFO order", () => {
  const retry = read("recharge-retry.js");
  const worker = blockBetween("async function processRechargeBatchQueue", "// ----- MAILER -----");
  assert.match(retry, /status IN \('pending_credit','pending_reserve','pending_weekly','pending_support'\)/);
  assert.match(worker, /ORDER BY id ASC LIMIT 50/);
  assert.match(routes, /previous_batch_unresolved|older_recharge_pending/);
  assert.match(routes, /markPendingRechargeBatchesDueTx\(tx, S\)/);
  assert.match(routes, /markPendingRechargeBatchesDueTx\(tx, D\)/);
  assert.match(routes, /markPendingRechargeBatchesDueTx\(tx, row\.username\)/);
});

test("user-last-stock exposes only a boolean pending-recharge indicator", () => {
  const endpoint = blockBetween('router.post("/app/user-last-stock"', 'router.post("/app/recharge"');
  assert.match(endpoint, /has_pending_recharge: hasPendingRecharge/);
  assert.match(endpoint, /const hasPendingRecharge = pendingRechargeRows\.length > 0/);
  assert.doesNotMatch(endpoint, /pending_amount:|remaining_amount:/);
});

test("Telegram outbox receives a notification on each finalized payment with the current hold reason and guidance", () => {
  const payment = blockBetween("async function processConfirmedUsdtPayment", "async function updateBatchEventStatus");
  const notifier = blockBetween("async function queueRechargeBatchStatusTx", "function safeJson");
  assert.match(payment, /queueRechargeBatchStatusTx\([\s\S]*receivedAmount: amountValue/);
  assert.match(notifier, /Your incoming BSC-USD payment has been finalized/);
  assert.match(notifier, /Current hold reason:/);
  assert.match(notifier, /Suggested action:/);
  assert.match(notifier, /previous_batch_unresolved/);
  assert.match(notifier, /older recharge is being processed first/);
  assert.match(notifier, /cannot ordinarily be cancelled or refunded/);
  const telegramWorker = read("telegram-worker.js");
  assert.match(telegramWorker, /setInterval\(\(\) => void processOutbox\(\), 1000\)/);
  assert.match(telegramWorker, /next_attempt_at_ms/);
});

test("exceptional refund requests are persisted and require administrative approval", () => {
  const userRoute = blockBetween('router.post("/app/recharge/refund-request"', '// The BSC wallet is fixed at signup');
  const adminRoute = blockBetween('router.post("/admin/recharge/refund"', '// Requeue an unsubmitted disbursement');
  assert.match(db, /CREATE TABLE IF NOT EXISTS user_usdt_refund_requests/);
  assert.match(userRoute, /getUserActivityPasswordState/);
  assert.match(userRoute, /INSERT INTO user_usdt_refund_requests/);
  assert.match(userRoute, /remaining\.gte\(threshold\)/);
  assert.match(adminRoute, /FROM user_usdt_refund_requests/);
  assert.match(adminRoute, /requestRows\[0\]\.status !== "pending_admin"/);
  assert.match(adminRoute, /request_type === "emergency" && emergency_approved === true/);
  assert.match(adminRoute, /remaining_amount=0,status='refund_queued'/);
  assert.match(routes, /async function closeStaleRechargeRefundRequestsTx/);
  assert.match(routes, /status = "auto_closed"/);
  assert.match(routes, /status = "remainder_changed"/);
  assert.match(limiter, /POST \/app\/recharge\/refund-request/);
});

for (const file of ["terms_fr.html", "terms_en.html"]) {
  test(`${file} explains partial credits, indefinite pending, and exceptional refunds`, () => {
    const html = read(file);
    assert.match(html, /200 BSC-USD/);
    assert.match(html, /60-minute|60 minutes|60 minutes|60 minutes/);
    assert.match(html, /100 BSC-USD/);
    assert.match(html, /no maximum|without a guaranteed maximum|sans délai maximal/);
    assert.match(html, /cannot ordinarily be cancelled|ne peut pas être annulée/);
  });
}

for (const file of ["privacy_fr.html", "privacy_en.html"]) {
  test(`${file} describes pending recharge and payment-processing data`, () => {
    const html = read(file);
    assert.match(html, /pending|attente/i);
    assert.match(html, /Telegram|télégramme/i);
    assert.match(html, /recharge|transfers/i);
  });
}
