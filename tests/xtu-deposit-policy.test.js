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
  classifyWeeklyDeposit,
  calculateXtuSettlementQuote,
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

test("XTU first-credit tranche cap is independent from the 70-140 weekly receipt range", () => {
  assert.equal(MAX_INITIAL_CREDIT_XTU.toFixed(), "100");
  const first = calculateXtuDepositTranche({
    grossReturnedXtu: "140",
    actualGasFeeBscUsd: "0.2",
    tfeesRatePercent: "4",
    globalDisbursementActive: false,
    globalUnitPrice: "2",
    creditedBeforeXtu: "0",
    creditSequence: 0,
  });
  assert.equal(first.depositFeeXtu.toFixed(8), "4.20000000");
  assert.equal(first.creditableXtu.toFixed(8), "100.00000000");
  assert.equal(first.deferredCreditXtu.toFixed(8), "35.60000000");
  assert.equal(first.creditedInitialAsset.toFixed(8), "50.00000000");

  const second = calculateXtuDepositTranche({
    grossReturnedXtu: "140",
    actualGasFeeBscUsd: "0.2",
    tfeesRatePercent: "4",
    globalDisbursementActive: false,
    globalUnitPrice: "2",
    creditedBeforeXtu: "100",
    creditSequence: 1,
  });
  assert.equal(second.creditableXtu.toFixed(8), "35.60000000");
  assert.equal(second.depositFeeXtu.toFixed(8), "4.20000000");
  assert.equal(second.actualGasFeeXtu.toFixed(8), "0.20000000");
  assert.equal(second.creditedInitialAsset.toFixed(8), "17.80000000");
});

test("XTU first-tranche cap does not apply during global disbursement, while gas still applies", () => {
  const tranche = calculateXtuDepositTranche({
    grossReturnedXtu: "140",
    actualGasFeeBscUsd: "0.2",
    tfeesRatePercent: "4",
    globalDisbursementActive: true,
    globalUnitPrice: "2",
    creditedBeforeXtu: "0",
    creditSequence: 0,
  });
  assert.equal(tranche.depositFeeXtu.toFixed(8), "0.00000000");
  assert.equal(tranche.creditableXtu.toFixed(8), "100.00000000");
  assert.equal(tranche.deferredCreditXtu.toFixed(8), "39.80000000");
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

test("XTU deposit weekly receive limits are separate from first-credit tranche settings", () => {
  assert.equal(MIN_XTU_DEPOSIT.toFixed(), "70");
  assert.equal(MAX_XTU_DEPOSIT.toFixed(), "140");
  assert.equal(classifyWeeklyDeposit({ previousSevenDayGross: "0", incomingGross: "70" }).status, "eligible");
  assert.equal(classifyWeeklyDeposit({ previousSevenDayGross: "80", incomingGross: "70" }).status, "pending_weekly");
});

test("XTU settlement gross-up accounts for contract 0.1% fee and preserves exact net", () => {
  const quote = calculateXtuSettlementQuote("99.8001");
  assert.equal(quote.requestedNet.toFixed(18), "99.800100000000000000");
  assert.equal(quote.actualNetAmount.toFixed(18), "99.800100000000000000");
  assert.equal(quote.grossAmount.minus(quote.contractFeeAmount).toFixed(18), "99.800100000000000000");
});
