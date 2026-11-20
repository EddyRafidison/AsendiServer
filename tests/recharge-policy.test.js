"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  MIN_RECHARGE_AMOUNT,
  MAX_RECHARGE_AMOUNT,
  RECHARGE_BATCH_WINDOW_MINUTES,
  validateRechargeAmount,
  calculateMinimumRechargeCapacity,
} = require("../recharge-policy");

test("automatic recharge session bounds are fixed at 20 and 100 BSC-USD", () => {
  assert.equal(MIN_RECHARGE_AMOUNT.toFixed(), "20");
  assert.equal(MAX_RECHARGE_AMOUNT.toFixed(), "100");
  assert.equal(RECHARGE_BATCH_WINDOW_MINUTES, 60);
});

test("the recharge minimum and maximum are inclusive", () => {
  assert.equal(validateRechargeAmount("20").allowed, true);
  assert.equal(validateRechargeAmount("100").allowed, true);
  assert.equal(validateRechargeAmount("19.999999999999999999").reason, "below_minimum");
  assert.equal(validateRechargeAmount("100.000000000000000001").reason, "above_maximum");
});

test("invalid, zero and negative recharge amounts are rejected", () => {
  for (const amount of ["0", "-1", "NaN", "Infinity", "not-a-number"]) {
    assert.equal(validateRechargeAmount(amount).reason, "invalid_amount", amount);
  }
});


test("deposit capacity includes the minimum recharge net of tfees", () => {
  const capacity = calculateMinimumRechargeCapacity({
    currentBalanceInitialAsset: "280.6",
    totalUnitsPrice: "18000000",
    backedUnits: "18000000",
    inactiveInitialAsset: "0",
    availableSellerInitialAsset: "100",
    protectedAdminInitialAsset: "1800000",
    currentUnitPrice: "1",
    tfeesRate: "3",
    maximumUserXtu: "300",
  });

  assert.equal(capacity.minimumGrossAmount.toFixed(2), "20.00");
  assert.equal(capacity.minimumTfeesAmount.toFixed(2), "0.60");
  assert.equal(capacity.minimumNetAmount.toFixed(2), "19.40");
  assert.equal(capacity.projectedBalanceXtu.toFixed(2), "300.00");
  assert.equal(capacity.allowed, true);
});

test("deposit capacity becomes unavailable when the minimum net recharge exceeds 300 XTU", () => {
  const capacity = calculateMinimumRechargeCapacity({
    currentBalanceInitialAsset: "280.61",
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

test("system-funded minimum recharge capacity uses a conservative post-recharge price", () => {
  const capacity = calculateMinimumRechargeCapacity({
    currentBalanceInitialAsset: "280.6",
    totalUnitsPrice: "18000000",
    backedUnits: "18000000",
    inactiveInitialAsset: "0",
    availableSellerInitialAsset: "0",
    protectedAdminInitialAsset: "1800000",
    currentUnitPrice: "1",
    tfeesRate: "3",
    maximumUserXtu: "300",
  });

  assert.equal(capacity.projectionMethod, "conservative_post_recharge_price");
  assert.equal(capacity.projectedUnitPrice.gt("1"), true);
  assert.equal(capacity.allowed, false);
});

test("minimum-recharge capacity rejects invalid tfees configurations", () => {
  assert.throws(() => calculateMinimumRechargeCapacity({
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
