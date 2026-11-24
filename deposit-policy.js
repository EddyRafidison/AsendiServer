"use strict";

const BigNumber = require("bignumber.js");
const { calculateGlobalUnitPrice, calculateDepositFundingAllocation } = require("./stock-accounting");

const MAX_DEFAULT_STOCK = "300";
// The minimum and maximum govern the accepted intake per user per rolling 7-day period.
// The first-credit tranche is tracked separately by the batch-crediting worker.
const MIN_DEPOSIT_AMOUNT = new BigNumber("70");
const MAX_DEPOSIT_AMOUNT = new BigNumber("140");
// Keep the first automatically credited tranche distinct from the rolling seven-day intake ceiling.
const MAX_INITIAL_CREDIT_TRANCHE_AMOUNT = new BigNumber(
  process.env.MAX_DEPOSIT_INITIAL_CREDIT_BSC_USD || "100",
);
const SYSTEM_ADMIN_RESERVE_RATIO = new BigNumber(
  process.env.SYSTEM_ADMIN_RESERVE_RATIO || "0.10",
);
const DEPOSIT_COOLDOWN_DAYS = 7;
const DEPOSIT_BATCH_WINDOW_MINUTES = 60;
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

const DEPOSIT_COOLDOWN_MS = DEPOSIT_COOLDOWN_DAYS * 24 * 60 * 60 * 1000;
const DEPOSIT_BATCH_WINDOW_MS = DEPOSIT_BATCH_WINDOW_MINUTES * 60 * 1000;
const DISBURSEMENT_COOLDOWN_MS = DISBURSEMENT_COOLDOWN_DAYS * 24 * 60 * 60 * 1000;
const DISBURSEMENT_RESERVATION_MS = DISBURSEMENT_RESERVATION_MINUTES * 60 * 1000;

function classifyRollingDepositReceipt(rollingSevenDayGross) {
  const gross = new BigNumber(rollingSevenDayGross);
  if (!gross.isFinite() || gross.isNegative()) {
    throw new RangeError("Rolling seven-day deposit gross must be finite and non-negative");
  }
  return {
    allowed: gross.lte(MAX_DEPOSIT_AMOUNT),
    status: gross.lte(MAX_DEPOSIT_AMOUNT) ? "eligible" : "pending_weekly",
    rollingSevenDayGross: gross,
    maximumSevenDayGross: new BigNumber(MAX_DEPOSIT_AMOUNT),
    remainingCapacity: BigNumber.maximum(0, MAX_DEPOSIT_AMOUNT.minus(gross)),
  };
}

function validateDepositAmount(amountValue) {
  const amount = new BigNumber(amountValue);
  if (!amount.isFinite() || !amount.isGreaterThan(0)) {
    return { allowed: false, reason: "invalid_amount" };
  }
  if (amount.isLessThan(MIN_DEPOSIT_AMOUNT)) {
    return { allowed: false, reason: "below_minimum" };
  }
  return {
    allowed: true,
    reason: null,
    amount,
    initialCreditLimit: MAX_INITIAL_CREDIT_TRANCHE_AMOUNT,
    exceedsInitialCreditLimit: amount.isGreaterThan(MAX_INITIAL_CREDIT_TRANCHE_AMOUNT),
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

async function getLastOnexDeposit(queryable, username, onexUsername) {
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

function assessDepositCooldown(lastDeposit, nowMs = Date.now()) {
  if (!lastDeposit) return { allowed: true, remainingMs: 0, lastDepositMs: null };
  const lastDepositMs = recordDateTimeToUtcMs(lastDeposit.record_date, lastDeposit.record_time);
  if (lastDepositMs === null || lastDepositMs > nowMs) {
    return { allowed: false, remainingMs: DEPOSIT_COOLDOWN_MS, lastDepositMs: null, invalidDate: true };
  }
  const remainingMs = Math.max(0, DEPOSIT_COOLDOWN_MS - (nowMs - lastDepositMs));
  return { allowed: remainingMs === 0, remainingMs, lastDepositMs };
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

function getWeeklyReleaseAt(pendingSinceMs, lastDepositMs) {
  const pendingRelease = Number(pendingSinceMs) + DEPOSIT_COOLDOWN_MS;
  const depositRelease = lastDepositMs == null ? 0 : Number(lastDepositMs) + DEPOSIT_COOLDOWN_MS;
  if (!Number.isSafeInteger(pendingRelease) || pendingRelease <= 0) throw new TypeError("Invalid pending timestamp");
  return Math.max(pendingRelease, depositRelease);
}

module.exports = {
  MAX_DEFAULT_STOCK,
  MIN_DEPOSIT_AMOUNT,
  MAX_DEPOSIT_AMOUNT,
  MAX_INITIAL_CREDIT_TRANCHE_AMOUNT,
  SYSTEM_ADMIN_RESERVE_RATIO,
  DEPOSIT_COOLDOWN_DAYS,
  DEPOSIT_COOLDOWN_MS,
  DEPOSIT_BATCH_WINDOW_MINUTES,
  DEPOSIT_BATCH_WINDOW_MS,
  DISBURSEMENT_COOLDOWN_DAYS,
  DISBURSEMENT_COOLDOWN_MS,
  DISBURSEMENT_RESERVATION_MINUTES,
  DISBURSEMENT_RESERVATION_MS,
  getLastOnexDeposit,
  assessDepositCooldown,
  formatUtcRecordDateTime,
  getWeeklyReleaseAt,
  validateDepositAmount,
  classifyRollingDepositReceipt,
  calculateMinimumDepositCapacity,
};
