"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { calculateXtuUnknownRefundQuote } = require("../xtu-unknown-refund-policy");

test("XTU unknown refund uses Hot Wallet net receipt as base, then deducts gas and 0.1% contract fee", () => {
  const quote = calculateXtuUnknownRefundQuote({
    hotWalletReceivedAmount: "99.9",
    estimatedGasFeeBscUsd: "0.1",
    minimumRefundNet: "0.8",
  });
  assert.equal(quote.baseReceivedAmount.toFixed(8), "99.90000000");
  assert.equal(quote.gasEquivalentXtu.toFixed(8), "0.10000000");
  assert.equal(quote.grossTransferAmount.toFixed(8), "99.80000000");
  assert.equal(quote.contractFeeAmount.toFixed(8), "0.09980000");
  assert.equal(quote.netAmount.toFixed(8), "99.70020000");
  assert.equal(BigInt(quote.amountRaw) - BigInt(quote.feeRaw), BigInt(quote.netRaw));
});

test("XTU unknown refund rejects gas that consumes the received Hot Wallet amount", () => {
  assert.throws(() => calculateXtuUnknownRefundQuote({
    hotWalletReceivedAmount: "0.4",
    estimatedGasFeeBscUsd: "0.4",
    minimumRefundNet: "0.8",
  }), /Estimated gas consumes/);
});

test("XTU unknown refund enforces the existing minimum on the beneficiary net amount", () => {
  assert.throws(() => calculateXtuUnknownRefundQuote({
    hotWalletReceivedAmount: "1.0",
    estimatedGasFeeBscUsd: "0.4",
    minimumRefundNet: "0.8",
  }), (error) => error.code === "XTU_REFUND_BELOW_MINIMUM");
});
