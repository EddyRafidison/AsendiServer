"use strict";

const https = require("https");
const { getAddress, WebSocketProvider } = require("ethers");
const BigNumber = require("bignumber.js");
const {
  createBscEventIdentity,
  classifyReceiptPair,
  canCommitReconciliation,
} = require("./bsc-reconciliation-policy");
const {
  shouldValidateCursorHash,
  getWebsocketScanDelay,
  getNextWebsocketReconnectDelay,
} = require("./bsc-rpc-efficiency");
const { getBscEthersRpcMetricsAdminSnapshot } = require("./bsc-rpc-ethers-metrics");
const {
  resolveIncomingRpcConfiguration,
  validateHttpsRpcUrls,
  validateWssRpcUrl,
  createRpcFailoverState,
  shouldTryRpcFallback,
  getRpcCandidates,
  recordRpcSuccess,
  recordRpcFailure,
  getRpcFailoverStatus,
} = require("./bsc-rpc-routing");

const TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const CHAIN_ID = 56n;
const CANONICAL_BSC_USD_CONTRACT =
  "0x55d398326f99059fF775485246999027B3197955";
const TOKEN_DECIMALS = 18;
const RPC_TIMEOUT_MS = 12000;
const RPC_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const TREASURY_SCAN_LOCK = "onex_bsc_treasury_incoming_scanner";
const SCAN_CHECKPOINT_INTERVAL_BLOCKS = 500n;
const RECONCILIATION_PREVIEW_TTL_MS = 30 * 60 * 1000;
const MAX_RECONCILIATION_CHECKPOINTS = 2000;
const DEFAULT_CURSOR_HASH_CHECK_INTERVAL_MS = 60000;
const RPC_METRICS_LOG_INTERVAL_MS = 60 * 60 * 1000;

let paymentConfig = null;
let rpcCounter = 0;
let watcherTimer = null;
let watcherRunning = false;
let watcherWakeRequested = false;
let watcherDatabase = null;
let transferHandler = null;
let maintenanceHandler = null;
let watcherWsProvider = null;
let watcherWsReconnectTimer = null;
let watcherWsHealthTimer = null;
let watcherWsReconnectDelayMs = 5000;
let watcherWsConnecting = false;
let validatedRpcUrls = new Set();
let cursorHashValidation = null;
let rpcMetricsWindow = createRpcMetricsWindow();
let rpcMetricsLifetimeWindow = createRpcMetricsWindow();
let previousRpcMetricsWindow = null;
let rpcMetricsTimer = null;
let lastWatcherScanStartedAtMs = 0;
let lastFinalityFallbackWarningAtMs = 0;

function createRpcMetricsWindow() {
  return {
    startedAtMs: Date.now(),
    requests: 0,
    errors: 0,
    rateLimited: 0,
    websocketNotifications: 0,
    websocketErrors: 0,
    failoverEvents: 0,
    providers: new Map(),
  };
}

function getRpcProviderLabel(rpcUrl) {
  try {
    return new URL(rpcUrl).host.toLowerCase();
  } catch {
    return 'unknown-provider';
  }
}

function ensureRpcMetricsTimer() {
  if (rpcMetricsTimer) return;
  rpcMetricsTimer = setInterval(() => {
    const snapshot = getRpcMetricsSnapshot();
    if (snapshot.requests > 0 || snapshot.websocket_notifications > 0 || snapshot.websocket_errors > 0) {
      previousRpcMetricsWindow = snapshot;
      console.info(`ONEX_BSC_RPC_METRICS ${JSON.stringify(snapshot)}`);
    }
    rpcMetricsWindow = createRpcMetricsWindow();
  }, RPC_METRICS_LOG_INTERVAL_MS);
  if (typeof rpcMetricsTimer.unref === 'function') rpcMetricsTimer.unref();
}

function updateRpcMetricsWindow(window, { provider, method, durationMs, requestBytes, responseBytes, statusCode, error }) {
  const providerLabel = provider || 'unknown-provider';
  let providerMetrics = window.providers.get(providerLabel);
  if (!providerMetrics) {
    providerMetrics = new Map();
    window.providers.set(providerLabel, providerMetrics);
  }
  let methodMetrics = providerMetrics.get(method);
  if (!methodMetrics) {
    methodMetrics = {
      requests: 0,
      errors: 0,
      rateLimited: 0,
      timeouts: 0,
      totalDurationMs: 0,
      maxDurationMs: 0,
      requestBytes: 0,
      responseBytes: 0,
    };
    providerMetrics.set(method, methodMetrics);
  }

  methodMetrics.requests += 1;
  methodMetrics.totalDurationMs += durationMs;
  methodMetrics.maxDurationMs = Math.max(methodMetrics.maxDurationMs, durationMs);
  methodMetrics.requestBytes += requestBytes;
  methodMetrics.responseBytes += responseBytes;
  window.requests += 1;

  if (error) {
    methodMetrics.errors += 1;
    window.errors += 1;
    const message = String(error.message || error).toLowerCase();
    if (statusCode === 429 || /rate.?limit|too many requests|http 429/.test(message)) {
      methodMetrics.rateLimited += 1;
      window.rateLimited += 1;
    }
    if (/timed out|timeout/.test(message)) methodMetrics.timeouts += 1;
  }
}

function recordRpcMetric(metric) {
  updateRpcMetricsWindow(rpcMetricsWindow, metric);
  updateRpcMetricsWindow(rpcMetricsLifetimeWindow, metric);
}

function recordWebsocketMetric(type) {
  const key = type === "error" ? "websocketErrors" : "websocketNotifications";
  rpcMetricsWindow[key] += 1;
  rpcMetricsLifetimeWindow[key] += 1;
}

function getRpcMetricsSnapshot() {
  const now = Date.now();
  const providers = {};
  for (const [provider, methods] of rpcMetricsWindow.providers.entries()) {
    providers[provider] = {};
    for (const [method, metrics] of methods.entries()) {
      providers[provider][method] = {
        ...metrics,
        averageDurationMs: metrics.requests
          ? Number((metrics.totalDurationMs / metrics.requests).toFixed(2))
          : 0,
      };
    }
  }
  return {
    window_started_at_ms: String(rpcMetricsWindow.startedAtMs),
    captured_at_ms: String(now),
    window_duration_ms: now - rpcMetricsWindow.startedAtMs,
    requests: rpcMetricsWindow.requests,
    errors: rpcMetricsWindow.errors,
    rate_limited: rpcMetricsWindow.rateLimited,
    websocket_notifications: rpcMetricsWindow.websocketNotifications,
    websocket_errors: rpcMetricsWindow.websocketErrors,
    failover_events: rpcMetricsWindow.failoverEvents,
    incoming_rpc_failover: paymentConfig?.enabled
      ? getRpcFailoverStatus(paymentConfig.incomingRpcFailoverState)
      : [],
    providers,
  };
}

function getRpcMetricsAdminSnapshot() {
  const lifetime = rpcMetricsLifetimeWindow;
  const providers = {};
  for (const [provider, methods] of lifetime.providers.entries()) {
    providers[provider] = {};
    for (const [method, metrics] of methods.entries()) {
      providers[provider][method] = {
        ...metrics,
        averageDurationMs: metrics.requests
          ? Number((metrics.totalDurationMs / metrics.requests).toFixed(2))
          : 0,
      };
    }
  }
  return {
    process_started_at_ms: String(lifetime.startedAtMs),
    ethers_provider_metrics: getBscEthersRpcMetricsAdminSnapshot(),
    incoming_rpc_failover: paymentConfig?.enabled
      ? getRpcFailoverStatus(paymentConfig.incomingRpcFailoverState)
      : [],
    since_process_start: {
      requests: lifetime.requests,
      errors: lifetime.errors,
      rate_limited: lifetime.rateLimited,
      websocket_notifications: lifetime.websocketNotifications,
      websocket_errors: lifetime.websocketErrors,
      failover_events: lifetime.failoverEvents,
      providers,
    },
    current_window: getRpcMetricsSnapshot(),
    previous_window: previousRpcMetricsWindow,
  };
}

function isAddress(value) {
  return typeof value === "string" && /^0x[a-fA-F0-9]{40}$/.test(value);
}

function checksumAddress(value) {
  if (!isAddress(value)) throw new Error("Invalid EVM address");
  return getAddress(value);
}

function addressTopic(address) {
  return `0x${address.slice(2).toLowerCase().padStart(64, "0")}`;
}

function toQuantity(value) {
  return `0x${BigInt(value).toString(16)}`;
}

