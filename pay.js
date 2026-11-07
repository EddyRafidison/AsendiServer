"use strict";

const https = require("https");
const BigNumber = require("bignumber.js");
const { URL } = require("url");
const { HDNodeWallet, getAddress } = require("ethers");
const {
  MIN_RECHARGE_AMOUNT,
  MAX_RECHARGE_AMOUNT,
  MAX_DEFAULT_STOCK,
  RECHARGE_REQUEST_TTL_MS,
} = require("./recharge-policy");

const TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const CHAIN_ID = 56n;
const CANONICAL_BSC_USD_CONTRACT =
  "0x55d398326f99059fF775485246999027B3197955";
const EXPECTED_TOKEN_DECIMALS = 18;
const RPC_TIMEOUT_MS = 12000;
const RPC_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

let paymentConfig = null;
let rpcCounter = 0;
let watcherTimer = null;
let watcherRunning = false;
let watcherDatabase = null;
let transferHandler = null;
let notificationHandler = null;
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

  const rpcCandidates = [
    process.env.BSC_RPC_URL,
    process.env.BSC_RPC_FALLBACK_URL,
  ]
    .map((value) => String(value || "").trim())
    .filter(Boolean);

  const tokenAddress = String(
    process.env.USDT_BEP20_CONTRACT || CANONICAL_BSC_USD_CONTRACT,
  ).trim();
  const treasuryAddress = String(
    process.env.USDT_BEP20_TREASURY_ADDRESS ||
      process.env.USDT_BEP20_RECEIVER_ADDRESS ||
      "",
  ).trim();
  const depositXpub = String(process.env.BSC_DEPOSIT_XPUB || "").trim();
  const minConfirmations = Number(process.env.USDT_MIN_CONFIRMATIONS || 15);
  const pollIntervalMs = Number(process.env.USDT_PAYMENT_POLL_MS || 5000);
  const maxLogBlockRange = Number(process.env.USDT_MAX_LOG_BLOCK_RANGE || 250);
  const maxWalletsPerPoll = Number(process.env.USDT_MAX_WALLETS_PER_POLL || 25);
  const expectedDecimals = Number(
    process.env.USDT_BEP20_EXPECTED_DECIMALS || EXPECTED_TOKEN_DECIMALS,
  );

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
    throw new Error(
      `Only the approved Binance-Peg BSC-USD contract is accepted: ${CANONICAL_BSC_USD_CONTRACT}.`,
    );
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
    throw new Error("USDT_MAX_WALLETS_PER_POLL must be an integer between 1 and 500.");
  }
  if (expectedDecimals !== EXPECTED_TOKEN_DECIMALS) {
    throw new Error(`The approved token must use ${EXPECTED_TOKEN_DECIMALS} decimals.`);
  }

  let publicRoot;
  try {
    publicRoot = HDNodeWallet.fromExtendedKey(depositXpub);
  } catch {
    throw new Error("BSC_DEPOSIT_XPUB is not a valid extended public key.");
  }
  if (publicRoot.privateKey) {
    throw new Error("BSC_DEPOSIT_XPUB must be an xpub, never an xprv or private key.");
  }

  const firstDerivedAddress = publicRoot.deriveChild(0).address;
  if (!isAddress(firstDerivedAddress)) {
    throw new Error("BSC_DEPOSIT_XPUB could not derive a valid deposit address.");
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
    decimals: expectedDecimals,
    decimalFactor: new BigNumber(10).pow(expectedDecimals),
  };
}

function deriveDepositAddress(index) {
  if (!paymentConfig || !paymentConfig.enabled) {
    throw new Error("BEP-20 payment provider is not initialized.");
  }
  if (!Number.isSafeInteger(Number(index)) || Number(index) < 0 || Number(index) > 0x7fffffff) {
    throw new RangeError("Invalid BSC deposit derivation index.");
  }
  return paymentConfig.publicRoot.deriveChild(Number(index)).address;
}

