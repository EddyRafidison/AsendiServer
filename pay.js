"use strict";

const https = require("https");
const { URL } = require("url");
const BigNumber = require("bignumber.js");
const { HDNodeWallet, getAddress } = require("ethers");

const TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const CHAIN_ID = 56n;
const CANONICAL_BSC_USD_CONTRACT =
  "0x55d398326f99059fF775485246999027B3197955";
const TOKEN_DECIMALS = 18;
const RPC_TIMEOUT_MS = 12000;
const RPC_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

let paymentConfig = null;
let rpcCounter = 0;
let watcherTimer = null;
let watcherRunning = false;
let watcherDatabase = null;
let transferHandler = null;
let maintenanceHandler = null;
let lastWalletCursorId = 0;

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

function minBigInt(a, b) {
  return a < b ? a : b;
}

function getPaymentConfigFromEnvironment() {
  const enabled = String(process.env.USDT_PAYMENTS_ENABLED || "false").toLowerCase() === "true";
  if (!enabled) return { enabled: false };

  const rpcCandidates = [process.env.BSC_RPC_URL, process.env.BSC_RPC_FALLBACK_URL]
    .map((value) => String(value || "").trim())
    .filter(Boolean);
  const tokenAddress = String(
    process.env.USDT_BEP20_CONTRACT || CANONICAL_BSC_USD_CONTRACT,
  ).trim();
  const treasuryAddress = String(
    process.env.USDT_BEP20_TREASURY_ADDRESS || process.env.USDT_BEP20_RECEIVER_ADDRESS || "",
  ).trim();
  const depositXpub = String(process.env.BSC_DEPOSIT_XPUB || "").trim();
  const minConfirmations = Number(process.env.USDT_MIN_CONFIRMATIONS || 15);
  const pollIntervalMs = Number(process.env.USDT_PAYMENT_POLL_MS || 5000);
  const maxLogBlockRange = Number(process.env.USDT_MAX_LOG_BLOCK_RANGE || 250);
  const maxWalletsPerPoll = Number(process.env.USDT_MAX_WALLETS_PER_POLL || 25);

  if (!rpcCandidates.length || !treasuryAddress || !depositXpub) {
    throw new Error(
      "USDT payments require BSC_RPC_URL, USDT_BEP20_TREASURY_ADDRESS and BSC_DEPOSIT_XPUB.",
    );
  }

  const rpcUrls = rpcCandidates.map((value, index) => {
    let parsed;
    try {
      parsed = new URL(value);
    } catch {
      throw new Error(`BSC RPC endpoint ${index + 1} is not a valid URL.`);
    }
    if (parsed.protocol !== "https:") {
      throw new Error(`BSC RPC endpoint ${index + 1} must use HTTPS.`);
    }
    return parsed;
  });

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
  if (!Number.isInteger(maxWalletsPerPoll) || maxWalletsPerPoll < 1 || maxWalletsPerPoll > 500) {
    throw new Error("USDT_MAX_WALLETS_PER_POLL must be between 1 and 500.");
  }

  let publicRoot;
  try {
    publicRoot = HDNodeWallet.fromExtendedKey(depositXpub);
  } catch {
    throw new Error("BSC_DEPOSIT_XPUB is not a valid extended public key.");
  }
  if (publicRoot.privateKey) {
    throw new Error("BSC_DEPOSIT_XPUB must be an extended public key, not a private key.");
  }

  return {
    enabled: true,
    rpcUrls,
    currentRpcIndex: 0,
    tokenAddress: checksumAddress(tokenAddress),
    tokenAddressLower: tokenAddress.toLowerCase(),
    treasuryAddress: checksumAddress(treasuryAddress),
    treasuryAddressLower: treasuryAddress.toLowerCase(),
    publicRoot,
    minConfirmations: BigInt(minConfirmations),
    minConfirmationsNumber: minConfirmations,
    pollIntervalMs,
    maxLogBlockRange: BigInt(maxLogBlockRange),
    maxWalletsPerPoll,
    decimals: TOKEN_DECIMALS,
    decimalFactor: new BigNumber(10).pow(TOKEN_DECIMALS),
  };
}

