"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { MINIMUM_REFUND_NET_BSC_USD, resolveMinimumRefundNetBscUsd, isRefundNetAmountAllowed } = require("../refund-policy");

const root = path.join(__dirname, "..");
const routes = fs.readFileSync(path.join(root, "routes.js"), "utf8");
const disbursement = fs.readFileSync(path.join(root, "disbursement.js"), "utf8");
const sellerAccounting = fs.readFileSync(path.join(root, "seller-accounting.js"), "utf8");
const xtuRefundPolicy = fs.readFileSync(path.join(root, "xtu-unknown-refund-policy.js"), "utf8");
const readme = fs.readFileSync(path.join(root, "README.md"), "utf8");

 test("automatic refund minimum is a fixed one token unit and independent of the gas ceiling", () => {
  assert.equal(MINIMUM_REFUND_NET_BSC_USD.toFixed(8), "1.00000000");
  assert.equal(resolveMinimumRefundNetBscUsd("0.4").toFixed(8), "1.00000000");
  assert.equal(resolveMinimumRefundNetBscUsd("0.1").toFixed(8), "1.00000000");
  assert.equal(isRefundNetAmountAllowed("1"), true);
  assert.equal(isRefundNetAmountAllowed("0.999999999999999999"), false);
});

test("refund-signing paths enforce the fixed minimum separately from the gas ceiling", () => {
  assert.match(routes, /MINIMUM_REFUND_NET_BSC_USD/);
  assert.match(disbursement, /finalPayoutAmount\.isGreaterThanOrEqualTo\(MINIMUM_REFUND_NET_BSC_USD\)/);
  assert.match(readme, /minimum net fixed at 1/);
});

test("seller payout minimum remains independent from the automatic-refund minimum", () => {
  assert.match(sellerAccounting, /getMinimumOutgoingNetBscUsd/);
  assert.match(sellerAccounting, /getMinimumOutgoingGrossBscUsd/);
});


test("the XTU refund quote default also uses the fixed one-unit minimum", () => {
  assert.match(xtuRefundPolicy, /minimumRefundNet = "1"/);
  assert.doesNotMatch(xtuRefundPolicy, /0\.8/);
});
