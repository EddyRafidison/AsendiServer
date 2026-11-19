"use strict";

const BigNumber = require("bignumber.js");
const { calculateGlobalUnitPrice, calculateRechargeFundingAllocation } = require("./stock-accounting");

const MAX_DEFAULT_STOCK = "300";
// Automatic deposit sessions are fixed to the published 10–100 BSC-USD range.
const MIN_RECHARGE_AMOUNT = new BigNumber("10");
const MAX_RECHARGE_AMOUNT = new BigNumber("100");
const SYSTEM_ADMIN_RESERVE_RATIO = new BigNumber(
  process.env.SYSTEM_ADMIN_RESERVE_RATIO || "0.10",
);
const RECHARGE_COOLDOWN_DAYS = 7;
const RECHARGE_BATCH_WINDOW_MINUTES = 60;
const DEPOSIT_SWEEP_THRESHOLD = new BigNumber(process.env.USDT_SWEEP_THRESHOLD_BSC_USD || "100");
const DEPOSIT_SWEEP_MAX_AGE_DAYS = 30;
const DISBURSEMENT_COOLDOWN_DAYS = 30;
const DISBURSEMENT_RESERVATION_MINUTES = 60;

if (
  !MIN_RECHARGE_AMOUNT.isFinite() || !MIN_RECHARGE_AMOUNT.isGreaterThan(0) ||
  !MAX_RECHARGE_AMOUNT.isFinite() || MAX_RECHARGE_AMOUNT.lt(MIN_RECHARGE_AMOUNT) ||
  !DEPOSIT_SWEEP_THRESHOLD.isFinite() || !DEPOSIT_SWEEP_THRESHOLD.isGreaterThan(0)
) {
  throw new RangeError("Recharge and deposit-sweep limits must be finite positive values with maximum >= minimum");
}

const RECHARGE_COOLDOWN_MS = RECHARGE_COOLDOWN_DAYS * 24 * 60 * 60 * 1000;
const RECHARGE_BATCH_WINDOW_MS = RECHARGE_BATCH_WINDOW_MINUTES * 60 * 1000;
const DEPOSIT_SWEEP_MAX_AGE_MS = DEPOSIT_SWEEP_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
const DISBURSEMENT_COOLDOWN_MS = DISBURSEMENT_COOLDOWN_DAYS * 24 * 60 * 60 * 1000;
const DISBURSEMENT_RESERVATION_MS = DISBURSEMENT_RESERVATION_MINUTES * 60 * 1000;

function validateRechargeAmount(amountValue) {
  const amount = new BigNumber(amountValue);
  if (!amount.isFinite() || !amount.isGreaterThan(0)) {
    return { allowed: false, reason: "invalid_amount" };
  }
  if (amount.isLessThan(MIN_RECHARGE_AMOUNT)) {
    return { allowed: false, reason: "below_minimum" };
  }
  if (amount.isGreaterThan(MAX_RECHARGE_AMOUNT)) {
    return { allowed: false, reason: "above_maximum" };
  }
  return { allowed: true, reason: null, amount };
}


/**
 * Determine whether the account can accept one minimum automatic recharge
 * without exceeding its public XTU stock limit.
 *
 * The projected price uses a conservative assumption that the complete gross
 * tfees may be consumed by eligible BSC gas. This is the highest post-recharge
 * price produced by the current recharge accounting formula; actual retained
 * tfees can only lower that projected price. Reserve availability is evaluated
 * without pending payout reservations because this check is about the account
 * stock ceiling, while payout reservations are still enforced by applyUserTopUp.
 */
