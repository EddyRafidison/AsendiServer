"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { evaluateRechargeCredit, findMaximumRechargeCredit } = require("../recharge-credit-policy");

function baseline(overrides = {}) {
  return {
    targetGrossAmount: "100",
    currentBalanceInitialAsset: "0",
    totalUnitsPrice: "18000000",
    backedUnits: "18000000",
    inactiveInitialAsset: "0",
    totalSellerReserve: "1000000",
    availableSellerReserve: "1000000",
    protectedAdminInitialAsset: "1800000",
    pendingDisbursementInitialAsset: "0",
    currentUnitPrice: "1",
    tfeesRatePercent: "3",
    maximumUserXtu: "300",
    weeklyCooldownAllowed: true,
    globalBonusRatePercent: "0",
    remainingAdminReserveInitialAsset: "1800000",
    alreadyReservedAdminBonusInitialAsset: "0",
    ...overrides,
  };
}

test("recharge credit retains all tfees and does not deduct incoming BSC gas", () => {
  const result = evaluateRechargeCredit({ ...baseline(), grossAmount: "100" });
  assert.equal(result.allowed, true);
  assert.equal(result.grossAmount.toFixed(2), "100.00");
  assert.equal(result.feeAmount.toFixed(2), "3.00");
  assert.equal(result.netAmount.toFixed(2), "97.00");
  assert.equal(result.newTotal.toFixed(2), "18000097.00");
  assert.equal(result.feeBasis.toFixed(2), "3.00");
});

test("initial credit request can be capped at 100 while any later remainder is submitted without that cap", () => {
  const initial = findMaximumRechargeCredit({ ...baseline(), targetGrossAmount: "250" });
  assert.equal(initial.allowed, true);
  assert.equal(initial.grossAmount.toFixed(2), "250.00");
  const firstTranche = findMaximumRechargeCredit({ ...baseline(), targetGrossAmount: "100" });
  assert.equal(firstTranche.allowed, true);
  assert.equal(firstTranche.grossAmount.toFixed(2), "100.00");
});

test("credit planner finds a partial tranche under the 300 XTU account ceiling", () => {
  const result = findMaximumRechargeCredit({
    ...baseline({ currentBalanceInitialAsset: "250" }),
    targetGrossAmount: "100",
  });
  assert.equal(result.allowed, true);
  assert.equal(result.partial, true);
  assert.equal(result.partialReason, "maximum_user_balance");
  assert.equal(result.grossAmount.gt(0), true);
  assert.equal(result.grossAmount.lt("100"), true);
  assert.equal(result.projectedBalanceXtu.lte("300"), true);
});

test("weekly cooldown blocks system-funded tranche but allows seller-funded tranche", () => {
  const systemOnly = findMaximumRechargeCredit({
    ...baseline({ totalSellerReserve: "0", availableSellerReserve: "0", weeklyCooldownAllowed: false }),
    targetGrossAmount: "20",
  });
  assert.equal(systemOnly.allowed, false);
  assert.equal(systemOnly.reason, "weekly_limit");

  const sellerOnly = findMaximumRechargeCredit({
    ...baseline({ inactiveInitialAsset: "0", totalSellerReserve: "1000", availableSellerReserve: "1000", weeklyCooldownAllowed: false }),
    targetGrossAmount: "20",
  });
  assert.equal(sellerOnly.allowed, true);
  assert.equal(sellerOnly.grossAmount.toFixed(2), "20.00");
});
