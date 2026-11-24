"use strict";

const BigNumber = require("bignumber.js");

BigNumber.config({ DECIMAL_PLACES: 36, ROUNDING_MODE: BigNumber.ROUND_HALF_UP });

const INITIAL_ASSET_DECIMALS = 30;

function finitePositive(value, fieldName) {
  const amount = new BigNumber(value);
  if (!amount.isFinite() || !amount.isGreaterThan(0)) {
    throw new RangeError(`${fieldName} must be finite and positive.`);
  }
  return amount;
}

function finiteNonNegative(value, fieldName) {
  const amount = new BigNumber(value);
  if (!amount.isFinite() || amount.isNegative()) {
    throw new RangeError(`${fieldName} must be finite and non-negative.`);
  }
  return amount;
}

/**
 * Reserve the user's gross XTU principal at the captured individual price.
 * The initial-asset amount is stored at the database's 30-decimal precision;
 * the corresponding XTU value is derived from that exact stored amount.
 */
function calculateXtuWithdrawalReservation({
  grossAmount,
  individualPrice,
  totalUnitsPrice,
  backedUnits,
  protectedBackedFloor = "0",
}) {
  const gross = finitePositive(grossAmount, "gross XTU amount");
  const price = finitePositive(individualPrice, "individual XTU price");
  const total = finitePositive(totalUnitsPrice, "common.total_units_price");
  const backed = finitePositive(backedUnits, "common.backed_units");
  const protectedFloor = finiteNonNegative(protectedBackedFloor, "protected backed-assets floor");

  const reservedInitialAsset = gross
    .dividedBy(price)
    .decimalPlaces(INITIAL_ASSET_DECIMALS, BigNumber.ROUND_HALF_UP);
  if (!reservedInitialAsset.isGreaterThan(0)) {
    throw new RangeError("The withdrawal is below the smallest reservable initial-asset amount.");
  }

  const reservedXtuValue = reservedInitialAsset
    .multipliedBy(price)
    .decimalPlaces(INITIAL_ASSET_DECIMALS, BigNumber.ROUND_HALF_UP);
  const newTotalUnitsPrice = total.minus(reservedXtuValue);
  const newBackedUnits = backed.minus(reservedInitialAsset);

  if (!reservedXtuValue.isGreaterThan(0) || !newTotalUnitsPrice.isGreaterThan(0)) {
    throw new RangeError("The common XTU reserve cannot cover the requested principal.");
  }
  if (!newBackedUnits.isGreaterThan(0) || newBackedUnits.isLessThan(protectedFloor)) {
    throw new RangeError("The withdrawal would breach the protected backed-assets reserve.");
  }

  return {
    reservedInitialAsset,
    reservedXtuValue,
    newTotalUnitsPrice,
    newBackedUnits,
  };
}

/** Move the confirmed withdrawal's initial-asset basis into the inactive reserve. */
function calculateXtuWithdrawalInactiveReserve(inactiveInitialAsset, reservedInitialAsset) {
  const inactive = finiteNonNegative(inactiveInitialAsset, "common.inactive_init_asset");
  const reserved = finitePositive(reservedInitialAsset, "reserved initial assets");
  return inactive.plus(reserved);
}

/** Restore a reverted withdrawal while retaining only the actual BNB gas expense. */
function calculateXtuWithdrawalReversal({
  totalUnitsPrice,
  backedUnits,
  reservedXtuValue,
  reservedInitialAsset,
  actualGasFeeUsd,
}) {
  const total = finitePositive(totalUnitsPrice, "common.total_units_price");
  const backed = finitePositive(backedUnits, "common.backed_units");
  const reservedValue = finitePositive(reservedXtuValue, "reserved XTU value");
  const reservedInitial = finitePositive(reservedInitialAsset, "reserved initial assets");
  const actualGas = finiteNonNegative(actualGasFeeUsd, "actual BNB gas fee");

  const restoredTotalUnitsPrice = total.plus(reservedValue).minus(actualGas);
  const restoredBackedUnits = backed.plus(reservedInitial);
  if (!restoredTotalUnitsPrice.isGreaterThan(0) || !restoredBackedUnits.isGreaterThan(0)) {
    throw new RangeError("The failed XTU withdrawal cannot be reversed without invalidating the common reserve.");
  }
  return { restoredTotalUnitsPrice, restoredBackedUnits };
}

module.exports = {
  calculateXtuWithdrawalReservation,
  calculateXtuWithdrawalInactiveReserve,
  calculateXtuWithdrawalReversal,
};
