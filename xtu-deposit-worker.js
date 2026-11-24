"use strict";

const BigNumber = require("bignumber.js");
const nodemailer = require("nodemailer");
const {
  JsonRpcProvider,
  Contract,
  Interface,
  Wallet,
  getAddress,
  keccak256,
  toUtf8Bytes,
} = require("ethers");
const {
  XTU_ABI,
  getXtuSettings,
  isXtuDepositWorkerEnabled,
  getXtuRuntime,
  getXtuMainSigner,
} = require("./xtu-withdrawal-chain");
const {
  calculateDepositFeeRate,
  calculateXtuDepositCredit,
  calculateXtuDepositTranche,
  allocateBatchGasByGross,
  classifyDepositSession,
  selectXtuConsolidationBatches,
  calculateXtuSettlementQuote,
  MIN_XTU_DEPOSIT,
  MAX_XTU_DEPOSIT,
  DEPOSIT_PENDING_RETRY_MS,
} = require("./xtu-deposit-policy");
const { getLatestCommonTx, insertCommonSnapshotTx } = require("./common-accounting");
const {
  recordEstimatedBscFeeTx,
  recordActualBscFeeTx,
  estimateBscTokenTransfer,
  calculateActualGasFee,
} = require("./bsc-fee-accounting");
const { getBnbUsdPrice } = require("./bsc-price-oracle");
const { getConfiguredMaxBscTxFeeUsd, evaluateBscTxFee } = require("./bsc-transaction-policy");
const {
  calculateDepositFundingAllocation,
  calculateSellerOnlyDepositFundingAllocation,
  calculateRemainingSystemAdminReserve,
} = require("./stock-accounting");
const { getActiveSellerReserveAvailableTx, consumeSellerReserveTx } = require("./seller-accounting");
const { getUserPriceStateTx, previewUserOperationCapacity } = require("./user-price-accounting");
const { isGlobalDisbursementEffective } = require("./global-disbursement-policy");
const { getLastOneXSystemFundedPurchase, assessOneXSystemFundingCooldown, getSystemFundingCooldownReleaseAt } = require("./deposit-policy");
const { queueTelegramMessageTx } = require("./telegram");
const { db: defaultDb, OneX, tfees, stock_limit, SYSTEM_ADMIN_RESERVE_RATIO, MAIL_PORT, SERVER_MAIL, SERVER_MAIL_PSWD } = require("./db");

BigNumber.config({ DECIMAL_PLACES: 36, ROUNDING_MODE: BigNumber.ROUND_HALF_UP });

const CHAIN_ID = 56n;
const XTU_SCALE = 10n ** 18n;
const ERC20_TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const XTU_INTERFACE = new Interface(XTU_ABI);
const EVENT_ABI = XTU_INTERFACE.getEvent("TransferWithFee");
const TRANSFER_ABI = new Interface(["event Transfer(address indexed from,address indexed to,uint256 value)"]);
const FEE_ABI = new Interface(["event FeeCollected(address indexed from,address indexed collector,uint256 amount)"]);
const EMAIL_TRANSPORTER = SERVER_MAIL && SERVER_MAIL_PSWD
  ? nodemailer.createTransport({
    host: process.env.SMTP_HOST || "smtp.gmail.com",
    port: MAIL_PORT || 587,
    secure: Number(MAIL_PORT) === 465,
    auth: { user: SERVER_MAIL, pass: SERVER_MAIL_PSWD },
  })
  : null;

function getPoolConnection(pool) {
  return new Promise((resolve, reject) => {
    pool.getConnection((error, connection) => error ? reject(error) : resolve(connection));
  });
}

async function withTransaction(pool, work, maxAttempts = 3) {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const connection = await getPoolConnection(pool);
    const tx = connection.promise();
    try {
      await tx.beginTransaction();
      const result = await work(tx);
      await tx.commit();
      return result;
    } catch (error) {
      try { await tx.rollback(); } catch (rollbackError) {
        console.error("XTU deposit transaction rollback failed:", rollbackError.message);
      }
      if (!error || !["ER_LOCK_DEADLOCK", "ER_LOCK_WAIT_TIMEOUT"].includes(error.code) || attempt === maxAttempts) throw error;
    } finally {
      connection.release();
    }
    await new Promise((resolve) => setTimeout(resolve, attempt * 50));
  }
  throw new Error("XTU deposit transaction retry limit reached.");
}

function utcDateTime(timestamp = Date.now()) {
  const date = new Date(Number(timestamp));
  const dateNumber = Number(`${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, "0")}${String(date.getUTCDate()).padStart(2, "0")}`);
  const time = `${String(date.getUTCHours()).padStart(2, "0")}${String(date.getUTCMinutes()).padStart(2, "0")}${String(date.getUTCSeconds()).padStart(2, "0")}`;
  return [dateNumber, time];
}

function safeAddress(value) {
  try { return getAddress(String(value)); } catch { return null; }
}

function eventIdentity(txHash, logIndex) {
  return keccak256(toUtf8Bytes(`${String(txHash).toLowerCase()}:${Number(logIndex)}`)).slice(2);
}

function addressTopic(address) {
  return `0x${String(address).toLowerCase().replace(/^0x/, "").padStart(64, "0")}`;
}

function parseTransfer(log) {
  try { return TRANSFER_ABI.parseLog(log); } catch { return null; }
}

function parseFee(log) {
  try { return FEE_ABI.parseLog(log); } catch { return null; }
}

function verifyDepositReceipt(receipt, eventLog, settings, parsed) {
  if (!receipt || Number(receipt.status) !== 1) throw new Error("The XTU deposit transaction receipt is not successful.");
  if (String(receipt.transactionHash || "").toLowerCase() !== String(eventLog.transactionHash || "").toLowerCase() ||
      Number(receipt.blockNumber) !== Number(eventLog.blockNumber) ||
      String(eventLog.address || "").toLowerCase() !== String(settings.tokenAddress).toLowerCase()) {
    throw new Error("The XTU deposit receipt does not match the scanned transaction, block or token contract.");
  }
  const matchingReceiptLog = (receipt.logs || []).find((log) =>
    Number(log.index) === Number(eventLog.index) &&
    String(log.address || "").toLowerCase() === String(eventLog.address || "").toLowerCase() &&
    String(log.data || "").toLowerCase() === String(eventLog.data || "").toLowerCase() &&
    JSON.stringify(log.topics || []).toLowerCase() === JSON.stringify(eventLog.topics || []).toLowerCase());
  if (!matchingReceiptLog) throw new Error("The scanned XTU event log is not present in the transaction receipt.");
  if (String(receipt.blockHash).toLowerCase() !== String(eventLog.blockHash).toLowerCase()) {
    throw new Error("The XTU deposit receipt block hash does not match the scanned event.");
  }
  const sender = getAddress(String(parsed.args.from));
  const receiver = getAddress(String(parsed.args.to));
  const gross = BigInt(parsed.args.grossAmount);
  const net = BigInt(parsed.args.netAmount);
  const fee = BigInt(parsed.args.feeAmount);
  const feeExempt = Boolean(parsed.args.feeExempt);
  const expectedFee = (gross * 10n) / 10_000n;
  if (receiver !== settings.mainWalletAddress || sender === settings.distributionAddress || feeExempt) {
    throw new Error("The XTU transfer is not an external deposit into the configured Hot Wallet.");
  }
  if (gross <= 0n || fee !== expectedFee || net + fee !== gross) {
    throw new Error("The XTU TransferWithFee event has inconsistent gross, net or 0.1% commission values.");
  }
  let hotTransfer = false;
  let distributionFee = fee === 0n;
  for (const log of receipt.logs || []) {
    if (String(log.address).toLowerCase() !== settings.tokenAddress.toLowerCase()) continue;
    const transfer = parseTransfer(log);
    if (transfer && getAddress(String(transfer.args.from)) === sender &&
        getAddress(String(transfer.args.to)) === settings.mainWalletAddress && BigInt(transfer.args.value) === net) {
      hotTransfer = true;
    }
    const collected = parseFee(log);
    if (collected && getAddress(String(collected.args.from)) === sender &&
        getAddress(String(collected.args.collector)) === settings.distributionAddress && BigInt(collected.args.amount) === fee) {
      distributionFee = true;
    }
  }
  if (!hotTransfer || !distributionFee) {
    throw new Error("The XTU deposit receipt does not reconcile with the Hot Wallet Transfer and Distribution Wallet commission events.");
  }
  return { sender, gross, net, fee };
}

async function acquireDepositLocks(tx) {
  for (const lockName of ["common_state", "onex_xtu_wallet_spend", "onex_xtu_main_wallet_spend"]) {
    const [rows] = await tx.query("SELECT lock_name FROM system_locks WHERE lock_name=? FOR UPDATE", [lockName]);
    if (!rows.length) throw new Error(`The ${lockName} lock row has not been initialized.`);
  }
}

async function initializeScannerState(pool, provider, settings) {
  const existing = await pool.queryAsync("SELECT * FROM xtu_deposit_scan_state WHERE singleton_id=1 LIMIT 1");
  if (existing.length) {
    const row = existing[0];
    if (Number(row.chain_id) !== 56 || String(row.token_contract).toLowerCase() !== settings.tokenAddress.toLowerCase() ||
        String(row.hot_wallet_address).toLowerCase() !== settings.mainWalletAddress.toLowerCase()) {
      throw new Error("The persisted XTU deposit scanner identity does not match the configured chain, token and Hot Wallet.");
    }
    return row;
  }
  if (!/^\d{1,20}$/.test(settings.incomingStartBlock)) {
    throw new Error("XTU_INCOMING_START_BLOCK must be explicitly configured before enabling XTU deposits.");
  }
  const startBlock = BigInt(settings.incomingStartBlock);
  const latest = await provider.getBlockNumber();
  const finalized = Math.max(0, latest - settings.minConfirmations + 1);
  if (startBlock > BigInt(finalized)) throw new Error("XTU_INCOMING_START_BLOCK cannot be ahead of the currently finalized BSC block.");
  await pool.queryAsync(
    `INSERT INTO xtu_deposit_scan_state
     (singleton_id,chain_id,token_contract,hot_wallet_address,start_block,last_scanned_block,last_finalized_block,
      finality_method,health_status,updated_at_ms)
     VALUES(1,56,?,?,?,?,?,'confirmations','healthy',?)`,
    [settings.tokenAddress, settings.mainWalletAddress, startBlock.toString(), (startBlock - 1n).toString(), String(finalized), String(Date.now())],
  );
  return (await pool.queryAsync("SELECT * FROM xtu_deposit_scan_state WHERE singleton_id=1 LIMIT 1"))[0];
}

async function notifyUserTx(tx, username, eventKey, subject, message) {
  await queueTelegramMessageTx(tx, username, eventKey, message);
  const [rows] = await tx.query("SELECT email FROM auths WHERE username=? LIMIT 1 FOR UPDATE", [username]);
  const recipient = String(rows[0]?.email || "").trim();
  if (recipient && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient)) {
    await tx.query(
      `INSERT IGNORE INTO xtu_deposit_email_outbox
       (event_key,username,recipient,subject,message_text,status,attempts,next_attempt_at_ms,created_at_ms)
       VALUES(?,?,?, ?,?,'pending',0,?,?)`,
      [eventKey, username, recipient, subject.slice(0, 200), message, String(Date.now()), String(Date.now())],
    );
  }
}

