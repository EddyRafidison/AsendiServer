"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  calculateIndividualDisbursement,
  validateGlobalDisbursementCapacity,
  calculateGlobalDisbursement,
  calculateDisbursementReserveSettlement,
  isRequestedPayoutWithinTolerance,
  isPositivePayoutAmount,
  isIndividualDisbursementBalanceEligible,
} = require("../disbursement-policy");

const fixed = (value) => value.toFixed();

test("individual disbursement converts through the participant's frozen individual price", () => {
  const result = calculateIndividualDisbursement("375", "300", "1.25", 3);
  assert.equal(fixed(result.grossInitialAsset), "300");
  assert.equal(fixed(result.grossBalance), "375");
  assert.equal(fixed(result.priceValue), "1.25");
  assert.equal(fixed(result.feeAmount), "11.25");
  assert.equal(fixed(result.feeInitialAsset), "9");
  assert.equal(fixed(result.soldInitialAsset), "291");
  assert.equal(fixed(result.payoutAmount), "363.75");
  assert.equal(result.amountRaw, "363750000000000000000");
});

test("an accepted individual disbursement remains frozen when the public price later changes", () => {
  const request = calculateIndividualDisbursement("375", "300", "1.25", 3);
  const laterGlobalPrice = new (require("bignumber.js"))("1.8");
  assert.equal(fixed(request.soldInitialAsset.multipliedBy(request.priceValue)), "363.75");
  assert.notEqual(fixed(request.soldInitialAsset.multipliedBy(laterGlobalPrice)), fixed(request.payoutAmount));
});

test("zero fees preserve BSC-USD token base-unit precision", () => {
  const BigNumber = require("bignumber.js");
  const grossXtu = new BigNumber("290.123456789012345678").multipliedBy("1.004");
  const result = calculateIndividualDisbursement(grossXtu, "290.123456789012345678", "1.004", 0);
  assert.equal(result.feeAmount.toFixed(), "0");
  assert.equal(result.feeInitialAsset.toFixed(), "0");
  assert.equal(result.payoutAmount.toFixed(18), "291.283950616168395060");
  assert.equal(result.amountRaw, "291283950616168395060");
});

test("settlement values returned tfees at the pre-settlement global price", () => {
  const request = calculateIndividualDisbursement("375", "300", "1.25", 3);
  const settlement = calculateDisbursementReserveSettlement("10000000", "10000000", "0", {
    ...request,
    feeValueXtu: request.feeInitialAsset.multipliedBy("1.40"),
  });
  assert.equal(fixed(settlement.newTotalUnitsPrice), "9999648.85");
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
  assert.throws(() => calculateIndividualDisbursement("375", "300", "1.25", 100), /FEES/);
  assert.throws(() => calculateIndividualDisbursement("0", "300", "1.25", 3), /gross XTU/);
  assert.throws(() => calculateIndividualDisbursement("375", "0", "1.25", 3), /balance/);
  assert.throws(() => calculateIndividualDisbursement("375", "300", "0", 3), /unit_price/);
});


test("individual disbursement applies tfees to a gross XTU request at the frozen price", () => {
  const result = calculateIndividualDisbursement("200", "250", "1.25", 3);
  assert.equal(fixed(result.grossInitialAsset), "160");
  assert.equal(fixed(result.feeInitialAsset), "4.8");
  assert.equal(fixed(result.soldInitialAsset), "155.2");
  assert.equal(fixed(result.feeAmount), "6");
  assert.equal(fixed(result.payoutAmount), "194");
  assert.equal(result.amountRaw, "194000000000000000000");
});

test("global reimbursement deducts recipient-paid tfees and BSC gas from the payout", () => {
  const result = calculateGlobalDisbursement("200", "1", "0.1", "3", "3");
  assert.equal(fixed(result.grossBalance), "200");
  assert.equal(fixed(result.netRequestedAmount), "194");
  assert.equal(fixed(result.bonusRatePercent), "3");
  assert.equal(fixed(result.bonusAmount), "5.82");
  assert.equal(fixed(result.bonusInitialAsset), "5.82");
  assert.equal(fixed(result.payoutBeforeGas), "199.82");
  assert.equal(fixed(result.bscFeeRecoveredUsd), "0.1");
  assert.equal(fixed(result.payoutAmount), "199.72");
  assert.equal(result.amountRaw, "199720000000000000000");
  assert.equal(fixed(result.feeInitialAsset), "6");
  assert.equal(fixed(result.feeAmount), "6");
});

