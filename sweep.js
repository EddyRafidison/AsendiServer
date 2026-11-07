"use strict";

require("dotenv").config();
const {
  HDNodeWallet,
  Wallet,
  JsonRpcProvider,
  Interface,
  keccak256,
  getAddress,
} = require("ethers");
const {
  DEPOSIT_SWEEP_THRESHOLD,
  DEPOSIT_SWEEP_MAX_AGE_MS,
} = require("./recharge-policy");

const CHAIN_ID = 56;
const CHAIN_ID_BIGINT = 56n;
const CANONICAL_BSC_USD_CONTRACT =
  "0x55d398326f99059fF775485246999027B3197955";
const GLOBAL_SWEEP_LOCK_NAME = "onex_bsc_usdt_sweeper_global";
const TRANSFER_ABI = new Interface([
  "function transfer(address to,uint256 amount) returns (bool)",
]);
const ERC20_BALANCE_ABI = ["function balanceOf(address account) view returns (uint256)"];

let timer = null;
let sweepRuntime = null;

function isEnabled() {
  return String(process.env.USDT_SWEEP_ENABLED || "false").toLowerCase() === "true";
}

function getSweepRuntime() {
  if (sweepRuntime) return sweepRuntime;
  if (!isEnabled()) return null;

  const xprv = String(process.env.BSC_DEPOSIT_XPRV || "").trim();
  const xpub = String(process.env.BSC_DEPOSIT_XPUB || "").trim();
  const funderPrivateKey = String(process.env.BSC_SWEEP_FUNDER_PRIVATE_KEY || "").trim();
  const rpcUrl = String(process.env.BSC_RPC_URL || "").trim();
  const tokenAddress = String(process.env.USDT_BEP20_CONTRACT || CANONICAL_BSC_USD_CONTRACT).trim();
  const treasuryAddress = String(
    process.env.USDT_BEP20_TREASURY_ADDRESS || process.env.USDT_BEP20_RECEIVER_ADDRESS || "",
  ).trim();
  const minConfirmations = Number(process.env.USDT_MIN_CONFIRMATIONS || 15);
  const tokenGasLimit = BigInt(process.env.USDT_SWEEP_TOKEN_GAS_LIMIT || "100000");

  if (!xprv || !xpub || !funderPrivateKey || !rpcUrl || !treasuryAddress) {
    throw new Error(
      "USDT_SWEEP_ENABLED requires BSC_DEPOSIT_XPRV, BSC_DEPOSIT_XPUB, BSC_SWEEP_FUNDER_PRIVATE_KEY, BSC_RPC_URL and the treasury address.",
    );
  }

  if (tokenAddress.toLowerCase() !== CANONICAL_BSC_USD_CONTRACT.toLowerCase()) {
    throw new Error(`The sweeper only accepts the approved Binance-Peg BSC-USD contract: ${CANONICAL_BSC_USD_CONTRACT}.`);
  }

  const privateRoot = HDNodeWallet.fromExtendedKey(xprv);
  if (!privateRoot.privateKey) {
    throw new Error("BSC_DEPOSIT_XPRV must be an extended private key.");
  }
  const publicRoot = HDNodeWallet.fromExtendedKey(xpub);
  if (publicRoot.privateKey) {
    throw new Error("BSC_DEPOSIT_XPUB must be an extended public key.");
  }
  if (privateRoot.neuter().extendedKey !== publicRoot.extendedKey) {
    throw new Error("BSC_DEPOSIT_XPRV does not match BSC_DEPOSIT_XPUB.");
  }

  let parsedRpcUrl;
  try {
    parsedRpcUrl = new URL(rpcUrl);
  } catch {
    throw new Error("BSC_RPC_URL is invalid for the deposit sweeper.");
  }
  if (parsedRpcUrl.protocol !== "https:") {
    throw new Error("BSC_RPC_URL must use HTTPS for the deposit sweeper.");
  }

  const provider = new JsonRpcProvider(rpcUrl, { name: "bnb", chainId: CHAIN_ID });
  const funder = new Wallet(funderPrivateKey, provider);
  const normalizedTreasuryAddress = getAddress(treasuryAddress);
  if (funder.address.toLowerCase() === normalizedTreasuryAddress.toLowerCase()) {
    console.warn("The sweep gas funder and treasury use the same address. This is supported, but a separate gas-funding wallet is safer.");
  }
  const token = new (require("ethers").Contract)(
    tokenAddress,
    ERC20_BALANCE_ABI,
    provider,
  );
  const thresholdRaw = BigInt(DEPOSIT_SWEEP_THRESHOLD.toFixed(0)) * (10n ** 18n);
  const intervalMs = Number(process.env.USDT_SWEEP_INTERVAL_MS || 60000);
  const batchSize = Number(process.env.USDT_SWEEP_BATCH_SIZE || 10);

  if (!Number.isInteger(intervalMs) || intervalMs < 15000 || intervalMs > 3600000) {
    throw new Error("USDT_SWEEP_INTERVAL_MS must be between 15000 and 3600000.");
  }
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 100) {
    throw new Error("USDT_SWEEP_BATCH_SIZE must be between 1 and 100.");
  }
  if (!Number.isInteger(minConfirmations) || minConfirmations < 1 || minConfirmations > 200) {
    throw new Error("USDT_MIN_CONFIRMATIONS must be an integer between 1 and 200.");
  }
  if (tokenGasLimit < 60000n || tokenGasLimit > 200000n) {
    throw new Error("USDT_SWEEP_TOKEN_GAS_LIMIT must be between 60000 and 200000.");
  }

  sweepRuntime = {
    privateRoot,
    provider,
    funder,
    token,
    tokenAddress: getAddress(tokenAddress),
    treasuryAddress: normalizedTreasuryAddress,
    thresholdRaw,
    intervalMs,
    batchSize,
    minConfirmations,
    tokenGasLimit,
  };
  return sweepRuntime;
}

