"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { calculateIndividualTargetPrice } = require("../user-price-accounting");

const fixed = (value) => value.toFixed();

test("individual target B equals A plus three times the applied transfer-fee rate", () => {
  assert.equal(fixed(calculateIndividualTargetPrice("1.25", "3")), "1.3625");
  assert.equal(fixed(calculateIndividualTargetPrice("2", "0")), "2");
  assert.equal(fixed(calculateIndividualTargetPrice("1.125", "2.5")), "1.209375");
});

test("individual target calculation rejects invalid price or fee rates", () => {
  assert.throws(() => calculateIndividualTargetPrice("0", "3"), /positive/);
  assert.throws(() => calculateIndividualTargetPrice("1", "-1"), /non-negative/);
  assert.throws(() => calculateIndividualTargetPrice("1", "100"), /less than 100/);
});
