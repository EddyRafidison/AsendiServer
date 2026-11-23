"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  shouldValidateCursorHash,
  getWebsocketScanDelay,
  getNextWebsocketReconnectDelay,
} = require("../bsc-rpc-efficiency");
const {
  attachEthersRpcMetrics,
  getBscEthersRpcMetricsAdminSnapshot,
} = require("../bsc-rpc-ethers-metrics");

const cursor = {
  blockNumber: "100",
  blockHash: `0x${"a".repeat(64)}`,
  rpcUrl: "https://rpc-a.example",
  lastValidatedAtMs: 100000,
};

test("finalized cursor hash is reused only for the same block, hash and provider inside its interval", () => {
  assert.equal(shouldValidateCursorHash({
    safeBlockMethod: "finalized", cached: cursor, blockNumber: "100",
    blockHash: cursor.blockHash, rpcUrl: cursor.rpcUrl, intervalMs: 60000, nowMs: 120000,
  }), false);
  assert.equal(shouldValidateCursorHash({
    safeBlockMethod: "finalized", cached: cursor, blockNumber: "100",
    blockHash: cursor.blockHash, rpcUrl: cursor.rpcUrl, intervalMs: 60000, nowMs: 160000,
  }), true);
  assert.equal(shouldValidateCursorHash({
    safeBlockMethod: "confirmations", cached: cursor, blockNumber: "100",
    blockHash: cursor.blockHash, rpcUrl: cursor.rpcUrl, intervalMs: 60000, nowMs: 120000,
  }), true);
  assert.equal(shouldValidateCursorHash({
    safeBlockMethod: "finalized", cached: cursor, blockNumber: "101",
    blockHash: cursor.blockHash, rpcUrl: cursor.rpcUrl, intervalMs: 60000, nowMs: 120000,
  }), true);
  const advancedCursor = { ...cursor, blockNumber: "101", blockHash: `0x${"c".repeat(64)}` };
  assert.equal(shouldValidateCursorHash({
    safeBlockMethod: "finalized", cached: advancedCursor, blockNumber: "101",
    blockHash: advancedCursor.blockHash, rpcUrl: cursor.rpcUrl, intervalMs: 60000, nowMs: 120000,
  }), false);
  assert.equal(shouldValidateCursorHash({
    safeBlockMethod: "finalized", cached: advancedCursor, blockNumber: "101",
    blockHash: advancedCursor.blockHash, rpcUrl: cursor.rpcUrl, intervalMs: 60000, nowMs: 160000,
  }), true);
  assert.equal(shouldValidateCursorHash({
    safeBlockMethod: "finalized", cached: cursor, blockNumber: "100",
    blockHash: cursor.blockHash, rpcUrl: "https://rpc-b.example", intervalMs: 60000, nowMs: 120000,
  }), true);
});

test("WebSocket wake-ups respect the configured minimum scan interval", () => {
  assert.equal(getWebsocketScanDelay(100000, 10000, 105000), 5000);
  assert.equal(getWebsocketScanDelay(100000, 10000, 110000), 0);
  assert.equal(getWebsocketScanDelay(0, 10000, 110000), 0);
});

test("WebSocket reconnect backoff doubles and remains capped", () => {
  assert.equal(getNextWebsocketReconnectDelay(0), 5000);
  assert.equal(getNextWebsocketReconnectDelay(5000), 10000);
  assert.equal(getNextWebsocketReconnectDelay(10000), 20000);
  assert.equal(getNextWebsocketReconnectDelay(40000), 60000);
  assert.equal(getNextWebsocketReconnectDelay(60000), 60000);
  assert.throws(() => getNextWebsocketReconnectDelay(5000, 1000, 500), /bounds/);
});

