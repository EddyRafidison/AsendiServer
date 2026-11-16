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
 * Derive the account-specific unit price from its current XTU balance
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
 * Calculate the remaining non-distributable administrative initial-asset quota.
 * Administrative spending is cumulative and reduces the protected quota one-for-one.
 */
function calculateRemainingSystemAdminReserve(initialStockValue, ratioValue, spentInitialAssetValue) {
  const initialStock = asBigNumber(initialStockValue, "STOCK_LIMIT");
  const ratio = asBigNumber(ratioValue, "SYSTEM_ADMIN_RESERVE_RATIO");
  const spent = asBigNumber(spentInitialAssetValue, "common.sys_inactive_init_asset");

  if (!initialStock.isGreaterThan(0)) throw new RangeError("STOCK_LIMIT must be positive");
  if (ratio.isNegative() || !ratio.isLessThan(1)) {
    throw new RangeError("SYSTEM_ADMIN_RESERVE_RATIO must be between zero and one");
  }
  if (spent.isNegative()) throw new RangeError("Administrative spending cannot be negative");

  const initialQuota = initialStock.multipliedBy(ratio);
  if (spent.isGreaterThan(initialQuota)) {
    throw new RangeError("common.sys_inactive_init_asset exceeds the initial administrative reserve quota");
  }
  return {
    initialQuota,
    spentInitialAsset: spent,
    remainingInitialAsset: initialQuota.minus(spent),
  };
}

/**
 * Apply an administrative common-stock operation using the current unit price.
 * The spent initial-asset basis moves out of backed_units into the cumulative
 * sys_inactive_init_asset ledger. The buyback reduces total_units_price by the
 * XTU amount spent while preserving the current unit_price.
 */
function calculateAdminCommonStockUpdate(
  amountValue,
  totalUnitsPriceValue,
  unitPriceValue,
  backedUnitsValue,
  sysInactiveInitAssetValue,
  initialStockValue,
  ratioValue,
) {
  const amount = asBigNumber(amountValue, "administrative amount");
  const totalUnitsPrice = asBigNumber(totalUnitsPriceValue, "common.total_units_price");
  const unitPrice = asBigNumber(unitPriceValue, "common.unit_price");
  const backedUnits = asBigNumber(backedUnitsValue, "common.backed_units");
  const sysInactive = asBigNumber(sysInactiveInitAssetValue, "common.sys_inactive_init_asset");
  const reserve = calculateRemainingSystemAdminReserve(initialStockValue, ratioValue, sysInactive);

  if (!amount.isGreaterThan(0)) throw new RangeError("Administrative amount must be positive");
  if (!totalUnitsPrice.isGreaterThan(0)) throw new RangeError("common.total_units_price must be positive");
  if (!unitPrice.isGreaterThan(0)) throw new RangeError("common.unit_price must be positive");
  if (backedUnits.isNegative()) throw new RangeError("common.backed_units cannot be negative");

  const availableInitialAsset = BigNumber.minimum(reserve.remainingInitialAsset, backedUnits);
  const availableValue = BigNumber.minimum(
    availableInitialAsset.multipliedBy(unitPrice),
    totalUnitsPrice,
  );
  if (amount.isGreaterThan(availableValue)) {
    return {
      available: false,
      availableValue,
      availableInitialAsset,
      spentInitialAsset: new BigNumber(0),
      newTotalUnitsPrice: totalUnitsPrice,
      newUnitPrice: unitPrice,
      newBackedUnits: backedUnits,
      newSysInactiveInitAsset: sysInactive,
      remainingAdminInitialAsset: reserve.remainingInitialAsset,
    };
  }

  if (amount.isGreaterThanOrEqualTo(totalUnitsPrice)) {
    throw new RangeError("Administrative amount must be lower than common.total_units_price");
  }

  const spentInitialAsset = amount.dividedBy(unitPrice);
  const newBackedUnits = backedUnits.minus(spentInitialAsset);
  const newSysInactiveInitAsset = sysInactive.plus(spentInitialAsset);
  const newTotalUnitsPrice = totalUnitsPrice.minus(amount);
  const newUnitPrice = unitPrice;
  const remainingAdminInitialAsset = reserve.remainingInitialAsset.minus(spentInitialAsset);

  if (
    !spentInitialAsset.isFinite() || spentInitialAsset.isNegative() ||
    newBackedUnits.isNegative() ||
    !newSysInactiveInitAsset.isFinite() ||
    newSysInactiveInitAsset.isGreaterThan(reserve.initialQuota) ||
    !newTotalUnitsPrice.isFinite() ||
    !newUnitPrice.isFinite() || !newUnitPrice.isGreaterThan(0) ||
    remainingAdminInitialAsset.isNegative()
  ) {
    throw new RangeError("Administrative common-stock update would create an invalid reserve state");
  }

  return {
    available: true,
    availableValue,
    availableInitialAsset,
    spentInitialAsset,
    newTotalUnitsPrice,
    newUnitPrice,
    newBackedUnits,
    newSysInactiveInitAsset,
    remainingAdminInitialAsset,
  };
}