function rpcCallAt(rpcUrl, method, params = []) {
  const requestBody = JSON.stringify({
    jsonrpc: "2.0",
    id: ++rpcCounter,
    method,
    params,
  });

  return new Promise((resolve, reject) => {
    const request = https.request(
      rpcUrl,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          "Content-Length": Buffer.byteLength(requestBody),
        },
      },
      (response) => {
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
            return reject(new Error(`BSC RPC returned HTTP ${response.statusCode}.`));
          }

          let payload;
          try {
            payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          } catch {
            return reject(new Error("BSC RPC returned invalid JSON."));
          }

          if (payload.error) {
            return reject(
              new Error(`BSC RPC ${method} failed: ${String(payload.error.message || "unknown error")}`),
            );
          }
          if (!Object.prototype.hasOwnProperty.call(payload, "result")) {
            return reject(new Error(`BSC RPC ${method} returned no result.`));
          }
          resolve(payload.result);
        });
      },
    );

    request.setTimeout(RPC_TIMEOUT_MS, () => {
      request.destroy(new Error(`BSC RPC ${method} timed out.`));
    });
    request.on("error", reject);
    request.end(requestBody);
  });
}

async function rpcCall(method, params = []) {
  if (!paymentConfig || !paymentConfig.enabled) {
    throw new Error("BEP-20 payment provider is not initialized.");
  }

  let lastError = null;
  const endpointCount = paymentConfig.rpcUrls.length;
  const startIndex = paymentConfig.currentRpcIndex || 0;

  for (let offset = 0; offset < endpointCount; offset += 1) {
    const index = (startIndex + offset) % endpointCount;
    try {
      const result = await rpcCallAt(paymentConfig.rpcUrls[index], method, params);
      paymentConfig.currentRpcIndex = index;
      return result;
    } catch (error) {
      lastError = error;
      console.error(`BSC RPC endpoint ${index + 1} failed for ${method}:`, error.message);
    }
  }

  throw new Error(
    `All configured BSC RPC endpoints failed for ${method}: ${lastError?.message || "unknown error"}`,
  );
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
    const verifiedRpcUrls = [];
    const rpcErrors = [];

    for (let index = 0; index < config.rpcUrls.length; index += 1) {
      const rpcUrl = config.rpcUrls[index];
      try {
        const chainId = BigInt(await rpcCallAt(rpcUrl, "eth_chainId", []));
        if (chainId !== CHAIN_ID) {
          throw new Error(`RPC endpoint is on chain ${chainId}, not BNB Smart Chain mainnet 56.`);
        }

        const tokenCode = await rpcCallAt(rpcUrl, "eth_getCode", [config.tokenAddress, "latest"]);
        if (typeof tokenCode !== "string" || tokenCode === "0x" || tokenCode === "0x0") {
          throw new Error("RPC endpoint cannot find the approved token contract.");
        }

        const decimalsResult = await rpcCallAt(rpcUrl, "eth_call", [
          { to: config.tokenAddress, data: "0x313ce567" },
          "latest",
        ]);
        if (typeof decimalsResult !== "string" || !/^0x[0-9a-fA-F]+$/.test(decimalsResult)) {
          throw new Error("RPC endpoint returned an invalid decimals() value.");
        }
        if (Number(BigInt(decimalsResult)) !== EXPECTED_TOKEN_DECIMALS) {
          throw new Error(`The approved token must use ${EXPECTED_TOKEN_DECIMALS} decimals.`);
        }

        const currentBlock = BigInt(await rpcCallAt(rpcUrl, "eth_blockNumber", []));
        const logProbe = await rpcCallAt(rpcUrl, "eth_getLogs", [
          {
            fromBlock: toQuantity(currentBlock),
            toBlock: toQuantity(currentBlock),
            address: config.tokenAddress,
            topics: [TRANSFER_TOPIC],
          },
        ]);
        if (!Array.isArray(logProbe)) {
          throw new Error("RPC endpoint does not support eth_getLogs correctly.");
        }

        verifiedRpcUrls.push(rpcUrl);
      } catch (error) {
        rpcErrors.push(`endpoint ${index + 1}: ${error.message}`);
        console.error(`BSC RPC endpoint ${index + 1} failed startup validation:`, error.message);
      }
    }

    if (verifiedRpcUrls.length === 0) {
      throw new Error(`No BSC RPC endpoint passed startup checks. ${rpcErrors.join(" | ")}`);
    }

    paymentConfig.rpcUrls = verifiedRpcUrls;
    paymentConfig.currentRpcIndex = 0;

    console.log(
      `BEP-20 monitor ready: BSC chain 56, Binance-Peg BSC-USD, 18 decimals, ${config.minConfirmationsNumber} confirmations, ${verifiedRpcUrls.length} RPC endpoint(s).`,
    );

    return {
      enabled: true,
      network: "BNB Smart Chain (BEP-20)",
      chainId: 56,
      tokenName: "Binance-Peg BSC-USD",
      tokenContract: paymentConfig.tokenAddress,
      treasuryAddress: paymentConfig.treasuryAddress,
      decimals: paymentConfig.decimals,
      minimumAmount: MIN_RECHARGE_AMOUNT.toFixed(0),
      maximumAmount: MAX_RECHARGE_AMOUNT.toFixed(0),
      requestLifetimeSeconds: Math.floor(RECHARGE_REQUEST_TTL_MS / 1000),
    };
  } catch (error) {
    paymentConfig = null;
    throw error;
  }
}

