"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  XTU_FREE_DEPOSIT_MINIMUM,
  XTU_FREE_DEPOSIT_MAX_EVENTS,
  XTU_FREE_CONSOLIDATION_MINIMUM,
  calculateXtuFreeDepositAttempt,
  calculateXtuFreeBalanceTransition,
  selectXtuFreeConsolidationLots,
} = require("../xtu-free-accounting");

const source = "0x1111111111111111111111111111111111111111";
const contract = "0x2222222222222222222222222222222222222222";

function event(n, grossAmount, overrides = {}) {
  return {
    chainId: 56,
    tokenContract: contract,
    sourceAddress: source,
    txHash: `0x${String(n).padStart(64, "0")}`,
    logIndex: 0,
    grossAmount,
    tfeesRatePercent: "0",
    campaignPhase: "ordinary",
    finalized: true,
    ...overrides,
  };
}

test("XTU free-deposit qualification uses one net XTU and at most five unique finalized events", () => {
  assert.equal(XTU_FREE_DEPOSIT_MINIMUM.toFixed(), "1");
  assert.equal(XTU_FREE_DEPOSIT_MAX_EVENTS, 5);
  const result = calculateXtuFreeDepositAttempt([
    event(1, "0.4"), event(2, "0.4"), event(3, "0.21"),
  ]);
  assert.equal(result.qualified, true);
  assert.equal(result.qualifiedAtSequence, 3);
  assert.equal(result.grossAmount.toFixed(18), "1.010000000000000000");
  assert.equal(result.netAmount.toFixed(18), "1.010000000000000000");
  assert.equal(result.expiresAtMs, null);
  assert.match(result.events[0].eventIdentity, /^[0-9a-f]{64}$/);
});

test("ordinary XTU free-deposit tfees are calculated per event and applied provisionally", () => {
  const result = calculateXtuFreeDepositAttempt([
    event(1, "0.5", { tfeesRatePercent: "1" }),
    event(2, "0.51", { tfeesRatePercent: "1" }),
  ]);
  assert.equal(result.feeAmount.toFixed(18), "0.010100000000000000");
  assert.equal(result.netAmount.toFixed(18), "0.999900000000000000");
  assert.equal(result.qualified, false);
});

test("XTU free-deposit global phases force the receive tfees rate to zero", () => {
  const result = calculateXtuFreeDepositAttempt([
    event(1, "0.6", { tfeesRatePercent: "10", campaignPhase: "global_primary" }),
    event(2, "0.4", { tfeesRatePercent: "10", campaignPhase: "global_extension" }),
  ]);
  assert.equal(result.qualified, true);
  assert.equal(result.feeAmount.toFixed(18), "0.000000000000000000");
  assert.equal(result.netAmount.toFixed(18), "1.000000000000000000");
});

test("the sixth event disqualifies an XTU free-deposit attempt if the first five did not qualify", () => {
  const result = calculateXtuFreeDepositAttempt([
    event(1, "0.1"), event(2, "0.1"), event(3, "0.1"),
    event(4, "0.1"), event(5, "0.1"), event(6, "0.1"),
  ]);
  assert.equal(result.qualified, false);
  assert.equal(result.disqualified, true);
  assert.equal(result.uniqueFinalizedEventCount, 6);
  assert.equal(result.events.length, 6);
});

test("a qualified attempt closes at its qualifying event and leaves later events for a new attempt", () => {
  const result = calculateXtuFreeDepositAttempt([
    event(1, "0.2"), event(2, "0.2"), event(3, "0.2"),
    event(4, "0.2"), event(5, "0.2"), event(6, "5"),
  ]);
  assert.equal(result.qualified, true);
  assert.equal(result.qualifiedAtSequence, 5);
  assert.equal(result.events.length, 5);
  assert.equal(result.trailingEvents.length, 1);
  assert.equal(result.netAmount.toFixed(18), "1.000000000000000000");
});

test("non-finalized and duplicate blockchain events do not inflate the XTU free-deposit attempt", () => {
  const first = event(1, "0.75");
  const duplicate = { ...first };
  const pending = event(2, "1", { finalized: false });
  const result = calculateXtuFreeDepositAttempt([first, duplicate, pending]);
  assert.equal(result.uniqueFinalizedEventCount, 1);
  assert.equal(result.netAmount.toFixed(18), "0.750000000000000000");
  assert.equal(result.qualified, false);
});

test("XTU free balance transitions preserve available, reserved and consumed separation", () => {
  const credit = calculateXtuFreeBalanceTransition({}, "credit", "10");
  assert.equal(credit.available.toFixed(18), "10.000000000000000000");
  const reserve = calculateXtuFreeBalanceTransition(credit, "reserve", "4");
  assert.equal(reserve.available.toFixed(18), "6.000000000000000000");
  assert.equal(reserve.reserved.toFixed(18), "4.000000000000000000");
  const settle = calculateXtuFreeBalanceTransition(reserve, "settle", "3");
  assert.equal(settle.reserved.toFixed(18), "1.000000000000000000");
  assert.equal(settle.consumed.toFixed(18), "3.000000000000000000");
  const release = calculateXtuFreeBalanceTransition(settle, "release", "1");
  assert.equal(release.available.toFixed(18), "7.000000000000000000");
  assert.equal(release.reserved.toFixed(18), "0.000000000000000000");
  assert.throws(() => calculateXtuFreeBalanceTransition({}, "reserve", "0.1"), /cannot become negative/);
});

function lot(id, amount, overrides = {}) {
  return {
    id,
    chainId: 56,
    tokenContract: contract,
    availableAmount: amount,
    reservedAmount: "0",
    receivedAtMs: id * 1000,
    confirmed: true,
    protected: true,
    status: "available",
    ...overrides,
  };
}

test("XTU free custody consolidation is FIFO and requires at least 100 XTU", () => {
  assert.equal(XTU_FREE_CONSOLIDATION_MINIMUM.toFixed(), "100");
  const insufficient = selectXtuFreeConsolidationLots([lot(1, "60"), lot(2, "30")]);
  assert.equal(insufficient.eligible, false);
  assert.equal(insufficient.amount.toFixed(), "90");
  const ready = selectXtuFreeConsolidationLots([
    lot(3, "50"), lot(1, "40"), lot(2, "30"),
    lot(4, "500", { protected: false }),
    lot(5, "500", { reservedAmount: "1" }),
  ]);
  assert.equal(ready.eligible, true);
  assert.deepEqual(ready.lots.map((item) => item.id), [1, 2, 3]);
  assert.equal(ready.amount.toFixed(), "120");
});
