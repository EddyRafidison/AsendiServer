"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  getMinimumOutgoingNetBscUsd,
  getMinimumOutgoingGrossBscUsd,
} = require("../outgoing-payout-policy");
const { MINIMUM_REFUND_NET_BSC_USD } = require("../refund-policy");

const root = path.join(__dirname, "..");
const routes = fs.readFileSync(path.join(root, "routes.js"), "utf8");
const disbursement = fs.readFileSync(path.join(root, "disbursement.js"), "utf8");
const sellerAccounting = fs.readFileSync(path.join(root, "seller-accounting.js"), "utf8");
const sellerWorker = fs.readFileSync(path.join(root, "disbursement.js"), "utf8");
const termsFr = fs.readFileSync(path.join(root, "terms_fr.html"), "utf8");
const termsEn = fs.readFileSync(path.join(root, "terms_en.html"), "utf8");
const readme = fs.readFileSync(path.join(root, "README.md"), "utf8");

test("minimum outgoing net payout is exactly twice the configured maximum BSC gas fee", () => {
  assert.equal(getMinimumOutgoingNetBscUsd("0.4").toFixed(8), "0.80000000");
  assert.equal(getMinimumOutgoingGrossBscUsd("0.4").toFixed(8), "1.20000000");
  assert.equal(getMinimumOutgoingNetBscUsd("0.25").toFixed(8), "0.50000000");
  assert.equal(getMinimumOutgoingGrossBscUsd("0.25").toFixed(8), "0.75000000");
  assert.equal(getMinimumOutgoingNetBscUsd("0").toFixed(8), "0.00000000");
  assert.throws(() => getMinimumOutgoingNetBscUsd("0.5"), /between 0 and 0.4/);
  assert.equal(MINIMUM_REFUND_NET_BSC_USD.toFixed(8), getMinimumOutgoingNetBscUsd().toFixed(8));
});

test("recharge and unknown-transfer refunds check the derived minimum before queueing", () => {
  assert.match(routes, /remaining\.minus\(maximumGasRecovery\)\.isLessThan\(MINIMUM_REFUND_NET_BSC_USD\)/);
  assert.match(routes, /grossAmount\.minus\(maximumGasRecovery\)\.isLessThan\(MINIMUM_REFUND_NET_BSC_USD\)/);
  assert.match(disbursement, /finalPayoutAmount\.isGreaterThanOrEqualTo\(MINIMUM_REFUND_NET_BSC_USD\)/);
});

test("seller minimum net payout is checked at queue planning and final transaction signing", () => {
  assert.match(sellerAccounting, /getMinimumOutgoingNetBscUsd/);
  assert.match(sellerAccounting, /getMinimumOutgoingGrossBscUsd/);
  assert.match(sellerAccounting, /grossAmount\.isLessThan\(minimumGross\)/);
  assert.match(sellerWorker, /payoutAmount\.isGreaterThanOrEqualTo\(minimumSellerNetPayout\)/);
});

test("seller principal eligibility starts at 20 XTU", () => {
  assert.match(sellerAccounting, /SELLER_MIN_RUN_BALANCE = new BigNumber\("20"\)/);
  assert.match(readme, /main balance is at least 20 XTU/);
  assert.doesNotMatch(readme, /main balance is at least 10 XTU/);
});

test("Terms disclose the fee-derived minimum net refunds and seller payouts", () => {
  assert.match(termsFr, /deux fois le plafond maximal des frais BSC configuré par OneX/);
  assert.match(termsEn, /twice the configured maximum BSC gas fee ceiling/);
  assert.match(termsFr, /20 XTU/);
  assert.match(termsEn, /20 XTU/);
});

test("the 300 BSC-USD seller payout batch value is a ceiling, not an aggregate minimum", () => {
  assert.match(sellerAccounting, /if \(qualifiedSellers\.length === 0\)/);
  assert.doesNotMatch(sellerAccounting, /qualifiedAvailableGross\.isLessThan\(batchLimit\)/);
  assert.match(readme, /The 300 BSC-USD value is a batch ceiling, not an additional aggregate minimum/);
});
