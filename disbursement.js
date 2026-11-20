"use strict";

const {
  Contract,
  Interface,
  JsonRpcProvider,
  Wallet,
  getAddress,
  keccak256,
} = require("ethers");
const BigNumber = require("bignumber.js");
const crypto = require("crypto");
const {
  calculateDisbursementReserveSettlement,
  calculateGlobalDisbursement,
} = require("./disbursement-policy");
const { getDate } = require("./utils");
const { queueTelegramMessageTx } = require("./telegram");
const {
  getLatestCommonTx,
  insertCommonSnapshotTx,
} = require("./common-accounting");
const {
  getConfiguredBnbUsdPrice,
  estimateBscTokenTransfer,
  recordEstimatedBscFeeTx,
  recordActualBscFeeTx,
} = require("./bsc-fee-accounting");
const { getBnbUsdPrice, startBnbUsdPriceOracle } = require("./bsc-price-oracle");
const { createBscFeeLimitError, getConfiguredMaxBscTxFeeUsd } = require("./bsc-transaction-policy");
const { SYSTEM_ADMIN_RESERVE_RATIO } = require("./recharge-policy");
const { calculateRemainingSystemAdminReserve } = require("./stock-accounting");
const {
  calculateRequiredAdminBonusReserve,
} = require("./global-disbursement-policy");
const { allocateBscCostFromTfees } = require("./tfees-bsc-allocation");

const INITIAL_STOCK_LIMIT = process.env.STOCK_LIMIT || "18000000";

const CHAIN_ID = 56n;
const TOKEN_DECIMALS = 18n;
const CANONICAL_BSC_USD_CONTRACT =
  "0x55d398326f99059fF775485246999027B3197955";
const TRANSFER_INTERFACE = new Interface([
  "function transfer(address to,uint256 amount) returns (bool)",
]);
const TRANSFER_EVENT_INTERFACE = new Interface([
  "event Transfer(address indexed from,address indexed to,uint256 value)",
]);
const BALANCE_INTERFACE = new Interface([
  "function balanceOf(address account) view returns (uint256)",
]);
const WORKER_LOCK_NAME = "onex_bsc_disbursement_worker";

let runtime = null;
let timer = null;
let workerRunning = false;

function requiredAddress(value, label) {
  try {
    return getAddress(String(value || "").trim());
  } catch {
    throw new Error(`${label} is not a valid EVM address.`);
  }
}

async function estimateNetBscTokenTransfer({
  provider,
  fromAddress,
  tokenAddress,
  payoutAddress,
  grossAmount,
  tokenBalanceRaw,
  maximumGasLimit,
  bnbUsdPrice,
}) {
  const gross = new BigNumber(grossAmount);
  const availableRaw = BigInt(tokenBalanceRaw);
  if (!gross.isFinite() || !gross.isGreaterThan(0) || availableRaw <= 0n) {
    throw new Error("The BSC-USD payout amount and treasury balance must be positive.");
  }
  const grossRaw = BigInt(gross.shiftedBy(18).integerValue(BigNumber.ROUND_DOWN).toFixed(0));
  let candidateRaw = availableRaw < grossRaw ? availableRaw : grossRaw;
  if (candidateRaw <= 0n) {
    throw new Error("The BSC-USD payout amount rounds to zero.");
  }

  for (let attempt = 0; attempt < 6; attempt += 1) {
    const data = TRANSFER_INTERFACE.encodeFunctionData("transfer", [payoutAddress, candidateRaw]);
    const estimate = await estimateBscTokenTransfer({
      provider,
      fromAddress,
      tokenAddress,
      data,
      maximumGasLimit,
      bnbUsdPrice,
    });
    if (!estimate.allowed) {
      throw createBscFeeLimitError(estimate.feeUsd, estimate.maximumFeeUsd);
    }

    const payoutAmount = gross.minus(estimate.feeUsd).decimalPlaces(18, BigNumber.ROUND_DOWN);
    if (!payoutAmount.isFinite() || !payoutAmount.isGreaterThan(0)) {
      return { payoutAmount, amountRaw: 0n, data: null, estimate };
    }
    const nextRaw = BigInt(payoutAmount.shiftedBy(18).integerValue(BigNumber.ROUND_DOWN).toFixed(0));
    if (nextRaw <= 0n) {
      return { payoutAmount, amountRaw: 0n, data: null, estimate };
    }
    if (availableRaw < nextRaw) {
      throw new Error("The OneX treasury has insufficient BSC-USD for the net payout amount.");
    }

    const nextData = TRANSFER_INTERFACE.encodeFunctionData("transfer", [payoutAddress, nextRaw]);
    if (nextData === data) {
      return { payoutAmount, amountRaw: nextRaw, data, estimate };
    }
    candidateRaw = nextRaw;
  }

  throw new Error("The BSC-USD payout amount and gas estimate did not converge; the queued job will be re-evaluated.");
}

function makeRuntime(forcePendingWork = false) {
  if (runtime) return runtime;

  const masterEnabled = String(process.env.USDT_DISBURSEMENTS_ENABLED || "false").toLowerCase() === "true";
  const individualEnabled = masterEnabled && String(process.env.USDT_INDIVIDUAL_DISBURSEMENT_ENABLED || "false").toLowerCase() === "true";
  const globalEnabled = masterEnabled && String(process.env.USDT_GLOBAL_DISBURSEMENT_ENABLED || "false").toLowerCase() === "true";
  const sellerPayoutsEnabled = String(process.env.USDT_SELLER_PAYOUTS_ENABLED || "false").toLowerCase() === "true";
  if (!individualEnabled && !globalEnabled && !sellerPayoutsEnabled && !forcePendingWork) return null;
  getConfiguredMaxBscTxFeeUsd();

  const privateKey = String(process.env.BSC_DISBURSEMENT_PRIVATE_KEY || "").trim();
  const rpcUrl = String(process.env.BSC_RPC_URL || "").trim();
  const tokenAddress = requiredAddress(
    process.env.USDT_BEP20_CONTRACT || CANONICAL_BSC_USD_CONTRACT,
    "BSC-USD token contract",
  );
  const treasuryAddress = requiredAddress(
    process.env.USDT_BEP20_TREASURY_ADDRESS || "",
    "OneX treasury address",
  );
  const confirmations = Number(process.env.USDT_DISBURSEMENT_CONFIRMATIONS || 15);
  const pollIntervalMs = Number(process.env.USDT_DISBURSEMENT_POLL_MS || 3000);
  const gasLimit = BigInt(process.env.USDT_DISBURSEMENT_GAS_LIMIT || "100000");

  if (!privateKey || !rpcUrl) {
    throw new Error(
      "Disbursements require BSC_DISBURSEMENT_PRIVATE_KEY and BSC_RPC_URL.",
    );
  }
  if (tokenAddress.toLowerCase() !== CANONICAL_BSC_USD_CONTRACT.toLowerCase()) {
    throw new Error("Disbursement token contract is not the approved Binance-Peg BSC-USD contract.");
  }
  if (!Number.isInteger(confirmations) || confirmations < 1 || confirmations > 200) {
    throw new Error("USDT_DISBURSEMENT_CONFIRMATIONS must be between 1 and 200.");
  }
  if (!Number.isInteger(pollIntervalMs) || pollIntervalMs < 1000 || pollIntervalMs > 60000) {
    throw new Error("USDT_DISBURSEMENT_POLL_MS must be between 1000 and 60000 milliseconds.");
  }
  if (gasLimit < 60000n || gasLimit > 200000n) {
    throw new Error("USDT_DISBURSEMENT_GAS_LIMIT must be between 60000 and 200000.");
  }

  const provider = new JsonRpcProvider(rpcUrl, 56, { staticNetwork: true });
  const signer = new Wallet(privateKey, provider);
  if (signer.address.toLowerCase() !== treasuryAddress.toLowerCase()) {
    throw new Error(
      `The disbursement signing wallet (${signer.address}) does not match USDT_BEP20_TREASURY_ADDRESS (${treasuryAddress}).`,
    );
  }

  runtime = {
    provider,
    signer,
    tokenAddress,
    treasuryAddress,
    confirmations,
    pollIntervalMs,
    gasLimit,
    token: new Contract(tokenAddress, [
      "function balanceOf(address account) view returns (uint256)",
    ], provider),
  };
  return runtime;
}

async function validateRuntime(activeRuntime) {
  const network = await activeRuntime.provider.getNetwork();
  if (BigInt(network.chainId) !== CHAIN_ID) {
    throw new Error(`Disbursement RPC is on chain ${network.chainId}; expected chain 56.`);
  }

  const code = await activeRuntime.provider.getCode(activeRuntime.tokenAddress);
  if (!code || code === "0x") {
    throw new Error("The approved BSC-USD contract is not deployed on the disbursement RPC.");
  }

  const decimalsResult = await activeRuntime.provider.call({
    to: activeRuntime.tokenAddress,
    data: "0x313ce567",
  });
  if (BigInt(decimalsResult) !== TOKEN_DECIMALS) {
    throw new Error("The approved BSC-USD token must use 18 decimals.");
  }
}

async function checkTreasuryLiquidity(amountRaw, payoutAddress) {
  const rpcUrl = String(process.env.BSC_RPC_URL || "").trim();
  const tokenAddress = requiredAddress(
    process.env.USDT_BEP20_CONTRACT || CANONICAL_BSC_USD_CONTRACT,
    "BSC-USD token contract",
  );
  const treasuryAddress = requiredAddress(
    process.env.USDT_BEP20_TREASURY_ADDRESS || "",
    "OneX treasury address",
  );
  const gasLimitCeiling = BigInt(process.env.USDT_DISBURSEMENT_GAS_LIMIT || "100000");
  const amount = BigInt(amountRaw);
  const destination = requiredAddress(payoutAddress, "BSC-USD payout address");
  if (!rpcUrl || amount <= 0n || tokenAddress.toLowerCase() !== CANONICAL_BSC_USD_CONTRACT.toLowerCase()) {
    throw new Error("Treasury liquidity check is not correctly configured.");
  }
  if (gasLimitCeiling < 60000n || gasLimitCeiling > 200000n) {
    throw new Error("USDT_DISBURSEMENT_GAS_LIMIT is outside the permitted range.");
  }

  const provider = new JsonRpcProvider(rpcUrl, 56, { staticNetwork: true });
  try {
    const network = await provider.getNetwork();
    if (BigInt(network.chainId) !== CHAIN_ID) throw new Error("Treasury RPC is not BNB Smart Chain mainnet.");
    const code = await provider.getCode(tokenAddress);
    if (!code || code === "0x") throw new Error("The approved BSC-USD contract is unavailable.");
    const token = new Contract(tokenAddress, ["function balanceOf(address account) view returns (uint256)"], provider);
    const tokenBalance = await token.balanceOf(treasuryAddress);
    const data = TRANSFER_INTERFACE.encodeFunctionData("transfer", [destination, amount]);
    const bnbUsdPrice = await getBnbUsdPrice(provider);
    const estimate = await estimateBscTokenTransfer({
      provider,
      fromAddress: treasuryAddress,
      tokenAddress,
      data,
      maximumGasLimit: gasLimitCeiling,
      bnbUsdPrice,
    });
    const bnbBalance = await provider.getBalance(treasuryAddress);
    const requiredGas = estimate.gasLimit * estimate.gasPrice;
    const tokenAvailable = tokenBalance >= amount;
    const bnbAvailable = bnbBalance >= requiredGas;
    return {
      available: tokenAvailable && bnbAvailable,
      tokenAvailable,
      bnbAvailable,
      feeWithinLimit: estimate.allowed,
      maximumFeeUsd: estimate.maximumFeeUsd.toFixed(18),
      tokenBalanceRaw: tokenBalance.toString(),
      spendableTokenBalanceRaw: tokenBalance.toString(),
      requiredTokenRaw: amount.toString(),
      bnbBalanceWei: bnbBalance.toString(),
      requiredBnbWei: requiredGas.toString(),
      gasLimit: estimate.gasLimit.toString(),
      gasPriceWei: estimate.gasPrice.toString(),
      estimatedFeeBnb: estimate.feeBnb.toFixed(30),
      estimatedFeeUsd: estimate.feeUsd.toFixed(18),
      bnbUsdPrice: estimate.bnbUsdPrice.toFixed(12),
    };
  } finally {
    await provider.destroy();
  }
}

