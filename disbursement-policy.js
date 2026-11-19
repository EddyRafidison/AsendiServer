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

/** Calculate a user-requested individual disbursement from a gross XTU amount. */
function calculateIndividualDisbursement(grossAmountXtuValue, availableInitialAssetValue, priceValue, feePercent) {
  const grossXtu = finitePositive(grossAmountXtuValue, "requested gross XTU amount");
  const availableInitialAsset = finitePositive(availableInitialAssetValue, "users_stock.balance");
  const price = finitePositive(priceValue, "common.unit_price");
  const fee = new BigNumber(feePercent);
  if (!fee.isFinite() || fee.isNegative() || !fee.isLessThan(100)) {
    throw new RangeError("FEES must be greater than or equal to 0 and less than 100");
  }
  const grossInitialAsset = grossXtu.dividedBy(price);
  if (grossInitialAsset.isGreaterThan(availableInitialAsset)) {
    throw new RangeError("The requested gross XTU amount exceeds the user's available initial-asset balance");
  }
  const feeInitialAsset = grossInitialAsset.multipliedBy(fee).dividedBy(100);
  const soldInitialAsset = grossInitialAsset.minus(feeInitialAsset);
  const feeAmount = grossXtu.multipliedBy(fee).dividedBy(100);
  const payoutAmount = soldInitialAsset.multipliedBy(price)
    .decimalPlaces(TOKEN_DECIMALS, BigNumber.ROUND_DOWN);
  const amountRawDecimal = payoutAmount.shiftedBy(TOKEN_DECIMALS);
  if (
    !grossInitialAsset.isFinite() || !grossInitialAsset.isGreaterThan(0) ||
    !feeInitialAsset.isFinite() || feeInitialAsset.isNegative() ||
    !soldInitialAsset.isFinite() || !soldInitialAsset.isGreaterThan(0) ||
    !feeAmount.isFinite() || feeAmount.isNegative() ||
    !payoutAmount.isFinite() || !payoutAmount.isGreaterThan(0) ||
    !amountRawDecimal.isInteger()
  ) throw new RangeError("The calculated individual disbursement amount is invalid");

  return {
    grossAmountXtu: grossXtu,
    grossInitialAsset,
    grossBalance: grossXtu,
    priceValue: price,
    payoutAmount,
    soldInitialAsset,
    feeAmount,
    feeInitialAsset,
    amountRaw: amountRawDecimal.toFixed(0),
  };
}

/** Ensure the frozen global liquidation liability leaves a positive XTU backing value. */
function validateGlobalDisbursementCapacity(totalUnitsPriceValue, snapshotPriceValue, totalInitialAssetValue) {
  const totalUnitsPrice = finitePositive(totalUnitsPriceValue, "common.total_units_price");
  const snapshotPrice = finitePositive(snapshotPriceValue, "global snapshot unit price");
  const totalInitialAsset = new BigNumber(totalInitialAssetValue);
  if (!totalInitialAsset.isFinite() || totalInitialAsset.isNegative()) {
    throw new RangeError("Global liquidation initial-asset total must be finite and non-negative");
  }
  const grossLiability = totalInitialAsset.multipliedBy(snapshotPrice);
  const remainingValue = totalUnitsPrice.minus(grossLiability);
  return {
    available: remainingValue.isGreaterThan(0),
    grossLiability,
    remainingValue,
  };
}

/** Global liquidation is fee-free; the announced bonus is calculated on the net XTU amount. */
function calculateGlobalDisbursement(balanceInitialAssetValue, priceValue, gasRecoveryValue = 0, bonusRateValue = 0) {
  const grossInitialAsset = finitePositive(balanceInitialAssetValue, "users_stock.balance");
  const price = finitePositive(priceValue, "common.unit_price");
  const gasRecovery = new BigNumber(gasRecoveryValue);
  const bonusRate = new BigNumber(bonusRateValue);
  if (!gasRecovery.isFinite() || gasRecovery.isNegative()) {
    throw new RangeError("BSC fee recovery must be finite and non-negative");
  }
  if (
    !bonusRate.isFinite() || bonusRate.isNegative() ||
    bonusRate.isGreaterThan(10)
  ) {
    throw new RangeError("GLOBAL_DISBURSEMENT_BONUS must be between 0 and 10 percent");
  }

  const grossAmount = grossInitialAsset.multipliedBy(price);
  const bonusAmount = grossAmount.multipliedBy(bonusRate).dividedBy(100)
    .decimalPlaces(TOKEN_DECIMALS, BigNumber.ROUND_DOWN);
  const bonusInitialAsset = bonusAmount.dividedBy(price);
  const payoutBeforeGas = grossAmount.plus(bonusAmount);
  const payoutAmount = payoutBeforeGas.minus(gasRecovery)
    .decimalPlaces(TOKEN_DECIMALS, BigNumber.ROUND_DOWN);
  if (!payoutAmount.isFinite() || !payoutAmount.isGreaterThan(0)) {
    throw new RangeError("Global disbursement is not sufficient to cover its BSC gas fee");
  }
  const amountRawDecimal = payoutAmount.shiftedBy(TOKEN_DECIMALS);
  if (!amountRawDecimal.isInteger()) throw new RangeError("Global disbursement raw amount is invalid");
  return {
    grossInitialAsset,
    grossBalance: grossAmount,
    netRequestedAmount: grossAmount,
    bonusRatePercent: bonusRate,
    bonusAmount,
    bonusInitialAsset,
    payoutBeforeGas,
    priceValue: price,
    payoutAmount,
    soldInitialAsset: grossInitialAsset,
    feeAmount: new BigNumber(0),
    feeInitialAsset: new BigNumber(0),
    bscFeeRecoveredUsd: gasRecovery,
    amountRaw: amountRawDecimal.toFixed(0),
  };
}

