"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const read = (name) => fs.readFileSync(path.join(root, name), "utf8");

test("one shared 20-100 configuration governs both BSC-USD and XTU deposits", () => {
  const shared = read("deposit-limits.js");
  const bscPolicy = read("deposit-policy.js");
  const xtuPolicy = read("xtu-deposit-policy.js");
  const rootEnv = read(".env.example");
  const xtuEnv = read(".env.xtu.example");
  const chainConfig = read("xtu-withdrawal-chain.js");

  assert.match(shared, /DEPOSIT_MIN_AMOUNT \|\| "20"/);
  assert.match(shared, /DEPOSIT_MAX_AMOUNT \|\| "100"/);
  assert.match(bscPolicy, /require\("\.\/deposit-limits"\)/);
  assert.match(xtuPolicy, /require\("\.\/deposit-limits"\)/);
  assert.match(rootEnv, /^DEPOSIT_MIN_AMOUNT=20$/m);
  assert.match(rootEnv, /^DEPOSIT_MAX_AMOUNT=100$/m);
  assert.doesNotMatch(xtuEnv, /^XTU_DEPOSIT_(?:MIN|MAX)_AMOUNT=/m);
  assert.match(chainConfig, /legacyDepositLimitVariables/);
  assert.match(chainConfig, /are obsolete; use the shared DEPOSIT_MIN_AMOUNT and DEPOSIT_MAX_AMOUNT/);
  assert.match(xtuEnv, /^XTU_DEPOSIT_CONSOLIDATION_MIN_BATCH_XTU=100$/m);
});

