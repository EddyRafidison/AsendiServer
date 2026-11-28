"use strict";

const BigNumber = require("bignumber.js");

const REFUND_FEE_RATE = new BigNumber("0.01");
const MINIMUM_AUTOMATIC_REFUND_NET = new BigNumber("1");
const REFUND_ELIGIBILITY_DELAY_MS = 30 * 60 * 1000;
const MAXIMUM_REFUND_GAS_EQUIVALENT = new BigNumber("0.4");
const SUPPORTED_ASSETS = new Set(["BSC-USD", "XTU"]);
const INELIGIBLE_EVENT_STATUSES = new Set([
  "credited", "refunded", "reserved", "consumed", "confirmed", "cancelled", "reversed", "manual_review",
]);

function decimal(value, fieldName, allowZero = false) {
  const result = new BigNumber(String(value));
  if (!result.isFinite() || (allowZero ? result.isNegative() : !result.isGreaterThan(0))) {
    throw new RangeError(`${fieldName} must be ${allowZero ? "finite and non-negative" : "finite and positive"}.`);
  }
  return result;
}

function normalizeAddress(value, fieldName) {
  const address = String(value || "").trim().toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(address)) throw new TypeError(`${fieldName} must be a valid normalized EVM address.`);
  return address;
}

function getAutomaticRefundGroupKey({ chainId, tokenContract, assetCode, senderAddress }) {
  const chain = Number(chainId);
  if (!Number.isSafeInteger(chain) || chain !== 56) throw new RangeError("Automatic refunds are supported only on BNB Smart Chain Mainnet (Chain ID 56).");
  const asset = String(assetCode || "").trim().toUpperCase();
  if (!SUPPORTED_ASSETS.has(asset)) throw new TypeError("The automatic refund asset must be BSC-USD or XTU.");
  const contract = normalizeAddress(tokenContract, "token_contract");
  const sender = normalizeAddress(senderAddress, "sender_address");
  return `${chain}:${contract}:${asset}:${sender}`;
}

function calculateRefundEventFee(receivedAmountValue) {
  const receivedAmount = decimal(receivedAmountValue, "source event amount");
  return receivedAmount.multipliedBy(REFUND_FEE_RATE).decimalPlaces(18, BigNumber.ROUND_DOWN);
}

/**
 * Calculate one payout from compatible source events. Each source event incurs
 * its own 1% refund retention. Estimated gas is deducted once for the single
 * grouped outbound transaction. Source events younger than 30 minutes are
 * deliberately excluded until their own eligibility timestamp has passed.
 * Small eligible groups are retained indefinitely; no age-based review exists.
 */
function calculateAutomaticRefundGroupQuote({
  events,
  estimatedGasFeeToken,
  maximumGasFeeToken = MAXIMUM_REFUND_GAS_EQUIVALENT,
  nowMs = Date.now(),
  minimumNet = MINIMUM_AUTOMATIC_REFUND_NET,
}) {
  if (!Array.isArray(events) || events.length === 0) {
    throw new TypeError("At least one automatic-refund source event is required.");
  }
  const gas = decimal(estimatedGasFeeToken, "estimated gas equivalent", true);
  const maximumGas = decimal(maximumGasFeeToken, "maximum gas equivalent", true);
  const minimum = decimal(minimumNet, "minimum automatic refund net");
  if (!Number.isFinite(Number(nowMs)) || Number(nowMs) < 0) throw new TypeError("nowMs must be a non-negative timestamp.");

  const first = events[0];
  const groupKey = getAutomaticRefundGroupKey({
    chainId: first.chainId,
    tokenContract: first.tokenContract,
    assetCode: first.assetCode,
    senderAddress: first.senderAddress,
  });
  const sender = normalizeAddress(first.senderAddress, "sender_address");
  const payout = normalizeAddress(first.payoutAddress || first.senderAddress, "payout_address");
  if (payout !== sender) throw new RangeError("Automatic refund destination must be the verified source address.");

  let grossEligible = new BigNumber(0);
  let refundFeeTotal = new BigNumber(0);
  const eligibleEvents = [];
  const pendingEvents = [];
  const seenEvents = new Set();
  let manualReview = false;

  for (const event of events) {
    const key = getAutomaticRefundGroupKey({
      chainId: event.chainId,
      tokenContract: event.tokenContract,
      assetCode: event.assetCode,
      senderAddress: event.senderAddress,
    });
    if (key !== groupKey || normalizeAddress(event.payoutAddress || event.senderAddress, "payout_address") !== payout) {
      throw new RangeError("Automatic refund events from different chains, contracts, tokens or source addresses cannot be grouped.");
    }
    const eventIdentity = String(event.eventIdentity || "").trim().toLowerCase();
    if (!eventIdentity || seenEvents.has(eventIdentity)) continue;
    seenEvents.add(eventIdentity);

    const status = String(event.status || "collecting").toLowerCase();
    if (status === "manual_review" || event.manualReview === true) {
      manualReview = true;
      continue;
    }
    if (INELIGIBLE_EVENT_STATUSES.has(status) || event.credited === true || event.consumed === true) continue;
    if (event.finalized !== true) continue;

    const received = decimal(event.grossAmount, "source event gross amount");
    const finalizedAtMs = Number(event.finalizedAtMs);
    const eligibleAtMs = Number(event.refundEligibleAtMs ?? (finalizedAtMs + REFUND_ELIGIBILITY_DELAY_MS));
    if (!Number.isFinite(finalizedAtMs) || finalizedAtMs <= 0 || !Number.isFinite(eligibleAtMs)) {
      throw new TypeError("Each finalized source event must have valid finalized and eligibility timestamps.");
    }
    if (Number(nowMs) < eligibleAtMs) {
      pendingEvents.push(event);
      continue;
    }
    const retained = calculateRefundEventFee(received);
    grossEligible = grossEligible.plus(received);
    refundFeeTotal = refundFeeTotal.plus(retained);
    eligibleEvents.push({
      ...event,
      grossAmount: received,
      refundFeeAmount: retained,
      refundEligibleAtMs: eligibleAtMs,
    });
  }

  const netAmount = BigNumber.maximum(0, grossEligible.minus(refundFeeTotal).minus(gas))
    .decimalPlaces(18, BigNumber.ROUND_DOWN);
  const gasWithinCeiling = gas.lte(maximumGas);
  const eligible = !manualReview && eligibleEvents.length > 0 && gasWithinCeiling && netAmount.gte(minimum);
  return {
    groupKey,
    assetCode: String(first.assetCode).trim().toUpperCase(),
    senderAddress: sender,
    payoutAddress: payout,
    sourceEventCount: seenEvents.size,
    eligibleEventCount: eligibleEvents.length,
    pendingEventCount: pendingEvents.length,
    grossEligibleAmount: grossEligible,
    refundFeeAmount: refundFeeTotal,
    estimatedGasFeeToken: gas,
    netAmount,
    minimumNet: minimum,
    gasWithinCeiling,
    manualReview,
    eligible,
    eligibleEvents,
    pendingEvents,
  };
}

module.exports = {
  REFUND_FEE_RATE,
  MINIMUM_AUTOMATIC_REFUND_NET,
  REFUND_ELIGIBILITY_DELAY_MS,
  MAXIMUM_REFUND_GAS_EQUIVALENT,
  getAutomaticRefundGroupKey,
  calculateRefundEventFee,
  calculateAutomaticRefundGroupQuote,
};
