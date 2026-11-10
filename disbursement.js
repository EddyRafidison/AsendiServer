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
const { deriveInitAsset } = require("./stock-accounting");
const { calculateDisbursementReserveSettlement } = require("./disbursement-policy");
const { getDate } = require("./utils");
const { queueTelegramMessageTx } = require("./telegram");

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

function makeRuntime() {
  if (runtime) return runtime;

  if (String(process.env.USDT_DISBURSEMENTS_ENABLED || "false").toLowerCase() !== "true") {
    return null;
  }

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

async function checkTreasuryLiquidity(amountRaw) {
  const rpcUrl = String(process.env.BSC_RPC_URL || "").trim();
  const tokenAddress = requiredAddress(
    process.env.USDT_BEP20_CONTRACT || CANONICAL_BSC_USD_CONTRACT,
    "BSC-USD token contract",
  );
  const treasuryAddress = requiredAddress(
    process.env.USDT_BEP20_TREASURY_ADDRESS || "",
    "OneX treasury address",
  );
  const gasLimit = BigInt(process.env.USDT_DISBURSEMENT_GAS_LIMIT || "100000");
  const amount = BigInt(amountRaw);
  if (!rpcUrl || amount <= 0n || tokenAddress.toLowerCase() !== CANONICAL_BSC_USD_CONTRACT.toLowerCase()) {
    throw new Error("Treasury liquidity check is not correctly configured.");
  }
  if (gasLimit < 60000n || gasLimit > 200000n) {
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
    const feeData = await provider.getFeeData();
    const gasPrice = feeData.gasPrice || BigInt(await provider.send("eth_gasPrice", []));
    const bnbBalance = await provider.getBalance(treasuryAddress);
    const gasRequired = gasLimit * gasPrice;
    return {
      available: tokenBalance >= amount && bnbBalance >= gasRequired,
      tokenBalanceRaw: tokenBalance.toString(),
      requiredTokenRaw: amount.toString(),
      bnbBalanceWei: bnbBalance.toString(),
      requiredBnbWei: gasRequired.toString(),
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
  if (Number(job.reservation_expires_at_ms) <= Date.now()) {
    await markManualReview(
      db,
      job.id,
      "Reservation expired before transaction submission; administrator review is required.",
    );
    return false;
  }
  const amountRaw = BigInt(job.amount_raw);
  if (amountRaw <= 0n) throw new Error("The disbursement token amount must be positive.");

  const payoutAddress = requiredAddress(job.payout_address, "Disbursement payout address");
  if (payoutAddress.toLowerCase() === activeRuntime.treasuryAddress.toLowerCase()) {
    throw new Error("The payout address cannot be the OneX treasury address.");
  }

  const tokenBalanceRaw = await activeRuntime.token.balanceOf(activeRuntime.treasuryAddress);
  if (tokenBalanceRaw < amountRaw) {
    throw new Error("The OneX treasury does not have enough BSC-USD to cover this disbursement.");
  }

  const feeData = await activeRuntime.provider.getFeeData();
  let gasPrice = feeData.gasPrice;
  if (!gasPrice || gasPrice <= 0n) {
    gasPrice = BigInt(await activeRuntime.provider.send("eth_gasPrice", []));
  }

  const nativeBalance = await activeRuntime.provider.getBalance(activeRuntime.treasuryAddress);
  const requiredGasBalance = activeRuntime.gasLimit * gasPrice;
  if (nativeBalance < requiredGasBalance) {
    throw new Error("The OneX treasury does not have enough BNB to pay the disbursement transaction fee.");
  }

  const nonce = await activeRuntime.provider.getTransactionCount(
    activeRuntime.treasuryAddress,
    "pending",
  );
  const data = TRANSFER_INTERFACE.encodeFunctionData("transfer", [
    payoutAddress,
    amountRaw,
  ]);
  const rawTransaction = await activeRuntime.signer.signTransaction({
    type: 0,
    chainId: Number(CHAIN_ID),
    nonce,
    to: activeRuntime.tokenAddress,
    value: 0n,
    data,
    gasLimit: activeRuntime.gasLimit,
    gasPrice,
  });
  const transactionHash = keccak256(rawTransaction);

  const result = await db.queryAsync(
    `UPDATE users_usdt_disbursements
     SET raw_tx=?,tx_hash=?,nonce=?,status='signed',last_error=NULL,updated_at_ms=?
     WHERE id=? AND status='queued' AND raw_tx IS NULL AND tx_hash IS NULL`,
    [rawTransaction, transactionHash, String(nonce), String(Date.now()), job.id],
  );
  if (result.affectedRows !== 1) {
    throw new Error("The disbursement job was claimed or updated concurrently.");
  }
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

async function markManualReview(db, jobId, message) {
  return withTransaction(db, async (tx) => {
    const [rows] = await tx.query(
      "SELECT username,status FROM users_usdt_disbursements WHERE id=? LIMIT 1 FOR UPDATE",
      [jobId],
    );
    if (!rows.length || rows[0].status === "manual_review") return;
    const username = rows[0].username;
    const now = String(Date.now());
    const [update] = await tx.query(
      `UPDATE users_usdt_disbursements
       SET status='manual_review',last_error=?,updated_at_ms=?
       WHERE id=? AND status IN ('queued','signed','submitted')`,
      [String(message).slice(0, 2000), now, jobId],
    );
    if (update.affectedRows === 1) {
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

async function restoreUserBalanceAfterFailedPayout(db, jobId, message) {
  return withTransaction(db, async (tx) => {
    const [preRows] = await tx.query(
      "SELECT username FROM users_usdt_disbursements WHERE id=? LIMIT 1",
      [jobId],
    );
    if (preRows.length === 0) return;
    const username = preRows[0].username;

    const [authRows] = await tx.query(
      "SELECT username FROM auths WHERE username=? LIMIT 1 FOR UPDATE",
      [username],
    );
    const [stockRows] = await tx.query(
      "SELECT balance,init_asset FROM users_stock WHERE username=? LIMIT 1 FOR UPDATE",
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

    const currentBalance = new BigNumber(stockRows[0].balance);
    const currentInitAsset = new BigNumber(stockRows[0].init_asset);
    if (!currentBalance.isZero() || !currentInitAsset.isZero()) {
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
      "UPDATE users_stock SET balance=?,init_asset=?,record_date=?,record_time=? WHERE username=?",
      [job.gross_balance, job.gross_init_asset, date, time, username],
    );
    await tx.query(
      `UPDATE users_usdt_disbursements
       SET status='failed',last_error=?,updated_at_ms=? WHERE id=?`,
      [String(message).slice(0, 2000), String(Date.now()), jobId],
    );
    await queueTelegramMessageTx(tx, username, `disbursement:${jobId}:failed`, [
      "OneX Disbursement Update",
      "Your disbursement transaction failed after blockchain finality. Your reserved One-Val balance has been restored.",
      `Disbursement ID: ${jobId}`,
      `Reason: ${String(message).slice(0, 500)}`,
      "Status: FAILED - BALANCE RESTORED",
    ].join("\n"));
  });
}

async function finalizeSuccessfulPayout(db, jobId, blockNumber) {
  return withTransaction(db, async (tx) => {
    const [preRows] = await tx.query(
      "SELECT username FROM users_usdt_disbursements WHERE id=? LIMIT 1",
      [jobId],
    );
    if (preRows.length === 0) throw new Error(`Disbursement ${jobId} does not exist.`);
    const username = preRows[0].username;

    // Keep the same account/stock/common lock order as the HTTP reservation path.
    const [authRows] = await tx.query(
      "SELECT username FROM auths WHERE username=? LIMIT 1 FOR UPDATE",
      [username],
    );
    const [userStockRows] = await tx.query(
      "SELECT balance,init_asset FROM users_stock WHERE username=? LIMIT 1 FOR UPDATE",
      [username],
    );
    const [jobRows] = await tx.query(
      "SELECT * FROM users_usdt_disbursements WHERE id=? LIMIT 1 FOR UPDATE",
      [jobId],
    );
    if (jobRows.length === 0) throw new Error(`Disbursement ${jobId} disappeared.`);
    const job = jobRows[0];
    if (job.status === "confirmed") return { confirmed: true };

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

    const userBalance = new BigNumber(userStockRows[0].balance);
    const userInitAsset = new BigNumber(userStockRows[0].init_asset);
    if (!userBalance.isZero() || !userInitAsset.isZero()) {
      const reviewReason = "The payout was confirmed on-chain, but the reserved user balance changed before accounting finalization.";
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
      "SELECT balance,init_asset FROM users_stock WHERE username='ONEX' LIMIT 1 FOR UPDATE",
    );
    if (systemRows.length === 0) throw new Error("The OneX system stock row is missing.");

    const [commonLockRows] = await tx.query(
      "SELECT lock_name FROM system_locks WHERE lock_name='common_state' FOR UPDATE",
    );
    if (commonLockRows.length === 0) throw new Error("The common-state lock row is missing.");

    const [commonRows] = await tx.query(
      `SELECT total_units_price,unit_price,backed_units,inactive_init_asset
       FROM common ORDER BY id DESC LIMIT 1 FOR UPDATE`,
    );
    if (commonRows.length === 0) throw new Error("The common reserve is missing.");

    const common = commonRows[0];
    const total = new BigNumber(common.total_units_price);
    const unitPrice = new BigNumber(common.unit_price);
    const backed = new BigNumber(common.backed_units);
    const inactive = new BigNumber(common.inactive_init_asset);
    const payoutAmount = new BigNumber(job.payout_amount);
    const storedSoldInitialAssets = new BigNumber(job.sold_init_asset || "0");
    const grossBalance = new BigNumber(job.gross_balance);
    const priceValue = new BigNumber(job.price_value);
    const feeInitialAssets = new BigNumber(job.fee_init_asset);
    const soldInitialAssets =
      storedSoldInitialAssets.isFinite() && storedSoldInitialAssets.isGreaterThan(0)
        ? storedSoldInitialAssets
        : payoutAmount.isFinite() && payoutAmount.isGreaterThan(0) && priceValue.isFinite() && priceValue.isGreaterThan(0)
          ? payoutAmount.dividedBy(priceValue)
          : new BigNumber("NaN");

    if (
      !total.isFinite() || !total.isGreaterThanOrEqualTo(payoutAmount) ||
      !unitPrice.isFinite() || !unitPrice.isGreaterThan(0) ||
      !backed.isFinite() || backed.isNegative() ||
      !inactive.isFinite() || inactive.isNegative() ||
      !payoutAmount.isFinite() || !payoutAmount.isGreaterThan(0) ||
      !soldInitialAssets.isFinite() || !soldInitialAssets.isGreaterThan(0) ||
      !grossBalance.isFinite() || !grossBalance.isGreaterThan(0) ||
      !priceValue.isFinite() || !priceValue.isGreaterThan(0) ||
      !feeInitialAssets.isFinite() || feeInitialAssets.isNegative()
    ) {
      await tx.query(
        `UPDATE users_usdt_disbursements SET status='manual_review',last_error=?,updated_at_ms=? WHERE id=?`,
        ["The payout was confirmed on-chain, but the common reserve values are inconsistent.", String(Date.now()), jobId],
      );
      return { manualReview: true };
    }

    const systemBalance = new BigNumber(systemRows[0].balance);
    const newSystemBalance = systemBalance.plus(grossBalance);
    const newSystemInitAsset = deriveInitAsset(newSystemBalance, priceValue);
    const reserveSettlement = calculateDisbursementReserveSettlement(
      total,
      backed,
      inactive,
      {
        payoutAmount,
        soldInitAsset: soldInitialAssets,
        feeInactiveInitAsset: feeInitialAssets.dividedBy(4),
        feeBackedInitAsset: feeInitialAssets.multipliedBy(3).dividedBy(4),
      },
    );
    const newTotal = reserveSettlement.newTotalUnitsPrice;
    const newInactive = reserveSettlement.newInactiveInitAsset;
    const newBacked = reserveSettlement.newBackedUnits;
    if (
      !systemBalance.isFinite() || systemBalance.isNegative() ||
      !newSystemBalance.isFinite() ||
      !newSystemInitAsset.isFinite() ||
      !newTotal.isFinite() || newTotal.isNegative() ||
      !newInactive.isFinite() || newInactive.isNegative() ||
      !newBacked.isFinite() || newBacked.isNegative()
    ) {
      throw new Error("Invalid accounting values while finalizing a disbursement.");
    }

    const [date, time] = getDate();
    await tx.query(
      "UPDATE users_stock SET balance=?,init_asset=?,record_date=?,record_time=? WHERE username='ONEX'",
      [newSystemBalance.toFixed(), newSystemInitAsset.toFixed(), date, time],
    );
    await tx.query(
      `INSERT INTO common(total_units_price,unit_price,backed_units,inactive_init_asset,record_date,record_time)
       VALUES(?,?,?,?,?,?)`,
      [newTotal.toFixed(), unitPrice.toFixed(), newBacked.toFixed(), newInactive.toFixed(), date, time],
    );

    const [existingActivityRows] = await tx.query(
      "SELECT id FROM activities WHERE reference=? LIMIT 1",
      [job.reference],
    );
    if (existingActivityRows.length === 0) {
      await tx.query(
        `INSERT INTO activities(sender,receiver,type,amount,unit_price,fees,reference,record_date,record_time)
         VALUES(?,?,?,?,?,?,?,?,?)`,
        [username, "ONEX", 3, soldInitialAssets.toFixed(), priceValue.toFixed(), feeInitialAssets.toFixed(), job.reference, date, time],
      );
    }

    const confirmedAt = String(Date.now());
    await tx.query(
      `UPDATE users_usdt_disbursements
       SET status='confirmed',block_number=?,last_error=NULL,confirmed_at_ms=?,updated_at_ms=?
       WHERE id=?`,
      [String(blockNumber), confirmedAt, confirmedAt, jobId],
    );
    await queueTelegramMessageTx(tx, username, `disbursement:${jobId}:confirmed`, [
      "OneX Disbursement Update",
      "Your sale to OneX has been completed and the BSC-USD payment is confirmed.",
      `Gross amount: ${grossBalance.toFixed(8)} One-Val`,
      `Fees: ${new BigNumber(job.fee_amount).toFixed(8)} One-Val`,
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
      await updateJobError(db, job.id, error);
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
    );
    return;
  }

  if (!receiptConfirmsExpectedTransfer(receipt, job, activeRuntime)) {
    await markManualReview(
      db,
      job.id,
      "The transaction succeeded on-chain but its receipt does not contain the expected BSC-USD Transfer event.",
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

  await finalizeSuccessfulPayout(db, job.id, receipt.blockNumber);
}

async function markRefundError(db, refundId, error) {
  await db.queryAsync(
    `UPDATE users_usdt_refunds
     SET last_error=?,updated_at_ms=?
     WHERE id=? AND status IN ('queued','signed','submitted')`,
    [String(error?.message || error || "Unknown refund error").slice(0, 2000), String(Date.now()), refundId],
  );
}

async function finalizeRefund(db, refundId, blockNumber) {
  return withTransaction(db, async (tx) => {
    const [preRows] = await tx.query(
      "SELECT batch_id FROM users_usdt_refunds WHERE id=? LIMIT 1", [refundId],
    );
    if (!preRows.length) throw new Error(`Refund ${refundId} does not exist.`);
    const batchId = preRows[0].batch_id;
    const [batchRows] = await tx.query(
      "SELECT id,status FROM users_usdt_deposit_batches WHERE id=? LIMIT 1 FOR UPDATE", [batchId],
    );
    const [refundRows] = await tx.query(
      "SELECT * FROM users_usdt_refunds WHERE id=? LIMIT 1 FOR UPDATE", [refundId],
    );
    if (!refundRows.length) throw new Error(`Refund ${refundId} disappeared.`);
    const refund = refundRows[0];
    if (refund.status === "confirmed") return { confirmed: true };
    if (!batchRows.length || batchRows[0].status !== "refund_queued") {
      const reviewReason = "The refund was confirmed on-chain but its recharge batch is not in refund_queued state.";
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
      [String(blockNumber), now, now, refundId],
    );
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
    await queueTelegramMessageTx(tx, refund.username, `refund:${refundId}:confirmed`, [
      "OneX Refund Update",
      "Your BSC-USD refund has been transferred successfully.",
      `Amount: ${new BigNumber(refund.amount).toFixed(8)} BSC-USD`,
      `Destination: ${refund.payout_address}`,
      `Transaction: ${refund.tx_hash}`,
      `Refund ID: ${refundId}`,
      "Status: CONFIRMED",
    ].join("\n"));
    return { confirmed: true };
  });
}

async function processOneRefundJob(db, job, activeRuntime) {
  if (job.status === "queued") {
    const amountRaw = BigInt(job.amount_raw);
    if (amountRaw <= 0n) throw new Error("The refund amount must be positive.");
    const payoutAddress = requiredAddress(job.payout_address, "Refund payout address");
    if (payoutAddress.toLowerCase() === activeRuntime.treasuryAddress.toLowerCase()) {
      throw new Error("Refund destination cannot be the OneX treasury address.");
    }
    const tokenBalance = await activeRuntime.token.balanceOf(activeRuntime.treasuryAddress);
    if (tokenBalance < amountRaw) throw new Error("The OneX treasury has insufficient BSC-USD for this refund.");
    const feeData = await activeRuntime.provider.getFeeData();
    const gasPrice = feeData.gasPrice || BigInt(await activeRuntime.provider.send("eth_gasPrice", []));
    const bnbBalance = await activeRuntime.provider.getBalance(activeRuntime.treasuryAddress);
    if (bnbBalance < activeRuntime.gasLimit * gasPrice) {
      throw new Error("The OneX treasury has insufficient BNB for the refund transaction gas.");
    }
    const nonce = await activeRuntime.provider.getTransactionCount(activeRuntime.treasuryAddress, "pending");
    const data = TRANSFER_INTERFACE.encodeFunctionData("transfer", [payoutAddress, amountRaw]);
    const rawTransaction = await activeRuntime.signer.signTransaction({
      type: 0,
      chainId: Number(CHAIN_ID),
      nonce,
      to: activeRuntime.tokenAddress,
      value: 0n,
      data,
      gasLimit: activeRuntime.gasLimit,
      gasPrice,
    });
    const transactionHash = keccak256(rawTransaction);
    const update = await db.queryAsync(
      `UPDATE users_usdt_refunds
       SET raw_tx=?,tx_hash=?,nonce=?,status='signed',last_error=NULL,updated_at_ms=?
       WHERE id=? AND status='queued' AND raw_tx IS NULL AND tx_hash IS NULL`,
      [rawTransaction, transactionHash, String(nonce), String(Date.now()), job.id],
    );
    if (update.affectedRows !== 1) return;
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
      await tx.query(
        "UPDATE users_usdt_refunds SET status='failed',last_error=?,updated_at_ms=? WHERE id=?",
        ["The refund transaction was finalized but reverted on BNB Smart Chain.", now, job.id],
      );
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
      await tx.query(
        "UPDATE users_usdt_refunds SET status='manual_review',last_error=?,updated_at_ms=? WHERE id=?",
        ["The refund transaction succeeded but did not contain the expected BSC-USD Transfer event.", now, job.id],
      );
      await tx.query(
        "UPDATE users_usdt_deposit_batches SET status='pending_support',updated_at_ms=? WHERE id=?",
        [now, job.batch_id],
      );
      await tx.query(
        "UPDATE admin_payment_resolutions SET action='refund_manual_review' WHERE batch_id=? AND action='refund_queued'",
        [job.batch_id],
      );
      await queueTelegramMessageTx(tx, job.username, `refund:${job.id}:manual_review`, [
        "OneX Refund Update",
        "The refund transaction requires manual review because its receipt does not match the expected transfer.",
        `Refund ID: ${job.id}`,
        "Status: MANUAL REVIEW",
      ].join("\n"));
    });
    return;
  }

  await finalizeRefund(db, job.id, receipt.blockNumber);
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
       WHERE status='queued' AND raw_tx IS NULL AND tx_hash IS NULL
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
  if (String(process.env.USDT_DISBURSEMENTS_ENABLED || "false").toLowerCase() !== "true") {
    console.log("OneX BSC disbursements are disabled.");
    return { enabled: false };
  }
  if (timer) return { enabled: true };

  const activeRuntime = makeRuntime();
  await validateRuntime(activeRuntime);
  console.log(`OneX BSC disbursement worker ready. Treasury: ${activeRuntime.treasuryAddress}`);

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
};
