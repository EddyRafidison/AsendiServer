"use strict";

const crypto = require("crypto");

const TEMP_PASSWORD_DIGITS = 7;
const TEMP_PASSWORD_TTL_MS = 10 * 60 * 1000;
const MAX_CONSECUTIVE_FAILED_AUTH = 3;

function generateTemporaryPassword() {
  const limit = 10 ** TEMP_PASSWORD_DIGITS;
  return String(crypto.randomInt(0, limit)).padStart(TEMP_PASSWORD_DIGITS, "0");
}

function isTemporaryPasswordActive(expiresAtMs, nowMs = Date.now()) {
  if (expiresAtMs === null || expiresAtMs === undefined) return false;
  const expiry = Number(expiresAtMs);
  return Number.isSafeInteger(expiry) && expiry > nowMs;
}

function isPasswordProtectedActivityLocked({ failedCount, temporaryPasswordExpiresAtMs }) {
  const count = Number(failedCount);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new TypeError("Failed-authentication counter must be a non-negative integer.");
  }
  return count >= MAX_CONSECUTIVE_FAILED_AUTH ||
    (temporaryPasswordExpiresAtMs !== null && temporaryPasswordExpiresAtMs !== undefined);
}

function nextFailedAuthCount(currentCount) {
  const count = Number(currentCount);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new TypeError("Failed-authentication counter must be a non-negative integer.");
  }
  return Math.min(count + 1, MAX_CONSECUTIVE_FAILED_AUTH);
}

function evaluatePasswordAuthentication({
  failedCount,
  temporaryPasswordExpiresAtMs,
  passwordMatches,
  nowMs = Date.now(),
}) {
  const count = Number(failedCount);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new TypeError("Failed-authentication counter must be a non-negative integer.");
  }

  const hasTemporaryPassword = temporaryPasswordExpiresAtMs !== null &&
    temporaryPasswordExpiresAtMs !== undefined;
  const temporaryPasswordActive = hasTemporaryPassword &&
    isTemporaryPasswordActive(temporaryPasswordExpiresAtMs, nowMs);
  const validPassword = passwordMatches === true &&
    (!hasTemporaryPassword || temporaryPasswordActive);

  if (count >= MAX_CONSECUTIVE_FAILED_AUTH) {
    const recoveryLoginAllowed = hasTemporaryPassword && temporaryPasswordActive && validPassword;
    return {
      allowed: recoveryLoginAllowed,
      incrementFailureCount: false,
      recoveryRequired: !recoveryLoginAllowed,
      passwordChangeRequired: recoveryLoginAllowed,
      resetFailedAuthCount: recoveryLoginAllowed,
    };
  }

  if (!validPassword) {
    return {
      allowed: false,
      incrementFailureCount: true,
      recoveryRequired: false,
      passwordChangeRequired: false,
      resetFailedAuthCount: false,
    };
  }

  return {
    allowed: true,
    incrementFailureCount: false,
    recoveryRequired: false,
    passwordChangeRequired: hasTemporaryPassword,
    resetFailedAuthCount: hasTemporaryPassword,
  };
}

module.exports = {
  TEMP_PASSWORD_DIGITS,
  TEMP_PASSWORD_TTL_MS,
  MAX_CONSECUTIVE_FAILED_AUTH,
  generateTemporaryPassword,
  isTemporaryPasswordActive,
  isPasswordProtectedActivityLocked,
  nextFailedAuthCount,
  evaluatePasswordAuthentication,
};