function connectionFromPool(db) {
  return new Promise((resolve, reject) => {
    db.getConnection((error, connection) => {
      if (error) return reject(error);
      resolve(connection);
    });
  });
}

async function withTransaction(db, work) {
  const connection = await connectionFromPool(db);
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
        console.error("Disbursement rollback failed:", rollbackError.message);
      }
    }
    throw error;
  } finally {
    connection.release();
  }
}

async function acquireWorkerLock(db) {
  const connection = await connectionFromPool(db);
  const queryable = connection.promise();
  try {
    const [rows] = await queryable.query(
      "SELECT GET_LOCK(?, 0) AS acquired",
      [WORKER_LOCK_NAME],
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
        await queryable.query("SELECT RELEASE_LOCK(?)", [WORKER_LOCK_NAME]);
      } finally {
        connection.release();
      }
    };
  } catch (error) {
    connection.release();
    throw error;
  }
}

async function updateJobError(db, jobId, error) {
  const message = String(error?.message || error || "Unknown disbursement error").slice(0, 2000);
  await db.queryAsync(
    "UPDATE users_usdt_disbursements SET last_error=?,updated_at_ms=? WHERE id=? AND status IN ('queued','signed','submitted')",
    [message, String(Date.now()), jobId],
  );
}

async function signQueuedJob(db, job, activeRuntime) {
  if (job.disbursement_mode !== "global" && Number(job.reservation_expires_at_ms) <= Date.now()) {
    await markManualReview(
      db,
      job.id,
      "Reservation expired before transaction submission; administrator review is required.",
    );
    return false;
  }
  const payoutAddress = requiredAddress(job.payout_address, "Disbursement payout address");
  if (payoutAddress.toLowerCase() === activeRuntime.treasuryAddress.toLowerCase()) {
    throw new Error("The payout address cannot be the OneX treasury address.");
  }

  let amountRaw;
  let payoutAmount = new BigNumber(job.payout_amount);
  let bscFeeRecovered = new BigNumber(job.bsc_fee_recovered_usd || "0");
  let estimate;
  let data;
  const tokenBalanceRaw = await activeRuntime.token.balanceOf(activeRuntime.treasuryAddress);
  const grossBase = job.disbursement_mode === "global"
    ? new BigNumber(job.gross_initial_asset).multipliedBy(new BigNumber(job.price_value)).plus(new BigNumber(job.bonus_amount || "0"))
    : null;

  if (job.disbursement_mode === "global") {
    if (!grossBase.isFinite() || !grossBase.isGreaterThan(0)) {
      throw new Error("The global disbursement gross amount must be positive.");
    }
    const payout = await estimateNetBscTokenTransfer({
      provider: activeRuntime.provider,
      fromAddress: activeRuntime.treasuryAddress,
      tokenAddress: activeRuntime.tokenAddress,
      payoutAddress,
      grossAmount: grossBase,
      tokenBalanceRaw,
      maximumGasLimit: activeRuntime.gasLimit,
      bnbUsdPrice: getConfiguredBnbUsdPrice(),
    });
    if (!payout.payoutAmount.isGreaterThan(0) || payout.amountRaw <= 0n || !payout.data) {
      throw new Error("The global request is too small to cover the estimated BSC network fee.");
    }
    payoutAmount = payout.payoutAmount;
    amountRaw = payout.amountRaw;
    data = payout.data;
    estimate = payout.estimate;
    bscFeeRecovered = estimate.feeUsd;
  } else {
    if (!payoutAmount.isFinite() || !payoutAmount.isGreaterThan(0)) {
      throw new Error("The individual disbursement amount must be positive.");
    }
    amountRaw = BigInt(job.amount_raw);
    if (amountRaw <= 0n) throw new Error("The disbursement token amount must be positive.");
    if (tokenBalanceRaw < amountRaw) {
      throw new Error("The OneX treasury does not have enough BSC-USD for this disbursement.");
    }
    data = TRANSFER_INTERFACE.encodeFunctionData("transfer", [payoutAddress, amountRaw]);
    estimate = await estimateBscTokenTransfer({
      provider: activeRuntime.provider,
      fromAddress: activeRuntime.treasuryAddress,
      tokenAddress: activeRuntime.tokenAddress,
      data,
      maximumGasLimit: activeRuntime.gasLimit,
      bnbUsdPrice: getConfiguredBnbUsdPrice(),
    });
    if (!estimate.allowed) {
      throw createBscFeeLimitError(estimate.feeUsd, estimate.maximumFeeUsd);
    }
  }

  if (tokenBalanceRaw < amountRaw) {
    throw new Error("The OneX treasury does not have enough BSC-USD for this disbursement.");
  }
  const nativeBalance = await activeRuntime.provider.getBalance(activeRuntime.treasuryAddress);
  const requiredGasBalance = estimate.gasLimit * estimate.gasPrice;
  if (nativeBalance < requiredGasBalance) {
    throw new Error("The OneX treasury does not have enough BNB to pay the disbursement transaction fee.");
  }

  const nonce = await activeRuntime.provider.getTransactionCount(activeRuntime.treasuryAddress, "pending");
  const rawTransaction = await activeRuntime.signer.signTransaction({
    type: 0,
    chainId: Number(CHAIN_ID),
    nonce,
    to: activeRuntime.tokenAddress,
    value: 0n,
    data,
    gasLimit: estimate.gasLimit,
    gasPrice: estimate.gasPrice,
  });
  const transactionHash = keccak256(rawTransaction);
  const result = await db.queryAsync(
    `UPDATE users_usdt_disbursements
     SET raw_tx=?,tx_hash=?,nonce=?,status='signed',payout_amount=?,amount_raw=?,
         bsc_fee_recovered_usd=?,estimated_fee_bnb=?,estimated_fee_usd=?,last_error=NULL,updated_at_ms=?
     WHERE id=? AND status='queued' AND raw_tx IS NULL AND tx_hash IS NULL`,
    [
      rawTransaction, transactionHash, String(nonce), payoutAmount.toFixed(18), amountRaw.toString(),
      bscFeeRecovered.toFixed(18), estimate.feeBnb.toFixed(30), estimate.feeUsd.toFixed(18),
      String(Date.now()), job.id,
    ],
  );
  if (result.affectedRows !== 1) throw new Error("The disbursement job was claimed or updated concurrently.");

  await withTransaction(db, async (tx) => {
    await recordEstimatedBscFeeTx(tx, {
      txHash: transactionHash,
      operation: "system_disbursement",
      gasLimit: estimate.gasLimit.toString(),
      gasPriceWei: estimate.gasPrice.toString(),
      bnbUsdPrice: estimate.bnbUsdPrice,
    });
  });
  return true;
}

async function markSubmitted(db, jobId, transactionHash) {
  await db.queryAsync(
    `UPDATE users_usdt_disbursements
     SET status='submitted',tx_hash=?,last_error=NULL,updated_at_ms=?
     WHERE id=? AND status IN ('signed','submitted')`,
    [transactionHash, String(Date.now()), jobId],
  );
}

async function markManualReview(db, jobId, message, receipt = null) {
  return withTransaction(db, async (tx) => {
    const [rows] = await tx.query(
      "SELECT username,status,tx_hash,disbursement_mode,global_run_id FROM users_usdt_disbursements WHERE id=? LIMIT 1 FOR UPDATE",
      [jobId],
    );
    if (!rows.length || rows[0].status === "manual_review") return;
    const username = rows[0].username;
    if (receipt && rows[0].tx_hash) {
      const actualFee = await recordActualBscFeeTx(tx, {
        txHash: rows[0].tx_hash,
        operation: "system_disbursement",
        receipt,
      });
      await tx.query(
        "UPDATE users_usdt_disbursements SET actual_fee_bnb=?,actual_fee_usd=? WHERE id=?",
        [actualFee.feeBnb.toFixed(30), actualFee.feeUsd.toFixed(18), jobId],
      );
    }
    const now = String(Date.now());
    const [update] = await tx.query(
      `UPDATE users_usdt_disbursements
       SET status='manual_review',last_error=?,updated_at_ms=?
       WHERE id=? AND status IN ('queued','signed','submitted')`,
      [String(message).slice(0, 2000), now, jobId],
    );
    if (update.affectedRows === 1) {
      if (rows[0].disbursement_mode === "global" && rows[0].global_run_id != null) {
        await tx.query(
          `UPDATE global_disbursement_participants
           SET status='manual_review',updated_at_ms=?
           WHERE run_id=? AND username=? AND status<>'resolved'`,
          [now, String(rows[0].global_run_id), username],
        );
      }
      await queueTelegramMessageTx(
        tx,
        username,
        `disbursement:${jobId}:manual_review`,
        [
          "OneX Disbursement Update",
          "Your disbursement requires a review by OneX support.",
          `Disbursement ID: ${jobId}`,
          `Reason: ${String(message).slice(0, 500)}`,
          "Your reserved balance has not been released automatically.",
          "Status: MANUAL REVIEW",
        ].join("\n"),
      );
    }
  });
}

