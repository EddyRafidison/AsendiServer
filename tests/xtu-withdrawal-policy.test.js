"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  calculateXtuWithdrawalQuote,
  validateWithdrawalRequestAmount,
  formatTokenRaw,
} = require("../xtu-withdrawal-policy");

test("XTU withdrawal quote deducts gas first and the contract applies 0.1% exactly once", () => {
  const quote = calculateXtuWithdrawalQuote("100", "0.10");
  assert.equal(quote.grossAmount.toFixed(18), "100.000000000000000000");
  assert.equal(quote.estimatedGasFeeXtu.toFixed(18), "0.100000000000000000");
  assert.equal(quote.contractTransferAmount.toFixed(18), "99.900000000000000000");
  assert.equal(quote.contractFeeAmount.toFixed(18), "0.099900000000000000");
  assert.equal(quote.netAmount.toFixed(18), "99.800100000000000000");
  assert.equal(quote.estimatedCombinedFees.toFixed(18), "0.199900000000000000");
});

test("XTU withdrawal amount validation enforces a gross minimum of one token and 18 decimals", () => {
  assert.equal(validateWithdrawalRequestAmount("1").toFixed(), "1");
  assert.equal(validateWithdrawalRequestAmount("12.000000000000000001").toFixed(), "12.000000000000000001");
  assert.throws(() => validateWithdrawalRequestAmount("0.999999999999999999"), /minimum gross XTU withdrawal is 1/);
  assert.throws(() => validateWithdrawalRequestAmount("1.0000000000000000001"), /18 decimal places/);
  assert.throws(() => validateWithdrawalRequestAmount("1e2"), /decimal/);
});

test("raw XTU values are formatted without losing precision", () => {
  assert.equal(formatTokenRaw(1000000000000000000n), "1");
  assert.equal(formatTokenRaw(1234567890123456789n), "1.234567890123456789");
});
