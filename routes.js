const express = require("express");
const crypto = require("crypto");
const { getAddress: checksumEvmAddress } = require("ethers");
const fs = require("fs");
const geoip = require("geoip-country");
const nodemailer = require("nodemailer");
const BigNumber = require("bignumber.js");
const {
  deriveUnitPrice,
  deriveInitAsset,
  addReceivedInitAsset,
  calculateTopUpReserveAllocation,
} = require("./stock-accounting");
const {
  MIN_RECHARGE_AMOUNT,
  MAX_RECHARGE_AMOUNT,
  MAX_DEFAULT_STOCK,
  RECHARGE_BATCH_WINDOW_MS,
  RECHARGE_COOLDOWN_MS,
  getLastOnexRecharge,
  assessRechargeCooldown,
  formatUtcRecordDateTime,
  getWeeklyReleaseAt,
} = require("./recharge-policy");
const {
  DISBURSEMENT_COOLDOWN_MS,
  DISBURSEMENT_RESERVATION_MS,
  calculateSystemDisbursement,
  isRequestedPayoutWithinTolerance,
} = require("./disbursement-policy");

const {
  db,
  OneX,
  maxStockDefault,
  P2Pallowed,
  stock_limit,
  first_welcome_clients,
  welcome_bonus,
  tfees,
  admin_pswd,
  admin_pin,
  APP_VERSION,
  MAIL_PORT,
  SERVER_MAIL,
  SERVER_MAIL_PSWD,
  DB_CONFIG,
} = require("./db");

const {
  encrypt,
  decrypt,
  getDate,
  getDateBefore,
  getUserPrefixName,
  transliterateUserText,
  createUserSuffixName,
  hashSecret,
  verifySecret,
} = require("./utils");

const {
  initializePaymentProvider,
  getOrCreateUserDepositAddress,
  startPaymentWatcher: startUsdtPaymentWatcher,
  getPaymentPublicConfig,
  isAddress: isEvmAddress,
} = require("./pay");
const { startDepositSweeper } = require("./sweep");
const { checkTreasuryLiquidity } = require("./disbursement");
const { createTelegramBotLinkTx, queueTelegramMessageTx } = require("./telegram");
const {
  generateTemporaryPassword,
  TEMP_PASSWORD_TTL_MS,
  isTemporaryPasswordActive,
  isPasswordProtectedActivityLocked,
  evaluatePasswordAuthentication,
} = require("./auth-recovery");

const router = express.Router();

function normalizeFormValue(value) {
  // URL-encoded form decoding is handled by Express. Preserve the submitted
  // value exactly; spaces must never be rewritten as literal plus signs.
  return typeof value === "string" ? value : "";
}

function normalizeUsername(value) {
  return normalizeFormValue(value).trim().toUpperCase();
}

function createFinancialReference(prefix = "ONEX") {
  return `${String(prefix).replace(/[^A-Za-z0-9]/g, "").slice(0, 12)}${crypto.randomBytes(16).toString("hex")}`;
}

function requestTokenIsValid(req, token, password, username) {
  const ua = req.headers["user-agent"];
  if (
    typeof token !== "string" ||
    typeof password !== "string" ||
    typeof username !== "string" ||
    typeof ua !== "string"
  ) {
    return false;
  }

  try {
    return ua === decrypt(token, password + username);
  } catch {
    return false;
  }
}

async function getUserActivityPasswordState(username, submittedPassword) {
  if (!username || typeof submittedPassword !== "string") return "incorrect";
  const rows = await db.queryAsync(
    `SELECT password,consec_failed_auth,password_temp_expires_at_ms
     FROM auths WHERE username=? LIMIT 1`,
    [username],
  );
  if (rows.length === 0) return "incorrect";

  const row = rows[0];
  // The lock persists after a temporary-password login. Only changing the
  // temporary password clears the marker and restores normal account activity.
  if (isPasswordProtectedActivityLocked({
    failedCount: Number(row.consec_failed_auth || 0),
    temporaryPasswordExpiresAtMs: row.password_temp_expires_at_ms,
  })) return "not_allowed";

  return (await verifySecret(row.password, submittedPassword)) ? "ok" : "incorrect";
}

async function verifyUserSeed(username, submittedSeed) {
  if (!username || typeof submittedSeed !== "string") return false;
  const rows = await db.queryAsync(
    "SELECT seed FROM auths WHERE username=? LIMIT 1",
    [username],
  );
  if (rows.length === 0) return false;
  return verifySecret(rows[0].seed, submittedSeed);
}

async function issueTemporaryPassword(username, email, subject, warningText) {
  const normalizedEmail = String(email || "").trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
    return { ok: false, reason: "email_unavailable" };
  }

  const temporaryPassword = generateTemporaryPassword();
  const passwordHash = await hashSecret(temporaryPassword);
  const now = Date.now();
  const expiresAt = now + TEMP_PASSWORD_TTL_MS;
  let previousPassword = null;
  let previousExpiry = null;

  const reservation = await withTransaction(async (tx) => {
    const [rows] = await tx.query(
      `SELECT password,password_temp_expires_at_ms,email
       FROM auths WHERE username=? LIMIT 1 FOR UPDATE`,
      [username],
    );
    if (!rows.length) return { ok: false, reason: "account_not_found" };

    const row = rows[0];
    if (String(row.email || "").trim().toLowerCase() !== normalizedEmail.toLowerCase()) {
      return { ok: false, reason: "email_changed" };
    }
    if (isTemporaryPasswordActive(row.password_temp_expires_at_ms, now)) {
      return { ok: false, reason: "temporary_password_active" };
    }

    previousPassword = row.password;
    previousExpiry = row.password_temp_expires_at_ms;
    await tx.query(
      `UPDATE auths SET password=?,password_temp_expires_at_ms=?
       WHERE username=?`,
      [passwordHash, String(expiresAt), username],
    );
    return { ok: true };
  });

  if (!reservation.ok) return reservation;

  try {
    await transporter.sendMail({
      from: SERVER_MAIL,
      to: normalizedEmail,
      subject,
      text: [
        `Your OneX temporary password is: ${temporaryPassword}`,
        "",
        "It contains 7 digits and is valid for 10 minutes.",
        "Use it to sign in, then change your password immediately.",
        warningText || "If you did not request this, contact OneX support immediately.",
      ].join("\n"),
    });
  } catch (error) {
    // Restore the previous credential only if this temporary credential is still current.
    await db.queryAsync(
      `UPDATE auths
       SET password=?,password_temp_expires_at_ms=?
       WHERE username=? AND password=? AND password_temp_expires_at_ms=?`,
      [previousPassword, previousExpiry, username, passwordHash, String(expiresAt)],
    ).catch((restoreError) => {
      console.error("Unable to restore credentials after temporary-password email failure:", restoreError.message);
    });
    throw error;
  }

  return { ok: true, expiresInSeconds: 600 };
}

async function getConnection() {
  return new Promise((resolve, reject) => {
    db.getConnection((error, connection) => {
      if (error) return reject(error);
      resolve(connection);
    });
  });
}

async function withTransaction(work, maxAttempts = 3) {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const connection = await getConnection();
    let tx;
    let transactionStarted = false;
    let retry = false;

    try {
      tx = connection.promise();
      await tx.beginTransaction();
      transactionStarted = true;
      const result = await work(tx);
      await tx.commit();
      transactionStarted = false;
      return result;
    } catch (error) {
      if (transactionStarted) {
        try {
          await tx.rollback();
        } catch (rollbackError) {
          console.error("Database transaction rollback failed:", rollbackError);
        }
      }

      const retryable =
        error &&
        ["ER_LOCK_DEADLOCK", "ER_LOCK_WAIT_TIMEOUT"].includes(error.code);
      if (!retryable || attempt === maxAttempts) throw error;
      retry = true;
    } finally {
      connection.release();
    }

    if (retry) await new Promise((resolve) => setTimeout(resolve, attempt * 40));
  }
  throw new Error("Transaction retry limit reached");
}


async function queueUserTransactionStatus(username, eventType, status, details = []) {
  const eventReference = createFinancialReference("ALERT");
  try {
    await withTransaction(async (tx) => {
      await queueTelegramMessageTx(
        tx,
        username,
        `transaction:${eventType}:${eventReference}:${status}`,
        [
          "OneX Transaction Update",
          ...details,
          `Status: ${String(status).toUpperCase()}`,
          `Reference: ${eventReference}`,
        ].join("\n"),
      );
    });
  } catch (error) {
    // Notification delivery must never roll back or alter the financial operation.
    console.error("Unable to queue transaction status notification:", error.message);
  }
}

async function applyUserTopUp(
  tx,
  username,
  amountValue,
  reference,
  date,
  time,
  eventTimestampMs = Date.now(),
  options = {},
) {
  const enforceRechargeRange = options.enforceRechargeRange !== false;
  if (!amountValue.isFinite() || !amountValue.isGreaterThan(0)) {
    return { error: "invalid top-up amount" };
  }
  if (enforceRechargeRange && amountValue.isLessThan(MIN_RECHARGE_AMOUNT)) {
    return { error: "minimum recharge amount not met" };
  }
  if (enforceRechargeRange && amountValue.isGreaterThan(MAX_RECHARGE_AMOUNT)) {
    return { error: "maximum recharge amount exceeded" };
  }

  const [authRows] = await tx.query(
    "SELECT status FROM auths WHERE username=? FOR UPDATE",
    [username],
  );
  if (authRows.length === 0 || Number(authRows[0].status) <= 0) {
    return { error: "user not found" };
  }

  const [userRows] = await tx.query(
    "SELECT balance,init_asset FROM users_stock WHERE username=? FOR UPDATE",
    [username],
  );
  if (userRows.length === 0) return { error: "user not found" };

  const [pendingDisbursementRows] = await tx.query(
    `SELECT id FROM users_usdt_disbursements
     WHERE username=? AND status IN ('queued','signed','submitted','manual_review')
     ORDER BY id DESC LIMIT 1 FOR UPDATE`,
    [username],
  );
  if (pendingDisbursementRows.length > 0) {
    return { error: "disbursement is pending" };
  }

  const userBalance = new BigNumber(userRows[0].balance);
  if (!userBalance.isFinite() || userBalance.isNegative()) {
    throw new Error("Invalid user balance during top-up");
  }

  const lastRecharge = await getLastOnexRecharge(tx, username, OneX);
  const cooldown = assessRechargeCooldown(lastRecharge, eventTimestampMs);
  if (!cooldown.allowed) {
    return {
      error: "weekly recharge limit reached",
      remaining_seconds: Math.ceil(cooldown.remainingMs / 1000),
    };
  }

  const maxStock = new BigNumber(maxStockDefault);
  if (!maxStock.isFinite() || maxStock.isNegative()) {
    throw new Error("Invalid maximum user stock configuration");
  }

  const [commonLockRows] = await tx.query(
    "SELECT lock_name FROM system_locks WHERE lock_name=? FOR UPDATE",
    ["common_state"],
  );
  if (commonLockRows.length === 0) {
    throw new Error("The common-state lock row has not been initialized");
  }

  const [commonRows] = await tx.query(
    "SELECT total_units_price,unit_price,backed_units,inactive_init_asset FROM common ORDER BY id DESC LIMIT 1 FOR UPDATE",
  );
  if (commonRows.length === 0) {
    throw new Error("Common reserve is not initialized");
  }

  const common = commonRows[0];
  const lastTotal = new BigNumber(common.total_units_price);
  const lastPrice = new BigNumber(common.unit_price);
  const backed = new BigNumber(common.backed_units);
  const inactive = new BigNumber(common.inactive_init_asset);
  if (
    !lastTotal.isFinite() ||
    !lastTotal.isGreaterThan(0) ||
    !lastPrice.isFinite() ||
    !lastPrice.isGreaterThan(0) ||
    !backed.isFinite() ||
    backed.isNegative() ||
    !inactive.isFinite() ||
    inactive.isNegative()
  ) {
    throw new Error("Invalid common reserve values during top-up");
  }

  // Inactive initial assets are consumed first. Backed assets are used only
  // for the remaining top-up amount; this also determines whether price changes.
  const reserveAllocation = calculateTopUpReserveAllocation(
    amountValue,
    lastPrice,
    backed,
    inactive,
    lastTotal,
  );
  if (!reserveAllocation.available) {
    return { limit: `BSC-USD ${reserveAllocation.availableValue.toFixed()}` };
  }

  const {
    activityAmount,
    newInactive,
    newBacked: remainedBacked,
    newTotalUnitsPrice: newTotal,
    newUnitPrice: newPrice,
    usedBackedAssets,
  } = reserveAllocation;

  const newBalance = userBalance.plus(amountValue);
  if (newBalance.isGreaterThan(maxStock)) {
    return { error: "maximum user balance exceeded" };
  }
  const currentInitAsset = new BigNumber(userRows[0].init_asset);
  if (!currentInitAsset.isFinite() || currentInitAsset.isNegative()) {
    throw new Error("Invalid user initial-asset basis during top-up");
  }
  const newInitAsset = currentInitAsset.plus(activityAmount);

  if (!newBalance.isFinite() || !newInitAsset.isFinite()) {
    throw new Error("Invalid user top-up calculations");
  }

  await tx.query(
    "INSERT INTO activities(sender,receiver,type,amount,unit_price,fees,reference,record_date,record_time) VALUES(?,?,?,?,?,?,?,?,?)",
    [OneX, username, 2, activityAmount.toFixed(), lastPrice.toFixed(), "0", reference, date, time],
  );
  await tx.query(
    "UPDATE users_stock SET balance=?,init_asset=?,record_date=?,record_time=? WHERE username=?",
    [newBalance.toFixed(), newInitAsset.toFixed(), date, time, username],
  );
  await tx.query(
    "INSERT INTO common(total_units_price,unit_price,backed_units,inactive_init_asset,record_date,record_time) VALUES(?,?,?,?,?,?)",
    [newTotal.toFixed(), newPrice.toFixed(), remainedBacked.toFixed(), newInactive.toFixed(), date, time],
  );
  await queueTelegramMessageTx(
    tx,
    username,
    `recharge:${reference}:credited`,
    [
      "OneX Recharge Update",
      "Your recharge has been credited successfully.",
      `Amount received: ${amountValue.toFixed(8)} BSC-USD`,
      `Amount credited: ${amountValue.toFixed(8)} One-Val`,
      `Reference: ${reference}`,
      "Status: SUCCESS",
    ].join("\n"),
  );

  return {
    transf: "sent",
    reserve_source: usedBackedAssets ? "inactive_and_backed_or_backed" : "inactive",
  };
}

