"use strict";

const BigNumber = require("bignumber.js");
const { calculateGlobalUnitPrice, calculateDepositFundingAllocation } = require("./stock-accounting");

const MAX_DEFAULT_STOCK = "300";
const { DEPOSIT_MIN_AMOUNT, DEPOSIT_MAX_AMOUNT } = require("./deposit-limits");
// Shared limits: 20 minimum per collecting dossier and 100 maximum per automatic credit tranche for both assets.
const MIN_DEPOSIT_AMOUNT = new BigNumber(DEPOSIT_MIN_AMOUNT);
const MAX_DEPOSIT_AMOUNT = new BigNumber(DEPOSIT_MAX_AMOUNT);
// Keep the first automatically credited tranche distinct from the per-session deposit ceiling.
const MAX_INITIAL_CREDIT_TRANCHE_AMOUNT = new BigNumber(DEPOSIT_MAX_AMOUNT);
const DEPOSIT_PENDING_EXPIRATION_DAYS = Number(process.env.DEPOSIT_PENDING_EXPIRATION_DAYS || 30);
if (DEPOSIT_PENDING_EXPIRATION_DAYS !== 30) {
  throw new RangeError("DEPOSIT_PENDING_EXPIRATION_DAYS is fixed at 30 days by the deposit policy.");
}
const DEPOSIT_PENDING_EXPIRATION_MS = DEPOSIT_PENDING_EXPIRATION_DAYS * 24 * 60 * 60 * 1000;
const SYSTEM_ADMIN_RESERVE_RATIO = new BigNumber(
  process.env.SYSTEM_ADMIN_RESERVE_RATIO || "0.10",
);
const SYSTEM_FUNDED_PURCHASE_COOLDOWN_DAYS = 7;
const DISBURSEMENT_COOLDOWN_DAYS = 30;
const DISBURSEMENT_RESERVATION_MINUTES = 60;

if (
  !MIN_DEPOSIT_AMOUNT.isFinite() || !MIN_DEPOSIT_AMOUNT.isGreaterThan(0) ||
  !MAX_DEPOSIT_AMOUNT.isFinite() || MAX_DEPOSIT_AMOUNT.lt(MIN_DEPOSIT_AMOUNT) ||
  !MAX_INITIAL_CREDIT_TRANCHE_AMOUNT.isFinite() ||
  !MAX_INITIAL_CREDIT_TRANCHE_AMOUNT.isGreaterThan(0) ||
  MAX_INITIAL_CREDIT_TRANCHE_AMOUNT.gt(MAX_DEPOSIT_AMOUNT)
) {
  throw new RangeError("Deposit limits must be finite positive values with maximum >= minimum");
}

const SYSTEM_FUNDED_PURCHASE_COOLDOWN_MS = SYSTEM_FUNDED_PURCHASE_COOLDOWN_DAYS * 24 * 60 * 60 * 1000;
const DISBURSEMENT_COOLDOWN_MS = DISBURSEMENT_COOLDOWN_DAYS * 24 * 60 * 60 * 1000;
const DISBURSEMENT_RESERVATION_MS = DISBURSEMENT_RESERVATION_MINUTES * 60 * 1000;

function validateDepositAmount(amountValue) {
  const amount = new BigNumber(amountValue);
  if (!amount.isFinite() || !amount.isGreaterThan(0)) {
    return { allowed: false, reason: "invalid_amount" };
  }
  return {
    allowed: true,
    reason: null,
    amount,
    minimumAmount: MIN_DEPOSIT_AMOUNT,
    initialCreditLimit: MAX_INITIAL_CREDIT_TRANCHE_AMOUNT,
    requiresCollection: amount.isLessThan(MIN_DEPOSIT_AMOUNT),
    requiresMultipleTranches: amount.isGreaterThan(MAX_INITIAL_CREDIT_TRANCHE_AMOUNT),
  };
}


/**
 * Determine whether the account can accept one minimum automatic deposit
 * without exceeding its public XTU stock limit.
 *
 * Incoming deposits have no OneX-paid consolidation gas. All tfees are retained
 * in the common accounting model. This projection mirrors applyUserTopUp and
 * includes the resulting tfees in both total valuation and backed initial assets.
 */
