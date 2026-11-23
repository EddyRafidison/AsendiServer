"use strict";

const { Contract, isAddress } = require("ethers");
const BigNumber = require("bignumber.js");

const CHAIN_ID = 56n;
const FEED_METADATA_RECHECK_MS = 24 * 60 * 60 * 1000;
const DEFAULT_BNB_USD_FEED_ADDRESS = "0x0567F2323251f0Aab15c8dFb1967E4e8A7D42aeE";
const PRICE_FEED_ABI = [
  "function description() view returns (string)",
  "function decimals() view returns (uint8)",
  "function latestRoundData() view returns (uint80 roundId,int256 answer,uint256 startedAt,uint256 updatedAt,uint80 answeredInRound)",
];

let cachedSnapshot = null;
let refreshTimer = null;
let refreshPromise = null;
let oracleProvider = null;
const validatedFeedCache = new WeakMap();

function boundedIntegerEnv(name, fallback, minimum, maximum) {
  const raw = process.env[name];
  if (raw == null || String(raw).trim() === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new RangeError(`${name} must be an integer between ${minimum} and ${maximum}.`);
  }
  return parsed;
}

function getBnbUsdFeedConfig() {
  const feedAddress = String(
    process.env.BSC_BNB_USD_FEED_ADDRESS || DEFAULT_BNB_USD_FEED_ADDRESS,
  ).trim();
  if (!isAddress(feedAddress)) {
    throw new TypeError("BSC_BNB_USD_FEED_ADDRESS must be a valid EVM address.");
  }

  const refreshIntervalMs = boundedIntegerEnv(
    "BSC_PRICE_REFRESH_INTERVAL_MS",
    60000,
    15000,
    900000,
  );
  const maxAgeSeconds = boundedIntegerEnv(
    "BSC_PRICE_MAX_AGE_SECONDS",
    300,
    60,
    3600,
  );
  if (maxAgeSeconds * 1000 < refreshIntervalMs) {
    throw new RangeError("BSC_PRICE_MAX_AGE_SECONDS must be at least the refresh interval in seconds.");
  }

  return { feedAddress, refreshIntervalMs, maxAgeSeconds };
}

function normalizeChainlinkPriceRound(round, decimals, nowSeconds = Math.floor(Date.now() / 1000), maxAgeSeconds = 300) {
  const precision = Number(decimals);
  const answer = new BigNumber(String(round?.answer ?? ""));
  const updatedAt = Number(String(round?.updatedAt ?? ""));
  const roundId = String(round?.roundId ?? "");

  if (!Number.isSafeInteger(precision) || precision < 0 || precision > 36) {
    throw new RangeError("Chainlink BNB/USD feed returned an invalid decimal precision.");
  }
  if (!answer.isFinite() || !answer.isInteger() || !answer.isGreaterThan(0)) {
    throw new RangeError("Chainlink BNB/USD feed returned a non-positive or invalid price.");
  }
  if (!/^\d+$/.test(roundId) || roundId === "0") {
    throw new RangeError("Chainlink BNB/USD feed returned an invalid round identifier.");
  }
  if (!Number.isSafeInteger(updatedAt) || updatedAt <= 0 || updatedAt > nowSeconds + 30) {
    throw new RangeError("Chainlink BNB/USD feed returned an invalid update timestamp.");
  }

  const ageSeconds = nowSeconds - updatedAt;
  if (ageSeconds > maxAgeSeconds) {
    throw new Error(
      `Chainlink BNB/USD price is stale (${ageSeconds}s old; maximum ${maxAgeSeconds}s).`,
    );
  }

  const price = answer.shiftedBy(-precision);
  if (!price.isFinite() || !price.isGreaterThan(0)) {
    throw new RangeError("Chainlink BNB/USD feed price could not be normalized.");
  }

  return {
    price,
    roundId,
    decimals: precision,
    updatedAt,
    ageSeconds,
  };
}

function getCachedBnbUsdPrice() {
  if (!cachedSnapshot) {
    throw new Error("A fresh Chainlink BNB/USD price is not available; outgoing BSC transactions are paused.");
  }
  const { maxAgeSeconds } = getBnbUsdFeedConfig();
  const ageSeconds = Math.floor(Date.now() / 1000) - cachedSnapshot.updatedAt;
  if (ageSeconds < 0 || ageSeconds > maxAgeSeconds) {
    throw new Error(
      `Cached Chainlink BNB/USD price is stale (${ageSeconds}s old; maximum ${maxAgeSeconds}s); outgoing BSC transactions are paused.`,
    );
  }
  return new BigNumber(cachedSnapshot.price);
}

function getBnbUsdPriceSnapshot() {
  if (!cachedSnapshot) return null;
  try {
    const price = getCachedBnbUsdPrice();
    return {
      price: price.toFixed(18),
      roundId: cachedSnapshot.roundId,
      decimals: cachedSnapshot.decimals,
      updatedAt: cachedSnapshot.updatedAt,
      fetchedAtMs: cachedSnapshot.fetchedAtMs,
    };
  } catch {
    return null;
  }
}

