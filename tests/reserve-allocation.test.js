"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { calculateRechargeFundingAllocation } = require("../stock-accounting");

const fixed = (value) => value.toFixed();

test("recharge funding consumes inactive assets, then seller lots, then backed assets", () => {
  const result = calculateRechargeFundingAllocation(
    "100", "2", "100", "30", "20", "200", "10", "0",
  );
  assert.equal(result.available, true);
  assert.equal(fixed(result.consumedInactive), "30");
  assert.equal(fixed(result.consumedSellers), "20");
  assert.equal(fixed(result.consumedBacked), "50");
  assert.equal(fixed(result.newInactive), "0");
  assert.equal(fixed(result.newSellersReserve), "0");
  assert.equal(fixed(result.newBacked), "50");
  assert.equal(fixed(result.newTotalUnitsPrice), "360");
  assert.equal(result.newBacked.gte("10"), true);
});

test("inactive reserve is consumed before any seller lot when it covers the full recharge", () => {
  const result = calculateRechargeFundingAllocation(
    "20", "1.5", "100", "25", "50", "150", "10", "0",
  );
  assert.equal(result.available, true);
  assert.equal(fixed(result.consumedInactive), "20");
  assert.equal(fixed(result.consumedSellers), "0");
  assert.equal(fixed(result.consumedBacked), "0");
  assert.equal(fixed(result.newInactive), "5");
  assert.equal(fixed(result.newSellersReserve), "50");
  assert.equal(fixed(result.newBacked), "100");
});

test("seller reserve is the second priority and protects the administrative backed floor", () => {
  const result = calculateRechargeFundingAllocation(
    "41", "2", "100", "5", "15", "200", "80", "0",
  );
  assert.equal(result.available, false);
  assert.equal(fixed(result.consumedInactive), "0");
  assert.equal(fixed(result.consumedSellers), "0");
  assert.equal(fixed(result.consumedBacked), "0");
  assert.equal(fixed(result.newInactive), "5");
  assert.equal(fixed(result.newSellersReserve), "15");
  assert.equal(fixed(result.newBacked), "100");
});

test("pending disbursement reservations reduce system capacity without consuming seller lots", () => {
  const result = calculateRechargeFundingAllocation(
    "15", "1", "100", "10", "5", "100", "10", "80",
  );
  assert.equal(result.available, true);
  assert.equal(fixed(result.consumedInactive), "10");
  assert.equal(fixed(result.consumedSellers), "5");
  assert.equal(fixed(result.consumedBacked), "0");
  assert.equal(fixed(result.availableAfterPending), "20");
});

test("rejects invalid reserve amounts, price inconsistency and administrative floor breaches", () => {
  assert.throws(() => calculateRechargeFundingAllocation("10", "0", "2", "3", "0", "10"), /unit_price/);
  assert.throws(() => calculateRechargeFundingAllocation("10", "1", "-1", "3", "0", "10"), /negative/);
  assert.throws(() => calculateRechargeFundingAllocation("10", "2", "3", "3", "100"), /inconsistent/);
  assert.throws(() => calculateRechargeFundingAllocation("10", "1", "5", "0", "0", "5", "6"), /below/);
});
