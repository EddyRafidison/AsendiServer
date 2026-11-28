"use strict";

const BigNumber = require("bignumber.js");
const crypto = require("crypto");

BigNumber.config({ DECIMAL_PLACES: 36, ROUNDING_MODE: BigNumber.ROUND_DOWN });

const XTU_FREE_DEPOSIT_MINIMUM = new BigNumber("1");
const XTU_FREE_DEPOSIT_MAX_EVENTS = 5;
const XTU_FREE_CONSOLIDATION_MINIMUM = new BigNumber("100");
const GLOBAL_CAMPAIGN_PHASES = new Set([
  "global",
  "global_primary",
  "global_extension",
  "global_claim_extension",
  "claim_extension",
  "extension",
]);

function amount(value, fieldName, allowZero = false) {
  const result = new BigNumber(String(value ?? ""));
  if (!result.isFinite() || (allowZero ? result.isNegative() : !result.isGreaterThan(0))) {
    throw new RangeError(`${fieldName} must be ${allowZero ? "finite and non-negative" : "finite and positive"}.`);
  }
  if (result.decimalPlaces() > 18) throw new RangeError(`${fieldName} cannot have more than 18 decimal places.`);
  return result;
}

function normalizeAddress(value, fieldName) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(normalized)) throw new TypeError(`${fieldName} must be a valid EVM address.`);
  return normalized;
}

function getEventKey(event) {
  const chainId = Number(event.chainId);
  if (!Number.isSafeInteger(chainId) || chainId !== 56) throw new RangeError("XTU free deposits are supported only on BNB Smart Chain Mainnet.");
  const contract = normalizeAddress(event.tokenContract, "tokenContract");
  const txHash = String(event.txHash ?? "").trim().toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(txHash)) throw new TypeError("txHash must be a valid transaction hash.");
  const logIndex = Number(event.logIndex);
  if (!Number.isSafeInteger(logIndex) || logIndex < 0) throw new TypeError("logIndex must be a non-negative safe integer.");
  return `${chainId}:${contract}:${txHash}:${logIndex}`;
}

function getEventIdentity(event) {
  return crypto.createHash("sha256").update(getEventKey(event)).digest("hex");
}

function effectiveReceiveFeeRate(event) {
  const phase = String(event.campaignPhase ?? "ordinary").trim().toLowerCase();
  if (GLOBAL_CAMPAIGN_PHASES.has(phase)) return new BigNumber(0);
  const rate = amount(event.tfeesRatePercent ?? "0", "tfeesRatePercent", true);
  if (rate.gt("100")) throw new RangeError("XTU free-deposit tfees rate cannot exceed 100 percent.");
  return rate;
}

/**
 * Evaluate finalized XTU free-deposit events in source order.
 * The receive-fee rate is expected to have been frozen at each event's finality.
 * The first event sequence reaching one net XTU qualifies the attempt; any
 * later events in the supplied array belong to the next attempt.
 */
function calculateXtuFreeDepositAttempt(events, options = {}) {
  if (!Array.isArray(events)) throw new TypeError("events must be an array.");
  const minimumNet = amount(options.minimumNet ?? XTU_FREE_DEPOSIT_MINIMUM, "minimumNet");
  const maximumEvents = Number(options.maximumEvents ?? XTU_FREE_DEPOSIT_MAX_EVENTS);
  if (!Number.isSafeInteger(maximumEvents) || maximumEvents < 1 || maximumEvents > 255) {
    throw new RangeError("maximumEvents must be a positive integer.");
  }

  const finalized = events.filter((event) => event?.finalized === true || String(event?.finalityStatus ?? "").toLowerCase() === "finalized");
  const seen = new Set();
  const unique = [];
  let grouping = null;
  for (const event of finalized) {
    const key = getEventKey(event);
    if (seen.has(key)) continue;
    seen.add(key);
    const source = normalizeAddress(event.sourceAddress, "sourceAddress");
    const contract = normalizeAddress(event.tokenContract, "tokenContract");
    const currentGroup = `${Number(event.chainId)}:${contract}:${source}`;
    if (grouping !== null && grouping !== currentGroup) {
      throw new RangeError("An XTU free-deposit attempt cannot mix source addresses, chains or token contracts.");
    }
    grouping = currentGroup;
    unique.push({ ...event, _eventKey: key, _eventIdentity: getEventIdentity(event), _source: source, _contract: contract });
  }

  let grossAmount = new BigNumber(0);
  let feeAmount = new BigNumber(0);
  let netAmount = new BigNumber(0);
  let qualifiedAtSequence = null;
  let qualifiedGrossAmount = new BigNumber(0);
  let qualifiedFeeAmount = new BigNumber(0);
  let qualifiedNetAmount = new BigNumber(0);
  let includedEventCount = 0;
  const eventResults = [];

  for (let index = 0; index < unique.length; index += 1) {
    const event = unique[index];
    const gross = amount(event.grossAmount, "grossAmount");
    const rate = effectiveReceiveFeeRate(event);
    const fee = gross.multipliedBy(rate).dividedBy(100).decimalPlaces(18, BigNumber.ROUND_DOWN);
    const net = gross.minus(fee);
    if (net.isNegative()) throw new RangeError("An XTU free-deposit event cannot have negative net amount.");
    grossAmount = grossAmount.plus(gross);
    feeAmount = feeAmount.plus(fee);
    netAmount = netAmount.plus(net);
    eventResults.push({
      event,
      eventIdentity: event._eventIdentity,
      grossAmount: gross,
      feeRatePercent: rate,
      feeAmount: fee,
      netAmount: net,
    });

    if (qualifiedAtSequence === null) {
      includedEventCount += 1;
      if (includedEventCount <= maximumEvents && netAmount.gte(minimumNet)) {
        qualifiedAtSequence = includedEventCount;
        qualifiedGrossAmount = grossAmount;
        qualifiedFeeAmount = feeAmount;
        qualifiedNetAmount = netAmount;
      }
    }
  }

  const disqualified = qualifiedAtSequence === null && unique.length > maximumEvents;
  const includedEvents = qualifiedAtSequence === null
    ? eventResults
    : eventResults.slice(0, qualifiedAtSequence);
  const trailingEvents = qualifiedAtSequence === null ? [] : eventResults.slice(qualifiedAtSequence);
  const resultGross = qualifiedAtSequence === null ? grossAmount : qualifiedGrossAmount;
  const resultFees = qualifiedAtSequence === null ? feeAmount : qualifiedFeeAmount;
  const resultNet = qualifiedAtSequence === null ? netAmount : qualifiedNetAmount;

  return {
    minimumNet,
    maximumEvents,
    uniqueFinalizedEventCount: unique.length,
    includedEventCount: includedEvents.length,
    grossAmount: resultGross,
    feeAmount: resultFees,
    netAmount: resultNet,
    qualified: qualifiedAtSequence !== null,
    qualifiedAtSequence,
    disqualified,
    trailingEvents,
    events: includedEvents,
    // XTU free attempts do not expire by age. The BSC-USD purchase-batch
    // expiration rule must never be reused for this register.
    expiresAtMs: null,
  };
}