function dbConnection(db) {
  return new Promise((resolve, reject) => {
    db.getConnection((error, connection) => {
      if (error) return reject(error);
      resolve(connection);
    });
  });
}

async function acquireGlobalSweepLock(db) {
  const connection = await dbConnection(db);
  const queryable = connection.promise();
  try {
    const [rows] = await queryable.query(
      "SELECT GET_LOCK(?, 0) AS acquired",
      [GLOBAL_SWEEP_LOCK_NAME],
    );
    if (Number(rows[0]?.acquired) !== 1) {
      connection.release();
      return null;
    }

    let released = false;
    return async () => {
      if (released) return;
      released = true;
      try {
        await queryable.query("SELECT RELEASE_LOCK(?)", [GLOBAL_SWEEP_LOCK_NAME]);
      } finally {
        connection.release();
      }
    };
  } catch (error) {
    connection.release();
    throw error;
  }
}

async function validateSweepNetwork(runtime) {
  const network = await runtime.provider.getNetwork();
  if (BigInt(network.chainId) !== CHAIN_ID_BIGINT) {
    throw new Error(`Sweep RPC is on chain ${network.chainId}; expected BNB Smart Chain 56.`);
  }
  const code = await runtime.provider.getCode(runtime.tokenAddress);
  if (!code || code === "0x") {
    throw new Error("The approved BSC-USD contract is not deployed on the configured sweep RPC.");
  }
  const decimalsResult = await runtime.provider.call({
    to: runtime.tokenAddress,
    data: "0x313ce567",
  });
  if (BigInt(decimalsResult) !== 18n) {
    throw new Error("The approved Binance-Peg BSC-USD contract must use 18 decimals.");
  }
}