function calculateMinimumDepositCapacity({
  currentBalanceInitialAsset,
  totalUnitsPrice,
  backedUnits,
  inactiveInitialAsset,
  availableSellerInitialAsset,
  protectedAdminInitialAsset,
  currentUnitPrice,
  tfeesRate,
  maximumUserXtu = MAX_DEFAULT_STOCK,
  stockLimitEvaluator = null,
}) {
  const currentBalance = new BigNumber(currentBalanceInitialAsset);
  const total = new BigNumber(totalUnitsPrice);
  const backed = new BigNumber(backedUnits);
  const inactive = new BigNumber(inactiveInitialAsset);
  const sellers = new BigNumber(availableSellerInitialAsset || 0);
  const protectedFloor = new BigNumber(protectedAdminInitialAsset || 0);
  const price = new BigNumber(currentUnitPrice);
  const feeRate = new BigNumber(tfeesRate);
  const maximumXtu = new BigNumber(maximumUserXtu);

  const values = [currentBalance, total, backed, inactive, sellers, protectedFloor, price, feeRate, maximumXtu];
  if (values.some((value) => !value.isFinite())) {
    throw new TypeError("Minimum-deposit capacity inputs must be finite");
  }
  if (
    currentBalance.isNegative() || total.isLessThanOrEqualTo(0) || backed.isLessThanOrEqualTo(0) ||
    inactive.isNegative() || sellers.isNegative() || protectedFloor.isNegative() ||
    price.isLessThanOrEqualTo(0) || feeRate.isNegative() || feeRate.isGreaterThanOrEqualTo(100) ||
    maximumXtu.isLessThanOrEqualTo(0)
  ) {
    throw new RangeError("Minimum-deposit capacity inputs are outside their valid ranges");
  }

  const calculatedPrice = calculateGlobalUnitPrice(total, backed);
  if (calculatedPrice.minus(price).gt("0.000000000000000000000000000001")) {
    throw new RangeError("common.unit_price must not be below the reserve valuation ratio");
  }

  const feeAmount = MIN_DEPOSIT_AMOUNT.multipliedBy(feeRate).dividedBy(100);
  const minimumNetAmount = MIN_DEPOSIT_AMOUNT.minus(feeAmount);
  if (!minimumNetAmount.isGreaterThan(0)) {
    throw new RangeError("The minimum deposit is fully consumed by tfees");
  }
  const requiredInitialAsset = minimumNetAmount.dividedBy(price);
  const allocation = calculateDepositFundingAllocation(
    requiredInitialAsset,
    price,
    backed,
    inactive,
    sellers,
    total,
    protectedFloor,
    0,
  );

  let projectedPrice = price;
  let projectionMethod = "current_price_fallback";
  if (allocation.available) {
    // Incoming deposit tfees are retained by OneX and added to the common valuation.
    // No BSC gas is deducted from the incoming amount or from the retained tfees.
    const projectedTotal = total
      .plus(allocation.systemInitialAsset.multipliedBy(price))
      .plus(feeAmount);
    const feeInitialAsset = feeAmount.dividedBy(price);
    const projectedBacked = backed.minus(allocation.consumedBacked).plus(feeInitialAsset);
    if (!projectedBacked.isGreaterThan(0)) {
      throw new RangeError("The minimum deposit would exhaust common.backed_units");
    }
    projectedPrice = calculateGlobalUnitPrice(projectedTotal, projectedBacked, price);
    projectionMethod = "retained_tfees_post_deposit_price";
  }

  const stockLimit = typeof stockLimitEvaluator === "function"
    ? stockLimitEvaluator(currentBalance, requiredInitialAsset, projectedPrice)
    : { allowed: currentBalance.plus(requiredInitialAsset).multipliedBy(projectedPrice).isLessThanOrEqualTo(maximumXtu),
      projectedXtu: currentBalance.plus(requiredInitialAsset).multipliedBy(projectedPrice) };
  const projectedBalanceXtu = stockLimit.projectedXtu;
  return {
    allowed: stockLimit.allowed,
    minimumGrossAmount: new BigNumber(MIN_DEPOSIT_AMOUNT),
    minimumTfeesAmount: feeAmount,
    minimumNetAmount,
    requiredInitialAsset,
    currentBalanceXtu: currentBalance.multipliedBy(price),
    projectedBalanceXtu,
    projectedUnitPrice: projectedPrice,
    maximumUserXtu: maximumXtu,
    reserveAllocationAvailable: allocation.available,
    projectionMethod,
  };
}

