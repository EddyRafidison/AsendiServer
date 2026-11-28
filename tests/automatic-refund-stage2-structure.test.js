"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const root = path.resolve(__dirname, "..");
const read = (name) => fs.readFileSync(path.join(root, name), "utf8");

function block(source, start, end) {
  const a = source.indexOf(start);
  assert.notEqual(a, -1, `Missing start marker: ${start}`);
  const b = source.indexOf(end, a + start.length);
  assert.notEqual(b, -1, `Missing end marker: ${end}`);
  return source.slice(a, b);
}

const routes = read("routes.js");
const service = read("automatic-refund-service.js");
const worker = read("automatic-refund-worker.js");
const schema = read("db.js");

test("all four refund categories are connected to finalized source events", () => {
  const bsc = block(routes, "async function processConfirmedUsdtPayment", "async function updateBatchEventStatus");
  const xtu = read("xtu-deposit-worker.js");
  const expiry = block(routes, "async function expireOneUsdtDepositBatch", "async function expireDueUsdtDepositBatches");
  assert.match(bsc, /category: "A"/);
  assert.match(bsc, /inGlobalRefundPeriod \? "B"/);
  assert.match(bsc, /accountInactiveForRefund \? "C"/);
  assert.match(xtu, /category: "A"/);
  assert.match(xtu, /category: "C"/);
  assert.match(expiry, /const category = wasActiveAtExpiry \? "D" : "C"/);
});

test("shared refund groups enforce same sender/token/contract and a one-percent source-event retention", () => {
  assert.match(service, /chain_id/);
  assert.match(service, /token_contract/);
  assert.match(service, /asset_code/);
  assert.match(service, /sender_address/);
  assert.match(read("automatic-refund-policy.js"), /REFUND_FEE_RATE = new BigNumber\("0\.01"\)/);
  assert.match(read("automatic-refund-policy.js"), /MINIMUM_AUTOMATIC_REFUND_NET = new BigNumber\("1"\)/);
  assert.match(service, /calculateRefundEventFee/);
  assert.match(service, /refund_eligible_at_ms/);
  assert.match(service, /MAXIMUM_REFUND_GAS_EQUIVALENT/);
  assert.match(service, /WAIT_FOR_REFUND_RESOLUTION/);
});

test("refund aggregation deducts gas once and never applies an age-based small-refund deadline", () => {
  const reservation = block(service, "async function reserveAutomaticRefundPayoutTx", "async function restoreAutomaticRefundPayoutTx");
  assert.match(reservation, /gross\.minus\(fees\)\.minus\(gas\)/);
  assert.match(reservation, /net\.lt\(ONE\)/);
  for (const obsolete of ["review_due_at_ms", "next_review_at_ms", "SMALL_REFUND_REVIEW_DELAY_MS", "reviewDue"]) {
    assert.doesNotMatch(schema + service + worker, new RegExp(obsolete));
  }
});

test("signup blocks outstanding refunds and fails closed unless both finalized scanners reach the reference block", () => {
  const signup = block(routes, 'router.post("/app/signup"', 'router.post("/app/signin"');
  assert.match(signup, /ensureWalletFinancialLockTx/);
  assert.match(signup, /captureLiveSignupFinalizedReferenceBlock/);
  assert.match(signup, /bsc_incoming_scan_state/);
  assert.match(signup, /xtu_deposit_scan_state/);
  assert.match(signup, /getOutstandingRefundObligationsTx/);
  assert.match(signup, /auth: "refund_pending"/);
  assert.match(signup, /status\(423\)/);
  assert.match(signup, /status\(503\)/);
  assert.match(signup, /registered_at_block/);
});

test("refund payout worker is disabled by default and persists the same signed raw transaction before broadcast", () => {
  assert.match(worker, /AUTOMATIC_REFUNDS_ENABLED \|\| "false"/);
  assert.match(read(".env.example"), /AUTOMATIC_REFUNDS_ENABLED=false/);
  assert.match(worker, /SET raw_tx=\?,tx_hash=\?,nonce=\?,status='signed'/);
  assert.match(worker, /broadcastTransaction\(payout\.raw_tx\)/);
  assert.match(worker, /payout\.raw_tx \|\| payout\.tx_hash/);
  assert.match(worker, /markAutomaticRefundManualReviewTx/);
  assert.match(worker, /configured payout signer/);
  assert.match(worker, /signerAddress !== from/);
});

test("BSC-USD and XTU custody/liquidity checks protect the shared refund obligations from other spenders", () => {
  assert.match(read("treasury-liquidity.js"), /automatic_refund_group_events/);
  assert.match(read("treasury-liquidity.js"), /g\.asset_code='BSC-USD'/);
  assert.match(read("xtu-deposit-worker.js"), /getUnbackedAutomaticRefundXtuAmount/);
  assert.match(read("automatic-refund-worker.js"), /xtu_withdrawals/);
  assert.match(read("automatic-refund-worker.js"), /xtu_global_settlement_ledger/);
  assert.match(read("xtu-withdrawal-worker.js"), /automatic_refund_payouts/);
  assert.match(routes, /reconcileDeactivatedBscDepositBatches/);
  assert.match(read("xtu-deposit-worker.js"), /reconcileDeactivatedXtuDepositBatches/);
});

test("the XTU contract and application policies require zero transfer commission", () => {
  assert.match(read("contracts/OneXToken.sol"), /TRANSFER_FEE_BPS\s*=\s*0/);
  assert.match(read("xtu-deposit-policy.js"), /XTU_TRANSFER_FEE_BPS\s*=\s*0n/);
  assert.match(read("xtu-withdrawal-policy.js"), /XTU_TRANSFER_FEE_BPS\s*=\s*0n/);
  assert.match(worker, /TRANSFER_FEE_BPS\(\)\) !== 0n/);
});
