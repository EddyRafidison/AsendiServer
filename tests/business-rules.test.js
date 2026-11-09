"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const BigNumber = require("bignumber.js");
const {
  calculateTopUpReserveAllocation,
  deriveUnitPrice,
  deriveInitAsset,
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
  RECHARGE_BATCH_WINDOW_MS,
  DEPOSIT_SWEEP_THRESHOLD,
  DEPOSIT_SWEEP_MAX_AGE_MS,
  getWeeklyReleaseAt,
  recordDateTimeToUtcMs,
} = require("../recharge-policy");

function fixed(value) {
  return value.toFixed();
}

test("current OneX business limits are centralized", () => {
  assert.equal(fixed(MIN_RECHARGE_AMOUNT), "70");
  assert.equal(fixed(MAX_RECHARGE_AMOUNT), "140");
  assert.equal(MAX_DEFAULT_STOCK, "300");
  assert.equal(RECHARGE_BATCH_WINDOW_MS, 60 * 60 * 1000);
  assert.equal(fixed(DEPOSIT_SWEEP_THRESHOLD), "70");
  assert.equal(DEPOSIT_SWEEP_MAX_AGE_MS, 30 * 24 * 60 * 60 * 1000);
  assert.equal(DISBURSEMENT_COOLDOWN_MS, 90 * 24 * 60 * 60 * 1000);
});

test("inactive reserve alone is consumed first without changing unit price", () => {
  const result = calculateTopUpReserveAllocation("50", "2", "20", "100", "500");
  assert.equal(result.available, true);
  assert.equal(fixed(result.activityAmount), "25");
  assert.equal(fixed(result.consumedInactive), "25");
  assert.equal(fixed(result.consumedBacked), "0");
  assert.equal(fixed(result.newInactive), "75");
  assert.equal(fixed(result.newBacked), "20");
  assert.equal(fixed(result.newTotalUnitsPrice), "550");
  assert.equal(fixed(result.newUnitPrice), "2");
});

test("backed reserve is used only for the shortfall and reprices the unit", () => {
  const result = calculateTopUpReserveAllocation("50", "2", "30", "20", "100");
  assert.equal(result.available, true);
  assert.equal(fixed(result.activityAmount), "25");
  assert.equal(fixed(result.consumedInactive), "20");
  assert.equal(fixed(result.consumedBacked), "5");
  assert.equal(fixed(result.newInactive), "0");
  assert.equal(fixed(result.newBacked), "25");
  assert.equal(fixed(result.newTotalUnitsPrice), "150");
  assert.equal(fixed(result.newUnitPrice), "3");
});

test("reserve allocation refuses a top-up above combined reserve value", () => {
  const result = calculateTopUpReserveAllocation("100", "2", "10", "20", "100");
  assert.equal(result.available, false);
  assert.equal(fixed(result.availableValue), "60");
  assert.equal(fixed(result.newInactive), "20");
  assert.equal(fixed(result.newBacked), "10");
});

test("P2P account price and initial-asset basis use the current account balance", () => {
  assert.equal(fixed(deriveUnitPrice("300", "150")), "2");
  assert.equal(fixed(deriveInitAsset("250", "2")), "125");
  assert.throws(() => deriveUnitPrice("300", "0"), /init_asset/);
});

test("disbursement uses model A: sell gross balance and deduct fees", () => {
  const result = calculateSystemDisbursement("300", "150", "2", 3);
  assert.equal(fixed(result.grossBalance), "300");
  assert.equal(fixed(result.grossInitAsset), "150");
  assert.equal(fixed(result.feeAmount), "9");
  assert.equal(fixed(result.payoutAmount), "291");
  assert.equal(fixed(result.soldInitAsset), "145.5");
  assert.equal(fixed(result.feeInitAsset), "4.5");
  assert.equal(fixed(result.feeInactiveInitAsset), "1.125");
  assert.equal(fixed(result.feeBackedInitAsset), "3.375");
});

test("disbursement reduces common total by exact net payout and allocates retained fees 25/75", () => {
  const disbursement = calculateSystemDisbursement("300", "150", "2", 3);
  const settlement = calculateDisbursementReserveSettlement("300", "10", "20", disbursement);
  assert.equal(fixed(settlement.newTotalUnitsPrice), "9");
  assert.equal(fixed(settlement.newInactiveInitAsset), "166.625");
  assert.equal(fixed(settlement.newBackedUnits), "13.375");
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
