"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  MINIMUM_AUTOMATIC_REFUND_NET,
  REFUND_ELIGIBILITY_DELAY_MS,
  getAutomaticRefundGroupKey,
  calculateAutomaticRefundGroupQuote,
} = require("../automatic-refund-policy");

const sender = "0x1111111111111111111111111111111111111111";
const contract = "0x2222222222222222222222222222222222222222";
const now = 2_000_000_000_000;

function event(overrides = {}) {
  const finalizedAtMs = now - REFUND_ELIGIBILITY_DELAY_MS - 1;
  return {
    chainId: 56,
    tokenContract: contract,
    assetCode: "BSC-USD",
    senderAddress: sender,
    payoutAddress: sender,
    eventIdentity: `event-${Math.random()}`,
    grossAmount: "0.6",
    finalized: true,
    finalizedAtMs,
    refundEligibleAtMs: finalizedAtMs + REFUND_ELIGIBILITY_DELAY_MS,
    status: "collecting",
    ...overrides,
  };
}

test("automatic refunds use a fixed net minimum of one unit", () => {
  assert.equal(MINIMUM_AUTOMATIC_REFUND_NET.toFixed(), "1");
});

test("compatible small transfers aggregate with one grouped gas deduction", () => {
  const quote = calculateAutomaticRefundGroupQuote({
    events: [event({ eventIdentity: "0x01", grossAmount: "0.6" }), event({ eventIdentity: "0x02", grossAmount: "0.6" })],
    estimatedGasFeeToken: "0.05",
    nowMs: now,
  });
  assert.equal(quote.grossEligibleAmount.toFixed(8), "1.20000000");
  assert.equal(quote.refundFeeAmount.toFixed(8), "0.01200000");
  assert.equal(quote.netAmount.toFixed(8), "1.13800000");
  assert.equal(quote.eligible, true);
  assert.equal(quote.eligibleEventCount, 2);
});

test("the event-specific 30-minute delay excludes a recent source event", () => {
  const quote = calculateAutomaticRefundGroupQuote({
    events: [
      event({ eventIdentity: "0x11", grossAmount: "1.2" }),
      event({ eventIdentity: "0x12", grossAmount: "1.0", finalizedAtMs: now - 1000, refundEligibleAtMs: now + REFUND_ELIGIBILITY_DELAY_MS - 1000 }),
    ],
    estimatedGasFeeToken: "0.05",
    nowMs: now,
  });
  assert.equal(quote.eligibleEventCount, 1);
  assert.equal(quote.pendingEventCount, 1);
  assert.equal(quote.eligible, false);
});

test("different senders, contracts, or token assets cannot share a refund group", () => {
  assert.throws(() => getAutomaticRefundGroupKey({
    chainId: 56, tokenContract: contract, assetCode: "BSC-USD", senderAddress: sender,
  }).concat(getAutomaticRefundGroupKey({
    chainId: 56, tokenContract: contract, assetCode: "BSC-USD", senderAddress: "0x3333333333333333333333333333333333333333",
  })), /never/);
  assert.throws(() => calculateAutomaticRefundGroupQuote({
    events: [event({ eventIdentity: "0x21" }), event({ eventIdentity: "0x22", assetCode: "XTU" })],
    estimatedGasFeeToken: "0.01",
    nowMs: now,
  }), /cannot be grouped/);
  assert.throws(() => calculateAutomaticRefundGroupQuote({
    events: [event({ eventIdentity: "0x31" }), event({ eventIdentity: "0x32", tokenContract: "0x4444444444444444444444444444444444444444" })],
    estimatedGasFeeToken: "0.01",
    nowMs: now,
  }), /cannot be grouped/);
});

test("gas above the ceiling blocks signing without changing the one-unit minimum", () => {
  const quote = calculateAutomaticRefundGroupQuote({
    events: [event({ eventIdentity: "0x41", grossAmount: "2" })],
    estimatedGasFeeToken: "0.41",
    nowMs: now,
  });
  assert.equal(quote.netAmount.toFixed(8), "1.57000000");
  assert.equal(quote.gasWithinCeiling, false);
  assert.equal(quote.eligible, false);
});

test("manual review blocks an otherwise eligible group and no age-based review state exists", () => {
  const blocked = calculateAutomaticRefundGroupQuote({
    events: [event({ eventIdentity: "0x51", grossAmount: "2", status: "manual_review" })],
    estimatedGasFeeToken: "0.01", nowMs: now,
  });
  assert.equal(blocked.manualReview, true);
  assert.equal(blocked.eligible, false);

  const retained = calculateAutomaticRefundGroupQuote({
    events: [event({ eventIdentity: "0x52", grossAmount: "0.5", finalizedAtMs: now - 365 * 24 * 60 * 60 * 1000, refundEligibleAtMs: now - 365 * 24 * 60 * 60 * 1000 })],
    estimatedGasFeeToken: "0.01", nowMs: now,
  });
  assert.equal(retained.eligible, false);
  assert.equal(retained.netAmount.toFixed(8), "0.48500000");
  assert.equal(Object.hasOwn(retained, "reviewDue"), false);
});