async function createDepositBatchTx(tx, username, settings, blockTimestampMs, status = "collecting", reason = null, globalRunId = null) {
  const timestamp = Number(blockTimestampMs);
  const expiresAt = timestamp + settings.depositBatchWindowMs;
  const initialDeadline = timestamp + settings.depositInitialGroupingTimeoutMs;
  const pendingSince = status === "collecting" ? null : timestamp;
  const retryAfterDelay = status === "pending_weekly" || status === "pending_minimum";
  const releaseAt = retryAfterDelay ? timestamp + settings.depositPendingRetryMs : null;
  const [result] = await tx.query(
    `INSERT INTO xtu_deposit_batches
     (username,hot_wallet_address,opened_at_ms,expires_at_ms,initial_group_deadline_ms,global_run_id,
      pending_since_ms,release_at_ms,status,reason_codes,tfees_rate_percent,created_at_ms,updated_at_ms)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [username, settings.mainWalletAddress, String(timestamp), String(expiresAt), String(initialDeadline), globalRunId,
      pendingSince == null ? null : String(pendingSince), releaseAt == null ? null : String(releaseAt),
      status, reason ? JSON.stringify([reason]) : "[]", new BigNumber(tfees).toFixed(10), String(Date.now()), String(Date.now())],
  );
  return String(result.insertId);
}

async function assignDepositEventTx(tx, event, settings) {
  const identity = eventIdentity(event.txHash, event.logIndex);
  const [existingEventRows] = await tx.query(
    `SELECT id FROM xtu_deposit_transfer_events WHERE event_identity=? LIMIT 1 FOR UPDATE`, [identity],
  );
  if (existingEventRows.length) return { status: "duplicate" };
  const [authRows] = await tx.query(
    `SELECT username,email,account_active,wallet_address FROM auths
     WHERE LOWER(wallet_address)=LOWER(?) LIMIT 1 FOR UPDATE`,
    [event.sender],
  );
  if (!authRows.length) {
    await tx.query(
      `INSERT IGNORE INTO xtu_deposit_transfer_events
       (username,batch_id,token_contract,from_address,hot_wallet_address,gross_amount,net_amount,commission_amount,
        gross_amount_raw,net_amount_raw,commission_amount_raw,tx_hash,log_index,block_number,block_hash,
        block_timestamp_ms,event_identity,status,reason_codes,created_at_ms)
       VALUES(NULL,NULL,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'pending_identity','["wallet_not_linked"]',?)`,
      [settings.tokenAddress, event.sender, settings.mainWalletAddress,
        new BigNumber(event.gross.toString()).shiftedBy(-18).toFixed(18),
        new BigNumber(event.net.toString()).shiftedBy(-18).toFixed(18),
        new BigNumber(event.fee.toString()).shiftedBy(-18).toFixed(18),
        event.gross.toString(), event.net.toString(), event.fee.toString(), event.txHash,
        String(event.logIndex), String(event.blockNumber), event.blockHash, String(event.blockTimestampMs), identity, String(Date.now())],
    );
    return { status: "pending_identity" };
  }
  const username = authRows[0].username;
  const eventTimestamp = Number(event.blockTimestampMs);
  const [globalRows] = await tx.query(
    `SELECT id,status,effective_at_ms FROM global_disbursement_runs
     WHERE status IN ('active','closed','manual_review','completed','resolved')
     ORDER BY id DESC LIMIT 1 FOR UPDATE`,
  );
  const candidateGlobal = globalRows[0] || null;
  const eventGlobalRunId = candidateGlobal && isGlobalDisbursementEffective(candidateGlobal.status) &&
    eventTimestamp >= Number(candidateGlobal.effective_at_ms || Number.MAX_SAFE_INTEGER)
    ? String(candidateGlobal.id) : null;
  const incoming = new BigNumber(event.gross.toString()).shiftedBy(-18);
  const [activeRows] = await tx.query(
    `SELECT * FROM xtu_deposit_batches WHERE username=? AND status='collecting'
     ORDER BY id DESC LIMIT 1 FOR UPDATE`, [username],
  );
  let activeBatch = activeRows[0] || null;
  if (activeBatch && String(activeBatch.global_run_id || "") !== String(eventGlobalRunId || "")) {
    const priorGross = new BigNumber(activeBatch.gross_amount || "0");
    const priorStatus = priorGross.gte(MIN_XTU_DEPOSIT) && priorGross.lte(MAX_XTU_DEPOSIT)
      ? "ready" : (priorGross.gt(MAX_XTU_DEPOSIT) ? "pending_support" : "pending_minimum");
    const priorReason = priorStatus === "pending_support"
      ? JSON.stringify(["deposit_session_above_maximum"])
      : (priorStatus === "pending_minimum" ? JSON.stringify(["minimum_not_reached"]) : "[]");
    const [latestPriorEventRows] = await tx.query(
      "SELECT MAX(CAST(block_timestamp_ms AS UNSIGNED)) AS latest_event_ms FROM xtu_deposit_transfer_events WHERE batch_id=?",
      [String(activeBatch.id)],
    );
    const latestPriorEvent = Number(latestPriorEventRows[0]?.latest_event_ms || activeBatch.opened_at_ms);
    await tx.query(
      `UPDATE xtu_deposit_batches SET status=?,pending_since_ms=?,release_at_ms=?,reason_codes=?,updated_at_ms=? WHERE id=? AND status='collecting'`,
      [priorStatus, priorStatus === "ready" || priorStatus === "pending_support" ? null : String(Date.now()),
        priorStatus === "ready" || priorStatus === "pending_support" ? null : String(latestPriorEvent + settings.depositPendingRetryMs),
        priorReason, String(Date.now()), String(activeBatch.id)],
    );
    activeBatch = null;
  }
  if (activeBatch && eventTimestamp > Number(activeBatch.expires_at_ms)) {
    const priorGross = new BigNumber(activeBatch.gross_amount || "0");
    const priorStatus = priorGross.gte(MIN_XTU_DEPOSIT) && priorGross.lte(MAX_XTU_DEPOSIT)
      ? "ready" : (priorGross.gt(MAX_XTU_DEPOSIT) ? "pending_support" : "pending_minimum");
    const priorReason = priorStatus === "pending_support"
      ? JSON.stringify(["deposit_session_above_maximum"])
      : (priorStatus === "pending_minimum" ? JSON.stringify(["minimum_not_reached"]) : "[]");
    const [latestPriorEventRows] = await tx.query(
      "SELECT MAX(CAST(block_timestamp_ms AS UNSIGNED)) AS latest_event_ms FROM xtu_deposit_transfer_events WHERE batch_id=?",
      [String(activeBatch.id)],
    );
    const latestPriorEvent = Number(latestPriorEventRows[0]?.latest_event_ms || activeBatch.opened_at_ms);
    await tx.query(
      `UPDATE xtu_deposit_batches SET status=?,pending_since_ms=?,release_at_ms=?,reason_codes=?,updated_at_ms=?
       WHERE id=? AND status='collecting'`,
      [priorStatus,
        priorStatus === "ready" || priorStatus === "pending_support" ? null : String(Date.now()),
        priorStatus === "ready" || priorStatus === "pending_support" ? null : String(latestPriorEvent + settings.depositPendingRetryMs),
        priorReason, String(Date.now()), String(activeBatch.id)],
    );
    activeBatch = null;
  }

  const currentSessionAmount = new BigNumber(activeBatch?.gross_amount || "0");
  const sessionDecision = classifyDepositSession({
    incomingGross: incoming,
    currentBatchGross: activeBatch ? currentSessionAmount : 0,
  });
  let batchId;
  let eventStatus = "detected";
  let reason = null;

  if (Number(authRows[0].account_active) !== 1) {
    reason = "account_inactive";
    batchId = await createDepositBatchTx(tx, username, settings, eventTimestamp, "pending_support", reason, eventGlobalRunId);
    eventStatus = "pending_support";
  } else if (!sessionDecision.allowed) {
    reason = sessionDecision.reason;
    batchId = await createDepositBatchTx(tx, username, settings, eventTimestamp, "pending_support", reason, eventGlobalRunId);
    eventStatus = "pending_support";
  } else if (activeBatch) {
    batchId = String(activeBatch.id);
  } else {
    const [lastRows] = await tx.query(
      `SELECT * FROM xtu_deposit_batches WHERE username=? ORDER BY id DESC LIMIT 1 FOR UPDATE`, [username],
    );
    const lastBatch = lastRows[0] || null;
    if (lastBatch && lastBatch.status === "pending_minimum" &&
        String(lastBatch.global_run_id || "") === String(eventGlobalRunId || "") &&
        eventTimestamp <= Number(lastBatch.initial_group_deadline_ms || 0)) {
      const reopenedDecision = classifyDepositSession({ incomingGross: incoming, currentBatchGross: lastBatch.gross_amount || 0 });
      if (!reopenedDecision.allowed) {
        reason = reopenedDecision.reason;
        batchId = await createDepositBatchTx(tx, username, settings, eventTimestamp, "pending_support", reason, eventGlobalRunId);
        eventStatus = "pending_support";
      } else {
        await tx.query(
          `UPDATE xtu_deposit_batches SET status='collecting',expires_at_ms=?,pending_since_ms=NULL,
           release_at_ms=NULL,reason_codes='[]',updated_at_ms=? WHERE id=? AND status='pending_minimum'`,
          [String(eventTimestamp + settings.depositBatchWindowMs), String(Date.now()), String(lastBatch.id)],
        );
        activeBatch = { ...lastBatch, status: "collecting", expires_at_ms: String(eventTimestamp + settings.depositBatchWindowMs) };
        batchId = String(activeBatch.id);
      }
    } else if (lastBatch && !["credited", "rejected", "reversed"].includes(String(lastBatch.status))) {
      reason = eventTimestamp > Number(lastBatch.initial_group_deadline_ms || 0)
        ? "outside_initial_grouping_window" : "previous_batch_unresolved";
      batchId = await createDepositBatchTx(tx, username, settings, eventTimestamp, "pending_support", reason, eventGlobalRunId);
      eventStatus = "pending_support";
    } else {
      batchId = await createDepositBatchTx(tx, username, settings, eventTimestamp, "collecting", null, eventGlobalRunId);
    }
  }

  const [insertResult] = await tx.query(
    `INSERT IGNORE INTO xtu_deposit_transfer_events
     (username,batch_id,token_contract,from_address,hot_wallet_address,gross_amount,net_amount,commission_amount,
      gross_amount_raw,net_amount_raw,commission_amount_raw,tx_hash,log_index,block_number,block_hash,
      block_timestamp_ms,event_identity,status,reason_codes,created_at_ms)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [username, batchId, settings.tokenAddress, event.sender, settings.mainWalletAddress,
      incoming.toFixed(18), new BigNumber(event.net.toString()).shiftedBy(-18).toFixed(18),
      new BigNumber(event.fee.toString()).shiftedBy(-18).toFixed(18), event.gross.toString(), event.net.toString(),
      event.fee.toString(), event.txHash, String(event.logIndex), String(event.blockNumber), event.blockHash,
      String(eventTimestamp), identity, eventStatus, reason ? JSON.stringify([reason]) : "[]", String(Date.now())],
  );
  if (Number(insertResult.affectedRows || 0) !== 1) return { status: "duplicate" };

  await tx.query(
    `UPDATE xtu_deposit_batches SET gross_amount=gross_amount+?,hot_wallet_received_amount=hot_wallet_received_amount+?,
     commission_amount=commission_amount+?,remaining_amount=remaining_amount+?,transfer_count=transfer_count+1,updated_at_ms=?
     WHERE id=?`,
    [incoming.toFixed(18), new BigNumber(event.net.toString()).shiftedBy(-18).toFixed(18),
      new BigNumber(event.fee.toString()).shiftedBy(-18).toFixed(18), incoming.toFixed(18), String(Date.now()), batchId],
  );
  if (reason) {
    await notifyUserTx(
      tx, username, `xtu-deposit:${batchId}:${reason}`, "OneX XTU deposit pending",
      `Your XTU deposit has been detected and finalized, but it is pending because: ${reason}. Please contact OneX support by email or phone to review this deposit. Reference: ${event.txHash}.`,
    );
  }
  return { status: eventStatus, username, batchId };
}

async function scanIncomingEvents(pool, provider, settings) {
  const state = await initializeScannerState(pool, provider, settings);
  if (state.health_status === "manual_review") throw new Error("The XTU deposit scanner is blocked pending manual reorganization review.");
  const latestBlock = await provider.getBlockNumber();
  const finalizedBlock = Math.max(0, latestBlock - settings.minConfirmations + 1);
  if (state.last_scanned_block_hash && Number(state.last_scanned_block) >= 0) {
    const checkpoint = await provider.getBlock(Number(state.last_scanned_block));
    if (!checkpoint || String(checkpoint.hash).toLowerCase() !== String(state.last_scanned_block_hash).toLowerCase()) {
      await pool.queryAsync(
        `UPDATE xtu_deposit_scan_state SET health_status='manual_review',last_error=?,updated_at_ms=? WHERE singleton_id=1`,
        ["A previously scanned XTU block hash changed; automatic cursor rollback is blocked to prevent duplicate credits.", String(Date.now())],
      );
      throw new Error("XTU deposit scanner detected a reorganization; manual review is required.");
    }
  }

  let cursor = BigInt(state.last_scanned_block);
  const target = BigInt(finalizedBlock);
  while (cursor < target) {
    const from = cursor + 1n;
    const to = BigInt(Math.min(Number(from) + settings.depositMaxLogBlockRange - 1, finalizedBlock));
    const logs = await provider.getLogs({
      address: settings.tokenAddress,
      topics: [EVENT_ABI.topicHash, null, addressTopic(settings.mainWalletAddress)],
      fromBlock: Number(from),
      toBlock: Number(to),
    });
    for (const log of logs) {
      const parsed = XTU_INTERFACE.parseLog(log);
      if (!parsed || parsed.name !== "TransferWithFee") continue;
      const receipt = await provider.getTransactionReceipt(log.transactionHash);
      const verified = verifyDepositReceipt(receipt, log, settings, parsed);
      const canonicalBlock = await provider.getBlock(Number(log.blockNumber));
      if (!canonicalBlock || String(canonicalBlock.hash).toLowerCase() !== String(log.blockHash).toLowerCase()) {
        throw new Error("XTU deposit log is not in the canonical block chain.");
      }
      const blockTimestampMs = Number(canonicalBlock.timestamp) * 1000;
      await withTransaction(pool, (tx) => assignDepositEventTx(tx, {
        sender: verified.sender,
        gross: verified.gross,
        net: verified.net,
        fee: verified.fee,
        txHash: log.transactionHash,
        logIndex: log.index,
        blockNumber: log.blockNumber,
        blockHash: log.blockHash,
        blockTimestampMs,
      }, settings));
    }
    cursor = to;
    const block = await provider.getBlock(Number(cursor));
    await pool.queryAsync(
      `UPDATE xtu_deposit_scan_state SET last_scanned_block=?,last_scanned_block_hash=?,last_finalized_block=?,
       finality_method='confirmations',health_status='healthy',last_error=NULL,updated_at_ms=? WHERE singleton_id=1`,
      [cursor.toString(), block?.hash || null, String(finalizedBlock), String(Date.now())],
    );
  }
  await pool.queryAsync(
    `UPDATE xtu_deposit_scan_state SET last_finalized_block=?,health_status='healthy',last_error=NULL,updated_at_ms=?
     WHERE singleton_id=1`, [String(finalizedBlock), String(Date.now())],
  );
  return { scannedThrough: cursor.toString(), finalizedBlock: String(finalizedBlock) };
}