async function refreshBnbUsdPrice(provider) {
  if (!provider || typeof provider.getNetwork !== "function" || typeof provider.getCode !== "function") {
    throw new TypeError("A BNB Smart Chain JSON-RPC provider is required for the Chainlink price feed.");
  }
  if (refreshPromise) return refreshPromise;

  refreshPromise = (async () => {
    const config = getBnbUsdFeedConfig();
    let providerFeeds = validatedFeedCache.get(provider);
    if (!providerFeeds) {
      providerFeeds = new Map();
      validatedFeedCache.set(provider, providerFeeds);
    }

    let feedState = providerFeeds.get(config.feedAddress.toLowerCase());
    if (!feedState || Date.now() - feedState.validatedAtMs >= FEED_METADATA_RECHECK_MS) {
      const network = await provider.getNetwork();
      if (BigInt(network.chainId) !== CHAIN_ID) {
        throw new Error("The Chainlink BNB/USD feed must be read from BNB Smart Chain mainnet (chain ID 56).");
      }

      const code = await provider.getCode(config.feedAddress);
      if (!code || code === "0x") {
        throw new Error("The configured Chainlink BNB/USD feed contract is unavailable on BNB Smart Chain.");
      }

      const feed = new Contract(config.feedAddress, PRICE_FEED_ABI, provider);
      const [description, decimals] = await Promise.all([
        feed.description(),
        feed.decimals(),
      ]);
      if (!/^BNB\s*\/\s*USD$/i.test(String(description).trim())) {
        throw new Error(`The configured Chainlink feed is not BNB/USD (reported description: ${String(description).slice(0, 80)}).`);
      }
      const precision = Number(decimals);
      if (!Number.isSafeInteger(precision) || precision < 0 || precision > 36) {
        throw new RangeError("Chainlink BNB/USD feed returned an invalid decimal precision.");
      }
      feedState = { feed, decimals: precision, validatedAtMs: Date.now() };
      providerFeeds.set(config.feedAddress.toLowerCase(), feedState);
    }

    const round = await feedState.feed.latestRoundData();
    const normalized = normalizeChainlinkPriceRound(
      round,
      feedState.decimals,
      Math.floor(Date.now() / 1000),
      config.maxAgeSeconds,
    );

    if (cachedSnapshot && normalized.updatedAt < cachedSnapshot.updatedAt) {
      throw new Error("Chainlink BNB/USD returned an older update timestamp than the previously accepted round.");
    }

    cachedSnapshot = {
      price: normalized.price.toFixed(36),
      roundId: normalized.roundId,
      decimals: normalized.decimals,
      updatedAt: normalized.updatedAt,
      fetchedAtMs: Date.now(),
    };
    return getBnbUsdPriceSnapshot();
  })();

  try {
    return await refreshPromise;
  } finally {
    refreshPromise = null;
  }
}

async function getBnbUsdPrice(provider, { forceRefresh = false } = {}) {
  const config = getBnbUsdFeedConfig();
  const snapshot = getBnbUsdPriceSnapshot();
  if (
    !forceRefresh && snapshot &&
    Date.now() - snapshot.fetchedAtMs < config.refreshIntervalMs
  ) {
    return new BigNumber(snapshot.price);
  }
  await refreshBnbUsdPrice(provider);
  return getCachedBnbUsdPrice();
}

async function startBnbUsdPriceOracle(provider) {
  const config = getBnbUsdFeedConfig();
  oracleProvider = provider;
  if (!refreshTimer) {
    refreshTimer = setInterval(() => {
      void refreshBnbUsdPrice(oracleProvider).catch((error) => {
        console.error("Chainlink BNB/USD price refresh failed:", error.message);
      });
    }, config.refreshIntervalMs);
    if (typeof refreshTimer.unref === "function") refreshTimer.unref();
  }

  try {
    await refreshBnbUsdPrice(provider);
  } catch (error) {
    console.error(
      "Initial Chainlink BNB/USD price read failed. Outgoing BSC transactions will remain queued until a fresh price is available:",
      error.message,
    );
  }
  return getBnbUsdPriceSnapshot();
}

function stopBnbUsdPriceOracle() {
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = null;
  oracleProvider = null;
}

module.exports = {
  CHAIN_ID,
  DEFAULT_BNB_USD_FEED_ADDRESS,
  getBnbUsdFeedConfig,
  normalizeChainlinkPriceRound,
  refreshBnbUsdPrice,
  getBnbUsdPrice,
  getCachedBnbUsdPrice,
  getBnbUsdPriceSnapshot,
  startBnbUsdPriceOracle,
  stopBnbUsdPriceOracle,
};
