"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const root = path.resolve(__dirname, "..");
const read = (name) => fs.readFileSync(path.join(root, name), "utf8");

function between(source, start, end) {
  const a = source.indexOf(start);
  assert.notEqual(a, -1, `Missing start marker ${start}`);
  const b = source.indexOf(end, a + start.length);
  assert.notEqual(b, -1, `Missing end marker ${end}`);
  return source.slice(a, b);
}

test("legacy BSC-USD public refund challenge and request endpoints are permanently retired", () => {
  const routes = read("routes.js");
  const challenge = between(routes, 'router.post("/public/bsc/unknown-transfers/refund-challenge"', 'router.post("/public/bsc/unknown-transfers/refund-request"');
  const request = between(routes, 'router.post("/public/bsc/unknown-transfers/refund-request"', 'router.post("/admin/bsc/unknown-transfers/list"');
  assert.match(challenge, /status\(410\)/);
  assert.match(request, /status\(410\)/);
  assert.match(challenge + request, /automatic refund|automatically/i);
});

test("official unknown BSC-USD events are registered automatically as category A", () => {
  const routes = read("routes.js");
  const payment = between(routes, "async function processConfirmedUsdtPayment", "async function updateBatchEventStatus");
  assert.match(payment, /registerAutomaticRefundEventTx/);
  assert.match(payment, /category: "A"/);
  assert.match(payment, /automatic_refund_pending/);
  assert.match(payment, /ensureWalletFinancialLockTx/);
});

test("the shared automatic-refund worker persists and reconciles a single signed transaction", () => {
  const worker = read("automatic-refund-worker.js");
  assert.match(worker, /AUTOMATIC_REFUNDS_ENABLED/);
  assert.match(worker, /raw_tx/);
  assert.match(worker, /tx_hash/);
  assert.match(worker, /nonce/);
  assert.match(worker, /broadcastTransaction\(payout\.raw_tx\)/);
  assert.match(worker, /markAutomaticRefundManualReviewTx/);
  assert.doesNotMatch(worker, /signTransaction\([^\n]*replacement/i);
});
