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
 * Calculate the administrative backing still protected in common.backed_units.
 * `adminExpenses` is the outstanding amount of administrative expenditure
 * that has not yet been recovered; it is not a historical cumulative counter.
 */
function calculateRemainingAdministrativeBacking(initialStockValue, ratioValue, adminExpensesValue) {
  const initialStock = asBigNumber(initialStockValue, "STOCK_LIMIT");
  const ratio = asBigNumber(ratioValue, "SYSTEM_ADMIN_RESERVE_RATIO");
  const adminExpenses = asBigNumber(adminExpensesValue, "common.admin_expens");

  if (!initialStock.isGreaterThan(0)) throw new RangeError("STOCK_LIMIT must be positive");
  if (ratio.isNegative() || !ratio.isLessThan(1)) {
    throw new RangeError("SYSTEM_ADMIN_RESERVE_RATIO must be between zero and one");
  }
  if (adminExpenses.isNegative()) throw new RangeError("common.admin_expens cannot be negative");

  const initialQuota = initialStock.multipliedBy(ratio);
  if (adminExpenses.isGreaterThan(initialQuota)) {
    throw new RangeError("common.admin_expens exceeds the administrative expenditure cap");
  }
  return {
    initialQuota,
    adminExpensesInitialAsset: adminExpenses,
    remainingInitialAsset: initialQuota.minus(adminExpenses),
  };
}

function roundInitialAsset(value) {
  return new BigNumber(value).decimalPlaces(30, BigNumber.ROUND_DOWN);
}

/** Calculate an administrative reserve expenditure (ONEX -> XADMIN). */
function calculateAdministrativeReserveExpense({
  amountBscUsdValue,
  totalUnitsPriceValue,
  unitPriceValue,
  backedUnitsValue,
  adminExpensesValue,
  initialStockValue,
  ratioValue,
}) {
  const amount = asBigNumber(amountBscUsdValue, "administrative BSC-USD expenditure");
  const total = asBigNumber(totalUnitsPriceValue, "common.total_units_price");
  const price = asBigNumber(unitPriceValue, "common.unit_price");
  const backed = asBigNumber(backedUnitsValue, "common.backed_units");
  const adminExpenses = asBigNumber(adminExpensesValue, "common.admin_expens");
  const reserve = calculateRemainingAdministrativeBacking(initialStockValue, ratioValue, adminExpenses);

  if (!amount.isGreaterThan(0)) throw new RangeError("Administrative expenditure amount must be positive");
  if (!total.isGreaterThan(amount)) throw new RangeError("Administrative expenditure must be lower than common.total_units_price");
  if (!price.isGreaterThan(0) || !backed.isGreaterThan(0)) {
    throw new RangeError("The global unit price and backed initial assets must remain positive");
  }
  const initialAssetAmount = roundInitialAsset(amount.dividedBy(price));
  if (!initialAssetAmount.isGreaterThan(0)) {
    throw new RangeError("Administrative expenditure is below the initial-asset storage precision");
  }
  if (initialAssetAmount.isGreaterThan(reserve.remainingInitialAsset)) {
    return {
      available: false,
      availableInitialAsset: reserve.remainingInitialAsset,
      availableValue: reserve.remainingInitialAsset.multipliedBy(price),
      initialAssetAmount,
    };
  }

  const newTotalUnitsPrice = total.minus(amount);
  const newBackedUnits = backed.minus(initialAssetAmount);
  const newAdminExpenses = adminExpenses.plus(initialAssetAmount);
  const protectedAfter = reserve.initialQuota.minus(newAdminExpenses);
  if (
    !newTotalUnitsPrice.isGreaterThan(0) || !newBackedUnits.isGreaterThan(0) ||
    newAdminExpenses.gt(reserve.initialQuota) || newBackedUnits.lt(protectedAfter)
  ) {
    throw new RangeError("Administrative expenditure would violate the protected reserve floor");
  }
  const newUnitPrice = calculateGlobalUnitPrice(newTotalUnitsPrice, newBackedUnits, price);
  return {
    available: true,
    amountBscUsd: amount,
    initialAssetAmount,
    newTotalUnitsPrice,
    newBackedUnits,
    newAdminExpenses,
    newUnitPrice,
    protectedAdminBackingAfter: protectedAfter,
  };
}

/** Calculate the recovery of a previous administrative expenditure (XADMIN -> ONEX). */
function calculateAdministrativeReserveRecovery({
  amountBscUsdValue,
  totalUnitsPriceValue,
  unitPriceValue,
  backedUnitsValue,
  adminExpensesValue,
  initialStockValue,
  ratioValue,
}) {
  const amount = asBigNumber(amountBscUsdValue, "administrative BSC-USD recovery");
  const total = asBigNumber(totalUnitsPriceValue, "common.total_units_price");
  const price = asBigNumber(unitPriceValue, "common.unit_price");
  const backed = asBigNumber(backedUnitsValue, "common.backed_units");
  const adminExpenses = asBigNumber(adminExpensesValue, "common.admin_expens");
  const reserve = calculateRemainingAdministrativeBacking(initialStockValue, ratioValue, adminExpenses);

  if (!amount.isGreaterThan(0)) throw new RangeError("Administrative recovery amount must be positive");
  if (!price.isGreaterThan(0) || !backed.isGreaterThan(0) || !total.isGreaterThan(0)) {
    throw new RangeError("Common reserve and global unit price must remain positive");
  }
  const maximumRecoverableValue = adminExpenses.multipliedBy(price);
  if (amount.isGreaterThan(maximumRecoverableValue)) {
    return {
      available: false,
      maximumRecoverableValue,
      initialAssetAmount: roundInitialAsset(amount.dividedBy(price)),
    };
  }
  const initialAssetAmount = roundInitialAsset(amount.dividedBy(price));
  if (!initialAssetAmount.isGreaterThan(0) || initialAssetAmount.isGreaterThan(adminExpenses)) {
    throw new RangeError("Administrative recovery exceeds the outstanding administrative expenditure");
  }
  const newTotalUnitsPrice = total.plus(amount);
  const newBackedUnits = backed.plus(initialAssetAmount);
  const newAdminExpenses = adminExpenses.minus(initialAssetAmount);
  const protectedAfter = reserve.initialQuota.minus(newAdminExpenses);
  if (newAdminExpenses.isNegative() || newBackedUnits.lt(protectedAfter)) {
    throw new RangeError("Administrative recovery would create an invalid reserve state");
  }
  const newUnitPrice = calculateGlobalUnitPrice(newTotalUnitsPrice, newBackedUnits, price);
  return {
    available: true,
    amountBscUsd: amount,
    initialAssetAmount,
    maximumRecoverableValue,
    newTotalUnitsPrice,
    newBackedUnits,
    newAdminExpenses,
    newUnitPrice,
    protectedAdminBackingAfter: protectedAfter,
  };
}