test("XTU internal consolidation is a FIFO lot of at least 100 actual Hot Wallet receipts", () => {
  const policy = read("xtu-deposit-policy.js");
  const worker = read("xtu-deposit-worker.js");
  const schema = read("db.js");
  const api = read("routes.js");
  const chainConfig = read("xtu-withdrawal-chain.js");

  assert.match(policy, /function selectXtuConsolidationBatches\([\s\S]*?batch\.hot_wallet_received_amount/);
  assert.match(policy, /minimum\.lt\("100"\)/);
  assert.match(worker, /selected\.totalHotWalletReceivedXtu/);
  assert.match(worker, /transfer", \[runtime\.settings\.distributionAddress, rawAmount\]/);
  assert.match(worker, /xtu_deposit_consolidation_items/);
  assert.match(schema, /CREATE TABLE IF NOT EXISTS xtu_deposit_consolidation_items/);
  assert.match(api, /consolidation_minimum_batch_xtu: state\.consolidationMinBatchXtu/);
});

test("personal-wallet XTU withdrawal has a 5 XTU gross minimum", () => {
  const policy = read("xtu-withdrawal-policy.js");
  const englishTerms = read("terms_en.html");
  const frenchTerms = read("terms_fr.html");
  const androidGuide = read("android-integration/XTU_EXTERNALIZATION.md");

  assert.match(policy, /MIN_XTU_WITHDRAWAL = new BigNumber\("5"\)/);
  assert.match(policy, /minimum gross XTU withdrawal is 5 XTU/);
  assert.match(englishTerms, /minimum gross amount is 5 XTU/);
  assert.match(frenchTerms, /montant brut minimal d'une demande de retrait vers un portefeuille personnel est de 5 XTU/);
  assert.match(androidGuide, /gross minimum of `5` XTU/);
});

test("BSC-USD accepts transfers above 100 and caps each automatic credit tranche at 100", () => {
  const policy = read("deposit-policy.js");
  const routes = read("routes.js");

  assert.match(policy, /requiresMultipleTranches: amount\.isGreaterThan\(MAX_INITIAL_CREDIT_TRANCHE_AMOUNT\)/);
  assert.doesNotMatch(policy, /reason: "above_maximum"/);
  assert.doesNotMatch(routes, /individualDepositAboveMaximum/);
  assert.match(routes, /BigNumber\.minimum\(remainingAmount, MAX_INITIAL_CREDIT_TRANCHE_AMOUNT\)/);
  assert.match(routes, /remainingAfter\.isGreaterThan\(0\)/);
  assert.match(routes, /expires_at_ms/);
});

test("weekly control counts one OneX-funded purchase, shared by BSC-USD and XTU, while seller campaigns bypass it", () => {
  const policy = read("deposit-policy.js");
  const creditPolicy = read("deposit-credit-policy.js");
  const stock = read("stock-accounting.js");
  const routes = read("routes.js");
  const xtuWorker = read("xtu-deposit-worker.js");
  const xtuPolicy = read("xtu-deposit-policy.js");
  const sellerAccounting = read("seller-accounting.js");
  const privacyEn = read("privacy_en.html");

  assert.match(privacyEn, /one purchase[^.]*OneX system reserves[^.]*rolling seven days/i);
  assert.match(privacyEn, /seller-campaign-funded credits[^.]*do not consume|credits funded exclusively from active seller campaigns[^.]*do not consume/i);
  assert.doesNotMatch(privacyEn, /rolling seven-day incoming-amount ceiling/i);
  assert.match(policy, /SELECT id,record_date,record_time[\s\S]*?WHERE sender=\? AND receiver=\? AND type=2[\s\S]*?ORDER BY record_date DESC,record_time DESC,id DESC/);
  assert.doesNotMatch(policy, /SUM\(|amount\s*[<>]|gross_amount|xtu_amount|classifyRollingDepositReceipt|previousSevenDayGross|rollingSevenDayGross/);
  assert.match(routes, /const lastSystemPurchase = await getLastOneXSystemFundedPurchase\(tx, username, OneX\)/);
  assert.match(routes, /systemFundingAllowed = cooldown\.allowed \|\| sameBatchAlreadyUsedSystemPurchase/);
  assert.match(routes, /VALUES\('XUSER',[\s\S]*?sellerBasis/);
  assert.match(routes, /if \(systemBasis\.isGreaterThan\(0\)\)[\s\S]*?\[OneX, username, systemBasis/);
  assert.match(routes, /seller_campaign_activation_requires_opt_in/);
  assert.match(routes, /seller_campaign_created_by_system_after_eligible_opt_in/);
  assert.match(routes, /weekly_system_funded_purchase_scope: "onex_system_reserves_only"/);
  assert.match(routes, /weekly_system_funded_purchase_shared_across_assets: true/);
  assert.match(routes, /router\.post\("\/app\/join-system-sellers"[\s\S]*?validateSellerJoin[\s\S]*?INSERT INTO users_seller_campaigns/);
  assert.match(sellerAccounting, /SELLER_LOCK_RATIO = new BigNumber\("0\.5"\)/);
  assert.match(creditPolicy, /systemFundingAllowed === true[\s\S]*?calculateSellerOnlyDepositFundingAllocation/);
  assert.match(stock, /consumedInactive: new BigNumber\(0\)[\s\S]*?consumedBacked: new BigNumber\(0\)/);
  assert.match(xtuWorker, /getLastOneXSystemFundedPurchase\(tx, batch\.username, OneX\)/);
  assert.match(xtuWorker, /systemFundingAllowed: cooldown\.allowed \|\| sameBatchSystemRows\.length > 0/);
  assert.match(xtuWorker, /VALUES\('XUSER',[\s\S]*?sellerBasis/);
  assert.match(xtuWorker, /if \(systemBasis\.isGreaterThan\(0\)\)[\s\S]*?\[OneX, currentBatch\.username, systemBasis/);
  assert.match(xtuWorker, /calculateSellerOnlyDepositFundingAllocation/);
  assert.match(xtuWorker, /same batch may continue in later tranches/);
  assert.match(xtuPolicy, /function classifyDepositSession/);
  assert.doesNotMatch(xtuPolicy, /previousSevenDayGross|projectedWeekly/);
});