test("scanner includes hourly RPC metrics without exposing endpoint URLs", () => {
  const fs = require("node:fs");
  const source = fs.readFileSync(require("node:path").resolve(__dirname, "../pay.js"), "utf8");
  assert.match(source, /ONEX_BSC_RPC_METRICS/);
  assert.match(source, /rate_limited/);
  assert.match(source, /rpc_metrics: getRpcMetricsAdminSnapshot\(\)/);
  assert.match(source, /recordWebsocketMetric\("notification"\)/);
  assert.match(source, /websocket_notifications/);
  assert.match(source, /new URL\(rpcUrl\)\.host\.toLowerCase\(\)/);
  assert.match(source, /getIncomingScannerStatus\(db, \{ includeRpcMetrics = false \} = \{\}\)/);
  assert.match(source, /topics: \[TRANSFER_TOPIC, null, addressTopic\(paymentConfig\.treasuryAddress\)\]/);
  assert.doesNotMatch(source, /wsProvider\.on\("block"/);
  assert.match(source, /finalized HTTP scanning remains the source of truth/);
  assert.match(source, /scheduleWebsocketReconnect/);
  assert.match(source, /USDT_PAYMENT_POLL_MS \|\| 30000/);
  assert.match(source, /USDT_WS_MIN_SCAN_INTERVAL_MS \|\| 10000/);
  const routing = fs.readFileSync(require("node:path").resolve(__dirname, "../bsc-rpc-routing.js"), "utf8");
  assert.match(routing, /BSC_INCOMING_RPC_FALLBACK_URL/);
  const disbursement = fs.readFileSync(require("node:path").resolve(__dirname, "../disbursement.js"), "utf8");
  const treasuryWorker = fs.readFileSync(require("node:path").resolve(__dirname, "../treasury-worker.js"), "utf8");
  assert.match(disbursement, /process\.env\.BSC_RPC_URL/);
  assert.match(treasuryWorker, /process\.env\.BSC_RPC_URL/);
  assert.doesNotMatch(disbursement, /BSC_INCOMING_RPC_URL/);
  assert.doesNotMatch(treasuryWorker, /BSC_INCOMING_RPC_URL/);
  const routes = fs.readFileSync(require("node:path").resolve(__dirname, "../routes.js"), "utf8");
  assert.match(routes, /getIncomingScannerStatus\(db, \{ includeRpcMetrics: true \}\)/);
});


test("Ethers JSON-RPC debug events count individual methods without retaining payloads", () => {
  const listeners = new Map();
  const provider = {
    on(event, listener) {
      listeners.set(event, listener);
      return Promise.resolve(this);
    },
  };
  assert.equal(attachEthersRpcMetrics(provider, "https://rpc-test.example/secret-path", "unit-test"), true);
  const debug = listeners.get("debug");
  const before = getBscEthersRpcMetricsAdminSnapshot().since_process_start.requests;
  const startedAt = Date.now();
  debug({
    action: "sendRpcPayload",
    payload: [
      { id: 900001, jsonrpc: "2.0", method: "eth_blockNumber", params: [] },
      { id: 900002, jsonrpc: "2.0", method: "eth_getBlockByNumber", params: ["latest", false] },
    ],
  });
  debug({
    action: "receiveRpcResult",
    result: [
      { id: 900001, result: "0x123" },
      { id: 900002, result: { number: "0x123", hash: `0x${"a".repeat(64)}` } },
    ],
  });
  const after = getBscEthersRpcMetricsAdminSnapshot().since_process_start;
  assert.equal(after.requests - before, 2);
  assert.equal(after.errors, 0);
  assert.ok(Object.keys(after.methods).some((key) => key.includes("rpc-test.example|eth_blockNumber")));
  assert.ok(!JSON.stringify(after).includes("secret-path"));
  assert.ok(Date.now() >= startedAt);
});


test("Ethers JSON-RPC errors and rate limits are counted by method", () => {
  const listeners = new Map();
  const provider = {
    on(event, listener) {
      listeners.set(event, listener);
      return Promise.resolve(this);
    },
  };
  attachEthersRpcMetrics(provider, "https://rpc-errors.example/key", "unit-test-errors");
  const debug = listeners.get("debug");
  const before = getBscEthersRpcMetricsAdminSnapshot().since_process_start;
  debug({
    action: "sendRpcPayload",
    payload: { id: 900003, jsonrpc: "2.0", method: "eth_getLogs", params: [] },
  });
  debug({
    action: "receiveRpcResult",
    result: [{ id: 900003, error: { code: -32005, message: "Rate limit exceeded" } }],
  });
  const after = getBscEthersRpcMetricsAdminSnapshot().since_process_start;
  assert.equal(after.requests - before.requests, 1);
  assert.equal(after.errors - before.errors, 1);
  assert.equal(after.rate_limited - before.rate_limited, 1);
});


test("Ethers transport errors are counted separately without failing unrelated pending methods", () => {
  const listeners = new Map();
  const provider = {
    on(event, listener) {
      listeners.set(event, listener);
      return Promise.resolve(this);
    },
  };
  attachEthersRpcMetrics(provider, "https://rpc-transport.example/key", "unit-test-transport");
  const debug = listeners.get("debug");
  const before = getBscEthersRpcMetricsAdminSnapshot().since_process_start;
  debug({
    action: "sendRpcPayload",
    payload: { id: 900004, jsonrpc: "2.0", method: "eth_getBalance", params: [] },
  });
  debug({
    action: "receiveRpcError",
    error: new Error("socket hang up"),
  });
  const after = getBscEthersRpcMetricsAdminSnapshot().since_process_start;
  assert.equal(after.requests, before.requests);
  assert.equal(after.transport_errors_unattributed - before.transport_errors_unattributed, 1);
});
