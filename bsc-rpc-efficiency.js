"use strict";

function shouldValidateCursorHash({
  safeBlockMethod,
  cached,
  blockNumber,
  blockHash,
  rpcUrl,
  intervalMs,
  nowMs = Date.now(),
}) {
  if (!cached) return true;
  if (String(cached.blockNumber) !== String(blockNumber)) return true;
  if (String(cached.blockHash).toLowerCase() !== String(blockHash).toLowerCase()) return true;
  if (String(cached.rpcUrl) !== String(rpcUrl)) return true;
  if (safeBlockMethod !== "finalized") return true;
  return nowMs - Number(cached.lastValidatedAtMs || cached.checkedAtMs || 0) >= intervalMs;
}

function getWebsocketScanDelay(lastScanStartedAtMs, minimumIntervalMs, nowMs = Date.now()) {
  if (!lastScanStartedAtMs) return 0;
  return Math.max(0, minimumIntervalMs - Math.max(0, nowMs - lastScanStartedAtMs));
}

function getNextWebsocketReconnectDelay(currentDelayMs, minimumDelayMs = 5000, maximumDelayMs = 60000) {
  const current = Number(currentDelayMs);
  const minimum = Number(minimumDelayMs);
  const maximum = Number(maximumDelayMs);
  if (!Number.isFinite(minimum) || !Number.isFinite(maximum) || minimum < 1000 || maximum < minimum) {
    throw new RangeError("WebSocket reconnect delay bounds are invalid.");
  }
  if (!Number.isFinite(current) || current < minimum) return minimum;
  return Math.min(maximum, current * 2);
}

module.exports = {
  shouldValidateCursorHash,
  getWebsocketScanDelay,
  getNextWebsocketReconnectDelay,
};