function getConnection(db) {
  return new Promise((resolve, reject) => {
    db.getConnection((error, connection) => {
      if (error) return reject(error);
      resolve(connection);
    });
  });
}

async function runDbTransaction(db, work, maxAttempts = 3) {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const connection = await getConnection(db);
    let tx;
    let started = false;
    let retry = false;

    try {
      tx = connection.promise();
      await tx.beginTransaction();
      started = true;
      const result = await work(tx);
      await tx.commit();
      started = false;
      return result;
    } catch (error) {
      if (started) {
        try {
          await tx.rollback();
        } catch (rollbackError) {
          console.error("Payment database rollback failed:", rollbackError);
        }
      }

      const retryable = error && ["ER_LOCK_DEADLOCK", "ER_LOCK_WAIT_TIMEOUT"].includes(error.code);
      if (!retryable || attempt === maxAttempts) throw error;
      retry = true;
    } finally {
      connection.release();
    }

    if (retry) await new Promise((resolve) => setTimeout(resolve, attempt * 50));
  }
  throw new Error("Payment database transaction retry limit reached.");
}

async function getOrCreateDepositWallet(tx, username, currentBlock) {
  const [existingRows] = await tx.query(
    `SELECT id,username,wallet_address,derivation_index,created_block,last_scanned_block
     FROM users_usdt_deposit_wallets
     WHERE username=?
     LIMIT 1
     FOR UPDATE`,
    [username],
  );
  if (existingRows.length > 0) return existingRows[0];

  const [lockRows] = await tx.query(
    "SELECT lock_name FROM system_locks WHERE lock_name=? FOR UPDATE",
    ["deposit_wallet_index"],
  );
  if (lockRows.length === 0) {
    throw new Error("The deposit-wallet derivation lock is not initialized.");
  }

  const [indexRows] = await tx.query(
    "SELECT MAX(derivation_index) AS max_index FROM users_usdt_deposit_wallets",
  );
  const nextIndex = indexRows[0].max_index === null
    ? 0
    : Number(indexRows[0].max_index) + 1;
  if (!Number.isSafeInteger(nextIndex) || nextIndex < 0 || nextIndex > 0x7fffffff) {
    throw new Error("The BSC deposit-wallet derivation index is exhausted or invalid.");
  }

  const walletAddress = checksumAddress(deriveDepositAddress(nextIndex));
  const [insertResult] = await tx.query(
    `INSERT INTO users_usdt_deposit_wallets
     (username,wallet_address,derivation_index,created_block,last_scanned_block,created_at_ms,sweep_lock_until_ms)
     VALUES(?,?,?,?,?,?,0)`,
    [username, walletAddress, nextIndex, String(currentBlock), String(currentBlock), String(Date.now())],
  );

  return {
    id: insertResult.insertId,
    username,
    wallet_address: walletAddress,
    derivation_index: nextIndex,
    created_block: String(currentBlock),
    last_scanned_block: String(currentBlock),
  };
}

async function getOrCreateUserDepositAddress(db, username) {
  if (typeof username !== "string" || username.length === 0) {
    throw new TypeError("A valid username is required to retrieve a deposit address.");
  }

  // Most users already have an address. Avoid an RPC call and a write transaction
  // on every balance refresh once the address has been assigned.
  const existingRows = await db.queryAsync(
    `SELECT wallet_address
     FROM users_usdt_deposit_wallets
     WHERE username=?
     LIMIT 1`,
    [username],
  );
  if (existingRows.length > 0) {
    return checksumAddress(existingRows[0].wallet_address);
  }

  // Do not create new deposit wallets while the payment provider is disabled.
  if (!paymentConfig || !paymentConfig.enabled) return null;

  const currentBlock = BigInt(await rpcCall("eth_blockNumber", []));
  const depositWallet = await runDbTransaction(db, async (tx) => {
    // Keep the same lock order as recharge creation to avoid lock-order deadlocks.
    const [authRows] = await tx.query(
      "SELECT status FROM auths WHERE username=? LIMIT 1 FOR UPDATE",
      [username],
    );
    if (authRows.length === 0 || Number(authRows[0].status) <= 0) {
      throw new Error("Cannot assign a deposit address to an inactive account.");
    }

    const [stockRows] = await tx.query(
      "SELECT username FROM users_stock WHERE username=? LIMIT 1 FOR UPDATE",
      [username],
    );
    if (stockRows.length === 0) {
      throw new Error("Cannot assign a deposit address without a user stock account.");
    }

    return getOrCreateDepositWallet(tx, username, currentBlock);
  });

  return checksumAddress(depositWallet.wallet_address);
}

