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
const { getDate } = require("./utils");

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
  await db.queryAsync(
    `UPDATE users_usdt_disbursements
     SET status='manual_review',last_error=?,updated_at_ms=?
     WHERE id=? AND status IN ('queued','signed','submitted')`,
    [String(message).slice(0, 2000), String(Date.now()), jobId],
  );
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
      await tx.query(
        "UPDATE users_usdt_disbursements SET status='manual_review',last_error=?,updated_at_ms=? WHERE id=?",
        [`Cannot restore user stock after failed payout: account or stock row is missing. ${message}`, String(Date.now()), jobId],
      );
      return;
    }

    const currentBalance = new BigNumber(stockRows[0].balance);
    const currentInitAsset = new BigNumber(stockRows[0].init_asset);
    if (!currentBalance.isZero() || !currentInitAsset.isZero()) {
      await tx.query(
        "UPDATE users_usdt_disbursements SET status='manual_review',last_error=?,updated_at_ms=? WHERE id=?",
        [`Cannot safely restore reserved stock because the user balance changed. ${message}`, String(Date.now()), jobId],
      );
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
      await tx.query(
        `UPDATE users_usdt_disbursements SET status='manual_review',last_error=?,updated_at_ms=? WHERE id=?`,
        ["The payout was confirmed on-chain, but the OneX account or stock row is missing.", String(Date.now()), jobId],
      );
      return { manualReview: true };
    }

    const userBalance = new BigNumber(userStockRows[0].balance);
    const userInitAsset = new BigNumber(userStockRows[0].init_asset);
    if (!userBalance.isZero() || !userInitAsset.isZero()) {
      await tx.query(
        `UPDATE users_usdt_disbursements SET status='manual_review',last_error=?,updated_at_ms=? WHERE id=?`,
        ["The payout was confirmed on-chain, but the reserved user balance changed before accounting finalization.", String(Date.now()), jobId],
      );
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
    const newTotal = total.minus(payoutAmount);
    const newInactive = inactive.plus(soldInitialAssets);
    if (
      !systemBalance.isFinite() || systemBalance.isNegative() ||
      !newSystemBalance.isFinite() ||
      !newSystemInitAsset.isFinite() ||
      !newTotal.isFinite() || newTotal.isNegative() ||
      !newInactive.isFinite() || newInactive.isNegative()
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
      [newTotal.toFixed(), unitPrice.toFixed(), backed.toFixed(), newInactive.toFixed(), date, time],
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

    await tx.query(
      `UPDATE users_usdt_disbursements
       SET status='confirmed',block_number=?,last_error=NULL,confirmed_at_ms=?,updated_at_ms=?
       WHERE id=?`,
      [String(blockNumber), String(Date.now()), String(Date.now()), jobId],
    );
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
    await restoreUserBalanceAfterFailedPayout(
      db,
      job.id,
      "The BSC-USD transfer transaction was mined but reverted.",
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

async function runDisbursementCycle(db, activeRuntime) {
  if (workerRunning) return;
  workerRunning = true;
  let releaseLock = null;
  try {
    releaseLock = await acquireWorkerLock(db);
    if (!releaseLock) return;

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
};
