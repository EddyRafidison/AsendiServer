"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  deriveUnitPrice,
  deriveInitAsset,
  calculateRemainingSystemAdminReserve,
  calculateAdminCommonStockUpdate,
  calculateDistributableInitialAssets,
} = require("../stock-accounting");

test("derives the account price from balance / init_asset", () => {
  assert.equal(deriveUnitPrice("250", "50").toFixed(), "5");
});

test("recalculates init_asset from the new balance and transfer price", () => {
  const price = deriveUnitPrice("250", "50");
  assert.equal(deriveInitAsset("180", price).toFixed(), "36");
  assert.equal(deriveInitAsset("320", price).toFixed(), "64");
});

test("allows a zero resulting balance and resets init_asset to zero", () => {
  assert.equal(deriveInitAsset("0", "5").toFixed(), "0");
});

test("rejects a sender without a positive initial-asset basis", () => {
  assert.throws(() => deriveUnitPrice("250", "0"), /init_asset/);
  assert.throws(() => deriveUnitPrice("0", "50"), /balance/);
});

test("rejects negative balances and invalid prices", () => {
  assert.throws(() => deriveInitAsset("-1", "5"), /negative/);
  assert.throws(() => deriveInitAsset("10", "0"), /priceValue/);
});


test("the initial administrative reserve is 10 percent and decreases only by recorded system spending", () => {
  const reserve = calculateRemainingSystemAdminReserve("10000000", "0.10", "100000");
  assert.equal(reserve.initialQuota.toFixed(), "1000000");
  assert.equal(reserve.remainingInitialAsset.toFixed(), "900000");
  assert.throws(
    () => calculateRemainingSystemAdminReserve("10000000", "0.10", "1000001"),
    /exceeds the initial administrative reserve quota/,
  );
});

test("administrative common-stock spending converts XTU at the current unit price", () => {
  const result = calculateAdminCommonStockUpdate(
    "125000",
    "10000000",
    "1.25",
    "10000000",
    "0",
    "10000000",
    "0.10",
  );
  assert.equal(result.available, true);
  assert.equal(result.spentInitialAsset.toFixed(), "100000");
  assert.equal(result.newBackedUnits.toFixed(), "9900000");
  assert.equal(result.newSysInactiveInitAsset.toFixed(), "100000");
  assert.equal(result.newTotalUnitsPrice.toFixed(), "9875000");
  assert.equal(result.newUnitPrice.toFixed(), "1.25");
  assert.equal(result.remainingAdminInitialAsset.toFixed(), "900000");
});

test("administrative common-stock spending cannot reduce total_units_price to zero", () => {
  assert.throws(
    () => calculateAdminCommonStockUpdate(
      "10000000", "10000000", "1", "10000000", "0", "100000000", "0.10",
    ),
    /must be lower than common.total_units_price/,
  );
});

test("administrative common-stock spending cannot exceed the remaining 10 percent reserve", () => {
  const result = calculateAdminCommonStockUpdate(
    "1000001",
    "10000000",
    "1",
    "10000000",
    "0",
    "10000000",
    "0.10",
  );
  assert.equal(result.available, false);
  assert.equal(result.availableValue.toFixed(), "1000000");
  assert.equal(result.newSysInactiveInitAsset.toFixed(), "0");
});


test("administrative spending preserves the original distributable initial-asset capacity", () => {
  const before = calculateDistributableInitialAssets("10000000", "0", "1000000");
  assert.equal(before.distributableInitialAssets.toFixed(), "9000000");

  const update = calculateAdminCommonStockUpdate(
    "125000", "10000000", "1.25", "10000000", "0", "10000000", "0.10",
  );
  const after = calculateDistributableInitialAssets(
    update.newBackedUnits, "0", update.remainingAdminInitialAsset,
  );
  assert.equal(after.distributableInitialAssets.toFixed(), "9000000");
});
