const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const read = (name) => fs.readFileSync(path.join(root, name), "utf8");

test("BSC unknown sender refund requests use a dedicated fresh schema", () => {
  const db = read("db.js");
  assert.match(db, /CREATE TABLE IF NOT EXISTS bsc_unknown_refund_requests/);
  assert.match(db, /uq_bsc_unknown_refund_request_transfer/);
  assert.match(db, /CREATE TABLE IF NOT EXISTS bsc_unknown_refund_request_events/);
});

test("BSC unknown refund challenge is bound to the original chain event and sender", () => {
  const routes = read("routes.js");
  assert.match(routes, /\/public\/bsc\/unknown-transfers\/refund-challenge/);
  assert.match(routes, /FROM bsc_unknown_incoming_transfers[\s\S]*?tx_hash=\? AND log_index=\? AND LOWER\(from_address\)=LOWER\(\?\)/);
  assert.match(routes, /BSC-USD unknown-transfer refund request/);
  assert.match(routes, /Signing proves control of the original sender address|proves control of the original sender address/);
});

test("BSC unknown refund request requires EIP-191 or EIP-1271 sender proof", () => {
  const routes = read("routes.js");
  assert.match(routes, /verifyMessage\(String\(request\.challenge_message\), signature\)/);
  assert.match(routes, /isValidSignature/);
  assert.match(routes, /proof_verified_at_ms=.*status='pending_admin'/);
});

test("administrator cannot queue a BSC unknown refund without proof-verified sender request", () => {
  const routes = read("routes.js");
  assert.match(routes, /bsc_unknown_refund_requests[\s\S]*?status='pending_admin'[\s\S]*?proof_verified_at_ms IS NOT NULL/);
  assert.match(routes, /sender_request_and_address_proof_required/);
});

test("BSC unknown refund request lifecycle is rate limited and reconciled", () => {
  const limiter = read("http-rate-limiter.js");
  const disbursement = read("disbursement.js");
  assert.match(limiter, /POST \/public\/bsc\/unknown-transfers\/refund-challenge/);
  assert.match(limiter, /POST \/public\/bsc\/unknown-transfers\/refund-request/);
  assert.match(disbursement, /UPDATE bsc_unknown_refund_requests SET status='completed'/);
  assert.match(disbursement, /UPDATE bsc_unknown_refund_requests SET status='manual_review'/);
});