async function restoreUserBalanceAfterFailedPayout(db, jobId, message, receipt) {
  return withTransaction(db, async (tx) => {
    const [preRows] = await tx.query(
      "SELECT * FROM users_usdt_disbursements WHERE id=? LIMIT 1",
      [jobId],
    );
    if (preRows.length === 0) return;
    const payoutSnapshot = preRows[0];
    const username = payoutSnapshot.username;
    if (receipt && payoutSnapshot.tx_hash) {
      const actualFee = await recordActualBscFeeTx(tx, {
        txHash: payoutSnapshot.tx_hash,
        operation: "system_disbursement",
        receipt,
      });
      await tx.query(
        "UPDATE users_usdt_disbursements SET actual_fee_bnb=?,actual_fee_usd=? WHERE id=?",
        [actualFee.feeBnb.toFixed(30), actualFee.feeUsd.toFixed(18), jobId],
      );
    }

    const [authRows] = await tx.query(
      "SELECT username FROM auths WHERE username=? LIMIT 1 FOR UPDATE",
      [username],
    );
    const [stockRows] = await tx.query(
      "SELECT balance FROM users_stock WHERE username=? LIMIT 1 FOR UPDATE",
      [username],
    );
    const [jobRows] = await tx.query(
      "SELECT * FROM users_usdt_disbursements WHERE id=? LIMIT 1 FOR UPDATE",
      [jobId],
    );
    if (jobRows.length === 0) return;

    const job = jobRows[0];
    if (job.status === "failed") return;
    if (!authRows.length || !stockRows.length) {
      const reviewReason = `Cannot restore user stock after failed payout: account or stock row is missing. ${message}`;
      await tx.query(
        "UPDATE users_usdt_disbursements SET status='manual_review',last_error=?,updated_at_ms=? WHERE id=?",
        [reviewReason, String(Date.now()), jobId],
      );
      await queueTelegramMessageTx(tx, username, `disbursement:${jobId}:manual_review`, [
        "OneX Disbursement Update",
        "Your disbursement could not be restored automatically and requires support review.",
        `Disbursement ID: ${jobId}`,
        `Reason: ${reviewReason.slice(0, 500)}`,
        "Status: MANUAL REVIEW",
      ].join("\n"));
      return;
    }

    const currentBalanceInitial = new BigNumber(stockRows[0].balance);
    const expectedReservedBalance = new BigNumber(job.balance_after_reservation || "0");
    if (
      !currentBalanceInitial.isFinite() || currentBalanceInitial.isNegative() ||
      !expectedReservedBalance.isFinite() || expectedReservedBalance.isNegative() ||
      !currentBalanceInitial.eq(expectedReservedBalance)
    ) {
      const reviewReason = `Cannot safely restore reserved stock because the user balance changed. ${message}`;
      await tx.query(
        "UPDATE users_usdt_disbursements SET status='manual_review',last_error=?,updated_at_ms=? WHERE id=?",
        [reviewReason, String(Date.now()), jobId],
      );
      await queueTelegramMessageTx(tx, username, `disbursement:${jobId}:manual_review`, [
        "OneX Disbursement Update",
        "Your disbursement could not be restored automatically and requires support review.",
        `Disbursement ID: ${jobId}`,
        `Reason: ${reviewReason.slice(0, 500)}`,
        "Status: MANUAL REVIEW",
      ].join("\n"));
      return;
    }

    const [date, time] = getDate();
    await tx.query(
      "UPDATE users_stock SET balance=?,record_date=?,record_time=? WHERE username=?",
      [currentBalanceInitial.plus(job.gross_initial_asset).toFixed(30), date, time, username],
    );
    const failedAt = String(Date.now());
    await tx.query(
      `UPDATE users_usdt_disbursements
       SET status='failed',last_error=?,updated_at_ms=? WHERE id=?`,
      [String(message).slice(0, 2000), failedAt, jobId],
    );
    if (job.disbursement_mode === "global" && job.global_run_id != null) {
      const restoredBalance = currentBalanceInitial.plus(job.gross_initial_asset);
      const openRows = await tx.query(
        `SELECT status,request_deadline_at_ms,extension_deadline_at_ms FROM global_disbursement_runs WHERE id=? LIMIT 1 FOR UPDATE`,
        [job.global_run_id],
      );
      const run = openRows[0]?.[0] || null;
      const canRetry = run && run.status === "active" && Number(run.extension_deadline_at_ms || run.request_deadline_at_ms) > Date.now();
      await tx.query(
        `UPDATE global_disbursement_runs
         SET admin_bonus_committed_initial_asset=GREATEST(0,admin_bonus_committed_initial_asset-?),
             total_requested_initial_asset=GREATEST(0,total_requested_initial_asset-?),updated_at_ms=?
         WHERE id=?`,
        [String(job.bonus_initial_asset || "0"), String(job.gross_initial_asset), failedAt, job.global_run_id],
      );
      await tx.query(
        `UPDATE global_disbursement_participants
         SET requested_initial_asset=GREATEST(0,requested_initial_asset-?),
             remaining_initial_asset=?,status=?,updated_at_ms=?
         WHERE run_id=? AND username=?`,
        [String(job.gross_initial_asset), restoredBalance.toFixed(30), canRetry ? "awaiting_request" : "manual_review",
          failedAt, job.global_run_id, username],
      );
    }
    await queueTelegramMessageTx(tx, username, `disbursement:${jobId}:failed`, [
      "OneX Disbursement Update",
      "Your disbursement transaction failed after blockchain finality. Your reserved XTU balance has been restored.",
      `Disbursement ID: ${jobId}`,
      `Reason: ${String(message).slice(0, 500)}`,
      "Status: FAILED - BALANCE RESTORED",
    ].join("\n"));
  });
}

