"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const routes = read("routes.js");
const db = read("db.js");
const xtuWorker = read("xtu-deposit-worker.js");
const disbursement = read("disbursement.js");

function blockBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `Missing marker ${startMarker}`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(end, -1, `Missing end marker ${endMarker}`);
  return source.slice(start, end);
}

test("BSC-USD opens a 30-day dossier on first finality and closes collection as soon as 20 is reached", () => {
  const payment = blockBetween(routes, "async function processConfirmedUsdtPayment", "async function updateBatchEventStatus");
  assert.match(payment, /const finalizedAtMs = Date\.now\(\)/);
  assert.match(payment, /const expiresAt = openedAt \+ DEPOSIT_PENDING_EXPIRATION_MS/);
  assert.match(payment, /amountValue\.gte\(MIN_DEPOSIT_AMOUNT\) \? "ready" : "collecting"/);
  assert.match(payment, /nextTotal\.gte\(MIN_DEPOSIT_AMOUNT\) \? "ready" : "collecting"/);
  assert.doesNotMatch(payment, /60\s*\*\s*60|BATCH_WINDOW|window_minutes/i);
});

test("BSC-USD processes each credit tranche at no more than 100 and preserves the remainder", () => {
  const worker = blockBetween(routes, "async function processOneDepositBatch", "async function processDepositBatchQueue");
  assert.match(worker, /BigNumber\.minimum\(remainingAmount, MAX_INITIAL_CREDIT_TRANCHE_AMOUNT\)/);
  assert.match(worker, /remainingAfter\.isGreaterThan\(0\)/);
  assert.match(worker, /minimum_met_at_ms == null && totalAmount\.lt\(MIN_DEPOSIT_AMOUNT\)/);
});

test("the pending API returns separate decimal amounts and individual expiration timers", () => {
  const endpoint = blockBetween(routes, 'router.post("/app/user-last-stock"', 'router.post("/app/deposit"');
  assert.match(endpoint, /pending_deposits:/);
  assert.match(endpoint, /bsc_usd: \{ total_pending_amount: totalPendingBsc\.toFixed\(18\), batches: pendingBscDetails \}/);
  assert.match(endpoint, /xtu: \{ total_pending_amount: totalPendingXtu\.toFixed\(18\), batches: pendingXtuDetails \}/);
  assert.match(endpoint, /pending_amount: remaining\.toFixed\(18\)/);
  assert.match(endpoint, /expires_at_ms: expiry/);
  assert.match(endpoint, /remaining_ms: expiry > 0 \? Math\.max\(0, expiry - nowForPending\) : null/);
  assert.match(endpoint, /reason_codes: reasons/);
});

test("BSC-USD unqualified expiry routes every uncredited finalized source event to category D or C without touching common reserves", () => {
  const expiry = blockBetween(routes, "async function expireOneUsdtDepositBatch", "async function expireDueUsdtDepositBatches");
  const transfer = blockBetween(routes, "async function transferBscBatchRemainderToAutomaticRefundTx", "async function getBscExpiryScannerCatchupBoundary");
  assert.match(expiry, /getBscExpiryScannerCatchupBoundary/);
  assert.match(expiry, /totalGross\.gte\(MIN_DEPOSIT_AMOUNT\)/);
  assert.match(expiry, /const category = wasActiveAtExpiry \? "D" : "C"/);
  assert.match(expiry, /transferBscBatchRemainderToAutomaticRefundTx/);
  assert.match(transfer, /getUncreditedBscBatchEventSlicesTx/);
  assert.match(transfer, /registerAutomaticRefundEventTx/);
  assert.match(transfer, /grossAmount: event\.uncreditedAmount\.toFixed\(18\)/);
  assert.match(transfer, /status='refund_queued'/);
  assert.doesNotMatch(expiry, /INSERT IGNORE INTO deposit_expiration_events/);
  assert.doesNotMatch(expiry, /total_units_price|backed_units|inactive_init_asset/);
});

test("XTU credit is independent of custody consolidation and consolidation remains at least 100 net", () => {
  assert.match(xtuWorker, /Credit processing is deliberately independent from Hot Wallet custody/);
  assert.match(xtuWorker, /await retryCredit\(pool, retryRows\[0\]\.id, runtime\)/);
  assert.match(xtuWorker, /The XTU consolidation lot must contain at least 100 XTU actually received by the Hot Wallet/);
  assert.match(xtuWorker, /protected_hot_wallet_amount=0/);
  assert.match(xtuWorker, /common_reserve_owned/);
  assert.match(xtuWorker, /physical XTU remains protected in the Hot Wallet until an eligible FIFO consolidation lot reaches at least 100 XTU net/);
  assert.match(xtuWorker, /xtu_deposit_consolidations WHERE status IN \('signed','submitted'\)/);
  assert.doesNotMatch(xtuWorker, /allowExpiredBelowMinimum|force.*consolidation.*below.*100/i);
});

test("XTU expiry reclassifies the remaining value but does not decrement common.xtu_wallets or force a transfer", () => {
  const expiry = blockBetween(xtuWorker, "async function expireOneXtuDepositBatch", "async function expireDueXtuDepositBatches");
  assert.match(expiry, /status='forfeited_to_common_reserve'/);
  assert.match(expiry, /total_units_price/);
  assert.match(expiry, /expired_common_reserve_amount/);
  assert.match(expiry, /status='common_reserve_owned'/);
  assert.match(expiry, /No OneX deposit fee was charged on this uncredited remainder/);
  assert.doesNotMatch(expiry, /UPDATE common SET[^;]*xtu_wallets/i);
  assert.doesNotMatch(expiry, /INSERT INTO xtu_deposit_consolidations/);
});

test("XTU consolidation gas receipt reconciles each credit tranche and expired common reserve", () => {
  const finalize = blockBetween(xtuWorker, "async function finalizeConsolidation", "async function markConsolidationBatchesManualReview");
  assert.match(finalize, /gas_actual_fee_xtu=\?/);
  assert.match(finalize, /deposit_expiration_events/);
  assert.match(finalize, /gas_adjustment_value/);
  assert.match(finalize, /total_units_price: adjustedTotal\.toFixed\(30\)/);
  assert.match(finalize, /The consolidation is a custody transfer only/);
});

test("legacy public refund requests are retired and normal refund payouts use the shared automatic register", () => {
  const userRoute = blockBetween(routes, 'router.post("/app/deposit/refund-request"', 'router.post("/app/set-payout-address"');
  assert.match(userRoute, /status\(410\)/);
  assert.match(userRoute, /automatic refund|automatically/i);
  assert.match(routes, /registerAutomaticRefundEventTx/);
  assert.match(routes, /automatic_refund_pending/);
  assert.match(disbursement, /batch_id IS NULL AND unknown_transfer_id IS NOT NULL AND user_request_id IS NULL/);
});

for (const file of ["terms_fr.html", "terms_en.html", "privacy_fr.html", "privacy_en.html"]) {
  test(`${file} describes the 30-day BSC-USD deposit boundary and current automatic-refund policy`, () => {
    const html = read(file);
    assert.match(html, /30-day|30 days|30 jours|30 × 24 heures/i);
    assert.match(html, /BSC-USD/);
    assert.match(html, /XTU/);
    assert.match(html, /1%|1 %|one percent|un pour cent/i);
    assert.match(html, /1 (?:BSC-USD|XTU)|one unit|une unité/i);
    assert.match(html, /automatic refund|remboursement automatique/i);
    assert.doesNotMatch(html, /(?:per|after|during) (?:a )?60-minute collection|session de 60 minutes|session of 60 minutes/i);
  });
}