function calculateDisbursementReserveSettlement(
  totalUnitsPriceValue,
  backedUnitsValue,
  inactiveInitAssetValue,
  disbursement,
  sysInactiveInitAssetValue = "0",
) {
  const totalUnitsPrice = new BigNumber(totalUnitsPriceValue);
  const backedUnits = new BigNumber(backedUnitsValue);
  const inactiveInitAsset = new BigNumber(inactiveInitAssetValue);
  const sysInactiveInitAsset = new BigNumber(sysInactiveInitAssetValue);
  if (
    !totalUnitsPrice.isFinite() || !totalUnitsPrice.isGreaterThan(0) ||
    !backedUnits.isFinite() || !backedUnits.isGreaterThan(0) ||
    !inactiveInitAsset.isFinite() || inactiveInitAsset.isNegative() ||
    !sysInactiveInitAsset.isFinite() || sysInactiveInitAsset.isNegative()
  ) {
    throw new RangeError("Common reserve values must be finite and non-negative, with positive backing");
  }

  const payoutAmount = finitePositive(disbursement.payoutAmount, "payoutAmount");
  const reserveExpenseAmount = finitePositive(
    disbursement.reserveExpenseAmount ?? payoutAmount,
    "reserveExpenseAmount",
  );
  const soldInitialAsset = finitePositive(disbursement.soldInitialAsset, "soldInitialAsset");
  const feeInitialAsset = new BigNumber(disbursement.feeInitialAsset);
  const bonusInitialAsset = new BigNumber(disbursement.bonusInitialAsset || "0");
  if (!feeInitialAsset.isFinite() || feeInitialAsset.isNegative()) {
    throw new RangeError("Disbursement fee initial-asset basis is invalid");
  }
  if (!bonusInitialAsset.isFinite() || bonusInitialAsset.isNegative()) {
    throw new RangeError("Disbursement bonus initial-asset basis is invalid");
  }
  if (bonusInitialAsset.isGreaterThan(backedUnits)) {
    throw new RangeError("Administrative reserve is insufficient for the global bonus");
  }

  // Principal is moved to the inactive reserve. The bonus is paid from the
  // protected administrative backing and is therefore removed from backed_units.
  // The treasury pays both the token amount sent to the user and the actual
  // BNB gas expense. For global reimbursement, gas is deducted from the user's
  // payout estimate, but the actual receipt cost must still be debited here.
  const newTotalUnitsPrice = totalUnitsPrice.minus(reserveExpenseAmount);
  const newInactiveInitAsset = inactiveInitAsset.plus(soldInitialAsset);
  const newBackedUnits = backedUnits.minus(bonusInitialAsset).plus(feeInitialAsset);
  const newSysInactiveInitAsset = sysInactiveInitAsset.plus(bonusInitialAsset);
  if (!newTotalUnitsPrice.isGreaterThan(0) || !newBackedUnits.isGreaterThan(0)) {
    throw new RangeError("Disbursement would exhaust the common reserve or backing");
  }
  const newUnitPrice = calculateGlobalUnitPrice(newTotalUnitsPrice, newBackedUnits);
  return {
    newTotalUnitsPrice,
    reserveExpenseAmount,
    newInactiveInitAsset,
    newBackedUnits,
    newSysInactiveInitAsset,
    newUnitPrice,
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
  calculateIndividualDisbursement,
  validateGlobalDisbursementCapacity,
  calculateGlobalDisbursement,
  calculateDisbursementReserveSettlement,
  isRequestedPayoutWithinTolerance,
};