async function finalizeSuccessfulPayout(db, jobId, receipt) {
  return withTransaction(db, async (tx) => {
    const [preRows] = await tx.query(
      "SELECT username FROM users_usdt_disbursements WHERE id=? LIMIT 1",
      [jobId],
    );
    if (preRows.length === 0) throw new Error(`Disbursement ${jobId} does not exist.`);
    const username = preRows[0].username;

    // Serialize global accounting first, then lock account and stock rows in request-path order.
    const [commonLockRows] = await tx.query(
      "SELECT lock_name FROM system_locks WHERE lock_name='common_state' FOR UPDATE",
    );
    if (!commonLockRows.length) throw new Error("The common-state lock row is missing.");
    const common = await getLatestCommonTx(tx, true);

    const [authRows] = await tx.query(
      "SELECT username FROM auths WHERE username=? LIMIT 1 FOR UPDATE",
      [username],
    );
    const [userStockRows] = await tx.query(
      "SELECT balance FROM users_stock WHERE username=? LIMIT 1 FOR UPDATE",
      [username],
    );
    const [jobRows] = await tx.query(
      "SELECT * FROM users_usdt_disbursements WHERE id=? LIMIT 1 FOR UPDATE",
      [jobId],
    );
    if (jobRows.length === 0) throw new Error(`Disbursement ${jobId} disappeared.`);
    const job = jobRows[0];
    if (job.status === "confirmed") return { confirmed: true };
    const actualFee = await recordActualBscFeeTx(tx, {
      txHash: job.tx_hash,
      operation: "system_disbursement",
      receipt,
    });
    await tx.query(
      "UPDATE users_usdt_disbursements SET actual_fee_bnb=?,actual_fee_usd=? WHERE id=?",
      [actualFee.feeBnb.toFixed(30), actualFee.feeUsd.toFixed(18), jobId],
    );

    if (!authRows.length || !userStockRows.length) {
      const reviewReason = "The payout was confirmed on-chain, but the OneX account or stock row is missing.";
      await tx.query(
        `UPDATE users_usdt_disbursements SET status='manual_review',last_error=?,updated_at_ms=? WHERE id=?`,
        [reviewReason, String(Date.now()), jobId],
      );
      await queueTelegramMessageTx(tx, username, `disbursement:${jobId}:manual_review`, [
        "OneX Disbursement Update",
        "Your BSC-USD payout was confirmed, but OneX accounting requires manual review.",
        `Disbursement ID: ${jobId}`,
        `Reason: ${reviewReason}`,
        "Status: MANUAL REVIEW",
      ].join("\n"));
      return { manualReview: true };
    }

    const userBalanceInitial = new BigNumber(userStockRows[0].balance);
    const expectedReservedBalance = new BigNumber(job.balance_after_reservation || "0");
    if (!userBalanceInitial.isFinite() || !userBalanceInitial.eq(expectedReservedBalance)) {
      const reviewReason = "The payout was confirmed on-chain, but the user's remaining balance changed before accounting finalization.";
      await tx.query(
        `UPDATE users_usdt_disbursements SET status='manual_review',last_error=?,updated_at_ms=? WHERE id=?`,
        [reviewReason, String(Date.now()), jobId],
      );
      await queueTelegramMessageTx(tx, username, `disbursement:${jobId}:manual_review`, [
        "OneX Disbursement Update",
        "Your BSC-USD payout was confirmed, but OneX accounting requires manual review.",
        `Disbursement ID: ${jobId}`,
        `Reason: ${reviewReason}`,
        "Status: MANUAL REVIEW",
      ].join("\n"));
      return { manualReview: true };
    }

    const [systemRows] = await tx.query(
      "SELECT balance FROM users_stock WHERE username='ONEX' LIMIT 1 FOR UPDATE",
    );
    if (systemRows.length === 0) throw new Error("The OneX system stock row is missing.");

    const total = new BigNumber(common.total_units_price);
    const unitPrice = new BigNumber(common.unit_price);
    const backed = new BigNumber(common.backed_units);
    const inactive = new BigNumber(common.inactive_init_asset);
    const payoutAmount = new BigNumber(job.payout_amount);
    // Every treasury transfer consumes both the BSC-USD sent to the user and
    // the actual BNB gas paid for the transaction. For individual sales the
    // gas is covered from gross tfees; for global payouts it was estimated and
    // deducted from the token amount before submission. In both cases, the
    // confirmed receipt cost must be included in common stock-value accounting.
    const reserveExpenseAmount = payoutAmount.plus(actualFee.feeUsd);
    const soldInitialAssets = new BigNumber(job.sold_initial_asset);
    const grossInitialAsset = new BigNumber(job.gross_initial_asset);
    const priceValue = new BigNumber(job.price_value);
    const feeInitialAssets = new BigNumber(job.fee_initial_asset);
    const grossBalance = grossInitialAsset.multipliedBy(priceValue);
    const isGlobalDisbursement = job.disbursement_mode === "global";
    const bscFeeRecovered = new BigNumber(job.bsc_fee_recovered_usd || "0");
    const bonusAmount = new BigNumber(job.bonus_amount || "0");
    const bonusInitialAssets = new BigNumber(job.bonus_initial_asset || "0");
    const expectedPayoutAmount = (isGlobalDisbursement
      ? grossBalance.plus(bonusAmount).minus(bscFeeRecovered)
      : soldInitialAssets.multipliedBy(priceValue))
      .decimalPlaces(18, BigNumber.ROUND_DOWN);
    const expectedFeeAmount = isGlobalDisbursement
      ? new BigNumber(0)
      : feeInitialAssets.multipliedBy(priceValue).decimalPlaces(18, BigNumber.ROUND_DOWN);
    const actualBscFeeUsd = new BigNumber(actualFee.feeUsd);
    const feeAllocation = isGlobalDisbursement
      ? { coveredBscCost: new BigNumber(0), uncoveredBscCost: new BigNumber(0), retainedTfees: new BigNumber(0) }
      : allocateBscCostFromTfees(expectedFeeAmount, actualBscFeeUsd);
    const tfeesCoveredBscUsd = feeAllocation.coveredBscCost;
    const tfeesUncoveredBscUsd = feeAllocation.uncoveredBscCost;
    const netFeeInitialAssets = isGlobalDisbursement
      ? new BigNumber(0)
      : feeAllocation.retainedTfees.dividedBy(priceValue);
    const lockedAmountsTolerance = new BigNumber("0.000000000000000001");
    const grossInitialAssetMismatch = grossInitialAsset.minus(soldInitialAssets.plus(feeInitialAssets)).abs();
    const payoutAmountMismatch = payoutAmount.minus(expectedPayoutAmount).abs();
    const feeAmountMismatch = new BigNumber(job.fee_amount).minus(expectedFeeAmount).abs();

    if (
      !total.isFinite() || !total.isGreaterThanOrEqualTo(reserveExpenseAmount) ||
      !unitPrice.isFinite() || !unitPrice.isGreaterThan(0) ||
      !backed.isFinite() || backed.isNegative() ||
      !inactive.isFinite() || inactive.isNegative() ||
      !payoutAmount.isFinite() || !payoutAmount.isGreaterThan(0) ||
      !soldInitialAssets.isFinite() || !soldInitialAssets.isGreaterThan(0) ||
      !grossInitialAsset.isFinite() || !grossInitialAsset.isGreaterThan(0) ||
      !grossBalance.isFinite() || !grossBalance.isGreaterThan(0) ||
      !priceValue.isFinite() || !priceValue.isGreaterThan(0) ||
      !feeInitialAssets.isFinite() || feeInitialAssets.isNegative() ||
      !bscFeeRecovered.isFinite() || bscFeeRecovered.isNegative() ||
      !bonusAmount.isFinite() || bonusAmount.isNegative() ||
      !bonusInitialAssets.isFinite() || bonusInitialAssets.isNegative() ||
      !actualBscFeeUsd.isFinite() || actualBscFeeUsd.isNegative() ||
      (isGlobalDisbursement && (!feeInitialAssets.isZero() || !new BigNumber(job.fee_amount).isZero())) ||
      (!isGlobalDisbursement && (!bonusAmount.isZero() || !bonusInitialAssets.isZero())) ||
      new BigNumber(job.bsc_fee_recovered_usd || "0").isNegative() ||
      !new BigNumber(job.fee_amount).isFinite() || new BigNumber(job.fee_amount).isNegative() ||
      grossInitialAssetMismatch.gt(lockedAmountsTolerance) ||
      payoutAmountMismatch.gt(lockedAmountsTolerance) ||
      feeAmountMismatch.gt(lockedAmountsTolerance)
    ) {
      await tx.query(
        `UPDATE users_usdt_disbursements SET status='manual_review',last_error=?,updated_at_ms=? WHERE id=?`,
        ["The payout was confirmed on-chain, but the common reserve values are inconsistent.", String(Date.now()), jobId],
      );
      return { manualReview: true };
    }

    const systemBalanceInitial = new BigNumber(systemRows[0].balance);
    const newSystemBalanceInitial = systemBalanceInitial.plus(grossInitialAsset);
    const reserveSettlement = calculateDisbursementReserveSettlement(
      total,
      backed,
      inactive,
      {
        payoutAmount,
        reserveExpenseAmount,
        soldInitialAsset: soldInitialAssets,
        feeInitialAsset: isGlobalDisbursement ? new BigNumber(0) : netFeeInitialAssets,
        bonusInitialAsset: isGlobalDisbursement ? bonusInitialAssets : new BigNumber(0),
      },
      common.sys_inactive_init_asset || "0",
    );
    if (isGlobalDisbursement) {
      const remainingAdminReserve = calculateRemainingSystemAdminReserve(
        INITIAL_STOCK_LIMIT,
        SYSTEM_ADMIN_RESERVE_RATIO,
        common.sys_inactive_init_asset || "0",
      ).remainingInitialAsset;
      if (bonusInitialAssets.gt(remainingAdminReserve)) {
        throw new Error("Global bonus exceeds the remaining protected administrative reserve");
      }
    }
    const newTotal = reserveSettlement.newTotalUnitsPrice;
    const newInactive = reserveSettlement.newInactiveInitAsset;
    const newBacked = reserveSettlement.newBackedUnits;
    if (
      !systemBalanceInitial.isFinite() || systemBalanceInitial.isNegative() ||
      !newSystemBalanceInitial.isFinite() || newSystemBalanceInitial.isNegative() ||
      !newTotal.isFinite() || newTotal.isNegative() ||
      !newInactive.isFinite() || newInactive.isNegative() ||
      !newBacked.isFinite() || newBacked.isNegative()
    ) {
      throw new Error("Invalid accounting values while finalizing a disbursement.");
    }

    const [date, time] = getDate();
    await tx.query(
      "UPDATE users_stock SET balance=?,record_date=?,record_time=? WHERE username='ONEX'",
      [newSystemBalanceInitial.toFixed(30), date, time],
    );
    const totalTfees = new BigNumber(common.total_tfees || "0").plus(
      isGlobalDisbursement ? 0 : netFeeInitialAssets,
    );
    const totalTfeesBscCost = new BigNumber(common.total_tfees_bsc_cost_usd || "0").plus(tfeesCoveredBscUsd);
    const totalTfeesBscUncovered = new BigNumber(common.total_tfees_bsc_uncovered_usd || "0").plus(tfeesUncoveredBscUsd);
    await insertCommonSnapshotTx(tx, common, {
      total_units_price: newTotal.toFixed(),
      backed_units: newBacked.toFixed(),
      inactive_init_asset: newInactive.toFixed(),
      sys_inactive_init_asset: reserveSettlement.newSysInactiveInitAsset.toFixed(),
      total_tfees: totalTfees.toFixed(),
      total_tfees_bsc_cost_usd: totalTfeesBscCost.toFixed(),
      total_tfees_bsc_uncovered_usd: totalTfeesBscUncovered.toFixed(),
    }, date, time);

    const [existingActivityRows] = await tx.query(
      "SELECT id FROM activities WHERE reference=? LIMIT 1",
      [job.reference],
    );
    if (existingActivityRows.length === 0) {
      await tx.query(
        `INSERT INTO activities(sender,receiver,type,amount,unit_price,fees,bsc_fee_cost_usd,reference,record_date,record_time)
         VALUES(?,?,?,?,?,?,?,?,?,?)`,
        [username, "ONEX", 3, soldInitialAssets.toFixed(), priceValue.toFixed(), feeInitialAssets.toFixed(), actualBscFeeUsd.toFixed(18), job.reference, date, time],
      );
    }

    const confirmedAt = String(Date.now());
    await tx.query(
      `UPDATE users_usdt_disbursements
       SET status='confirmed',block_number=?,last_error=NULL,confirmed_at_ms=?,updated_at_ms=?
       WHERE id=?`,
      [String(receipt.blockNumber), confirmedAt, confirmedAt, jobId],
    );
    if (job.disbursement_mode === "global" && job.global_run_id != null) {
      const [globalRows] = await tx.query(
        "SELECT status,request_deadline_at_ms,extension_deadline_at_ms FROM global_disbursement_runs WHERE id=? LIMIT 1 FOR UPDATE",
        [job.global_run_id],
      );
      const globalRun = globalRows[0] || null;
      if (!globalRun) throw new Error("The global disbursement run for this confirmed payment is missing.");
      const remainingInitial = new BigNumber(job.balance_after_reservation || "0");
      const participantStatus = remainingInitial.isZero()
        ? "paid"
        : (globalRun.status === "active" && Number(globalRun.extension_deadline_at_ms || globalRun.request_deadline_at_ms) > Date.now()
          ? "awaiting_request" : "manual_review");
      await tx.query(
        `UPDATE global_disbursement_participants
         SET paid_initial_asset=paid_initial_asset+?,remaining_initial_asset=?,status=?,updated_at_ms=?
         WHERE run_id=? AND username=? AND status<>'resolved'`,
        [String(job.sold_initial_asset), remainingInitial.toFixed(30), participantStatus,
          confirmedAt, job.global_run_id, username],
      );
      await tx.query(
        `UPDATE global_disbursement_runs
         SET total_paid_bsc_usd=total_paid_bsc_usd+?,
             total_bonus_paid_bsc_usd=total_bonus_paid_bsc_usd+?,
             total_bonus_paid_initial_asset=total_bonus_paid_initial_asset+?,
             total_bsc_gas_actual_usd=total_bsc_gas_actual_usd+?,
             updated_at_ms=?
         WHERE id=? AND status IN ('active','closed','manual_review')`,
        [payoutAmount.toFixed(18), bonusAmount.toFixed(18), bonusInitialAssets.toFixed(30), actualFee.feeUsd.toFixed(18), confirmedAt, job.global_run_id],
      );
    }
    await queueTelegramMessageTx(tx, username, `disbursement:${jobId}:confirmed`, [
      "OneX Disbursement Update",
      "Your sale to OneX has been completed and the BSC-USD payment is confirmed.",
      `Actual BSC gas cost: ${actualFee.feeBnb.toFixed(8)} BNB (${actualFee.feeUsd.toFixed(8)} BSC-USD).`,
      `Gross amount: ${grossBalance.toFixed(8)} XTU`,
      `Fees: ${isGlobalDisbursement ? "0" : feeInitialAssets.multipliedBy(priceValue).toFixed(8)} XTU`,
      ...(isGlobalDisbursement ? [`Automatic global bonus: ${bonusAmount.toFixed(8)} BSC-USD`] : [`BSC fee allocated from tfees: ${tfeesCoveredBscUsd.toFixed(8)} BSC-USD`, `Net tfees retained: ${netFeeInitialAssets.multipliedBy(priceValue).toFixed(8)} XTU`]),
      `Valuation price locked at request submission: ${priceValue.toFixed(12)} XTU per initial asset`,
      `Amount paid: ${payoutAmount.toFixed(8)} BSC-USD`,
      `Destination: ${job.payout_address}`,
      `Transaction: ${job.tx_hash}`,
      "Status: CONFIRMED",
    ].join("\n"));
    return { confirmed: true };
  });
}

