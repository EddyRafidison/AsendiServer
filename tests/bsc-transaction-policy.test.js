"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  getConfiguredMaxBscTxFeeUsd,
  evaluateBscTxFee,
  createBscFeeLimitError,
} = require("../bsc-transaction-policy");

const fixed = (value) => value.toFixed(8);

test("the BSC transaction fee cap defaults to 0.4 BSC-USD", () => {
  assert.equal(fixed(getConfiguredMaxBscTxFeeUsd("")), "0.40000000");
  assert.equal(fixed(getConfiguredMaxBscTxFeeUsd("0.25")), "0.25000000");
});

test("the BSC transaction fee cap cannot exceed 0.4 BSC-USD", () => {
  for (const value of ["0.4000000001", "0.5", "NaN", "Infinity", "-0.01"]) {
    assert.throws(() => getConfiguredMaxBscTxFeeUsd(value), /between 0 and 0.4/);
  }
  assert.equal(fixed(getConfiguredMaxBscTxFeeUsd("0")), "0.00000000");
});

test("a transfer is allowed at the fee cap and queued when the estimate exceeds it", () => {
  assert.equal(evaluateBscTxFee("0.4", "0.4").allowed, true);
  assert.equal(evaluateBscTxFee("0.39999999", "0.4").allowed, true);
  assert.equal(evaluateBscTxFee("0.40000001", "0.4").allowed, false);
  assert.equal(fixed(evaluateBscTxFee("0.45", "0.4").excessFeeUsd), "0.05000000");
});

test("fee limit errors are explicitly identifiable by workers", () => {
  const error = createBscFeeLimitError("0.45", "0.4");
  assert.equal(error.code, "BSC_GAS_FEE_LIMIT_EXCEEDED");
  assert.match(error.message, /0.45000000 BSC-USD exceeds.*0.40000000 BSC-USD/);
});