function calculateXtuFreeBalanceTransition(currentBalance, operation, amountValue) {
  const amountToMove = amount(amountValue, "amount");
  const current = {
    available: amount(currentBalance?.available ?? "0", "available", true),
    reserved: amount(currentBalance?.reserved ?? "0", "reserved", true),
    consumed: amount(currentBalance?.consumed ?? "0", "consumed", true),
  };
  let availableDelta = new BigNumber(0);
  let reservedDelta = new BigNumber(0);
  let consumedDelta = new BigNumber(0);

  switch (String(operation ?? "").toLowerCase()) {
    case "credit":
      availableDelta = amountToMove;
      break;
    case "reserve":
      availableDelta = amountToMove.negated();
      reservedDelta = amountToMove;
      break;
    case "settle":
      reservedDelta = amountToMove.negated();
      consumedDelta = amountToMove;
      break;
    case "release":
      availableDelta = amountToMove;
      reservedDelta = amountToMove.negated();
      break;
    default:
      throw new TypeError("operation must be credit, reserve, settle or release.");
  }

  const next = {
    available: current.available.plus(availableDelta),
    reserved: current.reserved.plus(reservedDelta),
    consumed: current.consumed.plus(consumedDelta),
  };
  for (const [field, value] of Object.entries(next)) {
    if (!value.isFinite() || value.isNegative()) throw new RangeError(`XTU free ${field} balance cannot become negative.`);
  }
  return { ...next, availableDelta, reservedDelta, consumedDelta };
}

/**
 * Select only explicit, finalized, protected XTU-free custody lots in FIFO
 * order. The initial XTU supply is never eligible because it has no lot here.
 */
function selectXtuFreeConsolidationLots(lots, options = {}) {
  if (!Array.isArray(lots)) throw new TypeError("lots must be an array.");
  const minimum = amount(options.minimumAmount ?? XTU_FREE_CONSOLIDATION_MINIMUM, "minimumAmount");
  const eligible = lots.filter((lot) => {
    if (lot?.confirmed !== true || lot?.protected !== true || String(lot?.status ?? "").toLowerCase() !== "available") return false;
    const available = amount(lot.availableAmount ?? "0", "availableAmount", true);
    const reserved = amount(lot.reservedAmount ?? "0", "reservedAmount", true);
    const receivedAtMs = Number(lot.receivedAtMs);
    if (!Number.isSafeInteger(receivedAtMs) || receivedAtMs <= 0) {
      throw new TypeError("Every eligible XTU free custody lot must have a valid receivedAtMs FIFO timestamp.");
    }
    return available.isGreaterThan(0) && reserved.isZero();
  }).sort((a, b) => {
    const timeDiff = Number(a.receivedAtMs) - Number(b.receivedAtMs);
    if (timeDiff !== 0) return timeDiff;
    return String(a.id).localeCompare(String(b.id), "en", { numeric: true });
  });

  if (!eligible.length) return { eligible: false, amount: new BigNumber(0), lots: [] };
  const firstChain = Number(eligible[0].chainId);
  if (firstChain !== 56) throw new RangeError("XTU free custody consolidation is supported only on BNB Smart Chain Mainnet.");
  const firstContract = normalizeAddress(eligible[0].tokenContract, "tokenContract");
  const compatible = eligible.filter((lot) => Number(lot.chainId) === firstChain &&
    normalizeAddress(lot.tokenContract, "tokenContract") === firstContract);
  const total = compatible.reduce((sum, lot) => sum.plus(amount(lot.availableAmount, "availableAmount")), new BigNumber(0));
  if (total.lt(minimum)) return { eligible: false, amount: total, lots: [] };
  return { eligible: true, amount: total, minimumAmount: minimum, lots: compatible };
}

module.exports = {
  XTU_FREE_DEPOSIT_MINIMUM,
  XTU_FREE_DEPOSIT_MAX_EVENTS,
  XTU_FREE_CONSOLIDATION_MINIMUM,
  calculateXtuFreeDepositAttempt,
  calculateXtuFreeBalanceTransition,
  selectXtuFreeConsolidationLots,
};