function receiptConfirmsExpectedTransfer(receipt, job, activeRuntime) {
  const expectedAmount = BigInt(job.amount_raw);
  const expectedTo = String(job.payout_address).toLowerCase();
  const expectedFrom = activeRuntime.treasuryAddress.toLowerCase();
  const expectedContract = activeRuntime.tokenAddress.toLowerCase();

  for (const log of receipt.logs || []) {
    if (String(log.address || "").toLowerCase() !== expectedContract) continue;
    try {
      const parsed = TRANSFER_EVENT_INTERFACE.parseLog({
        topics: log.topics,
        data: log.data,
      });
      if (
        parsed &&
        String(parsed.args.from).toLowerCase() === expectedFrom &&
        String(parsed.args.to).toLowerCase() === expectedTo &&
        BigInt(parsed.args.value) === expectedAmount
      ) {
        return true;
      }
    } catch {
      // Ignore unrelated or malformed logs from the same transaction.
    }
  }
  return false;
}

async function processOneJob(db, job, activeRuntime) {
  if (job.status === "queued") {
    try {
      await signQueuedJob(db, job, activeRuntime);
    } catch (error) {
      const message = String(error?.message || error);
      if (job.disbursement_mode === "global" && /too small to cover the estimated BSC network fee|rounds to zero after BSC gas recovery/i.test(message)) {
        await markManualReview(db, job.id, `${message} The reserved request remains pending for administrative resolution.`);
      } else {
        await updateJobError(db, job.id, error);
      }
      return;
    }
    const freshRows = await db.queryAsync(
      "SELECT * FROM users_usdt_disbursements WHERE id=? LIMIT 1",
      [job.id],
    );
    if (freshRows.length === 0) {
      throw new Error(`Disbursement ${job.id} disappeared after signing.`);
    }
    job = freshRows[0];
  }

  if (!job.raw_tx || !job.tx_hash) {
    await updateJobError(db, job.id, new Error("The signed payout transaction is missing."));
    return;
  }

  let receipt = await activeRuntime.provider.getTransactionReceipt(job.tx_hash);
  if (!receipt) {
    const knownTransaction = await activeRuntime.provider.getTransaction(job.tx_hash);
    if (!knownTransaction) {
      try {
        const broadcast = await activeRuntime.provider.broadcastTransaction(job.raw_tx);
        if (broadcast.hash.toLowerCase() !== job.tx_hash.toLowerCase()) {
          throw new Error("The broadcast transaction hash does not match the persisted signed transaction.");
        }
      } catch (error) {
        const afterError = await activeRuntime.provider.getTransaction(job.tx_hash);
        if (!afterError) {
          await updateJobError(db, job.id, error);
          return;
        }
      }
    }
    await markSubmitted(db, job.id, job.tx_hash);
    receipt = await activeRuntime.provider.getTransactionReceipt(job.tx_hash);
    if (!receipt) return;
  }

  if (Number(receipt.status) !== 1) {
    const failedCanonicalBlock = await activeRuntime.provider.getBlock(receipt.blockNumber);
    if (
      !failedCanonicalBlock ||
      String(failedCanonicalBlock.hash || "").toLowerCase() !== String(receipt.blockHash || "").toLowerCase()
    ) {
      await markSubmitted(db, job.id, job.tx_hash);
      return;
    }
    const failedLatestBlock = await activeRuntime.provider.getBlockNumber();
    const failedConfirmations = failedLatestBlock - Number(receipt.blockNumber) + 1;
    if (failedConfirmations < activeRuntime.confirmations) {
      await markSubmitted(db, job.id, job.tx_hash);
      return;
    }
    await restoreUserBalanceAfterFailedPayout(
      db,
      job.id,
      "The BSC-USD transfer transaction was mined, remained canonical and failed after the configured finality depth.",
      receipt,
    );
    return;
  }

  if (!receiptConfirmsExpectedTransfer(receipt, job, activeRuntime)) {
    await markManualReview(
      db,
      job.id,
      "The transaction succeeded on-chain but its receipt does not contain the expected BSC-USD Transfer event.",
      receipt,
    );
    return;
  }

  const canonicalBlock = await activeRuntime.provider.getBlock(receipt.blockNumber);
  if (
    !canonicalBlock ||
    String(canonicalBlock.hash || "").toLowerCase() !== String(receipt.blockHash || "").toLowerCase()
  ) {
    await markSubmitted(db, job.id, job.tx_hash);
    return;
  }

  const latestBlock = await activeRuntime.provider.getBlockNumber();
  const confirmations = latestBlock - Number(receipt.blockNumber) + 1;
  if (confirmations < activeRuntime.confirmations) {
    await markSubmitted(db, job.id, job.tx_hash);
    return;
  }

  await finalizeSuccessfulPayout(db, job.id, receipt);
}


async function signQueuedSellerPayout(db, job, activeRuntime) {
  const payoutAddress = requiredAddress(job.payout_address, "Seller payout address");
  if (payoutAddress.toLowerCase() === activeRuntime.treasuryAddress.toLowerCase()) {
    throw new Error("A seller payout cannot be sent to the OneX treasury address.");
  }
  const gross = new BigNumber(job.gross_amount);
  if (!gross.isFinite() || !gross.isGreaterThan(0)) throw new Error("Invalid seller payout gross amount.");

  const bnbUsdPrice = getConfiguredBnbUsdPrice();
  if (!bnbUsdPrice.isGreaterThan(0)) {
    throw new Error("A fresh Chainlink BNB/USD price is required to recover the seller's BSC gas cost.");
  }
  const tokenBalance = await activeRuntime.token.balanceOf(activeRuntime.treasuryAddress);
  const payout = await estimateNetBscTokenTransfer({
    provider: activeRuntime.provider,
    fromAddress: activeRuntime.treasuryAddress,
    tokenAddress: activeRuntime.tokenAddress,
    payoutAddress,
    grossAmount: gross,
    tokenBalanceRaw: tokenBalance,
    maximumGasLimit: activeRuntime.gasLimit,
    bnbUsdPrice,
  });
  const { payoutAmount, amountRaw, data, estimate: finalEstimate } = payout;
  if (!payoutAmount.isGreaterThan(0) || amountRaw <= 0n || !data) {
    throw new Error("Seller payout is too small after BSC gas recovery.");
  }
  const nativeBalance = await activeRuntime.provider.getBalance(activeRuntime.treasuryAddress);
  if (nativeBalance < finalEstimate.gasLimit * finalEstimate.gasPrice) {
    throw new Error("The OneX treasury has insufficient BNB for the seller payout gas.");
  }

  const nonce = await activeRuntime.provider.getTransactionCount(activeRuntime.treasuryAddress, "pending");
  const rawTransaction = await activeRuntime.signer.signTransaction({
    type: 0,
    chainId: Number(CHAIN_ID),
    nonce,
    to: activeRuntime.tokenAddress,
    value: 0n,
    data,
    gasLimit: finalEstimate.gasLimit,
    gasPrice: finalEstimate.gasPrice,
  });
  const transactionHash = keccak256(rawTransaction);
  const update = await db.queryAsync(
    `UPDATE users_usdt_seller_payouts
     SET raw_tx=?,tx_hash=?,nonce=?,gas_fee_estimated=?,payout_amount=?,amount_raw=?,bnb_usd_price=?,
         status='signed',last_error=NULL,updated_at_ms=?
     WHERE id=? AND status='queued' AND raw_tx IS NULL AND tx_hash IS NULL`,
    [
      rawTransaction,
      transactionHash,
      String(nonce),
      finalEstimate.feeUsd.toFixed(18),
      payoutAmount.toFixed(18),
      amountRaw.toString(),
      bnbUsdPrice.toFixed(12),
      String(Date.now()),
      job.id,
    ],
  );
  if (update.affectedRows !== 1) return false;

  await withTransaction(db, async (tx) => {
    await recordEstimatedBscFeeTx(tx, {
      txHash: transactionHash,
      operation: "seller_payout",
      gasLimit: finalEstimate.gasLimit.toString(),
      gasPriceWei: finalEstimate.gasPrice.toString(),
      bnbUsdPrice,
    });
  });
  return true;
}

async function finalizeSellerPayout(db, jobId, receipt, activeRuntime) {
  return withTransaction(db, async (tx) => {
    const [payoutRows] = await tx.query(
      "SELECT * FROM users_usdt_seller_payouts WHERE id=? LIMIT 1 FOR UPDATE",
      [jobId],
    );
    if (!payoutRows.length) throw new Error(`Seller payout ${jobId} does not exist.`);
    const payout = payoutRows[0];
    if (payout.status === "confirmed") return { confirmed: true };

    const actualFee = await recordActualBscFeeTx(tx, {
      txHash: payout.tx_hash,
      operation: "seller_payout",
      receipt,
    });

    if (Number(receipt.status) !== 1 || !receiptConfirmsExpectedTransfer(receipt, {
      amount_raw: payout.amount_raw,
      payout_address: payout.payout_address,
    }, activeRuntime)) {
      const reason = Number(receipt.status) !== 1
        ? "The seller payout transaction was finalized but reverted on BNB Smart Chain."
        : "The seller payout transaction succeeded but did not contain the expected BSC-USD Transfer event.";
      await tx.query(
        "UPDATE users_usdt_seller_payouts SET status='manual_review',last_error=?,block_number=?,updated_at_ms=? WHERE id=?",
        [reason, String(receipt.blockNumber), String(Date.now()), jobId],
      );
      await tx.query(
        "UPDATE users_usdt_seller_payout_batches SET status='manual_review',updated_at_ms=? WHERE id=?",
        [String(Date.now()), payout.batch_id],
      );
      await queueTelegramMessageTx(tx, payout.username, `seller-payout:${jobId}:manual_review`, [
        "OneX Seller Update",
        "Your seller payout requires a support review after the BSC transaction reached finality.",
        `Payout ID: ${jobId}`,
        `Actual BSC gas cost: ${actualFee.feeBnb.toFixed(8)} BNB (${actualFee.feeUsd.toFixed(8)} BSC-USD)`,
        `Reason: ${reason}`,
        "The reserved seller amount remains pending and has not been marked as paid.",
        "Status: MANUAL REVIEW",
      ].join("\n"));
      return { manualReview: true };
    }

    const [allocations] = await tx.query(
      `SELECT a.id,a.lot_id,a.initial_asset_amount,l.payout_pending_initial_asset,
              l.payout_reserved_initial_asset,l.paid_initial_asset
       FROM users_seller_payout_allocations a
       JOIN users_seller_reserve_lots l ON l.id=a.lot_id
       WHERE a.payout_id=? AND a.status='reserved'
       ORDER BY l.activated_at_ms ASC,l.id ASC
       FOR UPDATE`,
      [jobId],
    );
    if (!allocations.length) throw new Error(`Seller payout ${jobId} has no reserved lot allocations.`);
    for (const allocation of allocations) {
      const amount = new BigNumber(allocation.initial_asset_amount);
      const pending = new BigNumber(allocation.payout_pending_initial_asset);
      const reserved = new BigNumber(allocation.payout_reserved_initial_asset);
      const paid = new BigNumber(allocation.paid_initial_asset);
      if (
        !amount.isFinite() || !amount.isGreaterThan(0) ||
        pending.isLessThan(amount) || reserved.isLessThan(amount)
      ) {
        throw new Error(`Seller payout allocation ${allocation.id} exceeds its lot liability.`);
      }
      await tx.query(
        `UPDATE users_seller_reserve_lots
         SET payout_pending_initial_asset=?,payout_reserved_initial_asset=?,paid_initial_asset=?,updated_at_ms=? WHERE id=?`,
        [pending.minus(amount).toFixed(), reserved.minus(amount).toFixed(), paid.plus(amount).toFixed(), String(Date.now()), allocation.lot_id],
      );
      await tx.query(
        "UPDATE users_seller_payout_allocations SET status='paid' WHERE id=? AND status='reserved'",
        [allocation.id],
      );
    }

    const now = String(Date.now());
    await tx.query(
      `UPDATE users_usdt_seller_payouts
       SET status='confirmed',block_number=?,actual_fee_bnb=?,actual_fee_usd=?,last_error=NULL,confirmed_at_ms=?,updated_at_ms=?
       WHERE id=?`,
      [String(receipt.blockNumber), actualFee.feeBnb.toFixed(30), actualFee.feeUsd.toFixed(18), now, now, jobId],
    );
    const [openRows] = await tx.query(
      "SELECT id FROM users_usdt_seller_payouts WHERE batch_id=? AND status<>'confirmed' LIMIT 1 FOR UPDATE",
      [payout.batch_id],
    );
    if (!openRows.length) {
      await tx.query(
        "UPDATE users_usdt_seller_payout_batches SET status='completed',completed_at_ms=?,updated_at_ms=? WHERE id=?",
        [now, now, payout.batch_id],
      );
    } else {
      await tx.query(
        "UPDATE users_usdt_seller_payout_batches SET status='processing',updated_at_ms=? WHERE id=?",
        [now, payout.batch_id],
      );
    }
    await queueTelegramMessageTx(tx, payout.username, `seller-payout:${jobId}:confirmed`, [
      "OneX Seller Update",
      "Your seller reserve payout has been transferred successfully.",
      `Gross amount: ${new BigNumber(payout.gross_amount).toFixed(8)} BSC-USD`,
      `BSC gas recovery: ${new BigNumber(payout.gas_fee_estimated).toFixed(8)} BSC-USD`,
      `Net amount paid: ${new BigNumber(payout.payout_amount).toFixed(8)} BSC-USD`,
      `Actual gas cost: ${actualFee.feeBnb.toFixed(8)} BNB (${actualFee.feeUsd.toFixed(8)} BSC-USD)`,
      `Destination: ${payout.payout_address}`,
      `Transaction: ${payout.tx_hash}`,
      `Payout ID: ${jobId}`,
      "Status: CONFIRMED",
    ].join("\n"));
    return { confirmed: true };
  });
}

