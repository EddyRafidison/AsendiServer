"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  calculateSystemDisbursement,
  calculateIndividualDisbursement,
  validateGlobalDisbursementCapacity,
  calculateGlobalDisbursement,
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


test("individual disbursement applies tfees to a gross XTU request at the frozen price", () => {
  const result = calculateIndividualDisbursement("200", "250", "1.25", 3);
  assert.equal(fixed(result.grossInitialAsset), "160");
  assert.equal(fixed(result.feeInitialAsset), "4.8");
  assert.equal(fixed(result.soldInitialAsset), "155.2");
  assert.equal(fixed(result.feeAmount), "6");
  assert.equal(fixed(result.payoutAmount), "194");
  assert.equal(result.amountRaw, "194000000000000000000");
});

test("global reimbursement calculates the bonus on the net eligible amount and deducts BSC gas only", () => {
  const result = calculateGlobalDisbursement("200", "1", "0.1", "3");
  assert.equal(fixed(result.grossBalance), "200");
  assert.equal(fixed(result.netRequestedAmount), "200");
  assert.equal(fixed(result.bonusRatePercent), "3");
  assert.equal(fixed(result.bonusAmount), "6");
  assert.equal(fixed(result.bonusInitialAsset), "6");
  assert.equal(fixed(result.payoutBeforeGas), "206");
  assert.equal(fixed(result.bscFeeRecoveredUsd), "0.1");
  assert.equal(fixed(result.payoutAmount), "205.9");
  assert.equal(result.amountRaw, "205900000000000000000");
  assert.equal(fixed(result.feeInitialAsset), "0");
  assert.equal(fixed(result.feeAmount), "0");
});

test("global reimbursement keeps the net amount and bonus at non-unit frozen prices", () => {
  const result = calculateGlobalDisbursement("100", "1.2", "0.03", "5");
  assert.equal(fixed(result.grossBalance), "120");
  assert.equal(fixed(result.bonusAmount), "6");
  assert.equal(fixed(result.bonusInitialAsset), "5");
  assert.equal(fixed(result.payoutAmount), "125.97");
});

test("global reimbursement rejects a payout too small to cover BSC gas", () => {
  assert.throws(() => calculateGlobalDisbursement("0.01", "1", "0.02", "0"), /gas fee/);
});

test("global bonus is deducted from the administrative backing and recorded as administrative spend", () => {
  const result = calculateGlobalDisbursement("200", "1", "0.1", "3");
  const settlement = calculateDisbursementReserveSettlement(
    "1000", "1000", "0", {
      ...result,
      // The user receives 205.9, and the confirmed network expense is 0.065.
      // The remaining 0.035 of the estimated recovery stays with the system.
      reserveExpenseAmount: result.payoutAmount.plus("0.065"),
    }, "10",
  );
  assert.equal(fixed(settlement.newTotalUnitsPrice), "794.035");
  assert.equal(fixed(settlement.reserveExpenseAmount), "205.965");
  assert.equal(fixed(settlement.newInactiveInitAsset), "200");
  assert.equal(fixed(settlement.newBackedUnits), "994");
  assert.equal(fixed(settlement.newSysInactiveInitAsset), "16");
});


test("global reserve debit includes the actual BSC gas cost in addition to the net token payout", () => {
  const result = calculateGlobalDisbursement("200", "1", "0.1", "3");
  const lowerActualGas = calculateDisbursementReserveSettlement(
    "1000", "1000", "0", {
      ...result,
      reserveExpenseAmount: result.payoutAmount.plus("0.065"),
    },
  );
  const higherActualGas = calculateDisbursementReserveSettlement(
    "1000", "1000", "0", {
      ...result,
      reserveExpenseAmount: result.payoutAmount.plus("0.12"),
    },
  );
  assert.equal(fixed(lowerActualGas.newTotalUnitsPrice), "794.035");
  assert.equal(fixed(higherActualGas.newTotalUnitsPrice), "793.98");
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
