"use strict";

const BigNumber = require("bignumber.js");
const { DEPOSIT_MIN_AMOUNT, DEPOSIT_MAX_AMOUNT } = require("./deposit-limits");

BigNumber.config({ DECIMAL_PLACES: 36, ROUNDING_MODE: BigNumber.ROUND_HALF_UP });

const XTU_DECIMALS = 18;
const XTU_SCALE = 10n ** 18n;
const XTU_TRANSFER_FEE_BPS = 10n;
const BPS_DENOMINATOR = 10_000n;
const MIN_XTU_DEPOSIT = new BigNumber(DEPOSIT_MIN_AMOUNT);
const MAX_XTU_DEPOSIT = new BigNumber(DEPOSIT_MAX_AMOUNT);
const MAX_INITIAL_CREDIT_XTU = new BigNumber(DEPOSIT_MAX_AMOUNT);
const DEPOSIT_PENDING_EXPIRATION_MS = 30 * 24 * 60 * 60 * 1000;
// Pending retries are an operational cadence only; they never alter the immutable 30-day expiry.
const DEPOSIT_PENDING_RETRY_MS = 30 * 1000;
const ONEX_DEPOSIT_FEE_FACTOR = new BigNumber("0.75");

function nonNegative(value, name) {
  const amount = new BigNumber(String(value));
  if (!amount.isFinite() || amount.isNegative()) throw new RangeError(`${name} must be finite and non-negative.`);
  return amount;
}

function positive(value, name) {
  const amount = nonNegative(value, name);
  if (!amount.isGreaterThan(0)) throw new RangeError(`${name} must be positive.`);
  return amount;
}

function toRaw(value, decimals = XTU_DECIMALS) {
  const amount = positive(value, "XTU amount");
  const raw = amount.shiftedBy(decimals).integerValue(BigNumber.ROUND_DOWN);
  if (!raw.isInteger() || !raw.isGreaterThan(0)) throw new RangeError("XTU amount is below the token precision.");
  return BigInt(raw.toFixed(0));
}

function fromRaw(raw) {
  const value = BigInt(raw);
  if (value < 0n) throw new RangeError("Raw XTU amount cannot be negative.");
  return new BigNumber(value.toString()).shiftedBy(-XTU_DECIMALS);
}

function calculateDepositFeeRate(tfeesRatePercent, globalDisbursementActive) {
  const tfees = nonNegative(tfeesRatePercent, "tfees rate");
  if (!tfees.isLessThan(100)) throw new RangeError("tfees rate must be below 100%.");
  return globalDisbursementActive ? new BigNumber(0) : tfees.multipliedBy(ONEX_DEPOSIT_FEE_FACTOR);
}

function calculateXtuDepositCredit({
  grossReturnedXtu,
  actualGasFeeBscUsd,
  tfeesRatePercent,
  globalDisbursementActive = false,
  globalUnitPrice,
  maximumInitialCreditXtu = MAX_INITIAL_CREDIT_XTU,
}) {
  const gross = positive(grossReturnedXtu, "Gross returned XTU");
  const gas = nonNegative(actualGasFeeBscUsd, "Actual BSC gas fee");
  const price = positive(globalUnitPrice, "Global unit price");
  const trancheCap = positive(maximumInitialCreditXtu, "Maximum initial XTU credit tranche");
  if (trancheCap.gt(MAX_XTU_DEPOSIT)) throw new RangeError("The initial XTU credit tranche cannot exceed the per-session deposit maximum.");
  const feeRate = calculateDepositFeeRate(tfeesRatePercent, globalDisbursementActive);
  const depositFee = globalDisbursementActive
    ? new BigNumber(0)
    : gross.multipliedBy(feeRate).dividedBy(100).decimalPlaces(XTU_DECIMALS, BigNumber.ROUND_DOWN);
  const creditable = gross.minus(depositFee).minus(gas)
    .decimalPlaces(XTU_DECIMALS, BigNumber.ROUND_DOWN);
  if (!creditable.isGreaterThan(0)) throw new RangeError("The XTU deposit fees and actual gas consume the returned amount.");
  const initialCreditXtu = BigNumber.minimum(creditable, trancheCap);
  const deferredCreditXtu = creditable.minus(initialCreditXtu);
  const initialAsset = initialCreditXtu.dividedBy(price).decimalPlaces(30, BigNumber.ROUND_DOWN);
  if (!initialAsset.isGreaterThan(0)) throw new RangeError("The XTU deposit is too small to credit an initial-asset unit.");
  return {
    grossReturnedXtu: gross,
    depositFeeRatePercent: feeRate,
    depositFeeXtu: depositFee,
    actualGasFeeBscUsd: gas,
    actualGasFeeXtu: gas,
    creditableXtu: creditable,
    initialCreditXtu,
    deferredCreditXtu,
    maximumInitialCreditXtu: trancheCap,
    globalUnitPrice: price,
    creditedInitialAsset: initialAsset,
  };
}