function deriveDepositAddress(index) {
  if (!paymentConfig || !paymentConfig.enabled) {
    throw new Error("BEP-20 payment provider is not initialized.");
  }
  const childIndex = Number(index);
  if (!Number.isSafeInteger(childIndex) || childIndex < 0 || childIndex > 0x7fffffff) {
    throw new RangeError("Invalid BSC deposit derivation index.");
  }
  return paymentConfig.publicRoot.deriveChild(childIndex).address;
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

async function rpcCall(method, params = []) {
  if (!paymentConfig || !paymentConfig.enabled) {
    throw new Error("BEP-20 payment provider is not initialized.");
  }
  let lastError = null;
  const count = paymentConfig.rpcUrls.length;
  const start = paymentConfig.currentRpcIndex || 0;
  for (let offset = 0; offset < count; offset += 1) {
    const index = (start + offset) % count;
    try {
      const result = await rpcCallAt(paymentConfig.rpcUrls[index], method, params);
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
    console.log("BEP-20 payment monitoring is disabled.");
    return { enabled: false };
  }
  paymentConfig = config;
  try {
    for (let index = 0; index < config.rpcUrls.length; index += 1) {
      const rpcUrl = config.rpcUrls[index];
      const chainId = BigInt(await rpcCallAt(rpcUrl, "eth_chainId", []));
      if (chainId !== CHAIN_ID) {
        throw new Error(`RPC endpoint is on chain ${chainId}, not BNB Smart Chain mainnet 56.`);
      }
      const code = await rpcCallAt(rpcUrl, "eth_getCode", [config.tokenAddress, "latest"]);
      if (typeof code !== "string" || code === "0x" || code === "0x0") {
        throw new Error("The approved BSC-USD contract is not deployed on the RPC endpoint.");
      }
      const decimalsResult = await rpcCallAt(rpcUrl, "eth_call", [
        { to: config.tokenAddress, data: "0x313ce567" }, "latest",
      ]);
      if (Number(BigInt(decimalsResult)) !== TOKEN_DECIMALS) {
        throw new Error("The approved Binance-Peg BSC-USD token must use 18 decimals.");
      }
    }
    const blockNumber = BigInt(await rpcCall("eth_blockNumber", []));
    console.log(`BEP-20 payment provider ready. BSC block: ${blockNumber}`);
    return { enabled: true, chainId: 56, tokenAddress: config.tokenAddress };
  } catch (error) {
    paymentConfig = null;
    throw error;
  }
}

function getConnection(db) {
  return new Promise((resolve, reject) => {
    db.getConnection((error, connection) => error ? reject(error) : resolve(connection));
  });
}

async function runDbTransaction(db, work, maxAttempts = 3) {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const connection = await getConnection(db);
    const tx = connection.promise();
    let started = false;
    let retry = false;
    try {
      await tx.beginTransaction();
      started = true;
      const result = await work(tx);
      await tx.commit();
      started = false;
      return result;
    } catch (error) {
      if (started) await tx.rollback().catch((rollbackError) => console.error("Deposit wallet rollback failed:", rollbackError));
      const retryable = error && ["ER_LOCK_DEADLOCK", "ER_LOCK_WAIT_TIMEOUT"].includes(error.code);
      if (!retryable || attempt === maxAttempts) throw error;
      retry = true;
    } finally {
      connection.release();
    }
    if (retry) await new Promise((resolve) => setTimeout(resolve, attempt * 50));
  }
  throw new Error("Deposit wallet transaction retry limit reached.");
}

async function getOrCreateDepositWallet(tx, username, currentBlock) {
  const [existingRows] = await tx.query(
    `SELECT id,username,wallet_address,derivation_index,created_block,last_scanned_block
     FROM users_usdt_deposit_wallets WHERE username=? LIMIT 1 FOR UPDATE`,
    [username],
  );
  if (existingRows.length) return existingRows[0];

  const [lockRows] = await tx.query(
    "SELECT lock_name FROM system_locks WHERE lock_name='deposit_wallet_index' FOR UPDATE",
  );
  if (!lockRows.length) throw new Error("The deposit-wallet derivation lock is not initialized.");

  const [indexRows] = await tx.query(
    "SELECT COALESCE(MAX(derivation_index),-1)+1 AS next_index FROM users_usdt_deposit_wallets",
  );
  const nextIndex = Number(indexRows[0].next_index);
  if (!Number.isSafeInteger(nextIndex) || nextIndex < 0 || nextIndex > 0x7fffffff) {
    throw new Error("The BSC deposit-wallet derivation index is exhausted or invalid.");
  }

  const walletAddress = checksumAddress(deriveDepositAddress(nextIndex));
  const now = String(Date.now());
  const [insertResult] = await tx.query(
    `INSERT INTO users_usdt_deposit_wallets
     (username,wallet_address,derivation_index,created_block,last_scanned_block,created_at_ms,sweep_lock_until_ms,account_status)
     VALUES(?,?,?,?,?,?,0,'active')`,
    [username, walletAddress, nextIndex, String(currentBlock), String(currentBlock), now],
  );
  return {
    id: insertResult.insertId,
    username,
    wallet_address: walletAddress,
    derivation_index: nextIndex,
    created_block: String(currentBlock),
    last_scanned_block: String(currentBlock),
    account_status: "active",
  };
}

async function getOrCreateUserDepositAddress(db, username) {
  if (typeof username !== "string" || username.length === 0) {
    throw new TypeError("A valid username is required to retrieve a deposit address.");
  }
  const rows = await db.queryAsync(
    "SELECT wallet_address,account_status FROM users_usdt_deposit_wallets WHERE username=? LIMIT 1",
    [username],
  );
  if (rows.length) {
    if (rows[0].account_status !== "active") return null;
    return checksumAddress(rows[0].wallet_address);
  }
  if (!paymentConfig || !paymentConfig.enabled) return null;
  const currentBlock = BigInt(await rpcCall("eth_blockNumber", []));
  const wallet = await runDbTransaction(db, async (tx) => {
    const [authRows] = await tx.query(
      "SELECT status FROM auths WHERE username=? LIMIT 1 FOR UPDATE", [username],
    );
    if (!authRows.length || Number(authRows[0].status) <= 0) {
      throw new Error("Cannot assign a deposit address to an inactive account.");
    }
    const [stockRows] = await tx.query(
      "SELECT username FROM users_stock WHERE username=? LIMIT 1 FOR UPDATE", [username],
    );
    if (!stockRows.length) throw new Error("Cannot assign a deposit address without a user stock account.");
    return getOrCreateDepositWallet(tx, username, currentBlock);
  });
  return checksumAddress(wallet.wallet_address);
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
  return {
    txHash,
    logIndex,
    blockNumber: blockNumber.toString(),
    blockHash,
    blockTimestampMs,
    fromAddress: getAddress(`0x${String(log.topics[1]).slice(-40)}`),
    depositAddress: getAddress(`0x${String(log.topics[2]).slice(-40)}`),
    amountRaw: amountRaw.toString(),
    amount: new BigNumber(amountRaw.toString()).shiftedBy(-TOKEN_DECIMALS).toFixed(TOKEN_DECIMALS),
  };
}

async function scanOneDepositWallet(db, wallet, safeBlock, onTransfer) {
  const cursor = BigInt(wallet.last_scanned_block);
  const createdBlock = BigInt(wallet.created_block);
  const fromBlock = cursor > createdBlock ? cursor + 1n : createdBlock + 1n;
  if (safeBlock < fromBlock) return;

  const toBlock = minBigInt(safeBlock, fromBlock + paymentConfig.maxLogBlockRange - 1n);
  const logs = await rpcCall("eth_getLogs", [{
    fromBlock: toQuantity(fromBlock),
    toBlock: toQuantity(toBlock),
    address: paymentConfig.tokenAddress,
    topics: [TRANSFER_TOPIC, null, addressTopic(wallet.wallet_address)],
  }]);
  if (!Array.isArray(logs)) throw new Error("BSC RPC returned an invalid eth_getLogs result.");
  logs.sort((a, b) => {
    const blockDiff = BigInt(a.blockNumber) - BigInt(b.blockNumber);
    if (blockDiff !== 0n) return blockDiff < 0n ? -1 : 1;
    return Number(BigInt(a.logIndex)) - Number(BigInt(b.logIndex));
  });

  for (const log of logs) {
    const verified = await verifyFinalizedTransfer(log);
    if (verified?.pending) return;
    if (!verified || verified.ignored) continue;
    if (verified.depositAddress.toLowerCase() !== wallet.wallet_address.toLowerCase()) continue;
    await onTransfer({
      username: wallet.username,
      depositWalletId: Number(wallet.id),
      depositAccountStatus: wallet.account_status,
      ...verified,
    });
  }

  await db.queryAsync(
    "UPDATE users_usdt_deposit_wallets SET last_scanned_block=? WHERE id=? AND CAST(last_scanned_block AS UNSIGNED)<=?",
    [toBlock.toString(), wallet.id, toBlock.toString()],
  );
}

function startPaymentWatcher(db, onTransfer, onMaintenance) {
  if (!paymentConfig || !paymentConfig.enabled) return;
  if (watcherTimer) return;
  if (typeof onTransfer !== "function") throw new TypeError("A confirmed-transfer handler is required.");

  watcherDatabase = db;
  transferHandler = onTransfer;
  maintenanceHandler = typeof onMaintenance === "function" ? onMaintenance : null;

  const scan = async () => {
    if (watcherRunning) return;
    watcherRunning = true;
    try {
      const latestBlock = BigInt(await rpcCall("eth_blockNumber", []));
      const subtract = paymentConfig.minConfirmations - 1n;
      const safeBlock = latestBlock >= subtract ? latestBlock - subtract : 0n;

      let rows = await watcherDatabase.queryAsync(
        `SELECT id,username,wallet_address,account_status,created_block,last_scanned_block
         FROM users_usdt_deposit_wallets WHERE id>? ORDER BY id ASC LIMIT ?`,
        [lastWalletCursorId, paymentConfig.maxWalletsPerPoll],
      );
      if (!rows.length && lastWalletCursorId > 0) {
        lastWalletCursorId = 0;
        rows = await watcherDatabase.queryAsync(
          `SELECT id,username,wallet_address,account_status,created_block,last_scanned_block
           FROM users_usdt_deposit_wallets ORDER BY id ASC LIMIT ?`,
          [paymentConfig.maxWalletsPerPoll],
        );
      }
      for (const wallet of rows) {
        lastWalletCursorId = Number(wallet.id);
        try {
          await scanOneDepositWallet(watcherDatabase, wallet, safeBlock, transferHandler);
        } catch (error) {
          console.error(`BEP-20 scan failed for deposit wallet ${wallet.id}:`, error.message);
        }
      }
      if (maintenanceHandler) {
        try {
          await maintenanceHandler();
        } catch (error) {
          console.error("Recharge batch worker failed:", error.message);
        }
      }
    } catch (error) {
      console.error("BEP-20 deposit watcher failed:", error);
    } finally {
      watcherRunning = false;
      watcherTimer = setTimeout(scan, paymentConfig.pollIntervalMs);
      if (typeof watcherTimer.unref === "function") watcherTimer.unref();
    }
  };
  void scan();
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
  getOrCreateUserDepositAddress,
  startPaymentWatcher,
  getPaymentPublicConfig,
  isAddress,
  deriveDepositAddress,
  rpcCall,
};