async function getGlobalRunTx(tx, runId = null) {
  // The batch stores the global-run identity at event time. A null value is
  // an immutable pre-activation snapshot and must not inherit a later run.
  if (runId == null || String(runId).trim() === "") return null;
  const [rows] = await tx.query(
    `SELECT id,status,effective_at_ms FROM global_disbursement_runs
     WHERE id=? AND status IN ('active','closed','manual_review','completed','resolved') LIMIT 1 FOR UPDATE`, [String(runId)],
  );
  const row = rows[0] || null;
  return row && isGlobalDisbursementEffective(row.status) ? row : null;
}

async function getXtuBatchSystemPurchaseStateTx(tx, batch) {
  // This is the same cross-asset allowance as BSC-USD. A type-2 activity
  // with sender=OneX counts once regardless of amount; XUSER seller funding
  // is deliberately excluded. The same batch may continue in later tranches.
  const lastSystemPurchase = await getLastOneXSystemFundedPurchase(tx, batch.username, OneX);
  const cooldown = assessOneXSystemFundingCooldown(lastSystemPurchase, Date.now());
  const [sameBatchSystemRows] = await tx.query(
    `SELECT 1
     FROM xtu_deposit_credits c
     INNER JOIN activities a ON a.reference=CONCAT(c.reference,'O')
     WHERE c.batch_id=? AND c.username=? AND a.sender=? AND a.receiver=? AND a.type=2
     LIMIT 1 FOR UPDATE`,
    [String(batch.id), batch.username, OneX, batch.username],
  );
  return {
    cooldown,
    sameBatchAlreadyUsedSystemPurchase: sameBatchSystemRows.length > 0,
    systemFundingAllowed: cooldown.allowed || sameBatchSystemRows.length > 0,
  };
}

function getXtuWeeklyCooldownReleaseAt(batch, cooldown) {
  const pendingSince = Number(batch.pending_since_ms || Date.now());
  return getSystemFundingCooldownReleaseAt(pendingSince, cooldown.lastPurchaseMs);
}

async function allocateXtuDepositFundingTx(tx, batch, credit, common, sellerAvailable) {
  const purchaseState = await getXtuBatchSystemPurchaseStateTx(tx, batch);
  const allocation = purchaseState.systemFundingAllowed
    ? calculateDepositFundingAllocation(
      credit.creditedInitialAsset, common.unit_price, common.backed_units,
      common.inactive_init_asset, sellerAvailable, common.total_units_price,
      calculateRemainingSystemAdminReserve(
        stock_limit, SYSTEM_ADMIN_RESERVE_RATIO, common.sys_inactive_init_asset || "0",
      ).remainingInitialAsset, 0,
    )
    : calculateSellerOnlyDepositFundingAllocation(
      credit.creditedInitialAsset, common.unit_price, common.backed_units,
      common.inactive_init_asset, sellerAvailable, common.total_units_price,
      calculateRemainingSystemAdminReserve(
        stock_limit, SYSTEM_ADMIN_RESERVE_RATIO, common.sys_inactive_init_asset || "0",
      ).remainingInitialAsset,
    );
  return { ...purchaseState, allocation };
}

async function assessBatchCapacityTx(tx, batch, gasUsdEstimate, settings) {
  const common = await getLatestCommonTx(tx, true);
  const globalRun = await getGlobalRunTx(tx, batch.global_run_id || null);
  const [priorCreditRows] = await tx.query(
    `SELECT COALESCE(SUM(creditable_xtu),0) AS amount,COUNT(*) AS credit_count
     FROM xtu_deposit_credits WHERE batch_id=? FOR UPDATE`, [String(batch.id)],
  );
  const credit = calculateXtuDepositTranche({
    grossReturnedXtu: batch.gross_amount,
    actualGasFeeBscUsd: gasUsdEstimate,
    tfeesRatePercent: batch.tfees_rate_percent ?? tfees,
    globalDisbursementActive: Boolean(globalRun),
    globalUnitPrice: common.unit_price,
    creditedBeforeXtu: priorCreditRows[0]?.amount || "0",
    creditSequence: Number(batch.credit_sequence || 0),
    maximumInitialCreditXtu: settings.depositInitialCreditCap,
  });
  const sellerAvailable = await getActiveSellerReserveAvailableTx(tx, batch.username);
  const funding = await allocateXtuDepositFundingTx(tx, batch, credit, common, sellerAvailable);
  const allocation = funding.allocation;
  if (!allocation.available) {
    return {
      allowed: false,
      reason: funding.systemFundingAllowed ? "insufficient_reserves" : "system_funding_cooldown",
      credit, allocation, common, globalRun, cooldown: funding.cooldown,
    };
  }
  const [stockRows] = await tx.query("SELECT balance FROM users_stock WHERE username=? LIMIT 1 FOR UPDATE", [batch.username]);
  if (!stockRows.length) return { allowed: false, reason: "stock_missing", credit, allocation, common, globalRun };
  const currentBalance = new BigNumber(stockRows[0].balance);
  const nextBalance = currentBalance.plus(credit.creditedInitialAsset);
  const priceState = await getUserPriceStateTx(tx, batch.username, true);
  if (!priceState) return { allowed: false, reason: "remuneration_state_missing", credit, allocation, common, globalRun };
  const userCapacity = previewUserOperationCapacity(
    priceState, "purchase", credit.creditedInitialAsset, currentBalance, nextBalance, common.unit_price,
  );
  if (!userCapacity.allowed) return { allowed: false, reason: "maximum_user_balance", credit, allocation, common, globalRun };
  return { allowed: true, credit, allocation, common, globalRun, currentBalance, nextBalance, userCapacity };
}

async function closeExpiredBatches(pool, settings) {
  const rows = await pool.queryAsync(
    `SELECT id,username,gross_amount,opened_at_ms,expires_at_ms,initial_group_deadline_ms
     FROM xtu_deposit_batches WHERE status='collecting' AND CAST(expires_at_ms AS UNSIGNED)<=?
     ORDER BY id ASC LIMIT 20`, [String(Date.now())],
  );
  for (const row of rows) {
    await withTransaction(pool, async (tx) => {
      const [batchRows] = await tx.query("SELECT * FROM xtu_deposit_batches WHERE id=? LIMIT 1 FOR UPDATE", [String(row.id)]);
      if (!batchRows.length || batchRows[0].status !== "collecting") return;
      const batch = batchRows[0];
      const gross = new BigNumber(batch.gross_amount);
      const now = Date.now();
      if (gross.gte(MIN_XTU_DEPOSIT) && gross.lte(MAX_XTU_DEPOSIT)) {
        await tx.query("UPDATE xtu_deposit_batches SET status='ready',reason_codes='[]',updated_at_ms=? WHERE id=?", [String(now), String(row.id)]);
      } else if (gross.gt(MAX_XTU_DEPOSIT)) {
        await tx.query(
          `UPDATE xtu_deposit_batches SET status='pending_support',pending_since_ms=NULL,release_at_ms=NULL,
           reason_codes='["deposit_session_above_maximum"]',updated_at_ms=? WHERE id=?`,
          [String(now), String(row.id)],
        );
        await notifyUserTx(
          tx, batch.username, `xtu-deposit:${row.id}:session-maximum`, "OneX XTU deposit requires support review",
          `Your 60-minute XTU deposit session exceeds the 100 XTU maximum. It is held for manual support review and will not be automatically released after seven days. Batch: ${row.id}.`,
        );
      } else {
        const [latestRows] = await tx.query(
          "SELECT MAX(CAST(block_timestamp_ms AS UNSIGNED)) AS latest_event_ms FROM xtu_deposit_transfer_events WHERE batch_id=?",
          [String(row.id)],
        );
        const releaseAt = Number(latestRows[0]?.latest_event_ms || row.opened_at_ms) + settings.depositPendingRetryMs;
        await tx.query(
          `UPDATE xtu_deposit_batches SET status='pending_minimum',pending_since_ms=?,release_at_ms=?,
           reason_codes='["minimum_not_reached"]',updated_at_ms=? WHERE id=?`,
          [String(now), String(releaseAt), String(now), String(row.id)],
        );
        await notifyUserTx(
          tx, batch.username, `xtu-deposit:${row.id}:pending-minimum`, "OneX XTU deposit pending",
          `Your XTU deposit session is below the 20 XTU minimum. It may be completed within the initial grouping period. Batch: ${row.id}.`,
        );
      }
    });
  }
}

async function setBatchPending(pool, batchId, status, reason) {
  await withTransaction(pool, async (tx) => {
    const [rows] = await tx.query("SELECT * FROM xtu_deposit_batches WHERE id=? LIMIT 1 FOR UPDATE", [String(batchId)]);
    if (!rows.length || ["credited", "returned", "manual_review"].includes(rows[0].status)) return;
    const row = rows[0];
    const now = Date.now();
    await tx.query(
      `UPDATE xtu_deposit_batches SET status=?,pending_since_ms=COALESCE(pending_since_ms,?),
       release_at_ms=COALESCE(release_at_ms,?),reason_codes=?,updated_at_ms=? WHERE id=?`,
      [status, String(now), String(now + DEPOSIT_PENDING_RETRY_MS), JSON.stringify([reason]), String(now), String(batchId)],
    );
    await notifyUserTx(
      tx, row.username, `xtu-deposit:${batchId}:${reason}`, "OneX XTU deposit pending",
      `Your XTU deposit is pending because: ${reason}. No additional credit has been issued. Contact OneX support by email or phone. Batch: ${batchId}.`,
    );
  });
}