function recordDateTimeToUtcMs(recordDate, recordTime) {
  const date = String(recordDate ?? "").replace(/\D/g, "").padStart(8, "0");
  const time = String(recordTime ?? "").replace(/\D/g, "").padStart(6, "0");
  if (!/^\d{8}$/.test(date) || !/^\d{6}$/.test(time)) return null;

  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(4, 6));
  const day = Number(date.slice(6, 8));
  const hour = Number(time.slice(0, 2));
  const minute = Number(time.slice(2, 4));
  const second = Number(time.slice(4, 6));
  if (year < 2000 || month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) return null;

  const value = Date.UTC(year, month - 1, day, hour, minute, second);
  const parsed = new Date(value);
  if (
    parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day || parsed.getUTCHours() !== hour ||
    parsed.getUTCMinutes() !== minute || parsed.getUTCSeconds() !== second
  ) return null;
  return value;
}

async function getLastOneXSystemFundedPurchase(queryable, username, onexUsername) {
  const [rows] = await queryable.query(
    `SELECT id,record_date,record_time
     FROM activities
     WHERE sender=? AND receiver=? AND type=2
     ORDER BY record_date DESC,record_time DESC,id DESC
     LIMIT 1 FOR UPDATE`,
    [onexUsername, username],
  );
  return rows.length ? rows[0] : null;
}

function assessOneXSystemFundingCooldown(lastSystemPurchase, nowMs = Date.now()) {
  if (!lastSystemPurchase) return { allowed: true, remainingMs: 0, lastPurchaseMs: null };
  const lastPurchaseMs = recordDateTimeToUtcMs(lastSystemPurchase.record_date, lastSystemPurchase.record_time);
  if (lastPurchaseMs === null || lastPurchaseMs > nowMs) {
    return { allowed: false, remainingMs: SYSTEM_FUNDED_PURCHASE_COOLDOWN_MS, lastPurchaseMs: null, invalidDate: true };
  }
  const remainingMs = Math.max(0, SYSTEM_FUNDED_PURCHASE_COOLDOWN_MS - (nowMs - lastPurchaseMs));
  return { allowed: remainingMs === 0, remainingMs, lastPurchaseMs };
}

function formatUtcRecordDateTime(timestampMs) {
  const date = new Date(timestampMs);
  if (!Number.isFinite(date.getTime())) throw new TypeError("Invalid UTC timestamp");
  const yyyy = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(date.getUTCDate()).padStart(2, "0");
  const hh = String(date.getUTCHours()).padStart(2, "0");
  const mi = String(date.getUTCMinutes()).padStart(2, "0");
  const ss = String(date.getUTCSeconds()).padStart(2, "0");
  return [Number(`${yyyy}${mm}${dd}`), `${hh}${mi}${ss}`];
}

function getSystemFundingCooldownReleaseAt(pendingSinceMs, lastPurchaseMs) {
  // The weekly rule measures time from the last OneX-funded purchase, never
  // from the amount received or from when a later seller-funded deposit queued.
  if (lastPurchaseMs != null) {
    const cooldownRelease = Number(lastPurchaseMs) + SYSTEM_FUNDED_PURCHASE_COOLDOWN_MS;
    if (!Number.isSafeInteger(cooldownRelease) || cooldownRelease <= 0) {
      throw new TypeError("Invalid last OneX-funded purchase timestamp");
    }
    return cooldownRelease;
  }
  const pendingRelease = Number(pendingSinceMs) + SYSTEM_FUNDED_PURCHASE_COOLDOWN_MS;
  if (!Number.isSafeInteger(pendingRelease) || pendingRelease <= 0) {
    throw new TypeError("Invalid pending timestamp");
  }
  return pendingRelease;
}

module.exports = {
  MAX_DEFAULT_STOCK,
  MIN_DEPOSIT_AMOUNT,
  MAX_DEPOSIT_AMOUNT,
  MAX_INITIAL_CREDIT_TRANCHE_AMOUNT,
  SYSTEM_ADMIN_RESERVE_RATIO,
  SYSTEM_FUNDED_PURCHASE_COOLDOWN_DAYS,
  SYSTEM_FUNDED_PURCHASE_COOLDOWN_MS,
  DEPOSIT_PENDING_EXPIRATION_DAYS,
  DEPOSIT_PENDING_EXPIRATION_MS,
  DISBURSEMENT_COOLDOWN_DAYS,
  DISBURSEMENT_COOLDOWN_MS,
  DISBURSEMENT_RESERVATION_MINUTES,
  DISBURSEMENT_RESERVATION_MS,
  getLastOneXSystemFundedPurchase,
  assessOneXSystemFundingCooldown,
  formatUtcRecordDateTime,
  getSystemFundingCooldownReleaseAt,
  validateDepositAmount,
  calculateMinimumDepositCapacity,
};