function buildRequestResponse(requestId, username, depositWallet, requestedAmount, expiresAt) {
  return {
    transf: "pending",
    request_id: String(requestId),
    username,
    network: "BNB Smart Chain (BEP-20)",
    chain_id: 56,
    token_name: "Binance-Peg BSC-USD",
    token_contract: paymentConfig.tokenAddress,
    decimals: paymentConfig.decimals,
    deposit_address: depositWallet.wallet_address,
    receive_address: depositWallet.wallet_address,
    requested_amount: requestedAmount.toFixed(paymentConfig.decimals),
    minimum_amount: MIN_RECHARGE_AMOUNT.toFixed(0),
    maximum_amount: MAX_RECHARGE_AMOUNT.toFixed(0),
    expires_at_ms: expiresAt,
    expires_in: Math.floor(RECHARGE_REQUEST_TTL_MS / 1000),
  };
}

async function createPaymentRequest(db, username, amountText) {
  if (!paymentConfig || !paymentConfig.enabled) {
    throw new Error("BEP-20 payments are disabled.");
  }

  const amountString = typeof amountText === "string"
    ? amountText.trim()
    : String(amountText ?? "").trim();
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(amountString)) {
    return { error: "invalid recharge amount", notAllowed: true };
  }

  const requestedAmount = new BigNumber(amountString);
  if (
    !requestedAmount.isFinite() ||
    requestedAmount.decimalPlaces() > paymentConfig.decimals ||
    requestedAmount.isLessThan(MIN_RECHARGE_AMOUNT) ||
    requestedAmount.isGreaterThan(MAX_RECHARGE_AMOUNT)
  ) {
    return {
      error: "recharge amount must be between 70 and 140 BSC-USD",
      notAllowed: true,
    };
  }

  const blockNumber = BigInt(await rpcCall("eth_blockNumber", []));
  const now = Date.now();
  const expiresAt = now + RECHARGE_REQUEST_TTL_MS;

  return runDbTransaction(db, async (tx) => {
    const [authRows] = await tx.query(
      "SELECT username,status FROM auths WHERE username=? FOR UPDATE",
      [username],
    );
    if (authRows.length === 0 || Number(authRows[0].status) <= 0) {
      return { error: "account unavailable", notAllowed: true };
    }

    const [stockRows] = await tx.query(
      "SELECT balance FROM users_stock WHERE username=? FOR UPDATE",
      [username],
    );
    if (stockRows.length === 0) return { error: "user stock not found", notAllowed: true };

    const currentBalance = new BigNumber(stockRows[0].balance);
    const maxStock = new BigNumber(MAX_DEFAULT_STOCK);
    if (!currentBalance.isFinite() || currentBalance.isNegative()) {
      throw new Error("Invalid user balance while creating a recharge request.");
    }
    if (currentBalance.plus(requestedAmount).isGreaterThan(maxStock)) {
      return { error: "maximum user balance exceeded", notAllowed: true };
    }

    const [heldRows] = await tx.query(
      `SELECT id FROM users_usdt_transfer_events
       WHERE username=? AND status='pending_support'
       LIMIT 1 FOR UPDATE`,
      [username],
    );
    if (heldRows.length > 0) {
      return { error: "a received payment is awaiting support review", notAllowed: true };
    }

    const { getLastOnexRecharge, assessRechargeCooldown } = require("./recharge-policy");
    const lastRecharge = await getLastOnexRecharge(tx, username, "ONEX");
    const cooldown = assessRechargeCooldown(lastRecharge, now);
    if (!cooldown.allowed) {
      return {
        error: "weekly recharge limit reached",
        notAllowed: true,
        remaining_seconds: Math.ceil(cooldown.remainingMs / 1000),
      };
    }

    await tx.query(
      `UPDATE users_usdt_tx
       SET status='expired',pending_username=NULL,pending_tx_addr=NULL
       WHERE username=? AND status='pending' AND expires_at_ms<=?`,
      [username, String(now)],
    );
    await tx.query(
      `UPDATE users_usdt_recharge_status s
       JOIN users_usdt_tx p ON p.id=s.request_id
       SET s.status='expired',s.response_json=?,s.updated_at_ms=?
       WHERE p.username=? AND p.status='expired' AND s.status='pending'`,
      [JSON.stringify({ transf: "expired", message: "The one-hour payment window has expired." }), String(now), username],
    );

    const [existingRows] = await tx.query(
      `SELECT id,tx_addr,requested_amount,expires_at_ms
       FROM users_usdt_tx
       WHERE pending_username=? AND status='pending'
       LIMIT 1 FOR UPDATE`,
      [username],
    );
    if (existingRows.length > 0) {
      const sameAmount = new BigNumber(existingRows[0].requested_amount).isEqualTo(requestedAmount);
      const walletRows = await tx.query(
        `SELECT wallet_address FROM users_usdt_deposit_wallets WHERE username=? LIMIT 1`,
        [username],
      );
      const wallet = walletRows[0][0];
      if (!sameAmount || !wallet) {
        return { error: "a different recharge request is already active", notAllowed: true };
      }
      const response = buildRequestResponse(
        existingRows[0].id,
        username,
        wallet,
        requestedAmount,
        Number(existingRows[0].expires_at_ms),
      );
      return { existing: true, requestId: String(existingRows[0].id), response };
    }

    const depositWallet = await getOrCreateDepositWallet(tx, username, blockNumber);
    const [date, time] = require("./utils").getDate();
    const [insertResult] = await tx.query(
      `INSERT INTO users_usdt_tx
       (username,tx_addr,amount,requested_amount,tx_hash,record_date,record_time,status,pending_username,pending_tx_addr,created_at_ms,expires_at_ms,start_block,last_scanned_block)
       VALUES(?,?,0,?,NULL,?,?,'pending',?,?,?,?,?,?)`,
      [
        username,
        depositWallet.wallet_address,
        requestedAmount.toFixed(paymentConfig.decimals),
        date,
        time,
        username,
        depositWallet.wallet_address.toLowerCase(),
        String(now),
        String(expiresAt),
        blockNumber.toString(),
        blockNumber.toString(),
      ],
    );

    const requestId = String(insertResult.insertId);
    const response = buildRequestResponse(requestId, username, depositWallet, requestedAmount, expiresAt);
    await tx.query(
      `INSERT INTO users_usdt_recharge_status
       (request_id,username,status,response_json,expires_at_ms,updated_at_ms)
       VALUES(?,?,'pending',?,?,?)`,
      [requestId, username, JSON.stringify(response), String(expiresAt), String(now)],
    );

    return { existing: false, requestId, response };
  });
}