test("global reimbursement retains each participant's individual price at non-unit prices", () => {
  const result = calculateGlobalDisbursement("100", "1.2", "0.03", "5", "3");
  assert.equal(fixed(result.grossBalance), "120");
  assert.equal(fixed(result.netRequestedAmount), "116.4");
  assert.equal(fixed(result.feeAmount), "3.6");
  assert.equal(fixed(result.feeInitialAsset), "3");
  assert.equal(fixed(result.bonusAmount), "5.82");
  assert.equal(fixed(result.bonusInitialAsset), "4.85");
  assert.equal(fixed(result.payoutAmount), "122.19");
});

test("global reimbursement rejects a payout too small to cover BSC gas", () => {
  assert.throws(() => calculateGlobalDisbursement("0.01", "1", "0.02", "0", "3"), /gas fee/);
});

test("global bonus uses protected backing while tfees return to backing at global price", () => {
  const result = calculateGlobalDisbursement("200", "1", "0.1", "3", "3");
  const settlement = calculateDisbursementReserveSettlement(
    "1000", "1000", "0", {
      ...result,
      // Confirmed gas is 0.065; tfees are valued using the pre-settlement global price of 1.
      reserveExpenseAmount: result.payoutAmount.plus("0.065"),
      feeValueXtu: result.feeInitialAsset.multipliedBy("1"),
    }, "10",
  );
  assert.equal(fixed(settlement.newTotalUnitsPrice), "806.215");
  assert.equal(fixed(settlement.reserveExpenseAmount), "199.785");
  assert.equal(fixed(settlement.newInactiveInitAsset), "194");
  assert.equal(fixed(settlement.newBackedUnits), "1000.18");
  assert.equal(fixed(settlement.newSysInactiveInitAsset), "15.82");
});


test("global reserve debit includes actual BSC gas and global-price tfees allocation", () => {
  const result = calculateGlobalDisbursement("200", "1", "0.1", "3", "3");
  const lowerActualGas = calculateDisbursementReserveSettlement("1000", "1000", "0", {
    ...result,
    reserveExpenseAmount: result.payoutAmount.plus("0.065"),
    feeValueXtu: result.feeInitialAsset.multipliedBy("1"),
  });
  const higherActualGas = calculateDisbursementReserveSettlement("1000", "1000", "0", {
    ...result,
    reserveExpenseAmount: result.payoutAmount.plus("0.12"),
    feeValueXtu: result.feeInitialAsset.multipliedBy("1"),
  });
  assert.equal(fixed(lowerActualGas.newTotalUnitsPrice), "806.215");
  assert.equal(fixed(higherActualGas.newTotalUnitsPrice), "806.16");
});

test("global liquidation preflight rejects liabilities that exhaust the frozen stock value", () => {
  const safe = validateGlobalDisbursementCapacity("1000", "1.25", "700");
  assert.equal(safe.available, true);
  assert.equal(fixed(safe.grossLiability), "875");
  assert.equal(fixed(safe.remainingValue), "125");

  const exhausted = validateGlobalDisbursementCapacity("875", "1.25", "700");
  assert.equal(exhausted.available, false);
  assert.equal(fixed(exhausted.remainingValue), "0");

  const exceeded = validateGlobalDisbursementCapacity("874", "1.25", "700");
  assert.equal(exceeded.available, false);
  assert.equal(fixed(exceeded.remainingValue), "-1");
});


test("individual account balance eligibility matches the configured individual request minimum", () => {
  assert.equal(isIndividualDisbursementBalanceEligible("199.999999999999999999", "200"), false);
  assert.equal(isIndividualDisbursementBalanceEligible("200", "200"), true);
  assert.equal(isIndividualDisbursementBalanceEligible("250", "200"), true);
  assert.equal(isIndividualDisbursementBalanceEligible("249.99", "250"), false);
  assert.equal(isIndividualDisbursementBalanceEligible("250", "250"), true);
  assert.equal(isIndividualDisbursementBalanceEligible("NaN", "200"), false);
  assert.equal(isIndividualDisbursementBalanceEligible("300", "0"), false);
});

test("administrative disbursement requeue requires a positive payout but has no extra 10 BSC-USD minimum", () => {
  assert.equal(isPositivePayoutAmount("0.00000001"), true);
  assert.equal(isPositivePayoutAmount("2"), true);
  assert.equal(isPositivePayoutAmount("9.99"), true);
  assert.equal(isPositivePayoutAmount("10"), true);
  assert.equal(isPositivePayoutAmount("0"), false);
  assert.equal(isPositivePayoutAmount("-0.01"), false);
  assert.equal(isPositivePayoutAmount("NaN"), false);
});
