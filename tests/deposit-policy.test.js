"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  MIN_DEPOSIT_AMOUNT,
  MAX_DEPOSIT_AMOUNT,
  DEPOSIT_BATCH_WINDOW_MINUTES,
  validateDepositAmount,
  classifyRollingDepositReceipt,
  calculateMinimumDepositCapacity,
} = require("../deposit-policy");

test("automatic deposit receipt bounds are fixed at 70 and 140 BSC-USD, with a separate 100 BSC-USD first-credit tranche", () => {
  assert.equal(MIN_DEPOSIT_AMOUNT.toFixed(), "70");
  assert.equal(MAX_DEPOSIT_AMOUNT.toFixed(), "140");
  assert.equal(DEPOSIT_BATCH_WINDOW_MINUTES, 60);
});

test("the rolling seven-day receipt minimum is enforced while the first-credit tranche remains separately capped at 100", () => {
  assert.equal(validateDepositAmount("70").allowed, true);
  assert.equal(validateDepositAmount("140").allowed, true);
  assert.equal(validateDepositAmount("69.999999999999999999").reason, "below_minimum");
  const oversized = validateDepositAmount("140.000000000000000001");
  assert.equal(oversized.allowed, true);
  assert.equal(oversized.exceedsInitialCreditLimit, true);
  assert.equal(oversized.initialCreditLimit.toFixed(), "100");
});

test("the rolling seven-day BSC-USD receipt ceiling is enforced independently of the first credit tranche", () => {
  assert.equal(classifyRollingDepositReceipt("140").allowed, true);
  assert.equal(classifyRollingDepositReceipt("140.000000000000000001").status, "pending_weekly");
  assert.equal(classifyRollingDepositReceipt("80").remainingCapacity.toFixed(), "60");
});

test("invalid, zero and negative deposit amounts are rejected", () => {
  for (const amount of ["0", "-1", "NaN", "Infinity", "not-a-number"]) {
    assert.equal(validateDepositAmount(amount).reason, "invalid_amount", amount);
  }
});


test("deposit capacity includes the minimum deposit net of tfees", () => {
  const capacity = calculateMinimumDepositCapacity({
    currentBalanceInitialAsset: "232.1",
    totalUnitsPrice: "18000000",
    backedUnits: "18000000",
    inactiveInitialAsset: "0",
    availableSellerInitialAsset: "100",
    protectedAdminInitialAsset: "1800000",
    currentUnitPrice: "1",
    tfeesRate: "3",
    maximumUserXtu: "300",
  });

  assert.equal(capacity.minimumGrossAmount.toFixed(2), "70.00");
  assert.equal(capacity.minimumTfeesAmount.toFixed(2), "2.10");
  assert.equal(capacity.minimumNetAmount.toFixed(2), "67.90");
  assert.equal(capacity.projectedBalanceXtu.toFixed(2), "300.00");
  assert.equal(capacity.allowed, true);
});

test("deposit capacity becomes unavailable when the minimum net deposit exceeds 300 XTU", () => {
  const capacity = calculateMinimumDepositCapacity({
    currentBalanceInitialAsset: "232.11",
    totalUnitsPrice: "18000000",
    backedUnits: "18000000",
    inactiveInitialAsset: "0",
    availableSellerInitialAsset: "100",
    protectedAdminInitialAsset: "1800000",
    currentUnitPrice: "1",
    tfeesRate: "3",
    maximumUserXtu: "300",
  });

  assert.equal(capacity.allowed, false);
  assert.equal(capacity.projectedBalanceXtu.gt("300"), true);
});

test("system-funded minimum deposit capacity includes retained tfees in the post-deposit price", () => {
  const capacity = calculateMinimumDepositCapacity({
    currentBalanceInitialAsset: "232.1",
    totalUnitsPrice: "18000000",
    backedUnits: "18000000",
    inactiveInitialAsset: "0",
    availableSellerInitialAsset: "0",
    protectedAdminInitialAsset: "1800000",
    currentUnitPrice: "1",
    tfeesRate: "3",
    maximumUserXtu: "300",
  });

  assert.equal(capacity.projectionMethod, "retained_tfees_post_deposit_price");
  assert.equal(capacity.projectedUnitPrice.gt("1"), true);
  assert.equal(capacity.allowed, false);
});

test("minimum-deposit capacity rejects invalid tfees configurations", () => {
  assert.throws(() => calculateMinimumDepositCapacity({
    currentBalanceInitialAsset: "1",
    totalUnitsPrice: "18000000",
    backedUnits: "18000000",
    inactiveInitialAsset: "0",
    availableSellerInitialAsset: "100",
    protectedAdminInitialAsset: "1800000",
    currentUnitPrice: "1",
    tfeesRate: "100",
    maximumUserXtu: "300",
  }), /valid ranges/);
});
