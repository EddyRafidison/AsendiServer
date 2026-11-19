"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const BigNumber = require("bignumber.js");
const {
  calculateGlobalUnitPrice,
  xtuToInitialAsset,
  initialAssetToXtu,
  calculateTopUpReserveAllocation,
} = require("../stock-accounting");
const {
  calculateSystemDisbursement,
  calculateDisbursementReserveSettlement,
  DISBURSEMENT_COOLDOWN_MS,
} = require("../disbursement-policy");
const {
  MIN_RECHARGE_AMOUNT,
  MAX_RECHARGE_AMOUNT,
  MAX_DEFAULT_STOCK,
  SYSTEM_ADMIN_RESERVE_RATIO,
  RECHARGE_BATCH_WINDOW_MS,
  DEPOSIT_SWEEP_THRESHOLD,
  DEPOSIT_SWEEP_MAX_AGE_MS,
  getWeeklyReleaseAt,
  recordDateTimeToUtcMs,
} = require("../recharge-policy");

const fixed = (value) => value.toFixed();

test("current OneX business limits are centralized", () => {
  assert.equal(fixed(MIN_RECHARGE_AMOUNT), "10");
  assert.equal(fixed(MAX_RECHARGE_AMOUNT), "100");
  assert.equal(MAX_DEFAULT_STOCK, "300");
  assert.equal(fixed(SYSTEM_ADMIN_RESERVE_RATIO), "0.1");
  assert.equal(RECHARGE_BATCH_WINDOW_MS, 60 * 60 * 1000);
  assert.equal(fixed(DEPOSIT_SWEEP_THRESHOLD), "100");
  assert.equal(DEPOSIT_SWEEP_MAX_AGE_MS, 30 * 24 * 60 * 60 * 1000);
  assert.equal(DISBURSEMENT_COOLDOWN_MS, 30 * 24 * 60 * 60 * 1000);
});

test("a system-funded top-up converts the XTU request to initial assets at the pre-operation global price", () => {
  const price = calculateGlobalUnitPrice("200", "100");
  assert.equal(fixed(price), "2");
  assert.equal(fixed(xtuToInitialAsset("50", price)), "25");
  assert.equal(fixed(initialAssetToXtu("25", price)), "50");
});

test("inactive reserve is consumed first and the common price is recalculated from total / backed", () => {
  const result = calculateTopUpReserveAllocation("50", "2", "100", "100", "200", "10");
  assert.equal(result.available, true);
  assert.equal(fixed(result.activityAmount), "25");
  assert.equal(fixed(result.consumedInactive), "25");
  assert.equal(fixed(result.consumedBacked), "0");
  assert.equal(fixed(result.newInactive), "75");
  assert.equal(fixed(result.newBacked), "100");
  assert.equal(fixed(result.newTotalUnitsPrice), "250");
  assert.equal(fixed(result.newUnitPrice), "2.5");
});

test("backed reserve is used only for the shortfall and the administrative floor remains protected", () => {
  const result = calculateTopUpReserveAllocation("50", "2", "100", "20", "200", "10");
  assert.equal(result.available, true);
  assert.equal(fixed(result.activityAmount), "25");
  assert.equal(fixed(result.consumedInactive), "20");
  assert.equal(fixed(result.consumedBacked), "5");
  assert.equal(fixed(result.newInactive), "0");
  assert.equal(fixed(result.newBacked), "95");
  assert.equal(fixed(result.newTotalUnitsPrice), "250");
  assert.equal(result.newBacked.gte("10"), true);
});

test("reserve allocation refuses a top-up above the combined distributable reserve", () => {
  const result = calculateTopUpReserveAllocation("221", "2", "100", "20", "200", "10");
  assert.equal(result.available, false);
  assert.equal(fixed(result.availableValue), "220");
  assert.equal(fixed(result.newInactive), "20");
  assert.equal(fixed(result.newBacked), "100");
});