async function getPaymentStatus(db, username, requestId) {
  const rows = await db.queryAsync(
    `SELECT status,response_json,expires_at_ms
     FROM users_usdt_recharge_status
     WHERE request_id=? AND username=? LIMIT 1`,
    [requestId, username],
  );
  if (rows.length === 0) return { transf: "not_found" };

  let response;
  try {
    response = JSON.parse(rows[0].response_json);
  } catch {
    response = { transf: "error" };
  }

  if (rows[0].status === "pending") {
    const remainingMs = Math.max(0, Number(rows[0].expires_at_ms) - Date.now());
    response.transf = remainingMs > 0 ? "pending" : "verifying";
    response.remaining_seconds = Math.ceil(remainingMs / 1000);
  }
  return response;
}

async function verifyFinalizedTransfer(log) {
  if (!log || log.removed || !Array.isArray(log.topics) || log.topics.length < 3) return null;
  if (String(log.address).toLowerCase() !== paymentConfig.tokenAddressLower) return null;
  if (String(log.topics[0]).toLowerCase() !== TRANSFER_TOPIC) return null;
  if (!/^0x[0-9a-fA-F]{64}$/.test(String(log.topics[1] || ""))) return null;
  if (!/^0x[0-9a-fA-F]{64}$/.test(String(log.topics[2] || ""))) return null;
  if (!/^0x[0-9a-fA-F]{64}$/.test(String(log.data || ""))) return null;

  const txHash = String(log.transactionHash || "").toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(txHash)) return null;
  const blockNumber = BigInt(log.blockNumber);
  const blockHash = String(log.blockHash || "").toLowerCase();
  const logIndex = Number(BigInt(log.logIndex));
  if (!Number.isSafeInteger(logIndex) || logIndex < 0) return null;
  // The caller only scans blocks at or below safeBlock, which is already
  // computed from latestBlock and the configured confirmation depth.

  const receipt = await rpcCall("eth_getTransactionReceipt", [txHash]);
  if (!receipt) return { pending: true };
  if (String(receipt.status).toLowerCase() !== "0x1") return { ignored: true };
  if (
    String(receipt.transactionHash || "").toLowerCase() !== txHash ||
    String(receipt.blockHash || "").toLowerCase() !== blockHash ||
    BigInt(receipt.blockNumber) !== blockNumber ||
    !Array.isArray(receipt.logs)
  ) {
    return { pending: true };
  }

  const matchingReceiptLog = receipt.logs.find((item) =>
    Number(BigInt(item.logIndex)) === logIndex &&
    String(item.address || "").toLowerCase() === paymentConfig.tokenAddressLower &&
    String(item.topics?.[0] || "").toLowerCase() === TRANSFER_TOPIC &&
    String(item.topics?.[1] || "").toLowerCase() === String(log.topics[1]).toLowerCase() &&
    String(item.topics?.[2] || "").toLowerCase() === String(log.topics[2]).toLowerCase() &&
    String(item.data || "").toLowerCase() === String(log.data).toLowerCase(),
  );
  if (!matchingReceiptLog) return { ignored: true };

  const canonicalBlock = await rpcCall("eth_getBlockByNumber", [toQuantity(blockNumber), false]);
  if (!canonicalBlock || String(canonicalBlock.hash || "").toLowerCase() !== blockHash) {
    return { pending: true };
  }

  const blockTimestampMs = Number(BigInt(canonicalBlock.timestamp)) * 1000;
  if (!Number.isSafeInteger(blockTimestampMs) || blockTimestampMs <= 0) return { pending: true };

  const transaction = await rpcCall("eth_getTransactionByHash", [txHash]);
  if (!transaction) return { pending: true };

  const amountRaw = BigInt(log.data);
  if (amountRaw <= 0n) return { ignored: true };

  const fromAddress = getAddress(`0x${String(log.topics[1]).slice(-40)}`);
  const depositAddress = getAddress(`0x${String(log.topics[2]).slice(-40)}`);
  const transactionFrom = isAddress(transaction.from)
    ? getAddress(transaction.from)
    : null;
  const transactionTo = isAddress(transaction.to)
    ? getAddress(transaction.to)
    : null;
  const directWalletTransfer = Boolean(
    transactionFrom &&
    transactionTo &&
    transactionFrom.toLowerCase() === fromAddress.toLowerCase() &&
    transactionTo.toLowerCase() === paymentConfig.tokenAddressLower &&
    String(transaction.input || "").slice(0, 10).toLowerCase() === "0xa9059cbb",
  );
  const amount = new BigNumber(amountRaw.toString()).shiftedBy(-paymentConfig.decimals);

  return {
    txHash,
    logIndex,
    blockNumber: blockNumber.toString(),
    blockHash,
    blockTimestampMs,
    fromAddress,
    depositAddress,
    directWalletTransfer,
    amountRaw: amountRaw.toString(),
    amount: amount.toFixed(paymentConfig.decimals),
  };
}

