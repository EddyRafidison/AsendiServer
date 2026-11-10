"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  TEMP_PASSWORD_DIGITS,
  TEMP_PASSWORD_TTL_MS,
  MAX_CONSECUTIVE_FAILED_AUTH,
  generateTemporaryPassword,
  isTemporaryPasswordActive,
  isPasswordProtectedActivityLocked,
  nextFailedAuthCount,
  evaluatePasswordAuthentication,
} = require("../auth-recovery");

test("temporary recovery password is always seven numeric digits", () => {
  assert.equal(TEMP_PASSWORD_DIGITS, 7);
  for (let index = 0; index < 500; index += 1) {
    const password = generateTemporaryPassword();
    assert.match(password, /^\d{7}$/);
  }
});

test("temporary password validity is limited to ten minutes", () => {
  assert.equal(TEMP_PASSWORD_TTL_MS, 600_000);
  const now = 1_800_000_000_000;
  assert.equal(isTemporaryPasswordActive(null, now), false);
  assert.equal(isTemporaryPasswordActive(String(now + 1), now), true);
  assert.equal(isTemporaryPasswordActive(String(now), now), false);
  assert.equal(isTemporaryPasswordActive(String(now - 1), now), false);
  assert.equal(isTemporaryPasswordActive("invalid", now), false);
});

test("failed-authentication counter stops at three", () => {
  assert.equal(MAX_CONSECUTIVE_FAILED_AUTH, 3);
  assert.equal(nextFailedAuthCount(0), 1);
  assert.equal(nextFailedAuthCount(1), 2);
  assert.equal(nextFailedAuthCount(2), 3);
  assert.equal(nextFailedAuthCount(3), 3);
  assert.throws(() => nextFailedAuthCount(-1), /non-negative integer/);
});


test("three failed password attempts block normal sign-in until recovery completes", () => {
  const now = 1_800_000_000_000;
  const lockedNormalPassword = evaluatePasswordAuthentication({
    failedCount: 3,
    temporaryPasswordExpiresAtMs: null,
    passwordMatches: true,
    nowMs: now,
  });
  assert.equal(lockedNormalPassword.allowed, false);
  assert.equal(lockedNormalPassword.recoveryRequired, true);
  assert.equal(lockedNormalPassword.incrementFailureCount, false);

  const validRecoveryPassword = evaluatePasswordAuthentication({
    failedCount: 3,
    temporaryPasswordExpiresAtMs: String(now + TEMP_PASSWORD_TTL_MS),
    passwordMatches: true,
    nowMs: now,
  });
  assert.equal(validRecoveryPassword.allowed, true);
  assert.equal(validRecoveryPassword.passwordChangeRequired, true);
  assert.equal(validRecoveryPassword.resetFailedAuthCount, true);

  const expiredRecoveryPassword = evaluatePasswordAuthentication({
    failedCount: 3,
    temporaryPasswordExpiresAtMs: String(now - 1),
    passwordMatches: true,
    nowMs: now,
  });
  assert.equal(expiredRecoveryPassword.allowed, false);
  assert.equal(expiredRecoveryPassword.recoveryRequired, true);
});

test("temporary-password sign-in resets the counter but keeps activities locked until password replacement", () => {
  const now = 1_800_000_000_000;
  const decision = evaluatePasswordAuthentication({
    failedCount: 3,
    temporaryPasswordExpiresAtMs: String(now + TEMP_PASSWORD_TTL_MS),
    passwordMatches: true,
    nowMs: now,
  });
  assert.equal(decision.allowed, true);
  assert.equal(decision.resetFailedAuthCount, true);
  assert.equal(decision.passwordChangeRequired, true);

  // This models the database state immediately after a successful temporary-password sign-in.
  assert.equal(isPasswordProtectedActivityLocked({
    failedCount: 0,
    temporaryPasswordExpiresAtMs: String(now + TEMP_PASSWORD_TTL_MS),
  }), true);
});

test("successful ordinary sign-in never resets the recovery counter", () => {
  const decision = evaluatePasswordAuthentication({
    failedCount: 2,
    temporaryPasswordExpiresAtMs: null,
    passwordMatches: true,
    nowMs: 1_800_000_000_000,
  });
  assert.equal(decision.allowed, true);
  assert.equal(decision.incrementFailureCount, false);
  assert.equal(decision.passwordChangeRequired, false);
  assert.equal(decision.resetFailedAuthCount, false);
});

test("password-protected activities stay blocked until the temporary password is replaced", () => {
  assert.equal(isPasswordProtectedActivityLocked({
    failedCount: 3,
    temporaryPasswordExpiresAtMs: null,
  }), true);
  assert.equal(isPasswordProtectedActivityLocked({
    failedCount: 0,
    temporaryPasswordExpiresAtMs: String(Date.now() + 600_000),
  }), true);
  assert.equal(isPasswordProtectedActivityLocked({
    failedCount: 0,
    temporaryPasswordExpiresAtMs: String(Date.now() - 1),
  }), true);
  assert.equal(isPasswordProtectedActivityLocked({
    failedCount: 0,
    temporaryPasswordExpiresAtMs: null,
  }), false);
});
