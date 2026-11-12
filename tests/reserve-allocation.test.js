"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { calculateTopUpReserveAllocation } = require("../stock-accounting");

test("consumes inactive initial assets first and preserves price when sufficient", () => {
  const result = calculateTopUpReserveAllocation("70", "2", "100", "80", "500");
  assert.equal(result.available, true);
  assert.equal(result.activityAmount.toFixed(), "35");
  assert.equal(result.consumedInactive.toFixed(), "35");
  assert.equal(result.consumedBacked.toFixed(), "0");
  assert.equal(result.newInactive.toFixed(), "45");
  assert.equal(result.newBacked.toFixed(), "100");
  assert.equal(result.newTotalUnitsPrice.toFixed(), "570");
  assert.equal(result.newUnitPrice.toFixed(), "2");
  assert.equal(result.usedBackedAssets, false);
});

test("uses backed assets only after exhausting inactive assets and updates price", () => {
  const result = calculateTopUpReserveAllocation("100", "2", "100", "20", "500");
  assert.equal(result.available, true);
  assert.equal(result.activityAmount.toFixed(), "50");
  assert.equal(result.consumedInactive.toFixed(), "20");
  assert.equal(result.consumedBacked.toFixed(), "30");
  assert.equal(result.newInactive.toFixed(), "0");
  assert.equal(result.newBacked.toFixed(), "70");
  assert.equal(result.newTotalUnitsPrice.toFixed(), "600");
  assert.equal(result.newUnitPrice.toFixed(), "2.4");
  assert.equal(result.usedBackedAssets, true);
});

test("reports total available value without consuming reserves when insufficient", () => {
  const result = calculateTopUpReserveAllocation("121", "2", "40", "20", "500");
  assert.equal(result.available, false);
  assert.equal(result.availableValue.toFixed(), "120");
  assert.equal(result.consumedInactive.toFixed(), "0");
  assert.equal(result.consumedBacked.toFixed(), "0");
  assert.equal(result.newInactive.toFixed(), "20");
  assert.equal(result.newBacked.toFixed(), "40");
  assert.equal(result.newUnitPrice.toFixed(), "2");
});

test("rejects negative reserve quantities and invalid unit price", () => {
  assert.throws(() => calculateTopUpReserveAllocation("10", "0", "2", "3", "100"), /unit_price/);
  assert.throws(() => calculateTopUpReserveAllocation("10", "1", "-1", "3", "100"), /negative/);
});


test("protects the non-distributable 20 percent reserve floor", () => {
  const result = calculateTopUpReserveAllocation("170", "2", "80", "20", "500", "20");
  assert.equal(result.available, false);
  assert.equal(result.availableValue.toFixed(), "160");
  assert.equal(result.protectedFloor.toFixed(), "20");
  assert.equal(result.newInactive.toFixed(), "20");
  assert.equal(result.newBacked.toFixed(), "80");
});