async function prepareConsolidation(pool, batches, runtime, mainSigner) {
  if (!Array.isArray(batches) || batches.length < 1) {
    throw new TypeError("At least one eligible XTU deposit batch is required for consolidation.");
  }
  const selected = selectXtuConsolidationBatches(
    batches,
    runtime.settings.depositConsolidationMinBatchXtu,
  );
  if (!selected || selected.batches.length !== batches.length) {
    throw new Error("The selected XTU deposit consolidation lot is below its 100 XTU minimum.");
  }

  const totalReceived = selected.totalHotWalletReceivedXtu;
  const totalGrossReturned = selected.totalGrossReturnedXtu;
  const rawAmount = BigInt(totalReceived.shiftedBy(18).integerValue(BigNumber.ROUND_DOWN).toFixed(0));
  if (rawAmount <= 0n || totalReceived.lt(runtime.settings.depositConsolidationMinBatchXtu)) {
    throw new Error("The XTU consolidation lot must contain at least 100 XTU actually received by the Hot Wallet.");
  }
  const data = runtime.contract.interface.encodeFunctionData("transfer", [runtime.settings.distributionAddress, rawAmount]);
  const bnbUsdPrice = await getBnbUsdPrice(runtime.provider, { forceRefresh: true });
  const estimate = await estimateBscTokenTransfer({
    provider: runtime.provider,
    fromAddress: runtime.settings.mainWalletAddress,
    tokenAddress: runtime.settings.tokenAddress,
    data,
    maximumGasLimit: runtime.settings.depositGasLimitCeiling,
    bnbUsdPrice,
  });
  const bufferedGasLimit = (estimate.gasLimit * 120n + 99n) / 100n;
  if (bufferedGasLimit > runtime.settings.depositGasLimitCeiling) throw new RangeError("XTU consolidation gas limit exceeds XTU_DEPOSIT_GAS_LIMIT.");
  const gasEstimate = require("./bsc-fee-accounting").calculateEstimatedGasFee(
    bufferedGasLimit.toString(), estimate.gasPrice.toString(), bnbUsdPrice,
  );
  const feeDecision = evaluateBscTxFee(gasEstimate.feeUsd, getConfiguredMaxBscTxFeeUsd());
  if (!feeDecision.allowed) {
    const error = new Error("Estimated XTU deposit consolidation gas exceeds the 0.4 BSC-USD transaction ceiling.");
    error.code = "BSC_GAS_FEE_LIMIT_EXCEEDED";
    throw error;
  }
  const [tokenBalance, nativeBalance] = await Promise.all([
    runtime.contract.balanceOf(runtime.settings.mainWalletAddress),
    runtime.provider.getBalance(runtime.settings.mainWalletAddress),
  ]);
  if (BigInt(tokenBalance) < rawAmount) throw new Error("The XTU Hot Wallet does not currently hold the exact identified deposit lot amount.");
  if (BigInt(nativeBalance) < BigInt(gasEstimate.feeBnb.shiftedBy(18).integerValue(BigNumber.ROUND_CEIL).toFixed(0))) {
    throw new Error("The XTU Hot Wallet does not have enough BNB for deposit consolidation gas.");
  }

  const grossRows = batches.map((batch) => ({ id: String(batch.id), gross_amount: String(batch.gross_amount) }));
  const estimatedUsdByBatch = new Map(allocateBatchGasByGross(grossRows, gasEstimate.feeUsd, "id").map((row) => [row.key, row.gasFee]));
  const estimatedBnbByBatch = new Map(allocateBatchGasByGross(grossRows, gasEstimate.feeBnb, "id").map((row) => [row.key, row.gasFee]));
  const nonce = await runtime.provider.getTransactionCount(runtime.settings.mainWalletAddress, "pending");
  const txRequest = {
    to: runtime.settings.tokenAddress,
    data,
    value: 0n,
    chainId: CHAIN_ID,
    nonce,
    gasLimit: bufferedGasLimit,
    gasPrice: estimate.gasPrice,
  };
  const rawTx = await mainSigner.signTransaction(txRequest);
  const txHash = keccak256(rawTx).toLowerCase();
  let persisted = false;

  await withTransaction(pool, async (tx) => {
    await acquireDepositLocks(tx);
    const ids = batches.map((batch) => String(batch.id));
    const placeholders = ids.map(() => "?").join(",");
    const [lockedBatches] = await tx.query(
      `SELECT * FROM xtu_deposit_batches WHERE id IN (${placeholders}) ORDER BY id ASC FOR UPDATE`, ids,
    );
    if (lockedBatches.length !== ids.length) return;
    const [existingItems] = await tx.query(
      `SELECT batch_id FROM xtu_deposit_consolidation_items WHERE batch_id IN (${placeholders}) LIMIT 1 FOR UPDATE`, ids,
    );
    if (existingItems.length) return;

    let lockedReceived = new BigNumber(0);
    let lockedGross = new BigNumber(0);
    for (const locked of lockedBatches) {
      if (!["ready", "pending_reserve", "pending_credit", "pending_weekly"].includes(String(locked.status))) return;
      if (locked.release_at_ms != null && Number(locked.release_at_ms) > Date.now() &&
          !["ready", "pending_weekly"].includes(String(locked.status))) return;
      const gross = new BigNumber(locked.gross_amount);
      const received = new BigNumber(locked.hot_wallet_received_amount);
      if (!gross.isFinite() || gross.lt(MIN_XTU_DEPOSIT) || gross.gt(MAX_XTU_DEPOSIT) ||
          !received.isFinite() || !received.isGreaterThan(0)) return;
      lockedReceived = lockedReceived.plus(received);
      lockedGross = lockedGross.plus(gross);
    }
    if (!lockedReceived.eq(totalReceived) || !lockedGross.eq(totalGrossReturned) ||
        lockedReceived.lt(runtime.settings.depositConsolidationMinBatchXtu)) return;

    await recordEstimatedBscFeeTx(tx, {
      txHash,
      operation: "xtu_deposit_consolidation",
      gasLimit: txRequest.gasLimit.toString(),
      gasPriceWei: txRequest.gasPrice.toString(),
      bnbUsdPrice,
    });
    const now = String(Date.now());
    const [insertResult] = await tx.query(
      `INSERT INTO xtu_deposit_consolidations
       (anchor_batch_id,amount,amount_raw,hot_wallet_address,distribution_address,estimated_gas_fee_bnb,
        estimated_gas_fee_usd,gas_bnb_usd_price,gas_limit,gas_price_wei,gas_allocation_method,
        raw_tx,tx_hash,nonce,status,created_at_ms,updated_at_ms)
       VALUES(?,?,?,?,?,?,?,?,?,?, 'gross_weighted_event_identity_v1', ?,?,?,'signed',?,?)`,
      [ids[0], totalReceived.toFixed(18), rawAmount.toString(),
        runtime.settings.mainWalletAddress, runtime.settings.distributionAddress, gasEstimate.feeBnb.toFixed(30),
        gasEstimate.feeUsd.toFixed(30), bnbUsdPrice.toFixed(18), bufferedGasLimit.toString(), estimate.gasPrice.toString(),
        rawTx, txHash, String(nonce), now, now],
    );
    const consolidationId = String(insertResult.insertId);
    for (const locked of lockedBatches) {
      const batchId = String(locked.id);
      const received = new BigNumber(locked.hot_wallet_received_amount);
      const gross = new BigNumber(locked.gross_amount);
      await tx.query(
        `INSERT INTO xtu_deposit_consolidation_items
         (consolidation_id,batch_id,username,gross_returned_xtu,hot_wallet_received_xtu,contract_commission_xtu,
          estimated_gas_fee_bnb,estimated_gas_fee_usd,allocated_gas_fee_bnb,allocated_gas_fee_usd,
          allocated_gas_fee_xtu,status,created_at_ms,updated_at_ms)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,'signed',?,?)`,
        [consolidationId, batchId, locked.username, gross.toFixed(18), received.toFixed(18),
          new BigNumber(locked.commission_amount || "0").toFixed(18),
          estimatedBnbByBatch.get(batchId).toFixed(30), estimatedUsdByBatch.get(batchId).toFixed(30),
          "0", "0", "0", now, now],
      );
      await tx.query(
        "UPDATE xtu_deposit_batches SET status='finalizing',updated_at_ms=? WHERE id=?",
        [now, batchId],
      );
    }
    persisted = true;
  });

  if (!persisted) return false;
  try {
    const sent = await runtime.provider.broadcastTransaction(rawTx);
    if (String(sent.hash).toLowerCase() !== txHash) throw new Error("BSC RPC returned a hash different from the persisted XTU consolidation transaction.");
    await pool.queryAsync(
      "UPDATE xtu_deposit_consolidations SET status='submitted',updated_at_ms=? WHERE tx_hash=? AND status='signed'",
      [String(Date.now()), txHash],
    );
  } catch (error) {
    // The exact raw transaction and deterministic hash are already persisted; the next cycle reconciles it.
    await pool.queryAsync(
      "UPDATE xtu_deposit_consolidations SET last_error=?,updated_at_ms=? WHERE tx_hash=? AND status IN ('signed','submitted')",
      [String(error.message || error).slice(0, 990), String(Date.now()), txHash],
    );
  }
  return true;
}

async function parseConsolidationReceipt(runtime, receipt, row) {
  let matching = null;
  for (const log of receipt.logs || []) {
    if (String(log.address).toLowerCase() !== runtime.settings.tokenAddress.toLowerCase()) continue;
    let parsed;
    try { parsed = runtime.contract.interface.parseLog(log); } catch { continue; }
    if (parsed?.name === "TransferWithFee" &&
        getAddress(String(parsed.args.from)) === runtime.settings.mainWalletAddress &&
        getAddress(String(parsed.args.to)) === runtime.settings.distributionAddress) {
      matching = parsed;
      break;
    }
  }
  if (!matching) throw new Error("The finalized XTU consolidation receipt is missing the Hot Wallet to Distribution Wallet TransferWithFee event.");
  const gross = BigInt(matching.args.grossAmount);
  const net = BigInt(matching.args.netAmount);
  const fee = BigInt(matching.args.feeAmount);
  if (!Boolean(matching.args.feeExempt) || fee !== 0n || net !== gross || gross !== BigInt(String(row.amount_raw))) {
    throw new Error("The Hot Wallet to Distribution Wallet consolidation did not use the exact zero-commission exemption.");
  }
  return { gross, net, fee };
}

