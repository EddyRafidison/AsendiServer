"use strict";

const BigNumber = require("bignumber.js");
const { DISBURSEMENT_COOLDOWN_MS } = require("./recharge-policy");
const { calculateGlobalUnitPrice } = require("./stock-accounting");

const TOKEN_DECIMALS = 18;
const DISBURSEMENT_TOLERANCE = new BigNumber("0.00000001");

function finitePositive(value, fieldName) {
  const result = new BigNumber(value);
  if (!result.isFinite() || !result.isGreaterThan(0)) {
    throw new RangeError(`${fieldName} must be a finite positive number`);
  }
  return result;
}

/**
 * Calculate a full system sale using the global price frozen when the user
 * submits the request. `balanceInitialValue` is the user's entire internal
 * balance in initial assets; the resulting payout is BSC-USD.
 */
function calculateSystemDisbursement(balanceInitialValue, priceValue, feePercent) {
  const grossInitialAsset = finitePositive(balanceInitialValue, "users_stock.balance");
  const price = finitePositive(priceValue, "common.unit_price");
  const fee = new BigNumber(feePercent);
  if (!fee.isFinite() || fee.isNegative() || !fee.isLessThan(100)) {
    throw new RangeError("FEES must be greater than or equal to 0 and less than 100");
  }

  const grossBalance = grossInitialAsset.multipliedBy(price);
  const feeAmount = grossBalance.multipliedBy(fee).dividedBy(100);
  const feeInitialAsset = grossInitialAsset.multipliedBy(fee).dividedBy(100);
  const soldInitialAsset = grossInitialAsset.minus(feeInitialAsset);
  const payoutAmount = soldInitialAsset.multipliedBy(price)
    .decimalPlaces(TOKEN_DECIMALS, BigNumber.ROUND_DOWN);
  const amountRawDecimal = payoutAmount.shiftedBy(TOKEN_DECIMALS);

  if (
    !grossBalance.isFinite() || !grossBalance.isGreaterThan(0) ||
    !feeAmount.isFinite() || feeAmount.isNegative() ||
    !feeInitialAsset.isFinite() || feeInitialAsset.isNegative() ||
    !soldInitialAsset.isFinite() || !soldInitialAsset.isGreaterThan(0) ||
    !payoutAmount.isFinite() || !payoutAmount.isGreaterThan(0) ||
    !amountRawDecimal.isInteger()
  ) {
    throw new RangeError("The calculated disbursement amount is invalid");
  }

  return {
    grossInitialAsset,
    grossBalance,
    priceValue: price,
    payoutAmount,
    soldInitialAsset,
    feeAmount,
    feeInitialAsset,
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
    !totalUnitsPrice.isFinite() || !totalUnitsPrice.isGreaterThan(0) ||
    !backedUnits.isFinite() || !backedUnits.isGreaterThan(0) ||
    !inactiveInitAsset.isFinite() || inactiveInitAsset.isNegative()
  ) {
    throw new RangeError("Common reserve values must be finite and non-negative, with positive backing");
  }

  const payoutAmount = finitePositive(disbursement.payoutAmount, "payoutAmount");
  const soldInitialAsset = finitePositive(disbursement.soldInitialAsset, "soldInitialAsset");
  const feeInitialAsset = new BigNumber(disbursement.feeInitialAsset);
  if (!feeInitialAsset.isFinite() || feeInitialAsset.isNegative()) {
    throw new RangeError("Disbursement fee initial-asset basis is invalid");
  }

  // Settlement uses the payout and valuation basis frozen at request time.
  // The paid basis moves to inactive reserves; the retained fee basis remains backed.
  const newTotalUnitsPrice = totalUnitsPrice.minus(payoutAmount);
  const newInactiveInitAsset = inactiveInitAsset.plus(soldInitialAsset);
  const newBackedUnits = backedUnits.plus(feeInitialAsset);
  const newUnitPrice = calculateGlobalUnitPrice(newTotalUnitsPrice, newBackedUnits);
  return { newTotalUnitsPrice, newInactiveInitAsset, newBackedUnits, newUnitPrice };
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
