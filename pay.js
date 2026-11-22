"use strict";

const https = require("https");
const { getAddress, WebSocketProvider } = require("ethers");
const BigNumber = require("bignumber.js");

const TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const CHAIN_ID = 56n;
const CANONICAL_BSC_USD_CONTRACT =
  "0x55d398326f99059fF775485246999027B3197955";
const TOKEN_DECIMALS = 18;
const RPC_TIMEOUT_MS = 12000;
const RPC_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const TREASURY_SCAN_LOCK = "onex_bsc_treasury_incoming_scanner";

let paymentConfig = null;
let rpcCounter = 0;
let watcherTimer = null;
let watcherRunning = false;
let watcherWakeRequested = false;
let watcherDatabase = null;
let transferHandler = null;
let maintenanceHandler = null;
let watcherWsProvider = null;
let validatedRpcUrls = new Set();

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

function minBigInt(left, right) {
  return left < right ? left : right;
}

function getPaymentConfigFromEnvironment() {
  const enabled = String(process.env.USDT_PAYMENTS_ENABLED || "false").toLowerCase() === "true";
  if (!enabled) return { enabled: false };

  const rpcUrls = [process.env.BSC_RPC_URL, process.env.BSC_RPC_FALLBACK_URL]
    .map((value) => String(value || "").trim())
    .filter(Boolean);
  const websocketRpcUrl = String(process.env.BSC_WS_RPC_URL || "").trim();
  const tokenAddress = String(
    process.env.USDT_BEP20_CONTRACT || CANONICAL_BSC_USD_CONTRACT,
  ).trim();
  const treasuryAddress = String(
    process.env.USDT_BEP20_TREASURY_ADDRESS || process.env.USDT_BEP20_RECEIVER_ADDRESS || "",
  ).trim();
  const minConfirmations = Number(process.env.USDT_MIN_CONFIRMATIONS || 15);
  const pollIntervalMs = Number(process.env.USDT_PAYMENT_POLL_MS || 5000);
  const maxLogBlockRange = Number(process.env.USDT_MAX_LOG_BLOCK_RANGE || 250);
  const configuredStartBlock = String(process.env.USDT_INCOMING_START_BLOCK || "").trim();
  const startBlock = configuredStartBlock === "" ? null : BigInt(configuredStartBlock);

  if (!rpcUrls.length || !treasuryAddress) {
    throw new Error("USDT payments require BSC_RPC_URL and USDT_BEP20_TREASURY_ADDRESS.");
  }
  for (const [index, value] of rpcUrls.entries()) {
    let parsed;
    try {
      parsed = new URL(value);
    } catch {
      throw new Error(`BSC RPC endpoint ${index + 1} is not a valid URL.`);
    }
    if (parsed.protocol !== "https:") {
      throw new Error(`BSC RPC endpoint ${index + 1} must use HTTPS.`);
    }
  }
  if (websocketRpcUrl) {
    let parsed;
    try {
      parsed = new URL(websocketRpcUrl);
    } catch {
      throw new Error("BSC_WS_RPC_URL is not a valid URL.");
    }
    if (parsed.protocol !== "wss:") {
      throw new Error("BSC_WS_RPC_URL must use secure WebSocket (wss).");
    }
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
  if (startBlock !== null && (startBlock < 0n || startBlock > 0xffffffffffffffffn)) {
    throw new Error("USDT_INCOMING_START_BLOCK must be a valid non-negative block number.");
  }

  return {
    enabled: true,
    rpcUrls,
    websocketRpcUrl: websocketRpcUrl || null,
    currentRpcIndex: 0,
    tokenAddress: checksumAddress(tokenAddress),
    tokenAddressLower: tokenAddress.toLowerCase(),
    treasuryAddress: checksumAddress(treasuryAddress),
    treasuryAddressLower: treasuryAddress.toLowerCase(),
    minConfirmations: BigInt(minConfirmations),
    minConfirmationsNumber: minConfirmations,
    pollIntervalMs,
    maxLogBlockRange: BigInt(maxLogBlockRange),
    configuredStartBlock: startBlock,
    decimals: TOKEN_DECIMALS,
    decimalFactor: new BigNumber(10).pow(TOKEN_DECIMALS),
  };
}

function rpcCallAt(rpcUrl, method, params = []) {
  const requestBody = JSON.stringify({ jsonrpc: "2.0", id: ++rpcCounter, method, params });
  return new Promise((resolve, reject) => {
    const request = https.request(rpcUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "Content-Length": Buffer.byteLength(requestBody),
      },
    }, (response) => {
      let responseSize = 0;
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
        if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error(`BSC RPC returned HTTP ${response.statusCode}.`));
          return;
        }
        let payload;
        try {
          payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch {
          reject(new Error("BSC RPC returned invalid JSON."));
          return;
        }
        if (payload.error) {
          reject(new Error(`BSC RPC ${method} failed: ${String(payload.error.message || "unknown error")}`));
          return;
        }
        if (!Object.prototype.hasOwnProperty.call(payload, "result")) {
          reject(new Error(`BSC RPC ${method} returned no result.`));
          return;
        }
        resolve(payload.result);
      });
    });
    request.setTimeout(RPC_TIMEOUT_MS, () => request.destroy(new Error(`BSC RPC ${method} timed out.`)));
    request.on("error", reject);
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
  let lastError = null;
  const count = paymentConfig.rpcUrls.length;
  const start = paymentConfig.currentRpcIndex || 0;
  for (let offset = 0; offset < count; offset += 1) {
    const index = (start + offset) % count;
    const rpcUrl = paymentConfig.rpcUrls[index];
    try {
      if (!validatedRpcUrls.has(rpcUrl)) await validateRpcEndpoint(rpcUrl);
      const result = await rpcCallAt(rpcUrl, method, params);
      paymentConfig.currentRpcIndex = index;
      return result;
    } catch (error) {
      lastError = error;
      console.error(`BSC RPC endpoint ${index + 1} failed for ${method}:`, error.message);
    }
  }
  throw new Error(`All configured BSC RPC endpoints failed for ${method}: ${lastError?.message || "unknown error"}`);
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
    console.warn("BSC RPC does not provide the finalized block tag; using the confirmation fallback:", error.message);
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
        `UPDATE bsc_incoming_scan_state SET health_status='manual_review',last_error=?,updated_at_ms=? WHERE singleton_id=1`,
        [message, String(Date.now())],
      );
      throw new Error(message);
    }
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
  const initialCursorHash = initialCursor === null
    ? null
    : String((await rpcCall("eth_getBlockByNumber", [toQuantity(initialCursor), false]))?.hash || "").toLowerCase();
  if (initialCursor !== null && !/^0x[0-9a-f]{64}$/i.test(initialCursorHash)) {
    throw new Error("Unable to obtain the initial BSC scan cursor block hash.");
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
      initialCursorHash || null,
      safeBlock.number.toString(),
      safeBlock.method,
      String(Date.now()),
    ],
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

