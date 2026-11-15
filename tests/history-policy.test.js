"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  DAY_MS,
  MAX_TRANSACTION_HISTORY_DAYS,
  normalizeTransactionHistoryDays,
  getTransactionHistoryCutoffMs,
} = require("../history-policy");

test("transaction history defaults to and never exceeds 30 days", () => {
  assert.equal(normalizeTransactionHistoryDays(undefined), 30);
  assert.equal(normalizeTransactionHistoryDays(""), 30);
  assert.equal(normalizeTransactionHistoryDays("30"), 30);
  assert.equal(normalizeTransactionHistoryDays("31"), 30);
  assert.equal(normalizeTransactionHistoryDays("3650"), 30);
  assert.equal(normalizeTransactionHistoryDays("7"), 7);
  assert.equal(MAX_TRANSACTION_HISTORY_DAYS, 30);
});

test("invalid transaction history day values are rejected", () => {
  for (const value of [0, -1, 1.5, "1.5", "NaN", "Infinity", "9007199254740992"]) {
    assert.equal(normalizeTransactionHistoryDays(value), null);
  }
});

test("history cutoff uses an exact rolling 30 x 24-hour window", () => {
  const now = Date.UTC(2026, 10, 15, 12, 34, 56);
  assert.equal(getTransactionHistoryCutoffMs(now, 30), now - (30 * DAY_MS));
  assert.equal(getTransactionHistoryCutoffMs(now + 450, 30), now - (30 * DAY_MS) + 1000);
  assert.equal(getTransactionHistoryCutoffMs(now, 7), now - (7 * DAY_MS));
  assert.throws(() => getTransactionHistoryCutoffMs(now, 31), RangeError);
});