async function creditConsolidatedBatchTx(tx, batch, consolidation, receipt, actualGas, settings) {
  const [batchRows] = await tx.query("SELECT * FROM xtu_deposit_batches WHERE id=? LIMIT 1 FOR UPDATE", [String(batch.id)]);
  if (!batchRows.length || ["credited", "manual_review"].includes(batchRows[0].status)) return;
  const currentBatch = batchRows[0];
  if (! ["consolidated_pending_credit", "pending_reserve", "pending_credit", "pending_weekly"].includes(currentBatch.status)) {
    throw new Error(`XTU deposit batch ${currentBatch.id} is not in a creditable state.`);
  }
  const globalRun = await getGlobalRunTx(tx, currentBatch.global_run_id || null);
  const common = await getLatestCommonTx(tx, true);
  const grossReturned = new BigNumber(currentBatch.returned_amount || currentBatch.gross_amount || "0");
  const [priorCreditRows] = await tx.query(
    `SELECT COALESCE(SUM(creditable_xtu),0) AS amount,COUNT(*) AS credit_count
     FROM xtu_deposit_credits WHERE batch_id=? FOR UPDATE`, [String(currentBatch.id)],
  );
  const priorCredited = new BigNumber(priorCreditRows[0]?.amount || "0");
  const creditSequence = Number(currentBatch.credit_sequence || 0);
  if (Number(priorCreditRows[0]?.credit_count || 0) !== creditSequence) {
    throw new Error("XTU deposit credit sequence does not match its idempotent credit ledger.");
  }
  const credit = calculateXtuDepositTranche({
    grossReturnedXtu: grossReturned,
    actualGasFeeBscUsd: actualGas.feeUsd,
    tfeesRatePercent: currentBatch.tfees_rate_percent ?? tfees,
    globalDisbursementActive: Boolean(globalRun),
    globalUnitPrice: common.unit_price,
    creditedBeforeXtu: priorCredited,
    creditSequence,
    maximumInitialCreditXtu: settings.depositInitialCreditCap,
  });
  const firstTranche = creditSequence === 0;
  const depositFeeForThisTranche = firstTranche ? credit.depositFeeXtu : new BigNumber(0);
  const gasFeeForThisTranche = firstTranche ? credit.actualGasFeeXtu : new BigNumber(0);

  const [stockRows] = await tx.query("SELECT balance FROM users_stock WHERE username=? LIMIT 1 FOR UPDATE", [currentBatch.username]);
  const [authRows] = await tx.query("SELECT email,wallet_address,account_active FROM auths WHERE username=? LIMIT 1 FOR UPDATE", [currentBatch.username]);
  if (!stockRows.length || !authRows.length || Number(authRows[0].account_active) !== 1) {
    throw new Error("The XTU deposit beneficiary account is not eligible for automatic credit.");
  }
  const currentBalance = new BigNumber(stockRows[0].balance);
  const newBalance = currentBalance.plus(credit.creditedInitialAsset);
  const priceState = await getUserPriceStateTx(tx, currentBatch.username, true);
  if (!priceState) throw new Error("The XTU deposit beneficiary has no individual remuneration state.");
  const capacity = previewUserOperationCapacity(
    priceState, "purchase", credit.creditedInitialAsset, currentBalance, newBalance, common.unit_price,
  );
  if (!capacity.allowed) throw new Error("The XTU deposit tranche would exceed the user's current initial-asset purchase capacity.");

  const sellerAvailable = await getActiveSellerReserveAvailableTx(tx, currentBatch.username);
  const funding = await allocateXtuDepositFundingTx(tx, currentBatch, credit, common, sellerAvailable);
  const allocation = funding.allocation;
  if (!allocation.available) {
    if (!funding.systemFundingAllowed) {
      const error = new Error("The user's weekly OneX system-funded purchase is already used and eligible seller campaign reserves cannot cover this XTU deposit tranche.");
      error.code = "XTU_SYSTEM_FUNDING_COOLDOWN";
      error.releaseAtMs = getXtuWeeklyCooldownReleaseAt(currentBatch, funding.cooldown);
      throw error;
    }
    throw new Error("The reserve hierarchy cannot cover this XTU deposit tranche at the final credit check.");
  }

  const [sourceEventRows] = await tx.query(
    `SELECT event_identity,tx_hash,log_index,block_hash,gross_amount,net_amount,commission_amount
     FROM xtu_deposit_transfer_events
     WHERE batch_id=? AND status NOT IN ('rejected','reversed')
     ORDER BY event_identity ASC FOR UPDATE`,
    [String(currentBatch.id)],
  );
  if (!sourceEventRows.length) {
    throw new Error("The consolidated XTU deposit has no finalized source-event audit rows.");
  }
  const sourceEventHashesJson = JSON.stringify(sourceEventRows.map((event) => ({
    event_identity: String(event.event_identity),
    tx_hash: String(event.tx_hash).toLowerCase(),
    log_index: Number(event.log_index),
    block_hash: String(event.block_hash).toLowerCase(),
    gross_amount: String(event.gross_amount),
    net_amount: String(event.net_amount),
    commission_amount: String(event.commission_amount),
  })));
  const sourceTransactionHash = String(sourceEventRows[0].tx_hash || "").toLowerCase();
  const consolidationTxHash = String(consolidation.tx_hash).toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(sourceTransactionHash) ||
      !/^0x[0-9a-f]{64}$/.test(consolidationTxHash)) {
    throw new Error("The XTU source deposit or consolidation transaction hash is invalid for the credit audit.");
  }
  const [date, time] = utcDateTime();
  const creditedSequence = creditSequence + 1;
  const reference = `XTUD${String(currentBatch.id).padStart(10, "0")}${String(creditedSequence).padStart(3, "0")}`.slice(0, 64);
  const sellerAllocation = allocation.consumedSellers.isGreaterThan(0)
    ? await consumeSellerReserveTx(tx, allocation.consumedSellers, reference, date, time, currentBatch.username)
    : { consumedInitialAsset: new BigNumber(0) };
  if (!sellerAllocation.consumedInitialAsset.eq(allocation.consumedSellers)) {
    throw new Error("The active seller reserve changed during XTU deposit credit.");
  }
  const remainingSellers = new BigNumber(common.sellers_res || "0").minus(allocation.consumedSellers);
  if (!remainingSellers.isFinite() || remainingSellers.isNegative()) {
    throw new Error("common.sellers_res cannot cover the active seller reserve consumption.");
  }
  const newTotal = allocation.newTotalUnitsPrice.plus(depositFeeForThisTranche);
  const newTfees = new BigNumber(common.total_tfees || "0").plus(
    depositFeeForThisTranche.isGreaterThan(0) ? depositFeeForThisTranche.dividedBy(common.unit_price) : 0,
  );
  const [creditInsert] = await tx.query(
    `INSERT INTO xtu_deposit_credits
     (batch_id,username,credit_sequence,gross_returned_xtu,deposit_fee_xtu,gas_fee_xtu,creditable_xtu,
      credited_initial_asset,global_unit_price,reference,global_run_id,source_event_hashes_json,
      consolidation_tx_hash,status,created_at_ms)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,'credited',?)`,
    [String(currentBatch.id), currentBatch.username, creditedSequence,
      firstTranche ? grossReturned.toFixed(18) : "0",
      depositFeeForThisTranche.toFixed(18), gasFeeForThisTranche.toFixed(18),
      credit.creditedInitialAsset.isFinite() ? credit.initialCreditXtu.toFixed(18) : "0",
      credit.creditedInitialAsset.toFixed(30), common.unit_price, reference,
      globalRun ? String(globalRun.id) : null, sourceEventHashesJson, consolidationTxHash, String(Date.now())], 
  );
  if (Number(creditInsert.affectedRows || 0) !== 1) throw new Error("XTU deposit credit audit row was not inserted.");

  await tx.query(
    `UPDATE users_stock SET balance=?,record_date=?,record_time=? WHERE username=?`,
    [newBalance.toFixed(30), date, time, currentBatch.username],
  );
  const sellerBasis = new BigNumber(allocation.sellerInitialAsset || "0");
  const systemBasis = new BigNumber(allocation.systemInitialAsset || "0");
  if (!sellerBasis.plus(systemBasis).eq(credit.creditedInitialAsset)) {
    throw new Error("The XTU deposit funding allocation does not reconcile to the credited initial assets.");
  }
  const totalFeeBasis = depositFeeForThisTranche.dividedBy(common.unit_price);
  const sellerFeeBasis = credit.creditedInitialAsset.isGreaterThan(0)
    ? totalFeeBasis.multipliedBy(sellerBasis).dividedBy(credit.creditedInitialAsset)
    : new BigNumber(0);
  const systemFeeBasis = totalFeeBasis.minus(sellerFeeBasis);
  const sellerGasCost = credit.creditedInitialAsset.isGreaterThan(0)
    ? actualGas.feeUsd.multipliedBy(sellerBasis).dividedBy(credit.creditedInitialAsset)
    : new BigNumber(0);
  const systemGasCost = actualGas.feeUsd.minus(sellerGasCost);
  if (sellerBasis.isGreaterThan(0)) {
    await tx.query(
      `INSERT INTO activities
       (sender,receiver,type,amount,unit_price,fees,fee_unit_price,bsc_fee_cost_usd,reference,record_date,record_time)
       VALUES('XUSER',?,?,?, ?,?,?,?,?,?,?)`,
      [currentBatch.username, 2, sellerBasis.toFixed(30), common.unit_price,
        sellerFeeBasis.toFixed(30), common.unit_price, sellerGasCost.toFixed(30), `${reference}S`.slice(0, 64), date, time],
    );
  }
  if (systemBasis.isGreaterThan(0)) {
    await tx.query(
      `INSERT INTO activities
       (sender,receiver,type,amount,unit_price,fees,fee_unit_price,bsc_fee_cost_usd,reference,record_date,record_time)
       VALUES(?,?,2,?,?,?,?,?,?,?,?)`,
      [OneX, currentBatch.username, systemBasis.toFixed(30), common.unit_price,
        systemFeeBasis.toFixed(30), common.unit_price, systemGasCost.toFixed(30), `${reference}O`.slice(0, 64), date, time],
    );
  }
  await insertCommonSnapshotTx(tx, common, {
    total_units_price: newTotal.toFixed(30),
    backed_units: allocation.newBacked.toFixed(30),
    inactive_init_asset: allocation.newInactive.toFixed(30),
    sellers_res: remainingSellers.toFixed(30),
    total_tfees: newTfees.toFixed(30),
  }, date, time);

  let settlement = null;
  if (globalRun) {
    const netPayout = credit.initialCreditXtu;
    const quote = calculateXtuSettlementQuote(netPayout);
    const [ledgerResult] = await tx.query(
      `INSERT INTO xtu_global_settlement_ledger
       (global_run_id,username,deposit_batch_id,credit_sequence,tx_hash,source_event_hashes_json,
        consolidation_tx_hash,gross_returned_xtu,deposit_fee_xtu,gas_fee_xtu,global_unit_price,
        credited_initial_asset,reserved_xtu_amount,remaining_xtu_amount,settled_xtu_amount,
        status,created_at_ms,updated_at_ms)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,'reserved',?,?)`,
      [String(globalRun.id), currentBatch.username, String(currentBatch.id), creditedSequence,
        sourceTransactionHash, sourceEventHashesJson, consolidationTxHash,
        firstTranche ? grossReturned.toFixed(18) : "0",
        depositFeeForThisTranche.toFixed(18), gasFeeForThisTranche.toFixed(18), common.unit_price,
        credit.creditedInitialAsset.toFixed(30), netPayout.toFixed(18), netPayout.toFixed(18),
        String(Date.now()), String(Date.now())], 
    );
    await tx.query(
      `INSERT INTO xtu_global_settlement_payouts
       (ledger_id,global_run_id,username,payout_address,net_amount,gross_amount,contract_fee_amount,
        status,created_at_ms,updated_at_ms)
       VALUES(?,?,?,?,?,?,?,'queued',?,?)`,
      [String(ledgerResult.insertId), String(globalRun.id), currentBatch.username,
        getAddress(String(authRows[0].wallet_address)), quote.requestedNet.toFixed(18), quote.grossAmount.toFixed(18),
        quote.contractFeeAmount.toFixed(18), String(Date.now()), String(Date.now())],
    );
    settlement = { ledgerId: String(ledgerResult.insertId), payoutNet: netPayout.toFixed(18) };
  }

  const nextCredited = priorCredited.plus(credit.initialCreditXtu);
  const remainingCredit = credit.deferredCreditXtu;
  const now = Date.now();
  const nextStatus = remainingCredit.isGreaterThan(0) ? "pending_credit" : "credited";
  await tx.query(
    `UPDATE xtu_deposit_batches SET credited_amount=?,remaining_amount=?,credit_sequence=?,deposit_fee_amount=?,
     gas_allocated_usd=?,gas_allocated_xtu=?,global_run_id=?,status=?,pending_since_ms=?,release_at_ms=?,
     reason_codes=?,updated_at_ms=? WHERE id=?`,
    [nextCredited.toFixed(18), remainingCredit.toFixed(18), creditedSequence, credit.depositFeeXtu.toFixed(18),
      actualGas.feeUsd.toFixed(18), actualGas.feeUsd.toFixed(18), globalRun ? String(globalRun.id) : null,
      nextStatus, remainingCredit.isGreaterThan(0) ? String(now) : null,
      remainingCredit.isGreaterThan(0) ? String(now + DEPOSIT_PENDING_RETRY_MS) : null,
      remainingCredit.isGreaterThan(0) ? JSON.stringify(["first_credit_tranche_completed;remaining_credit_pending"]) : "[]",
      String(now), String(currentBatch.id)],
  );
  await notifyUserTx(
    tx, currentBatch.username, `xtu-deposit:${currentBatch.id}:credit:${creditedSequence}`, "OneX XTU deposit credit updated",
    [
      `Your XTU deposit credit tranche ${creditedSequence} has been confirmed.`,
      `Gross XTU returned: ${grossReturned.toFixed(8)} XTU`,
      `OneX deposit fee for the whole deposit: ${credit.depositFeeXtu.toFixed(8)} XTU`,
      `Actual BSC gas for the whole deposit: ${actualGas.feeUsd.toFixed(8)} BSC-USD / XTU equivalent`,
      `Global unit price: ${new BigNumber(common.unit_price).toFixed(12)}`,
      `Initial assets credited in this tranche: ${credit.creditedInitialAsset.toFixed(12)}`,
      `Creditable XTU remaining for a later tranche: ${remainingCredit.toFixed(8)}`,
      `Reference: ${reference}`,
      settlement ? `Global XTU-only settlement reference: ${settlement.ledgerId}` : "",
      remainingCredit.isGreaterThan(0) ? `The remaining credit remains pending and is rechecked automatically; eligible seller-campaign reserves may fund it before the seven-day OneX system-funding cooldown expires.` : "The XTU deposit batch is fully credited.",
    ].filter(Boolean).join("\n"),
  );
}

