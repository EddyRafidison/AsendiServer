"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const read = (name) => fs.readFileSync(path.join(root, name), "utf8");
const routes = read("routes.js");
const retry = read("deposit-retry.js");
const termsFr = read("terms_fr.html");
const termsEn = read("terms_en.html");
const privacyFr = read("privacy_fr.html");
const privacyEn = read("privacy_en.html");

function blockBetween(source, start, end) {
  const from = source.indexOf(start);
  assert.notEqual(from, -1, `Missing marker: ${start}`);
  const to = source.indexOf(end, from + start.length);
  assert.notEqual(to, -1, `Missing marker: ${end}`);
  return source.slice(from, to);
}

test("deactivation immediately holds all outstanding deposit balances with account_deactivated reason", () => {
  const hold = blockBetween(routes, "async function holdOutstandingDepositBatchesForDeactivatedAccount", "async function releaseDeactivatedDepositBatches");
  assert.match(hold, /remaining_amount>0/);
  assert.match(hold, /status='pending_support'/);
  assert.match(hold, /next_attempt_at_ms=NULL/);
  assert.match(hold, /reasons\.push\("account_deactivated"\)/);
  assert.match(hold, /updateBatchEventStatus\(tx, batch\.id, "pending_support", reasons\)/);
  assert.match(hold, /queueDepositBatchStatusTx\(/);
});

test("new incoming transfers for an already deactivated account are held with the explicit reason", () => {
  const payment = blockBetween(routes, "async function processConfirmedUsdtPayment", "async function updateBatchEventStatus");
  assert.match(payment, /const accountDeactivated = Number\(account\.account_active\) !== 1/);
  assert.match(payment, /initialReasons\.push\("account_deactivated"\)/);
  assert.match(payment, /const nextStatus = \(accountDeactivated \|\| accountUnavailable \|\| manualDepositSuspended \|\| initialGroupingExpired\)/);
  assert.match(payment, /initialStatus === "collecting" \? null : String\(now\)/);
});

test("normal deposit polling excludes account-deactivated holds", () => {
  const queue = blockBetween(routes, "async function processDepositBatchQueue", "// ----- MAILER -----");
  assert.match(queue, /JSON_CONTAINS\(reason_codes, JSON_QUOTE\('account_deactivated'\)\)=0/);
  assert.match(retry, /JSON_CONTAINS\(reason_codes, JSON_QUOTE\('account_deactivated'\)\)=0/);
});

test("top-up credit path distinguishes an administratively deactivated account", () => {
  const apply = blockBetween(routes, "async function applyUserTopUp", "async function queueSystemDisbursement");
  assert.match(apply, /if \(Number\(authRows\[0\]\.account_active\) !== 1\) return \{ error: "account deactivated" \}/);
  const batch = blockBetween(routes, "async function processOneDepositBatch", "async function processDepositBatchQueue");
  assert.match(batch, /creditResult\?\.error === "account deactivated"/);
  assert.match(batch, /reasons = \["account_deactivated"\]/);
  assert.match(batch, /retryAt = null/);
  assert.match(batch, /batch\.status !== "collecting" && Number\.isSafeInteger\(sessionExpiresAt\) && sessionExpiresAt > now/);
  assert.match(batch, /deposit_session_window_open/);
});

test("reactivation removes only the deactivation reason and immediately wakes eligible batches", () => {
  const release = blockBetween(routes, "async function releaseDeactivatedDepositBatches", "function wakeDepositBatchesImmediately");
  assert.match(release, /JSON_CONTAINS\(reason_codes, JSON_QUOTE\('account_deactivated'\)\)=1/);
  assert.match(release, /filter\(\(reason\) => reason !== "account_deactivated"\)/);
  assert.match(release, /Math\.max\(now,/);
  assert.match(release, /accountReactivated: true/);
  const wake = blockBetween(routes, "function wakeDepositBatchesImmediately", "async function changeAccountAccess");
  assert.match(wake, /processOneDepositBatch\(batchId\)/);
  assert.match(wake, /processDepositBatchQueue\(\)/);
  const admin = blockBetween(routes, "async function changeAccountAccess", 'router.post("/admin/unlock-system-seller"');
  assert.match(admin, /holdOutstandingDepositBatchesForDeactivatedAccount\(U\)/);
  assert.match(admin, /releaseDeactivatedDepositBatches\(U\)/);
  assert.match(admin, /wakeDepositBatchesImmediately\(wakeResult\.batchIds\)/);
});

test("Telegram messages explain account deactivation and reactivation processing", () => {
  assert.match(routes, /account_deactivated: "The account has been administratively deactivated/);
  assert.match(routes, /Account access has been restored\. OneX has immediately requeued/);
});

test("Terms and Privacy describe deposit holds on deactivation and automatic wake-up", () => {
  assert.match(termsFr, /dépôts non entièrement crédités[\s\S]*?Après réactivation/);
  assert.match(termsEn, /deposit amounts that have not been fully credited[\s\S]*?reactivation/);
  assert.match(privacyFr, /dépôts restant à créditer[\s\S]*?file de traitement/);
  assert.match(privacyEn, /deposit amounts that remain to be credited[\s\S]*?queue wake-up/);
});
