"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const BigNumber = require("bignumber.js");
const { allocateFeeByRawAmount } = require("../bsc-fee-allocations");

test("BSC sweep gas fees are allocated pro-rata by raw deposit amount", () => {
  const result = allocateFeeByRawAmount("0.4", [
    { batchId: "2", rawAmount: "300" },
    { batchId: "1", rawAmount: "100" },
  ]);
  assert.deepEqual(result.map((row) => row.batchId), ["1", "2"]);
  assert.equal(result[0].allocatedFeeUsd.toFixed(12), "0.100000000000");
  assert.equal(result[1].allocatedFeeUsd.toFixed(12), "0.300000000000");
  assert.equal(result.reduce((sum, row) => sum.plus(row.allocatedFeeUsd), new BigNumber(0)).toFixed(18), "0.400000000000000000");
});

test("BSC sweep allocation assigns rounding remainder to the final row", () => {
  const result = allocateFeeByRawAmount("1", [
    { batchId: "1", rawAmount: "1" },
    { batchId: "2", rawAmount: "1" },
    { batchId: "3", rawAmount: "1" },
  ]);
  const total = result.reduce((sum, row) => sum.plus(row.allocatedFeeUsd), new BigNumber(0));
  assert.equal(total.toFixed(), "1");
});

test("BSC sweep allocation rejects invalid or duplicate batch identifiers", () => {
  assert.throws(() => allocateFeeByRawAmount("1", [{ batchId: "x", rawAmount: "1" }]), /Invalid/);
  assert.throws(() => allocateFeeByRawAmount("1", [
    { batchId: "1", rawAmount: "1" }, { batchId: "1", rawAmount: "2" },
  ]), /Duplicate/);
});