async function withTransaction(db, work) {
  const connection = await dbConnection(db);
  const tx = connection.promise();
  let started = false;
  try {
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
        console.error("Sweep DB rollback failed:", rollbackError.message);
      }
    }
    throw error;
  } finally {
    connection.release();
  }
}

async function getFinalizedBlock(runtime) {
  const latest = await runtime.provider.getBlockNumber();
  return Math.max(0, latest - runtime.minConfirmations + 1);
}

async function getUnSweptEvents(db, walletAddress, snapshotBlock) {
  const rows = await db.queryAsync(
    `SELECT id,amount_raw,block_timestamp_ms,block_number
     FROM users_usdt_transfer_events
     WHERE deposit_address=? AND swept_at_ms IS NULL
       AND status IN ('credited','pending_support')
       AND CAST(block_number AS UNSIGNED)<=?
     ORDER BY block_number ASC,log_index ASC`,
    [walletAddress, String(snapshotBlock)],
  );

  let totalRaw = 0n;
  let oldestTimestamp = null;
  for (const row of rows) {
    totalRaw += BigInt(row.amount_raw);
    const timestamp = Number(row.block_timestamp_ms);
    if (Number.isFinite(timestamp)) {
      oldestTimestamp = oldestTimestamp === null ? timestamp : Math.min(oldestTimestamp, timestamp);
    }
  }
  return { rows, totalRaw, oldestTimestamp };
}

async function claimSweepLock(db, walletId) {
  const now = Date.now();
  return withTransaction(db, async (tx) => {
    const [walletRows] = await tx.query(
      "SELECT id,sweep_lock_until_ms FROM users_usdt_deposit_wallets WHERE id=? FOR UPDATE",
      [walletId],
    );
    if (walletRows.length === 0) return false;
    if (Number(walletRows[0].sweep_lock_until_ms || 0) > now) return false;
    await tx.query(
      "UPDATE users_usdt_deposit_wallets SET sweep_lock_until_ms=? WHERE id=?",
      [String(now + 15 * 60 * 1000), walletId],
    );
    return true;
  });
}