async function queueSystemDisbursement(tx, username, verifiedPasswordHash, requestedAmount) {
  if (String(process.env.USDT_DISBURSEMENTS_ENABLED || "false").toLowerCase() !== "true") {
    return { transf: "disbursement unavailable" };
  }
  const paymentConfig = getPaymentPublicConfig();
  if (!paymentConfig.enabled || !process.env.USDT_BEP20_TREASURY_ADDRESS) {
    return { transf: "disbursement unavailable" };
  }

  const [authRows] = await tx.query(
    "SELECT status,password,consec_failed_auth,password_temp_expires_at_ms FROM auths WHERE username=? FOR UPDATE",
    [username],
  );
  if (authRows.length && (
    Number(authRows[0].consec_failed_auth || 0) >= 3 ||
    authRows[0].password_temp_expires_at_ms != null
  )) return { auth: "not allowed" };
  if (
    authRows.length === 0 ||
    Number(authRows[0].status) <= 0 ||
    authRows[0].password !== verifiedPasswordHash
  ) {
    return { transf: "failed" };
  }

  const [stockRows] = await tx.query(
    "SELECT balance,init_asset FROM users_stock WHERE username=? FOR UPDATE",
    [username],
  );
  if (stockRows.length === 0) return { transf: "failed" };

  const [walletRows] = await tx.query(
    `SELECT payout_address FROM users_usdt_deposit_wallets
     WHERE username=? LIMIT 1 FOR UPDATE`,
    [username],
  );
  const payoutAddress = walletRows[0]?.payout_address || "";
  if (!isEvmAddress(payoutAddress) || /^0x0{40}$/i.test(payoutAddress)) {
    return { transf: "payout wallet not registered" };
  }
  if (
    String(payoutAddress).toLowerCase() ===
    String(process.env.USDT_BEP20_TREASURY_ADDRESS).toLowerCase()
  ) {
    return { transf: "invalid payout wallet" };
  }

  const now = Date.now();
  const [successfulRows] = await tx.query(
    `SELECT id FROM users_usdt_disbursements
     WHERE username=? AND status='confirmed' AND CAST(confirmed_at_ms AS UNSIGNED)>=?
     ORDER BY confirmed_at_ms DESC LIMIT 1 FOR UPDATE`,
    [username, String(now - DISBURSEMENT_COOLDOWN_MS)],
  );
  if (successfulRows.length > 0) {
    return { transf: "disbursement limit reached", cooldown_days: 90 };
  }
  const [activeRows] = await tx.query(
    `SELECT id FROM users_usdt_disbursements
     WHERE username=? AND status IN ('queued','signed','submitted','manual_review')
     ORDER BY id DESC LIMIT 1 FOR UPDATE`, [username],
  );
  if (activeRows.length > 0) return { transf: "disbursement pending" };

  const userBalance = new BigNumber(stockRows[0].balance);
  const userInitAsset = new BigNumber(stockRows[0].init_asset);
  const maxStock = new BigNumber(maxStockDefault);
  const minimumEligibleBalance = maxStock.minus(10);
  if (
    !userBalance.isFinite() ||
    !userInitAsset.isFinite() ||
    userBalance.isLessThan(minimumEligibleBalance) ||
    !userInitAsset.isGreaterThan(0)
  ) {
    return {
      transf: "not eligible",
      minimum_balance: minimumEligibleBalance.toFixed(),
    };
  }

  const priceValue = deriveUnitPrice(userBalance, userInitAsset);
  const calculation = calculateSystemDisbursement(
    userBalance,
    userInitAsset,
    priceValue,
    tfees,
  );
  if (!isRequestedPayoutWithinTolerance(requestedAmount, calculation.payoutAmount)) {
    return {
      transf: "invalid disbursement amount",
      expected_amount: calculation.payoutAmount.toFixed(18),
    };
  }

  const [commonLockRows] = await tx.query(
    "SELECT lock_name FROM system_locks WHERE lock_name=? FOR UPDATE",
    ["common_state"],
  );
  if (commonLockRows.length === 0) {
    throw new Error("The common-state lock row has not been initialized");
  }

  const [commonRows] = await tx.query(
    `SELECT total_units_price,unit_price,backed_units,inactive_init_asset
     FROM common ORDER BY id DESC LIMIT 1 FOR UPDATE`,
  );
  if (commonRows.length === 0) throw new Error("Common reserve is not initialized");

  const [pendingPayoutRows] = await tx.query(
    `SELECT payout_amount FROM users_usdt_disbursements
     WHERE status IN ('queued','signed','submitted','manual_review')
     FOR UPDATE`,
  );
  const pendingPayoutTotal = pendingPayoutRows.reduce(
    (sum, row) => sum.plus(row.payout_amount),
    new BigNumber(0),
  );
  const totalUnitsPrice = new BigNumber(commonRows[0].total_units_price);
  const commonUnitPrice = new BigNumber(commonRows[0].unit_price);
  const commonBackedUnits = new BigNumber(commonRows[0].backed_units);
  const commonInactiveAssets = new BigNumber(commonRows[0].inactive_init_asset);
  const availableAfterPending = totalUnitsPrice.minus(pendingPayoutTotal);
  if (
    !totalUnitsPrice.isFinite() ||
    totalUnitsPrice.isNegative() ||
    !commonUnitPrice.isFinite() ||
    !commonUnitPrice.isGreaterThan(0) ||
    !commonBackedUnits.isFinite() ||
    commonBackedUnits.isNegative() ||
    !commonInactiveAssets.isFinite() ||
    commonInactiveAssets.isNegative() ||
    !pendingPayoutTotal.isFinite() ||
    pendingPayoutTotal.isNegative() ||
    !availableAfterPending.isGreaterThanOrEqualTo(calculation.payoutAmount)
  ) {
    return { transf: "insufficient disbursement reserve" };
  }

  const reference = createFinancialReference(`DISB${username}`);
  const amountRaw = calculation.amountRaw;
  const [date, time] = getDate();
  await tx.query(
    `INSERT INTO users_usdt_disbursements
     (username,payout_address,requested_amount,payout_amount,amount_raw,gross_balance,gross_init_asset,
      sold_init_asset,fee_amount,fee_init_asset,price_value,reference,status,created_at_ms,reservation_expires_at_ms,updated_at_ms)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,'queued',?,?,?)`,
    [
      username,
      payoutAddress,
      calculation.payoutAmount.toFixed(18),
      calculation.payoutAmount.toFixed(18),
      amountRaw,
      calculation.grossBalance.toFixed(),
      calculation.grossInitAsset.toFixed(),
      calculation.soldInitAsset.toFixed(),
      calculation.feeAmount.toFixed(),
      calculation.feeInitAsset.toFixed(),
      calculation.priceValue.toFixed(),
      reference,
      String(now),
      String(now + DISBURSEMENT_RESERVATION_MS),
      String(now),
    ],
  );
  const [idRows] = await tx.query(
    "SELECT id FROM users_usdt_disbursements WHERE reference=? LIMIT 1",
    [reference],
  );
  if (idRows.length === 0) throw new Error("Unable to read the queued disbursement");

  // Reserve the user's entire balance while the dedicated payout worker sends
  // BSC-USD. The inactive reserve and common total are updated only after the
  // outgoing token transfer has reached the configured finality threshold.
  await tx.query(
    "UPDATE users_stock SET balance='0',init_asset='0',record_date=?,record_time=? WHERE username=?",
    [date, time, username],
  );
  await queueTelegramMessageTx(
    tx,
    username,
    `disbursement:${idRows[0].id}:queued`,
    [
      "OneX Disbursement Update",
      "Your sale request has been accepted and the balance is reserved.",
      `Gross amount: ${calculation.grossBalance.toFixed(8)} One-Val`,
      `Fees: ${calculation.feeAmount.toFixed(8)} One-Val`,
      `Expected payment: ${calculation.payoutAmount.toFixed(8)} BSC-USD`,
      `Reference: ${reference}`,
      "Status: PROCESSING",
    ].join("\n"),
  );

  return {
    transf: "processing",
    disbursement_id: String(idRows[0].id),
    payout_amount: calculation.payoutAmount.toFixed(18),
    payout_address: payoutAddress,
    message: "La demande est enregistrée. Le paiement BSC-USD sera envoyé après validation blockchain.",
  };
}

const RECHARGE_HOLD_REASON_TEXT = {
  below_minimum: "The total received during the 60-minute session is below 70 BSC-USD.",
  above_maximum: "The total received during the 60-minute session exceeds 140 BSC-USD.",
  weekly_limit: "A recharge was credited to this account within the last seven days. The system will retry automatically at the displayed release time.",
  maximum_user_balance: "Crediting this recharge would exceed the maximum account balance of 300 One-Val.",
  account_unavailable: "The OneX account is disabled, deleted or unavailable.",
  system_reserve: "The system reserves are not currently sufficient to credit this payment.",
  previous_batch_unresolved: "A previous payment for this account still requires support review.",
};

function getReasonText(reasonCodes) {
  return reasonCodes.map((code) => RECHARGE_HOLD_REASON_TEXT[code] || "This transfer requires manual review.");
}

function formatTelegramUtc(ms) {
  const value = Number(ms);
  return Number.isFinite(value) ? new Date(value).toISOString() : "Unavailable";
}

async function queueRechargeBatchStatusTx(tx, username, batchId, status, reasonCodes = [], releaseAtMs = null) {
  const eventKey = `recharge:batch:${batchId}:${status}`;
  const lines = [
    "OneX Recharge Update",
    `Batch: ${batchId}`,
    `Status: ${String(status).toUpperCase()}`,
  ];
  if (reasonCodes.length) {
    lines.push("Reason:", ...getReasonText(reasonCodes));
  }
  if (releaseAtMs != null) lines.push(`Expected automatic retry (UTC): ${formatTelegramUtc(releaseAtMs)}`);
  if (status === "pending_support") lines.push("Please contact OneX support by email or phone.");
  if (status === "pending_reserve") lines.push("The system will retry when reserve availability is restored.");
  if (status === "pending_weekly") lines.push("Your payment is kept safely pending; no recharge has been credited yet.");
  await queueTelegramMessageTx(tx, username, eventKey, lines.join("\n"));
}

function safeJson(value) {
  try { return JSON.stringify(value); } catch { return "[]"; }
}

