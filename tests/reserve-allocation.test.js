"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { calculateTopUpReserveAllocation } = require("../stock-accounting");

const fixed = (value) => value.toFixed();

test("inactive initial assets are consumed first and global price follows total / backed", () => {
  const result = calculateTopUpReserveAllocation("50", "2", "100", "100", "200", "10");
  assert.equal(result.available, true);
  assert.equal(fixed(result.activityAmount), "25");
  assert.equal(fixed(result.consumedInactive), "25");
  assert.equal(fixed(result.consumedBacked), "0");
  assert.equal(fixed(result.newInactive), "75");
  assert.equal(fixed(result.newBacked), "100");
  assert.equal(fixed(result.newTotalUnitsPrice), "250");
  assert.equal(fixed(result.newUnitPrice), "2.5");
});

test("backed assets are consumed after inactive assets without breaching the admin floor", () => {
  const result = calculateTopUpReserveAllocation("50", "2", "100", "20", "200", "10");
  assert.equal(result.available, true);
  assert.equal(fixed(result.consumedInactive), "20");
  assert.equal(fixed(result.consumedBacked), "5");
  assert.equal(fixed(result.newBacked), "95");
  assert.equal(fixed(result.newTotalUnitsPrice), "250");
  assert.equal(result.newBacked.gte("10"), true);
});

test("reports insufficient distributable reserves without mutating calculated state", () => {
  const result = calculateTopUpReserveAllocation("221", "2", "100", "20", "200", "10");
  assert.equal(result.available, false);
  assert.equal(fixed(result.availableValue), "220");
  assert.equal(fixed(result.newInactive), "20");
  assert.equal(fixed(result.newBacked), "100");
  assert.equal(fixed(result.newTotalUnitsPrice), "200");
});

test("rejects negative reserves, invalid prices and inconsistent common snapshots", () => {
  assert.throws(() => calculateTopUpReserveAllocation("10", "0", "2", "3", "10"), /unit_price/);
  assert.throws(() => calculateTopUpReserveAllocation("10", "1", "-1", "3", "10"), /negative/);
  assert.throws(() => calculateTopUpReserveAllocation("10", "2", "3", "3", "100"), /inconsistent/);
});