/**
 * Calculate one credit tranche from a deposit whose OneX fee and actual gas
 * have already been determined for the complete returned amount. The first
 * tranche has its own cap; later tranches can consume the retained remainder.
 */
function calculateXtuDepositTranche({
  grossReturnedXtu,
  actualGasFeeBscUsd,
  tfeesRatePercent,
  globalDisbursementActive = false,
  globalUnitPrice,
  creditedBeforeXtu = 0,
  grossCreditedBeforeXtu = 0,
  gasCreditedBeforeXtu = 0,
  creditSequence = 0,
  maximumInitialCreditXtu = MAX_INITIAL_CREDIT_XTU,
}) {
  const gross = positive(grossReturnedXtu, "Gross returned XTU");
  const gasTotal = nonNegative(actualGasFeeBscUsd, "Batch gas provision or actual gas");
  const price = positive(globalUnitPrice, "Global unit price");
  const feeRate = calculateDepositFeeRate(tfeesRatePercent, globalDisbursementActive);
  const creditedBefore = nonNegative(creditedBeforeXtu, "Previously credited XTU");
  const grossCreditedBefore = nonNegative(grossCreditedBeforeXtu, "Previously processed gross XTU");
  const gasCreditedBefore = nonNegative(gasCreditedBeforeXtu, "Previously allocated gas XTU");
  if (grossCreditedBefore.gt(gross)) {
    throw new RangeError("Previously processed gross XTU cannot exceed the deposit gross amount.");
  }
  if (gasCreditedBefore.gt(gasTotal)) {
    throw new RangeError("Previously allocated gas cannot exceed the batch gas provision.");
  }
  const remainingGross = gross.minus(grossCreditedBefore);
  if (!remainingGross.isGreaterThan(0)) {
    throw new RangeError("The XTU deposit has no remaining gross amount to process.");
  }
  const sequence = Number(creditSequence);
  if (!Number.isSafeInteger(sequence) || sequence < 0) {
    throw new RangeError("Credit sequence must be a non-negative safe integer.");
  }
  const trancheCap = positive(maximumInitialCreditXtu, "Maximum XTU credit tranche");
  if (trancheCap.gt(MAX_XTU_DEPOSIT)) {
    throw new RangeError("The XTU credit tranche cannot exceed 100 XTU.");
  }

  const trancheGross = BigNumber.minimum(remainingGross, trancheCap);
  const feeForTranche = globalDisbursementActive
    ? new BigNumber(0)
    : trancheGross.multipliedBy(feeRate).dividedBy(100).decimalPlaces(XTU_DECIMALS, BigNumber.ROUND_DOWN);
  const isLastTranche = trancheGross.eq(remainingGross);
  const gasForTranche = isLastTranche
    ? gasTotal.minus(gasCreditedBefore)
    : gasTotal.multipliedBy(trancheGross).dividedBy(gross).decimalPlaces(XTU_DECIMALS, BigNumber.ROUND_DOWN);
  if (gasForTranche.isNegative()) throw new RangeError("The allocated XTU gas share cannot be negative.");
  const creditable = trancheGross.minus(feeForTranche).minus(gasForTranche)
    .decimalPlaces(XTU_DECIMALS, BigNumber.ROUND_DOWN);
  if (!creditable.isGreaterThan(0)) {
    throw new RangeError("This XTU credit tranche is fully consumed by its OneX deposit fee and gas provision.");
  }
  const initialAsset = creditable.dividedBy(price).decimalPlaces(30, BigNumber.ROUND_DOWN);
  if (!initialAsset.isGreaterThan(0)) {
    throw new RangeError("The XTU credit tranche is too small to credit an initial-asset unit.");
  }
  const totalFee = globalDisbursementActive
    ? new BigNumber(0)
    : gross.multipliedBy(feeRate).dividedBy(100).decimalPlaces(XTU_DECIMALS, BigNumber.ROUND_DOWN);
  const totalCreditable = BigNumber.maximum(0, gross.minus(totalFee).minus(gasTotal));
  return {
    grossReturnedXtu: gross,
    grossProcessedBeforeXtu: grossCreditedBefore,
    trancheGrossXtu: trancheGross,
    remainingGrossBeforeTrancheXtu: remainingGross,
    depositFeeRatePercent: feeRate,
    depositFeeXtu: feeForTranche,
    actualGasFeeBscUsd: gasForTranche,
    actualGasFeeXtu: gasForTranche,
    totalGasFeeXtu: gasTotal,
    totalDepositFeeXtu: totalFee,
    totalCreditableXtu: totalCreditable,
    previouslyCreditedXtu: creditedBefore,
    previouslyAllocatedGasXtu: gasCreditedBefore,
    creditableXtu: creditable,
    initialCreditXtu: creditable,
    deferredCreditXtu: remainingGross.minus(trancheGross),
    maximumInitialCreditXtu: trancheCap,
    globalUnitPrice: price,
    creditedInitialAsset: initialAsset,
    creditSequence: sequence + 1,
  };
}