async function processConfirmedUsdtPayment(event) {
  const amountValue = new BigNumber(event.amount);
  if (!amountValue.isFinite() || !amountValue.isGreaterThan(0)) {
    throw new Error("The detected BEP-20 transfer amount is invalid.");
  }

  return withTransaction(async (tx) => {
    const [walletRows] = await tx.query(
      `SELECT id,username,wallet_address,account_status
       FROM users_usdt_deposit_wallets
       WHERE id=? AND wallet_address=? LIMIT 1 FOR UPDATE`,
      [event.depositWalletId, event.depositAddress],
    );
    if (!walletRows.length) {
      throw new Error("The confirmed transfer does not match a registered OneX deposit address.");
    }

    const wallet = walletRows[0];
    const username = wallet.username;
    const [eventInsert] = await tx.query(
      `INSERT IGNORE INTO users_usdt_transfer_events
       (username,deposit_wallet_id,batch_id,deposit_address,from_address,amount,amount_raw,tx_hash,log_index,
        block_number,block_hash,block_timestamp_ms,status,reason_codes,created_at_ms)
       VALUES(?,?,NULL,?,?,?,?,?,?,?,?,?,'detected',NULL,?)`,
      [
        username,
        event.depositWalletId,
        event.depositAddress,
        event.fromAddress,
        amountValue.toFixed(18),
        event.amountRaw,
        event.txHash,
        event.logIndex,
        event.blockNumber,
        event.blockHash,
        String(event.blockTimestampMs),
        String(Date.now()),
      ],
    );
    if (eventInsert.affectedRows !== 1) return { duplicate: true };

    const [authRows] = await tx.query(
      "SELECT status FROM auths WHERE username=? LIMIT 1 FOR UPDATE", [username],
    );
    const [stockRows] = await tx.query(
      "SELECT balance FROM users_stock WHERE username=? LIMIT 1 FOR UPDATE", [username],
    );

    const now = Date.now();
    const [activeBatchRows] = await tx.query(
      `SELECT * FROM users_usdt_deposit_batches
       WHERE username=? AND status='collecting'
       ORDER BY id DESC LIMIT 1 FOR UPDATE`,
      [username],
    );

    let batch = activeBatchRows[0] || null;
    if (batch && now >= Number(batch.expires_at_ms)) {
      await tx.query(
        "UPDATE users_usdt_deposit_batches SET status='ready',updated_at_ms=? WHERE id=? AND status='collecting'",
        [String(now), batch.id],
      );
      batch = null;
    }

    let initialStatus = "collecting";
    let initialReasons = [];
    if (wallet.account_status !== "active" || !authRows.length || Number(authRows[0].status) <= 0 || !stockRows.length) {
      initialStatus = "pending_support";
      initialReasons.push("account_unavailable");
    }

    if (!batch) {
      const [unresolvedRows] = await tx.query(
        `SELECT id FROM users_usdt_deposit_batches
         WHERE username=? AND status IN ('pending_support','finalizing','refund_queued')
         ORDER BY id DESC LIMIT 1 FOR UPDATE`,
        [username],
      );
      if (unresolvedRows.length) {
        initialStatus = "pending_support";
        initialReasons.push("previous_batch_unresolved");
      }
      // Start the collection window when OneX first processes the finalized event.
      const openedAt = now;
      const expiresAt = openedAt + RECHARGE_BATCH_WINDOW_MS;
      const [batchInsert] = await tx.query(
        `INSERT INTO users_usdt_deposit_batches
         (username,deposit_wallet_id,deposit_address,opened_at_ms,expires_at_ms,total_amount,total_amount_raw,
          transfer_count,status,reason_codes,created_at_ms,updated_at_ms)
         VALUES(?,?,?,?,?,0,0,1,?,?,?,?)`,
        [
          username,
          event.depositWalletId,
          event.depositAddress,
          String(openedAt),
          String(expiresAt),
          initialStatus,
          initialReasons.length ? safeJson(initialReasons) : null,
          String(now),
          String(now),
        ],
      );
      const [createdRows] = await tx.query(
        "SELECT * FROM users_usdt_deposit_batches WHERE id=? LIMIT 1 FOR UPDATE",
        [batchInsert.insertId],
      );
      batch = createdRows[0];
    }

    const nextStatus = batch.status === "collecting" ? "batched" : "pending_support";
    let reasonCodes = initialReasons;
    if (batch.reason_codes) {
      try {
        const parsedReasons = JSON.parse(batch.reason_codes);
        if (Array.isArray(parsedReasons)) reasonCodes = parsedReasons;
      } catch {
        reasonCodes = ["invalid_stored_reason_data"];
      }
    }
    await tx.query(
      `UPDATE users_usdt_deposit_batches
       SET total_amount=total_amount+?,total_amount_raw=total_amount_raw+?,transfer_count=transfer_count+1,updated_at_ms=?
       WHERE id=?`,
      [amountValue.toFixed(18), event.amountRaw, String(now), batch.id],
    );
    await tx.query(
      `UPDATE users_usdt_transfer_events SET batch_id=?,status=?,reason_codes=? WHERE tx_hash=? AND log_index=?`,
      [batch.id, nextStatus, reasonCodes.length ? safeJson(reasonCodes) : null, event.txHash, event.logIndex],
    );

    const batchTotal = new BigNumber(batch.total_amount || 0).plus(amountValue);
    await queueTelegramMessageTx(
      tx,
      username,
      `deposit:${event.txHash}:${event.logIndex}:received`,
      [
        "OneX Deposit Update",
        "A BSC-USD transfer to your OneX deposit address has been finalized.",
        `Amount received: ${amountValue.toFixed(8)} BSC-USD`,
        `Session total: ${batchTotal.toFixed(8)} BSC-USD`,
        `Batch: ${batch.id}`,
        `Transaction: ${event.txHash}`,
        `Status: ${String(nextStatus).toUpperCase()}`,
      ].join("\n"),
    );
    if (nextStatus === "pending_support") {
      await queueRechargeBatchStatusTx(tx, username, batch.id, nextStatus, reasonCodes);
    }

    return {
      accepted: true,
      username,
      batchId: String(batch.id),
      status: nextStatus,
      expiresAtMs: Number(batch.expires_at_ms),
    };
  });
}

async function updateBatchEventStatus(tx, batchId, status, reasonCodes = null) {
  await tx.query(
    `UPDATE users_usdt_transfer_events
     SET status=?,reason_codes=?
     WHERE batch_id=? AND status IN ('batched','pending_weekly','pending_reserve','pending_support')`,
    [status, reasonCodes ? safeJson(reasonCodes) : null, batchId],
  );
}

async function processOneRechargeBatch(batchId) {
  return withTransaction(async (tx) => {
    const [snapshotRows] = await tx.query(
      "SELECT username,deposit_wallet_id FROM users_usdt_deposit_batches WHERE id=? LIMIT 1",
      [batchId],
    );
    if (!snapshotRows.length) return { skipped: true };

    const [walletRows] = await tx.query(
      "SELECT id FROM users_usdt_deposit_wallets WHERE id=? LIMIT 1 FOR UPDATE",
      [snapshotRows[0].deposit_wallet_id],
    );
    const [authRows] = await tx.query(
      "SELECT status FROM auths WHERE username=? LIMIT 1 FOR UPDATE",
      [snapshotRows[0].username],
    );
    const [stockRows] = await tx.query(
      "SELECT balance,init_asset FROM users_stock WHERE username=? LIMIT 1 FOR UPDATE",
      [snapshotRows[0].username],
    );
    const [batchRows] = await tx.query(
      "SELECT * FROM users_usdt_deposit_batches WHERE id=? LIMIT 1 FOR UPDATE",
      [batchId],
    );
    if (!batchRows.length) return { skipped: true };
    const batch = batchRows[0];
    const now = Date.now();
    if (batch.status === "collecting") {
      if (now < Number(batch.expires_at_ms)) return { waiting: true };
      await tx.query(
        "UPDATE users_usdt_deposit_batches SET status='ready',updated_at_ms=? WHERE id=?",
        [String(now), batchId],
      );
      batch.status = "ready";
    }
    if (!['ready','pending_weekly','pending_reserve'].includes(batch.status)) return { skipped: true };
    if (batch.status === "pending_weekly" && Number(batch.release_at_ms || 0) > now) return { waiting: true };
    if (batch.status === "pending_reserve" && Number(batch.next_attempt_at_ms || 0) > now) return { waiting: true };

    const amount = new BigNumber(batch.total_amount);
    const reasons = [];
    if (!amount.isFinite() || amount.isLessThan(MIN_RECHARGE_AMOUNT)) reasons.push("below_minimum");
    if (amount.isFinite() && amount.isGreaterThan(MAX_RECHARGE_AMOUNT)) reasons.push("above_maximum");
    if (reasons.length) {
      await tx.query(
        `UPDATE users_usdt_deposit_batches
         SET status='pending_support',reason_codes=?,pending_since_ms=COALESCE(pending_since_ms,?),updated_at_ms=?
         WHERE id=?`,
        [safeJson(reasons), String(batch.expires_at_ms || now), String(now), batchId],
      );
      await updateBatchEventStatus(tx, batchId, "pending_support", reasons);
      await queueRechargeBatchStatusTx(tx, batch.username, batchId, "pending_support", reasons);
      return { held: true, reasons };
    }

    if (!authRows.length || Number(authRows[0].status) <= 0 || !stockRows.length) {
      reasons.push("account_unavailable");
      await tx.query(
        `UPDATE users_usdt_deposit_batches SET status='pending_support',reason_codes=?,pending_since_ms=COALESCE(pending_since_ms,?),updated_at_ms=? WHERE id=?`,
        [safeJson(reasons), String(now), String(now), batchId],
      );
      await updateBatchEventStatus(tx, batchId, "pending_support", reasons);
      await queueRechargeBatchStatusTx(tx, batch.username, batchId, "pending_support", reasons);
      return { held: true, reasons };
    }

    const lastRecharge = await getLastOnexRecharge(tx, batch.username, OneX);
    const cooldown = assessRechargeCooldown(lastRecharge, now);
    if (!cooldown.allowed) {
      const pendingSince = Number(batch.pending_since_ms || now);
      const releaseAt = getWeeklyReleaseAt(pendingSince, cooldown.lastRechargeMs);
      await tx.query(
        `UPDATE users_usdt_deposit_batches
         SET status='pending_weekly',pending_since_ms=COALESCE(pending_since_ms,?),release_at_ms=?,next_attempt_at_ms=?,reason_codes=?,updated_at_ms=?
         WHERE id=?`,
        [String(pendingSince), String(releaseAt), String(releaseAt), safeJson(["weekly_limit"]), String(now), batchId],
      );
      await updateBatchEventStatus(tx, batchId, "pending_weekly", ["weekly_limit"]);
      await queueRechargeBatchStatusTx(tx, batch.username, batchId, "pending_weekly", ["weekly_limit"], releaseAt);
      return { waiting: true, releaseAtMs: releaseAt };
    }

    const userBalance = new BigNumber(stockRows[0].balance);
    if (!userBalance.isFinite() || userBalance.isNegative() || userBalance.plus(amount).isGreaterThan(MAX_DEFAULT_STOCK)) {
      reasons.push("maximum_user_balance");
      await tx.query(
        `UPDATE users_usdt_deposit_batches SET status='pending_support',reason_codes=?,pending_since_ms=COALESCE(pending_since_ms,?),updated_at_ms=? WHERE id=?`,
        [safeJson(reasons), String(now), String(now), batchId],
      );
      await updateBatchEventStatus(tx, batchId, "pending_support", reasons);
      await queueRechargeBatchStatusTx(tx, batch.username, batchId, "pending_support", reasons);
      return { held: true, reasons };
    }

    const [date, time] = formatUtcRecordDateTime(now);
    const reference = createFinancialReference(`TOP${batch.username}`);
    const creditResult = await applyUserTopUp(
      tx,
      batch.username,
      amount,
      reference,
      date,
      time,
      now,
    );
    if (creditResult?.transf !== "sent") {
      if (creditResult?.limit || creditResult?.error === "reserve unavailable") {
        const retryAt = now + 5 * 60 * 1000;
        await tx.query(
          `UPDATE users_usdt_deposit_batches SET status='pending_reserve',next_attempt_at_ms=?,reason_codes=?,updated_at_ms=? WHERE id=?`,
          [String(retryAt), safeJson(["system_reserve"]), String(now), batchId],
        );
        await updateBatchEventStatus(tx, batchId, "pending_reserve", ["system_reserve"]);
        await queueRechargeBatchStatusTx(tx, batch.username, batchId, "pending_reserve", ["system_reserve"], retryAt);
        return { waiting: true, retryAtMs: retryAt };
      }
      if (creditResult?.error === "weekly recharge limit reached") {
        const pendingSince = Number(batch.pending_since_ms || now);
        const releaseAt = getWeeklyReleaseAt(pendingSince, cooldown.lastRechargeMs);
        await tx.query(
          `UPDATE users_usdt_deposit_batches SET status='pending_weekly',pending_since_ms=COALESCE(pending_since_ms,?),release_at_ms=?,next_attempt_at_ms=?,reason_codes=?,updated_at_ms=? WHERE id=?`,
          [String(pendingSince), String(releaseAt), String(releaseAt), safeJson(["weekly_limit"]), String(now), batchId],
        );
        await updateBatchEventStatus(tx, batchId, "pending_weekly", ["weekly_limit"]);
        await queueRechargeBatchStatusTx(tx, batch.username, batchId, "pending_weekly", ["weekly_limit"], releaseAt);
        return { waiting: true, releaseAtMs: releaseAt };
      }
      throw new Error(`Recharge batch credit failed: ${JSON.stringify(creditResult)}`);
    }

    await tx.query(
      `UPDATE users_usdt_deposit_batches
       SET status='credited',reason_codes=NULL,credited_at_ms=?,updated_at_ms=?
       WHERE id=? AND status IN ('ready','pending_weekly','pending_reserve')`,
      [String(now), String(now), batchId],
    );
    await updateBatchEventStatus(tx, batchId, "credited", null);
    return { credited: true, batchId: String(batchId), amount: amount.toFixed(18) };
  });
}