async function prepareSweep(db, walletRow, runtime) {
  const now = Date.now();
  const claimed = await claimSweepLock(db, walletRow.id);
  if (!claimed) return null;

  try {
    const activeRows = await db.queryAsync(
      `SELECT id,status,fund_raw_tx,token_raw_tx,fund_tx_hash,token_tx_hash,snapshot_block,amount_raw
       FROM users_usdt_sweeps
       WHERE deposit_wallet_id=? AND status IN ('prepared','funded','submitted')
       ORDER BY id DESC LIMIT 1`,
      [walletRow.id],
    );
    if (activeRows.length > 0) return activeRows[0];

    const snapshotBlock = await getFinalizedBlock(runtime);
    const { rows, totalRaw, oldestTimestamp } = await getUnSweptEvents(
      db,
      walletRow.wallet_address,
      snapshotBlock,
    );
    if (rows.length === 0 || totalRaw <= 0n || oldestTimestamp === null) {
      await db.queryAsync(
        "UPDATE users_usdt_deposit_wallets SET sweep_lock_until_ms=0 WHERE id=?",
        [walletRow.id],
      );
      return null;
    }

    const ageReached = now - oldestTimestamp >= DEPOSIT_SWEEP_MAX_AGE_MS;
    if (totalRaw < runtime.thresholdRaw && !ageReached) {
      await db.queryAsync(
        "UPDATE users_usdt_deposit_wallets SET sweep_lock_until_ms=0 WHERE id=?",
        [walletRow.id],
      );
      return null;
    }

    const childWallet = runtime.privateRoot.deriveChild(Number(walletRow.derivation_index));
    if (childWallet.address.toLowerCase() !== walletRow.wallet_address.toLowerCase()) {
      throw new Error(`Derived key mismatch for deposit wallet ${walletRow.id}.`);
    }

    const onChainBalance = await runtime.token.balanceOf(walletRow.wallet_address, {
      blockTag: snapshotBlock,
    });
    if (onChainBalance < totalRaw) {
      throw new Error(
        `Token balance is lower than the unswept ledger amount for deposit wallet ${walletRow.id}; sweep paused for reconciliation.`,
      );
    }

    const data = TRANSFER_ABI.encodeFunctionData("transfer", [runtime.treasuryAddress, totalRaw]);
    const feeData = await runtime.provider.getFeeData();
    const gasPrice = feeData.gasPrice;
    if (!gasPrice || gasPrice <= 0n) throw new Error("BSC gas price is unavailable.");

    // Use a configurable gas limit instead of eth_estimateGas: a newly derived
    // deposit address normally has no BNB yet, and some RPC nodes reject gas
    // estimation for an unfunded sender. Unused gas is returned to the address.
    const gasLimit = runtime.tokenGasLimit;
    const currentDepositBnb = await runtime.provider.getBalance(childWallet.address);
    const requiredDepositBnb = gasLimit * gasPrice;
    const topUpTarget = (requiredDepositBnb * 110n + 99n) / 100n;
    const fundingValue = topUpTarget > currentDepositBnb
      ? topUpTarget - currentDepositBnb
      : 0n;

    let fundRawTx = null;
    let fundTxHash = null;
    if (fundingValue > 0n) {
      const funderNonce = await runtime.provider.getTransactionCount(runtime.funder.address, "pending");
      const funderBalance = await runtime.provider.getBalance(runtime.funder.address);
      const funderGas = 21000n;
      const requiredFunderBalance = fundingValue + funderGas * gasPrice;
      if (funderBalance < requiredFunderBalance) {
        throw new Error("The BNB gas-funding wallet does not have enough BNB.");
      }
      fundRawTx = await runtime.funder.signTransaction({
        type: 0,
        chainId: CHAIN_ID,
        nonce: funderNonce,
        to: childWallet.address,
        value: fundingValue,
        gasLimit: funderGas,
        gasPrice,
      });
      fundTxHash = keccak256(fundRawTx);
    }

    const childNonce = await runtime.provider.getTransactionCount(childWallet.address, "pending");
    const tokenRawTx = await childWallet.signTransaction({
      type: 0,
      chainId: CHAIN_ID,
      nonce: childNonce,
      to: runtime.tokenAddress,
      value: 0n,
      data,
      gasLimit,
      gasPrice,
    });
    const tokenTxHash = keccak256(tokenRawTx);

    const insertResult = await db.queryAsync(
      `INSERT INTO users_usdt_sweeps
       (deposit_wallet_id,deposit_address,snapshot_block,amount_raw,fund_raw_tx,token_raw_tx,fund_tx_hash,token_tx_hash,status,created_at_ms,updated_at_ms)
       VALUES(?,?,?,?,?,?,?,?, 'prepared',?,?)`,
      [
        walletRow.id,
        walletRow.wallet_address,
        String(snapshotBlock),
        totalRaw.toString(),
        fundRawTx,
        tokenRawTx,
        fundTxHash,
        tokenTxHash,
        String(now),
        String(now),
      ],
    );
    return {
      id: insertResult.insertId,
      status: "prepared",
      fund_raw_tx: fundRawTx,
      token_raw_tx: tokenRawTx,
      fund_tx_hash: fundTxHash,
      token_tx_hash: tokenTxHash,
      snapshot_block: String(snapshotBlock),
      amount_raw: totalRaw.toString(),
    };
  } catch (error) {
    await db.queryAsync(
      "UPDATE users_usdt_deposit_wallets SET sweep_lock_until_ms=0 WHERE id=?",
      [walletRow.id],
    );
    throw error;
  }
}

