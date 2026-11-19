"use strict";

const BigNumber = require("bignumber.js");

const GLOBAL_DISBURSEMENT_NOTICE_MS = 7 * 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_GLOBAL_DISBURSEMENT_BONUS_PERCENT = new BigNumber(10);
const GLOBAL_EFFECTIVE_STATUSES = new Set(["active", "closed", "manual_review", "completed", "resolved"]);
const GLOBAL_REQUEST_OPEN_STATUSES = new Set(["active"]);
const GLOBAL_PRICE_FROZEN_STATUSES = new Set(["active", "closed", "manual_review", "completed", "resolved"]);

function resolveGlobalDisbursementBonus(feeRateValue, configuredBonusValue) {
  const feeRate = new BigNumber(feeRateValue ?? 0);
  if (!feeRate.isFinite() || feeRate.isNegative() || !feeRate.isLessThan(100)) {
    throw new RangeError("FEES must be finite, non-negative and below 100");
  }

  const hasExplicitValue = configuredBonusValue != null && String(configuredBonusValue).trim() !== "";
  const raw = hasExplicitValue
    ? new BigNumber(String(configuredBonusValue).trim())
    : BigNumber.minimum(feeRate, MAX_GLOBAL_DISBURSEMENT_BONUS_PERCENT);

  if (
    !raw.isFinite() || raw.isNegative() ||
    raw.isGreaterThan(MAX_GLOBAL_DISBURSEMENT_BONUS_PERCENT)
  ) {
    throw new RangeError("GLOBAL_DISBURSEMENT_BONUS must be between 0 and 10 percent");
  }
  return raw;
}

function calculateGlobalBonus(netRequestedXtuValue, bonusRateValue) {
  const netRequestedXtu = new BigNumber(netRequestedXtuValue);
  const bonusRate = new BigNumber(bonusRateValue);
  if (!netRequestedXtu.isFinite() || !netRequestedXtu.isGreaterThan(0)) {
    throw new RangeError("Global reimbursement net amount must be positive");
  }
  if (
    !bonusRate.isFinite() || bonusRate.isNegative() ||
    bonusRate.isGreaterThan(MAX_GLOBAL_DISBURSEMENT_BONUS_PERCENT)
  ) {
    throw new RangeError("Global disbursement bonus must be between 0 and 10 percent");
  }
  return netRequestedXtu.multipliedBy(bonusRate).dividedBy(100);
}

function calculateRequiredAdminBonusReserve(totalInitialAssetValue, bonusRateValue) {
  const totalInitialAsset = new BigNumber(totalInitialAssetValue);
  const bonusRate = new BigNumber(bonusRateValue);
  if (!totalInitialAsset.isFinite() || totalInitialAsset.isNegative()) {
    throw new RangeError("Global reimbursement balance must be finite and non-negative");
  }
  if (
    !bonusRate.isFinite() || bonusRate.isNegative() ||
    bonusRate.isGreaterThan(MAX_GLOBAL_DISBURSEMENT_BONUS_PERCENT)
  ) {
    throw new RangeError("Global disbursement bonus must be between 0 and 10 percent");
  }
  return totalInitialAsset.multipliedBy(bonusRate).dividedBy(100);
}

function isGlobalDisbursementEffective(status) {
  return GLOBAL_EFFECTIVE_STATUSES.has(String(status || "").toLowerCase());
}

function isGlobalDisbursementRequestOpen(status, deadlineAtMs, nowMs = Date.now()) {
  if (!GLOBAL_REQUEST_OPEN_STATUSES.has(String(status || "").toLowerCase())) return false;
  const deadline = Number(deadlineAtMs);
  return Number.isSafeInteger(deadline) && deadline > 0 && nowMs < deadline;
}

function isGlobalDisbursementPriceFrozen(status) {
  return GLOBAL_PRICE_FROZEN_STATUSES.has(String(status || "").toLowerCase());
}

function resolveDisbursementMinimumXtu(globalRequestOpen, configuredIndividualMinimum = "200") {
  if (globalRequestOpen) return new BigNumber(1);
  const minimum = new BigNumber(configuredIndividualMinimum);
  if (!minimum.isFinite() || !minimum.isGreaterThan(0)) {
    throw new RangeError("DISBURSEMENT_INDIVIDUAL_MINIMUM_XTU must be finite and positive");
  }
  return minimum;
}

function evaluateDisbursementMinimumXtu(
  requestedAmountValue,
  globalRequestOpen,
  configuredIndividualMinimum = "200",
) {
  const requestedAmount = new BigNumber(requestedAmountValue);
  if (!requestedAmount.isFinite() || !requestedAmount.isGreaterThan(0)) {
    throw new RangeError("The requested disbursement amount must be finite and positive");
  }
  const minimumAmount = resolveDisbursementMinimumXtu(
    globalRequestOpen,
    configuredIndividualMinimum,
  );
  return {
    allowed: requestedAmount.isGreaterThanOrEqualTo(minimumAmount),
    requestedAmount,
    minimumAmount,
    mode: globalRequestOpen ? "global" : "individual",
  };
}

function validateGlobalAnnouncement({ announcedAtMs, activationAtMs, requestWindowDays }) {
  const announced = Number(announcedAtMs);
  const activation = Number(activationAtMs);
  const days = Number(requestWindowDays);
  if (!Number.isSafeInteger(announced) || announced <= 0) {
    throw new RangeError("The global announcement timestamp is invalid");
  }
  if (!Number.isSafeInteger(activation) || activation < announced + GLOBAL_DISBURSEMENT_NOTICE_MS) {
    throw new RangeError("Global activation must be scheduled at least seven full days after announcement");
  }
  if (!Number.isInteger(days) || days < 1 || days > 365) {
    throw new RangeError("Global request window must be between 1 and 365 days");
  }
  return { announcedAtMs: announced, activationAtMs: activation, requestWindowDays: days };
}

function getGlobalRequestDeadline(activatedAtMs, requestWindowDays) {
  const activated = Number(activatedAtMs);
  const days = Number(requestWindowDays);
  if (!Number.isSafeInteger(activated) || activated <= 0 || !Number.isInteger(days) || days < 1 || days > 365) {
    throw new RangeError("Invalid global activation time or request window");
  }
  const deadline = activated + days * DAY_MS;
  if (!Number.isSafeInteger(deadline)) throw new RangeError("Global request deadline exceeds the supported timestamp range");
  return deadline;
}

module.exports = {
  GLOBAL_DISBURSEMENT_NOTICE_MS,
  MAX_GLOBAL_DISBURSEMENT_BONUS_PERCENT,
  resolveGlobalDisbursementBonus,
  calculateGlobalBonus,
  calculateRequiredAdminBonusReserve,
  isGlobalDisbursementEffective,
  isGlobalDisbursementRequestOpen,
  isGlobalDisbursementPriceFrozen,
  resolveDisbursementMinimumXtu,
  evaluateDisbursementMinimumXtu,
  validateGlobalAnnouncement,
  getGlobalRequestDeadline,
};
