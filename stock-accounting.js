"use strict";

const BigNumber = require("bignumber.js");

// Keep enough fractional precision for repeated balance / initial-asset ratios.
BigNumber.config({
  DECIMAL_PLACES: 36,
  ROUNDING_MODE: BigNumber.ROUND_HALF_UP,
});

function asBigNumber(value, fieldName) {
  const number = new BigNumber(value);
  if (!number.isFinite()) {
    throw new TypeError(`${fieldName} must be a finite numeric value`);
  }
  return number;
}

/**
 * Derive the account-specific unit price from its current One-Val balance
 * and initial-asset balance. A positive init_asset is required.
 */
function deriveUnitPrice(balanceValue, initAssetValue) {
  const balance = asBigNumber(balanceValue, "users_stock.balance");
  const initAsset = asBigNumber(initAssetValue, "users_stock.init_asset");

  if (balance.isNegative() || !balance.isGreaterThan(0)) {
    throw new RangeError("The sender balance must be greater than zero");
  }
  if (!initAsset.isGreaterThan(0)) {
    throw new RangeError("The sender init_asset must be greater than zero");
  }

  const price = balance.dividedBy(initAsset);
  if (!price.isFinite() || !price.isGreaterThan(0)) {
    throw new RangeError("The derived unit price is invalid");
  }
  return price;
}

/** Recalculate init_asset so balance / init_asset equals the supplied price. */
function deriveInitAsset(balanceValue, priceValue) {
  const balance = asBigNumber(balanceValue, "users_stock.balance");
  const price = asBigNumber(priceValue, "priceValue");

  if (balance.isNegative()) {
    throw new RangeError("The resulting balance cannot be negative");
  }
  if (!price.isGreaterThan(0)) {
    throw new RangeError("priceValue must be greater than zero");
  }

  const initAsset = balance.dividedBy(price);
  if (!initAsset.isFinite() || initAsset.isNegative()) {
    throw new RangeError("The resulting init_asset is invalid");
  }
  return initAsset;
}

/**
 * Add the initial-asset basis received by a P2P destination account.
 * The recipient keeps its existing historical basis; only the net basis
 * transferred at the sender's transaction price is added.
 */
function addReceivedInitAsset(currentInitAssetValue, receivedInitAssetValue) {
  const current = asBigNumber(currentInitAssetValue, "recipient init_asset");
  const received = asBigNumber(receivedInitAssetValue, "received initial assets");

  if (current.isNegative()) {
    throw new RangeError("The recipient init_asset cannot be negative");
  }
  if (!received.isFinite() || !received.isGreaterThan(0)) {
    throw new RangeError("Received initial assets must be greater than zero");
  }

  const result = current.plus(received);
  if (!result.isFinite() || result.isNegative()) {
    throw new RangeError("The resulting recipient init_asset is invalid");
  }
  return result;
}

/**
 * Allocate a One-Val top-up against common reserves, consuming inactive
 * initial assets first and backed initial assets only for any shortfall.
 * When backed assets are untouched, the common unit price remains unchanged.
 */
function calculateTopUpReserveAllocation(
  amountValue,
  unitPriceValue,
  backedValue,
  inactiveValue,
  totalUnitsPriceValue,
) {
  const amount = asBigNumber(amountValue, "top-up amount");
  const unitPrice = asBigNumber(unitPriceValue, "common.unit_price");
  const backed = asBigNumber(backedValue, "common.backed_units");
  const inactive = asBigNumber(inactiveValue, "common.inactive_init_asset");
  const totalUnitsPrice = asBigNumber(totalUnitsPriceValue, "common.total_units_price");

  if (!amount.isGreaterThan(0)) throw new RangeError("Top-up amount must be positive");
  if (!unitPrice.isGreaterThan(0)) throw new RangeError("common.unit_price must be positive");
  if (backed.isNegative() || inactive.isNegative()) {
    throw new RangeError("Reserve amounts cannot be negative");
  }
  if (!totalUnitsPrice.isGreaterThan(0)) {
    throw new RangeError("common.total_units_price must be positive");
  }

  const activityAmount = amount.dividedBy(unitPrice);
  const totalAvailableInitialAssets = inactive.plus(backed);
  const availableValue = totalAvailableInitialAssets.multipliedBy(unitPrice);
  if (amount.isGreaterThan(availableValue)) {
    return {
      available: false,
      availableValue,
      activityAmount,
      consumedInactive: new BigNumber(0),
      consumedBacked: new BigNumber(0),
      newInactive: inactive,
      newBacked: backed,
      newTotalUnitsPrice: totalUnitsPrice,
      newUnitPrice: unitPrice,
      usedBackedAssets: false,
    };
  }

  const consumedInactive = BigNumber.minimum(inactive, activityAmount);
  const consumedBacked = activityAmount.minus(consumedInactive);
  const newInactive = inactive.minus(consumedInactive);
  const newBacked = backed.minus(consumedBacked);
  const usedBackedAssets = consumedBacked.isGreaterThan(0);
  const newTotalUnitsPrice = totalUnitsPrice.plus(amount);
  const newUnitPrice = usedBackedAssets
    ? newTotalUnitsPrice.dividedBy(totalUnitsPrice).multipliedBy(unitPrice)
    : unitPrice;

  if (
    !activityAmount.isFinite() || !activityAmount.isGreaterThan(0) ||
    !consumedInactive.isFinite() || consumedInactive.isNegative() ||
    !consumedBacked.isFinite() || consumedBacked.isNegative() ||
    !newInactive.isFinite() || newInactive.isNegative() ||
    !newBacked.isFinite() || newBacked.isNegative() ||
    !newTotalUnitsPrice.isFinite() ||
    !newUnitPrice.isFinite() || !newUnitPrice.isGreaterThan(0)
  ) {
    throw new RangeError("The calculated reserve allocation is invalid");
  }

  return {
    available: true,
    availableValue,
    activityAmount,
    consumedInactive,
    consumedBacked,
    newInactive,
    newBacked,
    newTotalUnitsPrice,
    newUnitPrice,
    usedBackedAssets,
  };
}

module.exports = {
  deriveUnitPrice,
  deriveInitAsset,
  addReceivedInitAsset,
  calculateTopUpReserveAllocation,
};
