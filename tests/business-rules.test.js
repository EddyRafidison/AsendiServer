"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const BigNumber = require("bignumber.js");
const {
  calculateTopUpReserveAllocation,
  deriveUnitPrice,
  deriveInitAsset,
  addReceivedInitAsset,
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
  assert.equal(fixed(MIN_RECHARGE_AMOUNT), "12");
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

test("P2P price is derived from the sender and sender basis is recalculated", () => {
  assert.equal(fixed(deriveUnitPrice("300", "150")), "2");
  assert.equal(fixed(deriveInitAsset("250", "2")), "125");
  assert.throws(() => deriveUnitPrice("300", "0"), /init_asset/);
});

test("P2P recipient preserves its existing initial-asset basis and adds the net received basis", () => {
  // The recipient owns 100 XTU backed by 80 initial assets.
  // A 50 XTU transfer at price 2 contributes 25 initial assets.
  assert.equal(fixed(addReceivedInitAsset("80", "25")), "105");
  assert.throws(() => addReceivedInitAsset("-1", "25"), /cannot be negative/);
  assert.throws(() => addReceivedInitAsset("80", "0"), /greater than zero/);
});

test("P2P beneficiary pays all transfer fees while CommonShare and AdminFees split 50/50", () => {
  const senderBalance = new BigNumber("300");
  const senderInitAsset = new BigNumber("150");
  const receiverInitAsset = new BigNumber("80");
  const requestedAmount = new BigNumber("50");
  const priceValue = deriveUnitPrice(senderBalance, senderInitAsset);
  const amountUnits = requestedAmount.dividedBy(priceValue);
  const fees = amountUnits.multipliedBy(3).dividedBy(100);
  const receiverNetBasis = amountUnits.minus(fees);
  const commonShare = fees.dividedBy(2);
  const adminFees = fees.minus(commonShare);

  const newSenderBalance = senderBalance.minus(amountUnits.multipliedBy(priceValue));
  const newSenderInitAsset = deriveInitAsset(newSenderBalance, priceValue);
  const newReceiverInitAsset = addReceivedInitAsset(receiverInitAsset, receiverNetBasis);
  const initialBasisDelta = newSenderInitAsset
    .minus(senderInitAsset)
    .plus(newReceiverInitAsset.minus(receiverInitAsset))
    .plus(commonShare)
    .plus(adminFees);

  assert.equal(fixed(amountUnits), "25");
  assert.equal(fixed(fees), "0.75");
  assert.equal(fixed(newSenderBalance), "250");
  assert.equal(fixed(newSenderInitAsset), "125");
  assert.equal(fixed(newReceiverInitAsset), "104.25");
  assert.equal(fixed(commonShare), "0.375");
  assert.equal(fixed(adminFees), "0.375");
  assert.equal(fixed(initialBasisDelta), "0");
});

test("disbursement uses model A: sell gross balance and deduct fees", () => {
  const result = calculateSystemDisbursement("300", "150", "2", 3);
  assert.equal(fixed(result.grossBalance), "300");
  assert.equal(fixed(result.grossInitAsset), "150");
  assert.equal(fixed(result.feeAmount), "9");
  assert.equal(fixed(result.payoutAmount), "291");
  assert.equal(fixed(result.soldInitAsset), "145.5");
  assert.equal(fixed(result.feeInitAsset), "4.5");
  assert.equal(fixed(result.feeInactiveInitAsset), "2.25");
  assert.equal(fixed(result.feeBackedInitAsset), "2.25");
});

test("disbursement reduces common total by exact net payout and allocates fees 50/50", () => {
  const disbursement = calculateSystemDisbursement("300", "150", "2", 3);
  const settlement = calculateDisbursementReserveSettlement("300", "10", "20", disbursement);
  assert.equal(fixed(settlement.newTotalUnitsPrice), "9");
  assert.equal(fixed(settlement.newInactiveInitAsset), "167.75");
  assert.equal(fixed(settlement.newBackedUnits), "12.25");
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