function withTimeout(promise, timeoutMs, operation) {
  let timer = null;
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${operation} timed out after ${timeoutMs} ms.`)), timeoutMs);
    if (typeof timer.unref === "function") timer.unref();
  });
  return Promise.race([Promise.resolve(promise), timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function minBigInt(left, right) {
  return left < right ? left : right;
}

function getPaymentConfigFromEnvironment() {
  const enabled = String(process.env.USDT_PAYMENTS_ENABLED || "false").toLowerCase() === "true";
  if (!enabled) return { enabled: false };

  const incomingRpc = resolveIncomingRpcConfiguration(process.env);
  const incomingRpcUrls = incomingRpc.urls;
  const websocketRpcUrl = incomingRpc.websocketUrl;
  const tokenAddress = String(
    process.env.USDT_BEP20_CONTRACT || CANONICAL_BSC_USD_CONTRACT,
  ).trim();
  const treasuryAddress = String(
    process.env.USDT_BEP20_TREASURY_ADDRESS || process.env.USDT_BEP20_RECEIVER_ADDRESS || "",
  ).trim();
  const minConfirmations = Number(process.env.USDT_MIN_CONFIRMATIONS || 15);
  const pollIntervalMs = Number(process.env.USDT_PAYMENT_POLL_MS || 30000);
  const maxLogBlockRange = Number(process.env.USDT_MAX_LOG_BLOCK_RANGE || 1500);
  const cursorHashCheckIntervalMs = Number(
    process.env.USDT_CURSOR_HASH_CHECK_INTERVAL_MS || DEFAULT_CURSOR_HASH_CHECK_INTERVAL_MS,
  );
  const configuredWebsocketMinScanIntervalMs = Number(
    process.env.USDT_WS_MIN_SCAN_INTERVAL_MS || 10000,
  );
  const rpcCooldownMs = Number(process.env.BSC_INCOMING_RPC_COOLDOWN_MS || 30000);
  const configuredStartBlock = String(process.env.USDT_INCOMING_START_BLOCK || "").trim();
  const startBlock = configuredStartBlock === "" ? null : BigInt(configuredStartBlock);

  validateHttpsRpcUrls(incomingRpcUrls);
  validateWssRpcUrl(websocketRpcUrl);
  if (!treasuryAddress) {
    throw new Error("USDT payments require an incoming BSC RPC endpoint and USDT_BEP20_TREASURY_ADDRESS.");
  }
  if (!Number.isInteger(rpcCooldownMs) || rpcCooldownMs < 5000 || rpcCooldownMs > 300000) {
    throw new Error("BSC_INCOMING_RPC_COOLDOWN_MS must be between 5000 and 300000 milliseconds.");
  }
  if (!isAddress(tokenAddress) || !isAddress(treasuryAddress)) {
    throw new Error("The approved token contract or treasury address is invalid.");
  }
  if (tokenAddress.toLowerCase() !== CANONICAL_BSC_USD_CONTRACT.toLowerCase()) {
    throw new Error(`Only Binance-Peg BSC-USD is accepted: ${CANONICAL_BSC_USD_CONTRACT}.`);
  }
  if (tokenAddress.toLowerCase() === treasuryAddress.toLowerCase()) {
    throw new Error("The treasury address cannot be the token contract address.");
  }
  if (!Number.isInteger(minConfirmations) || minConfirmations < 1 || minConfirmations > 200) {
    throw new Error("USDT_MIN_CONFIRMATIONS must be an integer between 1 and 200.");
  }
  if (!Number.isInteger(pollIntervalMs) || pollIntervalMs < 1000 || pollIntervalMs > 60000) {
    throw new Error("USDT_PAYMENT_POLL_MS must be between 1000 and 60000 milliseconds.");
  }
  if (!Number.isInteger(maxLogBlockRange) || maxLogBlockRange < 1 || maxLogBlockRange > 2000) {
    throw new Error("USDT_MAX_LOG_BLOCK_RANGE must be an integer between 1 and 2000.");
  }
  if (!Number.isInteger(cursorHashCheckIntervalMs) || cursorHashCheckIntervalMs < 15000 || cursorHashCheckIntervalMs > 900000) {
    throw new Error("USDT_CURSOR_HASH_CHECK_INTERVAL_MS must be an integer between 15000 and 900000 milliseconds.");
  }
  if (!Number.isInteger(configuredWebsocketMinScanIntervalMs) || configuredWebsocketMinScanIntervalMs < 1000 || configuredWebsocketMinScanIntervalMs > 60000) {
    throw new Error("USDT_WS_MIN_SCAN_INTERVAL_MS must be an integer between 1000 and 60000 milliseconds.");
  }
  if (startBlock !== null && (startBlock < 0n || startBlock > 0xffffffffffffffffn)) {
    throw new Error("USDT_INCOMING_START_BLOCK must be a valid non-negative block number.");
  }

  return {
    enabled: true,
    incomingRpcUrls,
    incomingRpcFailoverState: createRpcFailoverState(incomingRpcUrls, rpcCooldownMs),
    primaryIncomingRpcUrl: incomingRpcUrls[0],
    lastSuccessfulRpcUrl: null,
    websocketRpcUrl: websocketRpcUrl || null,
    tokenAddress: checksumAddress(tokenAddress),
    tokenAddressLower: tokenAddress.toLowerCase(),
    treasuryAddress: checksumAddress(treasuryAddress),
    treasuryAddressLower: treasuryAddress.toLowerCase(),
    minConfirmations: BigInt(minConfirmations),
    minConfirmationsNumber: minConfirmations,
    pollIntervalMs,
    websocketMinScanIntervalMs: configuredWebsocketMinScanIntervalMs,
    cursorHashCheckIntervalMs,
    maxLogBlockRange: BigInt(maxLogBlockRange),
    configuredStartBlock: startBlock,
    decimals: TOKEN_DECIMALS,
    decimalFactor: new BigNumber(10).pow(TOKEN_DECIMALS),
  };
}

function rpcCallAt(rpcUrl, method, params = []) {
  const requestBody = JSON.stringify({ jsonrpc: "2.0", id: ++rpcCounter, method, params });
  const requestBytes = Buffer.byteLength(requestBody);
  const startedAtMs = Date.now();
  const providerLabel = getRpcProviderLabel(rpcUrl);
  ensureRpcMetricsTimer();

  return new Promise((resolve, reject) => {
    let responseSize = 0;
    let statusCode = null;
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      recordRpcMetric({
        provider: providerLabel,
        method,
        durationMs: Math.max(0, Date.now() - startedAtMs),
        requestBytes,
        responseBytes: responseSize,
        statusCode,
        error,
      });
      if (error) reject(error);
      else resolve(result);
    };

    const request = https.request(rpcUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "Content-Length": requestBytes,
      },
    }, (response) => {
      statusCode = Number(response.statusCode || 0);
      const chunks = [];
      response.on("data", (chunk) => {
        responseSize += chunk.length;
        if (responseSize > RPC_MAX_RESPONSE_BYTES) {
          request.destroy(new Error("BSC RPC response exceeded the size limit."));
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => {
        if (statusCode < 200 || statusCode >= 300) {
          const error = new Error(`BSC RPC returned HTTP ${statusCode}.`);
          error.httpStatus = statusCode;
          finish(error);
          return;
        }
        let payload;
        try {
          payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch {
          finish(new Error("BSC RPC returned invalid JSON."));
          return;
        }
        if (payload.error) {
          const error = new Error(`BSC RPC ${method} failed: ${String(payload.error.message || "unknown error")}`);
          if (Number.isInteger(Number(payload.error.code))) error.rpcCode = Number(payload.error.code);
          if (payload.error.data !== undefined) error.rpcData = payload.error.data;
          finish(error);
          return;
        }
        if (!Object.prototype.hasOwnProperty.call(payload, "result")) {
          finish(new Error(`BSC RPC ${method} returned no result.`));
          return;
        }
        finish(null, payload.result);
      });
    });
    request.setTimeout(RPC_TIMEOUT_MS, () => request.destroy(new Error(`BSC RPC ${method} timed out.`)));
    request.on("error", (error) => finish(error));
    request.end(requestBody);
  });
}

async function validateRpcEndpoint(rpcUrl) {
  const chainId = BigInt(await rpcCallAt(rpcUrl, "eth_chainId", []));
  if (chainId !== CHAIN_ID) {
    throw new Error(`RPC endpoint is on chain ${chainId}, not BNB Smart Chain mainnet 56.`);
  }
  const code = await rpcCallAt(rpcUrl, "eth_getCode", [paymentConfig.tokenAddress, "latest"]);
  if (typeof code !== "string" || code === "0x" || code === "0x0") {
    throw new Error("The approved BSC-USD contract is not deployed on the RPC endpoint.");
  }
  const decimalsResult = await rpcCallAt(rpcUrl, "eth_call", [
    { to: paymentConfig.tokenAddress, data: "0x313ce567" }, "latest",
  ]);
  if (Number(BigInt(decimalsResult)) !== TOKEN_DECIMALS) {
    throw new Error("The approved Binance-Peg BSC-USD token must use 18 decimals.");
  }
  validatedRpcUrls.add(rpcUrl);
}

async function rpcCall(method, params = []) {
  if (!paymentConfig || !paymentConfig.enabled) {
    throw new Error("BEP-20 payment provider is not initialized.");
  }
  const candidates = getRpcCandidates(paymentConfig.incomingRpcFailoverState);
  if (!candidates.length) {
    throw new Error("All incoming BSC RPC endpoints are temporarily unavailable or disabled by the failover circuit.");
  }

  let lastError = null;
  for (const rpcUrl of candidates) {
    try {
      if (!validatedRpcUrls.has(rpcUrl)) await validateRpcEndpoint(rpcUrl);
      const result = await rpcCallAt(rpcUrl, method, params);
      recordRpcSuccess(paymentConfig.incomingRpcFailoverState, rpcUrl);
      paymentConfig.lastSuccessfulRpcUrl = rpcUrl;
      return result;
    } catch (error) {
      lastError = error;
      const failover = shouldTryRpcFallback(error);
      if (failover) {
        const circuit = recordRpcFailure(paymentConfig.incomingRpcFailoverState, rpcUrl, error);
        if (circuit.disabled) {
          validatedRpcUrls.delete(rpcUrl);
          console.error(`Incoming BSC RPC endpoint ${getRpcProviderLabel(rpcUrl)} was disabled after a permanent configuration or network validation error:`, error.message);
        } else {
          if (circuit.opened) {
            rpcMetricsWindow.failoverEvents += 1;
            rpcMetricsLifetimeWindow.failoverEvents += 1;
          }
          console.warn(`Incoming BSC RPC endpoint ${getRpcProviderLabel(rpcUrl)} is unavailable for ${paymentConfig.incomingRpcFailoverState.cooldownMs} ms; trying the configured fallback when available:`, error.message);
        }
      } else {
        // Deterministic JSON-RPC errors (for example, an unsupported optional
        // block tag) must not open the circuit or move routine traffic to the
        // paid fallback. The caller may use a compatible method on the primary.
        throw error;
      }
    }
  }
  throw new Error(`All available incoming BSC RPC endpoints failed for ${method}: ${lastError?.message || "unknown error"}`);
}

async function initializePaymentProvider() {
  const config = getPaymentConfigFromEnvironment();
  if (!config.enabled) {
    paymentConfig = config;
    validatedRpcUrls = new Set();
    console.log("BEP-20 payment monitoring is disabled.");
    return { enabled: false };
  }

  paymentConfig = config;
  validatedRpcUrls = new Set();
  cursorHashValidation = null;
  try {
    const latestBlock = BigInt(await rpcCall("eth_blockNumber", []));
    console.log(`BEP-20 treasury watcher ready. BSC block: ${latestBlock}; treasury: ${config.treasuryAddress}`);
    return {
      enabled: true,
      chainId: 56,
      tokenAddress: config.tokenAddress,
      treasuryAddress: config.treasuryAddress,
      rpcValidated: true,
    };
  } catch (error) {
    // Keep the watcher active so it can retry RPC discovery after a temporary outage.
    console.warn("No configured BSC RPC endpoint is currently usable. The payment scanner will remain active and retry without advancing its database cursor:", error.message);
    return {
      enabled: true,
      chainId: 56,
      tokenAddress: config.tokenAddress,
      treasuryAddress: config.treasuryAddress,
      rpcValidated: false,
    };
  }
}

function getConnection(db) {
  return new Promise((resolve, reject) => {
    db.getConnection((error, connection) => error ? reject(error) : resolve(connection));
  });
}

async function acquireScannerLock(db) {
  const connection = await getConnection(db);
  const queryable = connection.promise();
  try {
    const [rows] = await queryable.query("SELECT GET_LOCK(?,0) AS acquired", [TREASURY_SCAN_LOCK]);
    if (Number(rows[0]?.acquired) !== 1) {
      connection.release();
      return null;
    }
    return async () => {
      try {
        await queryable.query("SELECT RELEASE_LOCK(?)", [TREASURY_SCAN_LOCK]);
      } finally {
        connection.release();
      }
    };
  } catch (error) {
    connection.release();
    throw error;
  }
}

async function getSafeBlock() {
  try {
    const finalized = await rpcCall("eth_getBlockByNumber", ["finalized", false]);
    if (finalized && finalized.number != null && /^0x[0-9a-f]+$/i.test(String(finalized.number))) {
      return { number: BigInt(finalized.number), hash: String(finalized.hash || "").toLowerCase(), method: "finalized" };
    }
  } catch (error) {
    if (Date.now() - lastFinalityFallbackWarningAtMs >= 5 * 60 * 1000) {
      lastFinalityFallbackWarningAtMs = Date.now();
      console.warn("BSC RPC does not provide the finalized block tag; using the confirmation fallback:", error.message);
    }
  }

  const latest = BigInt(await rpcCall("eth_blockNumber", []));
  const subtract = paymentConfig.minConfirmations - 1n;
  const number = latest >= subtract ? latest - subtract : 0n;
  const block = await rpcCall("eth_getBlockByNumber", [toQuantity(number), false]);
  if (!block || !block.hash) throw new Error("Unable to verify the BSC confirmation fallback block.");
  return { number, hash: String(block.hash).toLowerCase(), method: "confirmations" };
}

async function initializeScanState(db, safeBlock) {
  const rows = await db.queryAsync(
    "SELECT * FROM bsc_incoming_scan_state WHERE singleton_id=1 LIMIT 1",
  );
  if (rows.length) {
    const row = rows[0];
    if (
      Number(row.chain_id) !== 56 ||
      String(row.token_contract).toLowerCase() !== paymentConfig.tokenAddressLower ||
      String(row.treasury_address).toLowerCase() !== paymentConfig.treasuryAddressLower
    ) {
      const message = "BSC incoming scan state belongs to another chain, token or treasury address. Automatic crediting is halted until the configured scanner identity is reviewed.";
      await db.queryAsync(
        `UPDATE bsc_incoming_scan_state
         SET health_status='manual_review',manual_review_code='configuration_identity_changed',
             manual_review_at_ms=COALESCE(manual_review_at_ms,?),last_error=?,updated_at_ms=?
         WHERE singleton_id=1`,
        [String(Date.now()), message, String(Date.now())],
      );
      throw new Error(message);
    }
    // Do not promote the persisted cursor to a canonical checkpoint here.
    // It may be the very hash mismatch that caused manual_review. Only checkpoints
    // written after a successfully completed scan or an audited reconciliation are trusted.
    return row;
  }

  const startBlock = paymentConfig.configuredStartBlock === null
    ? safeBlock.number
    : paymentConfig.configuredStartBlock;
  if (startBlock > safeBlock.number) {
    throw new RangeError(
      `USDT_INCOMING_START_BLOCK (${startBlock}) is newer than the latest finalized BSC block (${safeBlock.number}). ` +
      "The scanner will keep retrying and the treasury address will remain hidden until the configuration is corrected.",
    );
  }
  const initialCursor = startBlock === 0n ? null : startBlock - 1n;
  const checkpointBlockNumber = initialCursor === null ? 0n : initialCursor;
  const initialCursorBlock = await rpcCall(
    "eth_getBlockByNumber",
    [toQuantity(checkpointBlockNumber), false],
  );
  const initialCursorHash = String(initialCursorBlock?.hash || "").toLowerCase();
  if (!/^0x[0-9a-f]{64}$/i.test(initialCursorHash)) {
    throw new Error("Unable to obtain the initial BSC scan checkpoint hash.");
  }
  if (initialCursor !== null) {
    cursorHashValidation = {
      blockNumber: initialCursor.toString(),
      blockHash: initialCursorHash,
      rpcUrl: (paymentConfig.lastSuccessfulRpcUrl || paymentConfig.primaryIncomingRpcUrl),
      lastValidatedAtMs: Date.now(),
    };
  }

  await db.queryAsync(
    `INSERT INTO bsc_incoming_scan_state
     (singleton_id,chain_id,token_contract,treasury_address,scan_start_block,last_scanned_block,
      last_scanned_block_hash,last_finalized_block,finality_method,health_status,last_error,updated_at_ms)
     VALUES(1,56,?,?,?,?,?,?,?,'healthy',NULL,?)`,
    [
      paymentConfig.tokenAddress,
      paymentConfig.treasuryAddress,
      startBlock.toString(),
      initialCursor === null ? null : initialCursor.toString(),
      initialCursor === null ? null : initialCursorHash,
      safeBlock.number.toString(),
      safeBlock.method,
      String(Date.now()),
    ],
  );
  await db.queryAsync(
    `INSERT IGNORE INTO bsc_scan_checkpoints
     (block_number,block_hash,finality_method,checkpoint_status,created_at_ms)
     VALUES(?,?,?,'canonical',?)`,
    [checkpointBlockNumber.toString(), initialCursorHash, safeBlock.method, String(Date.now())],
  );
  if (paymentConfig.configuredStartBlock === null) {
    console.warn(
      `BSC incoming scanner initialized at finalized block ${startBlock}. ` +
      "Set USDT_INCOMING_START_BLOCK explicitly when historical treasury deposits must also be indexed.",
    );
  }
  const createdRows = await db.queryAsync("SELECT * FROM bsc_incoming_scan_state WHERE singleton_id=1 LIMIT 1");
  return createdRows[0] || null;
}

async function getCachedScanRpcResult(cache, bucketName, key, method, params) {
  const bucket = cache?.[bucketName];
  if (!bucket) return rpcCall(method, params);
  if (!bucket.has(key)) bucket.set(key, rpcCall(method, params));
  return bucket.get(key);
}

async function verifyFinalizedTransfer(log, scanRpcCache = null) {
  if (!log || log.removed || !Array.isArray(log.topics) || log.topics.length < 3) return null;
  if (String(log.address || "").toLowerCase() !== paymentConfig.tokenAddressLower) return null;
  if (String(log.topics[0] || "").toLowerCase() !== TRANSFER_TOPIC) return null;
  if (!/^0x[0-9a-fA-F]{64}$/.test(String(log.topics[1] || ""))) return null;
  if (!/^0x[0-9a-fA-F]{64}$/.test(String(log.topics[2] || ""))) return null;
  if (!/^0x[0-9a-fA-F]{64}$/.test(String(log.data || ""))) return null;

  const txHash = String(log.transactionHash || "").toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(txHash)) return null;
  const blockNumber = BigInt(log.blockNumber);
  const blockHash = String(log.blockHash || "").toLowerCase();
  const logIndex = Number(BigInt(log.logIndex));
  if (!Number.isSafeInteger(logIndex) || logIndex < 0) return null;

  const receipt = await getCachedScanRpcResult(scanRpcCache, "receipts", txHash, "eth_getTransactionReceipt", [txHash]);
  if (!receipt) return { pending: true };
  if (String(receipt.status || "").toLowerCase() !== "0x1") return { ignored: true };
  if (
    String(receipt.transactionHash || "").toLowerCase() !== txHash ||
    String(receipt.blockHash || "").toLowerCase() !== blockHash ||
    BigInt(receipt.blockNumber) !== blockNumber || !Array.isArray(receipt.logs)
  ) return { pending: true };

  const receiptLog = receipt.logs.find((item) =>
    Number(BigInt(item.logIndex)) === logIndex &&
    String(item.address || "").toLowerCase() === paymentConfig.tokenAddressLower &&
    String(item.topics?.[0] || "").toLowerCase() === TRANSFER_TOPIC &&
    String(item.topics?.[1] || "").toLowerCase() === String(log.topics[1]).toLowerCase() &&
    String(item.topics?.[2] || "").toLowerCase() === String(log.topics[2]).toLowerCase() &&
    String(item.data || "").toLowerCase() === String(log.data).toLowerCase(),
  );
  if (!receiptLog) return { ignored: true };

  const canonicalBlock = await getCachedScanRpcResult(scanRpcCache, "blocks", blockNumber.toString(), "eth_getBlockByNumber", [toQuantity(blockNumber), false]);
  if (!canonicalBlock || String(canonicalBlock.hash || "").toLowerCase() !== blockHash) {
    return { pending: true };
  }
  const blockTimestampMs = Number(BigInt(canonicalBlock.timestamp)) * 1000;
  if (!Number.isSafeInteger(blockTimestampMs) || blockTimestampMs <= 0) return { pending: true };

  const amountRaw = BigInt(log.data);
  if (amountRaw <= 0n) return { ignored: true };
  const fromAddress = getAddress(`0x${String(log.topics[1]).slice(-40)}`);
  const toAddress = getAddress(`0x${String(log.topics[2]).slice(-40)}`);
  if (/^0x0{40}$/i.test(fromAddress)) return { ignored: true };
  if (toAddress.toLowerCase() !== paymentConfig.treasuryAddressLower) return null;
  return {
    txHash,
    logIndex,
    blockNumber: blockNumber.toString(),
    blockHash,
    blockTimestampMs,
    fromAddress,
    treasuryAddress: toAddress,
    amountRaw: amountRaw.toString(),
    amount: new BigNumber(amountRaw.toString()).shiftedBy(-TOKEN_DECIMALS).toFixed(TOKEN_DECIMALS),
  };
}

async function persistUnknownTransfer(db, event) {
  const registryRows = await db.queryAsync(
    "SELECT username FROM bsc_wallet_address_registry WHERE wallet_address_lower=? LIMIT 1",
    [event.fromAddress.toLowerCase()],
  );
  const identity = createBscEventIdentity(event.txHash, event.logIndex, event.blockHash);
  await db.queryAsync(
    `INSERT IGNORE INTO bsc_unknown_incoming_transfers
     (token_contract,from_address,to_address,amount,amount_raw,tx_hash,log_index,block_number,block_hash,
      block_timestamp_ms,previous_username,status,decision_action,event_identity,created_at_ms,updated_at_ms)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,'pending_admin',NULL,?,?,?)`,
    [
      paymentConfig.tokenAddress,
      event.fromAddress,
      event.treasuryAddress,
      event.amount,
      event.amountRaw,
      event.txHash,
      event.logIndex,
      event.blockNumber,
      event.blockHash,
      String(event.blockTimestampMs),
      registryRows[0]?.username || null,
      identity,
      String(Date.now()),
      String(Date.now()),
    ],
  );
  const rows = await db.queryAsync(
    `SELECT id,status FROM bsc_unknown_incoming_transfers WHERE event_identity=? LIMIT 1`, [identity],
  );
  if (!rows.length) throw new Error("The finalized unknown BSC-USD transfer could not be persisted.");
  return { id: String(rows[0].id), status: String(rows[0].status) };
}

async function scanTreasury(db, safeBlock) {
  let state = await initializeScanState(db, safeBlock);
  if (state.health_status !== "healthy") {
    throw new Error(`BSC incoming scanner requires review: ${state.last_error || state.health_status}`);
  }

  if (state.last_scanned_block !== null && state.last_scanned_block_hash) {
    const activeRpcUrl = (paymentConfig.lastSuccessfulRpcUrl || paymentConfig.primaryIncomingRpcUrl);
    const shouldCheckCursor = shouldValidateCursorHash({
      safeBlockMethod: safeBlock.method,
      cached: cursorHashValidation,
      blockNumber: state.last_scanned_block,
      blockHash: state.last_scanned_block_hash,
      rpcUrl: activeRpcUrl,
      intervalMs: paymentConfig.cursorHashCheckIntervalMs,
    });
    if (shouldCheckCursor) {
      const cursorBlock = await rpcCall("eth_getBlockByNumber", [toQuantity(state.last_scanned_block), false]);
      const checkedRpcUrl = (paymentConfig.lastSuccessfulRpcUrl || paymentConfig.primaryIncomingRpcUrl);
      if (!cursorBlock || String(cursorBlock.hash || "").toLowerCase() !== String(state.last_scanned_block_hash).toLowerCase()) {
        cursorHashValidation = null;
        const message = "The stored BSC scan cursor no longer matches the canonical block. Automatic crediting has been halted for administrative reconciliation.";
        await db.queryAsync(
          `UPDATE bsc_incoming_scan_state
           SET health_status='manual_review',manual_review_code='cursor_hash_mismatch',
               manual_review_at_ms=COALESCE(manual_review_at_ms,?),last_error=?,updated_at_ms=?
           WHERE singleton_id=1`,
          [String(Date.now()), message, String(Date.now())],
        );
        throw new Error(message);
      }
      cursorHashValidation = {
        blockNumber: String(state.last_scanned_block),
        blockHash: String(state.last_scanned_block_hash).toLowerCase(),
        rpcUrl: checkedRpcUrl,
        lastValidatedAtMs: Date.now(),
      };
    }
  }

  const fromBlock = state.last_scanned_block === null
    ? BigInt(state.scan_start_block)
    : BigInt(state.last_scanned_block) + 1n;
  if (safeBlock.number < fromBlock) return { scanned: false, reason: "awaiting_finality" };

  const toBlock = minBigInt(safeBlock.number, fromBlock + paymentConfig.maxLogBlockRange - 1n);
  const logs = await rpcCall("eth_getLogs", [{
    fromBlock: toQuantity(fromBlock),
    toBlock: toQuantity(toBlock),
    address: paymentConfig.tokenAddress,
    topics: [TRANSFER_TOPIC, null, addressTopic(paymentConfig.treasuryAddress)],
  }]);
  if (!Array.isArray(logs)) throw new Error("BSC RPC returned an invalid eth_getLogs result.");

  logs.sort((left, right) => {
    const blockDiff = BigInt(left.blockNumber) - BigInt(right.blockNumber);
    if (blockDiff !== 0n) return blockDiff < 0n ? -1 : 1;
    return Number(BigInt(left.logIndex)) - Number(BigInt(right.logIndex));
  });

  let processed = 0;
  const scanRpcCache = { receipts: new Map(), blocks: new Map() };
  for (const log of logs) {
    const event = await verifyFinalizedTransfer(log, scanRpcCache);
    if (event?.pending) throw new Error("A BSC transfer receipt or canonical block is not yet consistent; the scan cursor was not advanced.");
    if (!event || event.ignored) continue;

    const accountRows = await db.queryAsync(
      `SELECT username FROM auths WHERE LOWER(wallet_address)=? LIMIT 1`,
      [event.fromAddress.toLowerCase()],
    );
    if (!accountRows.length) {
      const unknownSource = await persistUnknownTransfer(db, event);
      const handled = await transferHandler({ ...event, unknownTransferId: unknownSource.id });
      if (handled?.unknown) {
        throw new Error("An official BSC-USD transfer from an unregistered address was not assigned to the automatic refund registry.");
      }
      processed += 1;
      continue;
    }

    const handled = await transferHandler({
      username: accountRows[0].username,
      depositAccountStatus: "active",
      ...event,
    });
    if (handled?.unknown) await persistUnknownTransfer(db, event);
    processed += 1;
  }

  const cursorBlock = await rpcCall("eth_getBlockByNumber", [toQuantity(toBlock), false]);
  if (!cursorBlock || !/^0x[0-9a-f]{64}$/i.test(String(cursorBlock.hash || ""))) {
    throw new Error("BSC RPC did not return a canonical hash for the scanned range endpoint.");
  }
  const now = String(Date.now());
  await db.queryAsync(
    `UPDATE bsc_incoming_scan_state
     SET last_scanned_block=?,last_scanned_block_hash=?,last_finalized_block=?,finality_method=?,
         health_status='healthy',manual_review_code=NULL,manual_review_at_ms=NULL,last_error=NULL,updated_at_ms=?
     WHERE singleton_id=1`,
    [
      toBlock.toString(),
      String(cursorBlock.hash).toLowerCase(),
      safeBlock.number.toString(),
      safeBlock.method,
      now,
    ],
  );
  await saveScanCheckpointIfDue(db, toBlock, String(cursorBlock.hash).toLowerCase(), safeBlock.method, now);
  const cursorRpcUrl = (paymentConfig.lastSuccessfulRpcUrl || paymentConfig.primaryIncomingRpcUrl);
  const previousValidationAtMs = cursorHashValidation?.rpcUrl === cursorRpcUrl
    ? Number(cursorHashValidation.lastValidatedAtMs || cursorHashValidation.checkedAtMs || 0)
    : 0;
  cursorHashValidation = {
    blockNumber: toBlock.toString(),
    blockHash: String(cursorBlock.hash).toLowerCase(),
    rpcUrl: cursorRpcUrl,
    lastValidatedAtMs: previousValidationAtMs || Date.now(),
  };
  return { scanned: true, fromBlock: fromBlock.toString(), toBlock: toBlock.toString(), events: processed };
}

function startPaymentWatcher(db, onTransfer, onMaintenance) {
  if (!paymentConfig || !paymentConfig.enabled) return { enabled: false };
  if (watcherTimer) return { enabled: true };
  if (typeof onTransfer !== "function") throw new TypeError("A confirmed-transfer handler is required.");

  watcherDatabase = db;
  transferHandler = onTransfer;
  maintenanceHandler = typeof onMaintenance === "function" ? onMaintenance : null;

  const scheduleScan = (delayMs) => {
    if (watcherTimer) clearTimeout(watcherTimer);
    watcherTimer = setTimeout(() => {
      watcherTimer = null;
      void scan();
    }, delayMs);
    if (typeof watcherTimer.unref === "function") watcherTimer.unref();
  };

  const scan = async () => {
    if (watcherRunning) {
      watcherWakeRequested = true;
      return;
    }
    watcherRunning = true;
    lastWatcherScanStartedAtMs = Date.now();
    let releaseLock = null;
    try {
      releaseLock = await acquireScannerLock(watcherDatabase);
      if (!releaseLock) return;
      const safeBlock = await getSafeBlock();
      const result = await scanTreasury(watcherDatabase, safeBlock);
      if (result.scanned && result.events > 0) {
        console.log(`BSC treasury scanner processed ${result.events} incoming event(s) in blocks ${result.fromBlock}-${result.toBlock}.`);
      }
      if (maintenanceHandler) await maintenanceHandler();
    } catch (error) {
      console.error("BSC treasury incoming scanner failed; the stored block cursor was preserved:", error.message);
    } finally {
      if (releaseLock) await releaseLock().catch((error) => console.error("BSC scanner lock release failed:", error.message));
      watcherRunning = false;
      const minimumIntervalMs = paymentConfig?.websocketMinScanIntervalMs || paymentConfig?.pollIntervalMs || 5000;
      const websocketDelay = getWebsocketScanDelay(lastWatcherScanStartedAtMs, minimumIntervalMs);
      const nextDelay = watcherWakeRequested
        ? websocketDelay
        : (paymentConfig?.pollIntervalMs || 5000);
      watcherWakeRequested = false;
      scheduleScan(nextDelay);
    }
  };

  scheduleScan(0);
  if (paymentConfig.websocketRpcUrl) {
    const incomingLogFilter = {
      address: paymentConfig.tokenAddress,
      topics: [TRANSFER_TOPIC, null, addressTopic(paymentConfig.treasuryAddress)],
    };

    const scheduleWebsocketReconnect = (reason) => {
      if (!paymentConfig?.websocketRpcUrl || watcherWsReconnectTimer || watcherWsConnecting) return;
      const delayMs = watcherWsReconnectDelayMs;
      watcherWsReconnectDelayMs = getNextWebsocketReconnectDelay(delayMs);
      console.warn(`Incoming BSC WebSocket hint will reconnect in ${delayMs} ms; HTTP polling and cursor recovery remain active:`, reason);
      watcherWsReconnectTimer = setTimeout(() => {
        watcherWsReconnectTimer = null;
        void connectWebsocketHint();
      }, delayMs);
      if (typeof watcherWsReconnectTimer.unref === "function") watcherWsReconnectTimer.unref();
    };

    const handleWebsocketFailure = (wsProvider, error) => {
      if (watcherWsProvider !== wsProvider) return;
      recordWebsocketMetric("error");
      watcherWsProvider = null;
      try { wsProvider.destroy(); } catch {}
      scheduleWebsocketReconnect(error?.message || "WebSocket connection closed");
    };

    const connectWebsocketHint = async () => {
      if (watcherWsConnecting || watcherWsProvider || !paymentConfig?.websocketRpcUrl) return;
      watcherWsConnecting = true;
      const wsProvider = new WebSocketProvider(paymentConfig.websocketRpcUrl);
      try {
        const network = await withTimeout(
          wsProvider.getNetwork(), 15000, "Incoming BSC WebSocket network detection",
        );
        if (BigInt(network.chainId) !== CHAIN_ID) {
          throw new Error(`WebSocket RPC is on chain ${network.chainId}, not BNB Smart Chain mainnet 56.`);
        }
        const wakeForIncomingLog = (log) => {
          // WebSocket logs are notifications only. They are never credited
          // directly; the finalized HTTP scanner validates the durable range.
          recordWebsocketMetric("notification");
          if (log?.removed) {
            console.warn("Incoming BSC WebSocket reported a removed log; the finalized HTTP scanner will re-check its canonical range.");
          }
          if (watcherRunning) {
            watcherWakeRequested = true;
            return;
          }
          const minimumIntervalMs = paymentConfig?.websocketMinScanIntervalMs || paymentConfig?.pollIntervalMs || 10000;
          scheduleScan(getWebsocketScanDelay(lastWatcherScanStartedAtMs, minimumIntervalMs));
        };
        watcherWsProvider = wsProvider;
        attachEthersRpcMetrics(wsProvider, paymentConfig.websocketRpcUrl, "incoming-scanner-websocket");
        await withTimeout(
          wsProvider.on("error", (error) => handleWebsocketFailure(wsProvider, error)),
          15000, "Incoming BSC WebSocket error-listener registration",
        );
        await withTimeout(
          wsProvider.on(incomingLogFilter, wakeForIncomingLog),
          15000, "Incoming BSC WebSocket log subscription",
        );
        watcherWsReconnectDelayMs = 5000;
        console.log("Incoming BSC WebSocket Transfer subscription connected; finalized HTTP scanning remains the source of truth.");
      } catch (error) {
        if (watcherWsProvider === wsProvider) watcherWsProvider = null;
        try { wsProvider.destroy(); } catch {}
        scheduleWebsocketReconnect(error);
      } finally {
        watcherWsConnecting = false;
        if (!watcherWsProvider) scheduleWebsocketReconnect("WebSocket setup did not complete");
      }
    };

    void connectWebsocketHint();
    if (!watcherWsHealthTimer) {
      watcherWsHealthTimer = setInterval(() => {
        if (!watcherWsProvider) {
          scheduleWebsocketReconnect("no active WebSocket provider");
          return;
        }
        const readyState = Number(watcherWsProvider.websocket?.readyState);
        // WebSocket.OPEN is 1. A closed or closing socket is recreated with
        // bounded exponential backoff; ordinary HTTP polling never pauses.
        if (readyState === 2 || readyState === 3) {
          handleWebsocketFailure(watcherWsProvider, new Error(`WebSocket readyState=${readyState}`));
        }
      }, 15000);
      if (typeof watcherWsHealthTimer.unref === "function") watcherWsHealthTimer.unref();
    }
  }
  return { enabled: true, treasuryAddress: paymentConfig.treasuryAddress, websocketHint: Boolean(paymentConfig.websocketRpcUrl) };
}


async function saveScanCheckpointIfDue(db, blockNumber, blockHash, finalityMethod, now = String(Date.now())) {
  const rows = await db.queryAsync(
    `SELECT block_number FROM bsc_scan_checkpoints
     WHERE checkpoint_status='canonical' ORDER BY block_number DESC LIMIT 1`,
  );
  const last = rows.length ? BigInt(rows[0].block_number) : null;
  if (last === null || BigInt(blockNumber) - last >= SCAN_CHECKPOINT_INTERVAL_BLOCKS) {
    await db.queryAsync(
      `INSERT IGNORE INTO bsc_scan_checkpoints
       (block_number,block_hash,finality_method,checkpoint_status,created_at_ms)
       VALUES(?,?,?,'canonical',?)`,
      [String(blockNumber), String(blockHash).toLowerCase(), String(finalityMethod || "confirmations"), now],
    );
  }
}

async function getRpcFinalizedSnapshot(rpcUrl) {
  await validateRpcEndpoint(rpcUrl);
  let number;
  let method = "finalized";
  try {
    const finalized = await rpcCallAt(rpcUrl, "eth_getBlockByNumber", ["finalized", false]);
    if (!finalized || finalized.number == null || !finalized.hash) throw new Error("No finalized block returned");
    number = BigInt(finalized.number);
  } catch {
    method = "confirmations";
    const latest = BigInt(await rpcCallAt(rpcUrl, "eth_blockNumber", []));
    const backoff = paymentConfig.minConfirmations - 1n;
    number = latest >= backoff ? latest - backoff : 0n;
  }
  const block = await rpcCallAt(rpcUrl, "eth_getBlockByNumber", [toQuantity(number), false]);
  const hash = String(block?.hash || "").toLowerCase();
  if (!block || BigInt(block.number) !== number || !/^0x[0-9a-f]{64}$/.test(hash)) {
    throw new Error(`RPC endpoint did not return a valid finalized block ${number}.`);
  }
  return { rpcUrl, number, hash, method };
}

async function getIndependentRpcConsensus() {
  if (!paymentConfig || !paymentConfig.enabled) throw new Error("BSC payment monitoring is not enabled.");
  if (paymentConfig.incomingRpcUrls.length < 2) {
    throw new Error("Scanner reconciliation requires two independently configured HTTPS RPC endpoints.");
  }
  const snapshots = [];
  for (const rpcUrl of paymentConfig.incomingRpcUrls) snapshots.push(await getRpcFinalizedSnapshot(rpcUrl));
  const safeNumber = snapshots.reduce((minimum, snapshot) => minBigInt(minimum, snapshot.number), snapshots[0].number);
  const blocks = await Promise.all(snapshots.map(async (snapshot) => {
    const block = await rpcCallAt(snapshot.rpcUrl, "eth_getBlockByNumber", [toQuantity(safeNumber), false]);
    const hash = String(block?.hash || "").toLowerCase();
    if (!block || BigInt(block.number) !== safeNumber || !/^0x[0-9a-f]{64}$/.test(hash)) {
      throw new Error(`RPC endpoint failed to verify finalized block ${safeNumber}.`);
    }
    return { rpcUrl: snapshot.rpcUrl, hash, method: snapshot.method };
  }));
  const hashes = new Set(blocks.map((block) => block.hash));
  if (hashes.size !== 1) {
    throw new Error("Configured BSC RPC endpoints disagree on the latest common finalized block.");
  }
  return {
    number: safeNumber,
    hash: blocks[0].hash,
    method: blocks.every((block) => block.method === "finalized") ? "finalized" : "confirmations",
    rpcUrls: snapshots.map((snapshot) => snapshot.rpcUrl),
  };
}

async function getCanonicalBlockHashConsensus(rpcUrls, blockNumber) {
  const results = await Promise.all(rpcUrls.map(async (rpcUrl) => {
    const block = await rpcCallAt(rpcUrl, "eth_getBlockByNumber", [toQuantity(blockNumber), false]);
    const hash = String(block?.hash || "").toLowerCase();
    if (!block || BigInt(block.number) !== BigInt(blockNumber) || !/^0x[0-9a-f]{64}$/.test(hash)) {
      throw new Error(`An RPC endpoint could not verify block ${blockNumber}.`);
    }
    return hash;
  }));
  if (new Set(results).size !== 1) {
    throw new Error(`Configured BSC RPC endpoints disagree on block ${blockNumber}.`);
  }
  return results[0];
}

async function findLatestCommonCheckpoint(db, rpcUrls, finalizedBlock) {
  const checkpoints = await db.queryAsync(
    `SELECT block_number,block_hash,finality_method
     FROM bsc_scan_checkpoints
     WHERE checkpoint_status='canonical' AND block_number<=?
     ORDER BY block_number DESC LIMIT ?`,
    [String(finalizedBlock), MAX_RECONCILIATION_CHECKPOINTS],
  );
  for (const checkpoint of checkpoints) {
    const canonicalHash = await getCanonicalBlockHashConsensus(rpcUrls, BigInt(checkpoint.block_number));
    if (canonicalHash === String(checkpoint.block_hash).toLowerCase()) {
      return {
        blockNumber: BigInt(checkpoint.block_number),
        blockHash: canonicalHash,
        finalityMethod: checkpoint.finality_method || "confirmations",
      };
    }
  }
  throw new Error("No stored historical checkpoint matches the canonical finalized chain. Automatic reconciliation is unsafe; operator-led forensic review is required.");
}

function matchesStoredTransferLog(log, event) {
  if (!log || String(log.address || "").toLowerCase() !== paymentConfig.tokenAddressLower) return false;
  if (String(log.topics?.[0] || "").toLowerCase() !== TRANSFER_TOPIC) return false;
  const fromTopic = String(log.topics?.[1] || "").toLowerCase();
  const toTopic = String(log.topics?.[2] || "").toLowerCase();
  const expectedFrom = addressTopic(String(event.from_address || event.fromAddress || "0x0000000000000000000000000000000000000000")).toLowerCase();
  const expectedTo = addressTopic(String(event.to_address || event.treasury_address || event.treasuryAddress || paymentConfig.treasuryAddress)).toLowerCase();
  let amountMatches = false;
  try { amountMatches = BigInt(log.data).toString() === BigInt(event.amount_raw).toString(); } catch {}
  return fromTopic === expectedFrom && toTopic === expectedTo && amountMatches;
}

async function inspectTransferReceiptAtRpc(rpcUrl, event) {
  const txHash = String(event.tx_hash || event.txHash).toLowerCase();
  const receipt = await rpcCallAt(rpcUrl, "eth_getTransactionReceipt", [txHash]);
  if (!receipt) return {
    receipt: null,
    matchingLog: false,
    matchingLogAmbiguous: false,
    matchingLogIndex: null,
    canonical: false,
    blockTimestampMs: null,
  };
  const matchingLogs = Array.isArray(receipt.logs)
    ? receipt.logs.filter((log) => matchesStoredTransferLog(log, event))
    : [];
  const matchingLogAmbiguous = matchingLogs.length > 1;
  const matchingLog = matchingLogs.length === 1;
  const matchingLogIndex = matchingLog ? String(BigInt(matchingLogs[0].logIndex)) : null;
  let canonical = false;
  let blockTimestampMs = null;
  if (receipt.blockNumber != null && receipt.blockHash) {
    const block = await rpcCallAt(rpcUrl, "eth_getBlockByNumber", [receipt.blockNumber, false]);
    canonical = Boolean(block && String(block.hash || "").toLowerCase() === String(receipt.blockHash).toLowerCase());
    if (canonical && block.timestamp != null) {
      const timestamp = Number(BigInt(block.timestamp) * 1000n);
      if (Number.isSafeInteger(timestamp) && timestamp > 0) blockTimestampMs = String(timestamp);
    }
  }
  return { receipt, matchingLog, matchingLogAmbiguous, matchingLogIndex, canonical, blockTimestampMs };
}

async function inspectStoredTransferEvent(event, rpcUrls, finalizedBlock) {
  const [left, right] = await Promise.all([
    inspectTransferReceiptAtRpc(rpcUrls[0], event),
    inspectTransferReceiptAtRpc(rpcUrls[1], event),
  ]);
  if (!left.receipt && !right.receipt) {
    const oldBlockHash = await getCanonicalBlockHashConsensus(rpcUrls, BigInt(event.block_number));
    if (oldBlockHash === String(event.block_hash || "").toLowerCase()) {
      return {
        classification: "unverifiable",
        reason: "receipt_missing_while_recorded_block_remains_canonical",
      };
    }
    return { classification: "orphaned", reason: "receipt_absent_and_recorded_block_is_not_canonical" };
  }
  const result = classifyReceiptPair(event, left, right);
  if (result.observedBlock != null && BigInt(result.observedBlock) > finalizedBlock) {
    return {
      classification: "unverifiable",
      reason: "re_included_receipt_is_not_finalized",
      observedBlock: result.observedBlock,
      observedBlockHash: result.observedBlockHash,
      observedLogIndex: result.observedLogIndex,
    };
  }
  return result;
}

async function loadAffectedIncomingEvents(db, ancestorBlock, previousBlock, rpcUrls, finalizedBlock) {
  const userEvents = await db.queryAsync(
    `SELECT e.id,e.username,e.batch_id,e.treasury_address,e.from_address,e.amount,e.amount_raw,
            e.tx_hash,e.log_index,e.block_number,e.block_hash,e.block_timestamp_ms,e.status,
            b.credited_amount AS batch_credited_amount,b.refunded_amount AS batch_refunded_amount,
            b.reserved_refund_amount AS batch_reserved_refund_amount,
            (SELECT COUNT(*) FROM users_usdt_deposit_credits c WHERE c.batch_id=e.batch_id) AS deposit_credit_count,
            (SELECT COUNT(*) FROM users_usdt_refunds r WHERE r.batch_id=e.batch_id) AS refund_count,
            (SELECT COUNT(*) FROM users_usdt_refunds r WHERE r.batch_id=e.batch_id
               AND r.status IN ('signed','submitted','completed','manual_review')) AS externally_effective_refund_count
     FROM users_usdt_transfer_events e
     LEFT JOIN users_usdt_deposit_batches b ON b.id=e.batch_id
     WHERE e.block_number>? AND e.block_number<=?
     ORDER BY e.block_number,e.log_index,e.id`,
    [ancestorBlock.toString(), previousBlock.toString()],
  );
  const unknownEvents = await db.queryAsync(
    `SELECT u.id,u.token_contract,u.from_address,u.to_address,u.amount,u.amount_raw,u.tx_hash,u.log_index,
            u.block_number,u.block_hash,u.block_timestamp_ms,u.status,u.refund_id,
            e.batch_id AS linked_batch_id,b.credited_amount AS linked_credited_amount,
            b.refunded_amount AS linked_refunded_amount,b.reserved_refund_amount AS linked_reserved_refund_amount,
            r.status AS refund_status,
            (SELECT COUNT(*) FROM users_usdt_refunds r2 WHERE r2.unknown_transfer_id=u.id
               AND r2.status IN ('signed','submitted','completed','manual_review')) AS externally_effective_refund_count
     FROM bsc_unknown_incoming_transfers u
     LEFT JOIN users_usdt_transfer_events e ON e.event_identity=u.event_identity
     LEFT JOIN users_usdt_deposit_batches b ON b.id=e.batch_id
     LEFT JOIN users_usdt_refunds r ON r.id=u.refund_id
     WHERE e.id IS NULL AND u.block_number>? AND u.block_number<=?
     ORDER BY u.block_number,u.log_index,u.id`,
    [ancestorBlock.toString(), previousBlock.toString()],
  );

  const items = [];
  for (const row of userEvents) {
    const observed = await inspectStoredTransferEvent(row, rpcUrls, finalizedBlock);
    const batchExists = row.batch_id != null && row.batch_credited_amount != null;
    const refundReservationWithoutJob =
      new BigNumber(row.batch_reserved_refund_amount || "0").isGreaterThan(0) &&
      Number(row.refund_count || 0) === 0;
    const financialImpact = !batchExists ||
      Number(row.deposit_credit_count || 0) > 0 ||
      new BigNumber(row.batch_credited_amount || "0").isGreaterThan(0) ||
      new BigNumber(row.batch_refunded_amount || "0").isGreaterThan(0) ||
      Number(row.externally_effective_refund_count || 0) > 0 ||
      refundReservationWithoutJob;
    items.push({
      sourceTable: "users_usdt_transfer_events",
      sourceId: String(row.id),
      txHash: row.tx_hash,
      logIndex: Number(row.log_index),
      batchId: row.batch_id == null ? null : String(row.batch_id),
      amount: String(row.amount),
      amountRaw: String(row.amount_raw),
      oldBlock: String(row.block_number),
      oldBlockHash: String(row.block_hash).toLowerCase(),
      classification: observed.classification,
      reason: observed.reason,
      observedBlock: observed.observedBlock || null,
      observedBlockHash: observed.observedBlockHash || null,
      observedTimestampMs: observed.observedTimestampMs || null,
      observedLogIndex: observed.observedLogIndex == null ? null : String(observed.observedLogIndex),
      financialImpact: financialImpact ? 1 : 0,
      resolutionStatus: "pending",
      details: { batchStatusImpact: financialImpact ? "compensation_required" : "uncredited_batch_can_be_reversed" },
    });
  }

  for (const row of unknownEvents) {
    const observed = await inspectStoredTransferEvent(row, rpcUrls, finalizedBlock);
    const linkedBatchExists = row.linked_batch_id != null && row.linked_credited_amount != null;
    const linkedFinancialImpact = linkedBatchExists && (
      new BigNumber(row.linked_credited_amount || "0").isGreaterThan(0) ||
      new BigNumber(row.linked_refunded_amount || "0").isGreaterThan(0) ||
      new BigNumber(row.linked_reserved_refund_amount || "0").isGreaterThan(0)
    );
    const refundMayHaveBeenBroadcast =
      ["signed", "submitted", "completed", "manual_review"].includes(String(row.refund_status || "")) ||
      Number(row.externally_effective_refund_count || 0) > 0;
    const financialImpact = refundMayHaveBeenBroadcast ||
      (row.status === "assigned_to_account" && !linkedBatchExists) || Boolean(linkedFinancialImpact);
    items.push({
      sourceTable: "bsc_unknown_incoming_transfers",
      sourceId: String(row.id),
      txHash: row.tx_hash,
      logIndex: Number(row.log_index),
      batchId: row.linked_batch_id == null ? null : String(row.linked_batch_id),
      amount: String(row.amount),
      amountRaw: String(row.amount_raw),
      oldBlock: String(row.block_number),
      oldBlockHash: String(row.block_hash).toLowerCase(),
      classification: observed.classification,
      reason: observed.reason,
      observedBlock: observed.observedBlock || null,
      observedBlockHash: observed.observedBlockHash || null,
      observedTimestampMs: observed.observedTimestampMs || null,
      observedLogIndex: observed.observedLogIndex == null ? null : String(observed.observedLogIndex),
      financialImpact: financialImpact ? 1 : 0,
      resolutionStatus: "pending",
      details: { previousStatus: row.status, linkedBatchId: row.linked_batch_id == null ? null : String(row.linked_batch_id) },
    });
  }
  return items;
}

function summarizeReconciliationItems(items) {
  return {
    total_events: items.length,
    canonical_events: items.filter((item) => item.classification === "canonical").length,
    re_included_events: items.filter((item) => item.classification === "re_included").length,
    orphaned_events: items.filter((item) => item.classification === "orphaned").length,
    unverifiable_events: items.filter((item) => item.classification === "unverifiable").length,
    compensation_required_events: items.filter((item) => item.classification === "orphaned" && item.financialImpact === 1).length,
  };
}

async function getIncomingScannerStatus(db, { includeRpcMetrics = false } = {}) {
  const rows = await db.queryAsync(
    "SELECT * FROM bsc_incoming_scan_state WHERE singleton_id=1 LIMIT 1",
  );
  if (!rows.length) {
    return {
      initialized: false,
      ...(includeRpcMetrics ? { rpc_metrics: getRpcMetricsAdminSnapshot() } : {}),
    };
  }
  const checkpointRows = await db.queryAsync(
    "SELECT COUNT(*) AS checkpoint_count,MAX(block_number) AS latest_checkpoint_block FROM bsc_scan_checkpoints WHERE checkpoint_status='canonical'",
  );
  const previewRows = await db.queryAsync(
    `SELECT id,status,scanner_reason_code,previous_block,previous_block_hash,candidate_resume_block,candidate_resume_hash,
            observed_finalized_block,rpc_endpoints_count,total_events,canonical_events,re_included_events,
            orphaned_events,unverifiable_events,compensation_required_events,created_by,created_at_ms,
            expires_at_ms,committed_at_ms,last_error
     FROM bsc_scan_reconciliation_previews ORDER BY id DESC LIMIT 1`,
  );
  let latestPreview = null;
  if (previewRows.length) {
    const preview = previewRows[0];
    const itemRows = await db.queryAsync(
      `SELECT id,source_table,source_id,tx_hash,log_index,batch_id,amount,old_block,old_block_hash,
              observed_block,observed_block_hash,observed_log_index,classification,financial_impact,
              resolution_status,compensation_reference,resolution_reason,resolved_by,resolved_at_ms
       FROM bsc_scan_reconciliation_items WHERE preview_id=? ORDER BY id`,
      [preview.id],
    );
    latestPreview = {
      ...preview,
      can_commit: preview.status === "previewed" && Number(preview.expires_at_ms) > Date.now() &&
        canCommitReconciliation(itemRows),
      items: itemRows,
    };
  }
  return {
    initialized: true,
    ...rows[0],
    ...(includeRpcMetrics ? { rpc_metrics: getRpcMetricsAdminSnapshot() } : {}),
    checkpoint_history: checkpointRows[0] || { checkpoint_count: 0, latest_checkpoint_block: null },
    latest_reconciliation_preview: latestPreview,
  };
}

async function previewIncomingScannerReconciliation(db, options = {}) {
  const reason = String(options.reason || "").trim();
  const adminUsername = String(options.adminUsername || "configured_admin").trim();
  if (reason.length < 5 || reason.length > 1000) throw new RangeError("A reconciliation reason of 5 to 1000 characters is required");
  if (!adminUsername || adminUsername.length > 64) throw new TypeError("Invalid administrator identifier");

  const releaseLock = await acquireScannerLock(db);
  if (!releaseLock) {
    const error = new Error("The BSC incoming scanner is currently processing a block range");
    error.code = "ONEX_BSC_SCANNER_BUSY";
    throw error;
  }
  try {
    if (!paymentConfig || !paymentConfig.enabled) throw new Error("BSC payment monitoring is not enabled");
    const stateRows = await db.queryAsync("SELECT * FROM bsc_incoming_scan_state WHERE singleton_id=1 LIMIT 1");
    if (!stateRows.length) throw new Error("The BSC incoming scanner has not initialized its cursor yet");
    const state = stateRows[0];
    if (state.health_status !== "manual_review") throw new Error("Reconciliation preview is allowed only while health_status is manual_review");
    if (Number(state.chain_id) !== 56 ||
        String(state.token_contract).toLowerCase() !== paymentConfig.tokenAddressLower ||
        String(state.treasury_address).toLowerCase() !== paymentConfig.treasuryAddressLower) {
      throw new Error("Scanner identity mismatch. Restore the original Chain ID, token contract and treasury address before attempting a chain reconciliation.");
    }
    const consensus = await getIndependentRpcConsensus();
    const cursorIsUnset = state.last_scanned_block == null;
    let previousBlock = null;
    let candidate;
    let items = [];

    if (cursorIsUnset) {
      // The only supported unset-cursor recovery is a configuration-only incident
      // before the first scan range completed. No incoming event may already exist.
      if (state.manual_review_code !== "configuration_identity_changed" || BigInt(state.scan_start_block) !== 0n) {
        throw new Error("The scanner has no completed cursor. Only a configuration-only review before the initial block-zero scan can be reconciled automatically.");
      }
      const [eventCounts, unknownCounts] = await Promise.all([
        db.queryAsync("SELECT COUNT(*) AS total FROM users_usdt_transfer_events"),
        db.queryAsync("SELECT COUNT(*) AS total FROM bsc_unknown_incoming_transfers"),
      ]);
      if (Number(eventCounts[0]?.total || 0) !== 0 || Number(unknownCounts[0]?.total || 0) !== 0) {
        throw new Error("Incoming events exist despite an unset scanner cursor. Operator-led forensic review is required.");
      }
      const initialBlockHash = await getCanonicalBlockHashConsensus(consensus.rpcUrls, 0n);
      candidate = { blockNumber: 0n, blockHash: initialBlockHash, finalityMethod: consensus.method };
    } else {
      if (!state.last_scanned_block_hash) throw new Error("The scanner cursor hash is missing; operator-led forensic review is required.");
      previousBlock = BigInt(state.last_scanned_block);
      if (consensus.number < previousBlock) {
        throw new Error("The agreed finalized RPC height is behind the scanner cursor. Wait for both RPC providers to catch up before previewing reconciliation.");
      }
      const storedCursorHash = String(state.last_scanned_block_hash).toLowerCase();
      const canonicalCursorHash = await getCanonicalBlockHashConsensus(consensus.rpcUrls, previousBlock);
      candidate = canonicalCursorHash === storedCursorHash
        ? { blockNumber: previousBlock, blockHash: canonicalCursorHash, finalityMethod: state.finality_method || consensus.method }
        : await findLatestCommonCheckpoint(db, consensus.rpcUrls, minBigInt(consensus.number, previousBlock - 1n));
      if (candidate.blockNumber > previousBlock ||
          (candidate.blockNumber === previousBlock && candidate.blockHash !== storedCursorHash)) {
        throw new Error("The reconciliation checkpoint is not a verified ancestor of the scanner cursor.");
      }
      items = await loadAffectedIncomingEvents(db, candidate.blockNumber, previousBlock, consensus.rpcUrls, consensus.number);
    }
    {
      const summary = summarizeReconciliationItems(items);
      const now = Date.now();
      const connection = await getConnection(db);
      const tx = connection.promise();
      let previewId;
      try {
        await tx.beginTransaction();
        await tx.query(
          `UPDATE bsc_scan_reconciliation_previews SET status='expired'
           WHERE status='previewed' AND expires_at_ms<=?`, [String(now)],
        );
        const [activePreviewRows] = await tx.query(
          `SELECT id FROM bsc_scan_reconciliation_previews
           WHERE status='previewed' AND expires_at_ms>? ORDER BY id DESC LIMIT 1 FOR UPDATE`,
          [String(now)],
        );
        if (activePreviewRows.length) {
          throw new Error(`Reconciliation preview ${activePreviewRows[0].id} is still active. Resolve or commit it, or wait for it to expire before creating another preview.`);
        }
        const [insert] = await tx.query(
          `INSERT INTO bsc_scan_reconciliation_previews
           (status,scanner_reason_code,previous_block,previous_block_hash,candidate_resume_block,candidate_resume_hash,
            observed_finalized_block,rpc_endpoints_count,total_events,canonical_events,re_included_events,
            orphaned_events,unverifiable_events,compensation_required_events,summary_json,created_by,
            created_at_ms,expires_at_ms)
           VALUES('previewed',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [state.manual_review_code || "unspecified", previousBlock === null ? null : previousBlock.toString(),
            state.last_scanned_block_hash || null, candidate.blockNumber.toString(), candidate.blockHash,
            consensus.number.toString(), consensus.rpcUrls.length,
            summary.total_events, summary.canonical_events, summary.re_included_events, summary.orphaned_events,
            summary.unverifiable_events, summary.compensation_required_events, JSON.stringify({ ...summary, reason }),
            adminUsername, String(now), String(now + RECONCILIATION_PREVIEW_TTL_MS)],
        );
        previewId = String(insert.insertId);
        for (const item of items) {
          const [itemInsert] = await tx.query(
            `INSERT INTO bsc_scan_reconciliation_items
             (preview_id,source_table,source_id,tx_hash,log_index,batch_id,amount,amount_raw,old_block,old_block_hash,
              observed_block,observed_block_hash,observed_timestamp_ms,observed_log_index,classification,financial_impact,
              resolution_status,details_json,created_at_ms)
             VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'pending',?,?)`,
            [previewId, item.sourceTable, item.sourceId, item.txHash, item.logIndex, item.batchId,
              item.amount, item.amountRaw, item.oldBlock, item.oldBlockHash, item.observedBlock,
              item.observedBlockHash, item.observedTimestampMs, item.observedLogIndex, item.classification, item.financialImpact,
              JSON.stringify({ reason: item.reason, ...item.details }), String(now)],
          );
          item.itemId = String(itemInsert.insertId);
        }
        await tx.commit();
      } catch (error) {
        await tx.rollback().catch((rollbackError) => console.error("BSC reconciliation preview rollback failed:", rollbackError.message));
        throw error;
      } finally {
        connection.release();
      }
      return {
        preview_id: previewId,
        expires_at_ms: now + RECONCILIATION_PREVIEW_TTL_MS,
        candidate_resume_block: candidate.blockNumber.toString(),
        candidate_resume_hash: candidate.blockHash,
        observed_finalized_block: consensus.number.toString(),
        rpc_endpoints_count: consensus.rpcUrls.length,
        ...summary,
        can_commit: canCommitReconciliation(items),
        requires_compensation_review: summary.compensation_required_events > 0,
        items: items.map((item) => ({
          item_id: item.itemId || null,
          source_table: item.sourceTable,
          source_id: item.sourceId,
          tx_hash: item.txHash,
          log_index: item.logIndex,
          batch_id: item.batchId,
          amount: item.amount,
          old_block: item.oldBlock,
          classification: item.classification,
          financial_impact: Boolean(item.financialImpact),
          observed_block: item.observedBlock,
          observed_log_index: item.observedLogIndex,
          reason: item.reason,
        })),
      };
    }
  } finally {
    await releaseLock();
  }
}

