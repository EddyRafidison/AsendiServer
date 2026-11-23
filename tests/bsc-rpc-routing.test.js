"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  resolveIncomingRpcConfiguration,
  validateHttpsRpcUrls,
  validateWssRpcUrl,
  createRpcFailoverState,
  isTransientRpcError,
  shouldTryRpcFallback,
  getRpcCandidates,
  recordRpcSuccess,
  recordRpcFailure,
  getRpcFailoverStatus,
} = require("../bsc-rpc-routing");

const PUBLICNODE_HTTP = "https://bsc-rpc.publicnode.com";
const PUBLICNODE_WS = "wss://bsc-rpc.publicnode.com";
const CHAINSTACK = "https://nd-example.p2pify.com/example-token";

 test("PublicNode is the incoming primary and Chainstack is the incoming fallback", () => {
  const resolved = resolveIncomingRpcConfiguration({
    BSC_RPC_URL: CHAINSTACK,
    BSC_INCOMING_RPC_URL: PUBLICNODE_HTTP,
    BSC_INCOMING_WS_RPC_URL: PUBLICNODE_WS,
  });
  assert.deepEqual(resolved.urls, [PUBLICNODE_HTTP, CHAINSTACK]);
  assert.equal(resolved.primaryUrl, PUBLICNODE_HTTP);
  assert.equal(resolved.fallbackUrl, CHAINSTACK);
  assert.equal(resolved.websocketUrl, PUBLICNODE_WS);
});

test("explicit incoming fallback takes precedence and duplicate endpoints are deduplicated", () => {
  const alternate = "https://rpc-backup.example/rpc";
  const resolved = resolveIncomingRpcConfiguration({
    BSC_RPC_URL: CHAINSTACK,
    BSC_INCOMING_RPC_URL: PUBLICNODE_HTTP,
    BSC_INCOMING_RPC_FALLBACK_URL: alternate,
  });
  assert.deepEqual(resolved.urls, [PUBLICNODE_HTTP, alternate]);

  const duplicate = resolveIncomingRpcConfiguration({
    BSC_RPC_URL: PUBLICNODE_HTTP,
    BSC_INCOMING_RPC_URL: PUBLICNODE_HTTP,
    BSC_INCOMING_RPC_FALLBACK_URL: PUBLICNODE_HTTP,
  });
  assert.deepEqual(duplicate.urls, [PUBLICNODE_HTTP]);
});

test("legacy configuration remains compatible when explicit incoming variables are absent", () => {
  const resolved = resolveIncomingRpcConfiguration({
    BSC_RPC_URL: CHAINSTACK,
    BSC_RPC_FALLBACK_URL: "https://rpc-legacy.example/rpc",
    BSC_WS_RPC_URL: "wss://legacy.example/ws",
  });
  assert.deepEqual(resolved.urls, [CHAINSTACK, "https://rpc-legacy.example/rpc"]);
  assert.equal(resolved.websocketUrl, "wss://legacy.example/ws");
});

test("incoming endpoints require secure HTTP and secure WebSocket transports", () => {
  assert.doesNotThrow(() => validateHttpsRpcUrls([PUBLICNODE_HTTP, CHAINSTACK]));
  assert.throws(() => validateHttpsRpcUrls(["http://insecure.example"]), /HTTPS/);
  assert.throws(() => validateHttpsRpcUrls(["https://user:pass@example.com"]), /without embedded credentials/);
  assert.doesNotThrow(() => validateWssRpcUrl(PUBLICNODE_WS));
  assert.throws(() => validateWssRpcUrl("ws://insecure.example"), /wss/);
});

test("transient failures open the RPC circuit and allow fallback without repeated primary calls", () => {
  const state = createRpcFailoverState([PUBLICNODE_HTTP, CHAINSTACK], 30000);
  assert.deepEqual(getRpcCandidates(state, 1000), [PUBLICNODE_HTTP, CHAINSTACK]);

  const error = new Error("HTTP 429 rate limit exceeded");
  error.httpStatus = 429;
  assert.equal(isTransientRpcError(error), true);
  assert.equal(shouldTryRpcFallback(error), true);
  assert.deepEqual(recordRpcFailure(state, PUBLICNODE_HTTP, error, 1000), { opened: true, disabled: false });
  assert.deepEqual(getRpcCandidates(state, 1001), [CHAINSTACK]);
  assert.deepEqual(getRpcCandidates(state, 30999), [CHAINSTACK]);
  assert.deepEqual(getRpcCandidates(state, 31000), [PUBLICNODE_HTTP, CHAINSTACK]);

  recordRpcSuccess(state, PUBLICNODE_HTTP, 31001);
  assert.deepEqual(getRpcCandidates(state, 31002), [PUBLICNODE_HTTP, CHAINSTACK]);
  assert.equal(getRpcFailoverStatus(state, 31002)[0].circuit_open, false);
});

test("deterministic method errors do not open circuits or trigger paid fallback", () => {
  const state = createRpcFailoverState([PUBLICNODE_HTTP, CHAINSTACK], 30000);
  const error = new Error("unsupported block tag finalized");
  assert.equal(isTransientRpcError(error), false);
  assert.equal(shouldTryRpcFallback(error), false);
  assert.deepEqual(recordRpcFailure(state, PUBLICNODE_HTTP, error, 1000), { opened: false, disabled: false });
  assert.deepEqual(getRpcCandidates(state, 1001), [PUBLICNODE_HTTP, CHAINSTACK]);
});

test("permanent endpoint configuration failures disable only the affected endpoint", () => {
  const state = createRpcFailoverState([PUBLICNODE_HTTP, CHAINSTACK], 30000);
  const error = new Error("RPC endpoint is on chain 97, not BNB Smart Chain mainnet 56.");
  assert.equal(shouldTryRpcFallback(error), true);
  assert.deepEqual(recordRpcFailure(state, PUBLICNODE_HTTP, error, 1000), { opened: true, disabled: true });
  assert.deepEqual(getRpcCandidates(state, 1001), [CHAINSTACK]);
});
