"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  MIN_DEPOSIT_AMOUNT,
  MAX_DEPOSIT_AMOUNT,
  DEPOSIT_BATCH_WINDOW_MINUTES,
  validateDepositAmount,
  getLastOneXSystemFundedPurchase,
  assessOneXSystemFundingCooldown,
  SYSTEM_FUNDED_PURCHASE_COOLDOWN_MS,
  calculateMinimumDepositCapacity,
} = require("../deposit-policy");

test("automatic deposit receipt bounds are fixed at 20 and 100 BSC-USD, with a separate 100 BSC-USD first-credit tranche", () => {
  assert.equal(MIN_DEPOSIT_AMOUNT.toFixed(), "20");
  assert.equal(MAX_DEPOSIT_AMOUNT.toFixed(), "100");
  assert.equal(DEPOSIT_BATCH_WINDOW_MINUTES, 60);
});

test("the 20-100 gross limits apply to each 60-minute deposit session, independently of weekly funding source", () => {
  assert.equal(validateDepositAmount("20").allowed, true);
  assert.equal(validateDepositAmount("100").allowed, true);
  assert.equal(validateDepositAmount("19.999999999999999999").reason, "below_minimum");
  const oversized = validateDepositAmount("100.000000000000000001");
  assert.equal(oversized.allowed, false);
  assert.equal(oversized.reason, "above_maximum");
});

test("the weekly limit counts one OneX-funded purchase regardless of amount", async () => {
  let capturedSql = "";
  let capturedParams = null;
  const queryable = {
    async query(sql, params) {
      capturedSql = sql;
      capturedParams = params;
      return [[{ id: 17, record_date: 20261117, record_time: "120000" }]];
    },
  };
  const lastPurchase = await getLastOneXSystemFundedPurchase(queryable, "USER001", "OneX");
  assert.equal(lastPurchase.id, 17);
  assert.match(capturedSql, /WHERE sender=\? AND receiver=\? AND type=2/);
  assert.doesNotMatch(capturedSql, /SUM\(|amount\s*[<>]|gross_amount|xtu_amount/i);
  assert.deepEqual(capturedParams, ["OneX", "USER001"]);

  const purchaseTime = Date.UTC(2026, 10, 17, 12, 0, 0);
  const samePurchaseCooldown = assessOneXSystemFundingCooldown(lastPurchase, purchaseTime + 6 * 24 * 60 * 60 * 1000);
  assert.equal(samePurchaseCooldown.allowed, false);
  assert.equal(samePurchaseCooldown.remainingMs, 24 * 60 * 60 * 1000);
  assert.equal(assessOneXSystemFundingCooldown(lastPurchase, purchaseTime + SYSTEM_FUNDED_PURCHASE_COOLDOWN_MS).allowed, true);
});

test("invalid, zero and negative deposit amounts are rejected", () => {
  for (const amount of ["0", "-1", "NaN", "Infinity", "not-a-number"]) {
    assert.equal(validateDepositAmount(amount).reason, "invalid_amount", amount);
  }
});


test("deposit capacity includes the minimum deposit net of tfees", () => {
  const capacity = calculateMinimumDepositCapacity({
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

test("deposit capacity becomes unavailable when the minimum net deposit exceeds 300 XTU", () => {
  const capacity = calculateMinimumDepositCapacity({
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

test("system-funded minimum deposit capacity includes retained tfees in the post-deposit price", () => {
  const capacity = calculateMinimumDepositCapacity({
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