async function resolveIncomingScannerCompensation(db, options = {}) {
  const previewId = String(options.previewId ?? "").trim();
  const itemId = String(options.itemId ?? "").trim();
  const compensationReference = String(options.compensationReference || "").trim();
  const reason = String(options.reason || "").trim();
  const adminUsername = String(options.adminUsername || "configured_admin").trim();
  if (!/^\d{1,20}$/.test(previewId) || !/^\d{1,20}$/.test(itemId)) throw new TypeError("Valid preview_id and item_id are required");
  if (!/^[A-Za-z0-9_-]{6,64}$/.test(compensationReference)) throw new TypeError("A valid compensation_reference is required");
  if (reason.length < 5 || reason.length > 1000) throw new RangeError("A compensation reason of 5 to 1000 characters is required");

  const releaseLock = await acquireScannerLock(db);
  if (!releaseLock) {
    const error = new Error("The BSC incoming scanner is currently processing a block range");
    error.code = "ONEX_BSC_SCANNER_BUSY";
    throw error;
  }
  try {
    const activityRows = await db.queryAsync(
      "SELECT reference,sender,receiver,type,amount FROM activities WHERE reference=? LIMIT 1",
      [compensationReference],
    );
    if (!activityRows.length) throw new Error("The compensation reference does not exist in the financial activity ledger");
    const connection = await getConnection(db);
    const tx = connection.promise();
    try {
      await tx.beginTransaction();
      const [previewRows] = await tx.query(
        "SELECT * FROM bsc_scan_reconciliation_previews WHERE id=? AND status='previewed' AND expires_at_ms>? LIMIT 1 FOR UPDATE",
        [previewId, String(Date.now())],
      );
      if (!previewRows.length) throw new Error("The reconciliation preview is missing, expired or no longer active");
      const [itemRows] = await tx.query(
        `SELECT * FROM bsc_scan_reconciliation_items
         WHERE id=? AND preview_id=? LIMIT 1 FOR UPDATE`, [itemId, previewId],
      );
      if (!itemRows.length || itemRows[0].classification !== "orphaned" || Number(itemRows[0].financial_impact) !== 1) {
        throw new Error("Only an orphaned event with financial impact can receive a compensation attestation");
      }
      const reconciliationItem = itemRows[0];
      if (reconciliationItem.resolution_status === "compensated") {
        if (String(reconciliationItem.compensation_reference || "") === compensationReference) {
          await tx.commit();
          return { recorded: true, already_recorded: true, preview_id: previewId, item_id: itemId, compensation_reference: compensationReference };
        }
        throw new Error("This event already has a different recorded compensation reference");
      }
      const usedRows = await tx.query(
        `SELECT source_table,source_id FROM bsc_scan_reconciliation_items
         WHERE compensation_reference=? LIMIT 1 FOR UPDATE`,
        [compensationReference],
      );
      if (usedRows[0].some((row) => row.source_table !== reconciliationItem.source_table ||
          String(row.source_id) !== String(reconciliationItem.source_id))) {
        throw new Error("This compensation reference is already attached to a different incoming event");
      }
      const now = String(Date.now());
      await tx.query(
        `UPDATE bsc_scan_reconciliation_items
         SET resolution_status='compensated',compensation_reference=?,resolution_reason=?,resolved_by=?,resolved_at_ms=?
         WHERE id=? AND preview_id=? AND resolution_status='pending'`,
        [compensationReference, reason, adminUsername, now, itemId, previewId],
      );
      await tx.query(
        `INSERT INTO bsc_scan_admin_events
         (admin_username,action,previous_block,previous_block_hash,resume_after_block,resume_block_hash,
          observed_finalized_block,reason,created_at_ms)
         VALUES(?,'record_compensation',?,?,?,?,?,?,?)`,
        [adminUsername, previewRows[0].previous_block, previewRows[0].previous_block_hash,
          previewRows[0].candidate_resume_block, previewRows[0].candidate_resume_hash,
          previewRows[0].observed_finalized_block, `${reason}; activity_reference=${compensationReference}; item=${itemId}`, now],
      );
      await tx.commit();
      return { recorded: true, preview_id: previewId, item_id: itemId, compensation_reference: compensationReference };
    } catch (error) {
      await tx.rollback().catch((rollbackError) => console.error("BSC compensation attestation rollback failed:", rollbackError.message));
      throw error;
    } finally {
      connection.release();
    }
  } finally {
    await releaseLock();
  }
}

