"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const db = read("db.js");
const routes = read("routes.js");
const disbursement = read("disbursement.js");
const limiter = read("http-rate-limiter.js");

function between(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `Missing marker: ${startMarker}`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(end, -1, `Missing end marker: ${endMarker}`);
  return source.slice(start, end);
}

test("refund request and refund record have unique direct one-to-one links", () => {
  assert.match(db, /user_request_id BIGINT UNSIGNED NULL/);
  assert.match(db, /UNIQUE KEY uq_usdt_refund_user_request\(user_request_id\)/);
  assert.match(db, /refund_id BIGINT UNSIGNED NULL/);
  assert.match(db, /UNIQUE KEY uq_user_usdt_refund_request_refund\(refund_id\)/);
  assert.match(db, /CREATE TABLE IF NOT EXISTS user_usdt_refund_request_events/);
  assert.match(db, /UNIQUE KEY uq_user_refund_request_event_key\(event_key\)/);
});

test("known-account deposit refund endpoint is disabled under the confirmed policy", () => {
  const adminRoute = between(routes, 'router.post("/admin/deposit/refund"', '// Requeue an unsubmitted disbursement');
  assert.match(adminRoute, /status\(403\)/);
  assert.match(adminRoute, /known_account_deposit_refund_disabled/);
  assert.match(adminRoute, /Refunds are restricted to official BSC-USD or XTU transfers from sender addresses not registered/);
  assert.doesNotMatch(adminRoute, /reserved_refund_amount=reserved_refund_amount\+/);
});

test("only a confirmed blockchain refund converts reserved amount into refunded amount", () => {
  const finalize = between(disbursement, "async function finalizeRefund", "async function markRefundManualReview");
  assert.match(finalize, /reserved_refund_amount=reserved_refund_amount-\?/);
  assert.match(finalize, /refunded_amount=refunded_amount\+\?/);
  assert.match(finalize, /newStatus: "completed"/);
  assert.match(finalize, /blockchain_confirmed/);
});

test("a finalized reverted refund restores the full gross amount to the pending deposit remainder", () => {
  const worker = between(disbursement, "async function processOneRefundJob", "async function processRefundQueue");
  const failure = between(worker, "if (Number(receipt.status) !== 1)", "if (!receiptConfirmsExpectedTransfer");
  assert.match(failure, /reserved_refund_amount=reserved_refund_amount-\?/);
  assert.match(failure, /remaining_amount=remaining_amount\+\?/);
  assert.match(failure, /status='pending_support'/);
  assert.match(failure, /blockchain_reverted/);
  assert.match(failure, /restored to pending deposit/);
});

test("refund request lifecycle and persisted state recovery are recorded", () => {
  assert.match(disbursement, /async function transitionUserRefundRequestTx/);
  assert.match(disbursement, /async function synchronizeUserRefundRequestTx/);
  assert.match(disbursement, /newStatus: "signed"/);
  assert.match(disbursement, /newStatus: "submitted"/);
  assert.match(disbursement, /newStatus: "manual_review"/);
  assert.match(disbursement, /newStatus: "failed"/);
  assert.match(disbursement, /newStatus: "completed"/);
  assert.match(disbursement, /UPDATE admin_payment_resolutions SET action='refund_confirmed'/);
  assert.match(disbursement, /UPDATE admin_payment_resolutions SET action='refund_failed'/);
});

test("administrator user-info endpoint exists and is rate limited without exposing credentials", () => {
  const endpoint = between(routes, 'router.post("/admin/user-info"', '// Apply an administrator-approved credit');
  assert.match(endpoint, /SELECT username,name,email,birthdate,wallet_address/);
  assert.match(endpoint, /balance: \{/);
  assert.match(endpoint, /deposits: \{/);
  assert.match(endpoint, /disbursements:/);
  assert.match(endpoint, /refund_requests:/);
  assert.match(endpoint, /refunds:/);
  assert.match(endpoint, /seller_payouts:/);
  assert.doesNotMatch(endpoint, /SELECT[^;]*(?:pswd|password|seed|private_key)/i);
  assert.match(limiter, /POST \/admin\/user-info/);
});

for (const file of ["terms_fr.html", "terms_en.html"]) {
  test(`${file} states the 300 XTU individual valuation cap and deactivation grounds`, () => {
    const html = read(file);
    assert.match(html, /300 XTU/);
    assert.doesNotMatch(html, /300 BSC-USD/);
    assert.match(html, /multiple accounts|plusieurs comptes/i);
    assert.match(html, /suspicious|suspect/i);
    assert.match(html, /non-compliance|non-respect/i);
  });
}

for (const file of ["privacy_fr.html", "privacy_en.html"]) {
  test(`${file} explains account-security review and multiple-account checks`, () => {
    const html = read(file);
    assert.match(html, /multiple linked accounts|plusieurs comptes/i);
    assert.match(html, /suspicious|suspect/i);
    assert.match(html, /deactivation|désactivation/i);
  });
}