async function finalizeConsolidation(pool, row, receipt, runtime) {
  const bnbUsdPrice = await getBnbUsdPrice(runtime.provider, { forceRefresh: true });
  const actualGas = calculateActualGasFee(receipt, bnbUsdPrice);
  await parseConsolidationReceipt(runtime, receipt, row);
  await withTransaction(pool, async (tx) => {
    await acquireDepositLocks(tx);
    const [conRows] = await tx.query("SELECT * FROM xtu_deposit_consolidations WHERE id=? LIMIT 1 FOR UPDATE", [String(row.id)]);
    if (!conRows.length || ["confirmed", "manual_review"].includes(conRows[0].status)) return;
    const current = conRows[0];
    if (!["signed", "submitted"].includes(current.status)) return;

    const [items] = await tx.query(
      `SELECT * FROM xtu_deposit_consolidation_items
       WHERE consolidation_id=? ORDER BY batch_id ASC FOR UPDATE`, [String(current.id)],
    );
    if (!items.length) throw new Error("The XTU consolidation transaction has no linked deposit batches.");
    const batchIds = items.map((item) => String(item.batch_id));
    const placeholders = batchIds.map(() => "?").join(",");
    const [batchRows] = await tx.query(
      `SELECT * FROM xtu_deposit_batches WHERE id IN (${placeholders}) ORDER BY id ASC FOR UPDATE`, batchIds,
    );
    if (batchRows.length !== items.length) throw new Error("An XTU deposit batch linked to the consolidation lot is missing.");

    await recordActualBscFeeTx(tx, {
      txHash: current.tx_hash,
      operation: "xtu_deposit_consolidation",
      receipt,
      bnbUsdPrice,
    });

    const totalGrossReturned = items.reduce(
      (sum, item) => sum.plus(item.gross_returned_xtu), new BigNumber(0),
    );
    const common = await getLatestCommonTx(tx, true);
    const nextOutstanding = new BigNumber(common.xtu_wallets || "0").minus(totalGrossReturned);
    if (!totalGrossReturned.isFinite() || !totalGrossReturned.isGreaterThan(0) ||
        !nextOutstanding.isFinite() || nextOutstanding.isNegative()) {
      const reason = "The returned gross XTU exceeds the outstanding externalized counter; manual reconciliation is required and no negative balance was written.";
      await tx.query(
        `UPDATE xtu_deposit_consolidations SET status='manual_review',block_number=?,receipt_json=?,
         actual_gas_fee_bnb=?,actual_gas_fee_usd=?,confirmed_at_ms=?,last_error=?,updated_at_ms=? WHERE id=?`,
        [String(receipt.blockNumber), JSON.stringify(receipt), actualGas.feeBnb.toFixed(30), actualGas.feeUsd.toFixed(30),
          String(Date.now()), reason, String(Date.now()), String(current.id)],
      );
      await tx.query(
        `UPDATE xtu_deposit_consolidation_items SET status='manual_review',updated_at_ms=? WHERE consolidation_id=?`,
        [String(Date.now()), String(current.id)],
      );
      for (const batch of batchRows) {
        await tx.query(
          `UPDATE xtu_deposit_batches SET status='manual_review',returned_amount=?,reason_codes=?,updated_at_ms=? WHERE id=?`,
          [String(batch.gross_amount), JSON.stringify(["returned_xtu_exceeds_common_xtu_wallets_manual_reconciliation"]), String(Date.now()), String(batch.id)],
        );
        await notifyUserTx(
          tx, batch.username, `xtu-deposit:${batch.id}:manual-reconcile`, "OneX XTU deposit requires reconciliation",
          `Your XTU was returned to the OneX Distribution Wallet, but the outstanding externalized XTU ledger is insufficient to reconcile the gross returned amount. No negative accounting balance was created and no initial assets were credited automatically. Please contact OneX support. Batch: ${batch.id}.`,
        );
      }
      return;
    }

    const eventRows = (await tx.query(
      `SELECT event_identity,batch_id,gross_amount FROM xtu_deposit_transfer_events
       WHERE batch_id IN (${placeholders}) AND status NOT IN ('rejected','reversed')
       ORDER BY event_identity ASC FOR UPDATE`, batchIds,
    ))[0];
    if (!eventRows.length) throw new Error("The XTU consolidation lot has no finalized source deposit events.");
    const gasUsdByEvent = new Map(allocateBatchGasByGross(eventRows, actualGas.feeUsd).map((entry) => [entry.key, entry.gasFee]));
    const gasBnbByEvent = new Map(allocateBatchGasByGross(eventRows, actualGas.feeBnb).map((entry) => [entry.key, entry.gasFee]));
    const gasByBatch = new Map(batchIds.map((id) => [id, { usd: new BigNumber(0), bnb: new BigNumber(0) }]));
    for (const event of eventRows) {
      const key = String(event.event_identity);
      const batchId = String(event.batch_id);
      const gasUsd = gasUsdByEvent.get(key);
      const gasBnb = gasBnbByEvent.get(key);
      const bucket = gasByBatch.get(batchId);
      if (!bucket || !gasUsd || !gasBnb) throw new Error("The deterministic XTU consolidation gas allocation is incomplete.");
      bucket.usd = bucket.usd.plus(gasUsd);
      bucket.bnb = bucket.bnb.plus(gasBnb);
      await tx.query(
        `UPDATE xtu_deposit_transfer_events SET status='returned',allocated_gas_fee_usd=?,allocated_gas_fee_xtu=?
         WHERE event_identity=?`,
        [gasUsd.toFixed(18), gasUsd.toFixed(18), key],
      );
    }

    const [date, time] = utcDateTime();
    await insertCommonSnapshotTx(tx, common, { xtu_wallets: nextOutstanding.toFixed(30) }, date, time);
    await tx.query(
      `UPDATE xtu_deposit_consolidations SET status='confirmed',block_number=?,receipt_json=?,
       actual_gas_fee_bnb=?,actual_gas_fee_usd=?,confirmed_at_ms=?,updated_at_ms=? WHERE id=?`,
      [String(receipt.blockNumber), JSON.stringify(receipt), actualGas.feeBnb.toFixed(30), actualGas.feeUsd.toFixed(30),
        String(Date.now()), String(Date.now()), String(current.id)],
    );

    for (const item of items) {
      const batchId = String(item.batch_id);
      const batch = batchRows.find((entry) => String(entry.id) === batchId);
      const allocation = gasByBatch.get(batchId);
      if (!batch || !allocation) throw new Error("An XTU consolidation item is not linked to its expected batch or gas allocation.");
      await tx.query(
        `UPDATE xtu_deposit_consolidation_items SET status='confirmed',allocated_gas_fee_bnb=?,
         allocated_gas_fee_usd=?,allocated_gas_fee_xtu=?,updated_at_ms=?
         WHERE consolidation_id=? AND batch_id=?`,
        [allocation.bnb.toFixed(18), allocation.usd.toFixed(18), allocation.usd.toFixed(18),
          String(Date.now()), String(current.id), batchId],
      );
      await tx.query(
        `UPDATE xtu_deposit_batches SET status='consolidated_pending_credit',returned_amount=?,
         gas_allocated_usd=?,gas_allocated_xtu=?,updated_at_ms=? WHERE id=?`,
        [new BigNumber(item.gross_returned_xtu).toFixed(18), allocation.usd.toFixed(18), allocation.usd.toFixed(18),
          String(Date.now()), batchId],
      );

      await tx.query("SAVEPOINT xtu_credit_attempt");
      try {
        await creditConsolidatedBatchTx(
          tx,
          { ...batch, returned_amount: String(item.gross_returned_xtu), status: "consolidated_pending_credit" },
          current,
          receipt,
          { feeBnb: allocation.bnb, feeUsd: allocation.usd },
          runtime.settings,
        );
        await tx.query("RELEASE SAVEPOINT xtu_credit_attempt");
      } catch (error) {
        await tx.query("ROLLBACK TO SAVEPOINT xtu_credit_attempt");
        await tx.query("RELEASE SAVEPOINT xtu_credit_attempt");
        const now = Date.now();
        const systemFundingCooldown = error.code === "XTU_SYSTEM_FUNDING_COOLDOWN";
        const pendingStatus = systemFundingCooldown ? "pending_weekly" : "pending_reserve";
        const pendingReason = systemFundingCooldown ? "system_funding_cooldown" : String(error.message || error).slice(0, 250);
        const releaseAt = systemFundingCooldown && Number.isSafeInteger(Number(error.releaseAtMs))
          ? Number(error.releaseAtMs)
          : now + DEPOSIT_PENDING_RETRY_MS;
        await tx.query(
          `UPDATE xtu_deposit_batches SET status=?,reason_codes=?,pending_since_ms=COALESCE(pending_since_ms,?),
           release_at_ms=?,updated_at_ms=? WHERE id=?`,
          [pendingStatus, JSON.stringify([pendingReason]), String(now), String(releaseAt), String(now), batchId],
        );
        await notifyUserTx(
          tx, batch.username, `xtu-deposit:${batchId}:${systemFundingCooldown ? "weekly-system-funding" : "pending-reserve"}`,
          "OneX XTU deposit pending",
          systemFundingCooldown
            ? `Your XTU deposit has been returned to OneX and reconciled, but the weekly OneX-funded purchase has already been used. An active eligible seller campaign may fund this credit earlier; the worker will recheck seller reserves. Otherwise OneX system-reserve funding becomes available after the seven-day period. Batch: ${batchId}.`
            : `Your XTU transfer has returned to OneX and the externalized XTU counter and coverage ledger have been reconciled. The initial-asset credit is pending a reserve or account check and will be reassessed automatically. Please contact OneX support if needed. Batch: ${batchId}.`,
        );
      }
    }
  });
}

async function markConsolidationBatchesManualReview(pool, consolidationId, reason) {
  await withTransaction(pool, async (tx) => {
    await acquireDepositLocks(tx);
    const [items] = await tx.query(
      `SELECT i.batch_id,b.username,b.gross_amount
       FROM xtu_deposit_consolidation_items i
       JOIN xtu_deposit_batches b ON b.id=i.batch_id
       WHERE i.consolidation_id=? ORDER BY i.batch_id ASC FOR UPDATE`, [String(consolidationId)],
    );
    await tx.query(
      `UPDATE xtu_deposit_consolidation_items SET status='manual_review',updated_at_ms=?
       WHERE consolidation_id=?`, [String(Date.now()), String(consolidationId)],
    );
    for (const item of items) {
      await tx.query(
        `UPDATE xtu_deposit_batches SET status='manual_review',reason_codes=?,updated_at_ms=? WHERE id=?`,
        [JSON.stringify([String(reason).slice(0, 250)]), String(Date.now()), String(item.batch_id)],
      );
      await notifyUserTx(
        tx, item.username, `xtu-deposit:${item.batch_id}:consolidation-manual-review`,
        "OneX XTU deposit requires reconciliation",
        `Your finalized XTU deposit is part of a Hot Wallet consolidation that requires manual reconciliation: ${String(reason).slice(0, 300)}. No automatic asset credit will be issued until the reconciliation is complete. Batch: ${item.batch_id}.`,
      );
    }
  });
}

async function reconcileConsolidation(pool, row, runtime) {
  const hash = String(row.tx_hash || "").toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(hash) || !row.raw_tx) throw new Error("Persisted XTU consolidation has no valid signed transaction.");
  const [transaction, receipt] = await Promise.all([
    runtime.provider.getTransaction(hash), runtime.provider.getTransactionReceipt(hash),
  ]);
  if (!receipt) {
    if (transaction) {
      await pool.queryAsync("UPDATE xtu_deposit_consolidations SET status='submitted',updated_at_ms=? WHERE id=?", [String(Date.now()), String(row.id)]);
      return;
    }
    const latestNonce = await runtime.provider.getTransactionCount(runtime.settings.mainWalletAddress, "latest");
    if (latestNonce > Number(row.nonce)) {
      await pool.queryAsync(
        "UPDATE xtu_deposit_consolidations SET status='manual_review',last_error=?,updated_at_ms=? WHERE id=?",
        ["The Hot Wallet nonce advanced but the persisted XTU consolidation hash is not visible; automatic resend is blocked.", String(Date.now()), String(row.id)],
      );
      await markConsolidationBatchesManualReview(
        pool, row.id, "The Hot Wallet nonce advanced but the persisted transaction hash is not visible; automatic resend is blocked.",
      );
      return;
    }
    const sent = await runtime.provider.broadcastTransaction(row.raw_tx);
    if (String(sent.hash).toLowerCase() !== hash) throw new Error("Rebroadcast of the persisted XTU consolidation returned a different transaction hash.");
    await pool.queryAsync("UPDATE xtu_deposit_consolidations SET status='submitted',last_error=NULL,updated_at_ms=? WHERE id=?", [String(Date.now()), String(row.id)]);
    return;
  }
  const latest = await runtime.provider.getBlockNumber();
  if (latest - Number(receipt.blockNumber) + 1 < runtime.settings.minConfirmations) return;
  const block = await runtime.provider.getBlock(Number(receipt.blockNumber));
  if (!block || String(block.hash).toLowerCase() !== String(receipt.blockHash).toLowerCase()) return;
  if (Number(receipt.status) !== 1) {
    await pool.queryAsync(
      "UPDATE xtu_deposit_consolidations SET status='failed',receipt_json=?,block_number=?,last_error=?,updated_at_ms=? WHERE id=?",
      [JSON.stringify(receipt), String(receipt.blockNumber), "Hot Wallet to Distribution Wallet consolidation reverted on-chain.", String(Date.now()), String(row.id)],
    );
    await markConsolidationBatchesManualReview(pool, row.id, "The Hot Wallet to Distribution Wallet consolidation reverted on-chain.");
    return;
  }
}