async function processRechargeBatchQueue() {
  const now = Date.now();
  const rows = await db.queryAsync(
    `SELECT id FROM users_usdt_deposit_batches
     WHERE (status='collecting' AND expires_at_ms<=?)
        OR (status='ready')
        OR (status='pending_weekly' AND release_at_ms<=?)
        OR (status='pending_reserve' AND next_attempt_at_ms<=?)
     ORDER BY id ASC LIMIT 50`,
    [String(now), String(now), String(now)],
  );
  for (const row of rows) {
    try {
      await processOneRechargeBatch(row.id);
    } catch (error) {
      console.error(`Recharge batch ${row.id} failed:`, error.message);
    }
  }
}

// ----- MAILER -----
const configuredMailPort = Number(MAIL_PORT || 587);
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || "smtp.gmail.com",
  port: configuredMailPort,
  secure: configuredMailPort === 465,
  auth: { user: SERVER_MAIL, pass: SERVER_MAIL_PSWD },
  connectionTimeout: 15000,
  greetingTimeout: 15000,
  socketTimeout: 30000,
});

if (!SERVER_MAIL || !SERVER_MAIL_PSWD) {
  console.warn("Email delivery is not configured: set SERV_MAIL and SERV_MAIL_PSWD.");
}

// ----- PUBLIC GET -----
router.get("/", (_r, s) => s.redirect("/app/download-latest-apk"));

router.get("/app/privacy-terms-info", async (req, res) => {
  const language = typeof req.query.l === "string" ? req.query.l.toLowerCase() : "";
  if (!["en", "fr"].includes(language)) return res.status(400).send("unsupported language");
  const documentType = req.query.r === "terms" ? "terms" : "privacy";
  const file = `./${documentType}_${language}.html`;
  try {
    res.send(await fs.promises.readFile(file, "utf8"));
  } catch {
    res.status(404).send("document not found");
  }
});

router.get("/app/download-latest-apk", (_r, res, n) =>
  res.download("./OneX.apk", "OneX.apk", n),
);

// ----- APP POSTS -----
// check version
router.post("/app/check-app-version", (_r, res) => {
  const size = fs.statSync("./OneX.apk").size / (1024 * 1024);
  res.send({ version: APP_VERSION, size });
});

// contact
router.post("/app/contact-onex", async (req, res) => {
  const { user, pswd, subj, msg, tkn } = req.body || {};
  const U = normalizeUsername(user);
  const P = normalizeFormValue(pswd);

  if (!requestTokenIsValid(req, tkn, P, U)) {
    return res.send({ status: "forbidden request" });
  }

  try {
    const passwordState = await getUserActivityPasswordState(U, P);
    if (passwordState === "not_allowed") return res.send({ auth: "not allowed" });
    if (passwordState !== "ok") return res.send({ status: "error" });
    const rows = await db.queryAsync(
      "SELECT email FROM auths WHERE username=? LIMIT 1",
      [U],
    );
    if (rows.length === 0) return res.send({ status: "error" });

    const safeSubject = (typeof subj === "string" ? subj : "OneX contact")
      .replace(/[\r\n\u0000-\u001f\u007f]/g, " ")
      .trim()
      .slice(0, 160) || "OneX contact";
    const safeMessage = typeof msg === "string" ? msg.slice(0, 10_000) : "";
    await transporter.sendMail({
      from: SERVER_MAIL,
      to: SERVER_MAIL,
      subject: safeSubject,
      text: `From: ${rows[0].email} (${U})\n\n${safeMessage}`,
    });
    res.send({ status: "sent" });
  } catch (error) {
    console.error("Contact request failed:", error);
    res.send({ status: "error" });
  }
});

// signup
router.post("/app/signup", async (req, res) => {
  const {
    email,
    birth,
    addr,
    name,
    cni,
    pswd,
    seed,
    cniimg1,
    cniimg2,
  } = req.body || {};

  const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress;
  const geo = geoip.lookup(ip);
  if (!geo) return res.send({ msg: "what country" });

  // First launch if Madagascar only allowed
  if (geo.country !== "MG")
    return res.send({ msg: "unsupported country" });

  const requiredTextValues = [email, birth, addr, name, cni, pswd, seed];
  if (requiredTextValues.some((value) => typeof value !== "string")) {
    return res.status(400).send({ msg: "invalid input" });
  }
  if (!pswd || !seed) {
    return res.status(400).send({ msg: "invalid input" });
  }

  let latinName;
  let latinAddress;
  try {
    // Transliterate free-form personal text before deriving usernames or storing data.
    latinName = transliterateUserText(name);
    latinAddress = transliterateUserText(addr);
  } catch (error) {
    console.error("Signup text transliteration failed:", error);
    return res.status(400).send({ msg: "invalid input" });
  }

  if (!latinName) {
    return res.status(400).send({ msg: "invalid name" });
  }

  const Email = email.trim();
  const Birth = birth.trim();
  const Address = latinAddress;
  const Name = latinName;
  const CNI = encrypt(cni.trim(), DB_CONFIG.password);
  const passwordValue = pswd;
  const seedValue = seed;
  let PWD;
  let SEED;
  try {
    PWD = await hashSecret(passwordValue);
    SEED = await hashSecret(seedValue);
  } catch (hashError) {
    console.error("Signup secret hashing failed:", hashError);
    return res.status(400).send({ msg: "invalid credentials" });
  }

  // Keep stored values within the existing database column limits.
  if (
    Email.length > 50 ||
    Birth.length > 20 ||
    Address.length > 50 ||
    Name.length > 50 ||
    CNI.length > 255 ||
    PWD.length > 255
  ) {
    return res.status(400).send({ msg: "invalid input" });
  }

  // The username column allows 30 characters, including the hyphen and six-character suffix.
  const prefix = getUserPrefixName(Name).slice(0, 23);
  if (!prefix) return res.status(400).send({ msg: "invalid name" });

  const [date, time] = getDate();
  let U;

  try {
    while (true) {
      const suffix = createUserSuffixName();
      U = `${prefix}-${suffix}`.toUpperCase();

      const collisions = await db.queryAsync(
        `SELECT 1 AS collision FROM auths WHERE username=?
         UNION ALL
         SELECT 1 AS collision FROM users_usdt_deposit_wallets WHERE username=?
         UNION ALL
         SELECT 1 AS collision FROM activities WHERE sender=? OR receiver=?
         LIMIT 1`,
        [U, U, U, U],
      );
      if (collisions.length) continue;

      let conn;
      try {
        conn = await new Promise((resolve, reject) => {
          db.getConnection((error, connection) => {
            if (error) return reject(error);
            resolve(connection);
          });
        });

        const connection = conn.promise();
        await connection.beginTransaction();
        await connection.query(
          "INSERT INTO auths(username,password,name,email,birthdate,cni,address,seed,status,record_date,record_time) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
          [U, PWD, Name, Email, Birth, CNI, Address, SEED, 0, date, time],
        );
        await connection.query(
          "INSERT INTO users_stock(username,balance,init_asset,record_date,record_time) VALUES(?,?,?,?,?)",
          [U, "0", "0", date, time],
        );
        await connection.commit();
      } catch (insertError) {
        if (conn) {
          try {
            await conn.promise().rollback();
          } catch (rollbackError) {
            console.error("Signup transaction rollback failed:", rollbackError);
          }
        }

        if (insertError.code === "ER_DUP_ENTRY") continue;
        throw insertError;
      } finally {
        if (conn) conn.release();
      }

      break;
    }

    res.send({ msg: "ok" });

    // Send the welcome email after the account is committed.
    transporter.sendMail({
      from: SERVER_MAIL,
      to: Email,
      subject: "New member",
      text: `Welcome to OneX.\nYour username: ${U}`,
    }).catch((mailError) => {
      console.error("Welcome email failed:", mailError);
    });

    // Send the identity documents for verification without modifying their encoded contents.
    transporter.sendMail({
      from: SERVER_MAIL,
      to: "eddy.heriniaina.rafidison@gmail.com",
      subject: "Account Verification",
      text: [U, Name, Birth, Address, cni].join("\n"),
      attachments: [
        { filename: "cni_1.png", content: cniimg1, encoding: "base64" },
        { filename: "cni_2.png", content: cniimg2, encoding: "base64" },
      ],
    }).catch((mailError) => {
      console.error("Identity verification email failed:", mailError);
    });
  } catch (e) {
    console.error("Signup failed:", e);
    if (!res.headersSent) res.send({ msg: "failed" });
  }
});

// signin
router.post("/app/signin", async (req, res) => {
  const { user, pswd, tkn, recon, seed } = req.body || {};
  const U = normalizeUsername(user);
  const P = normalizeFormValue(pswd);
  const submittedSeed = normalizeFormValue(seed);
  const needsSeed = String(recon) === "0";

  if (!U || !P) return res.status(400).send({ msg: "invalid request", ua: "", tg_botLink: null });
  if (needsSeed && !requestTokenIsValid(req, tkn, P, U)) {
    return res.send({ msg: "forbidden request", ua: "", tg_botLink: null });
  }

  const ua = req.headers["user-agent"];
  if (typeof ua !== "string") {
    return res.send({ msg: "error", ua: "", tg_botLink: null });
  }

  try {
    const result = await withTransaction(async (tx) => {
      const [rows] = await tx.query(
        `SELECT id,password,seed,status,consec_failed_auth,password_temp_expires_at_ms,tg_userId,tg_chat_id
         FROM auths WHERE username=? LIMIT 1 FOR UPDATE`,
        [U],
      );
      if (!rows.length) {
        return { response: { msg: "incorrect password", ua: "", tg_botLink: null } };
      }

      const row = rows[0];
      const authDecision = evaluatePasswordAuthentication({
        failedCount: Number(row.consec_failed_auth || 0),
        temporaryPasswordExpiresAtMs: row.password_temp_expires_at_ms,
        passwordMatches: await verifySecret(row.password, P),
        nowMs: Date.now(),
      });

      if (!authDecision.allowed) {
        let currentFailureCount = Number(row.consec_failed_auth || 0);
        if (authDecision.incrementFailureCount) {
          currentFailureCount = nextFailedAuthCount(currentFailureCount);
          await tx.query(
            "UPDATE auths SET consec_failed_auth=? WHERE username=?",
            [currentFailureCount, U],
          );
        }
        const locked = authDecision.recoveryRequired || currentFailureCount >= 3;
        return {
          response: {
            msg: locked ? "account recovery required" : "incorrect password",
            ua: "",
            tg_botLink: null,
            recovery_required: locked,
          },
        };
      }

      if (needsSeed && !(await verifySecret(row.seed, submittedSeed))) {
        return { response: { msg: "incorrect seed", ua: "", tg_botLink: null } };
      }

      const isTemporaryPassword = authDecision.passwordChangeRequired;
      if (authDecision.resetFailedAuthCount) {
        await tx.query(
          "UPDATE auths SET consec_failed_auth=0 WHERE username=?",
          [U],
        );
      }

      let status = Number(row.status);
      if (status === 0) {
        await tx.query("UPDATE auths SET status=1 WHERE username=?", [U]);
        if (Number(row.id) <= Number(first_welcome_clients)) {
          const configuredBonus = new BigNumber(welcome_bonus);
          const maximumStock = new BigNumber(maxStockDefault);
          if (
            !configuredBonus.isFinite() || configuredBonus.isNegative() ||
            !maximumStock.isFinite() || maximumStock.isNegative()
          ) {
            throw new Error("Invalid welcome bonus or maximum stock configuration");
          }

          const [stockRows] = await tx.query(
            "SELECT balance,init_asset FROM users_stock WHERE username=? LIMIT 1 FOR UPDATE",
            [U],
          );
          if (!stockRows.length) throw new Error("User stock row is missing during activation");
          const currentBalance = new BigNumber(stockRows[0].balance);
          const currentInitAsset = new BigNumber(stockRows[0].init_asset);
          if (
            !currentBalance.isFinite() || currentBalance.isNegative() ||
            !currentInitAsset.isFinite() || currentInitAsset.isNegative()
          ) throw new Error("Invalid stock values during welcome bonus activation");

          const availableCapacity = BigNumber.maximum(new BigNumber(0), maximumStock.minus(currentBalance));
          const welcomeBonusAmount = BigNumber.minimum(configuredBonus, availableCapacity);
          if (welcomeBonusAmount.isGreaterThan(0)) {
            const newBalance = currentBalance.plus(welcomeBonusAmount);
            const newInitAsset = currentInitAsset.plus(welcomeBonusAmount);
            const [d, t] = getDate();
            const reference = createFinancialReference(`BONUS${U}`);
            await tx.query(
              "UPDATE users_stock SET balance=?,init_asset=?,record_date=?,record_time=? WHERE username=?",
              [newBalance.toFixed(), newInitAsset.toFixed(), d, t, U],
            );
            await tx.query(
              "INSERT INTO activities(sender,receiver,type,amount,unit_price,fees,reference,record_date,record_time) VALUES(?,?,?,?,?,?,?,?,?)",
              ["XBONUS", U, 2, welcomeBonusAmount.toFixed(), 1, 0, reference, d, t],
            );
          }
        }
        status = 1;
      }

      const encUA = encrypt(ua, P + U);
      const tgBotLink = await createTelegramBotLinkTx(tx, U, row);
      return {
        response: {
          msg: status,
          ua: encUA,
          tg_botLink: tgBotLink,
          password_change_required: isTemporaryPassword,
        },
      };
    });

    return res.send(result.response);
  } catch (error) {
    console.error("Sign-in failed:", error);
    return res.send({ msg: "error", ua: "", tg_botLink: null });
  }
});

