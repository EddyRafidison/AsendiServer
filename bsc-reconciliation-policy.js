"use strict";

const crypto = require("crypto");

function createBscEventIdentity(txHash, logIndex, blockHash) {
  const normalizedHash = String(txHash || "").trim().toLowerCase();
  const normalizedIndex = String(logIndex ?? "").trim();
  const normalizedBlockHash = String(blockHash || "").trim().toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(normalizedHash) || !/^\d{1,10}$/.test(normalizedIndex) ||
      !/^0x[0-9a-f]{64}$/.test(normalizedBlockHash)) {
    throw new TypeError("A valid transaction hash, log index and block hash are required for BSC event identity.");
  }
  return crypto.createHash("sha256")
    .update(`${normalizedHash}:${BigInt(normalizedIndex).toString()}:${normalizedBlockHash}`)
    .digest("hex");
}

function receiptFingerprint(receipt) {
  if (!receipt) return null;
  return {
    transactionHash: String(receipt.transactionHash || "").toLowerCase(),
    status: String(receipt.status || "").toLowerCase(),
    blockNumber: BigInt(receipt.blockNumber || 0).toString(),
    blockHash: String(receipt.blockHash || "").toLowerCase(),
  };
}

function classifyReceiptPair(oldEvent, left, right) {
  if (!left || !right) return { classification: "unverifiable", reason: "rpc_receipt_missing" };
  if (!left.receipt || !right.receipt) {
    return { classification: "unverifiable", reason: "rpc_receipt_missing_or_disagreement" };
  }

  const leftFingerprint = receiptFingerprint(left.receipt);
  const rightFingerprint = receiptFingerprint(right.receipt);
  if (JSON.stringify(leftFingerprint) !== JSON.stringify(rightFingerprint) ||
      left.matchingLog !== right.matchingLog ||
      left.matchingLogAmbiguous !== right.matchingLogAmbiguous ||
      left.matchingLogIndex !== right.matchingLogIndex ||
      left.canonical !== right.canonical) {
    return { classification: "unverifiable", reason: "rpc_receipt_or_canonicality_disagreement" };
  }

  if (left.matchingLogAmbiguous) {
    return { classification: "unverifiable", reason: "multiple_identical_transfer_logs_in_receipt" };
  }
  if (leftFingerprint.status !== "0x1" || !left.matchingLog || !left.canonical) {
    return { classification: "orphaned", reason: "receipt_does_not_prove_a_canonical_successful_transfer" };
  }

  const sameRecordedBlock = String(oldEvent.block_number) === leftFingerprint.blockNumber &&
    String(oldEvent.block_hash || "").toLowerCase() === leftFingerprint.blockHash;
  const sameRecordedLogIndex = String(oldEvent.log_index) === String(left.matchingLogIndex);
  return {
    classification: sameRecordedBlock && sameRecordedLogIndex ? "canonical" : "re_included",
    reason: sameRecordedBlock && sameRecordedLogIndex
      ? "recorded_event_remains_canonical"
      : "transaction_was_reincluded_on_canonical_chain",
    observedBlock: leftFingerprint.blockNumber,
    observedBlockHash: leftFingerprint.blockHash,
    observedLogIndex: left.matchingLogIndex,
    observedTimestampMs: left.blockTimestampMs == null ? null : String(left.blockTimestampMs),
  };
}

function canCommitReconciliation(items) {
  const list = Array.isArray(items) ? items : [];
  return !list.some((item) => {
    if (!new Set(["canonical", "re_included", "orphaned"]).has(item.classification)) return true;
    const financialImpact = Number(item.financial_impact ?? item.financialImpact ?? 0);
    const resolutionStatus = item.resolution_status ?? item.resolutionStatus ?? "pending";
    if (item.classification === "orphaned" && financialImpact === 1 &&
        resolutionStatus !== "compensated") return true;
    return false;
  });
}

module.exports = {
  createBscEventIdentity,
  classifyReceiptPair,
  canCommitReconciliation,
};