/**
 * Calculate the initial-asset reserve that remains distributable after
 * protecting the unspent administrative quota.
 */
function calculateDistributableInitialAssets(backedValue, inactiveValue, protectedFloorValue) {
  const backed = asBigNumber(backedValue, "common.backed_units");
  const inactive = asBigNumber(inactiveValue, "common.inactive_init_asset");
  const protectedFloor = asBigNumber(protectedFloorValue, "remaining administrative reserve");

  if (backed.isNegative() || inactive.isNegative() || protectedFloor.isNegative()) {
    throw new RangeError("Reserve amounts and the protected floor cannot be negative");
  }

  const totalAvailableInitialAssets = backed.plus(inactive);
  const distributableInitialAssets = BigNumber.maximum(
    new BigNumber(0),
    totalAvailableInitialAssets.minus(protectedFloor),
  );
  return { totalAvailableInitialAssets, distributableInitialAssets };
}

/**
 * Allocate an XTU top-up against common reserves, consuming inactive
 * initial assets first and backed initial assets only for any shortfall.
 * When backed assets are untouched, the common unit price remains unchanged.
 */
function calculateTopUpReserveAllocation(
  amountValue,
  unitPriceValue,
  backedValue,
  inactiveValue,
  totalUnitsPriceValue,
  nonDistributableFloorValue = 0,
) {
  const amount = asBigNumber(amountValue, "top-up amount");
  const unitPrice = asBigNumber(unitPriceValue, "common.unit_price");
  const backed = asBigNumber(backedValue, "common.backed_units");
  const inactive = asBigNumber(inactiveValue, "common.inactive_init_asset");
  const totalUnitsPrice = asBigNumber(totalUnitsPriceValue, "common.total_units_price");
  const nonDistributableFloor = asBigNumber(nonDistributableFloorValue, "system reserve floor");

  if (nonDistributableFloor.isNegative()) throw new RangeError("System reserve floor cannot be negative");
  if (!amount.isGreaterThan(0)) throw new RangeError("Top-up amount must be positive");
  if (!unitPrice.isGreaterThan(0)) throw new RangeError("common.unit_price must be positive");
  if (backed.isNegative() || inactive.isNegative()) {
    throw new RangeError("Reserve amounts cannot be negative");
  }
  if (!totalUnitsPrice.isGreaterThan(0)) {
    throw new RangeError("common.total_units_price must be positive");
  }

  const activityAmount = amount.dividedBy(unitPrice);
  const { totalAvailableInitialAssets, distributableInitialAssets } =
    calculateDistributableInitialAssets(backed, inactive, nonDistributableFloor);
  const availableValue = distributableInitialAssets.multipliedBy(unitPrice);
  if (amount.isGreaterThan(availableValue)) {
    return {
      available: false,
      availableValue,
      totalAvailableInitialAssets,
      distributableInitialAssets,
      protectedFloor: nonDistributableFloor,
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
    totalAvailableInitialAssets,
    distributableInitialAssets,
    protectedFloor: nonDistributableFloor,
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
  calculateRemainingSystemAdminReserve,
  calculateAdminCommonStockUpdate,
  calculateDistributableInitialAssets,
};
