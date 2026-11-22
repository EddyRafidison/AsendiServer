"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  createBscEventIdentity,
  classifyReceiptPair,
  canCommitReconciliation,
} = require("../bsc-reconciliation-policy");

const TX_HASH = `0x${"a".repeat(64)}`;
const BLOCK_HASH = `0x${"b".repeat(64)}`;
const NEW_BLOCK_HASH = `0x${"c".repeat(64)}`;

function receipt(overrides = {}) {
  return {
    transactionHash: TX_HASH,
    status: "0x1",
    blockNumber: "0x64",
    blockHash: BLOCK_HASH,
    ...overrides,
  };
}

function verifiedReceipt(overrides = {}) {
  return {
    receipt: receipt(),
    matchingLog: true,
    matchingLogAmbiguous: false,
    matchingLogIndex: "7",
    canonical: true,
    blockTimestampMs: "1700000000000",
    ...overrides,
  };
}

test("BSC event identity is stable for the same transaction, log and block", () => {
  const first = createBscEventIdentity(TX_HASH, 7, BLOCK_HASH);
  const second = createBscEventIdentity(TX_HASH.toUpperCase(), "007", BLOCK_HASH.toUpperCase());
  assert.equal(first, second);
  assert.match(first, /^[a-f0-9]{64}$/);
});

test("BSC event identity changes when the same transaction is re-included in another block", () => {
  const original = createBscEventIdentity(TX_HASH, 7, BLOCK_HASH);
  const reIncluded = createBscEventIdentity(TX_HASH, 7, NEW_BLOCK_HASH);
  assert.notEqual(original, reIncluded);
});

test("BSC event identity rejects malformed transaction, log-index or block hashes", () => {
  assert.throws(() => createBscEventIdentity("not-a-hash", 0, BLOCK_HASH), /transaction hash/);
  assert.throws(() => createBscEventIdentity(TX_HASH, "-1", BLOCK_HASH), /transaction hash/);
  assert.throws(() => createBscEventIdentity(TX_HASH, 0, "invalid"), /transaction hash/);
});

test("two independent canonical receipts classify an unchanged event as canonical", () => {
  const result = classifyReceiptPair(
    { block_number: "100", block_hash: BLOCK_HASH, log_index: "7" },
    verifiedReceipt(),
    verifiedReceipt(),
  );
  assert.equal(result.classification, "canonical");
  assert.equal(result.observedLogIndex, "7");
});

test("a valid event included in a different canonical block and log position is re-included", () => {
  const movedReceipt = receipt({ blockNumber: "0x65", blockHash: NEW_BLOCK_HASH });
  const moved = verifiedReceipt({
    receipt: movedReceipt,
    matchingLogIndex: "8",
    blockTimestampMs: "1700000003000",
  });
  const result = classifyReceiptPair(
    { block_number: "100", block_hash: BLOCK_HASH, log_index: "7" },
    moved,
    moved,
  );
  assert.equal(result.classification, "re_included");
  assert.equal(result.observedBlock, "101");
  assert.equal(result.observedLogIndex, "8");
});

test("missing receipts alone are unverifiable, not proof of an orphaned transfer", () => {
  const result = classifyReceiptPair(
    { block_number: "100", block_hash: BLOCK_HASH, log_index: "7" },
    { receipt: null, matchingLog: false, matchingLogAmbiguous: false, matchingLogIndex: null, canonical: false },
    { receipt: null, matchingLog: false, matchingLogAmbiguous: false, matchingLogIndex: null, canonical: false },
  );
  assert.equal(result.classification, "unverifiable");
});

test("ambiguous identical transfer logs are not automatically reconciled", () => {
  const result = classifyReceiptPair(
    { block_number: "100", block_hash: BLOCK_HASH, log_index: "7" },
    verifiedReceipt({ matchingLogAmbiguous: true, matchingLog: false, matchingLogIndex: null }),
    verifiedReceipt({ matchingLogAmbiguous: true, matchingLog: false, matchingLogIndex: null }),
  );
  assert.equal(result.classification, "unverifiable");
});

test("RPC disagreement makes an event unverifiable", () => {
  const result = classifyReceiptPair(
    { block_number: "100", block_hash: BLOCK_HASH, log_index: "7" },
    verifiedReceipt(),
    { receipt: null, matchingLog: false, matchingLogAmbiguous: false, matchingLogIndex: null, canonical: false },
  );
  assert.equal(result.classification, "unverifiable");
});

test("reconciliation commit is blocked by unverifiable or uncompensated financial events", () => {
  assert.equal(canCommitReconciliation([{ classification: "unverifiable", financialImpact: 0 }]), false);
  assert.equal(canCommitReconciliation([{ classification: "orphaned", financialImpact: 1, resolutionStatus: "pending" }]), false);
  assert.equal(canCommitReconciliation([{ classification: "orphaned", financialImpact: 1, resolutionStatus: "compensated" }]), true);
  assert.equal(canCommitReconciliation([{ classification: "orphaned", financial_impact: 0, resolution_status: "pending" }]), true);
  assert.equal(canCommitReconciliation([{ classification: "canonical", financial_impact: 1 }]), true);
  assert.equal(canCommitReconciliation([{ classification: "unexpected", financial_impact: 0 }]), false);
  assert.equal(canCommitReconciliation([{ financial_impact: 0 }]), false);
});