/**
 * Split a real gas expense across a deterministically sorted batch. Rounding
 * is down to 18 decimals for all rows except the last, which receives the
 * exact remainder so that allocated gas equals the receipt cost exactly.
 */
function allocateBatchGasByGross(rows, totalGasFee, key = "event_identity") {
  if (!Array.isArray(rows) || rows.length === 0) {
    if (nonNegative(totalGasFee, "Batch gas fee").isZero()) return [];
    throw new RangeError("Cannot allocate gas to an empty XTU deposit batch.");
  }
  const gas = nonNegative(totalGasFee, "Batch gas fee").decimalPlaces(XTU_DECIMALS, BigNumber.ROUND_DOWN);
  const normalized = rows.map((row) => ({
    key: String(row[key] ?? row.id ?? ""),
    gross: positive(row.gross_amount ?? row.grossAmount, "Deposit event gross amount"),
  })).sort((a, b) => a.key.localeCompare(b.key));
  const totalGross = normalized.reduce((sum, row) => sum.plus(row.gross), new BigNumber(0));
  if (!totalGross.isGreaterThan(0)) throw new RangeError("Batch gross amount must be positive.");
  let allocated = new BigNumber(0);
  return normalized.map((row, index) => {
    const amount = index === normalized.length - 1
      ? gas.minus(allocated)
      : gas.multipliedBy(row.gross).dividedBy(totalGross).decimalPlaces(XTU_DECIMALS, BigNumber.ROUND_DOWN);
    allocated = allocated.plus(amount);
    return { key: row.key, grossAmount: row.gross, gasFee: amount };
  });
}