async function verifyFinalizedTransfer(log) {
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

  const receipt = await rpcCall("eth_getTransactionReceipt", [txHash]);
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

  const canonicalBlock = await rpcCall("eth_getBlockByNumber", [toQuantity(blockNumber), false]);
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
  await db.queryAsync(
    `INSERT IGNORE INTO bsc_unknown_incoming_transfers
     (token_contract,from_address,to_address,amount,amount_raw,tx_hash,log_index,block_number,block_hash,
      block_timestamp_ms,previous_username,status,decision_action,created_at_ms,updated_at_ms)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,'pending_admin',NULL,?,?)`,
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
      String(Date.now()),
      String(Date.now()),
    ],
  );
}

async function scanTreasury(db, safeBlock) {
  let state = await initializeScanState(db, safeBlock);
  if (state.health_status !== "healthy") {
    throw new Error(`BSC incoming scanner requires review: ${state.last_error || state.health_status}`);
  }

  if (state.last_scanned_block !== null && state.last_scanned_block_hash) {
    const cursorBlock = await rpcCall("eth_getBlockByNumber", [toQuantity(state.last_scanned_block), false]);
    if (!cursorBlock || String(cursorBlock.hash || "").toLowerCase() !== String(state.last_scanned_block_hash).toLowerCase()) {
      const message = "The stored BSC scan cursor no longer matches the canonical block. Automatic crediting has been halted for administrative reconciliation.";
      await db.queryAsync(
        `UPDATE bsc_incoming_scan_state SET health_status='manual_review',last_error=?,updated_at_ms=? WHERE singleton_id=1`,
        [message, String(Date.now())],
      );
      throw new Error(message);
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
  for (const log of logs) {
    const event = await verifyFinalizedTransfer(log);
    if (event?.pending) throw new Error("A BSC transfer receipt or canonical block is not yet consistent; the scan cursor was not advanced.");
    if (!event || event.ignored) continue;

    const accountRows = await db.queryAsync(
      `SELECT username FROM auths WHERE LOWER(wallet_address)=? LIMIT 1`,
      [event.fromAddress.toLowerCase()],
    );
    if (!accountRows.length) {
      await persistUnknownTransfer(db, event);
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
  await db.queryAsync(
    `UPDATE bsc_incoming_scan_state
     SET last_scanned_block=?,last_scanned_block_hash=?,last_finalized_block=?,finality_method=?,
         health_status='healthy',last_error=NULL,updated_at_ms=?
     WHERE singleton_id=1`,
    [
      toBlock.toString(),
      String(cursorBlock.hash).toLowerCase(),
      safeBlock.number.toString(),
      safeBlock.method,
      String(Date.now()),
    ],
  );
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
      const nextDelay = watcherWakeRequested ? 0 : (paymentConfig?.pollIntervalMs || 5000);
      watcherWakeRequested = false;
      scheduleScan(nextDelay);
    }
  };

  scheduleScan(0);
  if (paymentConfig.websocketRpcUrl) {
    try {
      const wsProvider = new WebSocketProvider(paymentConfig.websocketRpcUrl);
      void wsProvider.getNetwork().then((network) => {
        if (BigInt(network.chainId) !== CHAIN_ID) {
          throw new Error(`WebSocket RPC is on chain ${network.chainId}, not BNB Smart Chain mainnet 56.`);
        }
        watcherWsProvider = wsProvider;
        wsProvider.on("block", () => {
          if (watcherRunning) watcherWakeRequested = true;
          else scheduleScan(0);
        });
        wsProvider.on("error", (error) => {
          console.warn("BSC WebSocket hint failed; the durable HTTP scanner remains active:", error?.message || "unknown error");
        });
        console.log("BSC WebSocket new-block hint connected; the HTTP log scanner remains the recovery source of truth.");
      }).catch((error) => {
        console.warn("Unable to start optional BSC WebSocket hint; the durable HTTP scanner remains active:", error.message);
        wsProvider.destroy();
      });
    } catch (error) {
      console.warn("Unable to create optional BSC WebSocket hint; the durable HTTP scanner remains active:", error.message);
    }
  }
  return { enabled: true, treasuryAddress: paymentConfig.treasuryAddress, websocketHint: Boolean(paymentConfig.websocketRpcUrl) };
}


async function getIncomingScannerStatus(db) {
  const rows = await db.queryAsync(
    "SELECT * FROM bsc_incoming_scan_state WHERE singleton_id=1 LIMIT 1",
  );
  if (!rows.length) return { initialized: false };
  return { initialized: true, ...rows[0] };
}

async function reconcileIncomingScanner(db, options = {}) {
  const resumeAfterBlockValue = String(options.resumeAfterBlock ?? "").trim();
  const reason = String(options.reason || "").trim();
  const adminUsername = String(options.adminUsername || "configured_admin").trim();
  if (!/^\d{1,20}$/.test(resumeAfterBlockValue)) {
    throw new TypeError("resume_after_block must be a non-negative integer block number");
  }
  if (reason.length < 5 || reason.length > 1000) {
    throw new RangeError("A reconciliation reason of 5 to 1000 characters is required");
  }
  if (!adminUsername || adminUsername.length > 64) {
    throw new TypeError("Invalid administrator identifier");
  }

  const releaseLock = await acquireScannerLock(db);
  if (!releaseLock) {
    const error = new Error("The BSC incoming scanner is currently processing a block range");
    error.code = "ONEX_BSC_SCANNER_BUSY";
    throw error;
  }

  try {
    if (!paymentConfig || !paymentConfig.enabled) {
      throw new Error("BSC payment monitoring is not enabled");
    }
    const stateRows = await db.queryAsync(
      "SELECT * FROM bsc_incoming_scan_state WHERE singleton_id=1 LIMIT 1",
    );
    if (!stateRows.length) throw new Error("The BSC incoming scanner has not initialized its cursor yet");
    const state = stateRows[0];
    if (state.health_status !== "manual_review") {
      throw new Error("Scanner reconciliation is allowed only while health_status is manual_review");
    }

    const resumeAfterBlock = BigInt(resumeAfterBlockValue);
    const safeBlock = await getSafeBlock();
    if (resumeAfterBlock > safeBlock.number) {
      throw new RangeError("The resume cursor cannot be newer than the latest finalized block");
    }
    const block = await rpcCall("eth_getBlockByNumber", [toQuantity(resumeAfterBlock), false]);
    const canonicalHash = String(block?.hash || "").toLowerCase();
    if (
      !block || BigInt(block.number) !== resumeAfterBlock ||
      !/^0x[0-9a-f]{64}$/.test(canonicalHash)
    ) {
      throw new Error("The selected resume block is not available as a canonical BSC block");
    }

    const connection = await getConnection(db);
    const tx = connection.promise();
    try {
      await tx.beginTransaction();
      const [lockedRows] = await tx.query(
        "SELECT * FROM bsc_incoming_scan_state WHERE singleton_id=1 LIMIT 1 FOR UPDATE",
      );
      if (!lockedRows.length || lockedRows[0].health_status !== "manual_review") {
        throw new Error("The scanner state changed during administrative reconciliation");
      }
      const previousBlock = lockedRows[0].last_scanned_block == null
        ? null : String(lockedRows[0].last_scanned_block);
      const previousHash = lockedRows[0].last_scanned_block_hash || null;
      if (previousBlock === null || resumeAfterBlock >= BigInt(previousBlock)) {
        throw new RangeError("Reconciliation may only roll the cursor back to a block earlier than the stored cursor; it cannot skip incoming transfers.");
      }
      const now = String(Date.now());
      await tx.query(
        `UPDATE bsc_incoming_scan_state
         SET last_scanned_block=?,last_scanned_block_hash=?,last_finalized_block=?,finality_method=?,
             health_status='healthy',last_error=NULL,updated_at_ms=?
         WHERE singleton_id=1 AND health_status='manual_review'`,
        [resumeAfterBlock.toString(), canonicalHash, safeBlock.number.toString(), safeBlock.method, now],
      );
      await tx.query(
        `INSERT INTO bsc_scan_admin_events
         (admin_username,action,previous_block,previous_block_hash,resume_after_block,resume_block_hash,
          observed_finalized_block,reason,created_at_ms)
         VALUES(?,'resume_cursor',?,?,?,?,?,?,?)`,
        [adminUsername, previousBlock, previousHash, resumeAfterBlock.toString(), canonicalHash,
          safeBlock.number.toString(), reason, now],
      );
      await tx.commit();
      return {
        resumed: true,
        resume_after_block: resumeAfterBlock.toString(),
        resume_block_hash: canonicalHash,
        observed_finalized_block: safeBlock.number.toString(),
        finality_method: safeBlock.method,
      };
    } catch (error) {
      await tx.rollback().catch((rollbackError) => console.error("BSC scanner reconciliation rollback failed:", rollbackError.message));
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
  reconcileIncomingScanner,
  isAddress,
  checksumAddress,
};
