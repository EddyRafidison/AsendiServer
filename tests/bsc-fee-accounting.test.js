"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  calculateEstimatedGasFee,
  calculateActualGasFee,
} = require("../bsc-fee-accounting");

const fixed = (value) => value.toFixed(18);

test("estimated BNB gas fee uses gas limit, gas price and captured BNB/USD quote", () => {
  const result = calculateEstimatedGasFee("100000", "3000000000", "600");
  assert.equal(fixed(result.feeBnb), "0.000300000000000000");
  assert.equal(fixed(result.feeUsd), "0.180000000000000000");
  assert.equal(fixed(result.bnbUsdPrice), "600.000000000000000000");
});

test("actual BNB gas fee uses gasUsed and effectiveGasPrice from the receipt", () => {
  const result = calculateActualGasFee({ gasUsed: 50000n, gasPrice: 3000000000n }, "600");
  assert.equal(result.gasUsed, "50000");
  assert.equal(result.effectiveGasPriceWei, "3000000000");
  assert.equal(fixed(result.feeBnb), "0.000150000000000000");
  assert.equal(fixed(result.feeUsd), "0.090000000000000000");
});

test("gas fee conversion rejects invalid gas data and a zero BNB/USD quote", () => {
  assert.throws(() => calculateEstimatedGasFee("0", "3000000000", "600"), /positive integers/);
  assert.throws(() => calculateEstimatedGasFee("100000", "3000000000", "0"), /BNB\/USD/);
  assert.throws(() => calculateActualGasFee({ gasUsed: 1n }, "600"), /receipt/);
});
