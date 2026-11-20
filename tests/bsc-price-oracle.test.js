"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  DEFAULT_BNB_USD_FEED_ADDRESS,
  normalizeChainlinkPriceRound,
} = require("../bsc-price-oracle");

test("uses the documented Chainlink BNB/USD proxy on BNB Chain Mainnet", () => {
  assert.equal(
    DEFAULT_BNB_USD_FEED_ADDRESS.toLowerCase(),
    "0x0567f2323251f0aab15c8dfb1967e4e8a7d42aee",
  );
});

test("normalizes the feed answer using the contract-provided decimals", () => {
  const price = normalizeChainlinkPriceRound(
    { roundId: 12n, answer: 712345678901n, updatedAt: 1_800_000_000n },
    8,
    1_800_000_030,
    300,
  );
  assert.equal(price.price.toFixed(8), "7123.45678901");
  assert.equal(price.updatedAt, 1_800_000_000);
  assert.equal(price.ageSeconds, 30);
});

test("rejects a stale Chainlink answer", () => {
  assert.throws(
    () => normalizeChainlinkPriceRound(
      { roundId: 12n, answer: 700000000000n, updatedAt: 1_800_000_000n },
      8,
      1_800_000_301,
      300,
    ),
    /stale/i,
  );
});

test("rejects invalid, non-positive and future price answers", () => {
  assert.throws(
    () => normalizeChainlinkPriceRound(
      { roundId: 12n, answer: 0n, updatedAt: 1_800_000_000n },
      8,
      1_800_000_001,
      300,
    ),
    /non-positive|invalid price/i,
  );
  assert.throws(
    () => normalizeChainlinkPriceRound(
      { roundId: 12n, answer: 700000000000n, updatedAt: 1_800_000_040n },
      8,
      1_800_000_000,
      300,
    ),
    /timestamp/i,
  );
});
