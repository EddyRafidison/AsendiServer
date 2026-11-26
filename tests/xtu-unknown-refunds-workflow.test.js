"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const root = path.resolve(__dirname, "..");
const read = (name) => fs.readFileSync(path.join(root, name), "utf8");

const routes = read("routes.js");
const worker = read("xtu-deposit-worker.js");
const schema = read("db.js");
const limiter = read("http-rate-limiter.js");
const policy = read("xtu-unknown-refund-policy.js");

function between(source, start, end) {
  const a = source.indexOf(start);
  assert.notEqual(a, -1, `Missing start marker ${start}`);
  const b = source.indexOf(end, a + start.length);
  assert.notEqual(b, -1, `Missing end marker ${end}`);
  return source.slice(a, b);
}

test("XTU unknown transfers have isolated incoming, request, refund and audit ledgers", () => {
  for (const table of ["xtu_unknown_incoming_transfers", "xtu_unknown_refund_requests", "xtu_unknown_refunds", "xtu_unknown_refund_events"]) {
    assert.match(schema, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`));
  }
  assert.match(schema, /uq_xtu_unknown_event_identity/);
  assert.match(schema, /uq_xtu_unknown_refund_request_transfer/);
  assert.match(schema, /uq_xtu_unknown_refund_transfer/);
  assert.match(schema, /uq_xtu_unknown_refund_tx_hash/);
  assert.match(schema, /uq_xtu_unknown_refund_event_key/);
});

test("public refund request requires source-address proof and fixes payout to the original sender", () => {
  const challenge = between(routes, 'router.post("/public/xtu/unknown-transfers/refund-challenge"', 'router.post("/public/xtu/unknown-transfers/refund-request"');
  const request = between(routes, 'router.post("/public/xtu/unknown-transfers/refund-request"', 'router.post("/admin/xtu/unknown-transfers/list"');
  assert.match(challenge, /Signing this message proves control of the original sender address/);
  assert.match(request, /verifyMessage/);
  assert.match(request, /isValidSignature/);
  assert.match(request, /proof_verified_at_ms/);
  assert.match(request, /sender_address/);
  assert.doesNotMatch(request, /payout_address|destination_address/);
  assert.match(limiter, /POST \/public\/xtu\/unknown-transfers\/refund-challenge/);
  assert.match(limiter, /POST \/public\/xtu\/unknown-transfers\/refund-request/);
});

test("admin can approve an unknown XTU refund only after proof-verified sender request", () => {
  const resolve = between(routes, 'router.post("/admin/xtu/unknown-transfers/resolve"', 'router.post("/admin/xtu/unknown-refunds/list"');
  assert.match(resolve, /proof_verified_at_ms/);
  assert.match(resolve, /status='refund_approved'/);
  assert.match(resolve, /status='approved'/);
  assert.match(resolve, /status\(403\)|incorrect admin credentials/);
  assert.match(resolve, /assign|refund|retain/);
});

test("XTU refund uses Hot Wallet net receipt, gas-equivalent deduction and 0.1 percent contract fee", () => {
  assert.match(policy, /hotWalletReceivedAmount/);
  assert.match(policy, /estimatedGasFeeBscUsd/);
  assert.match(policy, /BPS = 10/);
  assert.match(worker, /baseAmount = new BigNumber\(String\(transfer\.hot_wallet_received_amount\)\)/);
  assert.match(worker, /hotWalletReceivedAmount: baseAmount\.toFixed\(18\)/);
  assert.match(worker, /MINIMUM_REFUND_NET_BSC_USD/);
  assert.match(worker, /parseUnknownXtuRefundReceipt/);
  assert.match(worker, /actual_fee_bnb/);
  assert.match(worker, /actual_fee_usd/);
  assert.match(worker, /getXtuMainSigner/);
  assert.match(worker, /encodeFunctionData\("transfer", \[transfer\.from_address/);
  assert.match(worker, /payout_address/);
});

test("refunds never use unprotected initial XTU supply or overlap with consolidation", () => {
  assert.match(worker, /common_reserve_owned/);
  assert.match(worker, /protectedHotWalletTotal/);
  assert.match(worker, /lockedProtectedTotal/);
  assert.match(worker, /activeConsolidations/);
  assert.match(worker, /activeRefunds/);
  assert.match(worker, /status IN \('signed','submitted','manual_review'\)/);
});

test("admin listing never exposes signed raw transaction payloads", () => {
  const list = between(routes, 'router.post("/admin/xtu/unknown-refunds/list"', 'router.post("/admin/bsc/unknown-transfers/list"');
  assert.match(list, /SELECT rf\.id/);
  assert.doesNotMatch(list, /SELECT rf\.\*/);
  assert.doesNotMatch(list, /rf\.raw_tx/);
});