async function getOrBroadcast(runtime, rawTransaction, expectedHash, confirmations) {
  let receipt = await runtime.provider.getTransactionReceipt(expectedHash);
  if (!receipt) {
    try {
      const response = await runtime.provider.broadcastTransaction(rawTransaction);
      if (response.hash.toLowerCase() !== expectedHash.toLowerCase()) {
        throw new Error("Broadcast transaction hash does not match the signed transaction.");
      }
    } catch (error) {
      // A previously broadcast raw transaction may already be known to the RPC node.
      const knownReceipt = await runtime.provider.getTransactionReceipt(expectedHash);
      const knownTransaction = await runtime.provider.getTransaction(expectedHash);
      if (!knownReceipt && !knownTransaction) throw error;
      receipt = knownReceipt;
    }
  }

  if (!receipt || Number(receipt.status) !== 1) {
    if (receipt && Number(receipt.status) !== 1) {
      throw new Error(`Sweep transaction ${expectedHash} failed on-chain.`);
    }
    receipt = await runtime.provider.waitForTransaction(expectedHash, confirmations, 120000);
  } else {
    const latestBlock = await runtime.provider.getBlockNumber();
    const confirmationDepth = latestBlock - receipt.blockNumber + 1;
    if (confirmationDepth < confirmations) {
      receipt = await runtime.provider.waitForTransaction(expectedHash, confirmations, 120000);
    }
  }

  if (!receipt) return null;
  if (Number(receipt.status) !== 1) {
    throw new Error(`Sweep transaction ${expectedHash} failed on-chain.`);
  }

  const canonicalBlock = await runtime.provider.getBlock(receipt.blockNumber);
  if (!canonicalBlock || canonicalBlock.hash.toLowerCase() !== receipt.blockHash.toLowerCase()) {
    return null;
  }
  const latestBlock = await runtime.provider.getBlockNumber();
  if (latestBlock - receipt.blockNumber + 1 < confirmations) return null;
  return receipt;
}

async function resumeSweep(db, walletRow, sweepRow, runtime) {
  const now = String(Date.now());
  try {
    if (sweepRow.fund_raw_tx && sweepRow.fund_tx_hash) {
      const fundReceipt = await getOrBroadcast(
        runtime,
        sweepRow.fund_raw_tx,
        sweepRow.fund_tx_hash,
        1,
      );
      if (!fundReceipt) return;
      await db.queryAsync(
        "UPDATE users_usdt_sweeps SET status='funded',updated_at_ms=? WHERE id=? AND status IN ('prepared','funded')",
        [now, sweepRow.id],
      );
    }

    const tokenReceipt = await getOrBroadcast(
      runtime,
      sweepRow.token_raw_tx,
      sweepRow.token_tx_hash,
      runtime.minConfirmations,
    );
    if (!tokenReceipt) return;

    await withTransaction(db, async (tx) => {
      await tx.query(
        `UPDATE users_usdt_sweeps
         SET status='confirmed',updated_at_ms=?,confirmed_at_ms=?
         WHERE id=? AND status IN ('prepared','funded','submitted')`,
        [now, now, sweepRow.id],
      );
      await tx.query(
        `UPDATE users_usdt_transfer_events
         SET swept_at_ms=?
         WHERE deposit_address=? AND swept_at_ms IS NULL
           AND status IN ('credited','pending_support')
           AND CAST(block_number AS UNSIGNED)<=?`,
        [now, walletRow.wallet_address, String(sweepRow.snapshot_block)],
      );
      await tx.query(
        "UPDATE users_usdt_deposit_wallets SET last_sweep_at_ms=?,sweep_lock_until_ms=0 WHERE id=?",
        [now, walletRow.id],
      );
    });

    console.log(
      `BSC deposit wallet ${walletRow.wallet_address} consolidated ${sweepRow.amount_raw} raw token units to treasury. tx=${sweepRow.token_tx_hash}`,
    );
  } catch (error) {
    const terminalFailure = /failed on-chain/i.test(String(error.message || error));
    await db.queryAsync(
      `UPDATE users_usdt_sweeps
       SET status=IF(?,'failed',status),attempts=attempts+1,last_error=?,updated_at_ms=?
       WHERE id=?`,
      [terminalFailure ? 1 : 0, String(error.message || error).slice(0, 2000), now, sweepRow.id],
    ).catch(() => {});
    if (terminalFailure) {
      await db.queryAsync(
        "UPDATE users_usdt_deposit_wallets SET sweep_lock_until_ms=0 WHERE id=?",
        [walletRow.id],
      ).catch(() => {});
    }
    // Keep a non-terminal signed transaction for an idempotent retry with the same nonce and hash.
    console.error(`BSC sweep ${sweepRow.id} could not finish:`, error.message);
  }
}

