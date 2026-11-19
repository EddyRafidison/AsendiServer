"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  MIN_RECHARGE_AMOUNT,
  MAX_RECHARGE_AMOUNT,
  DEPOSIT_SWEEP_THRESHOLD,
  RECHARGE_BATCH_WINDOW_MINUTES,
  validateRechargeAmount,
} = require("../recharge-policy");

test("automatic recharge session bounds are fixed at 10 and 100 BSC-USD", () => {
  assert.equal(MIN_RECHARGE_AMOUNT.toFixed(), "10");
  assert.equal(MAX_RECHARGE_AMOUNT.toFixed(), "100");
  assert.equal(DEPOSIT_SWEEP_THRESHOLD.toFixed(), "100");
  assert.equal(RECHARGE_BATCH_WINDOW_MINUTES, 60);
});

test("the recharge minimum and maximum are inclusive", () => {
  assert.equal(validateRechargeAmount("10").allowed, true);
  assert.equal(validateRechargeAmount("100").allowed, true);
  assert.equal(validateRechargeAmount("9.999999999999999999").reason, "below_minimum");
  assert.equal(validateRechargeAmount("100.000000000000000001").reason, "above_maximum");
});

test("invalid, zero and negative recharge amounts are rejected", () => {
  for (const amount of ["0", "-1", "NaN", "Infinity", "not-a-number"]) {
    assert.equal(validateRechargeAmount(amount).reason, "invalid_amount", amount);
  }
});