async function commitIncomingScannerReconciliation(db, options = {}) {
  const previewId = String(options.previewId ?? "").trim();
  const reason = String(options.reason || "").trim();
  const adminUsername = String(options.adminUsername || "configured_admin").trim();
  if (!/^\d{1,20}$/.test(previewId)) throw new TypeError("A valid preview_id is required");
  if (reason.length < 5 || reason.length > 1000) throw new RangeError("A commit reason of 5 to 1000 characters is required");

  const releaseLock = await acquireScannerLock(db);
  if (!releaseLock) {
    const error = new Error("The BSC incoming scanner is currently processing a block range");
    error.code = "ONEX_BSC_SCANNER_BUSY";
    throw error;
  }
  try {
    const consensus = await getIndependentRpcConsensus();
    const previewItemSnapshots = await db.queryAsync(
      "SELECT * FROM bsc_scan_reconciliation_items WHERE preview_id=? ORDER BY id",
      [previewId],
    );
    for (const item of previewItemSnapshots) {
      const table = item.source_table === "users_usdt_transfer_events"
        ? "users_usdt_transfer_events"
        : item.source_table === "bsc_unknown_incoming_transfers"
          ? "bsc_unknown_incoming_transfers" : null;
      if (!table) throw new Error(`Unsupported reconciliation source table ${item.source_table}`);
      const sourceRows = await db.queryAsync(`SELECT * FROM ${table} WHERE id=? LIMIT 1`, [item.source_id]);
      if (!sourceRows.length) throw new Error(`Reconciliation source event ${item.id} disappeared; create a new preview`);
      const current = await inspectStoredTransferEvent(sourceRows[0], consensus.rpcUrls, consensus.number);
      if (current.classification !== item.classification ||
          String(current.observedBlock || "") !== String(item.observed_block || "") ||
          String(current.observedBlockHash || "").toLowerCase() !== String(item.observed_block_hash || "").toLowerCase() ||
          String(current.observedLogIndex || "") !== String(item.observed_log_index || "")) {
        throw new Error(`The canonical status of event ${item.tx_hash} changed after preview. Create a new reconciliation preview.`);
      }
    }
    const connection = await getConnection(db);
    const tx = connection.promise();
    try {
      await tx.beginTransaction();
      const [previewRows] = await tx.query(
        "SELECT * FROM bsc_scan_reconciliation_previews WHERE id=? AND status='previewed' AND expires_at_ms>? LIMIT 1 FOR UPDATE",
        [previewId, String(Date.now())],
      );
      if (!previewRows.length) throw new Error("The reconciliation preview is missing, expired or no longer active");
      const preview = previewRows[0];
      if (BigInt(preview.observed_finalized_block) > consensus.number) {
        throw new Error("The finalized chain height has moved behind the preview. Create a new preview after both RPC endpoints catch up.");
      }
      const ancestorHash = await getCanonicalBlockHashConsensus(consensus.rpcUrls, BigInt(preview.candidate_resume_block));
      if (ancestorHash !== String(preview.candidate_resume_hash).toLowerCase()) {
        throw new Error("The preview checkpoint is no longer canonical. Create a new reconciliation preview.");
      }
      const [stateRows] = await tx.query(
        "SELECT * FROM bsc_incoming_scan_state WHERE singleton_id=1 LIMIT 1 FOR UPDATE",
      );
      if (!stateRows.length || stateRows[0].health_status !== "manual_review") {
        throw new Error("The scanner is no longer in manual_review; refresh its status before committing");
      }
      if (Number(stateRows[0].chain_id) !== 56 ||
          String(stateRows[0].token_contract).toLowerCase() !== paymentConfig.tokenAddressLower ||
          String(stateRows[0].treasury_address).toLowerCase() !== paymentConfig.treasuryAddressLower) {
        throw new Error("Scanner identity changed after preview. Restore the persisted Chain ID, token contract and treasury address, then create a new preview.");
      }
      const currentCursorIsUnset = stateRows[0].last_scanned_block == null;
      const previewCursorIsUnset = preview.previous_block == null;
      const cursorMatches = currentCursorIsUnset === previewCursorIsUnset &&
        (previewCursorIsUnset || String(stateRows[0].last_scanned_block) === String(preview.previous_block)) &&
        String(stateRows[0].last_scanned_block_hash || "").toLowerCase() === String(preview.previous_block_hash || "").toLowerCase();
      if (!cursorMatches) {
        throw new Error("The scanner cursor changed after this preview was created. Generate a new preview.");
      }
      const [itemRows] = await tx.query(
        "SELECT * FROM bsc_scan_reconciliation_items WHERE preview_id=? ORDER BY id FOR UPDATE", [previewId],
      );
      if (!canCommitReconciliation(itemRows)) {
        throw new Error("Commit blocked: at least one event is unverifiable or an orphaned financial event still requires a recorded compensating ledger operation.");
      }

      const orphanedByBatch = new Map();
      for (const item of itemRows) {
        if (item.classification === "orphaned" && item.source_table === "users_usdt_transfer_events" && Number(item.financial_impact) === 0) {
          const key = String(item.batch_id || "none");
          if (!orphanedByBatch.has(key)) orphanedByBatch.set(key, []);
          orphanedByBatch.get(key).push(item);
        }
      }
      for (const [batchKey, batchItems] of orphanedByBatch.entries()) {
        if (batchKey === "none") {
          await tx.query(
            `UPDATE users_usdt_transfer_events SET status='orphaned',reason_codes=? WHERE id IN (${batchItems.map(() => "?").join(",")})`,
            [JSON.stringify(["bsc_reorg_orphaned_uncredited"]), ...batchItems.map((item) => item.source_id)],
          );
          continue;
        }
        const [batchRows] = await tx.query(
          "SELECT * FROM users_usdt_deposit_batches WHERE id=? LIMIT 1 FOR UPDATE", [batchKey],
        );
        if (!batchRows.length) throw new Error(`Deposit batch ${batchKey} is missing; manual ledger review is required`);
        const batch = batchRows[0];
        const [refundRows] = await tx.query(
          `SELECT * FROM users_usdt_refunds WHERE batch_id=? ORDER BY id ASC FOR UPDATE`, [batchKey],
        );
        const unsafeRefunds = refundRows.filter((refund) =>
          !["queued", "failed", "cancelled_reorg"].includes(String(refund.status)));
        if (unsafeRefunds.length > 0 ||
            new BigNumber(batch.credited_amount || "0").isGreaterThan(0) ||
            new BigNumber(batch.refunded_amount || "0").isGreaterThan(0)) {
          throw new Error(`Deposit batch ${batchKey} acquired a financial effect or has a potentially broadcast refund. Compensation and payout reconciliation are required before commit.`);
        }
        const cancellationTime = String(Date.now());
        for (const refund of refundRows) {
          if (refund.status === "queued") {
            const [cancelResult] = await tx.query(
              `UPDATE users_usdt_refunds
               SET status='cancelled_reorg',last_error=?,updated_at_ms=?
               WHERE id=? AND status='queued'`,
              ["Cancelled because the source BSC incoming transfer was orphaned during canonical-chain reconciliation.",
                cancellationTime, refund.id],
            );
            if (Number(cancelResult.affectedRows || 0) !== 1) {
              throw new Error(`Queued refund ${refund.id} changed during reconciliation; retry with a fresh preview.`);
            }
            if (refund.user_request_id != null) {
              const [requestRows] = await tx.query(
                "SELECT id,status FROM user_usdt_refund_requests WHERE id=? LIMIT 1 FOR UPDATE",
                [refund.user_request_id],
              );
              if (requestRows.length && ["approved_queued", "signed"].includes(String(requestRows[0].status))) {
                const oldStatus = String(requestRows[0].status);
                await tx.query(
                  `UPDATE user_usdt_refund_requests
                   SET status='failed',last_error=?,updated_at_ms=?,failed_at_ms=?,resolved_at_ms=?
                   WHERE id=?`,
                  ["Refund cancelled because its source BSC incoming transfer was orphaned during chain reconciliation.",
                    cancellationTime, cancellationTime, cancellationTime, refund.user_request_id],
                );
                await tx.query(
                  `INSERT IGNORE INTO user_usdt_refund_request_events
                   (request_id,refund_id,event_key,event_type,actor_type,actor_username,old_status,new_status,reason,
                    gross_amount,fee_amount,net_amount,created_at_ms)
                   VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
                  [refund.user_request_id, refund.id, `refund:${refund.id}:cancelled_reorg`, "cancelled_reorg",
                    "admin", adminUsername, oldStatus, "failed",
                    "Source BSC transfer was orphaned; unsigned refund safely cancelled.",
                    String(refund.gross_amount || refund.amount || "0"), String(refund.fee_amount || "0"),
                    String(refund.amount || "0"), cancellationTime],
                );
              }
            }
            await tx.query(
              "UPDATE admin_payment_resolutions SET action='refund_cancelled_reorg',reason=? WHERE refund_id=? AND action IN ('refund_queued','unknown_refund_queued')",
              ["Unsigned refund cancelled because its source incoming transfer was orphaned.", refund.id],
            );
          }
        }
        const amountToRemove = batchItems.reduce((sum, item) => sum.plus(item.amount), new BigNumber(0));
        const rawToRemove = batchItems.reduce((sum, item) => sum + BigInt(item.amount_raw), 0n);
        const totalBefore = new BigNumber(batch.total_amount || "0");
        const remainingBefore = new BigNumber(batch.remaining_amount || "0");
        const rawBefore = BigInt(batch.total_amount_raw || "0");
        if (amountToRemove.gt(totalBefore) || amountToRemove.gt(remainingBefore) || rawToRemove > rawBefore ||
            Number(batch.transfer_count || 0) < batchItems.length) {
          throw new Error(`Deposit batch ${batchKey} cannot be safely reduced by the orphaned event amounts`);
        }
        const totalAfter = totalBefore.minus(amountToRemove);
        const remainingAfter = remainingBefore.minus(amountToRemove);
        const rawAfter = rawBefore - rawToRemove;
        const now = Date.now();
        let nextStatus = String(batch.status);
        if (totalAfter.isZero()) nextStatus = "orphaned";
        else if (totalAfter.lt("20") && ["collecting", "batched", "ready", "pending_credit"].includes(nextStatus)) nextStatus = "pending_minimum";
        else if (["collecting", "batched"].includes(nextStatus) && Number(batch.expires_at_ms) <= now) nextStatus = "ready";
        let existingReasons = [];
        try { existingReasons = JSON.parse(batch.reason_codes || "[]"); } catch {}
        if (!Array.isArray(existingReasons)) existingReasons = [];
        const reasons = [...new Set(existingReasons.filter((value) => value !== "minimum_not_reached"))];
        if (nextStatus === "orphaned") reasons.push("bsc_reorg_orphaned_uncredited");
        await tx.query(
          `UPDATE users_usdt_deposit_batches
           SET total_amount=?,total_amount_raw=?,remaining_amount=?,reserved_refund_amount='0',
               transfer_count=?,status=?,minimum_met_at_ms=?,reason_codes=?,next_attempt_at_ms=?,updated_at_ms=?
           WHERE id=?`,
          [totalAfter.toFixed(18), rawAfter.toString(), remainingAfter.toFixed(18),
            Number(batch.transfer_count) - batchItems.length, nextStatus,
            totalAfter.gte("20") ? (batch.minimum_met_at_ms || String(now)) : null,
            reasons.length ? JSON.stringify(reasons) : null,
            nextStatus === "ready" ? String(now) : null, String(now), batchKey],
        );
        await tx.query(
          `UPDATE users_usdt_transfer_events SET status='orphaned',reason_codes=? WHERE id IN (${batchItems.map(() => "?").join(",")})`,
          [JSON.stringify(["bsc_reorg_orphaned_uncredited"]), ...batchItems.map((item) => item.source_id)],
        );
      }

      for (const item of itemRows) {
        if (item.source_table === "users_usdt_transfer_events") {
          if (item.classification === "canonical" || item.classification === "re_included") {
            const nextLogIndex = item.observed_log_index == null ? Number(item.log_index) : Number(item.observed_log_index);
            const nextIdentity = createBscEventIdentity(item.tx_hash, nextLogIndex, item.observed_block_hash);
            await tx.query(
              `UPDATE users_usdt_transfer_events
               SET block_number=?,block_hash=?,block_timestamp_ms=?,log_index=?,event_identity=? WHERE id=?`,
              [item.observed_block, item.observed_block_hash, item.observed_timestamp_ms,
                nextLogIndex, nextIdentity, item.source_id],
            );
            if (item.classification === "re_included") {
              await tx.query(
                `UPDATE bsc_unknown_incoming_transfers
                 SET block_number=?,block_hash=?,block_timestamp_ms=?,log_index=?,event_identity=?
                 WHERE event_identity=? AND status='assigned_to_account'`,
                [item.observed_block, item.observed_block_hash, item.observed_timestamp_ms,
                  nextLogIndex, nextIdentity, createBscEventIdentity(item.tx_hash, item.log_index, item.old_block_hash)],
              );
            }
          } else if (item.classification === "orphaned" && Number(item.financial_impact) === 0) {
            await tx.query(
              `UPDATE bsc_unknown_incoming_transfers
               SET status='orphaned',decision_action='orphaned',decision_reason='Incoming transfer removed by canonical BSC reorganization',
                   decided_by=?,decided_at_ms=?,updated_at_ms=?
               WHERE event_identity=? AND status='assigned_to_account'`,
              [adminUsername, String(Date.now()), String(Date.now()),
                createBscEventIdentity(item.tx_hash, item.log_index, item.old_block_hash)],
            );
            await tx.query(
              `UPDATE users_usdt_transfer_events SET status='orphaned',reason_codes=? WHERE id=?`,
              [JSON.stringify(["bsc_reorg_orphaned_uncredited"]), item.source_id],
            );
          } else if (item.classification === "orphaned" && Number(item.financial_impact) === 1) {
            await tx.query(
              `UPDATE users_usdt_transfer_events SET status='reorg_compensated',reason_codes=? WHERE id=?`,
              [JSON.stringify(["bsc_reorg_compensated", item.compensation_reference]), item.source_id],
            );
            await tx.query(
              `UPDATE bsc_unknown_incoming_transfers
               SET status='reorg_compensated',decision_action='reorg_compensated',decision_reason=?,
                   decided_by=?,decided_at_ms=?,updated_at_ms=?
               WHERE event_identity=? AND status='assigned_to_account'`,
              [item.resolution_reason || item.compensation_reference, adminUsername,
                String(Date.now()), String(Date.now()),
                createBscEventIdentity(item.tx_hash, item.log_index, item.old_block_hash)],
            );
            if (item.batch_id != null) {
              const [batchRows] = await tx.query(
                "SELECT reason_codes FROM users_usdt_deposit_batches WHERE id=? LIMIT 1 FOR UPDATE", [item.batch_id],
              );
              let reasons = [];
              try { reasons = JSON.parse(batchRows[0]?.reason_codes || "[]"); } catch {}
              if (!Array.isArray(reasons)) reasons = [];
              reasons.push("bsc_reorg_compensation_review");
              await tx.query(
                "UPDATE users_usdt_deposit_batches SET status='manual_review',reason_codes=?,updated_at_ms=? WHERE id=?",
                [JSON.stringify([...new Set(reasons)]), String(Date.now()), item.batch_id],
              );
            }
          }
        } else if (item.source_table === "bsc_unknown_incoming_transfers") {
          if (item.classification === "canonical" || item.classification === "re_included") {
            const nextLogIndex = item.observed_log_index == null ? Number(item.log_index) : Number(item.observed_log_index);
            const nextIdentity = createBscEventIdentity(item.tx_hash, nextLogIndex, item.observed_block_hash);
            await tx.query(
              `UPDATE bsc_unknown_incoming_transfers
               SET block_number=?,block_hash=?,block_timestamp_ms=?,log_index=?,event_identity=? WHERE id=?`,
              [item.observed_block, item.observed_block_hash, item.observed_timestamp_ms,
                nextLogIndex, nextIdentity, item.source_id],
            );
          } else if (item.classification === "orphaned") {
            const [unknownRows] = await tx.query(
              `SELECT u.status,u.refund_id,r.status AS refund_status
               FROM bsc_unknown_incoming_transfers u
               LEFT JOIN users_usdt_refunds r ON r.id=u.refund_id
               WHERE u.id=? LIMIT 1 FOR UPDATE`,
              [item.source_id],
            );
            if (!unknownRows.length) throw new Error(`Unknown transfer ${item.source_id} disappeared during commit`);
            const unknown = unknownRows[0];
            if (Number(item.financial_impact) === 0 &&
                !["pending_admin", "resolved_uncredited", "refund_queued", "assigned_to_account"].includes(String(unknown.status))) {
              throw new Error(`Unknown transfer ${item.source_id} changed status after preview; create a new preview`);
            }
            if (Number(item.financial_impact) === 0 && unknown.refund_id != null) {
              if (!unknown.refund_status) {
                throw new Error(`Unknown-transfer refund ${unknown.refund_id} is missing from the refund ledger.`);
              }
              if (unknown.refund_status === "queued") {
                const [cancelResult] = await tx.query(
                  `UPDATE users_usdt_refunds SET status='cancelled_reorg',last_error=?,updated_at_ms=?
                   WHERE id=? AND status='queued'`,
                  ["Cancelled because the source BSC incoming transfer was orphaned during canonical-chain reconciliation.",
                    String(Date.now()), unknown.refund_id],
                );
                if (Number(cancelResult.affectedRows || 0) !== 1) {
                  throw new Error(`Unknown-transfer refund ${unknown.refund_id} changed during reconciliation; retry with a fresh preview.`);
                }
                await tx.query(
                  "UPDATE admin_payment_resolutions SET action='refund_cancelled_reorg',reason=? WHERE refund_id=? AND action='unknown_refund_queued'",
                  ["Unsigned refund cancelled because its source incoming transfer was orphaned.", unknown.refund_id],
                );
              } else if (unknown.refund_status && !["failed", "cancelled_reorg"].includes(String(unknown.refund_status))) {
                throw new Error(`Unknown-transfer refund ${unknown.refund_id} may have been broadcast; compensation is required.`);
              }
            }
            const status = Number(item.financial_impact) === 1 ? "reorg_compensated" : "orphaned";
            await tx.query(
              `UPDATE bsc_unknown_incoming_transfers
               SET status=?,decision_action=?,decision_reason=?,decided_by=?,decided_at_ms=?,updated_at_ms=?
               WHERE id=?`,
              [status, status, item.resolution_reason || item.compensation_reference || "Incoming transfer removed by canonical BSC reorganization",
                adminUsername, String(Date.now()), String(Date.now()), item.source_id],
            );
          }
        }
      }

      const ancestorBlock = String(preview.candidate_resume_block);
      await tx.query(
        `UPDATE bsc_scan_checkpoints SET checkpoint_status='orphaned'
         WHERE block_number>? AND checkpoint_status='canonical'`, [ancestorBlock],
      );
      await tx.query(
        `INSERT IGNORE INTO bsc_scan_checkpoints
         (block_number,block_hash,finality_method,checkpoint_status,created_at_ms)
         VALUES(?,?,?,'canonical',?)`,
        [ancestorBlock, ancestorHash, consensus.method, String(Date.now())],
      );
      await tx.query(
        `UPDATE bsc_incoming_scan_state
         SET last_scanned_block=?,last_scanned_block_hash=?,last_finalized_block=?,finality_method=?,
             health_status='healthy',manual_review_code=NULL,manual_review_at_ms=NULL,last_error=NULL,updated_at_ms=?
         WHERE singleton_id=1 AND health_status='manual_review'`,
        [preview.previous_block == null ? null : ancestorBlock,
          preview.previous_block == null ? null : ancestorHash,
          consensus.number.toString(), consensus.method, String(Date.now())],
      );
      await tx.query(
        `UPDATE bsc_scan_reconciliation_previews SET status='committed',committed_at_ms=?,last_error=NULL WHERE id=?`,
        [String(Date.now()), previewId],
      );
      await tx.query(
        `INSERT INTO bsc_scan_admin_events
         (admin_username,action,previous_block,previous_block_hash,resume_after_block,resume_block_hash,
          observed_finalized_block,reason,created_at_ms)
         VALUES(?,'reconcile_commit',?,?,?,?,?,?,?)`,
        [adminUsername, preview.previous_block, preview.previous_block_hash, ancestorBlock, ancestorHash,
          consensus.number.toString(), reason, String(Date.now())],
      );
      await tx.commit();
      cursorHashValidation = null;
      return {
        resumed: true,
        preview_id: previewId,
        resume_after_block: ancestorBlock,
        resume_block_hash: ancestorHash,
        observed_finalized_block: consensus.number.toString(),
        finality_method: consensus.method,
        ...summarizeReconciliationItems(itemRows),
      };
    } catch (error) {
      await tx.rollback().catch((rollbackError) => console.error("BSC reconciliation commit rollback failed:", rollbackError.message));
      throw error;
    } finally {
      connection.release();
    }
  } finally {
    await releaseLock();
  }
}

function getPaymentPublicConfig() {
  if (!paymentConfig || !paymentConfig.enabled) return { enabled: false };
  return {
    enabled: true,
    network: "BNB Smart Chain (BEP-20)",
    chainId: 56,
    tokenName: "Binance-Peg BSC-USD",
    tokenContract: paymentConfig.tokenAddress,
    treasuryAddress: paymentConfig.treasuryAddress,
    decimals: TOKEN_DECIMALS,
  };
}

module.exports = {
  initializePaymentProvider,
  startPaymentWatcher,
  getPaymentPublicConfig,
  getIncomingScannerStatus,
  previewIncomingScannerReconciliation,
  resolveIncomingScannerCompensation,
  commitIncomingScannerReconciliation,
  isAddress,
  checksumAddress,
  getRpcMetricsSnapshot,
};