test("P2P stores both user balances in initial assets and retains recipient-paid fees", () => {
  const price = new BigNumber("2");
  const senderBalanceInitial = new BigNumber("150");
  const recipientBalanceInitial = new BigNumber("80");
  const requestedXtu = new BigNumber("50");
  const requestedInitial = requestedXtu.dividedBy(price);
  const feesInitial = requestedInitial.multipliedBy(3).dividedBy(100);
  const recipientCreditInitial = requestedInitial.minus(feesInitial);
  const newSenderBalance = senderBalanceInitial.minus(requestedInitial);
  const newRecipientBalance = recipientBalanceInitial.plus(recipientCreditInitial);
  const feesXtu = feesInitial.multipliedBy(price);
  const newTotal = new BigNumber("200").plus(feesXtu);
  const newBacked = new BigNumber("100").plus(feesInitial);

  assert.equal(fixed(requestedInitial), "25");
  assert.equal(fixed(feesInitial), "0.75");
  assert.equal(fixed(newSenderBalance), "125");
  assert.equal(fixed(newRecipientBalance), "104.25");
  assert.equal(fixed(newTotal), "201.5");
  assert.equal(fixed(newBacked), "100.75");
  assert.equal(fixed(calculateGlobalUnitPrice(newTotal, newBacked)), "2");
});

test("disbursement freezes the public price and BSC-USD payment at request submission", () => {
  const result = calculateSystemDisbursement("300", "1.25", 3);
  assert.equal(fixed(result.grossInitialAsset), "300");
  assert.equal(fixed(result.grossBalance), "375");
  assert.equal(fixed(result.priceValue), "1.25");
  assert.equal(fixed(result.feeAmount), "11.25");
  assert.equal(fixed(result.feeInitialAsset), "9");
  assert.equal(fixed(result.soldInitialAsset), "291");
  assert.equal(fixed(result.payoutAmount), "363.75");
  assert.equal(result.amountRaw, "363750000000000000000");
  // A later global price is deliberately not an input to the persisted payout.
  const laterGlobalPrice = new BigNumber("1.8");
  assert.equal(fixed(result.soldInitialAsset.multipliedBy(result.priceValue)), "363.75");
  assert.notEqual(fixed(result.soldInitialAsset.multipliedBy(laterGlobalPrice)), fixed(result.payoutAmount));
});

test("disbursement settlement applies the frozen payout while recalculating the current common price", () => {
  const disbursement = calculateSystemDisbursement("300", "1.25", 3);
  const settlement = calculateDisbursementReserveSettlement("10000000", "10000000", "0", disbursement);
  assert.equal(fixed(settlement.newTotalUnitsPrice), "9999636.25");
  assert.equal(fixed(settlement.newInactiveInitAsset), "291");
  assert.equal(fixed(settlement.newBackedUnits), "10000009");
  assert.equal(fixed(settlement.newUnitPrice), fixed(settlement.newTotalUnitsPrice.dividedBy(settlement.newBackedUnits)));
});

test("checks the requested payout with a bounded tolerance", () => {
  const result = calculateSystemDisbursement("300", "1.25", 3);
  assert.equal(require("../disbursement-policy").isRequestedPayoutWithinTolerance("363.750000000", result.payoutAmount), true);
  assert.equal(require("../disbursement-policy").isRequestedPayoutWithinTolerance("363.75000002", result.payoutAmount), false);
  assert.equal(require("../disbursement-policy").isRequestedPayoutWithinTolerance("invalid", result.payoutAmount), false);
});

test("rejects invalid fee percentages and invalid balances", () => {
  assert.throws(() => calculateSystemDisbursement("300", "1.25", 100), /FEES/);
  assert.throws(() => calculateSystemDisbursement("0", "1.25", 3), /balance/);
  assert.throws(() => calculateSystemDisbursement("300", "0", 3), /unit_price/);
});

test("weekly pending release is at least seven days after first pending and last successful recharge", () => {
  const day = 24 * 60 * 60 * 1000;
  const pendingAt = Date.UTC(2026, 0, 10);
  const lastRechargeAt = Date.UTC(2026, 0, 8);
  assert.equal(getWeeklyReleaseAt(pendingAt, lastRechargeAt), pendingAt + 7 * day);
  assert.equal(getWeeklyReleaseAt(pendingAt, Date.UTC(2026, 0, 20)), Date.UTC(2026, 0, 27));
});

test("activity date/time parser treats database values as UTC and rejects invalid dates", () => {
  const expected = Date.UTC(2026, 10, 9, 13, 38, 0);
  assert.equal(recordDateTimeToUtcMs(20261109, "133800"), expected);
  assert.equal(recordDateTimeToUtcMs(20260231, "120000"), null);
  assert.equal(recordDateTimeToUtcMs(20261109, "250000"), null);
});
