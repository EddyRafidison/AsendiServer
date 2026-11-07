"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  deriveUnitPrice,
  deriveInitAsset,
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