// user-last-stock
router.post("/app/user-last-stock", async (req, res) => {
  const { user, pswd, tkn } = req.body || {};
  const U = normalizeUsername(user);
  const P = normalizeFormValue(pswd);
  if (!requestTokenIsValid(req, tkn, P, U))
    return res.send({ msg: "forbidden request" });

  try {
    const passwordState = await getUserActivityPasswordState(U, P);
    if (passwordState === "not_allowed") return res.send({ auth: "not allowed" });
    if (passwordState !== "ok") return res.send({ msg: "error" });

    const stockRows = await db.queryAsync(
      "SELECT balance FROM users_stock WHERE username=? LIMIT 1",
      [U],
    );
    if (stockRows.length === 0) {
      return res.send({ msg: "error" });
    }

    // users_stock.balance is stored directly in One-Val units.
    const balance = new BigNumber(stockRows[0].balance);
    if (!balance.isFinite() || balance.isNegative()) {
      throw new Error("Invalid user stock balance");
    }

    const numericBalance = balance.toNumber();
    if (!Number.isFinite(numericBalance)) {
      throw new Error("User stock balance is outside the supported numeric range");
    }

    const depositAddress = await getOrCreateUserDepositAddress(db, U);
    res.send({
      msg: numericBalance,
      fees: tfees,
      deposit_addr: depositAddress,
    });
  } catch {
    res.send({ msg: "error" });
  }
});

// BEP-20 recharge information. Payment sessions are opened automatically after a finalized transfer is detected.
router.post("/app/recharge", async (req, res) => {
  const { user, pswd, tkn } = req.body || {};
  const U = normalizeUsername(user);
  const P = normalizeFormValue(pswd);
  if (!requestTokenIsValid(req, tkn, P, U)) return res.send({ msg: "not allowed" });
  try {
    const passwordState = await getUserActivityPasswordState(U, P);
    if (passwordState === "not_allowed") return res.send({ auth: "not allowed" });
    if (passwordState !== "ok") return res.send({ msg: "not allowed" });
    const config = getPaymentPublicConfig();
    if (!config.enabled) return res.send({ msg: "not allowed" });
    const depositAddress = await getOrCreateUserDepositAddress(db, U);
    if (!depositAddress) return res.send({ msg: "not allowed" });
    return res.send({
      msg: "ok",
      deposit_addr: depositAddress,
      network: config.network,
      chain_id: config.chainId,
      token: config.tokenName,
      token_contract: config.tokenContract,
      minimum_amount: MIN_RECHARGE_AMOUNT.toFixed(0),
      maximum_amount: MAX_RECHARGE_AMOUNT.toFixed(0),
      batch_window_minutes: 60,
      automatic_detection: true,
    });
  } catch (error) {
    console.error("BEP-20 recharge information failed:", error.message);
    return res.send({ msg: "not allowed" });
  }
});

router.post("/app/recharge/status", async (req, res) => {
  const { user, pswd, batch_id, tkn } = req.body || {};
  const U = normalizeUsername(user);
  const P = normalizeFormValue(pswd);
  if (!requestTokenIsValid(req, tkn, P, U)) return res.send({ transf: "forbidden request" });
  const id = String(batch_id ?? "").trim();
  if (id && !/^\d{1,20}$/.test(id)) return res.status(400).send({ transf: "invalid request" });
  try {
    const passwordState = await getUserActivityPasswordState(U, P);
    if (passwordState === "not_allowed") return res.send({ auth: "not allowed" });
    if (passwordState !== "ok") return res.send({ auth: "incorrect" });
    const rows = id
      ? await db.queryAsync(
          `SELECT id,status,total_amount,opened_at_ms,expires_at_ms,release_at_ms,reason_codes,credited_at_ms
           FROM users_usdt_deposit_batches WHERE id=? AND username=? LIMIT 1`, [id, U],
        )
      : await db.queryAsync(
          `SELECT id,status,total_amount,opened_at_ms,expires_at_ms,release_at_ms,reason_codes,credited_at_ms
           FROM users_usdt_deposit_batches WHERE username=? ORDER BY id DESC LIMIT 1`, [U],
        );
    if (!rows.length) return res.send({ transf: "not_found" });
    const row = rows[0];
    let reasons = [];
    try { reasons = JSON.parse(row.reason_codes || "[]"); } catch { reasons = []; }
    return res.send({
      transf: row.status,
      batch_id: String(row.id),
      amount: String(row.total_amount),
      opened_at_ms: Number(row.opened_at_ms),
      expires_at_ms: Number(row.expires_at_ms),
      release_at_ms: row.release_at_ms == null ? null : Number(row.release_at_ms),
      reason_codes: reasons,
      credited_at_ms: row.credited_at_ms == null ? null : Number(row.credited_at_ms),
    });
  } catch (error) {
    console.error("Recharge batch status lookup failed:", error.message);
    return res.send({ transf: "error" });
  }
});

// Users declare their BSC payout address themselves. OneX does not claim to verify address ownership.
router.post("/app/set-payout-address", async (req, res) => {
  const { user, pswd, address, tkn } = req.body || {};
  const U = normalizeUsername(user);
  const P = normalizeFormValue(pswd);
  if (!requestTokenIsValid(req, tkn, P, U)) return res.send({ auth: "forbidden request" });
  if (!isEvmAddress(address) || /^0x0{40}$/i.test(String(address))) {
    return res.send({ auth: "invalid address" });
  }
  try {
    const passwordState = await getUserActivityPasswordState(U, P);
    if (passwordState === "not_allowed") return res.send({ auth: "not allowed" });
    if (passwordState !== "ok") return res.send({ auth: "incorrect" });
    const depositAddress = await getOrCreateUserDepositAddress(db, U);
    if (!depositAddress) return res.send({ auth: "error" });
    const payoutAddress = checksumEvmAddress(address);
    if (
      payoutAddress.toLowerCase() === depositAddress.toLowerCase() ||
      payoutAddress.toLowerCase() === String(process.env.USDT_BEP20_TREASURY_ADDRESS || "").toLowerCase()
    ) return res.send({ auth: "invalid address" });
    const depositCollision = await db.queryAsync(
      "SELECT id FROM users_usdt_deposit_wallets WHERE wallet_address=? LIMIT 1",
      [payoutAddress],
    );
    if (depositCollision.length) return res.send({ auth: "invalid address" });
    const result = await withTransaction(async (tx) => {
      const [authRows] = await tx.query(
        "SELECT username,consec_failed_auth,password_temp_expires_at_ms FROM auths WHERE username=? FOR UPDATE",
        [U],
      );
      if (!authRows.length) return { auth: "error" };
      if (isPasswordProtectedActivityLocked({
        failedCount: Number(authRows[0].consec_failed_auth || 0),
        temporaryPasswordExpiresAtMs: authRows[0].password_temp_expires_at_ms,
      })) return { auth: "not allowed" };
      const [pendingRows] = await tx.query(
        `SELECT id FROM users_usdt_disbursements
         WHERE username=? AND status IN ('queued','signed','submitted','manual_review') LIMIT 1 FOR UPDATE`, [U],
      );
      if (pendingRows.length) return { auth: "disbursement pending" };
      await tx.query(
        "UPDATE users_usdt_deposit_wallets SET payout_address=? WHERE username=? AND account_status='active'",
        [payoutAddress, U],
      );
      return { auth: "updated", payout_address: payoutAddress };
    });
    return res.send(result);
  } catch (error) {
    console.error("Payout-address update failed:", error.message);
    return res.send({ auth: "error" });
  }
});

// transactions-history
router.post("/app/transactions-history", async (req, res) => {
  const { user, pswd, days, tkn } = req.body || {};
  const U = normalizeUsername(user);
  const P = normalizeFormValue(pswd);
  if (!requestTokenIsValid(req, tkn, P, U))
    return res.send({ trans: "forbidden request" });

  try {
    const passwordState = await getUserActivityPasswordState(U, P);
    if (passwordState === "not_allowed") return res.send({ auth: "not allowed" });
    if (passwordState !== "ok") return res.send({ trans: "error" });

    const before = getDateBefore(Number(days))[0];
    const trans = await db.queryAsync(
      "SELECT * FROM activities WHERE record_date>=? AND (sender=? OR receiver=?) ORDER BY id DESC",
      [before, U, U],
    );
    res.send({ trans });
  } catch {
    res.send({ trans: "error" });
  }
});