async function processOneSellerPayout(db, job, activeRuntime) {
  if (job.status === "queued") {
    try {
      await signQueuedSellerPayout(db, job, activeRuntime);
    } catch (error) {
      await db.queryAsync(
        "UPDATE users_usdt_seller_payouts SET last_error=?,updated_at_ms=? WHERE id=? AND status='queued'",
        [String(error.message || error).slice(0, 2000), String(Date.now()), job.id],
      );
      return;
    }
    const freshRows = await db.queryAsync("SELECT * FROM users_usdt_seller_payouts WHERE id=? LIMIT 1", [job.id]);
    if (!freshRows.length) return;
    job = freshRows[0];
  }
  if (!job.raw_tx || !job.tx_hash) return;

  let receipt = await activeRuntime.provider.getTransactionReceipt(job.tx_hash);
  if (!receipt) {
    const known = await activeRuntime.provider.getTransaction(job.tx_hash);
    if (!known) {
      try {
        const broadcast = await activeRuntime.provider.broadcastTransaction(job.raw_tx);
        if (broadcast.hash.toLowerCase() !== job.tx_hash.toLowerCase()) {
          throw new Error("Seller payout broadcast hash differs from the persisted transaction hash.");
        }
      } catch (error) {
        const afterError = await activeRuntime.provider.getTransaction(job.tx_hash);
        if (!afterError) {
          await db.queryAsync(
            "UPDATE users_usdt_seller_payouts SET last_error=?,updated_at_ms=? WHERE id=? AND status IN ('signed','submitted')",
            [String(error.message || error).slice(0, 2000), String(Date.now()), job.id],
          );
          return;
        }
      }
    }
    await db.queryAsync(
      "UPDATE users_usdt_seller_payouts SET status='submitted',last_error=NULL,updated_at_ms=? WHERE id=? AND status IN ('signed','submitted')",
      [String(Date.now()), job.id],
    );
    receipt = await activeRuntime.provider.getTransactionReceipt(job.tx_hash);
    if (!receipt) return;
  }
  const canonicalBlock = await activeRuntime.provider.getBlock(receipt.blockNumber);
  const latestBlock = await activeRuntime.provider.getBlockNumber();
  const confirmations = latestBlock - Number(receipt.blockNumber) + 1;
  if (!canonicalBlock || String(canonicalBlock.hash || "").toLowerCase() !== String(receipt.blockHash || "").toLowerCase() || confirmations < activeRuntime.confirmations) {
    return;
  }
  await finalizeSellerPayout(db, job.id, receipt, activeRuntime);
}

async function markRefundError(db, refundId, error) {
  await db.queryAsync(
    `UPDATE users_usdt_refunds
     SET last_error=?,updated_at_ms=?
     WHERE id=? AND status IN ('queued','signed','submitted')`,
    [String(error?.message || error || "Unknown refund error").slice(0, 2000), String(Date.now()), refundId],
  );
}

async function finalizeRefund(db, refundId, receipt) {
  return withTransaction(db, async (tx) => {
    const [preRows] = await tx.query(
      "SELECT batch_id,unknown_transfer_id FROM users_usdt_refunds WHERE id=? LIMIT 1", [refundId],
    );
    if (!preRows.length) throw new Error(`Refund ${refundId} does not exist.`);
    const batchId = preRows[0].batch_id;
    const unknownTransferId = preRows[0].unknown_transfer_id;
    const [batchRows] = batchId == null ? [[]] : await tx.query(
      "SELECT id,status FROM users_usdt_deposit_batches WHERE id=? LIMIT 1 FOR UPDATE", [batchId],
    );
    const [unknownRows] = unknownTransferId == null ? [[]] : await tx.query(
      "SELECT id,status FROM bsc_unknown_incoming_transfers WHERE id=? LIMIT 1 FOR UPDATE", [unknownTransferId],
    );
    const [refundRows] = await tx.query(
      "SELECT * FROM users_usdt_refunds WHERE id=? LIMIT 1 FOR UPDATE", [refundId],
    );
    if (!refundRows.length) throw new Error(`Refund ${refundId} disappeared.`);
    const refund = refundRows[0];
    if (refund.status === "confirmed") return { confirmed: true };
    const actualFee = await recordActualBscFeeTx(tx, {
      txHash: refund.tx_hash,
      operation: "refund",
      receipt,
    });
    await tx.query(
      "UPDATE users_usdt_refunds SET actual_fee_bnb=?,actual_fee_usd=? WHERE id=?",
      [actualFee.feeBnb.toFixed(30), actualFee.feeUsd.toFixed(18), refundId],
    );
    const sourceIsQueued = batchId != null
      ? batchRows.length > 0 && batchRows[0].status === "refund_queued"
      : unknownRows.length > 0 && unknownRows[0].status === "refund_queued";
    if (!sourceIsQueued) {
      const reviewReason = "The refund was confirmed on-chain but its source payment is not in refund_queued state.";
      await tx.query(
        "UPDATE users_usdt_refunds SET status='manual_review',last_error=?,updated_at_ms=? WHERE id=?",
        [reviewReason, String(Date.now()), refundId],
      );
      await queueTelegramMessageTx(tx, refund.username, `refund:${refundId}:manual_review`, [
        "OneX Refund Update",
        "Your refund transaction was confirmed on-chain, but the refund requires manual review.",
        `Refund ID: ${refundId}`,
        `Reason: ${reviewReason}`,
        "Status: MANUAL REVIEW",
      ].join("\n"));
      return { manualReview: true };
    }
    const now = String(Date.now());
    await tx.query(
      `UPDATE users_usdt_refunds
       SET status='confirmed',block_number=?,last_error=NULL,confirmed_at_ms=?,updated_at_ms=?
       WHERE id=?`,
      [String(receipt.blockNumber), now, now, refundId],
    );
    if (batchId != null) {
      await tx.query(
        "UPDATE users_usdt_deposit_batches SET status='refunded',updated_at_ms=? WHERE id=? AND status='refund_queued'",
        [now, batchId],
      );
      await tx.query(
        "UPDATE users_usdt_transfer_events SET status='refunded' WHERE batch_id=?",
        [batchId],
      );
      await tx.query(
        `UPDATE admin_payment_resolutions
         SET action='refund_confirmed',tx_hash=?
         WHERE batch_id=? AND action='refund_queued' AND tx_hash IS NULL`,
        [refund.tx_hash, batchId],
      );
    } else {
      await tx.query(
        `UPDATE bsc_unknown_incoming_transfers SET status='refunded',updated_at_ms=? WHERE id=? AND status='refund_queued'`,
        [now, unknownTransferId],
      );
      await tx.query(
        `UPDATE admin_payment_resolutions SET action='refund_confirmed',tx_hash=?
         WHERE unknown_transfer_id=? AND action='unknown_refund_queued' AND tx_hash IS NULL`,
        [refund.tx_hash, unknownTransferId],
      );
    }
    await queueTelegramMessageTx(tx, refund.username, `refund:${refundId}:confirmed`, [
      "OneX Refund Update",
      "Your BSC-USD refund has been transferred successfully.",
      `Gross amount: ${new BigNumber(refund.gross_amount || refund.amount).toFixed(8)} BSC-USD`,
      `BSC gas recovery: ${new BigNumber(refund.fee_amount || 0).toFixed(8)} BSC-USD`,
      `Net amount: ${new BigNumber(refund.amount).toFixed(8)} BSC-USD`,
      `Actual gas cost: ${actualFee.feeBnb.toFixed(8)} BNB (${actualFee.feeUsd.toFixed(8)} BSC-USD)`,
      `Destination: ${refund.payout_address}`,
      `Transaction: ${refund.tx_hash}`,
      `Refund ID: ${refundId}`,
      "Status: CONFIRMED",
    ].join("\n"));
    return { confirmed: true };
  });
}

