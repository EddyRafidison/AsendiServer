"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  MIN_XTU_DEPOSIT,
  MAX_XTU_DEPOSIT,
  MAX_INITIAL_CREDIT_XTU,
  calculateDepositFeeRate,
  calculateXtuDepositCredit,
  calculateXtuDepositTranche,
  allocateBatchGasByGross,
  classifyDepositSession,
  calculateXtuSettlementQuote,
  selectXtuConsolidationBatches,
} = require("../xtu-deposit-policy");

test("XTU deposit fee is 75% of tfees outside global disbursement and zero during it", () => {
  assert.equal(calculateDepositFeeRate("4", false).toFixed(), "3");
  assert.equal(calculateDepositFeeRate("4", true).toFixed(), "0");
});

test("XTU deposit credit deducts OneX deposit fee and real gas, then uses the global price", () => {
  const outside = calculateXtuDepositCredit({
    grossReturnedXtu: "100",
    actualGasFeeBscUsd: "0.2",
    tfeesRatePercent: "4",
    globalDisbursementActive: false,
    globalUnitPrice: "2",
  });
  assert.equal(outside.depositFeeXtu.toFixed(8), "3.00000000");
  assert.equal(outside.creditableXtu.toFixed(8), "96.80000000");
  assert.equal(outside.creditedInitialAsset.toFixed(8), "48.40000000");

  const during = calculateXtuDepositCredit({
    grossReturnedXtu: "100",
    actualGasFeeBscUsd: "0.2",
    tfeesRatePercent: "4",
    globalDisbursementActive: true,
    globalUnitPrice: "2",
  });
  assert.equal(during.depositFeeXtu.toFixed(8), "0.00000000");
  assert.equal(during.creditableXtu.toFixed(8), "99.80000000");
});

test("XTU first-credit tranche cap is independent from the shared 20-100 session limits", () => {
  assert.equal(MAX_INITIAL_CREDIT_XTU.toFixed(), "100");
  const first = calculateXtuDepositTranche({
    grossReturnedXtu: "100",
    actualGasFeeBscUsd: "0.2",
    tfeesRatePercent: "4",
    globalDisbursementActive: false,
    globalUnitPrice: "2",
    creditedBeforeXtu: "0",
    creditSequence: 0,
    maximumInitialCreditXtu: "50",
  });
  assert.equal(first.depositFeeXtu.toFixed(8), "3.00000000");
  assert.equal(first.creditableXtu.toFixed(8), "50.00000000");
  assert.equal(first.deferredCreditXtu.toFixed(8), "46.80000000");
  assert.equal(first.creditedInitialAsset.toFixed(8), "25.00000000");

  const second = calculateXtuDepositTranche({
    grossReturnedXtu: "100",
    actualGasFeeBscUsd: "0.2",
    tfeesRatePercent: "4",
    globalDisbursementActive: false,
    globalUnitPrice: "2",
    creditedBeforeXtu: "50",
    creditSequence: 1,
  });
  assert.equal(second.creditableXtu.toFixed(8), "46.80000000");
  assert.equal(second.depositFeeXtu.toFixed(8), "3.00000000");
  assert.equal(second.actualGasFeeXtu.toFixed(8), "0.20000000");
  assert.equal(second.creditedInitialAsset.toFixed(8), "23.40000000");
});

test("XTU first-tranche cap does not apply during global disbursement, while gas still applies", () => {
  const tranche = calculateXtuDepositTranche({
    grossReturnedXtu: "100",
    actualGasFeeBscUsd: "0.2",
    tfeesRatePercent: "4",
    globalDisbursementActive: true,
    globalUnitPrice: "2",
    creditedBeforeXtu: "0",
    creditSequence: 0,
  });
  assert.equal(tranche.depositFeeXtu.toFixed(8), "0.00000000");
  assert.equal(tranche.creditableXtu.toFixed(8), "99.80000000");
  assert.equal(tranche.deferredCreditXtu.toFixed(8), "0.00000000");
});

test("batch gas allocation is deterministic and reconciles to the exact gas receipt cost", () => {
  const allocated = allocateBatchGasByGross([
    { event_identity: "b", gross_amount: "20" },
    { event_identity: "a", gross_amount: "30" },
    { event_identity: "c", gross_amount: "50" },
  ], "0.123456789012345678");
  assert.deepEqual(allocated.map((row) => row.key), ["a", "b", "c"]);
  const total = allocated.reduce((sum, row) => sum.plus(row.gasFee), new (require("bignumber.js"))(0));
  assert.equal(total.toFixed(18), "0.123456789012345678");
});

test("XTU applies the shared 20-100 gross limits to each 60-minute session, not to a rolling-week amount", () => {
  assert.equal(MIN_XTU_DEPOSIT.toFixed(), "20");
  assert.equal(MAX_XTU_DEPOSIT.toFixed(), "100");
  assert.equal(classifyDepositSession({ incomingGross: "20" }).status, "eligible");
  assert.equal(classifyDepositSession({ incomingGross: "30", currentBatchGross: "70" }).status, "eligible");
  assert.equal(classifyDepositSession({ incomingGross: "19.999999999999999999" }).status, "collecting");
  const oversizedTransfer = classifyDepositSession({ incomingGross: "100.000000000000000001" });
  assert.equal(oversizedTransfer.status, "pending_support");
  assert.equal(oversizedTransfer.reason, "deposit_amount_above_maximum");
  const oversizedSession = classifyDepositSession({ incomingGross: "40", currentBatchGross: "70" });
  assert.equal(oversizedSession.status, "pending_support");
  assert.equal(oversizedSession.reason, "deposit_session_above_maximum");
});

test("XTU consolidation waits until identified Hot Wallet receipts reach 100 XTU", () => {
  const single = selectXtuConsolidationBatches([
    { id: "1", gross_amount: "100", hot_wallet_received_amount: "99.9" },
  ], "100");
  assert.equal(single, null);

  const selected = selectXtuConsolidationBatches([
    { id: "3", gross_amount: "80", hot_wallet_received_amount: "79.92" },
    { id: "2", gross_amount: "41", hot_wallet_received_amount: "40.959" },
    { id: "1", gross_amount: "60", hot_wallet_received_amount: "59.94" },
  ], "100");
  assert.deepEqual(selected.batches.map((batch) => batch.id), ["1", "2"]);
  assert.equal(selected.totalGrossReturnedXtu.toFixed(18), "101.000000000000000000");
  assert.equal(selected.totalHotWalletReceivedXtu.toFixed(18), "100.899000000000000000");
  assert.throws(() => selectXtuConsolidationBatches([], "99"), /cannot be below 100 XTU/);
});

test("XTU settlement gross-up accounts for contract 0.1% fee and preserves exact net", () => {
  const quote = calculateXtuSettlementQuote("99.8001");
  assert.equal(quote.requestedNet.toFixed(18), "99.800100000000000000");
  assert.equal(quote.actualNetAmount.toFixed(18), "99.800100000000000000");
  assert.equal(quote.grossAmount.minus(quote.contractFeeAmount).toFixed(18), "99.800100000000000000");
});
