"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { allocateBscCostFromTfees } = require("../tfees-bsc-allocation");

test("confirmed BSC costs are covered from gross tfees and only the remainder is retained", () => {
  const result = allocateBscCostFromTfees("6", "0.4");
  assert.equal(result.grossTfees.toFixed(), "6");
  assert.equal(result.coveredBscCost.toFixed(), "0.4");
  assert.equal(result.uncoveredBscCost.toFixed(), "0");
  assert.equal(result.retainedTfees.toFixed(), "5.6");
});

test("BSC costs above gross tfees are tracked as a OneX cost, not a user surcharge", () => {
  const result = allocateBscCostFromTfees("0.2", "0.5");
  assert.equal(result.coveredBscCost.toFixed(), "0.2");
  assert.equal(result.uncoveredBscCost.toFixed(), "0.3");
  assert.equal(result.retainedTfees.toFixed(), "0");
});

test("zero BSC cost leaves all tfees retained", () => {
  const result = allocateBscCostFromTfees("3", "0");
  assert.equal(result.retainedTfees.toFixed(), "3");
  assert.equal(result.coveredBscCost.toFixed(), "0");
});

test("fee allocation rejects invalid values", () => {
  assert.throws(() => allocateBscCostFromTfees("-1", "0"), /Gross tfees/);
  assert.throws(() => allocateBscCostFromTfees("1", "NaN"), /Actual BSC cost/);
});