/** Calculate a donation that increases valuation without issuing initial assets. */
function calculateCommonReserveGift({ amountBscUsdValue, totalUnitsPriceValue, unitPriceValue, backedUnitsValue }) {
  const amount = asBigNumber(amountBscUsdValue, "BSC-USD gift amount");
  const total = asBigNumber(totalUnitsPriceValue, "common.total_units_price");
  const price = asBigNumber(unitPriceValue, "common.unit_price");
  const backed = asBigNumber(backedUnitsValue, "common.backed_units");
  if (!amount.isGreaterThan(0) || !total.isGreaterThan(0) || !price.isGreaterThan(0) || !backed.isGreaterThan(0)) {
    throw new RangeError("Gift, common reserve and global unit price must be positive");
  }
  const newTotalUnitsPrice = total.plus(amount);
  const newUnitPrice = calculateGlobalUnitPrice(newTotalUnitsPrice, backed, price);
  return { amountBscUsd: amount, newTotalUnitsPrice, newUnitPrice };
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


/**
 * Allocate a deposit exclusively from eligible seller campaign reserves.
 * This path is used after the user's one-per-seven-day OneX system-funded
 * purchase has already been consumed. It must never consume inactive or
 * backed system reserves, even when those reserves are available.
 */
function calculateSellerOnlyDepositFundingAllocation(
  requestedInitialAssetValue,
  unitPriceValue,
  backedValue,
  inactiveValue,
  sellersReserveValue,
  totalUnitsPriceValue,
  protectedFloorValue = 0,
) {
  const requested = asBigNumber(requestedInitialAssetValue, "seller-funded deposit initial-asset amount");
  const unitPrice = asBigNumber(unitPriceValue, "common.unit_price");
  const backed = asBigNumber(backedValue, "common.backed_units");
  const inactive = asBigNumber(inactiveValue, "common.inactive_init_asset");
  const sellers = asBigNumber(sellersReserveValue, "common.sellers_res");
  const total = asBigNumber(totalUnitsPriceValue, "common.total_units_price");
  const protectedFloor = asBigNumber(protectedFloorValue, "remaining administrative reserve");

  if (!requested.isGreaterThan(0) || !unitPrice.isGreaterThan(0) || !total.isGreaterThan(0)) {
    throw new RangeError("Seller-funded deposit amount, global price and total valuation must be positive");
  }
  if ([backed, inactive, sellers, protectedFloor].some((value) => value.isNegative())) {
    throw new RangeError("Seller-funded deposit reserve amounts cannot be negative");
  }
  if (backed.isLessThan(protectedFloor)) {
    throw new RangeError("common.backed_units is below the remaining administrative reserve quota");
  }
  const minimumRequiredPrice = calculateGlobalUnitPrice(total, backed);
  if (minimumRequiredPrice.minus(unitPrice).gt("0.000000000000000000000000000001")) {
    throw new RangeError("common.unit_price must not be below total_units_price / backed_units");
  }

  const available = sellers.isGreaterThanOrEqualTo(requested);
  const consumedSellers = available ? requested : new BigNumber(0);
  const remainingSellerAmount = available ? sellers.minus(requested) : sellers;
  return {
    available,
    requestedInitialAsset: requested,
    availableSellerInitialAsset: sellers,
    remainingSellerInitialAsset: available ? new BigNumber(0) : requested.minus(sellers),
    consumedInactive: new BigNumber(0),
    consumedSellers,
    consumedBacked: new BigNumber(0),
    systemInitialAsset: new BigNumber(0),
    sellerInitialAsset: consumedSellers,
    systemAmountXtu: new BigNumber(0),
    sellerAmountXtu: consumedSellers.multipliedBy(unitPrice),
    newInactive: inactive,
    newSellersReserve: remainingSellerAmount,
    newBacked: backed,
    newTotalUnitsPrice: total,
    newUnitPrice: unitPrice,
    usedBackedAssets: false,
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
  calculateRemainingAdministrativeBacking,
  calculateAdministrativeReserveExpense,
  calculateAdministrativeReserveRecovery,
  calculateCommonReserveGift,
  calculateDistributableInitialAssets,
  calculateUnreservedDistributableInitialAssets,
  calculateTopUpReserveAllocation,
  calculateDepositFundingAllocation,
  calculateSellerOnlyDepositFundingAllocation,
  isUserBalanceWithinMaxStock,
};