async function filterEligibleConsolidationBatches(pool, candidates, settings) {
  return withTransaction(pool, async (tx) => {
    await acquireDepositLocks(tx);
    const eligible = [];
    for (const candidate of candidates) {
      const [rows] = await tx.query(
        "SELECT * FROM xtu_deposit_batches WHERE id=? LIMIT 1 FOR UPDATE", [String(candidate.id)],
      );
      if (!rows.length) continue;
      const batch = rows[0];
      if (!["ready", "pending_reserve", "pending_credit", "pending_weekly"].includes(String(batch.status))) continue;
      // Pending weekly batches are rechecked each worker cycle so a newly
      // activated seller campaign can fund the purchase before the cooldown ends.
      if (batch.release_at_ms != null && Number(batch.release_at_ms) > Date.now() &&
          !["ready", "pending_weekly"].includes(String(batch.status))) continue;
      const [linked] = await tx.query(
        "SELECT id FROM xtu_deposit_consolidation_items WHERE batch_id=? LIMIT 1 FOR UPDATE", [String(batch.id)],
      );
      if (linked.length) continue;
      const capacity = await assessBatchCapacityTx(tx, batch, "0", settings);
      if (!capacity.allowed) {
        const now = Date.now();
        if (capacity.reason === "system_funding_cooldown") {
          const releaseAt = getXtuWeeklyCooldownReleaseAt(batch, capacity.cooldown || { lastPurchaseMs: null });
          await tx.query(
            `UPDATE xtu_deposit_batches SET status='pending_weekly',pending_since_ms=COALESCE(pending_since_ms,?),
             release_at_ms=?,reason_codes=?,updated_at_ms=? WHERE id=?`,
            [String(now), String(releaseAt), JSON.stringify(["system_funding_cooldown"]), String(now), String(batch.id)],
          );
          await notifyUserTx(
            tx, batch.username, `xtu-deposit:${batch.id}:weekly-system-funding`, "OneX XTU deposit pending",
            `Your XTU deposit cannot currently be funded from OneX system reserves because your one system-funded purchase for the rolling seven-day period has already been used. An eligible seller campaign may fund this deposit earlier; otherwise system-reserve funding can be reconsidered after the cooldown. Batch: ${batch.id}.`,
          );
        } else {
          await tx.query(
            `UPDATE xtu_deposit_batches SET status='pending_reserve',pending_since_ms=COALESCE(pending_since_ms,?),
             release_at_ms=?,reason_codes=?,updated_at_ms=? WHERE id=?`,
            [String(now), String(now + DEPOSIT_PENDING_RETRY_MS), JSON.stringify([capacity.reason || "reserve_or_account_check_failed"]), String(now), String(batch.id)],
          );
          await notifyUserTx(
            tx, batch.username, `xtu-deposit:${batch.id}:pending-reserve`, "OneX XTU deposit pending",
            `Your XTU deposit is waiting because its current reserve or account-capacity check is not satisfied. It will be reassessed automatically when the relevant reserve or account condition changes. Batch: ${batch.id}.`,
          );
        }
        continue;
      }
      eligible.push(batch);
    }
    return eligible;
  });
}

async function processOneReadyBatch(pool, runtime, mainSigner) {
  const pendingConsolidations = await pool.queryAsync(
    `SELECT * FROM xtu_deposit_consolidations WHERE status IN ('signed','submitted')
     ORDER BY id ASC LIMIT 1`,
  );
  if (pendingConsolidations.length) {
    await reconcileConsolidation(pool, pendingConsolidations[0], runtime);
    return;
  }

  const retryRows = await pool.queryAsync(
    `SELECT b.id FROM xtu_deposit_batches b
     JOIN xtu_deposit_consolidation_items i ON i.batch_id=b.id
     JOIN xtu_deposit_consolidations c ON c.id=i.consolidation_id
     WHERE b.status IN ('pending_reserve','pending_credit','pending_weekly') AND c.status='confirmed'
       AND (b.status='pending_weekly' OR b.release_at_ms IS NULL OR CAST(b.release_at_ms AS UNSIGNED)<=?)
     ORDER BY b.id ASC LIMIT 1`, [String(Date.now())],
  );
  if (retryRows.length) {
    await retryCredit(pool, retryRows[0].id, runtime.settings);
    return;
  }

  const candidates = await pool.queryAsync(
    `SELECT b.* FROM xtu_deposit_batches b
     WHERE b.status IN ('ready','pending_reserve','pending_credit','pending_weekly')
       AND (b.status IN ('ready','pending_weekly') OR b.release_at_ms IS NULL OR CAST(b.release_at_ms AS UNSIGNED)<=?)
       AND NOT EXISTS (
         SELECT 1 FROM xtu_deposit_consolidation_items i WHERE i.batch_id=b.id
       )
     ORDER BY b.id ASC LIMIT 200`, [String(Date.now())],
  );
  if (!candidates.length) return;

  const eligible = await filterEligibleConsolidationBatches(pool, candidates, runtime.settings);
  const selected = selectXtuConsolidationBatches(
    eligible,
    runtime.settings.depositConsolidationMinBatchXtu,
  );
  if (!selected) return;

  try {
    await prepareConsolidation(pool, selected.batches, runtime, mainSigner);
  } catch (error) {
    for (const batch of selected.batches) {
      await setBatchPending(pool, batch.id, "pending_reserve", error.message || "xtu_consolidation_preparation_failed");
    }
  }
}

async function retryCredit(pool, batchId, settings) {
  const rows = await pool.queryAsync(
    `SELECT b.*,i.allocated_gas_fee_bnb AS batch_gas_fee_bnb,
            i.allocated_gas_fee_usd AS batch_gas_fee_usd,
            c.receipt_json,c.tx_hash
     FROM xtu_deposit_batches b
     JOIN xtu_deposit_consolidation_items i ON i.batch_id=b.id
     JOIN xtu_deposit_consolidations c ON c.id=i.consolidation_id
     WHERE b.id=? AND b.status IN ('pending_reserve','pending_credit','pending_weekly') AND c.status='confirmed' LIMIT 1`, [String(batchId)],
  );
  if (!rows.length) return;
  const row = rows[0];
  const receipt = JSON.parse(row.receipt_json || "{}");
  const gas = {
    feeBnb: new BigNumber(row.batch_gas_fee_bnb || "0"),
    feeUsd: new BigNumber(row.batch_gas_fee_usd || "0"),
  };
  await withTransaction(pool, async (tx) => {
    await acquireDepositLocks(tx);
    await tx.query("SAVEPOINT xtu_credit_attempt");
    try {
      await creditConsolidatedBatchTx(tx, row, { tx_hash: row.tx_hash }, receipt, gas, settings);
      await tx.query("RELEASE SAVEPOINT xtu_credit_attempt");
    } catch (error) {
      await tx.query("ROLLBACK TO SAVEPOINT xtu_credit_attempt");
      await tx.query("RELEASE SAVEPOINT xtu_credit_attempt");
      const now = Date.now();
      const systemFundingCooldown = error.code === "XTU_SYSTEM_FUNDING_COOLDOWN";
      const pendingStatus = systemFundingCooldown ? "pending_weekly" : "pending_reserve";
      const pendingReason = systemFundingCooldown ? "system_funding_cooldown" : String(error.message || error).slice(0, 250);
      const releaseAt = systemFundingCooldown && Number.isSafeInteger(Number(error.releaseAtMs))
        ? Number(error.releaseAtMs)
        : now + DEPOSIT_PENDING_RETRY_MS;
      await tx.query(
        "UPDATE xtu_deposit_batches SET status=?,reason_codes=?,pending_since_ms=COALESCE(pending_since_ms,?),release_at_ms=?,updated_at_ms=? WHERE id=? AND status IN ('pending_reserve','pending_credit','pending_weekly')",
        [pendingStatus, JSON.stringify([pendingReason]), String(now), String(releaseAt), String(now), String(batchId)],
      );
    }
  });
}

async function processSettlementPayout(pool, runtime) {
  const rows = await pool.queryAsync(
    `SELECT * FROM xtu_global_settlement_payouts
     WHERE status IN ('queued','signed','submitted') ORDER BY id ASC LIMIT 1`,
  );
  if (!rows.length) return;
  const row = rows[0];
  if (row.status === "signed" || row.status === "submitted") {
    const hash = String(row.tx_hash || "").toLowerCase();
    if (!/^0x[0-9a-f]{64}$/.test(hash) || !row.raw_tx) {
      await pool.queryAsync("UPDATE xtu_global_settlement_payouts SET status='manual_review',last_error=?,updated_at_ms=? WHERE id=?", ["Signed XTU global payout is missing its persisted transaction data.", String(Date.now()), String(row.id)]);
      return;
    }
    const [transaction, receipt] = await Promise.all([runtime.provider.getTransaction(hash), runtime.provider.getTransactionReceipt(hash)]);
    if (!receipt) {
      if (!transaction) {
        const nonce = await runtime.provider.getTransactionCount(runtime.settings.distributionAddress, "latest");
        if (nonce > Number(row.nonce)) {
          await pool.queryAsync("UPDATE xtu_global_settlement_payouts SET status='manual_review',last_error=?,updated_at_ms=? WHERE id=?", ["Distribution wallet nonce advanced but the persisted XTU settlement transaction is not visible.", String(Date.now()), String(row.id)]);
          return;
        }
        await runtime.provider.broadcastTransaction(row.raw_tx);
      }
      return;
    }
    const latest = await runtime.provider.getBlockNumber();
    if (latest - Number(receipt.blockNumber) + 1 < runtime.settings.minConfirmations) return;
    const canonical = await runtime.provider.getBlock(Number(receipt.blockNumber));
    if (!canonical || String(canonical.hash).toLowerCase() !== String(receipt.blockHash).toLowerCase()) return;
    if (Number(receipt.status) !== 1) {
      await pool.queryAsync("UPDATE xtu_global_settlement_payouts SET status='failed',receipt_json=?,block_number=?,last_error=?,updated_at_ms=? WHERE id=?", [JSON.stringify(receipt), String(receipt.blockNumber), "XTU settlement payout reverted on-chain.", String(Date.now()), String(row.id)]);
      return;
    }
    await finalizeSettlementPayout(pool, row, receipt, runtime);
    return;
  }

  const quote = calculateXtuSettlementQuote(row.net_amount);
  const amountRaw = BigInt(quote.grossRaw);
  const data = runtime.contract.interface.encodeFunctionData("transfer", [row.payout_address, amountRaw]);
  const bnbUsdPrice = await getBnbUsdPrice(runtime.provider, { forceRefresh: true });
  const estimate = await estimateBscTokenTransfer({
    provider: runtime.provider,
    fromAddress: runtime.settings.distributionAddress,
    tokenAddress: runtime.settings.tokenAddress,
    data,
    maximumGasLimit: runtime.settings.gasLimitCeiling,
    bnbUsdPrice,
  });
  const gasLimit = (estimate.gasLimit * 120n + 99n) / 100n;
  if (gasLimit > runtime.settings.gasLimitCeiling) throw new Error("XTU global settlement gas limit exceeds the configured ceiling.");
  const gasQuote = require("./bsc-fee-accounting").calculateEstimatedGasFee(gasLimit.toString(), estimate.gasPrice.toString(), bnbUsdPrice);
  if (!evaluateBscTxFee(gasQuote.feeUsd, getConfiguredMaxBscTxFeeUsd()).allowed) {
    await pool.queryAsync("UPDATE xtu_global_settlement_payouts SET last_error=?,updated_at_ms=? WHERE id=?", ["Estimated XTU settlement BNB gas exceeds 0.4 BSC-USD; payout deferred.", String(Date.now()), String(row.id)]);
    return;
  }
  const ledgerRows = await pool.queryAsync("SELECT remaining_xtu_amount FROM xtu_global_settlement_ledger WHERE id=? LIMIT 1", [String(row.ledger_id)]);
  if (!ledgerRows.length || new BigNumber(ledgerRows[0].remaining_xtu_amount).lt(row.net_amount)) {
    await pool.queryAsync("UPDATE xtu_global_settlement_payouts SET status='manual_review',last_error=?,updated_at_ms=? WHERE id=?", ["The XTU settlement ledger does not reserve the exact payout net amount.", String(Date.now()), String(row.id)]);
    return;
  }
  const [balance, nativeBalance] = await Promise.all([
    runtime.contract.balanceOf(runtime.settings.distributionAddress),
    runtime.provider.getBalance(runtime.settings.distributionAddress),
  ]);
  const reservedRows = await pool.queryAsync(
    `SELECT COALESCE(SUM(remaining_xtu_amount),0) AS reserved FROM xtu_global_settlement_ledger
     WHERE status IN ('reserved','partially_settled')`,
  );
  const pendingWithdrawalRows = await pool.queryAsync(
    `SELECT COALESCE(SUM(net_amount),0) AS reserved FROM xtu_withdrawals
     WHERE status IN ('queued','signed','submitted','manual_review')`,
  );
  const reserved = new BigNumber(reservedRows[0]?.reserved || "0")
    .plus(pendingWithdrawalRows[0]?.reserved || "0");
  const currentNet = new BigNumber(row.net_amount);
  if (new BigNumber(balance.toString()).shiftedBy(-18).lt(reserved)) {
    await pool.queryAsync("UPDATE xtu_global_settlement_payouts SET last_error=?,updated_at_ms=? WHERE id=?", ["Distribution Wallet token balance is below the reserved global XTU settlements; payout deferred.", String(Date.now()), String(row.id)]);
    return;
  }
  if (new BigNumber(nativeBalance.toString()).lt(gasQuote.feeBnb.shiftedBy(18).integerValue(BigNumber.ROUND_CEIL))) {
    await pool.queryAsync("UPDATE xtu_global_settlement_payouts SET last_error=?,updated_at_ms=? WHERE id=?", ["Distribution Wallet does not have enough BNB for XTU global settlement gas.", String(Date.now()), String(row.id)]);
    return;
  }
  const nonce = await runtime.provider.getTransactionCount(runtime.settings.distributionAddress, "pending");
  const rawTx = await runtime.signer.signTransaction({
    to: runtime.settings.tokenAddress,
    data,
    value: 0n,
    chainId: CHAIN_ID,
    nonce,
    gasLimit,
    gasPrice: estimate.gasPrice,
  });
  const txHash = keccak256(rawTx).toLowerCase();
  await withTransaction(pool, async (tx) => {
    const [lockRows] = await tx.query("SELECT lock_name FROM system_locks WHERE lock_name='onex_xtu_wallet_spend' FOR UPDATE");
    if (!lockRows.length) throw new Error("The XTU wallet-spend lock is missing.");
    const [freshRows] = await tx.query("SELECT status FROM xtu_global_settlement_payouts WHERE id=? LIMIT 1 FOR UPDATE", [String(row.id)]);
    if (!freshRows.length || freshRows[0].status !== "queued") return;
    const [freshLedgerRows] = await tx.query(
      `SELECT COALESCE(SUM(remaining_xtu_amount),0) AS amount FROM xtu_global_settlement_ledger
       WHERE status IN ('reserved','partially_settled')`,
    );
    const [freshWithdrawalRows] = await tx.query(
      `SELECT COALESCE(SUM(net_amount),0) AS amount FROM xtu_withdrawals
       WHERE status IN ('queued','signed','submitted','manual_review')`,
    );
    const freshTokenBalance = new BigNumber((await runtime.contract.balanceOf(runtime.settings.distributionAddress)).toString()).shiftedBy(-18);
    const freshRequired = new BigNumber(freshLedgerRows[0]?.amount || "0").plus(freshWithdrawalRows[0]?.amount || "0");
    if (!freshTokenBalance.isFinite() || freshTokenBalance.lt(freshRequired)) {
      throw new Error("The Distribution Wallet no longer covers all reserved XTU global settlements and pending withdrawals.");
    }
    await recordEstimatedBscFeeTx(tx, {
      txHash,
      operation: "xtu_global_settlement",
      gasLimit: gasLimit.toString(),
      gasPriceWei: estimate.gasPrice.toString(),
      bnbUsdPrice,
    });
    await tx.query(
      `UPDATE xtu_global_settlement_payouts SET status='signed',gross_amount=?,contract_fee_amount=?,
       estimated_gas_fee_bnb=?,estimated_gas_fee_usd=?,raw_tx=?,tx_hash=?,nonce=?,gas_limit=?,gas_price_wei=?,updated_at_ms=?
       WHERE id=? AND status='queued'`,
      [quote.grossAmount.toFixed(18), quote.contractFeeAmount.toFixed(18), gasQuote.feeBnb.toFixed(30),
        gasQuote.feeUsd.toFixed(30), rawTx, txHash, String(nonce), gasLimit.toString(), estimate.gasPrice.toString(), String(Date.now()), String(row.id)],
    );
  });
  try {
    await runtime.provider.broadcastTransaction(rawTx);
    await pool.queryAsync("UPDATE xtu_global_settlement_payouts SET status='submitted',updated_at_ms=? WHERE id=? AND status='signed'", [String(Date.now()), String(row.id)]);
  } catch (error) {
    await pool.queryAsync("UPDATE xtu_global_settlement_payouts SET last_error=?,updated_at_ms=? WHERE id=? AND status IN ('signed','submitted')", [String(error.message || error).slice(0, 990), String(Date.now()), String(row.id)]);
  }
}

