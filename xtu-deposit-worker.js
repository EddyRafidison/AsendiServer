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
const { MINIMUM_REFUND_NET_BSC_USD } = require("./refund-policy");
const { calculateXtuUnknownRefundQuote } = require("./xtu-unknown-refund-policy");
const {
  ensureWalletFinancialLockTx,
  registerAutomaticRefundEventTx,
  markAutomaticRefundManualReviewTx,
} = require("./automatic-refund-service");
const {
  calculateDepositFundingAllocation,
  calculateSellerOnlyDepositFundingAllocation,
  calculateRemainingAdministrativeBacking,
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

async function getUnbackedAutomaticRefundXtuAmount(queryable, excludeGroupId = null) {
  const exclusion = excludeGroupId == null ? "" : "AND e.group_id<>?";
  const params = excludeGroupId == null ? [] : [String(excludeGroupId)];
  const sql = `SELECT COALESCE(SUM(e.gross_amount-e.refunded_amount),0) AS amount
    FROM automatic_refund_group_events e
    JOIN automatic_refund_groups g ON g.id=e.group_id
    JOIN xtu_deposit_transfer_events s ON s.id=e.source_id
    WHERE g.asset_code='XTU' AND e.source_table='xtu_deposit_transfer_events'
      AND e.status NOT IN ('refunded','resolved','cancelled')
      AND e.gross_amount>e.refunded_amount
      AND NOT EXISTS (SELECT 1 FROM xtu_hot_wallet_lots l WHERE l.event_identity=s.event_identity)
      ${exclusion}`;
  if (typeof queryable.queryAsync === "function") {
    const rows = await queryable.queryAsync(sql, params);
    return String(rows[0]?.amount || "0");
  }
  const [rows] = await queryable.query(sql, params);
  return String(rows[0]?.amount || "0");
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
  const expectedFee = 0n;
  if (receiver !== settings.mainWalletAddress || sender === settings.distributionAddress || feeExempt) {
    throw new Error("The XTU transfer is not an external deposit into the configured Hot Wallet.");
  }
  if (gross <= 0n || fee !== expectedFee || net + fee !== gross) {
    throw new Error("The XTU TransferWithFee event has inconsistent gross, net or zero-commission values.");
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

async function createDepositBatchTx(tx, username, settings, finalizedAtMs, status = "collecting", reason = null, globalRunId = null) {
  const timestamp = Number(finalizedAtMs);
  if (!Number.isSafeInteger(timestamp) || timestamp <= 0) throw new RangeError("Invalid finalized XTU deposit timestamp.");
  const expiresAt = timestamp + settings.depositPendingExpirationMs;
  const pendingSince = status === "collecting" ? null : timestamp;
  const releaseAt = status === "pending_weekly" ? timestamp + settings.depositPendingRetryMs : null;
  const [result] = await tx.query(
    `INSERT INTO xtu_deposit_batches
     (username,hot_wallet_address,opened_at_ms,expires_at_ms,initial_group_deadline_ms,global_run_id,
      pending_since_ms,release_at_ms,status,reason_codes,tfees_rate_percent,created_at_ms,updated_at_ms)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [username, settings.mainWalletAddress, String(timestamp), String(expiresAt), String(expiresAt), globalRunId,
      pendingSince == null ? null : String(pendingSince), releaseAt == null ? null : String(releaseAt),
      status, reason ? JSON.stringify([reason]) : "[]", new BigNumber(tfees).toFixed(10), String(Date.now()), String(Date.now())],
  );
  return String(result.insertId);
}

async function assignDepositEventTx(tx, event, settings) {
  const identity = eventIdentity(event.txHash, event.logIndex);
  await acquireDepositLocks(tx);
  await ensureWalletFinancialLockTx(tx, event.sender, Date.now());
  const [existingEventRows] = await tx.query(
    `SELECT id,username,batch_id,status FROM xtu_deposit_transfer_events WHERE event_identity=? LIMIT 1 FOR UPDATE`, [identity],
  );
  const previouslyUnknownEvent = existingEventRows.length === 1 &&
    existingEventRows[0].username == null && existingEventRows[0].batch_id == null &&
    String(existingEventRows[0].status) === "pending_identity";
  if (existingEventRows.length && !previouslyUnknownEvent) return { status: "duplicate" };

  const [authRows] = await tx.query(
    `SELECT username,email,account_active,wallet_address FROM auths
     WHERE LOWER(wallet_address)=LOWER(?) LIMIT 1 FOR UPDATE`, [event.sender],
  );
  if (!authRows.length) {
    // Unknown official XTU goes directly to the shared automatic-refund registry.
    // The refundable principal is the amount actually received by the Hot Wallet.
    const grossAmount = new BigNumber(event.gross.toString()).shiftedBy(-18);
    const hotWalletAmount = new BigNumber(event.net.toString()).shiftedBy(-18);
    const commissionAmount = new BigNumber(event.fee.toString()).shiftedBy(-18);
    const nowMs = Number(event.finalizedAtMs || Date.now());
    const now = String(nowMs);
    await tx.query(
      `INSERT IGNORE INTO xtu_deposit_transfer_events
       (username,batch_id,token_contract,from_address,hot_wallet_address,gross_amount,net_amount,commission_amount,
        gross_amount_raw,net_amount_raw,commission_amount_raw,tx_hash,log_index,block_number,block_hash,
        block_timestamp_ms,event_identity,status,reason_codes,created_at_ms)
       VALUES(NULL,NULL,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'automatic_refund_pending','["wallet_not_linked"]',?)`,
      [settings.tokenAddress, event.sender, settings.mainWalletAddress,
        grossAmount.toFixed(18), hotWalletAmount.toFixed(18), commissionAmount.toFixed(18),
        event.gross.toString(), event.net.toString(), event.fee.toString(), event.txHash,
        String(event.logIndex), String(event.blockNumber), event.blockHash,
        String(event.blockTimestampMs), identity, now],
    );
    await tx.query(
      `INSERT IGNORE INTO xtu_unknown_incoming_transfers
       (chain_id,token_contract,from_address,hot_wallet_address,gross_amount,hot_wallet_received_amount,commission_amount,
        gross_amount_raw,hot_wallet_received_raw,commission_amount_raw,tx_hash,log_index,block_number,block_hash,
        block_timestamp_ms,finalized_at_ms,receipt_json,event_identity,previous_username,status,created_at_ms,updated_at_ms)
       VALUES(56,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,'automatic_refund_pending',?,?)`,
      [settings.tokenAddress, event.sender, settings.mainWalletAddress, grossAmount.toFixed(18),
        hotWalletAmount.toFixed(18), commissionAmount.toFixed(18), event.gross.toString(), event.net.toString(),
        event.fee.toString(), event.txHash, String(event.logIndex), String(event.blockNumber), event.blockHash,
        String(event.blockTimestampMs), String(nowMs), String(event.receiptJson || null), identity, now, now],
    );
    const [sourceRows] = await tx.query(
      `SELECT id FROM xtu_unknown_incoming_transfers WHERE event_identity=? LIMIT 1 FOR UPDATE`, [identity],
    );
    if (!sourceRows.length) throw new Error("The finalized unknown XTU transfer could not be persisted.");
    const registered = await registerAutomaticRefundEventTx(tx, {
      chainId: 56,
      tokenContract: settings.tokenAddress,
      assetCode: "XTU",
      senderAddress: event.sender,
      payoutAddress: event.sender,
      sourceTable: "xtu_unknown_incoming_transfers",
      sourceId: String(sourceRows[0].id),
      sourceKind: "xtu_unknown",
      eventIdentity: identity,
      txHash: event.txHash,
      logIndex: Number(event.logIndex),
      blockNumber: String(event.blockNumber),
      blockHash: event.blockHash,
      grossAmount: hotWalletAmount.toFixed(18),
      finalizedAtMs: nowMs,
      category: "A",
      reasonCode: "official_unknown_sender",
      nowMs,
    });
    await tx.query(
      `UPDATE xtu_unknown_incoming_transfers SET status='automatic_refund_pending',updated_at_ms=?
       WHERE id=? AND status IN ('pending_admin','automatic_refund_pending')`, [now, String(sourceRows[0].id)],
    );
    return { status: "automatic_refund_pending", category: "A", groupId: registered.groupId, duplicate: Boolean(registered.duplicate) };
  }

  const username = authRows[0].username;
  const eventTimestamp = Number(event.blockTimestampMs);
  const finalizedAtMs = Number.isSafeInteger(Number(event.finalizedAtMs)) && Number(event.finalizedAtMs) > 0
    ? Number(event.finalizedAtMs) : Date.now();
  const grossAmount = new BigNumber(event.gross.toString()).shiftedBy(-18);
  const hotWalletAmount = new BigNumber(event.net.toString()).shiftedBy(-18);
  const commissionAmount = new BigNumber(event.fee.toString()).shiftedBy(-18);
  if (!grossAmount.isFinite() || !grossAmount.isGreaterThan(0) ||
      !hotWalletAmount.isFinite() || !hotWalletAmount.isGreaterThan(0) ||
      !commissionAmount.isFinite() || commissionAmount.isNegative() ||
      !hotWalletAmount.plus(commissionAmount).eq(grossAmount)) {
    throw new Error("The finalized XTU deposit event has inconsistent gross, net and commission amounts.");
  }

  const [globalRows] = await tx.query(
    `SELECT id,status,effective_at_ms FROM global_disbursement_runs
     WHERE status IN ('active','closed','manual_review','completed','resolved')
     ORDER BY id DESC LIMIT 1 FOR UPDATE`,
  );
  const candidateGlobal = globalRows[0] || null;
  const eventGlobalRunId = candidateGlobal && isGlobalDisbursementEffective(candidateGlobal.status) &&
    eventTimestamp >= Number(candidateGlobal.effective_at_ms || Number.MAX_SAFE_INTEGER)
    ? String(candidateGlobal.id) : null;
  const [controlRows] = await tx.query(
    "SELECT is_suspended FROM deposit_service_control WHERE control_id=1 LIMIT 1 FOR UPDATE",
  );
  const manuallySuspended = Number(controlRows[0]?.is_suspended || 0) === 1;
  const accountInactive = Number(authRows[0].account_active) !== 1;
  const globalCutoff = eventGlobalRunId != null;

  const [activeRows] = await tx.query(
    `SELECT * FROM xtu_deposit_batches
     WHERE username=? AND status='collecting' AND CAST(expires_at_ms AS UNSIGNED)>?
     ORDER BY opened_at_ms ASC,id ASC LIMIT 1 FOR UPDATE`, [username, String(finalizedAtMs)],
  );
  let batch = activeRows[0] || null;
  if (batch && String(batch.global_run_id || "") !== String(eventGlobalRunId || "")) batch = null;

  if (!batch) {
    const [reopenRows] = await tx.query(
      `SELECT * FROM xtu_deposit_batches
       WHERE username=? AND status='pending_minimum' AND global_run_id <=> ?
         AND CAST(expires_at_ms AS UNSIGNED)>?
       ORDER BY opened_at_ms ASC,id ASC LIMIT 1 FOR UPDATE`,
      [username, eventGlobalRunId, String(finalizedAtMs)],
    );
    batch = reopenRows[0] || null;
  }

  let blockingReason = null;
  if (globalCutoff) blockingReason = "received_after_global_disbursement_cutoff";
  else if (manuallySuspended) blockingReason = "manual_deposit_suspended";
  else if (accountInactive) blockingReason = "account_deactivated";

  // A returned XTU reduces the externalized exposure exactly once when its
  // finalized event is registered, never later at consolidation or expiry.
  const common = await getLatestCommonTx(tx, true);
  const outstandingXtu = new BigNumber(common.xtu_wallets || "0");
  const counterConsistent = outstandingXtu.isFinite() && !outstandingXtu.isNegative() && outstandingXtu.gte(grossAmount);
  if (!counterConsistent) blockingReason = "xtu_return_counter_insufficient_manual_review";

  if (accountInactive) {
    const [inserted] = await tx.query(
      `INSERT IGNORE INTO xtu_deposit_transfer_events
       (username,batch_id,token_contract,from_address,hot_wallet_address,gross_amount,net_amount,commission_amount,
        gross_amount_raw,net_amount_raw,commission_amount_raw,tx_hash,log_index,block_number,block_hash,
        block_timestamp_ms,event_identity,status,reason_codes,common_xtu_counter_decremented_at_ms,created_at_ms)
       VALUES(?,NULL,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'automatic_refund_pending','["account_deactivated"]',NULL,?)`,
      [username, settings.tokenAddress, event.sender, settings.mainWalletAddress, grossAmount.toFixed(18),
        hotWalletAmount.toFixed(18), commissionAmount.toFixed(18), event.gross.toString(), event.net.toString(),
        event.fee.toString(), event.txHash, String(event.logIndex), String(event.blockNumber), event.blockHash,
        String(eventTimestamp), identity, String(finalizedAtMs)],
    );
    let sourceId = null;
    if (Number(inserted.affectedRows || 0) === 1) sourceId = String(inserted.insertId);
    else {
      const [existingSourceRows] = await tx.query(
        `SELECT id,status FROM xtu_deposit_transfer_events WHERE event_identity=? LIMIT 1 FOR UPDATE`, [identity],
      );
      if (!existingSourceRows.length || String(existingSourceRows[0].status) !== "automatic_refund_pending") return { status: "duplicate_or_conflict" };
      sourceId = String(existingSourceRows[0].id);
    }
    const registered = await registerAutomaticRefundEventTx(tx, {
      chainId: 56,
      tokenContract: settings.tokenAddress,
      assetCode: "XTU",
      senderAddress: event.sender,
      payoutAddress: event.sender,
      sourceTable: "xtu_deposit_transfer_events",
      sourceId,
      sourceKind: "xtu_registered",
      eventIdentity: identity,
      txHash: event.txHash,
      logIndex: Number(event.logIndex),
      blockNumber: String(event.blockNumber),
      blockHash: event.blockHash,
      grossAmount: hotWalletAmount.toFixed(18),
      finalizedAtMs,
      category: "C",
      username,
      reasonCode: "account_deactivated",
      nowMs: finalizedAtMs,
    });
    if (counterConsistent) {
      const [date, time] = utcDateTime();
      await insertCommonSnapshotTx(tx, common, { xtu_wallets: outstandingXtu.minus(grossAmount).toFixed(30) }, date, time);
      await tx.query(
        `UPDATE xtu_deposit_transfer_events SET common_xtu_counter_decremented_at_ms=? WHERE id=? AND common_xtu_counter_decremented_at_ms IS NULL`,
        [String(finalizedAtMs), sourceId],
      );
    } else {
      const [groupRows] = await tx.query(
        `SELECT id FROM automatic_refund_groups WHERE id=? LIMIT 1 FOR UPDATE`, [registered.groupId],
      );
      if (groupRows.length) {
        await tx.query(
          `UPDATE automatic_refund_group_events SET status='manual_review',reason_code='xtu_return_counter_insufficient'
           WHERE source_table='xtu_deposit_transfer_events' AND source_id=?`, [sourceId],
        );
        await tx.query(
          `UPDATE automatic_refund_groups SET status='manual_review',manual_review_reason='The XTU externalized-return counter is insufficient for this finalized source transfer.'
           WHERE id=?`, [registered.groupId],
        );
      }
    }
    return { status: counterConsistent ? "automatic_refund_pending" : "manual_review", category: "C", groupId: registered.groupId };
  }

  if (!batch) {
    const [lastRows] = await tx.query(
      `SELECT * FROM xtu_deposit_batches WHERE username=? ORDER BY opened_at_ms DESC,id DESC LIMIT 1 FOR UPDATE`,
      [username],
    );
    const lastBatch = lastRows[0] || null;
    if (lastBatch && !["credited", "forfeited_to_common_reserve", "rejected", "reversed"].includes(String(lastBatch.status)) &&
        String(lastBatch.status) !== "pending_minimum") {
      // Never merge a later payment into an already eligible/blocked batch.
      // It opens its own fixed 30-day batch and is kept in FIFO order.
    }
    const initialStatus = counterConsistent
      ? (blockingReason ? (blockingReason === "xtu_return_counter_insufficient_manual_review" ? "manual_review" :
        blockingReason === "received_after_global_disbursement_cutoff" ? "pending_global" : "pending_support") : "collecting")
      : "manual_review";
    const batchId = await createDepositBatchTx(
      tx, username, settings, finalizedAtMs, initialStatus,
      blockingReason || null, eventGlobalRunId,
    );
    const [newRows] = await tx.query("SELECT * FROM xtu_deposit_batches WHERE id=? LIMIT 1 FOR UPDATE", [batchId]);
    batch = newRows[0];
  }

  const nextGross = new BigNumber(batch.gross_amount || "0").plus(grossAmount);
  const nextHot = new BigNumber(batch.hot_wallet_received_amount || "0").plus(hotWalletAmount);
  const nextCommission = new BigNumber(batch.commission_amount || "0").plus(commissionAmount);
  let eventStatus = "detected";
  let batchStatus = String(batch.status);
  if (!counterConsistent) {
    batchStatus = "manual_review";
    eventStatus = "manual_review";
  } else if (blockingReason === "received_after_global_disbursement_cutoff") {
    batchStatus = "pending_global";
    eventStatus = "pending_global";
  } else if (blockingReason) {
    batchStatus = "pending_support";
    eventStatus = "pending_support";
  } else {
    batchStatus = nextGross.gte(MIN_XTU_DEPOSIT) ? "ready" : "collecting";
    eventStatus = batchStatus;
  }

  const eventValues = [username, String(batch.id), settings.tokenAddress, event.sender, settings.mainWalletAddress,
    grossAmount.toFixed(18), hotWalletAmount.toFixed(18), commissionAmount.toFixed(18), event.gross.toString(),
    event.net.toString(), event.fee.toString(), event.txHash, String(event.logIndex), String(event.blockNumber),
    event.blockHash, String(eventTimestamp), identity, eventStatus,
    blockingReason ? JSON.stringify([blockingReason]) : "[]",
    counterConsistent ? String(Date.now()) : null, String(Date.now())];
  if (previouslyUnknownEvent) {
    await tx.query(
      `UPDATE xtu_deposit_transfer_events SET username=?,batch_id=?,token_contract=?,from_address=?,hot_wallet_address=?,
       gross_amount=?,net_amount=?,commission_amount=?,gross_amount_raw=?,net_amount_raw=?,commission_amount_raw=?,
       tx_hash=?,log_index=?,block_number=?,block_hash=?,block_timestamp_ms=?,status=?,reason_codes=?,
       common_xtu_counter_decremented_at_ms=?,created_at_ms=? WHERE event_identity=? AND username IS NULL AND status='pending_identity'`,
      [eventValues[0], eventValues[1], eventValues[2], eventValues[3], eventValues[4],
        eventValues[5], eventValues[6], eventValues[7], eventValues[8], eventValues[9], eventValues[10],
        eventValues[11], eventValues[12], eventValues[13], eventValues[14], eventValues[15],
        eventValues[17], eventValues[18], eventValues[19], eventValues[20], identity],
    );
  } else {
    const [insertResult] = await tx.query(
      `INSERT IGNORE INTO xtu_deposit_transfer_events
       (username,batch_id,token_contract,from_address,hot_wallet_address,gross_amount,net_amount,commission_amount,
        gross_amount_raw,net_amount_raw,commission_amount_raw,tx_hash,log_index,block_number,block_hash,
        block_timestamp_ms,event_identity,status,reason_codes,common_xtu_counter_decremented_at_ms,created_at_ms)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, eventValues,
    );
    if (Number(insertResult.affectedRows || 0) !== 1) return { status: "duplicate" };
  }

  if (counterConsistent) {
    const nextOutstanding = outstandingXtu.minus(grossAmount);
    const [date, time] = utcDateTime();
    await insertCommonSnapshotTx(tx, common, { xtu_wallets: nextOutstanding.toFixed(30) }, date, time);
  }

  await tx.query(
    `UPDATE xtu_deposit_batches
     SET gross_amount=gross_amount+?,hot_wallet_received_amount=hot_wallet_received_amount+?,
         commission_amount=commission_amount+?,returned_amount=returned_amount+?,remaining_amount=remaining_amount+?,transfer_count=transfer_count+1,
         common_xtu_return_accounted_at_ms=CASE WHEN ? IS NULL THEN common_xtu_return_accounted_at_ms ELSE ? END,
         status=?,pending_since_ms=CASE WHEN ?='collecting' THEN pending_since_ms ELSE COALESCE(pending_since_ms,?) END,
         reason_codes=?,updated_at_ms=? WHERE id=?`,
    [grossAmount.toFixed(18), hotWalletAmount.toFixed(18), commissionAmount.toFixed(18), grossAmount.toFixed(18), grossAmount.toFixed(18),
      counterConsistent ? String(Date.now()) : null, counterConsistent ? String(Date.now()) : null,
      batchStatus, batchStatus, String(Date.now()), blockingReason ? JSON.stringify([blockingReason]) : "[]",
      String(Date.now()), String(batch.id)],
  );

  await tx.query(
    `INSERT IGNORE INTO xtu_hot_wallet_lots
     (event_identity,batch_id,username,token_contract,chain_id,from_address,hot_wallet_address,tx_hash,log_index,
      gross_amount,hot_wallet_received_amount,commission_amount,pending_user_amount,protected_hot_wallet_amount,
      status,first_finalized_at_ms,created_at_ms,updated_at_ms)
     VALUES(?,?,?,?,56,?,?,?,?,?,?,?,?,?,'protected',?,?,?)`,
    [identity, String(batch.id), username, settings.tokenAddress, event.sender, settings.mainWalletAddress,
      event.txHash, String(event.logIndex), grossAmount.toFixed(18), hotWalletAmount.toFixed(18),
      commissionAmount.toFixed(18), hotWalletAmount.toFixed(18), hotWalletAmount.toFixed(18),
      String(finalizedAtMs), String(finalizedAtMs), String(finalizedAtMs)],
  );

  if (blockingReason) {
    const detail = blockingReason === "xtu_return_counter_insufficient_manual_review"
      ? `The finalized XTU transfer is ${grossAmount.toFixed(8)} XTU, but common.xtu_wallets is only ${outstandingXtu.toFixed(8)} XTU. The amount is protected and requires administrative reconciliation; no credit, counter decrement or consolidation is allowed.`
      : `The XTU transfer is finalized and recorded, but deposit processing is blocked: ${blockingReason}. It remains protected until the blocking condition is resolved or its fixed expiry is reached.`;
    await notifyUserTx(tx, username, `xtu-deposit:${identity}:pending`, "OneX XTU deposit pending", detail);
  } else {
    const missing = BigNumber.maximum(0, MIN_XTU_DEPOSIT.minus(nextGross));
    const statusMessage = batchStatus === "collecting"
      ? `Your finalized XTU transfer has been recorded. Current batch total: ${nextGross.toFixed(8)} XTU. Another ${missing.toFixed(8)} XTU is required to reach the 20 XTU minimum. Fixed expiry: ${new Date(Number(batch.expires_at_ms)).toISOString()}. Any amount still uncredited at expiry is irrevocably reclassified to OneX common reserves and is not refundable.`
      : `Your XTU batch has reached the 20 XTU minimum and is now being checked for immediate credit. Batch total: ${nextGross.toFixed(8)} XTU. The 100 XTU limit applies per credit tranche; any amount not credited remains pending until its fixed 30-day expiry, when it is irrevocably reclassified to common reserves.`;
    await notifyUserTx(tx, username, `xtu-deposit:${identity}:received`, "OneX XTU deposit received", statusMessage);
  }
  return { status: eventStatus, username, batchId: String(batch.id), creditReady: batchStatus === "ready" };
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
        finalizedAtMs: Date.now(),
        receiptJson: JSON.stringify(receipt),
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
      calculateRemainingAdministrativeBacking(
        stock_limit, SYSTEM_ADMIN_RESERVE_RATIO, common.admin_expens || "0",
      ).remainingInitialAsset, 0,
    )
    : calculateSellerOnlyDepositFundingAllocation(
      credit.creditedInitialAsset, common.unit_price, common.backed_units,
      common.inactive_init_asset, sellerAvailable, common.total_units_price,
      calculateRemainingAdministrativeBacking(
        stock_limit, SYSTEM_ADMIN_RESERVE_RATIO, common.admin_expens || "0",
      ).remainingInitialAsset,
    );
  return { ...purchaseState, allocation };
}

async function assessBatchCapacityTx(tx, batch, gasUsdEstimate, settings) {
  const common = await getLatestCommonTx(tx, true);
  const globalRun = await getGlobalRunTx(tx, batch.global_run_id || null);
  const [priorCreditRows] = await tx.query(
    `SELECT COALESCE(SUM(creditable_xtu),0) AS amount,
            COALESCE(SUM(gross_returned_xtu),0) AS gross_processed,
            COALESCE(SUM(CASE WHEN gas_fee_status='reconciled' THEN gas_actual_fee_xtu ELSE gas_fee_xtu END),0) AS gas_processed,COUNT(*) AS credit_count
     FROM xtu_deposit_credits WHERE batch_id=? FOR UPDATE`, [String(batch.id)],
  );
  const credit = calculateXtuDepositTranche({
    grossReturnedXtu: batch.gross_amount,
    actualGasFeeBscUsd: gasUsdEstimate,
    tfeesRatePercent: batch.tfees_rate_percent ?? tfees,
    globalDisbursementActive: Boolean(globalRun),
    globalUnitPrice: common.unit_price,
    creditedBeforeXtu: priorCreditRows[0]?.amount || "0",
    grossCreditedBeforeXtu: priorCreditRows[0]?.gross_processed || "0",
    gasCreditedBeforeXtu: priorCreditRows[0]?.gas_processed || "0",
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

async function ensureXtuBatchGasProvision(pool, batchId, runtime) {
  const existingRows = await pool.queryAsync(
    "SELECT * FROM xtu_deposit_batches WHERE id=? LIMIT 1", [String(batchId)],
  );
  if (!existingRows.length) return null;
  const existing = existingRows[0];
  const existingProvision = new BigNumber(existing.gas_provisioned_usd || "0");
  if (existingProvision.isGreaterThan(0)) return { feeUsd: existingProvision, feeBnb: new BigNumber(0), provisional: true };
  if (["manual_review", "pending_global", "forfeited_to_common_reserve", "credited"].includes(String(existing.status))) return null;

  const data = runtime.contract.interface.encodeFunctionData("transfer", [runtime.settings.distributionAddress, 1n]);
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
  if (bufferedGasLimit > runtime.settings.depositGasLimitCeiling) {
    throw new RangeError("The estimated XTU consolidation gas exceeds the configured gas-limit ceiling.");
  }
  const fee = require("./bsc-fee-accounting").calculateEstimatedGasFee(
    bufferedGasLimit.toString(), estimate.gasPrice.toString(), bnbUsdPrice,
  );
  const decision = evaluateBscTxFee(fee.feeUsd, getConfiguredMaxBscTxFeeUsd());
  if (!decision.allowed) {
    const error = new Error("The estimated XTU consolidation gas exceeds BSC_MAX_TX_FEE_BSC_USD; the credit remains pending until the estimate is acceptable.");
    error.code = "BSC_GAS_FEE_LIMIT_EXCEEDED";
    throw error;
  }

  return withTransaction(pool, async (tx) => {
    await acquireDepositLocks(tx);
    const [batchRows] = await tx.query("SELECT * FROM xtu_deposit_batches WHERE id=? LIMIT 1 FOR UPDATE", [String(batchId)]);
    if (!batchRows.length) return null;
    const batch = batchRows[0];
    const currentProvision = new BigNumber(batch.gas_provisioned_usd || "0");
    if (currentProvision.isGreaterThan(0)) return { feeUsd: currentProvision, feeBnb: new BigNumber(0), provisional: true };
    if (["manual_review", "pending_global", "forfeited_to_common_reserve", "credited"].includes(String(batch.status))) return null;

    const [events] = await tx.query(
      `SELECT event_identity,net_amount FROM xtu_deposit_transfer_events
       WHERE batch_id=? AND status NOT IN ('rejected','reversed','manual_review')
       ORDER BY block_timestamp_ms ASC,log_index ASC FOR UPDATE`, [String(batchId)],
    );
    if (!events.length) throw new Error("The XTU batch has no verified finalized source events for gas provision allocation.");
    const allocationRows = allocateBatchGasByGross(
      events.map((row) => ({ event_identity: String(row.event_identity), gross_amount: String(row.net_amount) })),
      fee.feeUsd,
      "event_identity",
    );
    const feeByEvent = new Map(allocationRows.map((entry) => [entry.key, entry.gasFee]));
    for (const event of events) {
      const allocated = feeByEvent.get(String(event.event_identity));
      if (!allocated) throw new Error("The XTU provisional gas allocation is incomplete.");
      await tx.query(
        `UPDATE xtu_deposit_transfer_events SET allocated_gas_fee_usd=?,allocated_gas_fee_xtu=? WHERE event_identity=?`,
        [allocated.toFixed(18), allocated.toFixed(18), String(event.event_identity)],
      );
      await tx.query(
        `UPDATE xtu_hot_wallet_lots SET gas_provision_xtu=?,updated_at_ms=? WHERE event_identity=?`,
        [allocated.toFixed(18), String(Date.now()), String(event.event_identity)],
      );
    }
    await tx.query(
      `UPDATE xtu_deposit_batches SET gas_provisioned_usd=?,gas_allocated_usd=?,gas_allocated_xtu=?,updated_at_ms=? WHERE id=?`,
      [fee.feeUsd.toFixed(18), fee.feeUsd.toFixed(18), fee.feeUsd.toFixed(18), String(Date.now()), String(batchId)],
    );
    return { feeUsd: fee.feeUsd, feeBnb: fee.feeBnb, provisional: true };
  });
}

async function expireOneXtuDepositBatch(pool, batchId, settings, now = Date.now()) {
  return withTransaction(pool, async (tx) => {
    await acquireDepositLocks(tx);
    const [batchRows] = await tx.query("SELECT * FROM xtu_deposit_batches WHERE id=? LIMIT 1 FOR UPDATE", [String(batchId)]);
    if (!batchRows.length) return { skipped: true };
    const batch = batchRows[0];
    if (["credited", "forfeited_to_common_reserve", "rejected", "reversed", "manual_review"].includes(String(batch.status))) {
      return { skipped: true, status: batch.status };
    }
    const expiresAt = Number(batch.expires_at_ms || 0);
    if (!Number.isSafeInteger(expiresAt) || expiresAt <= 0 || now < expiresAt) return { waiting: true };

    const [controlRows] = await tx.query("SELECT is_suspended FROM deposit_service_control WHERE control_id=1 LIMIT 1 FOR UPDATE");
    const [scannerRows] = await tx.query("SELECT health_status FROM xtu_deposit_scan_state WHERE singleton_id=1 LIMIT 1 FOR UPDATE");
    const pauseReason = Number(controlRows[0]?.is_suspended || 0) === 1
      ? "administrative_deposit_suspension"
      : (String(scannerRows[0]?.health_status || "healthy") !== "healthy" ? "xtu_scanner_unavailable_or_reconciliation" : null);
    if (pauseReason) {
      if (batch.expiration_paused_at_ms == null) {
        await tx.query(
          `UPDATE xtu_deposit_batches SET expiration_paused_at_ms=?,expiration_pause_reason=?,updated_at_ms=? WHERE id=?`,
          [String(now), pauseReason, String(now), String(batchId)],
        );
      }
      return { paused: true, reason: pauseReason };
    }
    if (batch.expiration_paused_at_ms != null) {
      const pausedAt = Number(batch.expiration_paused_at_ms);
      if (!Number.isSafeInteger(pausedAt) || pausedAt > now) throw new Error("Invalid XTU deposit expiration pause timestamp.");
      const extendedExpiry = expiresAt + (now - pausedAt);
      await tx.query(
        `UPDATE xtu_deposit_batches SET expires_at_ms=?,initial_group_deadline_ms=?,expiration_paused_at_ms=NULL,
         expiration_pause_reason=NULL,updated_at_ms=? WHERE id=?`,
        [String(extendedExpiry), String(extendedExpiry), String(now), String(batchId)],
      );
      return { resumed: true, expiresAtMs: extendedExpiry };
    }

    const [eventRows] = await tx.query(
      `SELECT event_identity,tx_hash,log_index,gross_amount,net_amount,commission_amount,status
       FROM xtu_deposit_transfer_events WHERE batch_id=? ORDER BY block_number ASC,log_index ASC FOR UPDATE`,
      [String(batchId)],
    );
    if (eventRows.length !== Number(batch.transfer_count || 0) || eventRows.some((row) => ["detected", "pending_reconciliation", "orphaned", "manual_review"].includes(String(row.status)))) {
      await tx.query(
        `UPDATE xtu_deposit_batches SET status='manual_review',reason_codes=?,expiration_paused_at_ms=?,
         expiration_pause_reason='xtu_deposit_event_reconciliation',updated_at_ms=? WHERE id=?`,
        [JSON.stringify(["xtu_deposit_event_reconciliation_required"]), String(now), String(now), String(batchId)],
      );
      await notifyUserTx(tx, batch.username, `xtu-deposit:${batchId}:expiry-reconciliation`, "OneX XTU deposit requires reconciliation",
        `Your XTU deposit reached its 30-day expiry, but its source events do not fully reconcile. No reserve reclassification or credit was performed. The expiry is paused while OneX reviews the blockchain records. Batch: ${batchId}.`);
      return { held: true, reason: "event_reconciliation_mismatch" };
    }

    const [creditRows] = await tx.query(
      `SELECT COALESCE(SUM(creditable_xtu),0) AS credited,
              COALESCE(SUM(gross_returned_xtu),0) AS gross_processed,
              COALESCE(SUM(CASE WHEN gas_fee_status='reconciled' THEN gas_actual_fee_xtu ELSE gas_fee_xtu END),0) AS gas_processed
       FROM xtu_deposit_credits WHERE batch_id=? FOR UPDATE`,
      [String(batchId)],
    );
    const gross = new BigNumber(batch.gross_amount || "0");
    const grossProcessed = new BigNumber(creditRows[0]?.gross_processed || "0");
    const credited = new BigNumber(creditRows[0]?.credited || "0");
    const gasProcessed = new BigNumber(creditRows[0]?.gas_processed || "0");
    const grossRemaining = BigNumber.maximum(0, gross.minus(grossProcessed).decimalPlaces(18, BigNumber.ROUND_DOWN));
    const batchRemaining = new BigNumber(batch.remaining_amount || "0");
    if (!gross.isFinite() || gross.isNegative() || grossProcessed.gt(gross) ||
        !grossRemaining.eq(batchRemaining) || !gasProcessed.isFinite() || gasProcessed.isNegative()) {
      await tx.query(
        `UPDATE xtu_deposit_batches SET status='manual_review',reason_codes=?,expiration_paused_at_ms=?,
         expiration_pause_reason='xtu_credit_ledger_mismatch',updated_at_ms=? WHERE id=?`,
        [JSON.stringify(["xtu_credit_ledger_mismatch_at_expiry"]), String(now), String(now), String(batchId)],
      );
      await notifyUserTx(tx, batch.username, `xtu-deposit:${batchId}:expiry-ledger-review`, "OneX XTU deposit requires accounting review",
        `Your XTU deposit reached its expiry date, but its gross/credit ledger does not reconcile. No amount was reclassified or credited. OneX has paused the expiry for accounting review. Batch: ${batchId}.`);
      return { held: true, reason: "credit_ledger_mismatch" };
    }

    if (grossRemaining.isZero()) {
      await tx.query(
        `UPDATE xtu_deposit_batches SET remaining_amount=0,status='credited',forfeited_at_ms=?,updated_at_ms=? WHERE id=?`,
        [String(now), String(now), String(batchId)],
      );
      return { completed: true, amount: "0" };
    }

    // No OneX deposit fee is deducted from the uncredited remainder. Only the
    // remaining gas provision (or its already-known actual allocation) reduces
    // the reserve value recognised at the 1:1 internal accounting parity.
    const provisionTotal = new BigNumber(batch.gas_provisioned_usd || "0");
    const actualTotal = new BigNumber(batch.gas_actual_usd || "0");
    if (!provisionTotal.isFinite() || provisionTotal.isNegative() || !actualTotal.isFinite() || actualTotal.isNegative()) {
      throw new Error("Invalid XTU gas provision or actual gas amount at expiry.");
    }
    const provisionRemaining = BigNumber.maximum(0, provisionTotal.minus(gasProcessed).decimalPlaces(18, BigNumber.ROUND_DOWN));
    const actualKnown = actualTotal.isGreaterThan(0);
    const actualRemaining = actualKnown ? actualTotal.minus(gasProcessed).decimalPlaces(18, BigNumber.ROUND_DOWN) : null;
    if (actualKnown && actualRemaining.isNegative()) {
      await tx.query(
        `UPDATE xtu_deposit_batches SET status='manual_review',reason_codes=?,expiration_paused_at_ms=?,
         expiration_pause_reason='xtu_gas_reconciliation',updated_at_ms=? WHERE id=?`,
        [JSON.stringify(["actual_consolidation_gas_below_previously_allocated_provision"]), String(now), String(now), String(batchId)],
      );
      await notifyUserTx(tx, batch.username, `xtu-deposit:${batchId}:gas-reconciliation`, "OneX XTU deposit gas reconciliation required",
        `The actual XTU consolidation gas is lower than the provision already assigned to credited tranches. The difference requires reconciliation before the expired remainder can be reclassified. No additional debit or credit has been applied. Batch: ${batchId}.`);
      return { held: true, reason: "gas_reconciliation_required" };
    }
    const gasForExpiredRemainder = actualKnown ? actualRemaining : provisionRemaining;
    if (gasForExpiredRemainder.gt(grossRemaining)) {
      await tx.query(
        `UPDATE xtu_deposit_batches SET status='manual_review',reason_codes=?,expiration_paused_at_ms=?,
         expiration_pause_reason='xtu_gas_exceeds_remainder',updated_at_ms=? WHERE id=?`,
        [JSON.stringify(["xtu_expiry_gas_exceeds_uncredited_gross"]), String(now), String(now), String(batchId)],
      );
      return { held: true, reason: "gas_exceeds_uncredited_gross" };
    }
    const expiredReserveValue = grossRemaining.minus(gasForExpiredRemainder).decimalPlaces(18, BigNumber.ROUND_DOWN);
    if (!expiredReserveValue.isFinite() || expiredReserveValue.isNegative()) throw new Error("Invalid XTU expired reserve value.");

    const common = await getLatestCommonTx(tx, true);
    const sourceHashes = JSON.stringify(eventRows.map((row) => ({
      event_identity: String(row.event_identity), tx_hash: String(row.tx_hash).toLowerCase(),
      log_index: Number(row.log_index), gross_amount: String(row.gross_amount),
      net_amount: String(row.net_amount), commission_amount: String(row.commission_amount),
    })));
    const eventKey = `deposit-expiry:XTU:${batchId}`;
    const [insertResult] = await tx.query(
      `INSERT IGNORE INTO deposit_expiration_events
       (asset_code,batch_id,username,expired_amount,value_added_to_common,gas_provision_value,gas_actual_value,
        gas_adjustment_value,gas_adjustment_applied_at_ms,global_unit_price,source_event_hashes_json,event_key,status,created_at_ms)
       VALUES('XTU',?,?,?,?,?,?,?,?,?,?,?,'applied',?)`,
      [String(batchId), batch.username, grossRemaining.toFixed(18), expiredReserveValue.toFixed(30),
        provisionRemaining.toFixed(18), actualKnown ? actualRemaining.toFixed(18) : "0",
        actualKnown ? provisionRemaining.minus(actualRemaining).toFixed(18) : "0",
        actualKnown ? String(now) : null, String(common.unit_price), sourceHashes, eventKey, String(now)],
    );
    if (Number(insertResult.affectedRows || 0) === 1) {
      if (expiredReserveValue.isGreaterThan(0)) {
        const [date, time] = utcDateTime(now);
        await insertCommonSnapshotTx(tx, common, {
          total_units_price: new BigNumber(common.total_units_price).plus(expiredReserveValue).toFixed(30),
        }, date, time);
        const [snapshotRows] = await tx.query("SELECT id FROM common ORDER BY id DESC LIMIT 1 FOR UPDATE");
        if (!snapshotRows.length) throw new Error("The common reserve snapshot was not persisted for XTU expiry.");
        await tx.query("UPDATE deposit_expiration_events SET common_snapshot_id=? WHERE event_key=?", [String(snapshotRows[0].id), eventKey]);
      }
    }

    await tx.query(
      `UPDATE xtu_deposit_batches SET expired_common_reserve_amount=expired_common_reserve_amount+?,remaining_amount=0,
       status='forfeited_to_common_reserve',reason_codes=NULL,forfeited_at_ms=?,updated_at_ms=?
       WHERE id=? AND status<>'forfeited_to_common_reserve'`,
      [expiredReserveValue.toFixed(18), String(now), String(now), String(batchId)],
    );

    const [lots] = await tx.query(
      `SELECT * FROM xtu_hot_wallet_lots WHERE batch_id=?
       ORDER BY first_finalized_at_ms ASC,tx_hash ASC,log_index ASC,id ASC FOR UPDATE`, [String(batchId)],
    );
    for (const lot of lots) {
      const hotNet = new BigNumber(lot.hot_wallet_received_amount || "0");
      const creditedNet = new BigNumber(lot.credited_amount || "0");
      const expiredNet = BigNumber.maximum(0, hotNet.minus(creditedNet));
      await tx.query(
        `UPDATE xtu_hot_wallet_lots SET pending_user_amount=0,
         expired_common_reserve_amount=?,status='common_reserve_owned',expired_at_ms=?,updated_at_ms=? WHERE id=?`,
        [expiredNet.toFixed(18), String(now), String(now), String(lot.id)],
      );
    }
    await tx.query(
      `UPDATE xtu_deposit_transfer_events SET status='forfeited_to_common_reserve',reason_codes=NULL WHERE batch_id=?`,
      [String(batchId)],
    );
    await notifyUserTx(tx, batch.username, `xtu-deposit:${batchId}:forfeited`, "OneX XTU deposit expired",
      `${grossRemaining.toFixed(8)} gross XTU remained uncredited at the fixed 30-day expiry. The recognised common-reserve value is ${expiredReserveValue.toFixed(8)} XTU/BSC-USD equivalent after the applicable gas provision or actual gas allocation. No OneX deposit fee was charged on this uncredited remainder. The physical XTU remains protected in the Hot Wallet until an eligible FIFO consolidation lot reaches at least 100 XTU net. It cannot be refunded or credited later. Batch: ${batchId}.`);
    return { forfeited: true, grossAmount: grossRemaining.toFixed(18), reserveValue: expiredReserveValue.toFixed(18) };
  });
}

async function expireDueXtuDepositBatches(pool, settings, now = Date.now()) {
  const rows = await pool.queryAsync(
    `SELECT id FROM xtu_deposit_batches WHERE remaining_amount>0
       AND CAST(expires_at_ms AS UNSIGNED)<=?
       AND status NOT IN ('credited','forfeited_to_common_reserve','rejected','reversed','manual_review')
     ORDER BY CAST(expires_at_ms AS UNSIGNED) ASC,id ASC LIMIT 100`, [String(now)],
  );
  for (const row of rows) {
    try { await expireOneXtuDepositBatch(pool, row.id, settings, now); }
    catch (error) { console.error(`XTU deposit expiry failed for batch ${row.id}:`, error.message); }
  }
}

async function notifyDueXtuDepositExpirations(pool, now = Date.now()) {
  const rows = await pool.queryAsync(
    `SELECT id,username,gross_amount,credited_amount,remaining_amount,expires_at_ms
     FROM xtu_deposit_batches WHERE remaining_amount>0 AND expiration_warning_sent_at_ms IS NULL
       AND CAST(expires_at_ms AS UNSIGNED)>? AND CAST(expires_at_ms AS UNSIGNED)<=?
       AND status NOT IN ('credited','forfeited_to_common_reserve','rejected','reversed','manual_review')
     ORDER BY expires_at_ms ASC,id ASC LIMIT 100`, [String(now), String(now + 24 * 60 * 60 * 1000)],
  );
  for (const row of rows) {
    await withTransaction(pool, async (tx) => {
      const [locked] = await tx.query("SELECT * FROM xtu_deposit_batches WHERE id=? LIMIT 1 FOR UPDATE", [String(row.id)]);
      if (!locked.length || locked[0].expiration_warning_sent_at_ms != null) return;
      const batch = locked[0];
      await notifyUserTx(tx, batch.username, `xtu-deposit:${batch.id}:expiry-warning`, "OneX XTU deposit expiry warning",
        `Your XTU deposit batch ${batch.id} has ${new BigNumber(batch.remaining_amount || "0").toFixed(8)} XTU-equivalent still pending and expires at ${new Date(Number(batch.expires_at_ms)).toISOString()}. Any uncredited remainder will be irrevocably reclassified to OneX common reserves and cannot be refunded or credited later. Resolve the stated minimum, account-capacity or reserve condition before expiry.`);
      await tx.query("UPDATE xtu_deposit_batches SET expiration_warning_sent_at_ms=?,updated_at_ms=? WHERE id=? AND expiration_warning_sent_at_ms IS NULL",
        [String(now), String(now), String(row.id)]);
    });
  }
}

async function closeExpiredBatches(pool, settings) {
  return expireDueXtuDepositBatches(pool, settings, Date.now());
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
  const [tokenBalance, nativeBalance, protectedDepositRows, protectedUnknownRows, unbackedAutomaticRefundAmount] = await Promise.all([
    runtime.contract.balanceOf(runtime.settings.mainWalletAddress),
    runtime.provider.getBalance(runtime.settings.mainWalletAddress),
    pool.queryAsync(
      `SELECT COALESCE(SUM(protected_hot_wallet_amount),0) AS amount
       FROM xtu_hot_wallet_lots
       WHERE status IN ('protected','consolidation_reserved','common_reserve_owned')`,
    ),
    pool.queryAsync(
      `SELECT COALESCE(SUM(CASE WHEN status='refunded' THEN refund_residual_amount ELSE hot_wallet_received_amount END),0) AS amount
       FROM xtu_unknown_incoming_transfers
       WHERE status IN ('pending_admin','refund_approved','refund_queued','refund_signed','refund_submitted','refund_manual_review','refund_failed','retained_uncredited','refunded','automatic_refund_pending')`,
    ),
    getUnbackedAutomaticRefundXtuAmount(pool),
  ]);
  const protectedHotWalletTotal = new BigNumber(protectedDepositRows[0]?.amount || "0")
    .plus(protectedUnknownRows[0]?.amount || "0")
    .plus(unbackedAutomaticRefundAmount);
  const actualHotWalletBalance = new BigNumber(tokenBalance.toString()).shiftedBy(-18);
  if (!protectedHotWalletTotal.isFinite() || protectedHotWalletTotal.isNegative() ||
      !actualHotWalletBalance.isFinite() || actualHotWalletBalance.lt(protectedHotWalletTotal) ||
      BigInt(tokenBalance) < rawAmount) {
    throw new Error("The XTU Hot Wallet does not cover every protected user deposit, expired common-reserve lot and unknown-transfer balance; consolidation is blocked pending reconciliation.");
  }
  if (BigInt(nativeBalance) < BigInt(gasEstimate.feeBnb.shiftedBy(18).integerValue(BigNumber.ROUND_CEIL).toFixed(0))) {
    throw new Error("The XTU Hot Wallet does not have enough BNB for deposit consolidation gas.");
  }

  const grossRows = batches.map((batch) => ({
    id: String(batch.id), gross_amount: String(batch.consolidation_available_amount ?? batch.hot_wallet_received_amount),
  }));
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
      if (["manual_review", "rejected", "reversed"].includes(String(locked.status))) return;
      const gross = new BigNumber(locked.gross_amount || "0");
      const received = new BigNumber(locked.hot_wallet_received_amount || "0");
      const consolidated = new BigNumber(locked.hot_wallet_consolidated_amount || "0");
      const reserved = new BigNumber(locked.consolidation_reserved_amount || "0");
      const available = BigNumber.maximum(0, received.minus(consolidated).minus(reserved));
      if (!gross.isFinite() || gross.isNegative() || !received.isFinite() || !received.isGreaterThan(0) ||
          !available.isFinite() || !available.isGreaterThan(0)) return;
      lockedReceived = lockedReceived.plus(available);
      lockedGross = lockedGross.plus(gross);
    }
    if (!lockedReceived.eq(totalReceived) || lockedReceived.lt(runtime.settings.depositConsolidationMinBatchXtu)) return;

    const [protectedLotRows] = await tx.query(
      `SELECT id,protected_hot_wallet_amount FROM xtu_hot_wallet_lots
       WHERE status IN ('protected','consolidation_reserved','common_reserve_owned') FOR UPDATE`,
    );
    const [protectedUnknownRowsLocked] = await tx.query(
      `SELECT id,status,hot_wallet_received_amount,refund_residual_amount FROM xtu_unknown_incoming_transfers
       WHERE status IN ('pending_admin','refund_approved','refund_queued','refund_signed','refund_submitted','refund_manual_review','refund_failed','retained_uncredited','refunded','automatic_refund_pending')
       FOR UPDATE`,
    );
    const unbackedAutomaticRefundAmount = await getUnbackedAutomaticRefundXtuAmount(tx);
    const protectedLotTotal = protectedLotRows.reduce((total, row) =>
      total.plus(row.protected_hot_wallet_amount || "0"), new BigNumber(0));
    const protectedUnknownTotal = protectedUnknownRowsLocked.reduce((total, row) =>
      total.plus(row.status === 'refunded' ? (row.refund_residual_amount || "0") : (row.hot_wallet_received_amount || "0")), new BigNumber(0));
    const lockedProtectedTotal = protectedLotTotal.plus(protectedUnknownTotal).plus(unbackedAutomaticRefundAmount);
    const freshHotWalletBalance = new BigNumber((await runtime.contract.balanceOf(runtime.settings.mainWalletAddress)).toString()).shiftedBy(-18);
    if (!lockedProtectedTotal.isFinite() || lockedProtectedTotal.isNegative() ||
        !freshHotWalletBalance.isFinite() || freshHotWalletBalance.lt(lockedProtectedTotal)) {
      throw new Error("The XTU Hot Wallet balance no longer covers all locked protected deposit and unknown-transfer lots; no consolidation transaction was persisted.");
    }

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
      const received = new BigNumber(locked.hot_wallet_received_amount || "0");
      const consolidated = new BigNumber(locked.hot_wallet_consolidated_amount || "0");
      const reserved = new BigNumber(locked.consolidation_reserved_amount || "0");
      const available = BigNumber.maximum(0, received.minus(consolidated).minus(reserved));
      const gross = new BigNumber(locked.gross_amount || "0");
      if (!available.isGreaterThan(0)) throw new Error("The XTU deposit lot has no unreserved Hot Wallet balance.");
      await tx.query(
        `INSERT INTO xtu_deposit_consolidation_items
         (consolidation_id,batch_id,username,gross_returned_xtu,hot_wallet_received_xtu,contract_commission_xtu,
          estimated_gas_fee_bnb,estimated_gas_fee_usd,allocated_gas_fee_bnb,allocated_gas_fee_usd,
          allocated_gas_fee_xtu,status,created_at_ms,updated_at_ms)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,'signed',?,?)`,
        [consolidationId, batchId, locked.username, gross.toFixed(18), available.toFixed(18),
          new BigNumber(locked.commission_amount || "0").toFixed(18),
          estimatedBnbByBatch.get(batchId).toFixed(30), estimatedUsdByBatch.get(batchId).toFixed(30),
          "0", "0", "0", now, now],
      );
      await tx.query(
        `UPDATE xtu_deposit_batches SET consolidation_reserved_amount=consolidation_reserved_amount+?,updated_at_ms=? WHERE id=?`,
        [available.toFixed(18), now, batchId],
      );
      await tx.query(
        `UPDATE xtu_hot_wallet_lots SET consolidation_reserved_amount=protected_hot_wallet_amount,
         status='consolidation_reserved',updated_at_ms=? WHERE batch_id=? AND consolidated_amount<hot_wallet_received_amount`,
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
  if (Boolean(matching.args.feeExempt) || fee !== 0n || net !== gross || gross !== BigInt(String(row.amount_raw))) {
    throw new Error("The Hot Wallet to Distribution Wallet consolidation did not use the exact zero-commission exemption.");
  }
  return { gross, net, fee };
}

async function allocateXtuGrossCreditToLotsTx(tx, batchId, trancheGrossAmount) {
  let remainingGross = new BigNumber(trancheGrossAmount);
  if (!remainingGross.isFinite() || !remainingGross.isGreaterThan(0)) {
    throw new RangeError("The XTU credited gross tranche must be positive.");
  }
  const [lots] = await tx.query(
    `SELECT * FROM xtu_hot_wallet_lots WHERE batch_id=?
     ORDER BY first_finalized_at_ms ASC,tx_hash ASC,log_index ASC,id ASC FOR UPDATE`,
    [String(batchId)],
  );
  if (!lots.length) throw new Error("The XTU credited tranche has no protected Hot Wallet source lots.");

  for (const lot of lots) {
    if (!remainingGross.isGreaterThan(0)) break;
    const lotGross = new BigNumber(lot.gross_amount || "0");
    const lotGrossCredited = new BigNumber(lot.gross_credited_amount || "0");
    const lotHotNet = new BigNumber(lot.hot_wallet_received_amount || "0");
    const lotNetCredited = new BigNumber(lot.credited_amount || "0");
    const lotExpiredNet = new BigNumber(lot.expired_common_reserve_amount || "0");
    const availableGross = BigNumber.maximum(0, lotGross.minus(lotGrossCredited));
    const availableNet = BigNumber.maximum(0, lotHotNet.minus(lotNetCredited).minus(lotExpiredNet));
    if (!availableGross.isGreaterThan(0)) continue;
    if (!lotGross.isGreaterThan(0) || !lotHotNet.isFinite()) {
      throw new Error("An XTU Hot Wallet lot contains invalid gross/net amounts.");
    }
    const grossPart = BigNumber.minimum(remainingGross, availableGross);
    const netPart = grossPart.eq(availableGross)
      ? availableNet
      : BigNumber.minimum(availableNet, lotHotNet.multipliedBy(grossPart).dividedBy(lotGross)
        .decimalPlaces(18, BigNumber.ROUND_DOWN));
    await tx.query(
      `UPDATE xtu_hot_wallet_lots
       SET gross_credited_amount=gross_credited_amount+?,credited_amount=credited_amount+?,
           pending_user_amount=GREATEST(0,pending_user_amount-?),updated_at_ms=?
       WHERE id=?`,
      [grossPart.toFixed(18), netPart.toFixed(18), netPart.toFixed(18), String(Date.now()), String(lot.id)],
    );
    remainingGross = remainingGross.minus(grossPart);
  }
  if (remainingGross.gt("0.000000000000000001")) {
    throw new Error(`XTU Hot Wallet lot ledger is missing ${remainingGross.toFixed(18)} gross XTU for the credited tranche.`);
  }
}

async function creditConsolidatedBatchTx(tx, batch, consolidation, receipt, actualGas, settings) {
  const [batchRows] = await tx.query("SELECT * FROM xtu_deposit_batches WHERE id=? LIMIT 1 FOR UPDATE", [String(batch.id)]);
  if (!batchRows.length || ["credited", "forfeited_to_common_reserve", "manual_review"].includes(batchRows[0].status)) return;
  const currentBatch = batchRows[0];
  if (!["ready", "pending_reserve", "pending_credit", "pending_weekly", "pending_support"].includes(currentBatch.status)) {
    throw new Error(`XTU deposit batch ${currentBatch.id} is not in a creditable state.`);
  }
  const [depositControlRows] = await tx.query(
    "SELECT is_suspended FROM deposit_service_control WHERE control_id=1 LIMIT 1 FOR UPDATE",
  );
  if (Number(depositControlRows[0]?.is_suspended || 0) === 1) {
    throw new Error("The deposit service is administratively suspended.");
  }
  const globalRun = await getGlobalRunTx(tx, currentBatch.global_run_id || null);
  const common = await getLatestCommonTx(tx, true);
  const grossReturned = new BigNumber(currentBatch.gross_amount || currentBatch.returned_amount || "0");
  const [priorCreditRows] = await tx.query(
    `SELECT COALESCE(SUM(creditable_xtu),0) AS amount,
            COALESCE(SUM(gross_returned_xtu),0) AS gross_processed,
            COALESCE(SUM(CASE WHEN gas_fee_status='reconciled' THEN gas_actual_fee_xtu ELSE gas_fee_xtu END),0) AS gas_processed,COUNT(*) AS credit_count
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
    grossCreditedBeforeXtu: priorCreditRows[0]?.gross_processed || "0",
    gasCreditedBeforeXtu: priorCreditRows[0]?.gas_processed || "0",
    creditSequence,
    maximumInitialCreditXtu: settings.depositInitialCreditCap,
  });
  const depositFeeForThisTranche = credit.depositFeeXtu;
  const gasFeeForThisTranche = credit.actualGasFeeXtu;
  const grossForThisTranche = credit.trancheGrossXtu;

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
  const consolidationTxHash = consolidation?.tx_hash ? String(consolidation.tx_hash).toLowerCase() : null;
  if (!/^0x[0-9a-f]{64}$/.test(sourceTransactionHash) ||
      (consolidationTxHash != null && !/^0x[0-9a-f]{64}$/.test(consolidationTxHash))) {
    throw new Error("The XTU source deposit or optional consolidation transaction hash is invalid for the credit audit.");
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
     (batch_id,username,credit_sequence,gross_returned_xtu,deposit_fee_xtu,gas_fee_xtu,gas_fee_status,gas_actual_fee_xtu,creditable_xtu,
      credited_initial_asset,global_unit_price,reference,global_run_id,source_event_hashes_json,
      consolidation_tx_hash,status,created_at_ms)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'credited',?)`,
    [String(currentBatch.id), currentBatch.username, creditedSequence,
      grossForThisTranche.toFixed(18),
      depositFeeForThisTranche.toFixed(18), gasFeeForThisTranche.toFixed(18),
      actualGas.provisional ? "provisional" : "reconciled",
      actualGas.provisional ? "0" : gasFeeForThisTranche.toFixed(18),
      credit.creditedInitialAsset.isFinite() ? credit.initialCreditXtu.toFixed(18) : "0",
      credit.creditedInitialAsset.toFixed(30), common.unit_price, reference,
      globalRun ? String(globalRun.id) : null, sourceEventHashesJson, consolidationTxHash, String(Date.now())], 
  );
  if (Number(creditInsert.affectedRows || 0) !== 1) throw new Error("XTU deposit credit audit row was not inserted.");

  await allocateXtuGrossCreditToLotsTx(tx, currentBatch.id, grossForThisTranche);

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
    ? gasFeeForThisTranche.multipliedBy(sellerBasis).dividedBy(credit.creditedInitialAsset)
    : new BigNumber(0);
  const systemGasCost = gasFeeForThisTranche.minus(sellerGasCost);
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
        grossForThisTranche.toFixed(18),
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
  const grossProcessedAfter = new BigNumber(priorCreditRows[0]?.gross_processed || "0").plus(grossForThisTranche);
  const remainingCredit = grossReturned.minus(grossProcessedAfter).decimalPlaces(18, BigNumber.ROUND_DOWN);
  const totalDepositFeeAfter = new BigNumber(currentBatch.deposit_fee_amount || "0").plus(depositFeeForThisTranche);
  const now = Date.now();
  const nextStatus = remainingCredit.isGreaterThan(0) ? "pending_credit" : "credited";
  await tx.query(
    `UPDATE xtu_deposit_batches SET credited_amount=?,gross_credited_amount=?,remaining_amount=?,credit_sequence=?,deposit_fee_amount=?,
     gas_allocated_usd=?,gas_allocated_xtu=?,global_run_id=?,status=?,pending_since_ms=?,release_at_ms=?,
     reason_codes=?,updated_at_ms=? WHERE id=?`,
    [nextCredited.toFixed(18), grossProcessedAfter.toFixed(18), remainingCredit.toFixed(18), creditedSequence, totalDepositFeeAfter.toFixed(18),
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
      `Gross XTU processed in this tranche: ${grossForThisTranche.toFixed(8)} XTU`,
      `OneX deposit fee for this credited tranche: ${depositFeeForThisTranche.toFixed(8)} XTU`,
      `${actualGas.provisional ? "Provisioned" : "Actual"} consolidation gas allocated to this tranche: ${gasFeeForThisTranche.toFixed(8)} BSC-USD / XTU equivalent`,
      `Global unit price: ${new BigNumber(common.unit_price).toFixed(12)}`,
      `Initial assets credited in this tranche: ${credit.creditedInitialAsset.toFixed(12)}`,
      `Gross XTU remaining for a later credit tranche: ${remainingCredit.toFixed(8)}`,
      `Reference: ${reference}`,
      settlement ? `Global XTU-only settlement reference: ${settlement.ledgerId}` : "",
      remainingCredit.isGreaterThan(0) ? `The remaining gross XTU remains pending and is rechecked automatically. No OneX deposit fee has been charged on that uncredited remainder; it remains subject to the original 30-day expiry.` : "The XTU deposit batch is fully credited.",
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

    const eventRows = (await tx.query(
      `SELECT event_identity,batch_id,gross_amount,net_amount FROM xtu_deposit_transfer_events
       WHERE batch_id IN (${placeholders}) AND status NOT IN ('rejected','reversed','manual_review')
       ORDER BY event_identity ASC FOR UPDATE`, batchIds,
    ))[0];
    if (!eventRows.length) throw new Error("The XTU consolidation lot has no verified source deposit events.");
    const gasUsdByEvent = new Map(allocateBatchGasByGross(
      eventRows.map((entry) => ({ ...entry, gross_amount: String(entry.net_amount) })), actualGas.feeUsd,
    ).map((entry) => [entry.key, entry.gasFee]));
    const gasBnbByEvent = new Map(allocateBatchGasByGross(
      eventRows.map((entry) => ({ ...entry, gross_amount: String(entry.net_amount) })), actualGas.feeBnb,
    ).map((entry) => [entry.key, entry.gasFee]));
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
        `UPDATE xtu_deposit_transfer_events SET allocated_gas_fee_usd=?,allocated_gas_fee_xtu=?,
         status=IF(status='forfeited_to_common_reserve',status,'consolidated') WHERE event_identity=?`,
        [gasUsd.toFixed(18), gasUsd.toFixed(18), key],
      );
      await tx.query(
        `UPDATE xtu_hot_wallet_lots SET gas_actual_xtu=?,consolidated_amount=hot_wallet_received_amount,
         protected_hot_wallet_amount=0,consolidation_reserved_amount=0,
         status=IF(expired_common_reserve_amount>0,'consolidated_common_reserve','consolidated'),
         consolidated_at_ms=?,updated_at_ms=? WHERE event_identity=?`,
        [gasUsd.toFixed(18), String(Date.now()), String(Date.now()), key],
      );
    }

    const [date, time] = utcDateTime();
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
      const consolidatedAmount = new BigNumber(item.hot_wallet_received_xtu);
      const previousConsolidated = new BigNumber(batch.hot_wallet_consolidated_amount || "0");
      const previousReserved = new BigNumber(batch.consolidation_reserved_amount || "0");
      if (!consolidatedAmount.isGreaterThan(0) || previousReserved.lt(consolidatedAmount)) {
        throw new Error("The XTU protected Hot Wallet lot reservation does not match the confirmed consolidation.");
      }
      await tx.query(
        `UPDATE xtu_deposit_consolidation_items SET status='confirmed',allocated_gas_fee_bnb=?,
         allocated_gas_fee_usd=?,allocated_gas_fee_xtu=?,updated_at_ms=?
         WHERE consolidation_id=? AND batch_id=?`,
        [allocation.bnb.toFixed(18), allocation.usd.toFixed(18), allocation.usd.toFixed(18),
          String(Date.now()), String(current.id), batchId],
      );

      const [creditRows] = await tx.query(
        `SELECT id,credit_sequence,gross_returned_xtu,gas_fee_xtu,gas_fee_status,gas_actual_fee_xtu,
                COALESCE(SUM(creditable_xtu) OVER (),0) AS credited
         FROM xtu_deposit_credits WHERE batch_id=? ORDER BY credit_sequence ASC FOR UPDATE`,
        [batchId],
      );
      const credited = new BigNumber(creditRows[0]?.credited || "0");
      const gross = new BigNumber(batch.gross_amount || "0");
      const [lotTotalsRows] = await tx.query(
        `SELECT COALESCE(SUM(hot_wallet_received_amount),0) AS hot_net,
                COALESCE(SUM(credited_amount),0) AS credited_hot_net,
                COALESCE(SUM(expired_common_reserve_amount),0) AS expired_hot_net
         FROM xtu_hot_wallet_lots WHERE batch_id=? FOR UPDATE`, [batchId],
      );
      const hotNetTotal = new BigNumber(lotTotalsRows[0]?.hot_net || "0");
      const creditedHotNet = new BigNumber(lotTotalsRows[0]?.credited_hot_net || "0");
      const expiredHotNet = new BigNumber(lotTotalsRows[0]?.expired_hot_net || "0");
      if (!hotNetTotal.isGreaterThan(0) || creditedHotNet.plus(expiredHotNet).gt(hotNetTotal)) {
        throw new Error(`XTU protected Hot Wallet lot totals do not reconcile for batch ${batchId}.`);
      }
      const actualGasCredited = allocation.usd.multipliedBy(creditedHotNet).dividedBy(hotNetTotal)
        .decimalPlaces(18, BigNumber.ROUND_DOWN);
      let gasAssignedToCredits = new BigNumber(0);
      const grossCreditTotal = creditRows.reduce((sum, row) => sum.plus(row.gross_returned_xtu || 0), new BigNumber(0));
      for (let creditIndex = 0; creditIndex < creditRows.length; creditIndex += 1) {
        const creditRow = creditRows[creditIndex];
        const rowGross = new BigNumber(creditRow.gross_returned_xtu || "0");
        const rowGas = creditIndex === creditRows.length - 1
          ? actualGasCredited.minus(gasAssignedToCredits)
          : (grossCreditTotal.isGreaterThan(0)
            ? actualGasCredited.multipliedBy(rowGross).dividedBy(grossCreditTotal).decimalPlaces(18, BigNumber.ROUND_DOWN)
            : new BigNumber(0));
        gasAssignedToCredits = gasAssignedToCredits.plus(rowGas);
        await tx.query(
          `UPDATE xtu_deposit_credits SET gas_fee_status='reconciled',gas_actual_fee_xtu=? WHERE id=?`,
          [rowGas.toFixed(18), String(creditRow.id)],
        );
      }

      const alreadyExpired = String(batch.status) === "forfeited_to_common_reserve";
      let expirationGasManualReview = false;
      if (alreadyExpired) {
        const actualGasExpired = allocation.usd.minus(actualGasCredited).decimalPlaces(18, BigNumber.ROUND_DOWN);
        const [expirationRows] = await tx.query(
          `SELECT * FROM deposit_expiration_events
           WHERE asset_code='XTU' AND batch_id=? LIMIT 1 FOR UPDATE`, [batchId],
        );
        if (expirationRows.length) {
          const expiration = expirationRows[0];
          const provisionForExpired = new BigNumber(expiration.gas_provision_value || "0");
          const adjustment = provisionForExpired.minus(actualGasExpired).decimalPlaces(18, BigNumber.ROUND_DOWN);
          const correctedReserveValue = new BigNumber(expiration.expired_amount || "0")
            .minus(actualGasExpired).decimalPlaces(18, BigNumber.ROUND_DOWN);
          if (correctedReserveValue.isNegative()) {
            throw new Error(`Actual XTU consolidation gas exceeds the expired gross reserve for batch ${batchId}.`);
          }
          if (!adjustment.isZero()) {
            const commonForAdjustment = await getLatestCommonTx(tx, true);
            const adjustedTotal = new BigNumber(commonForAdjustment.total_units_price).plus(adjustment);
            if (adjustedTotal.isNegative()) {
              expirationGasManualReview = true;
              await tx.query(
                `UPDATE deposit_expiration_events SET gas_actual_value=?,gas_adjustment_value=?,
                 gas_covered_by_onex=?,status='manual_review' WHERE id=?`,
                [actualGasExpired.toFixed(18), adjustment.toFixed(18), BigNumber.maximum(0, actualGasExpired.minus(provisionForExpired)).toFixed(18), String(expiration.id)],
              );
              await tx.query(
                `UPDATE xtu_deposit_batches SET status='manual_review',reason_codes=?,updated_at_ms=? WHERE id=?`,
                [JSON.stringify(["xtu_expired_gas_adjustment_would_make_common_reserve_negative"]), String(Date.now()), batchId],
              );
            } else {
              const [date, time] = utcDateTime();
              await insertCommonSnapshotTx(tx, commonForAdjustment, {
                total_units_price: adjustedTotal.toFixed(30),
              }, date, time);
              const [snapshotRows] = await tx.query("SELECT id FROM common ORDER BY id DESC LIMIT 1 FOR UPDATE");
              if (!snapshotRows.length) throw new Error("The XTU expiry gas adjustment snapshot was not persisted.");
              await tx.query(
                `UPDATE deposit_expiration_events SET value_added_to_common=?,gas_actual_value=?,
                 gas_adjustment_value=?,gas_covered_by_onex=?,gas_adjustment_applied_at_ms=?,
                 common_snapshot_id=?,status='gas_reconciled' WHERE id=?`,
                [correctedReserveValue.toFixed(30), actualGasExpired.toFixed(18), adjustment.toFixed(18),
                  BigNumber.maximum(0, actualGasExpired.minus(provisionForExpired)).toFixed(18),
                  String(Date.now()), String(snapshotRows[0].id), String(expiration.id)],
              );
              await tx.query(
                `UPDATE xtu_deposit_batches SET expired_common_reserve_amount=?,updated_at_ms=? WHERE id=?`,
                [correctedReserveValue.toFixed(18), String(Date.now()), batchId],
              );
            }
          } else {
            await tx.query(
              `UPDATE deposit_expiration_events SET value_added_to_common=?,gas_actual_value=?,
               gas_adjustment_value='0',gas_adjustment_applied_at_ms=?,status='gas_reconciled' WHERE id=?`,
              [correctedReserveValue.toFixed(30), actualGasExpired.toFixed(18), String(Date.now()), String(expiration.id)],
            );
            await tx.query(
              `UPDATE xtu_deposit_batches SET expired_common_reserve_amount=?,updated_at_ms=? WHERE id=?`,
              [correctedReserveValue.toFixed(18), String(Date.now()), batchId],
            );
          }
        }
      }
      const globalRun = await getGlobalRunTx(tx, batch.global_run_id || null);
      const feeRate = calculateDepositFeeRate(batch.tfees_rate_percent ?? tfees, Boolean(globalRun));
      const depositFee = globalRun ? new BigNumber(0) : gross.multipliedBy(feeRate).dividedBy(100).decimalPlaces(18, BigNumber.ROUND_DOWN);
      const creditableAtActualGas = BigNumber.maximum(0, gross.minus(depositFee).minus(allocation.usd).decimalPlaces(18, BigNumber.ROUND_DOWN));
      const newlyAvailable = BigNumber.maximum(0, creditableAtActualGas.minus(credited).decimalPlaces(18, BigNumber.ROUND_DOWN));
      const nextStatus = expirationGasManualReview ? "manual_review"
        : alreadyExpired ? "forfeited_to_common_reserve"
          : newlyAvailable.isGreaterThan(0) ? "pending_credit" : (credited.isGreaterThan(0) ? "credited" : String(batch.status));
      await tx.query(
        `UPDATE xtu_deposit_batches SET hot_wallet_consolidated_amount=?,
         consolidation_reserved_amount=consolidation_reserved_amount-?,gas_actual_usd=?,
         gas_allocated_usd=?,gas_allocated_xtu=?,remaining_amount=?,status=?,
         release_at_ms=IF(?='pending_credit',?,release_at_ms),updated_at_ms=? WHERE id=?`,
        [previousConsolidated.plus(consolidatedAmount).toFixed(18), consolidatedAmount.toFixed(18),
          allocation.usd.toFixed(18), allocation.usd.toFixed(18), allocation.usd.toFixed(18),
          alreadyExpired ? "0" : newlyAvailable.toFixed(18), nextStatus, nextStatus, String(Date.now()),
          String(Date.now()), batchId],
      );
      // Each credited tranche now has its own actual gas share. Keep gas_fee_xtu
      // unchanged as the original provision used for the credit calculation.
      // The consolidation is a custody transfer only. It must not change
      // common.xtu_wallets or common.total_units_price a second time.
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
  // User-credit decisions are database/accounting operations and remain independent
  // of a refund or consolidation occupying the XTU Hot Wallet signer.
  const pendingMainWalletRefunds = await pool.queryAsync(
    `SELECT id FROM xtu_unknown_refunds WHERE status IN ('signed','submitted','manual_review') LIMIT 1`,
  );

  // Credit processing is deliberately independent from Hot Wallet custody
  // consolidation. An eligible deposit can be credited while its tokens are
  // still protected in the Hot Wallet awaiting the 100-XTU FIFO threshold.
  const retryRows = await pool.queryAsync(
    `SELECT id FROM xtu_deposit_batches
     WHERE status IN ('ready','pending_reserve','pending_credit','pending_weekly','pending_support')
       AND remaining_amount>0
       AND (status IN ('ready','pending_weekly') OR release_at_ms IS NULL OR CAST(release_at_ms AS UNSIGNED)<=?)
     ORDER BY opened_at_ms ASC,id ASC LIMIT 1`, [String(Date.now())],
  );
  if (retryRows.length) {
    await retryCredit(pool, retryRows[0].id, runtime);
  }

  // A signed/submitted/manual-review refund must not block the database-only
  // credit path above, but it must prevent any additional Hot Wallet spend.
  if (pendingMainWalletRefunds.length) return;
  const pendingConsolidations = await pool.queryAsync(
    `SELECT * FROM xtu_deposit_consolidations WHERE status IN ('signed','submitted')
     ORDER BY id ASC LIMIT 1`,
  );
  if (pendingConsolidations.length) {
    await reconcileConsolidation(pool, pendingConsolidations[0], runtime);
    return;
  }
  const manualReviewConsolidations = await pool.queryAsync(
    `SELECT id FROM xtu_deposit_consolidations WHERE status='manual_review' LIMIT 1`,
  );
  if (manualReviewConsolidations.length) return;

  // Consolidation is a custody-only FIFO process. It considers every
  // finalized, protected Hot Wallet lot, including lots whose user credit has
  // already completed or whose uncredited remainder was reclassified at 30d.
  const fifoBlockers = await pool.queryAsync(
    `SELECT id,status FROM xtu_deposit_batches
     WHERE status IN ('collecting','pending_minimum','pending_global','manual_review')
       AND CAST(hot_wallet_received_amount AS DECIMAL(36,18)) >
           CAST(hot_wallet_consolidated_amount AS DECIMAL(36,18)) + CAST(consolidation_reserved_amount AS DECIMAL(36,18))
     ORDER BY opened_at_ms ASC,id ASC LIMIT 1`,
  );
  if (fifoBlockers.length) return;

  const candidates = await pool.queryAsync(
    `SELECT b.* FROM xtu_deposit_batches b
     WHERE b.status IN ('ready','pending_reserve','pending_credit',
                        'pending_weekly','pending_support','pending_global','credited','forfeited_to_common_reserve')
       AND (CAST(b.hot_wallet_received_amount AS DECIMAL(36,18)) >
            CAST(b.hot_wallet_consolidated_amount AS DECIMAL(36,18)) +
            CAST(b.consolidation_reserved_amount AS DECIMAL(36,18)))
       AND NOT EXISTS (SELECT 1 FROM xtu_deposit_consolidation_items i WHERE i.batch_id=b.id)
     ORDER BY b.opened_at_ms ASC,b.id ASC LIMIT 500`,
  );
  if (!candidates.length) return;
  const selected = selectXtuConsolidationBatches(candidates, runtime.settings.depositConsolidationMinBatchXtu);
  if (!selected) return;
  try {
    await prepareConsolidation(pool, selected.batches, runtime, mainSigner);
  } catch (error) {
    // A failed estimate/fee check does not affect the user-credit state or
    // release the protected tokens; the same FIFO lot is retried later.
    for (const batch of selected.batches) {
      await setBatchPending(pool, batch.id, batch.status, `consolidation_pending:${String(error.message || error).slice(0, 180)}`);
    }
  }
}

async function retryCredit(pool, batchId, runtime) {
  const expiryRows = await pool.queryAsync(
    "SELECT expires_at_ms,status FROM xtu_deposit_batches WHERE id=? LIMIT 1", [String(batchId)],
  );
  if (!expiryRows.length || ["forfeited_to_common_reserve", "manual_review", "credited"].includes(String(expiryRows[0].status))) return;
  const expiresAt = Number(expiryRows[0].expires_at_ms || 0);
  if (expiresAt > 0 && Date.now() >= expiresAt) {
    await expireOneXtuDepositBatch(pool, batchId, runtime.settings, Date.now());
    return;
  }
  let provision;
  try {
    provision = await ensureXtuBatchGasProvision(pool, batchId, runtime);
  } catch (error) {
    await setBatchPending(pool, batchId, "pending_reserve", error.message || "xtu_gas_provision_unavailable");
    return;
  }
  if (!provision) return;
  const rows = await pool.queryAsync(
    `SELECT * FROM xtu_deposit_batches WHERE id=?
     AND status IN ('ready','pending_reserve','pending_credit','pending_weekly','pending_support') LIMIT 1`,
    [String(batchId)],
  );
  if (!rows.length) return;
  const row = rows[0];
  const actualUsd = new BigNumber(row.gas_actual_usd || "0");
  const gasUsd = actualUsd.isGreaterThan(0) ? actualUsd : new BigNumber(row.gas_provisioned_usd || provision.feeUsd);
  const gas = { feeBnb: provision.feeBnb || new BigNumber(0), feeUsd: gasUsd, provisional: !actualUsd.isGreaterThan(0) };
  await withTransaction(pool, async (tx) => {
    await acquireDepositLocks(tx);
    await tx.query("SAVEPOINT xtu_credit_attempt");
    try {
      await creditConsolidatedBatchTx(tx, row, null, null, gas, runtime.settings);
      await tx.query("RELEASE SAVEPOINT xtu_credit_attempt");
    } catch (error) {
      await tx.query("ROLLBACK TO SAVEPOINT xtu_credit_attempt");
      await tx.query("RELEASE SAVEPOINT xtu_credit_attempt");
      const now = Date.now();
      const systemFundingCooldown = error.code === "XTU_SYSTEM_FUNDING_COOLDOWN";
      const pendingStatus = systemFundingCooldown ? "pending_weekly"
        : (String(error.message || "").includes("maximum_user_balance") || String(error.message || "").includes("capacity")
          ? "pending_credit" : "pending_reserve");
      const pendingReason = systemFundingCooldown ? "system_funding_cooldown" :
        (pendingStatus === "pending_credit" ? "maximum_user_balance" : String(error.message || error).slice(0, 250));
      const releaseAt = systemFundingCooldown && Number.isSafeInteger(Number(error.releaseAtMs))
        ? Number(error.releaseAtMs) : now + DEPOSIT_PENDING_RETRY_MS;
      await tx.query(
        `UPDATE xtu_deposit_batches SET status=?,reason_codes=?,pending_since_ms=COALESCE(pending_since_ms,?),
         release_at_ms=?,updated_at_ms=? WHERE id=? AND status IN ('ready','pending_reserve','pending_credit','pending_weekly','pending_support')`,
        [pendingStatus, JSON.stringify([pendingReason]), String(now), String(releaseAt), String(now), String(batchId)],
      );
      await notifyUserTx(tx, row.username, `xtu-deposit:${batchId}:${pendingReason}`, "OneX XTU deposit pending",
        systemFundingCooldown
          ? `Your XTU deposit is eligible but the weekly OneX-funded purchase allowance is already used. Seller-campaign reserves may fund it earlier; otherwise OneX funding can be reconsidered after the seven-day period. The deposit remains subject to its fixed 30-day expiry. Batch: ${batchId}.`
          : `Your XTU deposit remains pending because: ${pendingReason}. Release capacity by selling/transferring/withdrawing eligible assets or wait for eligible reserves. The remaining amount expires on ${new Date(Number(row.expires_at_ms)).toISOString()} and will then be irreversibly reclassified to common reserves. Batch: ${batchId}.`);
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
  const expectedFeeRaw = 0n;
  if (foundNet !== expectedNetRaw || foundGross !== expectedGrossRaw || foundFee !== expectedFeeRaw || foundExempt !== false) throw new Error("The XTU global settlement receipt does not match the exact gross/net entitlement and zero contract fee.");
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

async function appendXtuUnknownRefundEventTx(tx, requestId, refundId, eventType, oldStatus, newStatus, reason, options = {}) {
  const now = String(Date.now());
  await tx.query(
    `INSERT IGNORE INTO xtu_unknown_refund_events
     (unknown_transfer_id,request_id,refund_id,event_key,event_type,actor_type,actor_reference,old_status,new_status,reason,tx_hash,
      gross_amount,fee_amount,net_amount,created_at_ms)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [options.transferId == null ? null : String(options.transferId), requestId == null ? null : String(requestId), refundId == null ? null : String(refundId),
      String(options.eventKey || `xtu-unknown-refund:${requestId}:${eventType}:${options.suffix || "v1"}`),
      eventType, options.actorType || "system", options.actorReference || null,
      oldStatus || null, newStatus || null, reason || null, options.txHash || null,
      String(options.grossAmount || "0"), String(options.feeAmount || "0"), String(options.netAmount || "0"), now],
  );
}

async function assignUnknownXtuTransferToAccount(pool, transferId, username) {
  const settings = getXtuSettings();
  return withTransaction(pool, async (tx) => {
    await acquireDepositLocks(tx);
    const [unknownRows] = await tx.query(
      `SELECT * FROM xtu_unknown_incoming_transfers WHERE id=? AND status IN ('pending_admin','refund_failed') LIMIT 1 FOR UPDATE`,
      [String(transferId)],
    );
    if (!unknownRows.length) return { status: "not_available" };
    const unknown = unknownRows[0];
    const [authRows] = await tx.query(
      `SELECT username,wallet_address FROM auths WHERE username=? LIMIT 1 FOR UPDATE`, [String(username)],
    );
    if (!authRows.length || String(authRows[0].wallet_address || "").toLowerCase() !== String(unknown.from_address).toLowerCase()) {
      return { status: "sender_account_mismatch" };
    }
    const [requestRows] = await tx.query(
      `SELECT id,status FROM xtu_unknown_refund_requests WHERE unknown_transfer_id=? LIMIT 1 FOR UPDATE`,
      [String(unknown.id)],
    );
    if (requestRows.length && ["approved", "refund_signed", "refund_submitted", "manual_review", "completed"].includes(String(requestRows[0].status))) {
      return { status: "refund_already_resolved" };
    }
    const [activeRefundRows] = await tx.query(
      `SELECT id,status FROM xtu_unknown_refunds WHERE unknown_transfer_id=? LIMIT 1 FOR UPDATE`,
      [String(unknown.id)],
    );
    if (activeRefundRows.length && !["failed", "cancelled"].includes(String(activeRefundRows[0].status))) {
      return { status: "refund_already_resolved_or_in_progress" };
    }
    const event = {
      sender: unknown.from_address,
      gross: BigInt(String(unknown.gross_amount_raw)),
      net: BigInt(String(unknown.hot_wallet_received_raw)),
      fee: BigInt(String(unknown.commission_amount_raw)),
      txHash: unknown.tx_hash,
      logIndex: Number(unknown.log_index),
      blockNumber: String(unknown.block_number),
      blockHash: unknown.block_hash,
      blockTimestampMs: Number(unknown.block_timestamp_ms),
      finalizedAtMs: Number(unknown.finalized_at_ms || unknown.created_at_ms),
    };
    const assigned = await assignDepositEventTx(tx, event, settings);
    if (["duplicate", "pending_identity"].includes(String(assigned.status))) {
      throw new Error("The unknown XTU transfer could not be safely re-assigned to the normal deposit ledger.");
    }
    const now = String(Date.now());
    await tx.query(
      `UPDATE xtu_unknown_incoming_transfers
       SET status='assigned',decision_action='assign',decision_reason=?,decided_by='configured_admin',
           decided_at_ms=?,assigned_username=?,updated_at_ms=? WHERE id=? AND status IN ('pending_admin','refund_failed')`,
      [`Assigned to the account whose registered BSC wallet exactly matches the original sender.`, now, String(username), now, String(unknown.id)],
    );
    if (requestRows.length) {
      await tx.query(
        `UPDATE xtu_unknown_refund_requests SET status='assigned',admin_reason=?,resolved_at_ms=?,updated_at_ms=?
         WHERE id=? AND status IN ('challenge_pending','pending_admin','failed')`,
        ["The transfer was assigned to its matching registered OneX account.", now, now, String(requestRows[0].id)],
      );
      await appendXtuUnknownRefundEventTx(tx, requestRows[0].id, null, "assigned", "pending_admin", "assigned",
        "The transfer was assigned to the matching registered wallet.", { actorType: "admin", actorReference: String(username), transferId: unknown.id });
    }
    return { status: "assigned", username: String(username), deposit: assigned };
  });
}

async function verifyUnknownXtuSource(pool, transfer, runtime) {
  const [canonicalBlock, receipt] = await Promise.all([
    runtime.provider.getBlock(Number(transfer.block_number)),
    runtime.provider.getTransactionReceipt(transfer.tx_hash),
  ]);
  if (!canonicalBlock || String(canonicalBlock.hash).toLowerCase() !== String(transfer.block_hash).toLowerCase() ||
      !receipt || Number(receipt.status) !== 1 || Number(receipt.blockNumber) !== Number(transfer.block_number) ||
      String(receipt.blockHash).toLowerCase() !== String(transfer.block_hash).toLowerCase()) {
    throw new Error("The original unknown XTU deposit is not canonical and final; administrative refund signing is blocked.");
  }
  const parsed = (receipt.logs || []).find((log) => Number(log.index) === Number(transfer.log_index) &&
    String(log.address || "").toLowerCase() === String(runtime.settings.tokenAddress).toLowerCase());
  if (!parsed) throw new Error("The original unknown XTU transfer log is missing from its source receipt.");
  const feeEvent = XTU_INTERFACE.parseLog(parsed);
  if (!feeEvent || feeEvent.name !== "TransferWithFee" ||
      getAddress(String(feeEvent.args.from)) !== getAddress(String(transfer.from_address)) ||
      getAddress(String(feeEvent.args.to)) !== runtime.settings.mainWalletAddress ||
      BigInt(feeEvent.args.grossAmount).toString() !== String(transfer.gross_amount_raw) ||
      BigInt(feeEvent.args.netAmount).toString() !== String(transfer.hot_wallet_received_raw) ||
      BigInt(feeEvent.args.feeAmount).toString() !== String(transfer.commission_amount_raw) || Boolean(feeEvent.args.feeExempt)) {
    throw new Error("The original unknown XTU transfer event no longer matches the audited incoming amounts.");
  }
  const latestBlock = await runtime.provider.getBlockNumber();
  if (latestBlock - Number(transfer.block_number) + 1 < runtime.settings.minConfirmations) {
    throw new Error("The original unknown XTU transfer has not reached the configured confirmation depth.");
  }
  return receipt;
}

async function markUnknownXtuRefundDeferred(pool, transferId, reason) {
  await pool.queryAsync(
    `UPDATE xtu_unknown_incoming_transfers SET decision_reason=?,updated_at_ms=?
     WHERE id=? AND status='refund_approved'`,
    [String(reason || "Refund is deferred.").slice(0, 990), String(Date.now()), String(transferId)],
  );
}

async function createAndSignUnknownXtuRefund(pool, transfer, request, runtime, mainSigner) {
  await verifyUnknownXtuSource(pool, transfer, runtime);
  const baseAmount = new BigNumber(String(transfer.hot_wallet_received_amount));
  const baseRaw = BigInt(String(transfer.hot_wallet_received_raw));
  if (!baseAmount.isFinite() || !baseAmount.isGreaterThan(0) || baseRaw <= 0n) {
    throw new Error("The XTU unknown-transfer Hot Wallet receipt is not a positive refundable base.");
  }

  const estimatedCallRaw = baseRaw;
  const estimatedData = runtime.contract.interface.encodeFunctionData("transfer", [transfer.from_address, estimatedCallRaw]);
  const bnbUsdPrice = await getBnbUsdPrice(runtime.provider, { forceRefresh: true });
  const estimate = await estimateBscTokenTransfer({
    provider: runtime.provider,
    fromAddress: runtime.settings.mainWalletAddress,
    tokenAddress: runtime.settings.tokenAddress,
    data: estimatedData,
    maximumGasLimit: runtime.settings.depositGasLimitCeiling,
    bnbUsdPrice,
  });
  const gasLimit = (estimate.gasLimit * 120n + 99n) / 100n;
  if (gasLimit > runtime.settings.depositGasLimitCeiling) throw new Error("XTU unknown-refund gas limit exceeds the configured XTU deposit gas ceiling.");
  const gasQuote = require("./bsc-fee-accounting").calculateEstimatedGasFee(gasLimit.toString(), estimate.gasPrice.toString(), bnbUsdPrice);
  const gasDecision = evaluateBscTxFee(gasQuote.feeUsd, getConfiguredMaxBscTxFeeUsd());
  if (!gasDecision.allowed) {
    await markUnknownXtuRefundDeferred(pool, transfer.id,
      `Estimated XTU refund gas ${gasQuote.feeUsd.toFixed(8)} BSC-USD exceeds the 0.4 BSC-USD outgoing transaction ceiling.`);
    return false;
  }
  let quote;
  try {
    quote = calculateXtuUnknownRefundQuote({
      hotWalletReceivedAmount: baseAmount.toFixed(18),
      estimatedGasFeeBscUsd: gasQuote.feeUsd.toFixed(18),
      minimumRefundNet: MINIMUM_REFUND_NET_BSC_USD.toFixed(18),
    });
  } catch (error) {
    await markUnknownXtuRefundDeferred(pool, transfer.id, error.message || "XTU refund minimum or gas check failed.");
    return false;
  }

  const [tokenBalance, nativeBalance] = await Promise.all([
    runtime.contract.balanceOf(runtime.settings.mainWalletAddress),
    runtime.provider.getBalance(runtime.settings.mainWalletAddress),
  ]);
  const protectedDepositRows = await pool.queryAsync(
    `SELECT COALESCE(SUM(protected_hot_wallet_amount),0) AS amount
     FROM xtu_hot_wallet_lots WHERE status IN ('protected','consolidation_reserved','common_reserve_owned')`,
  );
  const protectedUnknownRows = await pool.queryAsync(
    `SELECT COALESCE(SUM(CASE WHEN status='refunded' THEN refund_residual_amount ELSE hot_wallet_received_amount END),0) AS amount
     FROM xtu_unknown_incoming_transfers
     WHERE status IN ('pending_admin','refund_approved','refund_queued','refund_signed','refund_submitted','refund_manual_review','refund_failed','retained_uncredited','refunded','automatic_refund_pending')`,
  );
  const unbackedAutomaticRefundAmount = await getUnbackedAutomaticRefundXtuAmount(pool);
  const protectedTotal = new BigNumber(protectedDepositRows[0]?.amount || "0")
    .plus(protectedUnknownRows[0]?.amount || "0")
    .plus(unbackedAutomaticRefundAmount);
  const hotBalance = new BigNumber(tokenBalance.toString()).shiftedBy(-18);
  if (!hotBalance.isFinite() || hotBalance.lt(protectedTotal)) {
    throw new Error("The XTU Hot Wallet balance does not cover all protected deposit lots and unknown-transfer balances; refund signing is blocked.");
  }
  const requiredBnb = gasQuote.feeBnb.shiftedBy(18).integerValue(BigNumber.ROUND_CEIL);
  if (BigInt(nativeBalance) < BigInt(requiredBnb.toFixed(0))) {
    throw new Error("The XTU Hot Wallet does not have enough BNB for the approved unknown-transfer refund gas.");
  }

  const data = runtime.contract.interface.encodeFunctionData("transfer", [transfer.from_address, BigInt(quote.amountRaw)]);
  const eventId = String(transfer.id);
  let signedRowId = null;
  let signedHash = null;
  let rawTx = null;
  await withTransaction(pool, async (tx) => {
    await acquireDepositLocks(tx);
    const [transferRows] = await tx.query(
      `SELECT * FROM xtu_unknown_incoming_transfers WHERE id=? AND status='refund_approved' LIMIT 1 FOR UPDATE`, [eventId],
    );
    const [requestRows] = await tx.query(
      `SELECT * FROM xtu_unknown_refund_requests WHERE id=? AND unknown_transfer_id=? AND status='approved' LIMIT 1 FOR UPDATE`,
      [String(request.id), eventId],
    );
    if (!transferRows.length || !requestRows.length) return;
    const [activeConsolidations] = await tx.query(
      `SELECT id FROM xtu_deposit_consolidations WHERE status IN ('signed','submitted','manual_review') LIMIT 1 FOR UPDATE`,
    );
    const [activeRefunds] = await tx.query(
      `SELECT id FROM xtu_unknown_refunds WHERE status IN ('signed','submitted','manual_review') LIMIT 1 FOR UPDATE`,
    );
    if (activeConsolidations.length || activeRefunds.length) return;
    const [existingRefundRows] = await tx.query(
      `SELECT * FROM xtu_unknown_refunds WHERE unknown_transfer_id=? LIMIT 1 FOR UPDATE`, [eventId],
    );
    if (existingRefundRows.length && !["failed", "cancelled"].includes(String(existingRefundRows[0].status))) return;

    const nonce = await runtime.provider.getTransactionCount(runtime.settings.mainWalletAddress, "pending");
    rawTx = await mainSigner.signTransaction({
      to: runtime.settings.tokenAddress,
      data,
      value: 0n,
      chainId: CHAIN_ID,
      nonce,
      gasLimit,
      gasPrice: estimate.gasPrice,
    });
    signedHash = keccak256(rawTx).toLowerCase();
    const now = String(Date.now());
    await recordEstimatedBscFeeTx(tx, {
      txHash: signedHash,
      operation: "xtu_unknown_refund",
      gasLimit: gasLimit.toString(),
      gasPriceWei: estimate.gasPrice.toString(),
      bnbUsdPrice,
    });
    const reference = `XTU-UNK-REF-${eventId}-${Date.now()}`.slice(0, 64);
    if (existingRefundRows.length) {
      signedRowId = String(existingRefundRows[0].id);
      await tx.query(
        `UPDATE xtu_unknown_refunds SET request_id=?,payout_address=?,base_received_amount=?,gas_equivalent_xtu=?,
         gross_transfer_amount=?,contract_fee_amount=?,net_amount=?,amount_raw=?,estimated_fee_bnb=?,estimated_fee_usd=?,
         actual_fee_bnb=NULL,actual_fee_usd=NULL,bnb_usd_price=?,gas_limit=?,gas_price_wei=?,reference=?,status='signed',
         raw_tx=?,tx_hash=?,nonce=?,block_number=NULL,receipt_json=NULL,last_error=NULL,created_at_ms=?,updated_at_ms=?,
         confirmed_at_ms=NULL,failed_at_ms=NULL WHERE id=? AND status IN ('failed','cancelled')`,
        [String(request.id), transfer.from_address, baseAmount.toFixed(18), quote.gasEquivalentXtu.toFixed(18),
          quote.grossTransferAmount.toFixed(18), quote.contractFeeAmount.toFixed(18), quote.netAmount.toFixed(18),
          quote.amountRaw, gasQuote.feeBnb.toFixed(30), gasQuote.feeUsd.toFixed(30), bnbUsdPrice.toFixed(18),
          gasLimit.toString(), estimate.gasPrice.toString(), reference, rawTx, signedHash, String(nonce), now, now, signedRowId],
      );
    } else {
      const [insertResult] = await tx.query(
        `INSERT INTO xtu_unknown_refunds
         (unknown_transfer_id,request_id,payout_address,base_received_amount,gas_equivalent_xtu,gross_transfer_amount,
          contract_fee_amount,net_amount,amount_raw,estimated_fee_bnb,estimated_fee_usd,bnb_usd_price,gas_limit,
          gas_price_wei,reference,status,raw_tx,tx_hash,nonce,created_at_ms,updated_at_ms)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'signed',?,?,?,?,?)`,
        [eventId, String(request.id), transfer.from_address, baseAmount.toFixed(18), quote.gasEquivalentXtu.toFixed(18),
          quote.grossTransferAmount.toFixed(18), quote.contractFeeAmount.toFixed(18), quote.netAmount.toFixed(18),
          quote.amountRaw, gasQuote.feeBnb.toFixed(30), gasQuote.feeUsd.toFixed(30), bnbUsdPrice.toFixed(18),
          gasLimit.toString(), estimate.gasPrice.toString(), `XTU-UNK-REF-${eventId}-${Date.now()}`.slice(0, 64),
          rawTx, signedHash, String(nonce), now, now],
      );
      signedRowId = String(insertResult.insertId);
    }
    await tx.query(
      `UPDATE xtu_unknown_incoming_transfers SET status='refund_signed',refund_id=?,updated_at_ms=?
       WHERE id=? AND status='refund_approved'`, [signedRowId, now, eventId],
    );
    await tx.query(
      `UPDATE xtu_unknown_refund_requests SET status='refund_signed',refund_id=?,updated_at_ms=?
       WHERE id=? AND status='approved'`, [signedRowId, now, String(request.id)],
    );
    await tx.query(
      `UPDATE xtu_deposit_transfer_events SET status='refund_signed'
       WHERE tx_hash=? AND log_index=? AND username IS NULL AND status='pending_identity'`,
      [String(transfer.tx_hash), String(transfer.log_index)],
    );
    await appendXtuUnknownRefundEventTx(tx, request.id, signedRowId, "signed", "approved", "refund_signed",
      "The refund was signed from the XTU Hot Wallet using the net amount originally received, less estimated gas equivalent and the zero contract fee.", {
        eventKey: `xtu-unknown-refund:${request.id}:signed:${signedHash}`,
        actorReference: mainSigner.address, txHash: signedHash, transferId: eventId,
        grossAmount: quote.grossTransferAmount.toFixed(18), feeAmount: quote.contractFeeAmount.toFixed(18), netAmount: quote.netAmount.toFixed(18),
      });
  });
  if (!signedRowId || !rawTx || !signedHash) return false;
  try {
    const sent = await runtime.provider.broadcastTransaction(rawTx);
    if (String(sent.hash).toLowerCase() !== signedHash) throw new Error("The RPC returned a different hash for the signed XTU refund.");
    await pool.queryAsync(
      `UPDATE xtu_unknown_refunds SET status='submitted',updated_at_ms=? WHERE id=? AND status='signed'`,
      [String(Date.now()), signedRowId],
    );
    await pool.queryAsync(
      `UPDATE xtu_unknown_incoming_transfers SET status='refund_submitted',updated_at_ms=? WHERE id=? AND refund_id=? AND status='refund_signed'`,
      [String(Date.now()), eventId, signedRowId],
    );
    await pool.queryAsync(
      `UPDATE xtu_deposit_transfer_events SET status='refund_submitted' WHERE tx_hash=? AND log_index=? AND username IS NULL`,
      [String(transfer.tx_hash), String(transfer.log_index)],
    );
  } catch (error) {
    await pool.queryAsync(
      `UPDATE xtu_unknown_refunds SET last_error=?,updated_at_ms=? WHERE id=? AND status IN ('signed','submitted')`,
      [String(error.message || error).slice(0, 990), String(Date.now()), signedRowId],
    );
  }
  return true;
}

function parseUnknownXtuRefundReceipt(receipt, row, runtime) {
  const expectedGross = BigInt(String(row.amount_raw));
  let transferWithFee = null;
  let recipientTransferAmount = null;
  let collectorFeeAmount = null;
  for (const log of receipt.logs || []) {
    if (String(log.address || "").toLowerCase() !== runtime.settings.tokenAddress.toLowerCase()) continue;
    try {
      const parsed = XTU_INTERFACE.parseLog(log);
      if (parsed?.name === "TransferWithFee" &&
          getAddress(String(parsed.args.from)) === runtime.settings.mainWalletAddress &&
          getAddress(String(parsed.args.to)) === getAddress(String(row.payout_address))) {
        transferWithFee = parsed;
      } else if (parsed?.name === "Transfer" &&
          getAddress(String(parsed.args.from)) === runtime.settings.mainWalletAddress &&
          getAddress(String(parsed.args.to)) === getAddress(String(row.payout_address)) &&
          BigInt(parsed.args.value) > 0n) {
        recipientTransferAmount = BigInt(parsed.args.value);
      } else if (parsed?.name === "Transfer" &&
          getAddress(String(parsed.args.from)) === runtime.settings.mainWalletAddress &&
          getAddress(String(parsed.args.to)) === runtime.settings.distributionAddress &&
          BigInt(parsed.args.value) > 0n) {
        collectorFeeAmount = BigInt(parsed.args.value);
      }
    } catch {}
  }
  if (!transferWithFee) return { valid: false, reason: "The refund receipt is missing the expected XTU TransferWithFee event." };
  const gross = BigInt(transferWithFee.args.grossAmount);
  const net = BigInt(transferWithFee.args.netAmount);
  const fee = BigInt(transferWithFee.args.feeAmount);
  const expectedFee = 0n;
  if (gross !== expectedGross || fee !== expectedFee || net + fee !== gross ||
      Boolean(transferWithFee.args.feeExempt) || recipientTransferAmount !== net || collectorFeeAmount !== fee) {
    return { valid: false, reason: "The confirmed XTU refund receipt does not match the persisted gross/net/zero-fee quote." };
  }
  if (net.toString() !== BigInt(String(row.net_amount).includes(".") ? new BigNumber(row.net_amount).shiftedBy(18).integerValue(BigNumber.ROUND_DOWN).toFixed(0) : row.net_amount).toString()) {
    return { valid: false, reason: "The refund receipt net amount differs from the persisted beneficiary amount." };
  }
  return { valid: true, gross, net, fee };
}

async function reconcileUnknownXtuRefund(pool, row, runtime) {
  const [transaction, receipt] = await Promise.all([
    runtime.provider.getTransaction(row.tx_hash),
    runtime.provider.getTransactionReceipt(row.tx_hash),
  ]);
  if (!receipt) {
    if (transaction) {
      await pool.queryAsync("UPDATE xtu_unknown_refunds SET status='submitted',updated_at_ms=? WHERE id=? AND status='signed'", [String(Date.now()), String(row.id)]);
      await pool.queryAsync("UPDATE xtu_unknown_incoming_transfers SET status='refund_submitted',updated_at_ms=? WHERE id=? AND refund_id=?", [String(Date.now()), String(row.unknown_transfer_id), String(row.id)]);
      await pool.queryAsync(
        `UPDATE xtu_deposit_transfer_events SET status='refund_submitted' WHERE tx_hash=? AND log_index=? AND username IS NULL`,
        [String(row.source_tx_hash), String(row.source_log_index)],
      );
      return;
    }
    const latestNonce = await runtime.provider.getTransactionCount(runtime.settings.mainWalletAddress, "latest");
    if (latestNonce > Number(row.nonce)) {
      await withTransaction(pool, async (tx) => {
        const now = String(Date.now());
        await tx.query("UPDATE xtu_unknown_refunds SET status='manual_review',last_error=?,updated_at_ms=? WHERE id=?", [
          "The Hot Wallet nonce advanced but the signed XTU refund is not visible by its persisted hash. Automatic resubmission is blocked.", now, String(row.id),
        ]);
        await tx.query("UPDATE xtu_unknown_incoming_transfers SET status='refund_manual_review',updated_at_ms=? WHERE id=?", [now, String(row.unknown_transfer_id)]);
        await tx.query("UPDATE xtu_unknown_refund_requests SET status='manual_review',updated_at_ms=? WHERE id=?", [now, String(row.request_id)]);
        await tx.query(
          `UPDATE xtu_deposit_transfer_events SET status='refund_manual_review' WHERE tx_hash=? AND log_index=? AND username IS NULL`,
          [String(row.source_tx_hash), String(row.source_log_index)],
        );
        await appendXtuUnknownRefundEventTx(tx, row.request_id, row.id, "manual_review", row.status, "manual_review",
          "The main-wallet nonce advanced without a visible refund hash. Manual reconciliation is required.", { eventKey: `xtu-unknown-refund:${row.id}:nonce-mismatch` , txHash: row.tx_hash, transferId: row.unknown_transfer_id });
      });
      return;
    }
    try {
      const sent = await runtime.provider.broadcastTransaction(row.raw_tx);
      if (String(sent.hash).toLowerCase() !== String(row.tx_hash).toLowerCase()) throw new Error("The RPC returned a different hash for the persisted refund transaction.");
      await pool.queryAsync("UPDATE xtu_unknown_refunds SET status='submitted',updated_at_ms=? WHERE id=? AND status='signed'", [String(Date.now()), String(row.id)]);
      await pool.queryAsync("UPDATE xtu_unknown_incoming_transfers SET status='refund_submitted',updated_at_ms=? WHERE id=? AND refund_id=?", [String(Date.now()), String(row.unknown_transfer_id), String(row.id)]);
      await pool.queryAsync(
        `UPDATE xtu_deposit_transfer_events SET status='refund_submitted' WHERE tx_hash=? AND log_index=? AND username IS NULL`,
        [String(row.source_tx_hash), String(row.source_log_index)],
      );
    } catch (error) {
      await pool.queryAsync("UPDATE xtu_unknown_refunds SET last_error=?,updated_at_ms=? WHERE id=? AND status IN ('signed','submitted')", [String(error.message || error).slice(0, 990), String(Date.now()), String(row.id)]);
    }
    return;
  }
  const latestBlock = await runtime.provider.getBlockNumber();
  if (latestBlock - Number(receipt.blockNumber) + 1 < runtime.settings.minConfirmations) return;
  const canonicalBlock = await runtime.provider.getBlock(Number(receipt.blockNumber));
  if (!canonicalBlock || String(canonicalBlock.hash).toLowerCase() !== String(receipt.blockHash).toLowerCase()) {
    await pool.queryAsync("UPDATE xtu_unknown_refunds SET status='manual_review',last_error=?,updated_at_ms=? WHERE id=?", [
      "The XTU refund receipt block is not canonical; the refund amount remains protected pending administrative reconciliation.", String(Date.now()), String(row.id),
    ]);
    await pool.queryAsync("UPDATE xtu_unknown_incoming_transfers SET status='refund_manual_review',updated_at_ms=? WHERE id=?", [String(Date.now()), String(row.unknown_transfer_id)]);
    await pool.queryAsync(
      `UPDATE xtu_deposit_transfer_events SET status='refund_manual_review' WHERE tx_hash=? AND log_index=? AND username IS NULL`,
      [String(row.source_tx_hash), String(row.source_log_index)],
    );
    return;
  }
  const bnbUsdPrice = await getBnbUsdPrice(runtime.provider, { forceRefresh: true });
  const actualGas = calculateActualGasFee(receipt, bnbUsdPrice);
  await withTransaction(pool, async (tx) => {
    const [refundRows] = await tx.query(
      `SELECT rf.*,u.tx_hash AS source_tx_hash,u.log_index AS source_log_index
       FROM xtu_unknown_refunds rf
       INNER JOIN xtu_unknown_incoming_transfers u ON u.id=rf.unknown_transfer_id
       WHERE rf.id=? LIMIT 1 FOR UPDATE`, [String(row.id)],
    );
    if (!refundRows.length || refundRows[0].status === "confirmed") return;
    const current = refundRows[0];
    await recordActualBscFeeTx(tx, { txHash: current.tx_hash, operation: "xtu_unknown_refund", receipt, bnbUsdPrice });
    const now = String(Date.now());
    if (Number(receipt.status) !== 1) {
      await tx.query("UPDATE xtu_unknown_refunds SET status='failed',block_number=?,actual_fee_bnb=?,actual_fee_usd=?,receipt_json=?,last_error=?,failed_at_ms=?,updated_at_ms=? WHERE id=?", [
        String(receipt.blockNumber), actualGas.feeBnb.toFixed(30), actualGas.feeUsd.toFixed(18), JSON.stringify(receipt),
        "The XTU refund transaction reverted. The original Hot Wallet amount remains held and may be reviewed for a new administrative decision.", now, now, String(row.id),
      ]);
      await tx.query("UPDATE xtu_unknown_incoming_transfers SET status='refund_failed',decision_reason=?,updated_at_ms=? WHERE id=?", [
        "The approved refund transaction reverted; no XTU refund was completed.", now, String(current.unknown_transfer_id),
      ]);
      await tx.query(
        `UPDATE xtu_deposit_transfer_events SET status='refund_failed' WHERE tx_hash=? AND log_index=? AND username IS NULL`,
        [String(current.source_tx_hash), String(current.source_log_index)],
      );
      await tx.query("UPDATE xtu_unknown_refund_requests SET status='failed',updated_at_ms=? WHERE id=?", [now, String(current.request_id)]);
      await appendXtuUnknownRefundEventTx(tx, current.request_id, current.id, "failed", current.status, "failed",
        "The refund transaction reverted on BNB Smart Chain; no token amount was transferred.", {
          eventKey: `xtu-unknown-refund:${current.id}:failed:${current.tx_hash}`,
          txHash: current.tx_hash, grossAmount: current.gross_transfer_amount,
          feeAmount: current.contract_fee_amount, netAmount: current.net_amount, transferId: current.unknown_transfer_id,
        });
      return;
    }
    const actualTransfer = parseUnknownXtuRefundReceipt(receipt, current, runtime);
    if (!actualTransfer.valid) {
      await tx.query("UPDATE xtu_unknown_refunds SET status='manual_review',block_number=?,actual_fee_bnb=?,actual_fee_usd=?,receipt_json=?,last_error=?,updated_at_ms=? WHERE id=?", [
        String(receipt.blockNumber), actualGas.feeBnb.toFixed(30), actualGas.feeUsd.toFixed(18), JSON.stringify(receipt), actualTransfer.reason, now, String(row.id),
      ]);
      await tx.query("UPDATE xtu_unknown_incoming_transfers SET status='refund_manual_review',updated_at_ms=? WHERE id=?", [now, String(current.unknown_transfer_id)]);
      await tx.query("UPDATE xtu_unknown_refund_requests SET status='manual_review',updated_at_ms=? WHERE id=?", [now, String(current.request_id)]);
      await tx.query(
        `UPDATE xtu_deposit_transfer_events SET status='refund_manual_review' WHERE tx_hash=? AND log_index=? AND username IS NULL`,
        [String(current.source_tx_hash), String(current.source_log_index)],
      );
      await appendXtuUnknownRefundEventTx(tx, current.request_id, current.id, "manual_review", current.status, "manual_review",
        actualTransfer.reason, { eventKey: `xtu-unknown-refund:${current.id}:receipt-review:${current.tx_hash}`, txHash: current.tx_hash, transferId: current.unknown_transfer_id });
      return;
    }
    const gasAdjustment = new BigNumber(current.gas_equivalent_xtu).minus(actualGas.feeUsd);
    await tx.query(
      `UPDATE xtu_unknown_refunds SET status='confirmed',block_number=?,actual_fee_bnb=?,actual_fee_usd=?,bnb_usd_price=?,
       gas_adjustment_xtu=?,receipt_json=?,confirmed_at_ms=?,updated_at_ms=?,last_error=? WHERE id=?`,
      [String(receipt.blockNumber), actualGas.feeBnb.toFixed(30), actualGas.feeUsd.toFixed(18), bnbUsdPrice.toFixed(18),
        gasAdjustment.toFixed(18), JSON.stringify(receipt), now, now,
        `Gas estimate reconciliation (estimated XTU equivalent minus actual BSC-USD gas): ${gasAdjustment.toFixed(18)} XTU. Any estimate shortfall is covered by OneX; any excess estimate remains included in the initial refund quote.`, String(row.id)],
    );
    const refundResidual = new BigNumber(current.base_received_amount).minus(current.gross_transfer_amount);
    if (!refundResidual.isFinite() || refundResidual.isNegative()) {
      throw new Error("The confirmed XTU refund residual is inconsistent with the original Hot Wallet receipt.");
    }
    const refundResidualRaw = BigInt(refundResidual.shiftedBy(18).integerValue(BigNumber.ROUND_DOWN).toFixed(0));
    await tx.query(
      `UPDATE xtu_unknown_incoming_transfers SET status='refunded',refund_residual_amount=?,refund_residual_raw=?,updated_at_ms=?
       WHERE id=? AND status IN ('refund_signed','refund_submitted','refund_manual_review')`,
      [refundResidual.toFixed(18), refundResidualRaw.toString(), now, String(current.unknown_transfer_id)],
    );
    await tx.query("UPDATE xtu_unknown_refund_requests SET status='completed',completed_at_ms=?,updated_at_ms=? WHERE id=?", [now, now, String(current.request_id)]);
    await tx.query(
      `UPDATE xtu_deposit_transfer_events SET status='refunded' WHERE tx_hash=? AND log_index=? AND username IS NULL`,
      [String(current.source_tx_hash), String(current.source_log_index)],
    );
    await appendXtuUnknownRefundEventTx(tx, current.request_id, current.id, "confirmed", current.status, "confirmed",
      "The XTU refund was confirmed. The beneficiary received the net amount after a contract transfer commission; BNB gas was paid by the Hot Wallet and recorded separately.", {
        eventKey: `xtu-unknown-refund:${current.id}:confirmed:${current.tx_hash}`,
        txHash: current.tx_hash, grossAmount: actualTransfer.gross.toString(), feeAmount: actualTransfer.fee.toString(), netAmount: actualTransfer.net.toString(),
        transferId: current.unknown_transfer_id,
      });
  });
}

async function processOneUnknownXtuRefund(pool, runtime, mainSigner) {
  const [activeRows] = await pool.queryAsync(
    `SELECT rf.*,u.tx_hash AS source_tx_hash,u.log_index AS source_log_index
     FROM xtu_unknown_refunds rf
     INNER JOIN xtu_unknown_incoming_transfers u ON u.id=rf.unknown_transfer_id
     WHERE rf.status IN ('signed','submitted','manual_review') ORDER BY rf.id ASC LIMIT 1`,
  );
  if (activeRows.length) {
    if (["signed", "submitted"].includes(String(activeRows[0].status))) {
      await reconcileUnknownXtuRefund(pool, activeRows[0], runtime);
    }
    return true;
  }
  const [approvedRows] = await pool.queryAsync(
    `SELECT u.*,r.id AS request_id,r.status AS request_status
     FROM xtu_unknown_incoming_transfers u
     INNER JOIN xtu_unknown_refund_requests r ON r.unknown_transfer_id=u.id
     WHERE u.status='refund_approved' AND r.status='approved'
     ORDER BY u.block_timestamp_ms ASC,u.id ASC LIMIT 1`,
  );
  if (!approvedRows.length) return false;
  const [pendingConsolidations] = await pool.queryAsync(
    `SELECT id FROM xtu_deposit_consolidations WHERE status IN ('signed','submitted','manual_review') LIMIT 1`,
  );
  if (pendingConsolidations.length) return true;
  try {
    return await createAndSignUnknownXtuRefund(pool, approvedRows[0], { id: approvedRows[0].request_id }, runtime, mainSigner);
  } catch (error) {
    await markUnknownXtuRefundDeferred(pool, approvedRows[0].id, error.message || "XTU unknown refund is waiting for reconciliation.");
    return false;
  }
}


/**
 * Atomically converts every uncredited portion of an already-open XTU batch
 * belonging to a newly disabled account into Category C refund events.
 * Previously credited portions remain untouched. The source lot ledger is the
 * authority for event-level FIFO allocation; inconsistent batches are held.
 */
async function routeOutstandingXtuBatchesToAutomaticRefund(pool, username) {
  const U = String(username || "").trim();
  if (!U) throw new TypeError("A username is required to route XTU deposits after deactivation.");
  return withTransaction(pool, async (tx) => {
    await acquireDepositLocks(tx);
    const [accountRows] = await tx.query(
      `SELECT username,wallet_address,account_active FROM auths WHERE username=? LIMIT 1 FOR UPDATE`, [U],
    );
    if (!accountRows.length || Number(accountRows[0].account_active) !== 0) {
      throw new Error("The account must be inactive before its existing XTU deposits can be routed to Category C.");
    }
    const sender = String(accountRows[0].wallet_address || "").toLowerCase();
    await ensureWalletFinancialLockTx(tx, sender, Date.now());
    const [batches] = await tx.query(
      `SELECT * FROM xtu_deposit_batches
       WHERE username=? AND CAST(remaining_amount AS DECIMAL(36,18))>0
         AND status IN ('collecting','pending_minimum','ready','pending_reserve','pending_credit',
                        'pending_weekly','pending_support','pending_global')
       ORDER BY opened_at_ms ASC,id ASC FOR UPDATE`, [U],
    );
    const now = Date.now();
    let queuedCount = 0;
    let queuedAmount = new BigNumber(0);
    const queuedBatchIds = [];

    for (const batch of batches) {
      const batchId = String(batch.id);
      try {
        const [sourceRows] = await tx.query(
          `SELECT * FROM xtu_deposit_transfer_events
           WHERE batch_id=? ORDER BY block_number ASC,log_index ASC FOR UPDATE`, [batchId],
        );
        if (!sourceRows.length || sourceRows.length !== Number(batch.transfer_count || 0)) {
          throw new Error("XTU source-event count does not match the batch transfer count.");
        }
        const [consolidationRows] = await tx.query(
          `SELECT i.status,c.status AS consolidation_status
           FROM xtu_deposit_consolidation_items i
           INNER JOIN xtu_deposit_consolidations c ON c.id=i.consolidation_id
           WHERE i.batch_id=? AND (i.status IN ('queued','signed','submitted','manual_review')
             OR c.status IN ('queued','signed','submitted','manual_review'))
           LIMIT 1 FOR UPDATE`, [batchId],
        );
        if (consolidationRows.length) {
          throw new Error("An XTU consolidation for this batch is still queued, signed, submitted or under manual review.");
        }
        const [lotRows] = await tx.query(
          `SELECT * FROM xtu_hot_wallet_lots WHERE batch_id=?
           ORDER BY first_finalized_at_ms ASC,tx_hash ASC,log_index ASC,id ASC FOR UPDATE`, [batchId],
        );
        const lotsByIdentity = new Map(lotRows.map((lot) => [String(lot.event_identity).toLowerCase(), lot]));
        let grossRemaining = new BigNumber(0);
        let netRemaining = new BigNumber(0);
        const refundableSlices = [];
        for (const event of sourceRows) {
          const lot = lotsByIdentity.get(String(event.event_identity).toLowerCase());
          if (!lot) throw new Error(`The protected XTU source lot for event ${event.event_identity} is missing.`);
          if (["common_reserve_owned", "consolidated_common_reserve"].includes(String(lot.status))) {
            throw new Error("An XTU source lot has already been reclassified to common reserves and cannot be refunded automatically.");
          }
          if (new BigNumber(lot.consolidation_reserved_amount || "0").gt(0)) {
            throw new Error("An XTU source lot still has an active consolidation reservation.");
          }
          const originalGross = new BigNumber(lot.gross_amount || event.gross_amount || "0");
          const creditedGross = new BigNumber(lot.gross_credited_amount || "0");
          const receivedNet = new BigNumber(lot.hot_wallet_received_amount || event.net_amount || "0");
          const creditedNet = new BigNumber(lot.credited_amount || "0");
          const reserveOwnedNet = new BigNumber(lot.expired_common_reserve_amount || "0");
          if (!originalGross.isFinite() || !originalGross.isGreaterThan(0) ||
              !creditedGross.isFinite() || creditedGross.isNegative() || creditedGross.gt(originalGross) ||
              !receivedNet.isFinite() || receivedNet.isNegative() || !creditedNet.isFinite() || creditedNet.isNegative() ||
              !reserveOwnedNet.isFinite() || reserveOwnedNet.isNegative()) {
            throw new Error("An XTU source lot has invalid gross/net/credited amounts.");
          }
          const uncreditedGross = BigNumber.maximum(0, originalGross.minus(creditedGross)).decimalPlaces(18, BigNumber.ROUND_DOWN);
          const uncreditedNet = BigNumber.maximum(0, receivedNet.minus(creditedNet).minus(reserveOwnedNet)).decimalPlaces(18, BigNumber.ROUND_DOWN);
          if (uncreditedGross.isZero()) continue;
          if (uncreditedNet.isZero()) throw new Error("An XTU source event has uncredited gross principal but no corresponding received token balance.");
          if (!/^[0-9a-f]{64}$/i.test(String(event.event_identity)) ||
              !/^0x[0-9a-f]{64}$/i.test(String(event.tx_hash)) ||
              !/^0x[0-9a-f]{64}$/i.test(String(event.block_hash))) {
            throw new Error("An XTU source event is missing immutable blockchain identity evidence.");
          }
          grossRemaining = grossRemaining.plus(uncreditedGross);
          netRemaining = netRemaining.plus(uncreditedNet);
          refundableSlices.push({ event, lot, uncreditedGross, uncreditedNet });
        }
        const storedRemaining = new BigNumber(batch.remaining_amount || "0");
        if (!storedRemaining.isFinite() || storedRemaining.isNegative() || !grossRemaining.eq(storedRemaining)) {
          throw new Error("XTU lot-level uncredited gross does not reconcile with the deposit batch remaining_amount.");
        }
        if (grossRemaining.isZero()) {
          await tx.query(
            `UPDATE xtu_deposit_batches SET remaining_amount=0,status='credited',updated_at_ms=? WHERE id=?`,
            [String(now), batchId],
          );
          continue;
        }

        for (const slice of refundableSlices) {
          const event = slice.event;
          const registered = await registerAutomaticRefundEventTx(tx, {
            chainId: 56,
            tokenContract: String(event.token_contract || batch.token_contract || settingsTokenFallback()).toLowerCase(),
            assetCode: "XTU",
            senderAddress: sender,
            payoutAddress: sender,
            sourceTable: "xtu_deposit_transfer_events",
            sourceId: String(event.id),
            sourceKind: "xtu_deactivated_batch",
            eventIdentity: String(event.event_identity),
            txHash: String(event.tx_hash),
            logIndex: Number(event.log_index),
            blockNumber: String(event.block_number),
            blockHash: String(event.block_hash),
            grossAmount: slice.uncreditedNet.toFixed(18),
            finalizedAtMs: Number(event.created_at_ms) > 0 ? Number(event.created_at_ms) : now,
            category: "C",
            username: U,
            reasonCode: "account_deactivated",
            nowMs: now,
          });
          if (registered.status === "manual_review") throw new Error("An existing XTU refund source is already marked for manual review.");
          await tx.query(
            `UPDATE xtu_deposit_transfer_events SET status='automatic_refund_pending',reason_codes=? WHERE id=?`,
            [JSON.stringify(["account_deactivated"]), String(event.id)],
          );
          await tx.query(
            `UPDATE xtu_hot_wallet_lots SET pending_user_amount=0,protected_hot_wallet_amount=?,
             status='refund_queued',updated_at_ms=? WHERE id=?`,
            [slice.uncreditedNet.toFixed(18), String(now), String(slice.lot.id)],
          );
        }
        await tx.query(
          `UPDATE xtu_deposit_batches SET remaining_amount=0,status='refund_queued',reason_codes=?,
           pending_since_ms=NULL,release_at_ms=NULL,updated_at_ms=? WHERE id=? AND remaining_amount=?`,
          [JSON.stringify(["account_deactivated"]), String(now), batchId, storedRemaining.toFixed(18)],
        );
        queuedCount += refundableSlices.length;
        queuedAmount = queuedAmount.plus(netRemaining);
        queuedBatchIds.push(batchId);
        await notifyUserTx(
          tx, U, `xtu-deposit:${batchId}:automatic-refund-category-c`, "OneX XTU deposit routed to automatic refund",
          `Your uncredited XTU deposit balance of ${netRemaining.toFixed(8)} XTU has been transferred to the automatic refund register because the account is deactivated. Already credited amounts are unchanged. Refunds are grouped by token and source address; the net minimum is 1 XTU and amounts below it are retained without an expiry. Batch: ${batchId}.`,
        );
      } catch (error) {
        await tx.query(
          `UPDATE xtu_deposit_batches SET status='manual_review',reason_codes=?,updated_at_ms=? WHERE id=?`,
          [JSON.stringify(["account_deactivation_refund_reconciliation"]), String(now), batchId],
        );
        await tx.query(
          `UPDATE xtu_deposit_transfer_events SET status='manual_review',reason_codes=? WHERE batch_id=?
           AND status NOT IN ('credited','refund_confirmed','refunded')`,
          [JSON.stringify(["account_deactivation_refund_reconciliation"]), batchId],
        );
        console.error(`Deactivated account XTU batch ${batchId} requires refund reconciliation:`, error.message);
      }
    }
    return { count: queuedBatchIds.length, events: queuedCount, batchIds: queuedBatchIds, queuedAmount: queuedAmount.toFixed(18) };
  });
}

function settingsTokenFallback() {
  return String(process.env.XTU_TOKEN_CONTRACT_ADDRESS || "").trim();
}

async function reconcileDeactivatedXtuDepositBatches(pool) {
  const rows = await pool.queryAsync(
    `SELECT DISTINCT b.username
     FROM xtu_deposit_batches b
     INNER JOIN auths a ON a.username=b.username
     WHERE a.account_active=0 AND CAST(b.remaining_amount AS DECIMAL(36,18))>0
       AND b.status IN ('collecting','pending_minimum','ready','pending_reserve','pending_credit',
                        'pending_weekly','pending_support','pending_global')
     ORDER BY b.username ASC LIMIT 100`,
  );
  for (const row of rows) {
    try {
      await routeOutstandingXtuBatchesToAutomaticRefund(pool, row.username);
    } catch (error) {
      console.error(`Deactivated XTU account ${row.username} still requires refund routing:`, error.message);
    }
  }
}

async function processOne(pool, context) {
  const { runtime, provider, mainSigner } = context;
  await scanIncomingEvents(pool, provider, runtime.settings);
  await reconcileDeactivatedXtuDepositBatches(pool);
  await closeExpiredBatches(pool, runtime.settings);
  await notifyDueXtuDepositExpirations(pool, Date.now());
  // Legacy unknown-transfer request/signature/admin-approval refunds are intentionally
  // not executed. Those events are now assigned by assignDepositEventTx to the
  // shared automatic-refund registry and wait for its idempotent payout worker.
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
  assignUnknownXtuTransferToAccount,
  processOneUnknownXtuRefund,
  parseUnknownXtuRefundReceipt,
  routeOutstandingXtuBatchesToAutomaticRefund,
};

if (require.main === module) {
  require("./db").initDbIfEmpty()
    .then(() => startXtuDepositWorker(defaultDb))
    .catch((error) => {
      console.error("Standalone XTU deposit worker failed:", error.message);
      process.exitCode = 1;
    });
}
