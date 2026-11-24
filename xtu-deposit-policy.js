"use strict";

const BigNumber = require("bignumber.js");

BigNumber.config({ DECIMAL_PLACES: 36, ROUNDING_MODE: BigNumber.ROUND_HALF_UP });

const XTU_DECIMALS = 18;
const XTU_SCALE = 10n ** 18n;
const XTU_TRANSFER_FEE_BPS = 10n;
const BPS_DENOMINATOR = 10_000n;
const MIN_XTU_DEPOSIT = new BigNumber("70");
const MAX_XTU_DEPOSIT = new BigNumber("140");
const MAX_INITIAL_CREDIT_XTU = new BigNumber(process.env.XTU_DEPOSIT_MAX_INITIAL_CREDIT_XTU || "100");
const DEPOSIT_BATCH_WINDOW_MS = 60 * 60 * 1000;
const DEPOSIT_MAX_INITIAL_GROUPING_MS = 30 * 24 * 60 * 60 * 1000;
const DEPOSIT_PENDING_RETRY_MS = 7 * 24 * 60 * 60 * 1000;
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
  if (trancheCap.gt(MAX_XTU_DEPOSIT)) throw new RangeError("The initial XTU credit tranche cannot exceed the maximum weekly intake.");
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
  creditSequence = 0,
  maximumInitialCreditXtu = MAX_INITIAL_CREDIT_XTU,
}) {
  const gross = positive(grossReturnedXtu, "Gross returned XTU");
  const total = calculateXtuDepositCredit({
    grossReturnedXtu: gross,
    actualGasFeeBscUsd,
    tfeesRatePercent,
    globalDisbursementActive,
    globalUnitPrice,
    maximumInitialCreditXtu: gross,
  });
  const creditedBefore = nonNegative(creditedBeforeXtu, "Previously credited XTU");
  if (creditedBefore.gt(total.creditableXtu)) {
    throw new RangeError("Previously credited XTU cannot exceed the deposit's total creditable amount.");
  }
  const remaining = total.creditableXtu.minus(creditedBefore);
  if (!remaining.isGreaterThan(0)) {
    throw new RangeError("The XTU deposit has no remaining creditable amount.");
  }
  const sequence = Number(creditSequence);
  if (!Number.isSafeInteger(sequence) || sequence < 0) {
    throw new RangeError("Credit sequence must be a non-negative safe integer.");
  }
  const firstTrancheCap = positive(maximumInitialCreditXtu, "Maximum first XTU credit tranche");
  if (firstTrancheCap.gt(MAX_XTU_DEPOSIT)) {
    throw new RangeError("The first XTU credit tranche cannot exceed the maximum weekly intake.");
  }
  const tranche = sequence === 0 ? BigNumber.minimum(remaining, firstTrancheCap) : remaining;
  const initialAsset = tranche.dividedBy(total.globalUnitPrice).decimalPlaces(30, BigNumber.ROUND_DOWN);
  if (!initialAsset.isGreaterThan(0)) {
    throw new RangeError("The XTU credit tranche is too small to credit an initial-asset unit.");
  }
  return {
    ...total,
    totalCreditableXtu: total.creditableXtu,
    previouslyCreditedXtu: creditedBefore,
    remainingBeforeTrancheXtu: remaining,
    creditableXtu: tranche,
    initialCreditXtu: tranche,
    deferredCreditXtu: remaining.minus(tranche),
    creditedInitialAsset: initialAsset,
    creditSequence: sequence + 1,
    maximumInitialCreditXtu: firstTrancheCap,
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

function classifyWeeklyDeposit({ previousSevenDayGross, incomingGross, currentBatchGross = 0 }) {
  const previous = nonNegative(previousSevenDayGross, "Previous seven-day XTU deposits");
  const incoming = positive(incomingGross, "Incoming XTU deposit");
  const batch = nonNegative(currentBatchGross, "Current XTU deposit batch");
  const projectedWeekly = previous.plus(incoming);
  const projectedBatch = batch.plus(incoming);
  if (incoming.gt(MAX_XTU_DEPOSIT) || projectedBatch.gt(MAX_XTU_DEPOSIT) || projectedWeekly.gt(MAX_XTU_DEPOSIT)) {
    return { allowed: false, status: "pending_weekly", projectedWeekly, projectedBatch };
  }
  return {
    allowed: true,
    status: projectedBatch.gte(MIN_XTU_DEPOSIT) ? "eligible" : "collecting", projectedWeekly, projectedBatch,
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
  DEPOSIT_BATCH_WINDOW_MS,
  DEPOSIT_MAX_INITIAL_GROUPING_MS,
  DEPOSIT_PENDING_RETRY_MS,
  calculateDepositFeeRate,
  calculateXtuDepositCredit,
  calculateXtuDepositTranche,
  allocateBatchGasByGross,
  classifyWeeklyDeposit,
  grossForExactNetRaw,
  calculateXtuSettlementQuote,
};
