"use strict";

const BigNumber = require("bignumber.js");

BigNumber.config({ DECIMAL_PLACES: 36, ROUNDING_MODE: BigNumber.ROUND_HALF_UP });

function asBigNumber(value, fieldName) {
  const number = new BigNumber(value);
  if (!number.isFinite()) throw new TypeError(`${fieldName} must be a finite numeric value`);
  return number;
}

/** The only OneX price: public XTU value per initial asset. */
function calculateGlobalUnitPrice(totalUnitsPriceValue, backedUnitsValue, minimumPriceValue = 0) {
  const totalUnitsPrice = asBigNumber(totalUnitsPriceValue, "common.total_units_price");
  const backedUnits = asBigNumber(backedUnitsValue, "common.backed_units");
  if (!totalUnitsPrice.isGreaterThan(0)) throw new RangeError("common.total_units_price must be positive");
  if (!backedUnits.isGreaterThan(0)) throw new RangeError("common.backed_units must remain positive");
  const minimumPrice = asBigNumber(minimumPriceValue, "minimum global unit price");
  if (minimumPrice.isNegative()) throw new RangeError("The minimum global unit price cannot be negative");
  const reserveRatioPrice = totalUnitsPrice.dividedBy(backedUnits);
  const price = BigNumber.maximum(reserveRatioPrice, minimumPrice);
  if (!price.isFinite() || !price.isGreaterThan(0)) throw new RangeError("The global unit price is invalid");
  return price;
}

function xtuToInitialAsset(amountXtuValue, unitPriceValue) {
  const amountXtu = asBigNumber(amountXtuValue, "XTU amount");
  const unitPrice = asBigNumber(unitPriceValue, "common.unit_price");
  if (amountXtu.isNegative()) throw new RangeError("XTU amount cannot be negative");
  if (!unitPrice.isGreaterThan(0)) throw new RangeError("common.unit_price must be positive");
  return amountXtu.dividedBy(unitPrice);
}

function initialAssetToXtu(initialAssetValue, unitPriceValue) {
  const initialAsset = asBigNumber(initialAssetValue, "initial-asset amount");
  const unitPrice = asBigNumber(unitPriceValue, "common.unit_price");
  if (initialAsset.isNegative()) throw new RangeError("Initial-asset amount cannot be negative");
  if (!unitPrice.isGreaterThan(0)) throw new RangeError("common.unit_price must be positive");
  return initialAsset.multipliedBy(unitPrice);
}

/**
 * Calculate the administrative reserve quota that remains protected in
 * common.backed_units. The cumulative spent amount is not a reserve balance;
 * it records how much of the original administrative quota has been consumed.
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
 * Spend XTU from the protected administrative portion of common.backed_units.
 * The corresponding initial assets move to the cumulative system-spending
 * ledger. Numerator and denominator decrease proportionally, preserving the
 * current global price (subject only to storage precision).
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
  const calculatedPrice = calculateGlobalUnitPrice(totalUnitsPrice, backedUnits);

  if (!amount.isGreaterThan(0)) throw new RangeError("Administrative amount must be positive");
  if (!unitPrice.isGreaterThan(0)) throw new RangeError("common.unit_price must be positive");
  if (calculatedPrice.minus(unitPrice).gt("0.000000000000000000000000000001")) {
    throw new RangeError("common.unit_price must not be below total_units_price / backed_units");
  }

  const availableInitialAsset = BigNumber.minimum(reserve.remainingInitialAsset, backedUnits);
  const availableValue = availableInitialAsset.multipliedBy(unitPrice);
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

  const spentInitialAsset = xtuToInitialAsset(amount, unitPrice);
  const newBackedUnits = backedUnits.minus(spentInitialAsset);
  const newSysInactiveInitAsset = sysInactive.plus(spentInitialAsset);
  const newTotalUnitsPrice = totalUnitsPrice.minus(amount);
  const newUnitPrice = calculateGlobalUnitPrice(newTotalUnitsPrice, newBackedUnits, unitPrice);
  const remainingAdminInitialAsset = reserve.remainingInitialAsset.minus(spentInitialAsset);

  if (
    spentInitialAsset.isNegative() || newBackedUnits.isNegative() ||
    newSysInactiveInitAsset.gt(reserve.initialQuota) || remainingAdminInitialAsset.isNegative() ||
    newBackedUnits.lt(remainingAdminInitialAsset)
  ) {
    throw new RangeError("Administrative expenditure would create an invalid reserve state");
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
 * Distributable reserves consist of all inactive initial assets plus the
 * backed initial assets above the still-unspent administrative quota.
 */
function calculateDistributableInitialAssets(backedValue, inactiveValue, protectedFloorValue) {
  const backed = asBigNumber(backedValue, "common.backed_units");
  const inactive = asBigNumber(inactiveValue, "common.inactive_init_asset");
  const protectedFloor = asBigNumber(protectedFloorValue, "remaining administrative reserve");
  if (backed.isNegative() || inactive.isNegative() || protectedFloor.isNegative()) {
    throw new RangeError("Reserve amounts and the protected floor cannot be negative");
  }
  if (backed.isLessThan(protectedFloor)) {
    throw new RangeError("common.backed_units is below the remaining administrative reserve quota");
  }
  const distributableBacked = backed.minus(protectedFloor);
  return {
    distributableBacked,
    totalAvailableInitialAssets: backed.plus(inactive),
    distributableInitialAssets: distributableBacked.plus(inactive),
  };
}

