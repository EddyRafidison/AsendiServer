"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const read = (name) => fs.readFileSync(path.join(root, name), "utf8");

test("signup requires a valid fixed wallet and permanently reserves it", () => {
  const routes = read("routes.js");
  const db = read("db.js");
  assert.match(routes, /if \(!isEvmAddress\(submittedWalletAddress\).*auths: "addr error"/s);
  assert.match(routes, /INSERT INTO bsc_wallet_address_registry\(wallet_address_lower,wallet_address,username,registered_at_ms\)/);
  assert.match(routes, /wallet_address already registered|wallet address has already been registered/i);
  assert.match(db, /wallet_address CHAR\(42\) NOT NULL[\s\S]*?UNIQUE KEY uq_auths_wallet_address\(wallet_address\)/);
  assert.match(db, /CREATE TABLE IF NOT EXISTS bsc_wallet_address_registry\([\s\S]*?wallet_address_lower CHAR\(42\) PRIMARY KEY/);
});

test("incoming scanner filters the shared treasury and identifies users from Transfer.from", () => {
  const pay = read("pay.js");
  const routes = read("routes.js");
  assert.match(pay, /topics: \[TRANSFER_TOPIC, null, addressTopic\(paymentConfig\.treasuryAddress\)\]/);
  assert.match(pay, /const fromAddress = getAddress\(`0x\$\{String\(log\.topics\[1\]\)\.slice\(-40\)\}`\)/);
  assert.match(pay, /SELECT username FROM auths WHERE LOWER\(wallet_address\)=\?/);
  assert.match(pay, /persistUnknownTransfer\(db, event\)/);
  assert.match(routes, /FROM auths WHERE LOWER\(wallet_address\)=\?/);
  assert.match(routes, /transfer_precedes_or_may_precede_wallet_registration/);
  assert.match(routes, /Math\.ceil\(createdAtMs \/ 1000\) \* 1000/);
  assert.match(routes, /scannerStatus.initialized && scannerStatus.health_status === "healthy" && scannerCaughtUp/);
  assert.match(routes, /configured OneX treasury address is permanently registered as a user wallet/);
});

test("incoming scanner has a durable, idempotent cursor and audited rollback recovery", () => {
  const pay = read("pay.js");
  const db = read("db.js");
  const routes = read("routes.js");
  assert.match(db, /CREATE TABLE IF NOT EXISTS bsc_incoming_scan_state/);
  assert.match(db, /KEY idx_bsc_unknown_tx_log\(tx_hash,log_index\)/);
  assert.match(db, /CREATE TABLE IF NOT EXISTS bsc_scan_admin_events/);
  assert.match(pay, /eth_getLogs/);
  assert.match(pay, /new WebSocketProvider\(paymentConfig\.websocketRpcUrl\)/);
  assert.match(pay, /finalized HTTP scanning remains the source of truth/);
  assert.match(pay, /health_status='manual_review'/);
  assert.match(pay, /configured scanner identity is reviewed/);
  assert.match(pay, /findLatestCommonCheckpoint/);
  assert.match(pay, /Do not promote the persisted cursor to a canonical checkpoint/);
  assert.match(pay, /scanner has no completed cursor/);
  assert.match(pay, /getIndependentRpcConsensus/);
  assert.match(pay, /latestPreview = \{/);
  assert.match(pay, /can_commit:[\s\S]*?canCommitReconciliation\(itemRows\)/);
  assert.match(pay, /previewIncomingScannerReconciliation/);
  assert.match(pay, /commitIncomingScannerReconciliation/);
  assert.match(pay, /resolveIncomingScannerCompensation/);
  assert.match(pay, /INSERT(?: IGNORE)? INTO bsc_scan_checkpoints/);
  assert.match(pay, /INSERT INTO bsc_scan_admin_events/);
  assert.doesNotMatch(pay, /function reconcileIncomingScanner\(/);
  assert.match(pay, /validatedRpcUrls = new Set\(\)/);
  assert.match(pay, /validateRpcEndpoint\(rpcUrl\)/);
  assert.match(pay, /The payment scanner will remain active and retry without advancing its database cursor/);
  assert.ok(pay.includes('if (startBlock > safeBlock.number)'));
  assert.match(read("routes.js"), /sharedTreasuryAddress = depositAvailability.allowed && paymentConfig.enabled && depositScannerReady/);
  assert.match(pay, /let watcherWsProvider = null/);
  assert.match(routes, /\/admin\/bsc\/incoming-scanner\/status/);
  assert.match(routes, /\/admin\/bsc\/incoming-scanner\/reconcile\/preview/);
  assert.match(routes, /\/admin\/bsc\/incoming-scanner\/reconcile\/resolve-event/);
  assert.match(routes, /\/admin\/bsc\/incoming-scanner\/reconcile\/commit/);
  assert.match(routes, /preview_required/);
  assert.match(routes, /startDepositBatchWorker\(\)/);
  assert.match(routes, /isDepositBatchSafeDuringScannerReview/);
  assert.match(routes, /USDT_DEPOSIT_QUEUE_POLL_MS/);
});

test("deposit batches persist the shared treasury, not a per-user deposit address", () => {
  const db = read("db.js");
  const pay = read("pay.js");
  const routes = read("routes.js");
  assert.match(db, /CREATE TABLE IF NOT EXISTS users_usdt_deposit_batches\([\s\S]*?treasury_address CHAR\(42\) NOT NULL/);
  assert.match(db, /CREATE TABLE IF NOT EXISTS users_usdt_transfer_events\([\s\S]*?treasury_address CHAR\(42\) NOT NULL/);
  assert.match(pay, /treasuryAddress: toAddress/);
  assert.match(routes, /username,batch_id,treasury_address,from_address/);
  assert.doesNotMatch(db, /users_usdt_deposit_wallets|users_usdt_sweeps/);
  assert.doesNotMatch(pay, /BSC_DEPOSIT_XPUB|BSC_DEPOSIT_XPRV|startDepositSweeper/);
  assert.doesNotMatch(read("routes.js"), /BSC sweep fees are not finalized|awaiting_actual_bsc_fee_reconciliation/);
});

test("individual price threshold uses three times the applied fee rate", () => {
  const price = read("user-price-accounting.js");
  const index = read("index.js");
  const testSource = read("tests/individual-price.test.js");
  assert.match(price, /USER_PRICE_TRIGGER_RATIO = new BigNumber\(3\)/);
  assert.match(price, /USER_PRICE_TRIGGER_RATIO\.multipliedBy\(feeRate\)/);
  assert.match(price, /recalculateWatchingPriceTargets/);
  assert.match(index, /recalculateWatchingPriceTargets\(database\)/);
  assert.match(price, /MINIMUM_OPERATION_RATIO = new BigNumber\("0\.05"\)/);
  assert.match(price, /calculateIndividualRemunerationRate/);
  assert.match(testSource, /calculateIndividualRemunerationRate\("50", "100", "3"\)/);
  assert.ok(testSource.includes('assert.equal(fixed(calculateIndividualRemunerationRate("25", "100", "3")), "4.5")'));
});

test("Terms and Privacy describe the shared-treasury and fixed-wallet model in both languages", () => {
  for (const name of ["terms_fr.html", "terms_en.html", "privacy_fr.html", "privacy_en.html"]) {
    const text = read(name);
    assert.match(text, /wallet|portefeuille/i, `${name} must describe wallet processing`);
    assert.match(text, /treasury|trésorerie/i, `${name} must describe the shared treasury`);
    assert.match(text, /unknown|inconnu/i, `${name} must describe unmatched transfers`);
    assert.match(text, /from|expédit/i, `${name} must explain sender-address matching`);
    assert.match(text, /block cursor|curseur de blocs/i, `${name} must describe durable scanner state`);
    assert.match(text, /manual_review/i, `${name} must describe scanner reconciliation holds`);
  }
  assert.match(read("terms_fr.html"), /C = 3 × tfees × min\(1, 2 × V \/ P\)/);
  assert.match(read("terms_en.html"), /C = 3 × tfees × min\(1, 2 × V \/ P\)/);
});