// near-transfer
router.post("/app/near-transfer", async (req, res) => {
  const { sender, pswd, dest, amount, tkn } = req.body || {};
  const senderInput = normalizeUsername(sender);
  const P = normalizeFormValue(pswd);
  const destinationInput = normalizeUsername(dest);
  const amountText =
    typeof amount === "string" || typeof amount === "number"
      ? String(amount).trim()
      : "";

  if (!requestTokenIsValid(req, tkn, P, senderInput)) {
    return res.send({ transf: "forbidden request" });
  }

  const S = senderInput.toUpperCase();
  const D = destinationInput.toUpperCase();
  if (!S || !P || !D || !amountText || S === D) {
    return res.status(400).send({ transf: "invalid request" });
  }
  if (S === OneX) {
    return res.send({ transf: "failed" });
  }

  const requestedAmount = new BigNumber(amountText);
  if (!requestedAmount.isFinite() || !requestedAmount.isGreaterThan(0)) {
    return res.send({ warning: "abusive operation" });
  }

  try {
    const senderAuthRows = await db.queryAsync(
      "SELECT password,consec_failed_auth,password_temp_expires_at_ms FROM auths WHERE username=? LIMIT 1",
      [S],
    );
    if (senderAuthRows.length === 0) return res.send({ transf: "failed" });
    if (
      Number(senderAuthRows[0].consec_failed_auth || 0) >= 3 ||
      senderAuthRows[0].password_temp_expires_at_ms != null
    ) return res.send({ auth: "not allowed" });
    if (!(await verifySecret(senderAuthRows[0].password, P))) {
      return res.send({ transf: "failed" });
    }
    const verifiedPasswordHash = senderAuthRows[0].password;

    if (!Number.isFinite(tfees) || tfees < 0 || tfees >= 100) {
      throw new Error("Invalid transfer-fee configuration");
    }

    // Selling to the system is a distinct disbursement operation. The amount
    // supplied by the app is the expected BSC-USD payout after the seller-paid fee.
    if (D === OneX) {
      const result = await withTransaction((tx) =>
        queueSystemDisbursement(tx, S, verifiedPasswordHash, requestedAmount),
      );
      if (result?.transf && result.transf !== "processing" && result.auth !== "not allowed") {
        await queueUserTransactionStatus(S, "disbursement", "failed", [
          `Your sale-to-OneX request was not accepted: ${String(result.transf).slice(0, 160)}.`,
        ]);
      }
      return res.send(result);
    }

    // P2P_ALLOWED controls user-to-user transfers only. Selling to the system
    // is governed independently by USDT_DISBURSEMENTS_ENABLED.
    if (!P2Pallowed) {
      await queueUserTransactionStatus(S, "p2p", "failed", ["Your P2P transfer could not be completed because P2P transfers are currently unavailable."]);
      return res.send({ transf: "not yet allowed" });
    }

    // The legacy P2P minimum applies only to transfers between users.
    if (requestedAmount.isLessThan(10000)) {
      await queueUserTransactionStatus(S, "p2p", "failed", ["Your P2P transfer could not be completed because the requested amount is below the minimum."]);
      return res.send({ warning: "abusive operation" });
    }

    const result = await withTransaction(async (tx) => {
      const authNames = [S, D].sort();
      const authByName = new Map();
      for (const username of authNames) {
        const [rows] = await tx.query(
          "SELECT username,status,password,consec_failed_auth,password_temp_expires_at_ms FROM auths WHERE username=? FOR UPDATE",
          [username],
        );
        if (rows.length > 0) authByName.set(username, rows[0]);
      }

      const senderAuth = authByName.get(S);
      const destinationAuth = authByName.get(D);
      if (senderAuth && (
        Number(senderAuth.consec_failed_auth || 0) >= 3 ||
        senderAuth.password_temp_expires_at_ms != null
      )) return { auth: "not allowed" };
      if (
        !senderAuth ||
        Number(senderAuth.status) <= 0 ||
        senderAuth.password !== verifiedPasswordHash ||
        !destinationAuth ||
        Number(destinationAuth.status) <= 0
      ) {
        return { transf: "failed" };
      }

      const [pendingDisbursements] = await tx.query(
        `SELECT id,username FROM users_usdt_disbursements
         WHERE username IN (?,?)
           AND status IN ('queued','signed','submitted','manual_review')
         LIMIT 1 FOR UPDATE`,
        [S, D],
      );
      if (pendingDisbursements.length > 0) {
        return { transf: "disbursement pending" };
      }

      const stockNames = [...new Set([S, D])].sort();
      const stockByName = new Map();
      for (const username of stockNames) {
        const [rows] = await tx.query(
          "SELECT username,balance,init_asset FROM users_stock WHERE username=? FOR UPDATE",
          [username],
        );
        if (rows.length > 0) stockByName.set(rows[0].username, rows[0]);
      }
      if (!stockByName.has(S) || !stockByName.has(D)) {
        return { transf: "failed" };
      }

      const [commonLockRows] = await tx.query(
        "SELECT lock_name FROM system_locks WHERE lock_name=? FOR UPDATE",
        ["common_state"],
      );
      if (commonLockRows.length === 0) {
        throw new Error("The common-state lock row has not been initialized");
      }

      const [commonRows] = await tx.query(
        `SELECT total_units_price,backed_units,inactive_init_asset
         FROM common ORDER BY id DESC LIMIT 1 FOR UPDATE`,
      );
      if (commonRows.length === 0) {
        throw new Error("The common reserve has not been initialized");
      }

      const common = commonRows[0];
      const senderStock = stockByName.get(S);
      const destinationStock = stockByName.get(D);
      const senderBalance = new BigNumber(senderStock.balance);
      const senderInitAsset = new BigNumber(senderStock.init_asset);
      const destinationBalance = new BigNumber(destinationStock.balance);
      const destinationInitAsset = new BigNumber(destinationStock.init_asset);
      const priceValue = deriveUnitPrice(senderBalance, senderInitAsset);
      const lastTotal = new BigNumber(common.total_units_price);
      const backedUnits = new BigNumber(common.backed_units);
      const inactiveInitAsset = new BigNumber(common.inactive_init_asset);

      if (
        !priceValue.isFinite() ||
        !priceValue.isGreaterThan(0) ||
        !lastTotal.isFinite() ||
        !lastTotal.isGreaterThan(0) ||
        !backedUnits.isFinite() ||
        backedUnits.isNegative() ||
        !inactiveInitAsset.isFinite() ||
        inactiveInitAsset.isNegative() ||
        !senderBalance.isFinite() ||
        !senderInitAsset.isFinite() ||
        senderInitAsset.isNegative() ||
        !destinationBalance.isFinite() ||
        destinationBalance.isNegative() ||
        !destinationInitAsset.isFinite() ||
        destinationInitAsset.isNegative()
      ) {
        throw new Error("Invalid balances or reserve values in the database");
      }

      // A recipient must have a consistent balance/basis pair. A positive
      // balance without an initial-asset basis cannot be safely re-based using
      // the sender's price, and a zero balance must not retain a stale basis.
      if (destinationBalance.isZero() !== destinationInitAsset.isZero()) {
        throw new Error("Recipient balance and init_asset are inconsistent");
      }

      // P2P input amounts are One-Val; receiverAmountUnits and activity.amount use initial-asset units.
      const amountUnits = requestedAmount.dividedBy(priceValue);
      const fees = amountUnits.multipliedBy(tfees).dividedBy(100);
      const senderFee = fees.dividedBy(2);
      const receiverFee = fees.dividedBy(2);
      const totalDebit = amountUnits.plus(senderFee);
      const receiverAmountUnits = amountUnits.minus(receiverFee);
      const sharedFees = fees.multipliedBy(3).dividedBy(4);
      const adminFees = fees.minus(sharedFees);

      const senderStockDebit = totalDebit.multipliedBy(priceValue);
      const receiverStockCredit = receiverAmountUnits.multipliedBy(priceValue);
      const futureSenderBalance = senderBalance.minus(senderStockDebit);
      const futureDestinationBalance = destinationBalance.plus(receiverStockCredit);

      if (
        !fees.isFinite() ||
        fees.isNegative() ||
        !senderStockDebit.isFinite() ||
        !receiverStockCredit.isFinite() ||
        !futureSenderBalance.isFinite() ||
        !futureDestinationBalance.isFinite()
      ) {
        throw new Error("Invalid calculated transfer amounts");
      }
      if (!receiverAmountUnits.isFinite() || !receiverAmountUnits.isGreaterThan(0)) {
        return { transf: "unsupported" };
      }
      if (senderBalance.isLessThan(senderStockDebit)) {
        return { transf: "insufficient balance" };
      }

      const maximumStock = new BigNumber(maxStockDefault);
      if (!maximumStock.isFinite() || maximumStock.isNegative()) {
        throw new Error("Invalid destination stock limit configuration");
      }
      if (futureDestinationBalance.isGreaterThan(maximumStock)) {
        return { transf: "unsupported" };
      }

      const inactiveFees = adminFees;
      const newTotal = lastTotal.plus(sharedFees.multipliedBy(priceValue));
      const newPrice = newTotal.dividedBy(lastTotal).multipliedBy(priceValue);
      const newBackedUnits = backedUnits.plus(sharedFees);
      const newInactiveAssets = inactiveInitAsset.plus(inactiveFees);
      const [date, time] = getDate();
      const reference = createFinancialReference(`P2P${S}`);

      const senderInitAssetAfter = deriveInitAsset(futureSenderBalance, priceValue);
      // Preserve the recipient's historical basis and add only the net
      // initial-asset amount transferred at the sender's transaction price.
      const destinationInitAssetAfter = addReceivedInitAsset(
        destinationInitAsset,
        receiverAmountUnits,
      );

      await tx.query(
        "INSERT INTO activities(sender,receiver,type,amount,unit_price,fees,reference,record_date,record_time) VALUES(?,?,?,?,?,?,?,?,?)",
        [
          S,
          D,
          1,
          receiverAmountUnits.toFixed(),
          priceValue.toFixed(),
          fees.toFixed(),
          reference,
          date,
          time,
        ],
      );
      await tx.query(
        "UPDATE users_stock SET balance=?,init_asset=?,record_date=?,record_time=? WHERE username=?",
        [futureSenderBalance.toFixed(), senderInitAssetAfter.toFixed(), date, time, S],
      );
      await tx.query(
        "UPDATE users_stock SET balance=?,init_asset=?,record_date=?,record_time=? WHERE username=?",
        [futureDestinationBalance.toFixed(), destinationInitAssetAfter.toFixed(), date, time, D],
      );
      await tx.query(
        `INSERT INTO common(total_units_price,unit_price,backed_units,inactive_init_asset,record_date,record_time)
         VALUES(?,?,?,?,?,?)`,
        [newTotal.toFixed(), newPrice.toFixed(), newBackedUnits.toFixed(), newInactiveAssets.toFixed(), date, time],
      );

      await queueTelegramMessageTx(
        tx,
        S,
        `p2p:${reference}:sender`,
        [
          "OneX Transaction Update",
          "Your P2P transfer was completed successfully.",
          `Recipient: ${D}`,
          `Amount debited: ${senderStockDebit.toFixed(8)} One-Val`,
          `Reference: ${reference}`,
          "Status: SUCCESS",
        ].join("\n"),
      );
      await queueTelegramMessageTx(
        tx,
        D,
        `p2p:${reference}:receiver`,
        [
          "OneX Transaction Update",
          "You have received a P2P transfer.",
          `Sender: ${S}`,
          `Amount received: ${receiverStockCredit.toFixed(8)} One-Val`,
          `Reference: ${reference}`,
          "Status: SUCCESS",
        ].join("\n"),
      );

      return { transf: "sent" };
    });

    if (result?.transf && result.transf !== "sent" && result.auth !== "not allowed") {
      await queueUserTransactionStatus(S, "p2p", "failed", [
        `Your P2P transfer could not be completed: ${String(result.transf).slice(0, 160)}.`,
      ]);
    }
    return res.send(result);
  } catch (error) {
    console.error("Near-transfer failed:", error);
    await queueUserTransactionStatus(S, "p2p", "failed", ["Your P2P transfer could not be completed because of a server or database error. Please contact OneX support if your balance appears inconsistent."]);
    return res.send({ transf: "failed" });
  }
});

// Disbursement status
router.post("/app/disbursement/status", async (req, res) => {
  const { user, pswd, disbursement_id, tkn } = req.body || {};
  const userInput = normalizeUsername(user);
  const U = userInput.toUpperCase();
  const P = normalizeFormValue(pswd);
  const id = String(disbursement_id ?? "");

  if (!requestTokenIsValid(req, tkn, P, userInput)) {
    return res.send({ transf: "forbidden request" });
  }
  if (!/^\d{1,20}$/.test(id)) {
    return res.status(400).send({ transf: "invalid request" });
  }

  try {
    const passwordState = await getUserActivityPasswordState(U, P);
    if (passwordState === "not_allowed") return res.send({ auth: "not allowed" });
    if (passwordState !== "ok") return res.send({ transf: "failed" });
    const rows = await db.queryAsync(
      `SELECT id,payout_address,payout_amount,status,tx_hash,last_error,created_at_ms,confirmed_at_ms
       FROM users_usdt_disbursements WHERE id=? AND username=? LIMIT 1`,
      [id, U],
    );
    if (rows.length === 0) return res.send({ transf: "not found" });

    const row = rows[0];
    return res.send({
      transf: row.status,
      disbursement_id: String(row.id),
      payout_address: row.payout_address,
      payout_amount: String(row.payout_amount),
      tx_hash: row.tx_hash,
      message: row.last_error || undefined,
      created_at_ms: Number(row.created_at_ms),
      confirmed_at_ms: row.confirmed_at_ms ? Number(row.confirmed_at_ms) : null,
    });
  } catch (error) {
    console.error("Disbursement status lookup failed:", error);
    return res.send({ transf: "error" });
  }
});

// Exceptional administrative credit of a support-held recharge batch.
// Normal weekly cooldown, 300 One-Val stock cap and common reserve checks remain enforced.
// Only the 70-140 BSC-USD per-batch range is bypassed after an administrator decision.
router.post("/admin/recharge/credit", async (req, res) => {
  const { pswd, pin, username, batch_id, reason } = req.body || {};
  if (
    pswd !== decrypt(admin_pswd, DB_CONFIG.password) ||
    pin !== decrypt(admin_pin, DB_CONFIG.password)
  ) return res.send({ transf: "incorrect admin credentials" });

  const U = normalizeUsername(username);
  const batchId = String(batch_id ?? "").trim();
  const resolutionReason = typeof reason === "string" ? reason.trim() : "";
  if (!U || !/^\d{1,20}$/.test(batchId) || resolutionReason.length < 5 || resolutionReason.length > 1000) {
    return res.status(400).send({ transf: "invalid request" });
  }

  try {
    const result = await withTransaction(async (tx) => {
      const [batchRows] = await tx.query(
        `SELECT id,username,total_amount,status FROM users_usdt_deposit_batches
         WHERE id=? AND username=? LIMIT 1 FOR UPDATE`,
        [batchId, U],
      );
      if (!batchRows.length || batchRows[0].status !== "pending_support") {
        return { transf: "batch not available for manual credit" };
      }

      const [resolutionRows] = await tx.query(
        `SELECT id FROM admin_payment_resolutions
         WHERE batch_id=? AND action IN ('manual_credit','partial_credit_refund','refund_queued','refund_confirmed','refund_manual_review')
         LIMIT 1 FOR UPDATE`,
        [batchId],
      );
      if (resolutionRows.length) return { transf: "batch already has an administrative resolution" };
      const [refundRows] = await tx.query(
        `SELECT id FROM users_usdt_refunds
         WHERE batch_id=? AND status IN ('queued','signed','submitted','confirmed','manual_review')
         LIMIT 1 FOR UPDATE`,
        [batchId],
      );
      if (refundRows.length) return { transf: "refund operation is unresolved" };

      const amount = new BigNumber(batchRows[0].total_amount);
      if (!amount.isFinite() || !amount.isGreaterThan(0)) {
        return { transf: "invalid batch amount" };
      }
      const now = Date.now();
      const [date, time] = formatUtcRecordDateTime(now);
      const reference = createFinancialReference(`ADMCREDIT${U}`);
      const creditResult = await applyUserTopUp(
        tx,
        U,
        amount,
        reference,
        date,
        time,
        now,
        { enforceRechargeRange: false },
      );
      if (creditResult?.transf !== "sent") {
        return {
          transf: "manual credit not completed",
          reason: creditResult?.error || creditResult?.limit || "accounting validation failed",
        };
      }

      await tx.query(
        `UPDATE users_usdt_deposit_batches
         SET status='credited',reason_codes=NULL,credited_at_ms=?,updated_at_ms=?
         WHERE id=? AND status='pending_support'`,
        [String(now), String(now), batchId],
      );
      await tx.query(
        "UPDATE users_usdt_transfer_events SET status='credited',reason_codes=NULL WHERE batch_id=?",
        [batchId],
      );
      await tx.query(
        `INSERT INTO admin_payment_resolutions
         (admin_username,username,batch_id,action,gross_amount,fee_amount,net_amount,payout_address,tx_hash,reason,created_at_ms)
         VALUES('configured_admin',?,?,'manual_credit',?,'0',?,NULL,NULL,?,?)`,
        [U, batchId, amount.toFixed(18), amount.toFixed(18), resolutionReason, String(now)],
      );
      return {
        transf: "credited",
        batch_id: batchId,
        amount: amount.toFixed(18),
        reference,
      };
    });
    return res.send(result);
  } catch (error) {
    console.error("Administrative recharge credit failed:", error.message);
    return res.send({ transf: "error" });
  }
});

