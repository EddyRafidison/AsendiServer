"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  calculateSystemDisbursement,
  isRequestedPayoutWithinTolerance,
} = require("../disbursement-policy");

test("calculates seller-net BSC-USD payout and records the complete sold stock basis", () => {
  const result = calculateSystemDisbursement("300", "30", "10", 3);
  assert.equal(result.grossBalance.toFixed(), "300");
  assert.equal(result.grossInitAsset.toFixed(), "30");
  assert.equal(result.priceValue.toFixed(), "10");
  assert.equal(result.payoutAmount.toFixed(18), "291.000000000000000000");
  assert.equal(result.soldInitAsset.toFixed(), "29.1");
  assert.equal(result.feeAmount.toFixed(), "9");
  assert.equal(result.feeInitAsset.toFixed(), "0.9");
  assert.equal(result.commonShare.toFixed(), "4.5");
  assert.equal(result.adminFees.toFixed(), "4.5");
  assert.equal(result.feeBackedInitAsset.toFixed(), "0.45");
  assert.equal(result.feeInactiveInitAsset.toFixed(), "0.45");
  assert.equal(result.amountRaw, "291000000000000000000");
});

test("allows zero fee while preserving token base-unit precision", () => {
  const result = calculateSystemDisbursement("290.123456789012345678", "29", "10.004", 0);
  assert.equal(result.payoutAmount.toFixed(18), "290.123456789012345678");
  assert.equal(result.soldInitAsset.toFixed(18), "29.000745380748934994");
  assert.equal(result.feeAmount.toFixed(), "0");
  assert.equal(result.amountRaw, "290123456789012345678");
});

test("checks the requested payout with a bounded tolerance", () => {
  assert.equal(isRequestedPayoutWithinTolerance("291.000000000", "291"), true);
  assert.equal(isRequestedPayoutWithinTolerance("291.00000002", "291"), false);
  assert.equal(isRequestedPayoutWithinTolerance("invalid", "291"), false);
});

test("rejects invalid fee percentages and invalid balances", () => {
  assert.throws(() => calculateSystemDisbursement("300", "30", "10", 100), /FEES/);
  assert.throws(() => calculateSystemDisbursement("0", "30", "10", 3), /balance/);
  assert.throws(() => calculateSystemDisbursement("300", "0", "10", 3), /init_asset/);
});
