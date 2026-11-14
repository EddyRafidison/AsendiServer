"use strict";

const BigNumber = require("bignumber.js");
const { DISBURSEMENT_COOLDOWN_MS } = require("./recharge-policy");
const { COMMON_SHARE_RATIO } = require("./fee-policy");

const TOKEN_DECIMALS = 18;
const DISBURSEMENT_TOLERANCE = new BigNumber("0.00000001");

function finitePositive(value, fieldName) {
  const result = new BigNumber(value);
  if (!result.isFinite() || !result.isGreaterThan(0)) {
    throw new RangeError(`${fieldName} must be a finite positive number`);
  }
  return result;
}

function calculateSystemDisbursement(balanceValue, initAssetValue, priceValue, feePercent) {
  const balance = finitePositive(balanceValue, "users_stock.balance");
  const initAsset = finitePositive(initAssetValue, "users_stock.init_asset");
  const price = finitePositive(priceValue, "priceValue");
  const fee = new BigNumber(feePercent);
  if (!fee.isFinite() || fee.isNegative() || !fee.isLessThan(100)) {
    throw new RangeError("FEES must be greater than or equal to 0 and less than 100");
  }

  // The entire balance is liquidated; the configured fee is deducted from it.
  const feeAmount = balance.multipliedBy(fee).dividedBy(100);
  const payoutAmount = balance.minus(feeAmount).decimalPlaces(TOKEN_DECIMALS, BigNumber.ROUND_DOWN);
  const grossInitAsset = initAsset;
  const feeInitAsset = feeAmount.dividedBy(price);
  const soldInitAsset = payoutAmount.dividedBy(price);
  const amountRawDecimal = payoutAmount.shiftedBy(TOKEN_DECIMALS);

  if (
    !payoutAmount.isFinite() || !payoutAmount.isGreaterThan(0) ||
    !feeAmount.isFinite() || feeAmount.isNegative() ||
    !feeInitAsset.isFinite() || feeInitAsset.isNegative() ||
    !soldInitAsset.isFinite() || !soldInitAsset.isGreaterThan(0) ||
    !amountRawDecimal.isInteger()
  ) throw new RangeError("The calculated disbursement amount is invalid");

  return {
    grossBalance: balance,
    grossInitAsset,
    priceValue: price,
    payoutAmount,
    soldInitAsset,
    feeAmount,
    feeInitAsset,
    commonShare: feeAmount.multipliedBy(COMMON_SHARE_RATIO),
    adminFees: feeAmount.minus(feeAmount.multipliedBy(COMMON_SHARE_RATIO)),
    feeBackedInitAsset: feeInitAsset.multipliedBy(COMMON_SHARE_RATIO),
    feeInactiveInitAsset: feeInitAsset.minus(feeInitAsset.multipliedBy(COMMON_SHARE_RATIO)),
    amountRaw: amountRawDecimal.toFixed(0),
  };
}

function calculateDisbursementReserveSettlement(
  totalUnitsPriceValue,
  backedUnitsValue,
  inactiveInitAssetValue,
  disbursement,
) {
  const totalUnitsPrice = new BigNumber(totalUnitsPriceValue);
  const backedUnits = new BigNumber(backedUnitsValue);
  const inactiveInitAsset = new BigNumber(inactiveInitAssetValue);
  if (
    !totalUnitsPrice.isFinite() || totalUnitsPrice.isNegative() ||
    !backedUnits.isFinite() || backedUnits.isNegative() ||
    !inactiveInitAsset.isFinite() || inactiveInitAsset.isNegative()
  ) {
    throw new RangeError("Common reserve values must be finite and non-negative");
  }

  const payoutAmount = finitePositive(disbursement.payoutAmount, "payoutAmount");
  const soldInitAsset = finitePositive(disbursement.soldInitAsset, "soldInitAsset");
  const feeInactiveInitAsset = new BigNumber(disbursement.feeInactiveInitAsset);
  const feeBackedInitAsset = new BigNumber(disbursement.feeBackedInitAsset);
  if (
    !feeInactiveInitAsset.isFinite() || feeInactiveInitAsset.isNegative() ||
    !feeBackedInitAsset.isFinite() || feeBackedInitAsset.isNegative()
  ) {
    throw new RangeError("Disbursement fee reserve allocation is invalid");
  }

  // The common XTU total is reduced by the exact BSC-USD payout.
  // The retained fee is split 50/50: CommonShare enters backed assets and
  // AdminFees enters inactive initial assets.
  const newTotalUnitsPrice = totalUnitsPrice.minus(payoutAmount);
  const newInactiveInitAsset = inactiveInitAsset
    .plus(soldInitAsset)
    .plus(feeInactiveInitAsset);
  const newBackedUnits = backedUnits.plus(feeBackedInitAsset);

  if (
    newTotalUnitsPrice.isNegative() ||
    !newInactiveInitAsset.isFinite() ||
    !newBackedUnits.isFinite()
  ) {
    throw new RangeError("Disbursement reserve settlement would create an invalid balance");
  }

  return {
    newTotalUnitsPrice,
    newInactiveInitAsset,
    newBackedUnits,
  };
}

function isRequestedPayoutWithinTolerance(requestedValue, expectedValue) {
  const requested = new BigNumber(requestedValue);
  const expected = new BigNumber(expectedValue);
  if (!requested.isFinite() || !expected.isFinite()) return false;
  return requested.minus(expected).abs().lte(DISBURSEMENT_TOLERANCE);
}

module.exports = {
  TOKEN_DECIMALS,
  DISBURSEMENT_TOLERANCE,
  DISBURSEMENT_COOLDOWN_MS,
  calculateSystemDisbursement,
  calculateDisbursementReserveSettlement,
  isRequestedPayoutWithinTolerance,
};
