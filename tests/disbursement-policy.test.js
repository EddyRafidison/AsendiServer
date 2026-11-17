"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  calculateSystemDisbursement,
  calculateDisbursementReserveSettlement,
  isRequestedPayoutWithinTolerance,
} = require("../disbursement-policy");

const fixed = (value) => value.toFixed();

test("disbursement calculates all amounts with the price captured at request submission", () => {
  const result = calculateSystemDisbursement("300", "1.25", 3);
  assert.equal(fixed(result.grossInitialAsset), "300");
  assert.equal(fixed(result.grossBalance), "375");
  assert.equal(fixed(result.priceValue), "1.25");
  assert.equal(fixed(result.feeAmount), "11.25");
  assert.equal(fixed(result.feeInitialAsset), "9");
  assert.equal(fixed(result.soldInitialAsset), "291");
  assert.equal(fixed(result.payoutAmount), "363.75");
  assert.equal(result.amountRaw, "363750000000000000000");
});

test("the frozen disbursement amount does not change when the global price later changes", () => {
  const request = calculateSystemDisbursement("300", "1.25", 3);
  const laterPrice = require("bignumber.js");
  assert.equal(fixed(request.soldInitialAsset.multipliedBy(request.priceValue)), "363.75");
  assert.notEqual(fixed(request.soldInitialAsset.multipliedBy(new laterPrice("1.8"))), fixed(request.payoutAmount));
});

test("zero fees preserve BSC-USD token base-unit precision", () => {
  const result = calculateSystemDisbursement("290.123456789012345678", "1.004", 0);
  assert.equal(result.feeAmount.toFixed(), "0");
  assert.equal(result.feeInitialAsset.toFixed(), "0");
  assert.equal(result.payoutAmount.toFixed(18), "291.283950616168395060");
  assert.equal(result.amountRaw, "291283950616168395060");
});

test("settlement uses the frozen payout and initial-asset basis while recalculating current common price", () => {
  const request = calculateSystemDisbursement("300", "1.25", 3);
  const settlement = calculateDisbursementReserveSettlement("10000000", "10000000", "0", request);
  assert.equal(fixed(settlement.newTotalUnitsPrice), "9999636.25");
  assert.equal(fixed(settlement.newInactiveInitAsset), "291");
  assert.equal(fixed(settlement.newBackedUnits), "10000009");
  assert.equal(fixed(settlement.newUnitPrice), fixed(settlement.newTotalUnitsPrice.dividedBy(settlement.newBackedUnits)));
});

test("checks the expected payout with bounded token precision", () => {
  assert.equal(isRequestedPayoutWithinTolerance("363.750000000", "363.75"), true);
  assert.equal(isRequestedPayoutWithinTolerance("363.75000002", "363.75"), false);
  assert.equal(isRequestedPayoutWithinTolerance("invalid", "363.75"), false);
});

test("rejects invalid fee percentages and invalid request balances or prices", () => {
  assert.throws(() => calculateSystemDisbursement("300", "1.25", 100), /FEES/);
  assert.throws(() => calculateSystemDisbursement("0", "1.25", 3), /balance/);
  assert.throws(() => calculateSystemDisbursement("300", "0", 3), /unit_price/);
});