async function markRefundManualReview(db, job, reason) {
  return withTransaction(db, async (tx) => {
    const [refundRows] = await tx.query(
      "SELECT id,username,batch_id,unknown_transfer_id,status FROM users_usdt_refunds WHERE id=? LIMIT 1 FOR UPDATE",
      [job.id],
    );
    if (!refundRows.length || refundRows[0].status !== "queued") return;
    const refund = refundRows[0];
    const now = String(Date.now());
    await tx.query(
      "UPDATE users_usdt_refunds SET status='manual_review',last_error=?,updated_at_ms=? WHERE id=? AND status='queued'",
      [String(reason).slice(0, 2000), now, job.id],
    );
    if (refund.batch_id != null) {
      await tx.query(
        "UPDATE users_usdt_deposit_batches SET status='pending_support',updated_at_ms=? WHERE id=?",
        [now, refund.batch_id],
      );
      await tx.query(
        "UPDATE admin_payment_resolutions SET action='refund_manual_review',reason=? WHERE batch_id=? AND action='refund_queued'",
        [String(reason).slice(0, 1000), refund.batch_id],
      );
    } else if (refund.unknown_transfer_id != null) {
      await tx.query(
        `UPDATE bsc_unknown_incoming_transfers SET status='refund_manual_review',updated_at_ms=? WHERE id=?`,
        [now, refund.unknown_transfer_id],
      );
      await tx.query(
        `UPDATE admin_payment_resolutions SET action='refund_manual_review',reason=?
         WHERE unknown_transfer_id=? AND action='unknown_refund_queued'`,
        [String(reason).slice(0, 1000), refund.unknown_transfer_id],
      );
    }
    await queueTelegramMessageTx(tx, refund.username, `refund:${job.id}:manual_review`, [
      "OneX Refund Update",
      "The refund requires manual review because its net amount would be below the permitted minimum.",
      `Refund ID: ${job.id}`,
      `Reason: ${String(reason).slice(0, 500)}`,
      "Status: MANUAL REVIEW",
    ].join("\n"));
  });
}

async function processOneRefundJob(db, job, activeRuntime) {
  if (job.status === "queued") {
    const payoutAddress = requiredAddress(job.payout_address, "Refund payout address");
    if (payoutAddress.toLowerCase() === activeRuntime.treasuryAddress.toLowerCase()) {
      throw new Error("Refund destination cannot be the OneX treasury address.");
    }
    const grossAmount = new BigNumber(job.gross_amount || job.amount);
    if (!grossAmount.isFinite() || !grossAmount.isGreaterThan(0)) {
      throw new Error("The refund gross amount must be positive.");
    }
    const tokenBalance = await activeRuntime.token.balanceOf(activeRuntime.treasuryAddress);
    const payout = await estimateNetBscTokenTransfer({
      provider: activeRuntime.provider,
      fromAddress: activeRuntime.treasuryAddress,
      tokenAddress: activeRuntime.tokenAddress,
      payoutAddress,
      grossAmount,
      tokenBalanceRaw: tokenBalance,
      maximumGasLimit: activeRuntime.gasLimit,
      bnbUsdPrice: getConfiguredBnbUsdPrice(),
    });
    const { payoutAmount: finalPayoutAmount, amountRaw: finalAmountRaw, data: signedData, estimate: finalEstimate } = payout;
    if (!finalPayoutAmount.isGreaterThanOrEqualTo(10) || finalAmountRaw <= 0n || !signedData) {
      await markRefundManualReview(
        db,
        job,
        "The estimated network-fee deduction would reduce the net refund below 10 BSC-USD.",
      );
      return;
    }
    if (tokenBalance < finalAmountRaw) {
      throw new Error("The OneX treasury has insufficient BSC-USD for this refund.");
    }
    const bnbBalance = await activeRuntime.provider.getBalance(activeRuntime.treasuryAddress);
    if (bnbBalance < finalEstimate.gasLimit * finalEstimate.gasPrice) {
      throw new Error("The OneX treasury has insufficient BNB for the refund transaction gas.");
    }
    const nonce = await activeRuntime.provider.getTransactionCount(activeRuntime.treasuryAddress, "pending");
    const rawTransaction = await activeRuntime.signer.signTransaction({
      type: 0,
      chainId: Number(CHAIN_ID),
      nonce,
      to: activeRuntime.tokenAddress,
      value: 0n,
      data: signedData,
      gasLimit: finalEstimate.gasLimit,
      gasPrice: finalEstimate.gasPrice,
    });
    const transactionHash = keccak256(rawTransaction);
    const update = await db.queryAsync(
      `UPDATE users_usdt_refunds
       SET raw_tx=?,tx_hash=?,nonce=?,status='signed',amount=?,fee_amount=?,amount_raw=?,
           estimated_fee_bnb=?,estimated_fee_usd=?,bnb_usd_price=?,last_error=NULL,updated_at_ms=?
       WHERE id=? AND status='queued' AND raw_tx IS NULL AND tx_hash IS NULL`,
      [
        rawTransaction,
        transactionHash,
        String(nonce),
        finalPayoutAmount.toFixed(18),
        finalEstimate.feeUsd.toFixed(18),
        finalAmountRaw.toString(),
        finalEstimate.feeBnb.toFixed(30),
        finalEstimate.feeUsd.toFixed(18),
        finalEstimate.bnbUsdPrice.toFixed(12),
        String(Date.now()),
        job.id,
      ],
    );
    if (update.affectedRows !== 1) return;
    await withTransaction(db, async (tx) => {
      await recordEstimatedBscFeeTx(tx, {
        txHash: transactionHash,
        operation: "refund",
        gasLimit: finalEstimate.gasLimit.toString(),
        gasPriceWei: finalEstimate.gasPrice.toString(),
        bnbUsdPrice: finalEstimate.bnbUsdPrice,
      });
      if (job.batch_id != null) {
        await tx.query(
          `UPDATE admin_payment_resolutions SET fee_amount=?,net_amount=?
           WHERE batch_id=? AND action='refund_queued'`,
          [finalEstimate.feeUsd.toFixed(18), finalPayoutAmount.toFixed(18), job.batch_id],
        );
      } else {
        await tx.query(
          `UPDATE admin_payment_resolutions SET fee_amount=?,net_amount=?
           WHERE unknown_transfer_id=? AND action='unknown_refund_queued'`,
          [finalEstimate.feeUsd.toFixed(18), finalPayoutAmount.toFixed(18), job.unknown_transfer_id],
        );
      }
      await queueTelegramMessageTx(tx, job.username, `refund:${job.id}:gas_accepted`, [
        "OneX Refund Update",
        "The estimated BSC network fee is within the permitted limit. Your refund transaction has been signed and queued for blockchain submission.",
        `Gross amount: ${grossAmount.toFixed(8)} BSC-USD`,
        `Estimated gas recovery: ${finalEstimate.feeUsd.toFixed(8)} BSC-USD`,
        `Net refund: ${finalPayoutAmount.toFixed(8)} BSC-USD`,
        `Refund ID: ${job.id}`,
        "Status: PROCESSING",
      ].join("\n"));
    });
    job = { ...job, raw_tx: rawTransaction, tx_hash: transactionHash, status: "signed" };
  }

  if (!job.raw_tx || !job.tx_hash) {
    await markRefundError(db, job.id, new Error("Signed refund transaction is missing."));
    return;
  }

  let receipt = await activeRuntime.provider.getTransactionReceipt(job.tx_hash);
  if (!receipt) {
    const known = await activeRuntime.provider.getTransaction(job.tx_hash);
    if (!known) {
      try {
        const broadcast = await activeRuntime.provider.broadcastTransaction(job.raw_tx);
        if (broadcast.hash.toLowerCase() !== job.tx_hash.toLowerCase()) {
          throw new Error("The refund broadcast hash differs from the persisted transaction hash.");
        }
      } catch (error) {
        const afterError = await activeRuntime.provider.getTransaction(job.tx_hash);
        if (!afterError) {
          await markRefundError(db, job.id, error);
          return;
        }
      }
    }
    await db.queryAsync(
      "UPDATE users_usdt_refunds SET status='submitted',last_error=NULL,updated_at_ms=? WHERE id=? AND status IN ('signed','submitted')",
      [String(Date.now()), job.id],
    );
    receipt = await activeRuntime.provider.getTransactionReceipt(job.tx_hash);
    if (!receipt) return;
  }

  const canonicalBlock = await activeRuntime.provider.getBlock(receipt.blockNumber);
  const latestBlock = await activeRuntime.provider.getBlockNumber();
  const confirmations = latestBlock - Number(receipt.blockNumber) + 1;
  const canonical = canonicalBlock &&
    String(canonicalBlock.hash || "").toLowerCase() === String(receipt.blockHash || "").toLowerCase();
  if (!canonical || confirmations < activeRuntime.confirmations) return;

  if (Number(receipt.status) !== 1) {
    await withTransaction(db, async (tx) => {
      const now = String(Date.now());
      const actualFee = await recordActualBscFeeTx(tx, {
        txHash: job.tx_hash,
        operation: "refund",
        receipt,
      });
      await tx.query(
        "UPDATE users_usdt_refunds SET status='failed',actual_fee_bnb=?,actual_fee_usd=?,last_error=?,updated_at_ms=? WHERE id=?",
        [actualFee.feeBnb.toFixed(30), actualFee.feeUsd.toFixed(18), "The refund transaction was finalized but reverted on BNB Smart Chain.", now, job.id],
      );
      if (job.batch_id != null) {
        await tx.query(
          "UPDATE users_usdt_deposit_batches SET status='pending_support',updated_at_ms=? WHERE id=? AND status='refund_queued'",
          [now, job.batch_id],
        );
        await tx.query(
          "UPDATE users_usdt_transfer_events SET status='pending_support' WHERE batch_id=?",
          [job.batch_id],
        );
        await tx.query(
          "UPDATE admin_payment_resolutions SET action='refund_failed' WHERE batch_id=? AND action='refund_queued'",
          [job.batch_id],
        );
      } else if (job.unknown_transfer_id != null) {
        await tx.query(
          `UPDATE bsc_unknown_incoming_transfers SET status='refund_failed',updated_at_ms=? WHERE id=?`,
          [now, job.unknown_transfer_id],
        );
        await tx.query(
          `UPDATE admin_payment_resolutions SET action='refund_failed'
           WHERE unknown_transfer_id=? AND action='unknown_refund_queued'`,
          [job.unknown_transfer_id],
        );
      }
      await queueTelegramMessageTx(tx, job.username, `refund:${job.id}:failed`, [
        "OneX Refund Update",
        "Your refund transaction failed after blockchain finality. The support case has been reopened.",
        `Refund ID: ${job.id}`,
        "Status: FAILED - SUPPORT REQUIRED",
      ].join("\n"));
    });
    return;
  }

  if (!receiptConfirmsExpectedTransfer(receipt, job, activeRuntime)) {
    await withTransaction(db, async (tx) => {
      const now = String(Date.now());
      const actualFee = await recordActualBscFeeTx(tx, {
        txHash: job.tx_hash,
        operation: "refund",
        receipt,
      });
      await tx.query(
        "UPDATE users_usdt_refunds SET status='manual_review',actual_fee_bnb=?,actual_fee_usd=?,last_error=?,updated_at_ms=? WHERE id=?",
        [actualFee.feeBnb.toFixed(30), actualFee.feeUsd.toFixed(18), "The refund transaction succeeded but did not contain the expected BSC-USD Transfer event.", now, job.id],
      );
      if (job.batch_id != null) {
        await tx.query(
          "UPDATE users_usdt_deposit_batches SET status='pending_support',updated_at_ms=? WHERE id=?",
          [now, job.batch_id],
        );
        await tx.query(
          "UPDATE admin_payment_resolutions SET action='refund_manual_review' WHERE batch_id=? AND action='refund_queued'",
          [job.batch_id],
        );
      } else if (job.unknown_transfer_id != null) {
        await tx.query(
          `UPDATE bsc_unknown_incoming_transfers SET status='refund_manual_review',updated_at_ms=? WHERE id=?`,
          [now, job.unknown_transfer_id],
        );
        await tx.query(
          `UPDATE admin_payment_resolutions SET action='refund_manual_review'
           WHERE unknown_transfer_id=? AND action='unknown_refund_queued'`,
          [job.unknown_transfer_id],
        );
      }
      await queueTelegramMessageTx(tx, job.username, `refund:${job.id}:manual_review`, [
        "OneX Refund Update",
        "The refund transaction requires manual review because its receipt does not match the expected transfer.",
        `Refund ID: ${job.id}`,
        "Status: MANUAL REVIEW",
      ].join("\n"));
    });
    return;
  }

  await finalizeRefund(db, job.id, receipt);
}

