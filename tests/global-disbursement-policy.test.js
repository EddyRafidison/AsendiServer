"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  GLOBAL_DISBURSEMENT_NOTICE_MS,
  resolveGlobalDisbursementBonus,
  calculateGlobalBonus,
  calculateRequiredAdminBonusReserve,
  isGlobalDisbursementEffective,
  isGlobalDisbursementRequestOpen,
  resolveGlobalDisbursementPhase,
  resolveGlobalDisbursementRequestWindowDays,
  resolveGlobalDisbursementExtensionDays,
  resolveDisbursementMinimumXtu,
  evaluateDisbursementMinimumXtu,
  isGlobalDisbursementPriceFrozen,
  validateGlobalAnnouncement,
  getGlobalRequestDeadline,
} = require("../global-disbursement-policy");

test("global bonus defaults to FEES and cannot exceed 10 percent", () => {
  assert.equal(resolveGlobalDisbursementBonus("3", undefined).toFixed(), "3");
  assert.equal(resolveGlobalDisbursementBonus("15", "").toFixed(), "10");
  assert.throws(() => resolveGlobalDisbursementBonus("3", "10.0001"), /between 0 and 10/);
});

test("global bonus is calculated on the net XTU amount requested by the user", () => {
  assert.equal(calculateGlobalBonus("200", "3").toFixed(), "6");
  assert.equal(calculateRequiredAdminBonusReserve("200", "3").toFixed(), "6");
  assert.equal(calculateRequiredAdminBonusReserve("18000000", "3").toFixed(), "540000");
  assert.equal(calculateRequiredAdminBonusReserve("18000000", "10").toFixed(), "1800000");
  assert.throws(() => calculateGlobalBonus("0", "3"), /positive/);
});

test("the announcement period does not activate global mode or freeze the price", () => {
  assert.equal(isGlobalDisbursementEffective("announced"), false);
  assert.equal(isGlobalDisbursementPriceFrozen("announced"), false);
  assert.equal(isGlobalDisbursementRequestOpen("announced", Date.now() + 86400000), false);
});

test("only active status opens the user request window and freezes the global price", () => {
  const now = Date.now();
  const deadline = now + 86400000;
  assert.equal(isGlobalDisbursementEffective("active"), true);
  assert.equal(isGlobalDisbursementPriceFrozen("active"), true);
  assert.equal(isGlobalDisbursementRequestOpen("active", deadline, now), true);
  assert.equal(isGlobalDisbursementRequestOpen("active", now, now), false);
  assert.equal(isGlobalDisbursementRequestOpen("active", now - 1, now), false);
  assert.equal(isGlobalDisbursementRequestOpen("closed", deadline, now), false);
  assert.equal(isGlobalDisbursementRequestOpen("manual_review", deadline, now), false);
});

test("the global cutoff remains effective after closure and while administrative reviews are unresolved", () => {
  for (const status of ["closed", "manual_review", "completed", "resolved"]) {
    assert.equal(isGlobalDisbursementEffective(status), true, status);
    assert.equal(isGlobalDisbursementPriceFrozen(status), true, status);
    assert.equal(isGlobalDisbursementRequestOpen(status, Date.now() + 86400000), false, status);
  }
  for (const status of ["queued", "staging", "settling", "unknown"]) {
    assert.equal(isGlobalDisbursementEffective(status), false, status);
    assert.equal(isGlobalDisbursementRequestOpen(status, Date.now() + 86400000), false, status);
  }
});

test("individual minimum is 200 XTU and global minimum is 1 XTU only while requests are open", () => {
  assert.equal(resolveDisbursementMinimumXtu(false).toFixed(), "200");
  assert.equal(resolveDisbursementMinimumXtu(true).toFixed(), "1");
  assert.equal(resolveDisbursementMinimumXtu(false, "250").toFixed(), "250");
  assert.equal(evaluateDisbursementMinimumXtu("199.999999999999999999", false).allowed, false);
  assert.equal(evaluateDisbursementMinimumXtu("200", false).allowed, true);
  assert.equal(evaluateDisbursementMinimumXtu("0.999999999999999999", true).allowed, false);
  assert.equal(evaluateDisbursementMinimumXtu("1", true).allowed, true);
  assert.equal(evaluateDisbursementMinimumXtu("1.5", false).minimumAmount.toFixed(), "200");
  assert.throws(() => resolveDisbursementMinimumXtu(false, "0"), /must be finite and positive/);
  assert.throws(() => evaluateDisbursementMinimumXtu("NaN", false), /must be finite and positive/);
});

test("global announcement requires seven full days and a 90-day minimum primary window", () => {
  const announcedAtMs = Date.UTC(2026, 10, 19, 10, 0, 0);
  const activationAtMs = announcedAtMs + GLOBAL_DISBURSEMENT_NOTICE_MS;
  assert.throws(() => validateGlobalAnnouncement({
    announcedAtMs, activationAtMs: activationAtMs - 1, requestWindowDays: 90,
  }), /seven full days/);
  assert.equal(resolveGlobalDisbursementRequestWindowDays(undefined), 90);
  assert.equal(resolveGlobalDisbursementRequestWindowDays("120"), 120);
  assert.throws(() => resolveGlobalDisbursementRequestWindowDays("89"), /cannot be reduced below 90 days/);
  assert.throws(() => resolveGlobalDisbursementRequestWindowDays("366"), /between 90 and 365/);
  assert.equal(resolveGlobalDisbursementExtensionDays(undefined), 30);
  assert.equal(resolveGlobalDisbursementExtensionDays("45"), 45);
  assert.throws(() => resolveGlobalDisbursementExtensionDays("29"), /between 30 and 365/);

  const valid = validateGlobalAnnouncement({
    announcedAtMs, activationAtMs, requestWindowDays: 90, extensionDays: 30,
  });
  assert.equal(valid.activationAtMs, activationAtMs);
  const primaryDeadline = getGlobalRequestDeadline(valid.activationAtMs, valid.requestWindowDays);
  const extensionDeadline = getGlobalRequestDeadline(primaryDeadline, valid.extensionDays);
  assert.equal(primaryDeadline, activationAtMs + 90 * 86400000);
  assert.equal(extensionDeadline, primaryDeadline + 30 * 86400000);
  assert.equal(resolveGlobalDisbursementPhase("active", primaryDeadline, extensionDeadline, primaryDeadline - 1), "primary");
  assert.equal(resolveGlobalDisbursementPhase("active", primaryDeadline, extensionDeadline, primaryDeadline), "extension");
  assert.equal(resolveGlobalDisbursementPhase("active", primaryDeadline, extensionDeadline, extensionDeadline - 1), "extension");
  assert.equal(resolveGlobalDisbursementPhase("active", primaryDeadline, extensionDeadline, extensionDeadline), "closed");
  assert.equal(resolveGlobalDisbursementPhase("closed", primaryDeadline, extensionDeadline, primaryDeadline), "closed");
  assert.throws(() => validateGlobalAnnouncement({
    announcedAtMs, activationAtMs, requestWindowDays: 89, extensionDays: 30,
  }), /between 90 and 365/);
  assert.throws(() => validateGlobalAnnouncement({
    announcedAtMs, activationAtMs, requestWindowDays: 90, extensionDays: 29,
  }), /between 30 and 365/);
});