/** Subtract initial-asset amounts already reserved by unresolved disbursements. */
function calculateUnreservedDistributableInitialAssets(
  backedValue,
  inactiveValue,
  protectedFloorValue,
  pendingDisbursementInitialAssetValue = 0,
) {
  const base = calculateDistributableInitialAssets(backedValue, inactiveValue, protectedFloorValue);
  const pending = asBigNumber(pendingDisbursementInitialAssetValue, "pending disbursement initial assets");
  if (pending.isNegative()) throw new RangeError("Pending disbursement reservations cannot be negative");
  const availableAfterPending = base.distributableInitialAssets.minus(pending);
  return {
    ...base,
    pendingDisbursementInitialAssets: pending,
    availableAfterPending,
  };
}

/**
 * Allocate a system-funded XTU top-up using initial-asset reserves. The XTU
 * amount is valued at the transaction's pre-operation global price. Inactive
 * assets are consumed first; backed assets may only be consumed above the
 * remaining administrative quota. New price is the maximum of the prior global price and the resulting T / B ratio.
 */
function calculateTopUpReserveAllocation(
  amountValue,
  unitPriceValue,
  backedValue,
  inactiveValue,
  totalUnitsPriceValue,
  nonDistributableFloorValue = 0,
) {
  const amountXtu = asBigNumber(amountValue, "top-up amount");
  const unitPrice = asBigNumber(unitPriceValue, "common.unit_price");
  const backed = asBigNumber(backedValue, "common.backed_units");
  const inactive = asBigNumber(inactiveValue, "common.inactive_init_asset");
  const totalUnitsPrice = asBigNumber(totalUnitsPriceValue, "common.total_units_price");
  const nonDistributableFloor = asBigNumber(nonDistributableFloorValue, "system reserve floor");

  if (!amountXtu.isGreaterThan(0)) throw new RangeError("Top-up amount must be positive");
  if (!unitPrice.isGreaterThan(0)) throw new RangeError("common.unit_price must be positive");
  if (backed.isNegative() || inactive.isNegative() || nonDistributableFloor.isNegative()) {
    throw new RangeError("Reserve amounts and protected floor cannot be negative");
  }
  if (!totalUnitsPrice.isGreaterThan(0)) throw new RangeError("common.total_units_price must be positive");
  const minimumRequiredPrice = calculateGlobalUnitPrice(totalUnitsPrice, backed);
  if (minimumRequiredPrice.minus(unitPrice).gt("0.000000000000000000000000000001")) {
    throw new RangeError("common.unit_price must not be below total_units_price / backed_units");
  }

  const activityAmount = xtuToInitialAsset(amountXtu, unitPrice);
  const { totalAvailableInitialAssets, distributableInitialAssets } =
    calculateDistributableInitialAssets(backed, inactive, nonDistributableFloor);
  const availableValue = distributableInitialAssets.multipliedBy(unitPrice);
  if (amountXtu.isGreaterThan(availableValue)) {
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
  const newTotalUnitsPrice = totalUnitsPrice.plus(amountXtu);
  const newUnitPrice = calculateGlobalUnitPrice(newTotalUnitsPrice, newBacked, unitPrice);
  if (newBacked.isLessThan(nonDistributableFloor)) {
    throw new RangeError("Top-up allocation would consume the administrative reserve floor");
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
    usedBackedAssets: consumedBacked.isGreaterThan(0),
  };
}

/**
 * Allocate a deposit in the required funding order:
 * inactive OneX reserve, active seller lots, then distributable backed assets.
 * `pendingDisbursementInitialAssetValue` is a system-reserve reservation and
 * must remain available after this deposit. Seller lots are tracked
 * separately and are therefore not included in that reservation pool.
 */
function calculateDepositFundingAllocation(
  requestedInitialAssetValue,
  unitPriceValue,
  backedValue,
  inactiveValue,
  sellersReserveValue,
  totalUnitsPriceValue,
  protectedFloorValue = 0,
  pendingDisbursementInitialAssetValue = 0,
) {
  const requested = asBigNumber(requestedInitialAssetValue, "deposit initial-asset amount");
  const unitPrice = asBigNumber(unitPriceValue, "common.unit_price");
  const backed = asBigNumber(backedValue, "common.backed_units");
  const inactive = asBigNumber(inactiveValue, "common.inactive_init_asset");
  const sellers = asBigNumber(sellersReserveValue, "common.sellers_res");
  const total = asBigNumber(totalUnitsPriceValue, "common.total_units_price");
  const protectedFloor = asBigNumber(protectedFloorValue, "remaining administrative reserve");
  const pending = asBigNumber(pendingDisbursementInitialAssetValue, "pending disbursement initial assets");

  if (!requested.isGreaterThan(0)) throw new RangeError("Deposit initial-asset amount must be positive");
  if (!unitPrice.isGreaterThan(0)) throw new RangeError("common.unit_price must be positive");
  if (!total.isGreaterThan(0)) throw new RangeError("common.total_units_price must be positive");
  if ([backed, inactive, sellers, protectedFloor, pending].some((value) => value.isNegative())) {
    throw new RangeError("Deposit reserve amounts cannot be negative");
  }
  if (backed.isLessThan(protectedFloor)) {
    throw new RangeError("common.backed_units is below the remaining administrative reserve quota");
  }

  const minimumRequiredPrice = calculateGlobalUnitPrice(total, backed);
  if (minimumRequiredPrice.minus(unitPrice).gt("0.000000000000000000000000000001")) {
    throw new RangeError("common.unit_price must not be below total_units_price / backed_units");
  }

  const distributableBacked = backed.minus(protectedFloor);
  const availableSystemReserves = inactive.plus(distributableBacked);
  const availableAfterPending = availableSystemReserves.minus(pending);

  const consumedInactive = BigNumber.minimum(requested, inactive);
  const afterInactive = requested.minus(consumedInactive);
  const consumedSellers = BigNumber.minimum(afterInactive, sellers);
  const afterSellers = afterInactive.minus(consumedSellers);
  const consumedBacked = afterSellers;
  const systemInitialAsset = consumedInactive.plus(consumedBacked);
  const sellerInitialAsset = consumedSellers;

  const available =
    (systemInitialAsset.isZero() || availableAfterPending.isGreaterThanOrEqualTo(systemInitialAsset)) &&
    consumedBacked.isLessThanOrEqualTo(distributableBacked);

  if (!available) {
    return {
      available: false,
      requestedInitialAsset: requested,
      availableSystemReserves,
      availableAfterPending,
      distributableBacked,
      consumedInactive: new BigNumber(0),
      consumedSellers: new BigNumber(0),
      consumedBacked: new BigNumber(0),
      systemInitialAsset: new BigNumber(0),
      sellerInitialAsset: new BigNumber(0),
      newInactive: inactive,
      newSellersReserve: sellers,
      newBacked: backed,
      newTotalUnitsPrice: total,
      newUnitPrice: unitPrice,
    };
  }

  const systemAmountXtu = systemInitialAsset.multipliedBy(unitPrice);
  const newInactive = inactive.minus(consumedInactive);
  const newSellersReserve = sellers.minus(consumedSellers);
  const newBacked = backed.minus(consumedBacked);
  const newTotalUnitsPrice = total.plus(systemAmountXtu);
  const newUnitPrice = calculateGlobalUnitPrice(newTotalUnitsPrice, newBacked, unitPrice);

  if (newBacked.isLessThan(protectedFloor) || newInactive.isNegative() || newSellersReserve.isNegative()) {
    throw new RangeError("Deposit allocation would breach a protected reserve");
  }

  return {
    available: true,
    requestedInitialAsset: requested,
    availableSystemReserves,
    availableAfterPending,
    distributableBacked,
    consumedInactive,
    consumedSellers,
    consumedBacked,
    systemInitialAsset,
    sellerInitialAsset,
    systemAmountXtu,
    sellerAmountXtu: sellerInitialAsset.multipliedBy(unitPrice),
    newInactive,
    newSellersReserve,
    newBacked,
    newTotalUnitsPrice,
    newUnitPrice,
    usedBackedAssets: consumedBacked.isGreaterThan(0),
  };
}

/** Check a user's projected XTU balance against the global stock cap. */
function isUserBalanceWithinMaxStock(currentInitialAssetValue, creditInitialAssetValue, unitPriceValue, maximumXtuValue) {
  const currentInitialAsset = asBigNumber(currentInitialAssetValue, "current user initial-asset balance");
  const creditInitialAsset = asBigNumber(creditInitialAssetValue, "user credit initial-asset amount");
  const unitPrice = asBigNumber(unitPriceValue, "common.unit_price");
  const maximumXtu = asBigNumber(maximumXtuValue, "maximum user XTU balance");
  if (currentInitialAsset.isNegative() || creditInitialAsset.isNegative()) {
    throw new RangeError("User balances and credits cannot be negative");
  }
  if (!unitPrice.isGreaterThan(0) || !maximumXtu.isGreaterThan(0)) {
    throw new RangeError("The global price and maximum user balance must be positive");
  }
  const projectedXtu = currentInitialAsset.plus(creditInitialAsset).multipliedBy(unitPrice);
  return {
    allowed: projectedXtu.isLessThanOrEqualTo(maximumXtu),
    projectedXtu,
    maximumXtu,
  };
}

module.exports = {
  calculateGlobalUnitPrice,
  xtuToInitialAsset,
  initialAssetToXtu,
  calculateRemainingSystemAdminReserve,
  calculateAdminCommonStockUpdate,
  calculateDistributableInitialAssets,
  calculateUnreservedDistributableInitialAssets,
  calculateTopUpReserveAllocation,
  calculateDepositFundingAllocation,
  isUserBalanceWithinMaxStock,
};
