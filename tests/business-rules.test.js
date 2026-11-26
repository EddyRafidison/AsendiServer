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
  calculateIndividualDisbursement,
  calculateDisbursementReserveSettlement,
  DISBURSEMENT_COOLDOWN_MS,
} = require("../disbursement-policy");
const {
  MIN_DEPOSIT_AMOUNT,
  MAX_DEPOSIT_AMOUNT,
  MAX_DEFAULT_STOCK,
  SYSTEM_ADMIN_RESERVE_RATIO,
  DEPOSIT_PENDING_EXPIRATION_MS,
  getSystemFundingCooldownReleaseAt,
  recordDateTimeToUtcMs,
} = require("../deposit-policy");

const fixed = (value) => value.toFixed();

test("current OneX business limits are centralized", () => {
  assert.equal(fixed(MIN_DEPOSIT_AMOUNT), "20");
  assert.equal(fixed(MAX_DEPOSIT_AMOUNT), "100");
  assert.equal(MAX_DEFAULT_STOCK, "300");
  assert.equal(fixed(SYSTEM_ADMIN_RESERVE_RATIO), "0.1");
  assert.equal(DEPOSIT_PENDING_EXPIRATION_MS, 30 * 24 * 60 * 60 * 1000);
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

test("P2P uses the sender individual price while tfees are valued at the pre-operation global price", () => {
  const globalPriceBefore = new BigNumber("2");
  const senderIndividualPrice = new BigNumber("2.5");
  const senderBalanceInitial = new BigNumber("150");
  const recipientBalanceInitial = new BigNumber("80");
  const requestedXtu = new BigNumber("50");
  const requestedInitial = requestedXtu.dividedBy(senderIndividualPrice);
  const feesInitial = requestedInitial.multipliedBy(3).dividedBy(100);
  const recipientCreditInitial = requestedInitial.minus(feesInitial);
  const newSenderBalance = senderBalanceInitial.minus(requestedInitial);
  const newRecipientBalance = recipientBalanceInitial.plus(recipientCreditInitial);
  const commonFeeValueXtu = feesInitial.multipliedBy(globalPriceBefore);
  const newTotal = new BigNumber("200").plus(commonFeeValueXtu);
  const newBacked = new BigNumber("100").plus(feesInitial);

  assert.equal(fixed(requestedInitial), "20");
  assert.equal(fixed(feesInitial), "0.6");
  assert.equal(fixed(newSenderBalance), "130");
  assert.equal(fixed(newRecipientBalance), "99.4");
  assert.equal(fixed(commonFeeValueXtu), "1.2");
  assert.equal(fixed(newTotal), "201.2");
  assert.equal(fixed(newBacked), "100.6");
  assert.equal(fixed(calculateGlobalUnitPrice(newTotal, newBacked)), "2");
});

test("individual disbursement uses the participant's snapshot price and deducts tfees", () => {
  const result = calculateIndividualDisbursement("375", "300", "1.25", 3);
  assert.equal(fixed(result.grossInitialAsset), "300");
  assert.equal(fixed(result.grossBalance), "375");
  assert.equal(fixed(result.priceValue), "1.25");
  assert.equal(fixed(result.feeAmount), "11.25");
  assert.equal(fixed(result.feeInitialAsset), "9");
  assert.equal(fixed(result.soldInitialAsset), "291");
  assert.equal(fixed(result.payoutAmount), "363.75");
  assert.equal(result.amountRaw, "363750000000000000000");
  const laterGlobalPrice = new BigNumber("1.8");
  assert.notEqual(fixed(result.soldInitialAsset.multipliedBy(laterGlobalPrice)), fixed(result.payoutAmount));
});

test("individual disbursement settlement returns tfees at the pre-settlement global price", () => {
  const disbursement = calculateIndividualDisbursement("375", "300", "1.25", 3);
  const settlement = calculateDisbursementReserveSettlement("10000000", "10000000", "0", {
    ...disbursement,
    feeValueXtu: disbursement.feeInitialAsset.multipliedBy("1.40"),
  });
  assert.equal(fixed(settlement.newTotalUnitsPrice), "9999648.85");
  assert.equal(fixed(settlement.newInactiveInitAsset), "291");
  assert.equal(fixed(settlement.newBackedUnits), "10000009");
  assert.equal(fixed(settlement.newUnitPrice), fixed(settlement.newTotalUnitsPrice.dividedBy(settlement.newBackedUnits)));
});

test("rejects invalid individual payout fees, amounts and participant prices", () => {
  assert.throws(() => calculateIndividualDisbursement("375", "300", "1.25", 100), /FEES/);
  assert.throws(() => calculateIndividualDisbursement("0", "300", "1.25", 3), /gross XTU/);
  assert.throws(() => calculateIndividualDisbursement("375", "0", "1.25", 3), /balance/);
  assert.throws(() => calculateIndividualDisbursement("375", "300", "0", 3), /unit_price/);
});

test("weekly OneX system-funding cooldown expires seven days after the last OneX-funded purchase", () => {
  const day = 24 * 60 * 60 * 1000;
  const pendingAt = Date.UTC(2026, 0, 12);
  const lastOnexPurchaseAt = Date.UTC(2026, 0, 8);
  assert.equal(getSystemFundingCooldownReleaseAt(pendingAt, lastOnexPurchaseAt), Date.UTC(2026, 0, 15));
  assert.equal(getSystemFundingCooldownReleaseAt(pendingAt, Date.UTC(2026, 0, 20)), Date.UTC(2026, 0, 27));
  assert.equal(getSystemFundingCooldownReleaseAt(pendingAt, null), pendingAt + 7 * day);
});

test("activity date/time parser treats database values as UTC and rejects invalid dates", () => {
  const expected = Date.UTC(2026, 10, 9, 13, 38, 0);
  assert.equal(recordDateTimeToUtcMs(20261109, "133800"), expected);
  assert.equal(recordDateTimeToUtcMs(20260231, "120000"), null);
  assert.equal(recordDateTimeToUtcMs(20261109, "250000"), null);
});