async function processRefundQueue(db, activeRuntime) {
  const jobs = await db.queryAsync(
    `SELECT * FROM users_usdt_refunds
     WHERE status IN ('queued','signed','submitted')
     ORDER BY id ASC LIMIT 10`,
  );
  for (const job of jobs) {
    try {
      await processOneRefundJob(db, job, activeRuntime);
    } catch (error) {
      console.error(`Refund ${job.id} processing failed:`, error.message);
      await markRefundError(db, job.id, error).catch(() => {});
    }
  }
}


async function closeExpiredGlobalDisbursement(db) {
  const now = Date.now();
  const [runs] = await db.queryAsync(
    `SELECT id FROM global_disbursement_runs
     WHERE status='active' AND CAST(CASE WHEN extension_deadline_at_ms>0 THEN extension_deadline_at_ms ELSE request_deadline_at_ms END AS UNSIGNED)<=?
     ORDER BY id ASC LIMIT 10`,
    [String(now)],
  );
  let closed = 0;
  for (const candidate of runs) {
    await withTransaction(db, async (tx) => {
      const [lockRows] = await tx.query(
        "SELECT lock_name FROM system_locks WHERE lock_name='common_state' FOR UPDATE",
      );
      if (!lockRows.length) throw new Error("The common-state lock row is missing during global closure.");
      await getLatestCommonTx(tx, true);
      const [runRows] = await tx.query(
        "SELECT id,status,request_deadline_at_ms,extension_deadline_at_ms FROM global_disbursement_runs WHERE id=? LIMIT 1 FOR UPDATE",
        [candidate.id],
      );
      if (!runRows.length || runRows[0].status !== "active" || Number(runRows[0].extension_deadline_at_ms || runRows[0].request_deadline_at_ms) > now) return;
      const timestamp = String(now);
      await tx.query(
        `UPDATE global_disbursement_runs
         SET status='closed',closed_at_ms=?,updated_at_ms=? WHERE id=? AND status='active'`,
        [timestamp, timestamp, candidate.id],
      );
      await tx.query(
        `UPDATE global_disbursement_participants
         SET status='manual_review',updated_at_ms=?
         WHERE run_id=? AND status='awaiting_request' AND remaining_initial_asset>0`,
        [timestamp, candidate.id],
      );
      closed += 1;
    });
  }
  return { closed };
}

async function settleGlobalDisbursementRun(db) {
  const [runs] = await db.queryAsync(
    `SELECT id,status FROM global_disbursement_runs
     WHERE status IN ('closed','manual_review') ORDER BY id ASC LIMIT 10`,
  );
  let settled = 0;
  for (const run of runs) {
    await withTransaction(db, async (tx) => {
      const [lockRows] = await tx.query(
        "SELECT lock_name FROM system_locks WHERE lock_name='common_state' FOR UPDATE",
      );
      if (!lockRows.length) throw new Error("The common-state lock row is missing during global settlement.");
      await getLatestCommonTx(tx, true);
      const [runRows] = await tx.query(
        "SELECT id,status FROM global_disbursement_runs WHERE id=? LIMIT 1 FOR UPDATE", [run.id],
      );
      if (!runRows.length || !["closed", "manual_review"].includes(runRows[0].status)) return;
      const [pendingRows] = await tx.query(
        `SELECT COUNT(*) AS count FROM users_usdt_disbursements
         WHERE global_run_id=? AND status IN ('queued','signed','submitted','manual_review')`, [run.id],
      );
      if (Number(pendingRows[0]?.count || 0) > 0) return;
      const [participantRows] = await tx.query(
        `SELECT COUNT(*) AS count FROM global_disbursement_participants
         WHERE run_id=? AND status IN ('awaiting_request','request_pending','manual_review')`, [run.id],
      );
      const unresolved = Number(participantRows[0]?.count || 0);
      const nextStatus = unresolved > 0 ? "manual_review" : "completed";
      const timestamp = String(Date.now());
      await tx.query(
        `UPDATE global_disbursement_runs
         SET status=?,admin_bonus_reserved_initial_asset=CASE WHEN ?='completed' THEN 0 ELSE admin_bonus_reserved_initial_asset END,
             completed_at_ms=CASE WHEN ?='completed' THEN ? ELSE completed_at_ms END,
             updated_at_ms=? WHERE id=?`,
        [nextStatus, nextStatus, nextStatus, timestamp, timestamp, run.id],
      );
      settled += 1;
    });
  }
  return { settled };
}

async function runDisbursementCycle(db, activeRuntime) {
  if (workerRunning) return;
  workerRunning = true;
  let releaseLock = null;
  try {
    releaseLock = await acquireWorkerLock(db);
    if (!releaseLock) return;

    const now = String(Date.now());
    const expiredReservations = await db.queryAsync(
      `SELECT id FROM users_usdt_disbursements
       WHERE status='queued' AND disbursement_mode='individual'
         AND raw_tx IS NULL AND tx_hash IS NULL
         AND CAST(reservation_expires_at_ms AS UNSIGNED)<=?
       ORDER BY id ASC LIMIT 50`,
      [now],
    );
    for (const expired of expiredReservations) {
      await markManualReview(
        db,
        expired.id,
        "Reservation expired before transaction submission; administrator review is required.",
      );
    }
    const jobs = await db.queryAsync(
      `SELECT * FROM users_usdt_disbursements
       WHERE status IN ('queued','signed','submitted')
       ORDER BY id ASC LIMIT 10`,
    );
    for (const job of jobs) {
      try {
        await processOneJob(db, job, activeRuntime);
      } catch (error) {
        console.error(`Disbursement ${job.id} processing failed:`, error.message);
        await updateJobError(db, job.id, error).catch(() => {});
      }
    }
    await processRefundQueue(db, activeRuntime);

    const sellerPayouts = await db.queryAsync(
      `SELECT * FROM users_usdt_seller_payouts
       WHERE status IN ('queued','signed','submitted')
       ORDER BY id ASC LIMIT 20`,
    );
    for (const payout of sellerPayouts) {
      try {
        await processOneSellerPayout(db, payout, activeRuntime);
      } catch (error) {
        console.error(`Seller payout ${payout.id} processing failed:`, error.message);
      }
    }
    await closeExpiredGlobalDisbursement(db);
    await settleGlobalDisbursementRun(db);

  } catch (error) {
    console.error("OneX BSC disbursement worker failed:", error);
  } finally {
    if (releaseLock) {
      try {
        await releaseLock();
      } catch (error) {
        console.error("Unable to release the disbursement worker lock:", error.message);
      }
    }
    workerRunning = false;
  }
}

async function startDisbursementWorker(db) {
  if (timer) return { enabled: true };
  const masterEnabled = String(process.env.USDT_DISBURSEMENTS_ENABLED || "false").toLowerCase() === "true";
  const individualEnabled = masterEnabled && String(process.env.USDT_INDIVIDUAL_DISBURSEMENT_ENABLED || "false").toLowerCase() === "true";
  const globalEnabled = masterEnabled && String(process.env.USDT_GLOBAL_DISBURSEMENT_ENABLED || "false").toLowerCase() === "true";
  const sellerEnabled = String(process.env.USDT_SELLER_PAYOUTS_ENABLED || "false").toLowerCase() === "true";
  const [pendingRows] = await db.promise().query(
    `SELECT
       (SELECT COUNT(*) FROM users_usdt_disbursements WHERE status IN ('queued','signed','submitted')) AS disbursements,
       (SELECT COUNT(*) FROM users_usdt_seller_payouts WHERE status IN ('queued','signed','submitted')) AS seller_payouts,
       (SELECT COUNT(*) FROM global_disbursement_runs WHERE status IN ('active','closed','manual_review')) AS global_runs`,
  );
  const pendingWork = Number(pendingRows[0]?.disbursements || 0) > 0 ||
    Number(pendingRows[0]?.seller_payouts || 0) > 0 || Number(pendingRows[0]?.global_runs || 0) > 0;
  if (!individualEnabled && !globalEnabled && !sellerEnabled && !pendingWork) {
    console.log("OneX BSC treasury payouts are disabled; no accepted payouts are pending.");
    return { enabled: false };
  }

  const activeRuntime = makeRuntime(pendingWork);
  if (!activeRuntime) return { enabled: false };
  const priceSnapshot = await startBnbUsdPriceOracle(activeRuntime.provider);
  await validateRuntime(activeRuntime);
  if (priceSnapshot) {
    console.log(
      `OneX BSC treasury worker ready. Treasury: ${activeRuntime.treasuryAddress}. ` +
      `Chainlink BNB/USD: ${priceSnapshot.price} (updated ${new Date(priceSnapshot.updatedAt * 1000).toISOString()}).`,
    );
  } else {
    console.warn("OneX BSC treasury worker is ready, but no fresh Chainlink BNB/USD quote is available. Outgoing jobs will remain queued.");
  }

  const run = async () => {
    await runDisbursementCycle(db, activeRuntime);
    timer = setTimeout(run, activeRuntime.pollIntervalMs);
  };
  void run();
  return { enabled: true };
}

module.exports = {
  startDisbursementWorker,
  checkTreasuryLiquidity,
  closeExpiredGlobalDisbursement,
  settleGlobalDisbursementRun,
};