// Administrative refund of a recharge batch held for support.
// The refund is queued for the isolated treasury worker; gas is paid separately in BNB.
router.post("/admin/recharge/refund", async (req, res) => {
  const { pswd, pin, username, batch_id, reason } = req.body || {};
  if (
    pswd !== decrypt(admin_pswd, DB_CONFIG.password) ||
    pin !== decrypt(admin_pin, DB_CONFIG.password)
  ) return res.send({ transf: "incorrect admin credentials" });

  const U = normalizeUsername(username);
  const batchId = String(batch_id ?? "").trim();
  const resolutionReason = typeof reason === "string" ? reason.trim() : "";
  if (!U || !/^\d{1,20}$/.test(batchId) || resolutionReason.length < 5 || resolutionReason.length > 1000) {
    return res.status(400).send({ transf: "invalid request" });
  }

  try {
    if (String(process.env.USDT_DISBURSEMENTS_ENABLED || "false").toLowerCase() !== "true") {
      return res.send({ transf: "treasury payout service disabled" });
    }
    const snapshotRows = await db.queryAsync(
      `SELECT b.id,b.username,b.total_amount,b.status,w.payout_address
       FROM users_usdt_deposit_batches b
       JOIN users_usdt_deposit_wallets w ON w.id=b.deposit_wallet_id
       WHERE b.id=? AND b.username=? LIMIT 1`,
      [batchId, U],
    );
    if (!snapshotRows.length) return res.send({ transf: "not found" });
    const snapshot = snapshotRows[0];
    if (snapshot.status !== "pending_support") return res.send({ transf: "batch not refundable" });
    if (!isEvmAddress(snapshot.payout_address) || /^0x0{40}$/i.test(snapshot.payout_address)) {
      return res.send({ transf: "payout wallet not registered" });
    }

    const amount = new BigNumber(snapshot.total_amount);
    if (!amount.isFinite() || amount.isLessThan(10)) {
      return res.send({ transf: "minimum refund is 10 BSC-USD" });
    }
    const amountRawDecimal = amount.shiftedBy(18);
    if (!amountRawDecimal.isInteger() || amountRawDecimal.isLessThanOrEqualTo(0)) {
      return res.send({ transf: "invalid refund amount" });
    }
    const amountRaw = amountRawDecimal.toFixed(0);
    const liquidity = await checkTreasuryLiquidity(amountRaw);
    if (!liquidity.available) {
      return res.send({ transf: "insufficient treasury liquidity", liquidity });
    }

    const result = await withTransaction(async (tx) => {
      const [walletRows] = await tx.query(
        "SELECT payout_address,account_status FROM users_usdt_deposit_wallets WHERE username=? LIMIT 1 FOR UPDATE",
        [U],
      );
      const [batchRows] = await tx.query(
        "SELECT id,username,total_amount,status,deposit_wallet_id FROM users_usdt_deposit_batches WHERE id=? AND username=? LIMIT 1 FOR UPDATE",
        [batchId, U],
      );
      if (!batchRows.length || batchRows[0].status !== "pending_support") return { transf: "batch not refundable" };
      if (!walletRows.length || walletRows[0].account_status !== "active" ||
          String(walletRows[0].payout_address || "").toLowerCase() !== String(snapshot.payout_address).toLowerCase()) {
        return { transf: "payout wallet changed or account unavailable" };
      }

      const [existingRows] = await tx.query(
        "SELECT id FROM users_usdt_refunds WHERE batch_id=? AND status IN ('queued','signed','submitted','confirmed','manual_review') LIMIT 1 FOR UPDATE",
        [batchId],
      );
      if (existingRows.length) return { transf: "refund already exists", refund_id: String(existingRows[0].id) };

      const reference = createFinancialReference(`REF${U}`);
      const now = String(Date.now());
      const [refundInsert] = await tx.query(
        `INSERT INTO users_usdt_refunds
         (username,batch_id,payout_address,amount,amount_raw,reference,status,created_at_ms,updated_at_ms)
         VALUES(?,?,?,?,?,?,'queued',?,?)`,
        [U, batchId, snapshot.payout_address, amount.toFixed(18), amountRaw, reference, now, now],
      );
      await tx.query(
        "UPDATE users_usdt_deposit_batches SET status='refund_queued',updated_at_ms=? WHERE id=?",
        [now, batchId],
      );
      await tx.query(
        "UPDATE users_usdt_transfer_events SET status='refund_queued' WHERE batch_id=?",
        [batchId],
      );
      await tx.query(
        `INSERT INTO admin_payment_resolutions
         (admin_username,username,batch_id,action,gross_amount,fee_amount,net_amount,payout_address,tx_hash,reason,created_at_ms)
         VALUES('configured_admin',?,?,'refund_queued',?,'0',?,?,NULL,?,?)`,
        [U, batchId, amount.toFixed(18), amount.toFixed(18), snapshot.payout_address, resolutionReason, now],
      );
      await queueTelegramMessageTx(
        tx,
        U,
        `refund:${refundInsert.insertId}:queued`,
        [
          "OneX Refund Update",
          "Your BSC-USD refund has been accepted and queued for processing.",
          `Amount: ${amount.toFixed(8)} BSC-USD`,
          `Refund ID: ${refundInsert.insertId}`,
          `Destination: ${snapshot.payout_address}`,
          "Status: PROCESSING",
        ].join("\n"),
      );
      return {
        transf: "refund_processing",
        refund_id: String(refundInsert.insertId),
        amount: amount.toFixed(18),
        payout_address: snapshot.payout_address,
      };
    });
    return res.send(result);
  } catch (error) {
    console.error("Administrative recharge refund failed:", error.message);
    return res.send({ transf: "error" });
  }
});

// Requeue an unsubmitted disbursement after its 60-minute reservation has expired.
// The worker still performs the signed BSC-USD transfer; this endpoint never signs transactions.
router.post("/admin/unlock-disbursement", async (req, res) => {
  const { pswd, pin, user, disbursement_id } = req.body || {};
  if (
    pswd !== decrypt(admin_pswd, DB_CONFIG.password) ||
    pin !== decrypt(admin_pin, DB_CONFIG.password)
  ) return res.send({ transf: "incorrect admin credentials" });

  const username = normalizeUsername(user);
  const id = String(disbursement_id ?? "").trim();
  if (!username || !/^\d{1,20}$/.test(id)) {
    return res.status(400).send({ transf: "invalid request" });
  }

  try {
    if (String(process.env.USDT_DISBURSEMENTS_ENABLED || "false").toLowerCase() !== "true") {
      return res.send({ transf: "disbursement service disabled" });
    }
    const snapshotRows = await db.queryAsync(
      `SELECT id,username,payout_amount,amount_raw,payout_address,status,raw_tx,tx_hash,reservation_expires_at_ms
       FROM users_usdt_disbursements WHERE id=? AND username=? LIMIT 1`,
      [id, username],
    );
    if (!snapshotRows.length) return res.send({ transf: "not found" });
    const snapshot = snapshotRows[0];
    if (
      snapshot.status !== "manual_review" || snapshot.raw_tx || snapshot.tx_hash ||
      Number(snapshot.reservation_expires_at_ms) > Date.now()
    ) return res.send({ transf: "not eligible for unlock" });
    if (!new BigNumber(snapshot.payout_amount).isFinite() || new BigNumber(snapshot.payout_amount).isLessThan(10)) {
      return res.send({ transf: "minimum payout is 10 BSC-USD" });
    }
    if (!isEvmAddress(snapshot.payout_address)) return res.send({ transf: "invalid payout address" });

    // The HTTP process checks balances only; the isolated worker owns the signing key.
    const liquidity = await checkTreasuryLiquidity(snapshot.amount_raw);
    if (!liquidity.available) {
      return res.send({ transf: "insufficient treasury liquidity", liquidity });
    }

    const result = await withTransaction(async (tx) => {
      const [authRows] = await tx.query(
        "SELECT status FROM auths WHERE username=? LIMIT 1 FOR UPDATE", [username],
      );
      const [stockRows] = await tx.query(
        "SELECT balance,init_asset FROM users_stock WHERE username=? LIMIT 1 FOR UPDATE", [username],
      );
      const [jobRows] = await tx.query(
        `SELECT id,status,raw_tx,tx_hash,payout_amount,amount_raw,payout_address,reservation_expires_at_ms
         FROM users_usdt_disbursements WHERE id=? AND username=? LIMIT 1 FOR UPDATE`,
        [id, username],
      );
      if (!authRows.length || Number(authRows[0].status) <= 0 || !stockRows.length || jobRows.length === 0) {
        return { transf: "account unavailable" };
      }
      const job = jobRows[0];
      if (
        job.status !== "manual_review" || job.raw_tx || job.tx_hash ||
        Number(job.reservation_expires_at_ms) > Date.now() ||
        new BigNumber(job.payout_amount).isLessThan(10)
      ) return { transf: "not eligible for unlock" };
      const balance = new BigNumber(stockRows[0].balance);
      const initAsset = new BigNumber(stockRows[0].init_asset);
      if (!balance.isZero() || !initAsset.isZero()) return { transf: "reserved balance changed" };
      const now = Date.now();
      const update = await tx.query(
        `UPDATE users_usdt_disbursements
         SET status='queued',reservation_expires_at_ms=?,updated_at_ms=?,last_error=NULL
         WHERE id=? AND status='manual_review' AND raw_tx IS NULL AND tx_hash IS NULL`,
        [String(now + DISBURSEMENT_RESERVATION_MS), String(now), id],
      );
      if (update[0].affectedRows !== 1) return { transf: "not eligible for unlock" };
      await queueTelegramMessageTx(
        tx,
        username,
        `disbursement:${id}:requeued`,
        [
          "OneX Disbursement Update",
          "Your disbursement request has been re-queued by OneX support.",
          `Disbursement ID: ${id}`,
          "Status: PROCESSING",
        ].join("\n"),
      );
      return { transf: "processing", disbursement_id: id };
    });
    return res.send(result);
  } catch (error) {
    console.error("Admin disbursement unlock failed:", error.message);
    return res.send({ transf: "error" });
  }
});

