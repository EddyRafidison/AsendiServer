"use strict";

const BigNumber = require("bignumber.js");

BigNumber.config({
  DECIMAL_PLACES: 36,
  ROUNDING_MODE: BigNumber.ROUND_HALF_UP,
});

const TOKEN_DECIMALS = 18;
const DISBURSEMENT_TOLERANCE = new BigNumber("0.00000001");
const DISBURSEMENT_COOLDOWN_MS = 30 * 24 * 60 * 60 * 1000;

function finitePositive(value, fieldName) {
  const result = new BigNumber(value);
  if (!result.isFinite() || !result.isGreaterThan(0)) {
    throw new RangeError(`${fieldName} must be a finite positive number`);
  }
  return result;
}

/**
 * OneX liquidates the user's entire One-Val balance. The user receives the
 * balance net of the configured fee percentage; the fee is entirely charged
 * to the seller. The payout is rounded down to the token's 18 decimals.
 */
function calculateSystemDisbursement(balanceValue, initAssetValue, priceValue, feePercent) {
  const balance = finitePositive(balanceValue, "users_stock.balance");
  const initAsset = finitePositive(initAssetValue, "users_stock.init_asset");
  const price = finitePositive(priceValue, "priceValue");
  const fee = new BigNumber(feePercent);

  if (!fee.isFinite() || fee.isNegative() || !fee.isLessThan(100)) {
    throw new RangeError("FEES must be greater than or equal to 0 and less than 100");
  }

  const payoutAmount = balance
    .multipliedBy(new BigNumber(100).minus(fee))
    .dividedBy(100)
    .decimalPlaces(TOKEN_DECIMALS, BigNumber.ROUND_DOWN);
  const feeAmount = balance.minus(payoutAmount);
  const soldInitAsset = payoutAmount.dividedBy(price);
  const feeInitAsset = feeAmount.dividedBy(price);
  const amountRawDecimal = payoutAmount.shiftedBy(TOKEN_DECIMALS);

  if (
    !payoutAmount.isFinite() ||
    !payoutAmount.isGreaterThan(0) ||
    !feeAmount.isFinite() ||
    feeAmount.isNegative() ||
    !feeInitAsset.isFinite() ||
    feeInitAsset.isNegative() ||
    !amountRawDecimal.isInteger()
  ) {
    throw new RangeError("The calculated disbursement amount is invalid");
  }

  return {
    grossBalance: balance,
    grossInitAsset: initAsset,
    priceValue: price,
    payoutAmount,
    soldInitAsset,
    feeAmount,
    feeInitAsset,
    amountRaw: amountRawDecimal.toFixed(0),
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
  isRequestedPayoutWithinTolerance,
};
