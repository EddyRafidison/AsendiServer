"use strict";

const BigNumber = require("bignumber.js");
const { DISBURSEMENT_COOLDOWN_MS } = require("./deposit-policy");
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

/** Ensure the frozen, participant-specific global liquidation liability is covered. */
function validateGlobalDisbursementCapacity(totalUnitsPriceValue, snapshotPriceValue, totalInitialAssetValue, individualLiabilityXtuValue = null) {
  const totalUnitsPrice = finitePositive(totalUnitsPriceValue, "common.total_units_price");
  const snapshotPrice = finitePositive(snapshotPriceValue, "global snapshot unit price");
  const totalInitialAsset = new BigNumber(totalInitialAssetValue);
  if (!totalInitialAsset.isFinite() || totalInitialAsset.isNegative()) {
    throw new RangeError("Global liquidation initial-asset total must be finite and non-negative");
  }
  const grossLiability = individualLiabilityXtuValue == null
    ? totalInitialAsset.multipliedBy(snapshotPrice)
    : new BigNumber(individualLiabilityXtuValue);
  if (!grossLiability.isFinite() || grossLiability.isNegative()) {
    throw new RangeError("Global participant liability must be finite and non-negative");
  }
  const remainingValue = totalUnitsPrice.minus(grossLiability);
  return { available: remainingValue.isGreaterThan(0), grossLiability, remainingValue };
}

/** Global liquidation applies recipient-paid tfees and separately recovers BSC gas from the payout. */
function calculateGlobalDisbursement(balanceInitialAssetValue, priceValue, gasRecoveryValue = 0, bonusRateValue = 0, feePercentValue = 0) {
  const grossInitialAsset = finitePositive(balanceInitialAssetValue, "users_stock.balance");
  const price = finitePositive(priceValue, "participant individual snapshot price");
  const gasRecovery = new BigNumber(gasRecoveryValue);
  const bonusRate = new BigNumber(bonusRateValue);
  const feeRate = new BigNumber(feePercentValue);
  if (!gasRecovery.isFinite() || gasRecovery.isNegative()) throw new RangeError("BSC fee recovery must be finite and non-negative");
  if (!bonusRate.isFinite() || bonusRate.isNegative() || bonusRate.isGreaterThan(10)) {
    throw new RangeError("GLOBAL_DISBURSEMENT_BONUS must be between 0 and 10 percent");
  }
  if (!feeRate.isFinite() || feeRate.isNegative() || !feeRate.isLessThan(100)) {
    throw new RangeError("tfees rate must be between 0 and 100 percent");
  }

  const grossBalance = grossInitialAsset.multipliedBy(price);
  const feeInitialAsset = grossInitialAsset.multipliedBy(feeRate).dividedBy(100);
  const feeAmount = feeInitialAsset.multipliedBy(price);
  const soldInitialAsset = grossInitialAsset.minus(feeInitialAsset);
  const netBalance = soldInitialAsset.multipliedBy(price);
  const bonusAmount = netBalance.multipliedBy(bonusRate).dividedBy(100)
    .decimalPlaces(TOKEN_DECIMALS, BigNumber.ROUND_DOWN);
  const bonusInitialAsset = bonusAmount.dividedBy(price);
  const payoutBeforeGas = netBalance.plus(bonusAmount);
  const payoutAmount = payoutBeforeGas.minus(gasRecovery).decimalPlaces(TOKEN_DECIMALS, BigNumber.ROUND_DOWN);
  if (!payoutAmount.isFinite() || !payoutAmount.isGreaterThan(0)) {
    throw new RangeError("Global disbursement is not sufficient to cover its BSC gas fee and tfees");
  }
  const amountRawDecimal = payoutAmount.shiftedBy(TOKEN_DECIMALS);
  if (!amountRawDecimal.isInteger()) throw new RangeError("Global disbursement raw amount is invalid");
  return {
    grossInitialAsset,
    grossBalance,
    netRequestedAmount: netBalance,
    bonusRatePercent: bonusRate,
    bonusAmount,
    bonusInitialAsset,
    payoutBeforeGas,
    priceValue: price,
    payoutAmount,
    soldInitialAsset,
    feeAmount,
    feeInitialAsset,
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
  minimumUnitPriceValue = "0",
) {
  const totalUnitsPrice = new BigNumber(totalUnitsPriceValue);
  const backedUnits = new BigNumber(backedUnitsValue);
  const inactiveInitAsset = new BigNumber(inactiveInitAssetValue);
  const sysInactiveInitAsset = new BigNumber(sysInactiveInitAssetValue);
  const minimumUnitPrice = new BigNumber(minimumUnitPriceValue);
  if (
    !totalUnitsPrice.isFinite() || !totalUnitsPrice.isGreaterThan(0) ||
    !backedUnits.isFinite() || !backedUnits.isGreaterThan(0) ||
    !inactiveInitAsset.isFinite() || inactiveInitAsset.isNegative() ||
    !sysInactiveInitAsset.isFinite() || sysInactiveInitAsset.isNegative() ||
    !minimumUnitPrice.isFinite() || minimumUnitPrice.isNegative()
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
  const feeValueXtu = new BigNumber(disbursement.feeValueXtu || "0");
  const bonusInitialAsset = new BigNumber(disbursement.bonusInitialAsset || "0");
  if (!feeInitialAsset.isFinite() || feeInitialAsset.isNegative()) {
    throw new RangeError("Disbursement fee initial-asset basis is invalid");
  }
  if (!feeValueXtu.isFinite() || feeValueXtu.isNegative()) {
    throw new RangeError("Disbursement fee XTU reserve value is invalid");
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
  // BNB gas expense. Tfees return to common backing and are valued at the public
  // global price captured immediately before settlement.
  const newTotalUnitsPrice = totalUnitsPrice.minus(reserveExpenseAmount).plus(feeValueXtu);
  const newInactiveInitAsset = inactiveInitAsset.plus(soldInitialAsset);
  const newBackedUnits = backedUnits.minus(bonusInitialAsset).plus(feeInitialAsset);
  const newSysInactiveInitAsset = sysInactiveInitAsset.plus(bonusInitialAsset);
  if (!newTotalUnitsPrice.isGreaterThan(0) || !newBackedUnits.isGreaterThan(0)) {
    throw new RangeError("Disbursement would exhaust the common reserve or backing");
  }
  const newUnitPrice = calculateGlobalUnitPrice(newTotalUnitsPrice, newBackedUnits, minimumUnitPrice);
  return {
    newTotalUnitsPrice,
    reserveExpenseAmount,
    feeValueXtu,
    newInactiveInitAsset,
    newBackedUnits,
    newSysInactiveInitAsset,
    newUnitPrice,
  };
}

function isPositivePayoutAmount(value) {
  const amount = new BigNumber(value);
  return amount.isFinite() && amount.isGreaterThan(0);
}

function isIndividualDisbursementBalanceEligible(balanceXtuValue, minimumRequestXtuValue) {
  const balance = new BigNumber(balanceXtuValue);
  const minimumRequest = new BigNumber(minimumRequestXtuValue);
  return balance.isFinite() && balance.isGreaterThanOrEqualTo(0) &&
    minimumRequest.isFinite() && minimumRequest.isGreaterThan(0) &&
    balance.isGreaterThanOrEqualTo(minimumRequest);
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
  calculateIndividualDisbursement,
  validateGlobalDisbursementCapacity,
  calculateGlobalDisbursement,
  calculateDisbursementReserveSettlement,
  isRequestedPayoutWithinTolerance,
  isPositivePayoutAmount,
  isIndividualDisbursementBalanceEligible,
};
