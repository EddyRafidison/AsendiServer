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

const routes = read("routes.js");
const worker = read("xtu-deposit-worker.js");
const schema = read("db.js");
const policy = read("xtu-unknown-refund-policy.js");
const refundWorker = read("automatic-refund-worker.js");

 test("XTU unknown official transfers use the common automatic-refund register", () => {
  for (const table of ["automatic_refund_groups", "automatic_refund_group_events", "automatic_refund_payouts"]) {
    assert.match(schema, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`));
  }
  assert.match(worker, /registerAutomaticRefundEventTx/);
  assert.match(worker, /category: "A"/);
  assert.match(worker, /sourceTable: "xtu_unknown_incoming_transfers"/);
  assert.match(worker, /automatic_refund_pending/);
});

test("legacy XTU challenge and request endpoints return HTTP 410", () => {
  const challenge = between(routes, 'router.post("/public/xtu/unknown-transfers/refund-challenge"', 'router.post("/public/xtu/unknown-transfers/refund-request"');
  const request = between(routes, 'router.post("/public/xtu/unknown-transfers/refund-request"', 'router.post("/admin/xtu/unknown-transfers/list"');
  assert.match(challenge, /status\(410\)/);
  assert.match(request, /status\(410\)/);
  assert.doesNotMatch(challenge + request, /verifyMessage|isValidSignature|proof_verified_at_ms/);
});

test("XTU fee policy and deployed-runtime checks require zero contract commission", () => {
  assert.match(policy, /BPS\s*=\s*0/);
  assert.match(read("xtu-deposit-policy.js"), /XTU_TRANSFER_FEE_BPS\s*=\s*0n/);
  assert.match(read("xtu-withdrawal-policy.js"), /XTU_TRANSFER_FEE_BPS\s*=\s*0n/);
  assert.match(refundWorker, /TRANSFER_FEE_BPS\(\)\) !== 0n/);
  assert.match(read("xtu-withdrawal-chain.js"), /TRANSFER_FEE_BPS/);
});

test("XTU Hot Wallet custody lots and unknown automatic-refund amounts are protected from consolidation", () => {
  assert.match(worker, /getUnbackedAutomaticRefundXtuAmount/);
  assert.match(worker, /automatic_refund_pending/);
  assert.match(worker, /lockedProtectedTotal/);
  assert.match(worker, /protected_hot_wallet_amount/);
  assert.match(refundWorker, /protectedAmount/);
});

test("automatic XTU refund payouts use the same source address, exact token and persisted signed transaction", () => {
  assert.match(refundWorker, /payoutAddress\.toLowerCase\(\) !== String\(group\.sender_address\)/);
  assert.match(refundWorker, /from_wallet_address/);
  assert.match(refundWorker, /raw_tx/);
  assert.match(refundWorker, /tx_hash/);
  assert.match(refundWorker, /nonce/);
  assert.match(refundWorker, /broadcastTransaction\(payout\.raw_tx\)/);
});