async function scanOneDepositWallet(db, wallet, safeBlock, onTransfer) {
  const cursor = BigInt(wallet.last_scanned_block);
  const firstBlock = BigInt(wallet.created_block);
  const fromBlock = cursor > firstBlock ? cursor + 1n : firstBlock + 1n;
  if (safeBlock < fromBlock) return;

  const toBlock = minBigInt(safeBlock, fromBlock + paymentConfig.maxLogBlockRange - 1n);
  const logs = await rpcCall("eth_getLogs", [
    {
      fromBlock: toQuantity(fromBlock),
      toBlock: toQuantity(toBlock),
      address: paymentConfig.tokenAddress,
      topics: [TRANSFER_TOPIC, null, addressTopic(wallet.wallet_address)],
    },
  ]);
  if (!Array.isArray(logs)) throw new Error("BSC RPC returned an invalid eth_getLogs result.");

  logs.sort((a, b) => {
    const blockDifference = BigInt(a.blockNumber) - BigInt(b.blockNumber);
    if (blockDifference !== 0n) return blockDifference < 0n ? -1 : 1;
    return Number(BigInt(a.logIndex)) - Number(BigInt(b.logIndex));
  });

  for (const log of logs) {
    const verified = await verifyFinalizedTransfer(log);
    if (verified && verified.pending) {
      return;
    }
    if (!verified || verified.ignored) continue;
    if (verified.depositAddress.toLowerCase() !== wallet.wallet_address.toLowerCase()) continue;

    await onTransfer({
      username: wallet.username,
      depositWalletId: Number(wallet.id),
      ...verified,
    });
  }

  await db.queryAsync(
    "UPDATE users_usdt_deposit_wallets SET last_scanned_block=? WHERE id=? AND last_scanned_block<=?",
    [toBlock.toString(), wallet.id, toBlock.toString()],
  );
}

