"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const dbSource = fs.readFileSync(path.join(root, "db.js"), "utf8");
const refundPolicy = fs.readFileSync(path.join(root, "automatic-refund-policy.js"), "utf8");
const refundSchema = dbSource.slice(
  dbSource.indexOf("CREATE TABLE IF NOT EXISTS automatic_refund_groups"),
  dbSource.indexOf("CREATE TABLE IF NOT EXISTS user_price_state"),
);

test("MAJ6 refund schema no longer has a 30-day review or retention deadline", () => {
  assert.doesNotMatch(refundSchema, /review_due_at_ms|next_review_at_ms|review_due/i);
  assert.doesNotMatch(refundPolicy, /SMALL_REFUND_REVIEW_DELAY_MS|reviewDueAtMs|reviewDue|review_due/i);
  assert.match(refundPolicy, /REFUND_ELIGIBILITY_DELAY_MS = 30 \* 60 \* 1000/);
  assert.match(refundPolicy, /MINIMUM_AUTOMATIC_REFUND_NET = new BigNumber\("1"\)/);
});

test("signup and scanners have the shared persistent wallet lock and registration block boundary", () => {
  assert.match(dbSource, /CREATE TABLE IF NOT EXISTS bsc_wallet_financial_locks/);
  assert.match(dbSource, /wallet_address_lower CHAR\(42\) PRIMARY KEY/);
  assert.match(dbSource, /registered_at_block BIGINT UNSIGNED NOT NULL/);
});

test("the autonomous XTU-free schema has balances, attempts, append-only ledger, reservations and custody", () => {
  const attemptEventSchema = dbSource.slice(
    dbSource.indexOf("CREATE TABLE IF NOT EXISTS users_xtu_free_deposit_attempt_events"),
    dbSource.indexOf("CREATE TABLE IF NOT EXISTS users_xtu_free_ledger"),
  );
  assert.match(attemptEventSchema, /finalized_at_ms BIGINT UNSIGNED NULL/);

  for (const table of [
    "users_xtu_free_balances",
    "users_xtu_free_ledger",
    "users_xtu_free_reservations",
    "users_xtu_free_reservation_allocations",
    "users_xtu_free_deposit_attempts",
    "users_xtu_free_deposit_attempt_events",
    "users_xtu_externalized_balances",
    "users_xtu_externalized_ledger",
    "xtu_free_custody_lots",
    "xtu_free_fee_ledger",
  ]) {
    assert.match(dbSource, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\(`));
    assert.match(dbSource, new RegExp(`${table}: \\[`));
  }
});

test("the XTU-free ledger exposes a transactional helper, kept separate from old R4 disbursement workers", () => {
  const ledgerSource = fs.readFileSync(path.join(root, "xtu-free-ledger.js"), "utf8");
  const disbursementSource = fs.readFileSync(path.join(root, "disbursement.js"), "utf8");
  assert.match(ledgerSource, /async function postXtuFreeLedgerEntryTx/);
  assert.match(ledgerSource, /FOR UPDATE/);
  assert.match(ledgerSource, /XTU_FREE_IDEMPOTENCY_CONFLICT/);
  assert.doesNotMatch(disbursementSource, /postXtuFreeLedgerEntryTx/);
});