async function finalizeSettlementPayout(pool, row, receipt, runtime) {
  const bnbUsdPrice = await getBnbUsdPrice(runtime.provider, { forceRefresh: true });
  const actualGas = calculateActualGasFee(receipt, bnbUsdPrice);
  const expectedNetRaw = BigInt(new BigNumber(row.net_amount).shiftedBy(18).integerValue(BigNumber.ROUND_DOWN).toFixed(0));
  const expectedGrossRaw = BigInt(new BigNumber(row.gross_amount).shiftedBy(18).integerValue(BigNumber.ROUND_DOWN).toFixed(0));
  let foundNet = null;
  let foundGross = null;
  let foundFee = null;
  let foundExempt = null;
  for (const log of receipt.logs || []) {
    if (String(log.address).toLowerCase() !== runtime.settings.tokenAddress.toLowerCase()) continue;
    let parsed;
    try { parsed = runtime.contract.interface.parseLog(log); } catch { continue; }
    if (parsed?.name === "TransferWithFee" &&
        getAddress(String(parsed.args.from)) === runtime.settings.distributionAddress &&
        getAddress(String(parsed.args.to)) === getAddress(row.payout_address)) {
      foundGross = BigInt(parsed.args.grossAmount);
      foundNet = BigInt(parsed.args.netAmount);
      foundFee = BigInt(parsed.args.feeAmount);
      foundExempt = Boolean(parsed.args.feeExempt);
    }
  }
  const expectedFeeRaw = (expectedGrossRaw * 10n) / 10_000n;
  if (foundNet !== expectedNetRaw || foundGross !== expectedGrossRaw || foundFee !== expectedFeeRaw || foundExempt !== false) throw new Error("The XTU global settlement receipt does not match the exact gross/net entitlement and 0.1% contract fee.");
  await withTransaction(pool, async (tx) => {
    const [lockRows] = await tx.query("SELECT lock_name FROM system_locks WHERE lock_name='onex_xtu_wallet_spend' FOR UPDATE");
    if (!lockRows.length) throw new Error("The XTU wallet-spend lock is missing.");
    const [rows] = await tx.query("SELECT * FROM xtu_global_settlement_payouts WHERE id=? LIMIT 1 FOR UPDATE", [String(row.id)]);
    if (!rows.length || rows[0].status === "confirmed") return;
    const current = rows[0];
    await recordActualBscFeeTx(tx, { txHash: current.tx_hash, operation: "xtu_global_settlement", receipt, bnbUsdPrice });
    const [ledgerRows] = await tx.query("SELECT * FROM xtu_global_settlement_ledger WHERE id=? LIMIT 1 FOR UPDATE", [String(current.ledger_id)]);
    if (!ledgerRows.length) throw new Error("XTU global settlement ledger row is missing.");
    const ledger = ledgerRows[0];
    const remaining = new BigNumber(ledger.remaining_xtu_amount).minus(current.net_amount);
    const settled = new BigNumber(ledger.settled_xtu_amount).plus(current.net_amount);
    if (remaining.isNegative()) throw new Error("XTU global settlement payout exceeds its protected reserved amount.");
    const status = remaining.isZero() ? "settled" : "partially_settled";
    await tx.query(
      `UPDATE xtu_global_settlement_ledger SET remaining_xtu_amount=?,settled_xtu_amount=?,status=?,updated_at_ms=? WHERE id=?`,
      [remaining.toFixed(18), settled.toFixed(18), status, String(Date.now()), String(ledger.id)],
    );
    await tx.query(
      `UPDATE xtu_global_settlement_payouts SET status='confirmed',block_number=?,receipt_json=?,
       actual_gas_fee_bnb=?,actual_gas_fee_usd=?,confirmed_at_ms=?,updated_at_ms=? WHERE id=?`,
      [String(receipt.blockNumber), JSON.stringify(receipt), actualGas.feeBnb.toFixed(30), actualGas.feeUsd.toFixed(30),
        String(Date.now()), String(Date.now()), String(current.id)],
    );
    await notifyUserTx(
      tx, current.username, `xtu-global-settlement:${current.id}:confirmed`, "OneX XTU global settlement completed",
      `Your XTU settlement has been confirmed. Net XTU received: ${new BigNumber(current.net_amount).toFixed(8)}. Actual BNB gas cost is recorded separately and is not deducted from your settlement amount. Transaction: ${current.tx_hash}.`,
    );
  });
}

async function processEmailOutbox(pool) {
  if (!EMAIL_TRANSPORTER) return;
  const now = Date.now();
  const rows = await pool.queryAsync(
    `SELECT id,recipient,subject,message_text,attempts FROM xtu_deposit_email_outbox
     WHERE status='pending' AND CAST(next_attempt_at_ms AS UNSIGNED)<=? ORDER BY id ASC LIMIT 1`, [String(now)],
  );
  if (!rows.length) return;
  const row = rows[0];
  const claim = await pool.queryAsync(
    `UPDATE xtu_deposit_email_outbox SET status='sending',attempts=attempts+1
     WHERE id=? AND status='pending'`, [String(row.id)],
  );
  if (Number(claim.affectedRows || 0) !== 1) return;
  try {
    await EMAIL_TRANSPORTER.sendMail({ from: SERVER_MAIL, to: row.recipient, subject: row.subject, text: row.message_text });
    await pool.queryAsync("UPDATE xtu_deposit_email_outbox SET status='sent',sent_at_ms=?,last_error=NULL WHERE id=? AND status='sending'", [String(Date.now()), String(row.id)]);
  } catch (error) {
    const attempts = Number(row.attempts || 0) + 1;
    const delay = Math.min(60 * 60 * 1000, 15_000 * (2 ** Math.min(attempts - 1, 7)));
    await pool.queryAsync(
      `UPDATE xtu_deposit_email_outbox SET status=?,next_attempt_at_ms=?,last_error=? WHERE id=? AND status='sending'`,
      [attempts >= 8 ? "failed" : "pending", String(Date.now() + delay), String(error.message || error).slice(0, 990), String(row.id)],
    );
  }
}

async function processOne(pool, context) {
  const { runtime, provider, mainSigner } = context;
  await scanIncomingEvents(pool, provider, runtime.settings);
  await closeExpiredBatches(pool, runtime.settings);
  await processOneReadyBatch(pool, runtime, mainSigner);
  await processSettlementPayout(pool, runtime);
  await processEmailOutbox(pool);
}

async function startXtuDepositWorker(pool = defaultDb) {
  if (!isXtuDepositWorkerEnabled()) return false;
  let settings;
  try { settings = getXtuSettings(); } catch (error) {
    console.error("XTU deposit worker configuration is invalid:", error.message);
    return false;
  }
  if (!settings.depositWorkerEnabled) {
    console.log("XTU deposit worker is disabled by XTU_DEPOSIT_WORKER_ENABLED.");
    return false;
  }
  if (!settings.incomingRpcUrl) throw new Error("XTU_INCOMING_RPC_URL or a configured BSC incoming RPC is required.");

  const runtime = await getXtuRuntime({ requireSigner: true });
  const mainSigner = await getXtuMainSigner(runtime);
  const provider = new JsonRpcProvider(settings.incomingRpcUrl, CHAIN_ID);
  const network = await provider.getNetwork();
  if (BigInt(network.chainId) !== CHAIN_ID) throw new Error("XTU incoming RPC is not connected to BNB Smart Chain Mainnet.");
  const code = await provider.getCode(settings.tokenAddress);
  if (!code || code === "0x") throw new Error("The XTU token contract has no code on the incoming RPC endpoint.");
  await initializeScannerState(pool, provider, settings);

  const lockConnection = await getPoolConnection(pool);
  const lockTx = lockConnection.promise();
  const [lockRows] = await lockTx.query("SELECT GET_LOCK('onex_xtu_deposit_worker',0) AS acquired");
  if (Number(lockRows[0]?.acquired) !== 1) {
    lockConnection.release();
    console.log("Another process already owns the XTU deposit worker lock.");
    return false;
  }

  let stopping = false;
  let timer = null;
  let busy = false;
  const tick = async () => {
    if (stopping || busy) return;
    busy = true;
    try { await processOne(pool, { runtime, provider, mainSigner }); }
    catch (error) {
      console.error("XTU deposit worker cycle failed:", error.message);
      await pool.queryAsync(
        "UPDATE xtu_deposit_scan_state SET last_error=?,updated_at_ms=? WHERE singleton_id=1",
        [String(error.message || error).slice(0, 990), String(Date.now())],
      ).catch(() => {});
    } finally { busy = false; }
    if (!stopping) {
      timer = setTimeout(tick, runtime.settings.depositPollMs);
      if (typeof timer.unref === "function") timer.unref();
    }
  };
  void tick();
  const stop = async () => {
    stopping = true;
    if (timer) clearTimeout(timer);
    try { await lockTx.query("SELECT RELEASE_LOCK('onex_xtu_deposit_worker')"); } catch {}
    lockConnection.release();
  };
  process.once("SIGINT", () => { void stop(); });
  process.once("SIGTERM", () => { void stop(); });
  console.log("XTU deposit scanner and settlement worker started on BNB Smart Chain Mainnet.");
  return { stop };
}

module.exports = {
  startXtuDepositWorker,
  scanIncomingEvents,
  verifyDepositReceipt,
  closeExpiredBatches,
  processOne,
  processSettlementPayout,
};

if (require.main === module) {
  require("./db").initDbIfEmpty()
    .then(() => startXtuDepositWorker(defaultDb))
    .catch((error) => {
      console.error("Standalone XTU deposit worker failed:", error.message);
      process.exitCode = 1;
    });
}