// modify-pin-or-password
router.post("/app/modify-pin-or-password", async (req, res) => {
  const { user, pswd1, pswd2, tkn } = req.body || {};
  const U = normalizeUsername(user);
  const P1 = normalizeFormValue(pswd1);
  const P2 = normalizeFormValue(pswd2);

  if (!requestTokenIsValid(req, tkn, P1, U)) {
    return res.send({ auth: "forbidden request" });
  }
  if (!P2) return res.status(400).send({ auth: "invalid password" });

  try {
    const result = await withTransaction(async (tx) => {
      const [rows] = await tx.query(
        `SELECT password,password_temp_expires_at_ms,consec_failed_auth
         FROM auths WHERE username=? LIMIT 1 FOR UPDATE`,
        [U],
      );
      if (!rows.length) return { auth: "incorrect" };

      const current = rows[0];
      const isRecoveryPassword = current.password_temp_expires_at_ms != null;
      const accountLocked = Number(current.consec_failed_auth || 0) >= 3;
      if (accountLocked && !isRecoveryPassword) {
        return { auth: "not allowed" };
      }
      if (isRecoveryPassword) {
        const expiresAt = Number(current.password_temp_expires_at_ms);
        if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
          return { auth: "temporary password expired" };
        }
      }
      if (!(await verifySecret(current.password, P1))) {
        return { auth: "incorrect" };
      }
      if (P2 === P1) return { auth: "new password must be different" };

      const passwordHash = await hashSecret(P2);
      if (isRecoveryPassword) {
        await tx.query(
          `UPDATE auths SET password=?,password_temp_expires_at_ms=NULL,consec_failed_auth=0
           WHERE username=?`,
          [passwordHash, U],
        );
      } else {
        await tx.query(
          "UPDATE auths SET password=?,password_temp_expires_at_ms=NULL WHERE username=?",
          [passwordHash, U],
        );
      }
      return { auth: "updated", recovery_completed: isRecoveryPassword };
    });
    res.send(result);
  } catch (error) {
    console.error("Password update failed:", error);
    res.send({ auth: "error" });
  }
});

// delete-user
router.post("/app/delete-user", async (req, res) => {
  const { user, pswd, tkn } = req.body || {};
  const U = normalizeUsername(user);
  const P = normalizeFormValue(pswd);
  if (!requestTokenIsValid(req, tkn, P, U)) return res.send({ auth: "forbidden request" });
  try {
    const passwordState = await getUserActivityPasswordState(U, P);
    if (passwordState === "not_allowed") return res.send({ auth: "not allowed" });
    if (passwordState !== "ok") return res.send({ auth: "incorrect" });
    const result = await withTransaction(async (tx) => {
      const [authRows] = await tx.query(
        "SELECT username,consec_failed_auth,password_temp_expires_at_ms FROM auths WHERE username=? FOR UPDATE",
        [U],
      );
      if (!authRows.length) return { auth: "error" };
      if (isPasswordProtectedActivityLocked({
        failedCount: Number(authRows[0].consec_failed_auth || 0),
        temporaryPasswordExpiresAtMs: authRows[0].password_temp_expires_at_ms,
      })) return { auth: "not allowed" };
      const [stockRows] = await tx.query("SELECT balance FROM users_stock WHERE username=? FOR UPDATE", [U]);
      if (!stockRows.length) return { auth: "error" };
      const stockBalance = new BigNumber(stockRows[0].balance);
      if (!stockBalance.isFinite() || stockBalance.isNegative()) throw new Error("Invalid user stock balance");
      if (stockBalance.isGreaterThan(2)) return { auth: "failed, balance > 2" };

      const [pendingDisbursements] = await tx.query(
        `SELECT id FROM users_usdt_disbursements
         WHERE username=? AND status IN ('queued','signed','submitted','manual_review') LIMIT 1 FOR UPDATE`, [U],
      );
      const [pendingBatches] = await tx.query(
        `SELECT id FROM users_usdt_deposit_batches
         WHERE username=? AND status IN ('collecting','ready','finalizing','pending_weekly','pending_reserve','pending_support','refund_queued')
         LIMIT 1 FOR UPDATE`, [U],
      );
      const [pendingEvents] = await tx.query(
        `SELECT id FROM users_usdt_transfer_events
         WHERE username=? AND status IN ('detected','batched','pending_weekly','pending_reserve','pending_support','refund_queued')
         LIMIT 1 FOR UPDATE`, [U],
      );
      const [pendingRefunds] = await tx.query(
        `SELECT id FROM users_usdt_refunds
         WHERE username=? AND status IN ('queued','signed','submitted','manual_review')
         LIMIT 1 FOR UPDATE`, [U],
      );
      if (pendingDisbursements.length) return { auth: "failed, disbursement pending" };
      if (pendingBatches.length || pendingEvents.length || pendingRefunds.length) return { auth: "failed, recharge pending" };

      // Keep the deposit address reserved forever; remove personal account data and disable payout.
      await tx.query(
        `UPDATE users_usdt_deposit_wallets
         SET account_status='deleted',payout_address=NULL WHERE username=?`, [U],
      );
      await tx.query("DELETE FROM users_stock WHERE username=?", [U]);
      await tx.query("DELETE FROM auths WHERE username=?", [U]);
      return { auth: "deleted" };
    });
    return res.send(result);
  } catch (error) {
    console.error("User deletion failed:", error.message);
    return res.send({ auth: "error" });
  }
});

// recover-account
router.post("/app/recover-account", async (req, res) => {
  const { user, seed } = req.body || {};
  const U = normalizeUsername(user);
  const S = normalizeFormValue(seed);
  if (!U || !S) return res.status(400).send({ auth: "invalid request" });

  try {
    const rows = await db.queryAsync(
      "SELECT email,seed FROM auths WHERE username=? LIMIT 1",
      [U],
    );
    if (!rows.length || !(await verifySecret(rows[0].seed, S))) {
      return res.send({ auth: "incorrect" });
    }

    const issue = await issueTemporaryPassword(
      U,
      rows[0].email,
      "OneX account recovery – temporary password",
      "If you did not request this recovery, contact OneX support immediately.",
    );
    if (!issue.ok) {
      const messages = {
        email_unavailable: "recovery email unavailable",
        account_not_found: "account not found",
        email_changed: "recovery email unavailable",
        temporary_password_active: "recovery already in progress",
      };
      return res.send({ auth: messages[issue.reason] || "error" });
    }
    return res.send({ auth: "recovery email sent", expires_in: issue.expiresInSeconds });
  } catch (error) {
    console.error("Account recovery failed:", error.message);
    return res.send({ auth: "error" });
  }
});

// modify-seed
router.post("/app/modify-seed", async (req, res) => {
  const { user, pswd, seed, tkn } = req.body || {};
  const U = normalizeUsername(user);
  const P = normalizeFormValue(pswd);
  const S = normalizeFormValue(seed);

  if (!requestTokenIsValid(req, tkn, P, U)) {
    return res.send({ auth: "forbidden request" });
  }
  if (!S) return res.status(400).send({ auth: "invalid seed" });

  try {
    const result = await withTransaction(async (tx) => {
      const [rows] = await tx.query(
        `SELECT password,consec_failed_auth,password_temp_expires_at_ms
         FROM auths WHERE username=? LIMIT 1 FOR UPDATE`,
        [U],
      );
      if (!rows.length) return { auth: "incorrect" };
      if (isPasswordProtectedActivityLocked({
        failedCount: Number(rows[0].consec_failed_auth || 0),
        temporaryPasswordExpiresAtMs: rows[0].password_temp_expires_at_ms,
      })) return { auth: "not allowed" };
      if (!(await verifySecret(rows[0].password, P))) return { auth: "incorrect" };

      const seedHash = await hashSecret(S);
      await tx.query("UPDATE auths SET seed=? WHERE username=?", [seedHash, U]);
      return { auth: "updated" };
    });
    res.send(result);
  } catch (error) {
    console.error("Seed update failed:", error);
    res.send({ auth: "not exists" });
  }
});

// ----- ADMIN POSTS -----
// send-temp-pswd
router.post("/admin/send-temp-pswd", async (req, res) => {
  const { pswd, pin, user } = req.body || {};
  if (
    pswd !== decrypt(admin_pswd, DB_CONFIG.password) ||
    pin !== decrypt(admin_pin, DB_CONFIG.password)
  ) {
    return res.send({ auth: "incorrect" });
  }

  const U = normalizeUsername(user);
  if (!U) return res.status(400).send({ auth: "invalid user" });

  try {
    const rows = await db.queryAsync(
      "SELECT email FROM auths WHERE username=? LIMIT 1",
      [U],
    );
    if (!rows.length) return res.send({ auth: "user not found" });

    const issue = await issueTemporaryPassword(
      U,
      rows[0].email,
      "OneX temporary account password",
      "This temporary password was issued by OneX support. If you did not request assistance, contact OneX support immediately.",
    );
    if (!issue.ok) {
      const messages = {
        email_unavailable: "email unavailable",
        account_not_found: "user not found",
        email_changed: "email changed; retry with the current account email",
        temporary_password_active: "temporary password already active",
      };
      return res.send({ auth: messages[issue.reason] || "error" });
    }

    return res.send({ auth: "temporary password sent", expires_in: issue.expiresInSeconds });
  } catch (error) {
    console.error("Admin temporary-password issuance failed:", error.message);
    return res.send({ auth: "error" });
  }
});

// set-user-status
router.post("/admin/set-user-status", async (req, res) => {
  const { pswd, pin, user, status } = req.body;
  if (
    pswd !== decrypt(admin_pswd, DB_CONFIG.password) ||
    pin !== decrypt(admin_pin, DB_CONFIG.password)
  )
    return res.send({ auth: "incorrect" });

  const stat = Number(status);
  if (isNaN(stat)) return res.send({ error: "invalid status" });

  try {
    await db.queryAsync("UPDATE auths SET status=? WHERE username=?", [
      stat,
      user,
    ]);
    res.send({ account: "updated" });
  } catch {
    res.send({ error: "error" });
  }
});

// update-user-or-common-stock
router.post("/admin/update-user-or-common-stock", async (req, res) => {
  const { pswd, pin, amount, user } = req.body || {};
  if (
    pswd !== decrypt(admin_pswd, DB_CONFIG.password) ||
    pin !== decrypt(admin_pin, DB_CONFIG.password)
  ) {
    return res.send({ auth: "incorrect" });
  }

  if (typeof user !== "string") {
    return res.status(400).send({ error: "invalid user" });
  }

  const amountValue = new BigNumber(String(amount ?? ""));
  if (!amountValue.isFinite() || !amountValue.isGreaterThan(0)) {
    return res.status(400).send({ error: "invalid amount" });
  }

  const [date, time] = getDate();
  const isUserTopUp = user.includes("-");
  const U = isUserTopUp ? normalizeUsername(user) : null;

  try {
    const result = await withTransaction(async (tx) => {
      if (isUserTopUp) {
        const reference = createFinancialReference(`TOP${U}`);
        return applyUserTopUp(tx, U, amountValue, reference, date, time, Date.now(), { enforceRechargeRange: false });
      }

      const [commonLockRows] = await tx.query(
        "SELECT lock_name FROM system_locks WHERE lock_name=? FOR UPDATE",
        ["common_state"],
      );
      if (commonLockRows.length === 0) {
        throw new Error("The common-state lock row has not been initialized");
      }

      const [commonRows] = await tx.query(
        "SELECT total_units_price,unit_price,backed_units,inactive_init_asset FROM common ORDER BY id DESC LIMIT 1 FOR UPDATE",
      );
      if (commonRows.length === 0) {
        throw new Error("Common reserve is not initialized");
      }

      const common = commonRows[0];
      const lastTotal = new BigNumber(common.total_units_price);
      const lastPrice = new BigNumber(common.unit_price);
      const backed = new BigNumber(common.backed_units);
      const inactiveInitAsset = new BigNumber(common.inactive_init_asset);
      if (
        !lastTotal.isFinite() ||
        !lastTotal.isGreaterThan(0) ||
        !lastPrice.isFinite() ||
        !lastPrice.isGreaterThan(0) ||
        !backed.isFinite() ||
        backed.isNegative() ||
        !inactiveInitAsset.isFinite() ||
        inactiveInitAsset.isNegative()
      ) {
        throw new Error("Invalid common reserve values");
      }

      const availableValue = backed.multipliedBy(lastPrice);
      if (amountValue.isGreaterThan(availableValue)) {
        return { limit: `BSC-USD ${availableValue.toFixed()}` };
      }

      const newTotal = lastTotal.plus(amountValue);
      const remained = backed.minus(amountValue.dividedBy(lastPrice));
      const newPrice = newTotal.dividedBy(lastTotal).multipliedBy(lastPrice);
      await tx.query(
        "INSERT INTO common(total_units_price,unit_price,backed_units,inactive_init_asset,record_date,record_time) VALUES(?,?,?,?,?,?)",
        [newTotal.toFixed(), newPrice.toFixed(), remained.toFixed(), inactiveInitAsset.toFixed(), date, time],
      );
      return { total_units_price: "updated" };
    });

    return res.send(result);
  } catch (error) {
    console.error("Admin stock update failed:", error);
    return res.send({ error: "error" });
  }
});

async function initializeRechargePayments() {
  const providerInfo = await initializePaymentProvider();
  if (providerInfo.enabled) {
    // Run consolidation in a separate process by default so the HTTP server
    // never needs the deposit-wallet extended private key in its environment.
    if (String(process.env.USDT_SWEEP_IN_MAIN_PROCESS || "false").toLowerCase() === "true") {
      startDepositSweeper(db);
    }
    startUsdtPaymentWatcher(db, processConfirmedUsdtPayment, processRechargeBatchQueue);
  }
  return providerInfo;
}

router.initializeRechargePayments = initializeRechargePayments;

module.exports = router;