async function sweepWallet(db, walletRow, runtime) {
  const activeRows = await db.queryAsync(
    `SELECT id,status,fund_raw_tx,token_raw_tx,fund_tx_hash,token_tx_hash,snapshot_block,amount_raw
     FROM users_usdt_sweeps
     WHERE deposit_wallet_id=? AND status IN ('prepared','funded','submitted')
     ORDER BY id DESC LIMIT 1`,
    [walletRow.id],
  );

  let sweepRow = activeRows[0] || null;
  if (sweepRow) {
    const claimed = await claimSweepLock(db, walletRow.id);
    if (!claimed) return;
  } else {
    sweepRow = await prepareSweep(db, walletRow, runtime);
  }
  if (sweepRow) await resumeSweep(db, walletRow, sweepRow, runtime);
}

function startDepositSweeper(db) {
  if (!isEnabled()) {
    console.log("Automatic BSC deposit consolidation is disabled.");
    return { enabled: false };
  }
  if (timer) return { enabled: true };

  const runtime = getSweepRuntime();
  let sweepRunning = false;
  let networkValidated = false;

  const run = async () => {
    if (sweepRunning) return;
    sweepRunning = true;
    let releaseGlobalLock = null;
    try {
      releaseGlobalLock = await acquireGlobalSweepLock(db);
      if (!releaseGlobalLock) return;
      if (!networkValidated) {
        await validateSweepNetwork(runtime);
        networkValidated = true;
      }

      const rows = await db.queryAsync(
        `SELECT w.id,w.username,w.wallet_address,w.derivation_index,w.sweep_lock_until_ms,
                MIN(e.block_timestamp_ms) AS oldest_unswept_at_ms
         FROM users_usdt_deposit_wallets w
         JOIN users_usdt_transfer_events e ON e.deposit_address=w.wallet_address
         WHERE e.swept_at_ms IS NULL AND e.status IN ('credited','pending_support')
         GROUP BY w.id,w.username,w.wallet_address,w.derivation_index,w.sweep_lock_until_ms
         ORDER BY oldest_unswept_at_ms ASC
         LIMIT ?`,
        [runtime.batchSize],
      );

      for (const walletRow of rows) {
        try {
          await sweepWallet(db, walletRow, runtime);
        } catch (error) {
          console.error(`Automatic sweep failed for deposit wallet ${walletRow.id}:`, error.message);
          await db.queryAsync(
            "UPDATE users_usdt_deposit_wallets SET sweep_lock_until_ms=0 WHERE id=? AND sweep_lock_until_ms<?",
            [walletRow.id, String(Date.now())],
          ).catch(() => {});
        }
      }
    } catch (error) {
      console.error("BSC deposit sweeper failed:", error);
    } finally {
      if (releaseGlobalLock) {
        try {
          await releaseGlobalLock();
        } catch (error) {
          console.error("Unable to release the global BSC sweep lock:", error.message);
        }
      }
      sweepRunning = false;
      timer = setTimeout(run, runtime.intervalMs);
      if (typeof timer.unref === "function") timer.unref();
    }
  };

  void run();
  return { enabled: true };
}

module.exports = { startDepositSweeper };