function calculateMinimumRechargeCapacity({
  currentBalanceInitialAsset,
  totalUnitsPrice,
  backedUnits,
  inactiveInitialAsset,
  availableSellerInitialAsset,
  protectedAdminInitialAsset,
  currentUnitPrice,
  tfeesRate,
  maximumUserXtu = MAX_DEFAULT_STOCK,
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
    throw new TypeError("Minimum-recharge capacity inputs must be finite");
  }
  if (
    currentBalance.isNegative() || total.isLessThanOrEqualTo(0) || backed.isLessThanOrEqualTo(0) ||
    inactive.isNegative() || sellers.isNegative() || protectedFloor.isNegative() ||
    price.isLessThanOrEqualTo(0) || feeRate.isNegative() || feeRate.isGreaterThanOrEqualTo(100) ||
    maximumXtu.isLessThanOrEqualTo(0)
  ) {
    throw new RangeError("Minimum-recharge capacity inputs are outside their valid ranges");
  }

  const calculatedPrice = calculateGlobalUnitPrice(total, backed);
  if (calculatedPrice.minus(price).abs().gt("0.000000000000000000000000000001")) {
    throw new RangeError("Current XTU price is inconsistent with common reserve values");
  }

  const feeAmount = MIN_RECHARGE_AMOUNT.multipliedBy(feeRate).dividedBy(100);
  const minimumNetAmount = MIN_RECHARGE_AMOUNT.minus(feeAmount);
  if (!minimumNetAmount.isGreaterThan(0)) {
    throw new RangeError("The minimum recharge is fully consumed by tfees");
  }
  const requiredInitialAsset = minimumNetAmount.dividedBy(price);
  const allocation = calculateRechargeFundingAllocation(
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
    // This models the highest price possible under the current fee policy:
    // all tfees are consumed by BSC gas, so no fee value is added to reserves.
    const projectedTotal = total.plus(allocation.systemInitialAsset.multipliedBy(price));
    const projectedBacked = backed.minus(allocation.consumedBacked);
    if (!projectedBacked.isGreaterThan(0)) {
      throw new RangeError("The minimum recharge would exhaust common.backed_units");
    }
    projectedPrice = calculateGlobalUnitPrice(projectedTotal, projectedBacked);
    projectionMethod = "conservative_post_recharge_price";
  }

  const projectedBalanceXtu = currentBalance.plus(requiredInitialAsset).multipliedBy(projectedPrice);
  return {
    allowed: projectedBalanceXtu.isLessThanOrEqualTo(maximumXtu),
    minimumGrossAmount: new BigNumber(MIN_RECHARGE_AMOUNT),
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

async function getLastOnexRecharge(queryable, username, onexUsername) {
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

function assessRechargeCooldown(lastRecharge, nowMs = Date.now()) {
  if (!lastRecharge) return { allowed: true, remainingMs: 0, lastRechargeMs: null };
  const lastRechargeMs = recordDateTimeToUtcMs(lastRecharge.record_date, lastRecharge.record_time);
  if (lastRechargeMs === null || lastRechargeMs > nowMs) {
    return { allowed: false, remainingMs: RECHARGE_COOLDOWN_MS, lastRechargeMs: null, invalidDate: true };
  }
  const remainingMs = Math.max(0, RECHARGE_COOLDOWN_MS - (nowMs - lastRechargeMs));
  return { allowed: remainingMs === 0, remainingMs, lastRechargeMs };
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

function getWeeklyReleaseAt(pendingSinceMs, lastRechargeMs) {
  const pendingRelease = Number(pendingSinceMs) + RECHARGE_COOLDOWN_MS;
  const rechargeRelease = lastRechargeMs == null ? 0 : Number(lastRechargeMs) + RECHARGE_COOLDOWN_MS;
  if (!Number.isSafeInteger(pendingRelease) || pendingRelease <= 0) throw new TypeError("Invalid pending timestamp");
  return Math.max(pendingRelease, rechargeRelease);
}

module.exports = {
  MAX_DEFAULT_STOCK,
  MIN_RECHARGE_AMOUNT,
  MAX_RECHARGE_AMOUNT,
  SYSTEM_ADMIN_RESERVE_RATIO,
  RECHARGE_COOLDOWN_DAYS,
  RECHARGE_COOLDOWN_MS,
  RECHARGE_BATCH_WINDOW_MINUTES,
  RECHARGE_BATCH_WINDOW_MS,
  DEPOSIT_SWEEP_THRESHOLD,
  DEPOSIT_SWEEP_MAX_AGE_DAYS,
  DEPOSIT_SWEEP_MAX_AGE_MS,
  DISBURSEMENT_COOLDOWN_DAYS,
  DISBURSEMENT_COOLDOWN_MS,
  DISBURSEMENT_RESERVATION_MINUTES,
  DISBURSEMENT_RESERVATION_MS,
  getLastOnexRecharge,
  assessRechargeCooldown,
  formatUtcRecordDateTime,
  getWeeklyReleaseAt,
  validateRechargeAmount,
  calculateMinimumRechargeCapacity,
};