function selectXtuConsolidationBatches(candidates, minimumConsolidationAmount = "100") {
  if (!Array.isArray(candidates)) throw new TypeError("XTU consolidation candidates must be an array.");
  const minimum = positive(minimumConsolidationAmount, "Minimum XTU consolidation batch");
  if (minimum.lt("100")) throw new RangeError("The minimum XTU consolidation batch cannot be below 100 XTU.");

  const ordered = [...candidates].sort((a, b) => {
    const leftTime = Number(a.first_finalized_at_ms ?? a.opened_at_ms ?? a.created_at_ms ?? 0);
    const rightTime = Number(b.first_finalized_at_ms ?? b.opened_at_ms ?? b.created_at_ms ?? 0);
    if (leftTime !== rightTime) return leftTime - rightTime;
    const left = BigInt(String(a.id));
    const right = BigInt(String(b.id));
    return left < right ? -1 : left > right ? 1 : 0;
  });

  const selected = [];
  let received = new BigNumber(0);
  let grossReturned = new BigNumber(0);
  for (const batch of ordered) {
    const hotReceived = nonNegative(batch.hot_wallet_received_amount ?? 0, "Hot Wallet received amount");
    const alreadyConsolidated = nonNegative(batch.hot_wallet_consolidated_amount ?? 0, "Previously consolidated XTU");
    const alreadyReserved = nonNegative(batch.consolidation_reserved_amount ?? 0, "Reserved XTU consolidation amount");
    const available = BigNumber.maximum(0, hotReceived.minus(alreadyConsolidated).minus(alreadyReserved));
    if (!available.isGreaterThan(0)) continue;
    const gross = nonNegative(batch.gross_amount ?? 0, "Gross returned XTU amount");
    selected.push({ ...batch, consolidation_available_amount: available.toFixed(18) });
    received = received.plus(available);
    grossReturned = grossReturned.plus(gross);
    if (received.gte(minimum)) {
      return {
        batches: selected,
        totalHotWalletReceivedXtu: received,
        totalGrossReturnedXtu: grossReturned,
        minimumConsolidationAmount: minimum,
      };
    }
  }
  return null;
}

function classifyDepositSession({ incomingGross, currentBatchGross = 0 }) {
  const incoming = positive(incomingGross, "Incoming XTU deposit");
  const batch = nonNegative(currentBatchGross, "Current XTU deposit session");
  const projectedSession = batch.plus(incoming);
  return {
    allowed: true,
    status: projectedSession.gte(MIN_XTU_DEPOSIT) ? "eligible" : "collecting",
    projectedSession,
    creditTrancheLimit: new BigNumber(MAX_XTU_DEPOSIT),
    requiresMultipleCreditTranches: projectedSession.gt(MAX_XTU_DEPOSIT),
  };
}

/** Find the smallest gross raw amount whose Solidity 0.1% fee leaves exact net raw. */
function grossForExactNetRaw(netRawValue) {
  const targetNet = BigInt(netRawValue);
  if (targetNet <= 0n) throw new RangeError("Settlement net XTU amount must be positive.");
  let gross = (targetNet * BPS_DENOMINATOR + (BPS_DENOMINATOR - XTU_TRANSFER_FEE_BPS) - 1n) /
    (BPS_DENOMINATOR - XTU_TRANSFER_FEE_BPS);
  const netFor = (value) => value - (value * XTU_TRANSFER_FEE_BPS) / BPS_DENOMINATOR;
  while (netFor(gross) < targetNet) gross += 1n;
  while (gross > 1n && netFor(gross - 1n) >= targetNet) gross -= 1n;
  const fee = (gross * XTU_TRANSFER_FEE_BPS) / BPS_DENOMINATOR;
  return { grossRaw: gross, feeRaw: fee, netRaw: netFor(gross) };
}

function calculateXtuSettlementQuote(netAmount) {
  const netRaw = toRaw(netAmount);
  const quote = grossForExactNetRaw(netRaw);
  return {
    requestedNet: fromRaw(netRaw),
    grossAmount: fromRaw(quote.grossRaw),
    contractFeeAmount: fromRaw(quote.feeRaw),
    actualNetAmount: fromRaw(quote.netRaw),
    grossRaw: quote.grossRaw.toString(),
    contractFeeRaw: quote.feeRaw.toString(),
    netRaw: quote.netRaw.toString(),
  };
}

module.exports = {
  XTU_DECIMALS,
  XTU_SCALE,
  XTU_TRANSFER_FEE_BPS,
  MIN_XTU_DEPOSIT,
  MAX_XTU_DEPOSIT,
  MAX_INITIAL_CREDIT_XTU,
  DEPOSIT_PENDING_EXPIRATION_MS,
  DEPOSIT_PENDING_RETRY_MS,
  calculateDepositFeeRate,
  calculateXtuDepositCredit,
  calculateXtuDepositTranche,
  allocateBatchGasByGross,
  classifyDepositSession,
  selectXtuConsolidationBatches,
  grossForExactNetRaw,
  calculateXtuSettlementQuote,
};