async function expireOldRequests(db) {
  const now = String(Date.now());
  await db.queryAsync(
    `UPDATE users_usdt_tx
     SET status='expired',pending_username=NULL,pending_tx_addr=NULL
     WHERE status='pending' AND expires_at_ms<=?`,
    [now],
  );
  await db.queryAsync(
    `UPDATE users_usdt_recharge_status s
     JOIN users_usdt_tx p ON p.id=s.request_id
     SET s.status='expired',
         s.response_json=?,
         s.updated_at_ms=?
     WHERE p.status='expired' AND s.status='pending'`,
    [JSON.stringify({ transf: "expired", message: "The one-hour payment window has expired. Late payments are held for support review." }), now],
  );
}

function startPaymentWatcher(db, onTransfer, onNotifyPending) {
  if (!paymentConfig || !paymentConfig.enabled) return;
  if (watcherTimer) return;
  if (typeof onTransfer !== "function") {
    throw new TypeError("A confirmed-transfer handler is required.");
  }

  watcherDatabase = db;
  transferHandler = onTransfer;
  notificationHandler = typeof onNotifyPending === "function" ? onNotifyPending : null;

  const scan = async () => {
    if (watcherRunning) return;
    watcherRunning = true;

    try {
      const latestBlock = BigInt(await rpcCall("eth_blockNumber", []));
      const confirmationsToSubtract = paymentConfig.minConfirmations - 1n;
      const safeBlock = latestBlock >= confirmationsToSubtract
        ? latestBlock - confirmationsToSubtract
        : 0n;

      await expireOldRequests(watcherDatabase);

      let walletRows = await watcherDatabase.queryAsync(
        `SELECT id,username,wallet_address,created_block,last_scanned_block
         FROM users_usdt_deposit_wallets
         WHERE id>?
         ORDER BY id ASC
         LIMIT ?`,
        [lastWalletCursorId, paymentConfig.maxWalletsPerPoll],
      );
      if (walletRows.length === 0 && lastWalletCursorId > 0) {
        lastWalletCursorId = 0;
        walletRows = await watcherDatabase.queryAsync(
          `SELECT id,username,wallet_address,created_block,last_scanned_block
           FROM users_usdt_deposit_wallets
           ORDER BY id ASC
           LIMIT ?`,
          [paymentConfig.maxWalletsPerPoll],
        );
      }

      for (const wallet of walletRows) {
        lastWalletCursorId = Number(wallet.id);
        try {
          await scanOneDepositWallet(
            watcherDatabase,
            wallet,
            safeBlock,
            transferHandler,
          );
        } catch (error) {
          console.error(`BEP-20 scan failed for deposit wallet ${wallet.id}:`, error.message);
        }
      }

      if (notificationHandler) {
        try {
          await notificationHandler();
        } catch (error) {
          console.error("Recharge support notification worker failed:", error.message);
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
    decimals: paymentConfig.decimals,
    minimumAmount: MIN_RECHARGE_AMOUNT.toFixed(0),
    maximumAmount: MAX_RECHARGE_AMOUNT.toFixed(0),
    maximumUserBalance: MAX_DEFAULT_STOCK,
  };
}

module.exports = {
  initializePaymentProvider,
  createPaymentRequest,
  getOrCreateUserDepositAddress,
  getPaymentStatus,
  startPaymentWatcher,
  getPaymentPublicConfig,
  isAddress,
  deriveDepositAddress,
};
