"use strict";

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_TRANSACTION_HISTORY_DAYS = 30;

function normalizeTransactionHistoryDays(value) {
  if (value == null || value === "") return MAX_TRANSACTION_HISTORY_DAYS;
  const days = Number(value);
  if (!Number.isSafeInteger(days) || days < 1) return null;
  return Math.min(days, MAX_TRANSACTION_HISTORY_DAYS);
}

function getTransactionHistoryCutoffMs(nowMs, days) {
  if (!Number.isSafeInteger(nowMs) || !Number.isSafeInteger(days) || days < 1 || days > MAX_TRANSACTION_HISTORY_DAYS) {
    throw new RangeError("Invalid transaction history window");
  }
  const exactCutoffMs = nowMs - (days * DAY_MS);
  // The database stores activity timestamps to whole seconds; round upward to never include an older second.
  return Math.ceil(exactCutoffMs / 1000) * 1000;
}

module.exports = {
  DAY_MS,
  MAX_TRANSACTION_HISTORY_DAYS,
  normalizeTransactionHistoryDays,
  getTransactionHistoryCutoffMs,
};
