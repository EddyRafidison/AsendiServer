"use strict";

const BigNumber = require("bignumber.js");

const DAY_MS = 24 * 60 * 60 * 1000;
const GLOBAL_DISBURSEMENT_NOTICE_MS = 7 * DAY_MS;
const MAX_GLOBAL_DISBURSEMENT_BONUS_PERCENT = new BigNumber(10);
const MIN_GLOBAL_DISBURSEMENT_REQUEST_WINDOW_DAYS = 90;
const DEFAULT_GLOBAL_DISBURSEMENT_REQUEST_WINDOW_DAYS = 90;
const MAX_GLOBAL_DISBURSEMENT_REQUEST_WINDOW_DAYS = 365;
const MIN_GLOBAL_DISBURSEMENT_EXTENSION_DAYS = 30;
const DEFAULT_GLOBAL_DISBURSEMENT_EXTENSION_DAYS = 30;
const MAX_GLOBAL_DISBURSEMENT_EXTENSION_DAYS = 365;
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

function resolveGlobalDisbursementPhase(status, primaryDeadlineAtMs, extensionDeadlineAtMs, nowMs = Date.now()) {
  if (!GLOBAL_REQUEST_OPEN_STATUSES.has(String(status || "").toLowerCase())) return "closed";
  const primaryDeadline = Number(primaryDeadlineAtMs);
  const extensionDeadline = Number(extensionDeadlineAtMs || primaryDeadlineAtMs);
  if (
    !Number.isSafeInteger(primaryDeadline) || primaryDeadline <= 0 ||
    !Number.isSafeInteger(extensionDeadline) || extensionDeadline < primaryDeadline ||
    !Number.isSafeInteger(Number(nowMs)) || Number(nowMs) < 0
  ) return "closed";
  if (Number(nowMs) < primaryDeadline) return "primary";
  if (Number(nowMs) < extensionDeadline) return "extension";
  return "closed";
}

function isGlobalDisbursementRequestOpen(status, primaryDeadlineAtMs, nowMs = Date.now(), extensionDeadlineAtMs = primaryDeadlineAtMs) {
  return resolveGlobalDisbursementPhase(
    status,
    primaryDeadlineAtMs,
    extensionDeadlineAtMs,
    nowMs,
  ) !== "closed";
}

function isGlobalDisbursementPrimaryWindowOpen(status, primaryDeadlineAtMs, nowMs = Date.now()) {
  return resolveGlobalDisbursementPhase(status, primaryDeadlineAtMs, primaryDeadlineAtMs, nowMs) === "primary";
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

function resolveGlobalDisbursementRequestWindowDays(value) {
  const raw = value == null || String(value).trim() === ""
    ? DEFAULT_GLOBAL_DISBURSEMENT_REQUEST_WINDOW_DAYS
    : Number(value);
  if (
    !Number.isInteger(raw) ||
    raw < MIN_GLOBAL_DISBURSEMENT_REQUEST_WINDOW_DAYS ||
    raw > MAX_GLOBAL_DISBURSEMENT_REQUEST_WINDOW_DAYS
  ) {
    throw new RangeError(
      `GLOBAL_DISBURSEMENT_REQUEST_WINDOW_DAYS must be an integer between ${MIN_GLOBAL_DISBURSEMENT_REQUEST_WINDOW_DAYS} and ${MAX_GLOBAL_DISBURSEMENT_REQUEST_WINDOW_DAYS}; it cannot be reduced below ${MIN_GLOBAL_DISBURSEMENT_REQUEST_WINDOW_DAYS} days`,
    );
  }
  return raw;
}

function resolveGlobalDisbursementExtensionDays(value) {
  const raw = value == null || String(value).trim() === ""
    ? DEFAULT_GLOBAL_DISBURSEMENT_EXTENSION_DAYS
    : Number(value);
  if (
    !Number.isInteger(raw) ||
    raw < MIN_GLOBAL_DISBURSEMENT_EXTENSION_DAYS ||
    raw > MAX_GLOBAL_DISBURSEMENT_EXTENSION_DAYS
  ) {
    throw new RangeError(
      `GLOBAL_DISBURSEMENT_EXTENSION_DAYS must be an integer between ${MIN_GLOBAL_DISBURSEMENT_EXTENSION_DAYS} and ${MAX_GLOBAL_DISBURSEMENT_EXTENSION_DAYS}`,
    );
  }
  return raw;
}

function validateGlobalAnnouncement({ announcedAtMs, activationAtMs, requestWindowDays, extensionDays = DEFAULT_GLOBAL_DISBURSEMENT_EXTENSION_DAYS }) {
  const announced = Number(announcedAtMs);
  const activation = Number(activationAtMs);
  const days = Number(requestWindowDays);
  const extension = Number(extensionDays);
  if (!Number.isSafeInteger(announced) || announced <= 0) {
    throw new RangeError("The global announcement timestamp is invalid");
  }
  if (!Number.isSafeInteger(activation) || activation < announced + GLOBAL_DISBURSEMENT_NOTICE_MS) {
    throw new RangeError("Global activation must be scheduled at least seven full days after announcement");
  }
  if (
    !Number.isInteger(days) ||
    days < MIN_GLOBAL_DISBURSEMENT_REQUEST_WINDOW_DAYS ||
    days > MAX_GLOBAL_DISBURSEMENT_REQUEST_WINDOW_DAYS
  ) {
    throw new RangeError(`Global primary request window must be between ${MIN_GLOBAL_DISBURSEMENT_REQUEST_WINDOW_DAYS} and ${MAX_GLOBAL_DISBURSEMENT_REQUEST_WINDOW_DAYS} days`);
  }
  if (
    !Number.isInteger(extension) ||
    extension < MIN_GLOBAL_DISBURSEMENT_EXTENSION_DAYS ||
    extension > MAX_GLOBAL_DISBURSEMENT_EXTENSION_DAYS
  ) {
    throw new RangeError(`Global extension must be between ${MIN_GLOBAL_DISBURSEMENT_EXTENSION_DAYS} and ${MAX_GLOBAL_DISBURSEMENT_EXTENSION_DAYS} days`);
  }
  return {
    announcedAtMs: announced,
    activationAtMs: activation,
    requestWindowDays: days,
    extensionDays: extension,
  };
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
  DAY_MS,
  GLOBAL_DISBURSEMENT_NOTICE_MS,
  MAX_GLOBAL_DISBURSEMENT_BONUS_PERCENT,
  MIN_GLOBAL_DISBURSEMENT_REQUEST_WINDOW_DAYS,
  DEFAULT_GLOBAL_DISBURSEMENT_REQUEST_WINDOW_DAYS,
  MAX_GLOBAL_DISBURSEMENT_REQUEST_WINDOW_DAYS,
  MIN_GLOBAL_DISBURSEMENT_EXTENSION_DAYS,
  DEFAULT_GLOBAL_DISBURSEMENT_EXTENSION_DAYS,
  MAX_GLOBAL_DISBURSEMENT_EXTENSION_DAYS,
  resolveGlobalDisbursementBonus,
  calculateGlobalBonus,
  calculateRequiredAdminBonusReserve,
  isGlobalDisbursementEffective,
  resolveGlobalDisbursementPhase,
  isGlobalDisbursementRequestOpen,
  isGlobalDisbursementPrimaryWindowOpen,
  isGlobalDisbursementPriceFrozen,
  resolveDisbursementMinimumXtu,
  evaluateDisbursementMinimumXtu,
  resolveGlobalDisbursementRequestWindowDays,
  resolveGlobalDisbursementExtensionDays,
  validateGlobalAnnouncement,
  getGlobalRequestDeadline,
};
