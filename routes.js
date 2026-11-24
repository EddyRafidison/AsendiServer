require("dotenv").config();

const express = require("express");
const crypto = require("crypto");
const { getAddress: checksumEvmAddress } = require("ethers");
const fs = require("fs");
const geoip = require("geoip-country");
const nodemailer = require("nodemailer");
const { createEmailQueue } = require("./email-queue");
const {
  DEVICE_CHALLENGE_TTL_MS,
  DEVICE_REQUEST_CLOCK_SKEW_MS,
  DEVICE_REQUEST_NONCE_TTL_MS,
  normalizeDeviceId,
  createDeviceChallenge,
  buildDeviceChallengeMessage,
  verifyDeviceSignature,
  createSessionToken,
  hashSessionToken,
  timingSafeHexEqual,
  hashRequestBody,
  buildDeviceRequestMessage,
} = require("./device-auth");
const BigNumber = require("bignumber.js");
const {
  xtuToInitialAsset,
  initialAssetToXtu,
  calculateGlobalUnitPrice,
  calculateDepositFundingAllocation,
  isUserBalanceWithinMaxStock,
  calculateRemainingSystemAdminReserve,
  calculateAdminCommonStockUpdate,
  calculateUnreservedDistributableInitialAssets,
  calculateTopUpReserveAllocation,
} = require("./stock-accounting");
const {
  MIN_DEPOSIT_AMOUNT,
  MAX_DEPOSIT_AMOUNT,
  MAX_INITIAL_CREDIT_TRANCHE_AMOUNT,
  MAX_DEFAULT_STOCK,
  DEPOSIT_BATCH_WINDOW_MS,
  DEPOSIT_COOLDOWN_MS,
  DISBURSEMENT_COOLDOWN_DAYS,
  getLastOnexDeposit,
  assessDepositCooldown,
  formatUtcRecordDateTime,
  getWeeklyReleaseAt,
  validateDepositAmount,
  classifyRollingDepositReceipt,
  calculateMinimumDepositCapacity,
  SYSTEM_ADMIN_RESERVE_RATIO,
} = require("./deposit-policy");
const {
  DISBURSEMENT_COOLDOWN_MS,
  DISBURSEMENT_RESERVATION_MS,
  calculateIndividualDisbursement,
  calculateGlobalDisbursement,
  validateGlobalDisbursementCapacity,
  isRequestedPayoutWithinTolerance,
  isPositivePayoutAmount,
  isIndividualDisbursementBalanceEligible,
} = require("./disbursement-policy");

const {
  db,
  OneX,
  maxStockDefault,
  P2Pallowed,
  stock_limit,
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
  getUserPrefixName,
  transliterateUserText,
  createUserSuffixName,
  hashSecret,
  verifySecret,
} = require("./utils");

const {
  initializePaymentProvider,
  startPaymentWatcher: startUsdtPaymentWatcher,
  getPaymentPublicConfig,
  getIncomingScannerStatus,
  previewIncomingScannerReconciliation,
  resolveIncomingScannerCompensation,
  commitIncomingScannerReconciliation,
  isAddress: isEvmAddress,
} = require("./pay");
const { createBscEventIdentity } = require("./bsc-reconciliation-policy");
const {
  checkTreasuryLiquidity,
  checkDisbursementLiquidity,
  checkDisbursementReserveCapacity,
} = require("./disbursement");
const { getHotWalletTreasurySnapshot } = require("./treasury-liquidity");
const { getConfiguredMaxBscTxFeeUsd } = require("./bsc-transaction-policy");
const { MINIMUM_REFUND_NET_BSC_USD } = require("./refund-policy");
getConfiguredMaxBscTxFeeUsd();
const { createTelegramBotLinkTx, queueTelegramMessageTx } = require("./telegram");
const {
  resetUserPriceBasisTx,
  triggerUserPriceThresholdTx,
  recordUserOperationTx,
  initializeUserPriceStateTx,
  getUserPriceStateTx,
  previewUserOperationCapacity,
  calculateEffectiveIndividualPrice,
} = require("./user-price-accounting");
const {
  getLatestCommonTx,
  insertCommonSnapshotTx,
} = require("./common-accounting");
const {
  SELLER_STATUS_DURATION_MS,
  validateSellerJoin,
  getActiveSellerReserveAvailableTx,
  consumeSellerReserveTx,
  closeExpiredSellerCampaignsTx,
} = require("./seller-accounting");
const {
  generateTemporaryPassword,
  TEMP_PASSWORD_TTL_MS,
  isTemporaryPasswordActive,
  isPasswordProtectedActivityLocked,
  evaluatePasswordAuthentication,
} = require("./auth-recovery");
const { normalizeTransactionHistoryDays, getTransactionHistoryCutoffMs } = require("./history-policy");
const {
  DAY_MS,
  evaluateAccountActionLimit,
  lockAccountSecurityActionTx,
  getRecentAccountSecurityEventsTx,
  recordAccountSecurityEventTx,
  consumeAccountApiRateLimit,
} = require("./security-limits");
const { validateSignupIdentity } = require("./identity-policy");
const { resolveDepositAvailability, getVisibleDepositAddress } = require("./deposit-service-control");
const { getPublicDepositAvailability } = require("./deposit-availability");
const { findMaximumDepositCredit } = require("./deposit-credit-policy");
const { markPendingDepositBatchesDueTx } = require("./deposit-retry");
const { recordRefundRequestEventTx } = require("./refund-request-audit");
const {
  GLOBAL_DISBURSEMENT_NOTICE_MS,
  resolveGlobalDisbursementRequestWindowDays,
  resolveGlobalDisbursementExtensionDays,
  resolveGlobalDisbursementPhase,
  resolveGlobalDisbursementBonus,
  calculateRequiredAdminBonusReserve,
  isGlobalDisbursementEffective,
  evaluateDisbursementMinimumXtu,
  isGlobalDisbursementPriceFrozen,
  validateGlobalAnnouncement,
  getGlobalRequestDeadline,
} = require("./global-disbursement-policy");
const CONFIGURED_GLOBAL_DISBURSEMENT_BONUS = resolveGlobalDisbursementBonus(
  tfees,
  process.env.GLOBAL_DISBURSEMENT_BONUS,
);
const GLOBAL_DISBURSEMENT_REQUEST_WINDOW_DAYS = resolveGlobalDisbursementRequestWindowDays(
  process.env.GLOBAL_DISBURSEMENT_REQUEST_WINDOW_DAYS,
);
const GLOBAL_DISBURSEMENT_EXTENSION_DAYS = resolveGlobalDisbursementExtensionDays(
  process.env.GLOBAL_DISBURSEMENT_EXTENSION_DAYS,
);
const {
  resolveWelcomeBonusBeneficiaries,
  resolveWelcomeBonusAmount,
  createWelcomeBonusSubjectHashes,
  decideWelcomeBonus,
} = require("./welcome-bonus-policy");
const WELCOME_BONUS_BENEFICIARIES = resolveWelcomeBonusBeneficiaries(
  process.env.WELCOME_BONUS_BENEFICIARIES,
);
const WELCOME_BONUS_AMOUNT_XTU = resolveWelcomeBonusAmount(
  process.env.WELCOME_BONUS_AMOUNT_XTU,
);
const WELCOME_BONUS_CLAIM_SECRET = String(
  process.env.WELCOME_BONUS_CLAIM_SECRET || DB_CONFIG.password || "",
);
const configuredDeviceSessionTtlDays = Number(process.env.DEVICE_SESSION_TTL_DAYS || 30);
if (!Number.isInteger(configuredDeviceSessionTtlDays) || configuredDeviceSessionTtlDays < 1 || configuredDeviceSessionTtlDays > 90) {
  throw new Error("DEVICE_SESSION_TTL_DAYS must be an integer between 1 and 90");
}
const DEVICE_SESSION_TTL_MS = configuredDeviceSessionTtlDays * 24 * 60 * 60 * 1000;

const router = express.Router();

async function accountApiLimitReached(res, username, action, limit, windowMs) {
  const allowed = await consumeAccountApiRateLimit(db, username, action, limit, windowMs);
  if (allowed) return false;
  res.status(429).send({ auth: "limit reached" });
  return true;
}

function parseBase64Image(value, filename, maxBytes = 3 * 1024 * 1024) {
  if (value == null || value === "") return null;
  if (typeof value !== "string") return false;

  let payload = value.trim();
  let extension = "png";
  const dataUri = payload.match(/^data:image\/(png|jpeg|jpg|webp);base64,/i);
  if (dataUri) {
    extension = dataUri[1].toLowerCase() === "jpeg" ? "jpg" : dataUri[1].toLowerCase();
    payload = payload.slice(dataUri[0].length);
  }
  if (!payload || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(payload)) {
    return false;
  }

  const decoded = Buffer.from(payload, "base64");
  if (decoded.length === 0 || decoded.length > maxBytes) return false;
  return { filename: `${filename}.${extension}`, content: payload, encoding: "base64" };
}

function normalizeFormValue(value) {
  // URL-encoded form decoding is handled by Express. Preserve the submitted
  // value exactly; spaces must never be rewritten as literal plus signs.
  return typeof value === "string" ? value : "";
}

function normalizeUsername(value) {
  const username = normalizeFormValue(value).trim().toUpperCase();
  return username.length <= 30 ? username : "";
}

function createFinancialReference(prefix = "ONEX") {
  return `${String(prefix).replace(/[^A-Za-z0-9]/g, "").slice(0, 12)}${crypto.randomBytes(16).toString("hex")}`;
}

async function requestTokenIsValid(req, token, _password, username) {
  if (
    typeof token !== "string" || token.length > 128 ||
    typeof username !== "string" || username.length === 0 || username.length > 30
  ) return false;

  const deviceId = normalizeDeviceId(req.get("x-onex-device-id"));
  const timestampText = String(req.get("x-onex-device-timestamp") || "");
  const nonce = String(req.get("x-onex-device-nonce") || "");
  const signature = String(req.get("x-onex-device-signature") || "");
  if (!deviceId || !/^\d{13}$/.test(timestampText) ||
      !/^[A-Za-z0-9_-]{22,80}$/.test(nonce) || signature.length > 512) return false;

  const timestamp = Number(timestampText);
  const now = Date.now();
  if (!Number.isSafeInteger(timestamp) || Math.abs(now - timestamp) > DEVICE_REQUEST_CLOCK_SKEW_MS) return false;

  let tokenHash;
  try {
    tokenHash = hashSessionToken(token);
  } catch {
    return false;
  }

  let message;
  try {
    const bodyHash = hashRequestBody(req.rawBody);
    message = buildDeviceRequestMessage({
      method: req.method,
      originalUrl: req.originalUrl,
      timestamp: timestampText,
      nonce,
      token,
      bodyHash,
    });
  } catch {
    return false;
  }

  try {
    return await withTransaction(async (tx) => {
      const [deviceRows] = await tx.execute(
        `SELECT device_id,public_key_der,session_token_hash,session_expires_at_ms
         FROM auth_devices WHERE username=? LIMIT 1 FOR UPDATE`,
        [username],
      );
      if (!deviceRows.length) return false;
      const device = deviceRows[0];
      if (
        device.device_id !== deviceId ||
        Number(device.session_expires_at_ms) <= now ||
        !timingSafeHexEqual(String(device.session_token_hash || ""), tokenHash) ||
        !verifyDeviceSignature(device.public_key_der, message, signature)
      ) return false;

      await tx.execute(
        `INSERT INTO auth_device_request_nonces(username,device_id,nonce,expires_at_ms,created_at_ms)
         VALUES(?,?,?,?,?)`,
        [username, deviceId, nonce, String(now + DEVICE_REQUEST_NONCE_TTL_MS), String(now)],
      );
      await tx.execute(
        `UPDATE auth_devices SET last_seen_at_ms=? WHERE username=? AND device_id=? AND session_token_hash=?`,
        [String(now), username, deviceId, tokenHash],
      );
      return true;
    });
  } catch (error) {
    if (error.code !== "ER_DUP_ENTRY") {
      console.error("Device-bound request validation failed:", error.message);
    }
    return false;
  }
}

async function getUserActivityPasswordState(username, submittedPassword) {
  if (!username || typeof submittedPassword !== "string") return "incorrect";
  const rows = await db.queryAsync(
    `SELECT password,last_login_at_ms,account_active,consec_failed_auth,password_temp_expires_at_ms
     FROM auths WHERE username=? LIMIT 1`,
    [username],
  );
  if (rows.length === 0) return "incorrect";

  const row = rows[0];
  if (!(await verifySecret(row.password, submittedPassword))) return "incorrect";
  if (Number(row.account_active) !== 1) return "deactivated";
  if (row.last_login_at_ms == null) return "not_allowed";
  // The lock persists after a temporary-password login. Only changing the
  // temporary password clears the marker and restores normal account activity.
  if (isPasswordProtectedActivityLocked({
    failedCount: Number(row.consec_failed_auth || 0),
    temporaryPasswordExpiresAtMs: row.password_temp_expires_at_ms,
  })) return "not_allowed";

  return "ok";
}

async function applyWelcomeBonusAtFirstLoginTx(tx, authRow, nowMs) {
  const decision = decideWelcomeBonus({
    registrationSequence: authRow.registration_sequence,
    currentStatus: authRow.welcome_bonus_status,
    beneficiaryLimit: WELCOME_BONUS_BENEFICIARIES,
    amountXtu: WELCOME_BONUS_AMOUNT_XTU,
  });

  if (decision.reason === "already_decided") {
    return {
      status: decision.status,
      amount_xtu: String(authRow.welcome_bonus_amount_xtu || "0"),
      credited: decision.status === "credited",
    };
  }

  const configuredAmount = decision.shouldCredit
    ? WELCOME_BONUS_AMOUNT_XTU
    : new BigNumber(0);
  const now = String(nowMs);
  if (decision.shouldCredit) {
    const [claimRows] = await tx.query(
      `SELECT subject_type FROM welcome_bonus_claims
       WHERE (subject_type='email' AND subject_hash=?)
          OR (subject_type='identity' AND subject_hash=?)
       LIMIT 1 FOR UPDATE`,
      [authRow.welcome_bonus_email_hash, authRow.welcome_bonus_identity_hash],
    );
    if (claimRows.length) {
      await tx.query(
        `UPDATE auths
         SET welcome_bonus_status='previously_credited',welcome_bonus_amount_xtu='0',
             welcome_bonus_initial_asset='0',welcome_bonus_unit_price=NULL,
             welcome_bonus_decided_at_ms=?,welcome_bonus_credited_at_ms=NULL
         WHERE id=? AND welcome_bonus_status='pending'`,
        [now, String(authRow.id)],
      );
      return { status: "previously_credited", amount_xtu: "0", credited: false };
    }
  }
  if (!decision.shouldCredit) {
    await tx.query(
      `UPDATE auths
       SET welcome_bonus_status=?,welcome_bonus_amount_xtu=?,welcome_bonus_initial_asset='0',
           welcome_bonus_unit_price=NULL,welcome_bonus_decided_at_ms=?,welcome_bonus_credited_at_ms=NULL
       WHERE id=? AND welcome_bonus_status='pending'`,
      [decision.status, configuredAmount.toFixed(18), now, String(authRow.id)],
    );
    return { status: decision.status, amount_xtu: "0", credited: false };
  }

  const [commonLockRows] = await tx.query(
    "SELECT lock_name FROM system_locks WHERE lock_name='common_state' FOR UPDATE",
  );
  if (!commonLockRows.length) throw new Error("The common-state lock row has not been initialized for welcome bonus credit");

  const common = await getLatestCommonTx(tx, true);
  const unitPrice = new BigNumber(common.unit_price);
  const protectedFloor = calculateRemainingSystemAdminReserve(
    stock_limit,
    SYSTEM_ADMIN_RESERVE_RATIO,
    common.sys_inactive_init_asset || "0",
  ).remainingInitialAsset;
  if (!unitPrice.isFinite() || !unitPrice.isGreaterThan(0)) {
    throw new Error("The global XTU price is invalid during welcome bonus credit");
  }

  const allocation = calculateTopUpReserveAllocation(
    configuredAmount,
    unitPrice,
    common.backed_units,
    common.inactive_init_asset,
    common.total_units_price,
    protectedFloor,
  );
  if (!allocation.available) {
    await tx.query(
      `UPDATE auths
       SET welcome_bonus_status='reserve_unavailable',welcome_bonus_amount_xtu=?,
           welcome_bonus_initial_asset='0',welcome_bonus_unit_price=?,
           welcome_bonus_decided_at_ms=?,welcome_bonus_credited_at_ms=NULL
       WHERE id=? AND welcome_bonus_status='pending'`,
      [configuredAmount.toFixed(18), unitPrice.toFixed(30), now, String(authRow.id)],
    );
    return { status: "reserve_unavailable", amount_xtu: "0", credited: false };
  }

  const [stockRows] = await tx.query(
    "SELECT balance FROM users_stock WHERE username=? LIMIT 1 FOR UPDATE",
    [authRow.username],
  );
  if (!stockRows.length) throw new Error(`Missing stock row for welcome bonus beneficiary ${authRow.username}`);
  const currentBalance = new BigNumber(stockRows[0].balance);
  if (!currentBalance.isFinite() || currentBalance.isNegative()) {
    throw new Error("Invalid user balance during welcome bonus credit");
  }
  const stockLimit = isUserBalanceWithinMaxStock(
    currentBalance,
    allocation.activityAmount,
    allocation.newUnitPrice,
    maxStockDefault,
  );
  if (!stockLimit.allowed) {
    await tx.query(
      `UPDATE auths
       SET welcome_bonus_status='balance_limit',welcome_bonus_amount_xtu=?,
           welcome_bonus_initial_asset='0',welcome_bonus_unit_price=?,
           welcome_bonus_decided_at_ms=?,welcome_bonus_credited_at_ms=NULL
       WHERE id=? AND welcome_bonus_status='pending'`,
      [configuredAmount.toFixed(18), unitPrice.toFixed(30), now, String(authRow.id)],
    );
    return { status: "balance_limit", amount_xtu: "0", credited: false };
  }

  const [date, time] = getDate();
  const reference = createFinancialReference("WELCOME");
  const newBalance = currentBalance.plus(allocation.activityAmount);
  await tx.query(
    `INSERT INTO activities(sender,receiver,type,amount,unit_price,fees,bsc_fee_cost_usd,reference,record_date,record_time)
     VALUES(?,?,4,?,?,0,0,?,?,?)`,
    [OneX, authRow.username, allocation.activityAmount.toFixed(30), unitPrice.toFixed(30), reference, date, time],
  );
  await tx.query(
    "UPDATE users_stock SET balance=?,record_date=?,record_time=? WHERE username=?",
    [newBalance.toFixed(30), date, time, authRow.username],
  );
  await markPendingDepositBatchesDueTx(tx, authRow.username);
  await insertCommonSnapshotTx(tx, common, {
    total_units_price: allocation.newTotalUnitsPrice.toFixed(30),
    backed_units: allocation.newBacked.toFixed(30),
    inactive_init_asset: allocation.newInactive.toFixed(30),
  }, date, time);

  const resultingPrice = calculateGlobalUnitPrice(
    allocation.newTotalUnitsPrice,
    allocation.newBacked,
    unitPrice,
  );
  await resetUserPriceBasisTx(tx, authRow.username, resultingPrice, tfees, { source: "welcome_bonus" });
  await tx.query(
    `INSERT INTO welcome_bonus_claims(subject_type,subject_hash,username,amount_xtu,credited_at_ms)
     VALUES('email',?,?,?,?),('identity',?,?,?,?)`,
    [
      authRow.welcome_bonus_email_hash, authRow.username, configuredAmount.toFixed(18), now,
      authRow.welcome_bonus_identity_hash, authRow.username, configuredAmount.toFixed(18), now,
    ],
  );
  await tx.query(
    `UPDATE auths
     SET welcome_bonus_status='credited',welcome_bonus_amount_xtu=?,welcome_bonus_initial_asset=?,
         welcome_bonus_unit_price=?,welcome_bonus_decided_at_ms=?,welcome_bonus_credited_at_ms=?
     WHERE id=? AND welcome_bonus_status='pending'`,
    [
      configuredAmount.toFixed(18),
      allocation.activityAmount.toFixed(30),
      unitPrice.toFixed(30),
      now,
      now,
      String(authRow.id),
    ],
  );
  await queueTelegramMessageTx(
    tx,
    authRow.username,
    `welcome-bonus:${reference}`,
    [
      "OneX Welcome Bonus",
      `Your one-time welcome credit of ${configuredAmount.toFixed(8)} XTU has been added to your balance.`,
      `Reference: ${reference}`,
      "Status: SUCCESS",
    ].join("\n"),
  );
  return {
    status: "credited",
    amount_xtu: configuredAmount.toFixed(18),
    credited: true,
    reference,
  };
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
      `SELECT password,password_temp_expires_at_ms,email,account_active
       FROM auths WHERE username=? LIMIT 1 FOR UPDATE`,
      [username],
    );
    if (!rows.length) return { ok: false, reason: "account_not_found" };

    const row = rows[0];
    if (Number(row.account_active) !== 1) return { ok: false, reason: "account_deactivated" };
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
    await mailQueue.sendMail({
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


const { getXtuSettings, isXtuDepositWorkerEnabled } = require("./xtu-withdrawal-chain");
const { registerXtuWithdrawalRoutes } = require("./xtu-withdrawal-routes");
registerXtuWithdrawalRoutes(router, {
  db,
  OneX,
  admin_pswd,
  admin_pin,
  DB_CONFIG,
  decrypt,
  normalizeUsername,
  normalizeFormValue,
  requestTokenIsValid,
  getUserActivityPasswordState,
  accountApiLimitReached,
  withTransaction,
  getDate,
  createFinancialReference,
  getLatestCommonTx,
  insertCommonSnapshotTx,
  getUserPriceStateTx,
  calculateEffectiveIndividualPrice,
  xtuToInitialAsset,
  calculateRemainingSystemAdminReserve,
  stock_limit,
  SYSTEM_ADMIN_RESERVE_RATIO,
});

/**
 * Read a consistent deposit-availability snapshot. The common-state lock
 * serializes this check with deposit credits and global-disbursement activation.
 */
async function assessUserDepositAvailability(username) {
  return withTransaction(async (tx) => {
    const [lockRows] = await tx.query(
      "SELECT lock_name FROM system_locks WHERE lock_name='common_state' FOR UPDATE",
    );
    if (!lockRows.length) throw new Error("The common-state lock row has not been initialized");

    const common = await getLatestCommonTx(tx, true);
    const [globalRows] = await tx.query(
      `SELECT id,status,effective_at_ms,request_deadline_at_ms,extension_deadline_at_ms,bonus_rate_percent
       FROM global_disbursement_runs
       WHERE status IN ('announced','active','closed','manual_review','completed','resolved')
       ORDER BY id DESC LIMIT 1 FOR UPDATE`,
    );
    const globalRun = globalRows[0] || null;
    const [controlRows] = await tx.query(
      `SELECT is_suspended,suspension_reason,changed_by,updated_at_ms
       FROM deposit_service_control WHERE control_id=1 LIMIT 1 FOR UPDATE`,
    );
    if (!controlRows.length) throw new Error("The deposit service control row has not been initialized");
    const depositControl = controlRows[0];
    const [stockRows] = await tx.query(
      `SELECT balance,seller_status,run_balance,seller_expires_at_ms
       FROM users_stock WHERE username=? LIMIT 1 FOR UPDATE`, [username],
    );
    if (!stockRows.length) return { allowed: false, reason: "account_not_found", common, globalRun, depositControl };
    const [priceStateRows] = await tx.query(
      "SELECT * FROM user_price_state WHERE username=? LIMIT 1 FOR UPDATE", [username],
    );
    if (!priceStateRows.length) throw new Error(`Individual remuneration state is missing for ${username}`);
    const priceState = priceStateRows[0];

    const globalEffective = Boolean(
      globalRun && isGlobalDisbursementEffective(globalRun.status, globalRun.effective_at_ms, Date.now()),
    );
    const manualSuspended = Number(depositControl.is_suspended) === 1;
    const paymentServiceEnabled = Boolean(getPaymentPublicConfig().enabled);
    if (globalEffective || manualSuspended || !paymentServiceEnabled) {
      const availability = resolveDepositAvailability({
        globalDisbursementActive: globalEffective,
        manuallySuspended: manualSuspended,
        paymentServiceEnabled,
        capacityAllowed: true,
      });
      return {
        ...availability,
        globalRun,
        globalEffective,
        depositControl,
        common,
        stock: stockRows[0],
        balanceInitial: new BigNumber(stockRows[0].balance),
      };
    }

    const activeSellerReserve = await getActiveSellerReserveAvailableTx(tx, username);
    const sellersReserve = new BigNumber(common.sellers_res || "0");
    if (!sellersReserve.isFinite() || sellersReserve.isNegative() || activeSellerReserve.gt(sellersReserve)) {
      throw new Error("Active seller lots exceed common.sellers_res or the seller reserve is invalid");
    }
    const protectedFloor = calculateRemainingSystemAdminReserve(
      stock_limit,
      SYSTEM_ADMIN_RESERVE_RATIO,
      common.sys_inactive_init_asset || "0",
    ).remainingInitialAsset;

    const capacity = calculateMinimumDepositCapacity({
      currentBalanceInitialAsset: stockRows[0].balance,
      totalUnitsPrice: common.total_units_price,
      backedUnits: common.backed_units,
      inactiveInitialAsset: common.inactive_init_asset,
      availableSellerInitialAsset: activeSellerReserve,
      protectedAdminInitialAsset: protectedFloor,
      currentUnitPrice: common.unit_price,
      tfeesRate: tfees,
      maximumUserXtu: maxStockDefault,
      stockLimitEvaluator: (_balance, creditInitial, projectedGlobalPrice) => previewUserOperationCapacity(
        priceState, "purchase", creditInitial, new BigNumber(stockRows[0].balance),
        new BigNumber(stockRows[0].balance).plus(creditInitial), projectedGlobalPrice,
      ),
    });
    const availability = resolveDepositAvailability({
      globalDisbursementActive: false,
      manuallySuspended: false,
      paymentServiceEnabled,
      capacityAllowed: capacity.allowed,
    });

    return {
      ...capacity,
      ...availability,
      globalRun,
      globalEffective: false,
      depositControl,
      common,
      stock: stockRows[0],
      balanceInitial: new BigNumber(stockRows[0].balance),
    };
  });
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
  const enforceDepositRange = options.enforceDepositRange !== false;
  if (!amountValue.isFinite() || !amountValue.isGreaterThan(0)) return { error: "invalid top-up amount" };
  if (enforceDepositRange) {
    const rangeCheck = validateDepositAmount(amountValue);
    if (!rangeCheck.allowed) {
      return {
        error: rangeCheck.reason === "below_minimum"
          ? "minimum deposit amount not met"
          : (rangeCheck.reason === "above_maximum" ? "maximum deposit amount exceeded" : "invalid top-up amount"),
      };
    }
  }
  const appliedTfeesRate = new BigNumber(options.tfeesRatePercent ?? tfees);
  if (!appliedTfeesRate.isFinite() || appliedTfeesRate.isNegative() || appliedTfeesRate.isGreaterThanOrEqualTo(100)) {
    throw new Error("Invalid transfer-fee configuration");
  }

  const [lockRows] = await tx.query(
    "SELECT lock_name FROM system_locks WHERE lock_name=? FOR UPDATE", ["common_state"],
  );
  if (!lockRows.length) throw new Error("The common-state lock row has not been initialized");
  const common = await getLatestCommonTx(tx, true);
  const [depositControlRows] = await tx.query(
    "SELECT is_suspended FROM deposit_service_control WHERE control_id=1 LIMIT 1 FOR UPDATE",
  );
  if (!depositControlRows.length) throw new Error("The deposit service control row has not been initialized");
  const reviewedAdminCredit = options.allowReviewedAdminCredit === true;
  if (Number(depositControlRows[0].is_suspended) === 1 && !reviewedAdminCredit) {
    return { error: "deposit manually suspended" };
  }
  if (!getPaymentPublicConfig().enabled && !reviewedAdminCredit) {
    return { error: "payment service disabled" };
  }
  const [activeGlobalRuns] = await tx.query(
    `SELECT id,status,effective_at_ms,bonus_rate_percent,admin_bonus_reserved_initial_asset FROM global_disbursement_runs
     WHERE status IN ('announced','active','closed','manual_review','completed','resolved')
     ORDER BY id DESC LIMIT 1 FOR UPDATE`,
  );
  const globalRun = activeGlobalRuns[0] || null;
  const globalEffective = globalRun && isGlobalDisbursementEffective(
    globalRun.status, globalRun.effective_at_ms, eventTimestampMs,
  );
  if (globalEffective && options.preEffectiveBatch !== true) {
    return { error: "global disbursement in progress" };
  }
  const [authRows] = await tx.query(
    "SELECT last_login_at_ms,account_active FROM auths WHERE username=? FOR UPDATE", [username],
  );
  if (!authRows.length || authRows[0].last_login_at_ms == null) return { error: "user not found" };
  if (Number(authRows[0].account_active) !== 1) return { error: "account deactivated" };
  const [userRows] = await tx.query(
    "SELECT balance FROM users_stock WHERE username=? FOR UPDATE", [username],
  );
  if (!userRows.length) return { error: "user not found" };
  const [userPriceRows] = await tx.query(
    "SELECT * FROM user_price_state WHERE username=? LIMIT 1 FOR UPDATE", [username],
  );
  if (!userPriceRows.length) throw new Error(`Individual remuneration state is missing for ${username}`);
  const userPriceState = userPriceRows[0];
  const [pendingDisbursementRows] = await tx.query(
    `SELECT id FROM users_usdt_disbursements
     WHERE username=? AND status IN ('queued','signed','submitted','manual_review')
     ORDER BY id DESC LIMIT 1 FOR UPDATE`, [username],
  );
  if (pendingDisbursementRows.length) return { error: "disbursement is pending" };
  const [pendingXtuRows] = await tx.query(
    `SELECT id FROM xtu_withdrawals
     WHERE username=? AND status IN ('queued','signed','submitted','manual_review')
     ORDER BY id DESC LIMIT 1 FOR UPDATE`, [username],
  );
  if (pendingXtuRows.length) return { error: "XTU withdrawal is pending" };

  const userBalanceInitial = new BigNumber(userRows[0].balance);
  if (!userBalanceInitial.isFinite() || userBalanceInitial.isNegative()) {
    throw new Error("Invalid initial-asset user balance during top-up");
  }
  const total = new BigNumber(common.total_units_price);
  const price = new BigNumber(common.unit_price);
  const backed = new BigNumber(common.backed_units);
  const inactive = new BigNumber(common.inactive_init_asset);
  const sellersReserve = new BigNumber(common.sellers_res || "0");
  // Do not recycle a beneficiary's own locked seller reserve into their deposit.
  const activeSellerReserve = await getActiveSellerReserveAvailableTx(tx, username);
  if (
    !total.isFinite() || !total.isGreaterThan(0) || !price.isFinite() || !price.isGreaterThan(0) ||
    !backed.isFinite() || !backed.isGreaterThan(0) || !inactive.isFinite() || inactive.isNegative() ||
    !sellersReserve.isFinite() || sellersReserve.isNegative()
  ) throw new Error("Invalid common reserve values during top-up");
  if (activeSellerReserve.gt(sellersReserve)) {
    throw new Error("Active seller lots exceed common.sellers_res");
  }

  // Incoming deposits are received directly by the treasury. OneX does not
  // deduct BSC gas from deposit amounts; only the batch's captured tfees apply.
  const actualBscFeeUsd = new BigNumber(0);
  const protectedFloor = calculateRemainingSystemAdminReserve(
    stock_limit, SYSTEM_ADMIN_RESERVE_RATIO, common.sys_inactive_init_asset || "0",
  ).remainingInitialAsset;
  const [pendingPayoutRows] = await tx.query(
    `SELECT sold_initial_asset FROM users_usdt_disbursements
     WHERE status IN ('queued','signed','submitted','manual_review') FOR UPDATE`,
  );
  const pendingPayoutInitial = pendingPayoutRows.reduce(
    (sum, row) => sum.plus(row.sold_initial_asset), new BigNumber(0),
  );
  const lastDeposit = await getLastOnexDeposit(tx, username, OneX);
  const cooldown = assessDepositCooldown(lastDeposit, eventTimestampMs);
  const bonusRate = globalRun && globalRun.status === "announced" && !globalEffective
    ? new BigNumber(globalRun.bonus_rate_percent || "0")
    : new BigNumber(0);
  const adminQuotaRemaining = calculateRemainingSystemAdminReserve(
    stock_limit, SYSTEM_ADMIN_RESERVE_RATIO, common.sys_inactive_init_asset || "0",
  ).remainingInitialAsset;
  const currentlyReserved = new BigNumber(globalRun?.admin_bonus_reserved_initial_asset || "0");
  const creditPlan = findMaximumDepositCredit({
    targetGrossAmount: amountValue,
    currentBalanceInitialAsset: userBalanceInitial,
    totalUnitsPrice: total,
    backedUnits: backed,
    inactiveInitialAsset: inactive,
    totalSellerReserve: sellersReserve,
    availableSellerReserve: activeSellerReserve,
    protectedAdminInitialAsset: protectedFloor,
    pendingDisbursementInitialAsset: pendingPayoutInitial,
    currentUnitPrice: price,
    tfeesRatePercent: appliedTfeesRate,
    maximumUserXtu: maxStockDefault,
    weeklyCooldownAllowed: cooldown.allowed,
    globalBonusRatePercent: bonusRate,
    remainingAdminReserveInitialAsset: adminQuotaRemaining,
    alreadyReservedAdminBonusInitialAsset: currentlyReserved,
    stockLimitEvaluator: (_balance, creditInitial, projectedGlobalPrice) => {
      const projectedBalance = userBalanceInitial.plus(creditInitial);
      return previewUserOperationCapacity(
        userPriceState, "purchase", creditInitial, userBalanceInitial,
        projectedBalance, projectedGlobalPrice,
      );
    },
  });
  if (!creditPlan.allowed) {
    if (creditPlan.reason === "system_reserve") {
      const availableSystem = BigNumber.maximum(0, creditPlan.details?.availableInitialAsset || 0);
      const availableTotal = availableSystem.plus(activeSellerReserve);
      return { limit: `BSC-USD ${availableTotal.multipliedBy(price).toFixed(18)}` };
    }
    if (creditPlan.reason === "weekly_limit") {
      return {
        error: "weekly deposit limit reached",
        remaining_seconds: Math.ceil(cooldown.remainingMs / 1000),
        lastDepositMs: cooldown.lastDepositMs,
        sellerReserveAvailable: sellersReserve.toFixed(),
      };
    }
    if (creditPlan.reason === "maximum_user_balance") {
      return {
        error: "maximum user balance exceeded",
        projected_balance: creditPlan.details?.projectedBalanceXtu?.toFixed(18) || "0",
      };
    }
    if (creditPlan.reason === "global_bonus_reserve") {
      return { error: "global bonus reserve unavailable during notice period" };
    }
    return { error: "fees exceed the received deposit amount" };
  }

  // If current account capacity or reserves cannot accept the whole target,
  // credit the largest exact 18-decimal tranche that passes every constraint.
  amountValue = creditPlan.grossAmount;
  const feeAmountXtu = creditPlan.feeAmount;
  const netAmountXtu = creditPlan.netAmount;
  const bscFeeCoveredUsd = new BigNumber(0);
  const bscFeeUncoveredUsd = new BigNumber(0);
  const netFeeAmountXtu = feeAmountXtu;
  const fundingAllocation = creditPlan.allocation;
  const sellerAmountInitial = creditPlan.sellerInitialAsset;
  const systemAmountInitial = creditPlan.systemInitialAsset;
  const systemAmountXtu = creditPlan.systemAmountXtu;
  const sellerBasis = sellerAmountInitial;
  const systemBasis = systemAmountInitial;
  const creditedBasis = sellerBasis.plus(systemBasis);
  const grossFeeBasis = feeAmountXtu.dividedBy(price);
  const feeBasis = grossFeeBasis;
  if (!feeBasis.isFinite() || feeBasis.isNegative()) throw new Error("Net tfees reserve basis is invalid");
  const newTotal = creditPlan.newTotal;
  const newBacked = creditPlan.newBacked;
  const newInactive = creditPlan.newInactive;
  const newSellersReserve = creditPlan.newSellerReserve;
  const totalTfees = new BigNumber(common.total_tfees || "0").plus(feeBasis);
  const totalTfeesBscCost = new BigNumber(common.total_tfees_bsc_cost_usd || "0");
  const totalTfeesBscUncovered = new BigNumber(common.total_tfees_bsc_uncovered_usd || "0");
  if (newSellersReserve.isNegative()) throw new Error("Seller reserve totals would become negative");

  const newPrice = creditPlan.newPrice;
  const newBalanceInitial = userBalanceInitial.plus(creditedBasis);
  const stockLimit = previewUserOperationCapacity(
    userPriceState, "purchase", creditedBasis, userBalanceInitial,
    newBalanceInitial, newPrice,
  );
  if (!stockLimit.allowed) {
    return { error: "maximum user balance exceeded", projected_balance: stockLimit.projectedXtu.toFixed(18) };
  }
  if (globalRun && globalRun.status === "announced" && !globalEffective && creditedBasis.isGreaterThan(0)) {
    await tx.query(
      `UPDATE global_disbursement_runs
       SET admin_bonus_reserved_initial_asset=admin_bonus_reserved_initial_asset+?,updated_at_ms=?
       WHERE id=? AND status='announced'`,
      [creditPlan.additionalAdminBonusReserve.toFixed(30), String(Date.now()), globalRun.id],
    );
  }

  // Capture any threshold reached before this acquisition, using the user's
  // pre-deposit principal balance. The acquisition then resets the price basis.
  await triggerUserPriceThresholdTx(tx, username, price);

  const sellerAllocation = sellerAmountInitial.isGreaterThan(0)
    ? await consumeSellerReserveTx(tx, sellerAmountInitial, reference, date, time, username)
    : { consumedInitialAsset: new BigNumber(0), allocations: [] };
  if (!sellerAllocation.consumedInitialAsset.eq(sellerAmountInitial)) {
    throw new Error("The seller reserve changed during deposit allocation");
  }
  const sellerFeeBasis = creditedBasis.isGreaterThan(0)
    ? grossFeeBasis.multipliedBy(sellerBasis).dividedBy(creditedBasis)
    : new BigNumber(0);
  const systemFeeBasis = grossFeeBasis.minus(sellerFeeBasis);
  const sellerBscFeeCost = creditedBasis.isGreaterThan(0)
    ? actualBscFeeUsd.multipliedBy(sellerBasis).dividedBy(creditedBasis)
    : new BigNumber(0);
  const systemBscFeeCost = actualBscFeeUsd.minus(sellerBscFeeCost);
  if (sellerBasis.isGreaterThan(0)) {
    await tx.query(
      `INSERT INTO activities(sender,receiver,type,amount,unit_price,fees,fee_unit_price,bsc_fee_cost_usd,reference,record_date,record_time)
       VALUES('XUSER',?,?,?, ?,?,?,?,?,?,?)`,
      [username, 2, sellerBasis.toFixed(30), price.toFixed(30), sellerFeeBasis.toFixed(30), price.toFixed(30), sellerBscFeeCost.toFixed(30), `${reference}S`.slice(0, 64), date, time],
    );
  }
  if (systemBasis.isGreaterThan(0)) {
    await tx.query(
      `INSERT INTO activities(sender,receiver,type,amount,unit_price,fees,fee_unit_price,bsc_fee_cost_usd,reference,record_date,record_time)
       VALUES(?,?,2,?,?,?,?,?,?,?,?)`,
      [OneX, username, systemBasis.toFixed(30), price.toFixed(30), systemFeeBasis.toFixed(30), price.toFixed(30), systemBscFeeCost.toFixed(30), `${reference}O`.slice(0, 64), date, time],
    );
  }
  await tx.query(
    "UPDATE users_stock SET balance=?,record_date=?,record_time=? WHERE username=?",
    [newBalanceInitial.toFixed(30), date, time, username],
  );
  await markPendingDepositBatchesDueTx(tx, username, options.depositBatchId || null);
  await insertCommonSnapshotTx(tx, common, {
    total_units_price: newTotal.toFixed(30),
    backed_units: newBacked.toFixed(30),
    inactive_init_asset: newInactive.toFixed(30),
    sellers_res: newSellersReserve.toFixed(30),
    total_tfees: totalTfees.toFixed(30),
    total_tfees_bsc_cost_usd: totalTfeesBscCost.toFixed(30),
    total_tfees_bsc_uncovered_usd: totalTfeesBscUncovered.toFixed(30),
  }, date, time);

  const resultingPrice = calculateGlobalUnitPrice(newTotal, newBacked, new BigNumber(common.unit_price));
  await recordUserOperationTx(
    tx, username, "purchase", creditedBasis, userBalanceInitial, newBalanceInitial,
    resultingPrice, appliedTfeesRate, reference,
  );
  // Only evaluate the post-credit global price after a qualifying group has
  // had a chance to create its next cycle; this avoids a false pause notice.
  await triggerUserPriceThresholdTx(tx, username, resultingPrice, null, newBalanceInitial);
  const updatedPriceState = await getUserPriceStateTx(tx, username, true);
  if (!updatedPriceState) throw new Error(`Individual remuneration state is missing after deposit for ${username}`);
  const updatedIndividualPrice = calculateEffectiveIndividualPrice(
    updatedPriceState, newBalanceInitial, resultingPrice, maxStockDefault,
  ).price;
  const creditedXtuAtIndividualPrice = creditedBasis.multipliedBy(updatedIndividualPrice);
  await queueTelegramMessageTx(
    tx,
    username,
    `deposit:${reference}:credited`,
    [
      "OneX Deposit Update",
      "Your deposit has been credited successfully.",
      `Gross amount credited in this tranche: ${amountValue.toFixed(8)} BSC-USD`,
      `Applied tfees rate: ${appliedTfeesRate.toFixed(4)}%`,
      `Gross tfees retained by OneX: ${feeAmountXtu.toFixed(8)} BSC-USD`,
      "No OneX BSC network fee is deducted from incoming deposits.",
      `Initial assets credited to your principal: ${creditedBasis.toFixed(8)}`,
      `Individual valuation of the credited assets: ${creditedXtuAtIndividualPrice.toFixed(8)} XTU at ${updatedIndividualPrice.toFixed(12)} XTU per initial asset`,
      `Public/global price after this credit: ${resultingPrice.toFixed(12)} XTU per initial asset`,
      `Funding source: ${[
        fundingAllocation.consumedInactive.isGreaterThan(0) ? "inactive reserve" : null,
        sellerBasis.isGreaterThan(0) ? "seller reserve" : null,
        fundingAllocation.consumedBacked.isGreaterThan(0) ? "backed reserve" : null,
      ].filter(Boolean).join(" + ")}`,
      "Status: SUCCESS",
    ].join("\n"),
  );

  return {
    transf: "sent",
    gross_amount: amountValue.toFixed(18),
    requested_gross_amount: creditPlan.targetGrossAmount.toFixed(18),
    partial_credit: Boolean(creditPlan.partial),
    partial_reason: creditPlan.partialReason || null,
    tfees_rate_percent: appliedTfeesRate.toFixed(10),
    fee_amount: feeAmountXtu.toFixed(18),
    bsc_fee_cost: actualBscFeeUsd.toFixed(18),
    net_tfees_retained: netFeeAmountXtu.toFixed(18),
    bsc_fee_uncovered: bscFeeUncoveredUsd.toFixed(18),
    credited_amount: creditedXtuAtTransactionPrice.toFixed(18),
    credited_initial_asset: creditedBasis.toFixed(30),
    unit_price: price.toFixed(30),
    reserve_source: [
      fundingAllocation.consumedInactive.isGreaterThan(0) ? "inactive" : null,
      sellerBasis.isGreaterThan(0) ? "seller" : null,
      fundingAllocation.consumedBacked.isGreaterThan(0) ? "backed" : null,
    ].filter(Boolean).join("+"),
    activity_basis: creditedBasis.toFixed(30),
  };
}

async function queueSystemDisbursement(tx, username, verifiedPasswordHash, requestedGrossAmountXtu) {
  const enabled = (name) => String(process.env[name] || "false").toLowerCase() === "true";
  if (!process.env.USDT_BEP20_DISBURSEMENT_ADDRESS) return { transf: "disbursement unavailable" };
  if (!requestedGrossAmountXtu.isFinite() || !requestedGrossAmountXtu.isGreaterThan(0)) {
    return { transf: "invalid disbursement amount" };
  }

  const [lockRows] = await tx.query(
    "SELECT lock_name FROM system_locks WHERE lock_name='common_state' FOR UPDATE",
  );
  if (!lockRows.length) throw new Error("The common-state lock row has not been initialized");
  const common = await getLatestCommonTx(tx, true);
  const commonPrice = new BigNumber(common.unit_price);
  if (!commonPrice.isFinite() || !commonPrice.isGreaterThan(0)) throw new Error("Invalid global unit price");

  const [runRows] = await tx.query(
    `SELECT id,status,effective_at_ms,request_deadline_at_ms,extension_deadline_at_ms,snapshot_unit_price,
            bonus_rate_percent,admin_bonus_reserved_initial_asset,admin_bonus_committed_initial_asset
     FROM global_disbursement_runs
     WHERE status IN ('announced','active','closed','manual_review','completed','resolved')
     ORDER BY id DESC LIMIT 1 FOR UPDATE`,
  );
  const globalRun = runRows[0] || null;
  const now = Date.now();
  const globalEffective = Boolean(globalRun && isGlobalDisbursementEffective(globalRun.status));
  const globalPhase = globalRun
    ? resolveGlobalDisbursementPhase(
      globalRun.status,
      globalRun.request_deadline_at_ms,
      globalRun.extension_deadline_at_ms,
      now,
    )
    : "closed";
  const globalRequestOpen = globalPhase !== "closed";
  if (globalEffective && !globalRequestOpen) {
    return { transf: "global disbursement request window closed; administrative review required" };
  }
  if (!enabled("USDT_DISBURSEMENTS_ENABLED")) return { transf: "disbursement unavailable" };
  if (globalRequestOpen) {
    if (!enabled("USDT_GLOBAL_DISBURSEMENT_ENABLED")) return { transf: "global disbursement unavailable" };
  } else if (!enabled("USDT_INDIVIDUAL_DISBURSEMENT_ENABLED")) {
    return { transf: "individual disbursement unavailable" };
  }

  const mode = globalRequestOpen ? "global" : "individual";
  if (mode === "individual") {
    const [controlRows] = await tx.query(
      `SELECT is_open FROM individual_disbursement_control
       WHERE control_id=1 LIMIT 1 FOR UPDATE`,
    );
    if (!controlRows.length || Number(controlRows[0].is_open) !== 1) {
      return { transf: "disbursement unavailable" };
    }
  }
  let requestPrice;
  let globalParticipant = null;

  const [authRows] = await tx.query(
    `SELECT last_login_at_ms,account_active,password,consec_failed_auth,password_temp_expires_at_ms
     FROM auths WHERE username=? FOR UPDATE`, [username],
  );
  if (authRows.length && Number(authRows[0].account_active) !== 1) {
    return { auths: "deactivated" };
  }
  if (authRows.length && (
    Number(authRows[0].consec_failed_auth || 0) >= 3 || authRows[0].password_temp_expires_at_ms != null
  )) return { auth: "not allowed" };
  if (!authRows.length || authRows[0].last_login_at_ms == null || authRows[0].password !== verifiedPasswordHash) {
    return { transf: "failed" };
  }

  const [stockRows] = await tx.query(
    "SELECT balance,seller_status FROM users_stock WHERE username=? FOR UPDATE", [username],
  );
  if (!stockRows.length) return { transf: "failed" };
  if (Number(stockRows[0].seller_status || 0) !== 0) return { transf: "seller campaign active" };

  const [walletRows] = await tx.query(
    `SELECT wallet_address FROM auths WHERE username=? AND account_active=1 LIMIT 1 FOR UPDATE`, [username],
  );
  const payoutAddress = walletRows[0]?.wallet_address || "";
  const internalWallets = [
    process.env.USDT_BEP20_TREASURY_ADDRESS,
    process.env.USDT_BEP20_COLD_WALLET_ADDRESS,
    process.env.USDT_BEP20_DISBURSEMENT_ADDRESS,
  ].map((address) => String(address || "").trim().toLowerCase()).filter(Boolean);
  if (!isEvmAddress(payoutAddress) || /^0x0{40}$/i.test(payoutAddress) ||
      internalWallets.includes(String(payoutAddress).toLowerCase())) {
    return { transf: "payout wallet not registered" };
  }

  if (mode === "individual") {
    const [successfulRows] = await tx.query(
      `SELECT id FROM users_usdt_disbursements
       WHERE username=? AND disbursement_mode='individual' AND status='confirmed'
         AND CAST(confirmed_at_ms AS UNSIGNED)>=?
       ORDER BY confirmed_at_ms DESC LIMIT 1 FOR UPDATE`,
      [username, String(now - DISBURSEMENT_COOLDOWN_MS)],
    );
    if (successfulRows.length) return { transf: "disbursement limit reached", cooldown_days: DISBURSEMENT_COOLDOWN_DAYS };
  }
  const [activeRows] = await tx.query(
    `SELECT id FROM users_usdt_disbursements
     WHERE username=? AND status IN ('queued','signed','submitted','manual_review')
     ORDER BY id DESC LIMIT 1 FOR UPDATE`, [username],
  );
  if (activeRows.length) return { transf: "disbursement pending" };
  const [activeXtuRows] = await tx.query(
    `SELECT id FROM xtu_withdrawals
     WHERE username=? AND status IN ('queued','signed','submitted','manual_review')
     ORDER BY id DESC LIMIT 1 FOR UPDATE`, [username],
  );
  if (activeXtuRows.length) return { transf: "XTU withdrawal pending" };

  const userBalanceInitial = new BigNumber(stockRows[0].balance);
  if (!userBalanceInitial.isFinite() || !userBalanceInitial.isGreaterThan(0)) {
    return { transf: "not eligible" };
  }
  if (mode === "global") {
    const [participantRows] = await tx.query(
      `SELECT * FROM global_disbursement_participants
       WHERE run_id=? AND username=? LIMIT 1 FOR UPDATE`, [globalRun.id, username],
    );
    if (!participantRows.length) return { transf: "global participant not found; administrative review required" };
    globalParticipant = participantRows[0];
    requestPrice = new BigNumber(globalParticipant.snapshot_unit_price);
  } else {
    await triggerUserPriceThresholdTx(tx, username, commonPrice);
    const userPriceState = await getUserPriceStateTx(tx, username, true);
    if (!userPriceState) throw new Error(`Individual remuneration state is missing for ${username}`);
    requestPrice = calculateEffectiveIndividualPrice(
      userPriceState, userBalanceInitial, commonPrice, maxStockDefault,
    ).price;
  }
  if (!requestPrice.isFinite() || !requestPrice.isGreaterThan(0)) {
    throw new Error("Invalid individual price for disbursement request");
  }
  const currentBalanceXtu = userBalanceInitial.multipliedBy(requestPrice);
  const minimumCheck = evaluateDisbursementMinimumXtu(
    requestedGrossAmountXtu,
    mode === "global",
    process.env.DISBURSEMENT_INDIVIDUAL_MINIMUM_XTU || "200",
  );
  if (!minimumCheck.allowed) {
    return {
      transf: mode === "global" ? "below global minimum" : "below individual minimum",
      disbursement_mode: mode,
      minimum_amount: minimumCheck.minimumAmount.toFixed(18),
    };
  }

  if (mode === "global") {
    const participant = globalParticipant;
    if (!["awaiting_request", "paid"].includes(String(participant.status))) {
      return { transf: "global participant requires administrative review" };
    }
    const requestedInitialAsset = requestedGrossAmountXtu.dividedBy(requestPrice);
    if (!requestedInitialAsset.isFinite() || !requestedInitialAsset.isGreaterThan(0) ||
        requestedInitialAsset.gt(userBalanceInitial)) {
      return { transf: "insufficient user balance" };
    }
    const bonusRate = new BigNumber(
      globalPhase === "primary" ? (globalRun.bonus_rate_percent || "0") : "0",
    );
    const calculation = calculateGlobalDisbursement(
      requestedInitialAsset, requestPrice, 0, bonusRate, tfees,
    );
    const reservedBonus = new BigNumber(globalRun.admin_bonus_reserved_initial_asset || "0");
    const committedBonus = new BigNumber(globalRun.admin_bonus_committed_initial_asset || "0");
    const remainingBonusReserve = reservedBonus.minus(committedBonus);
    if (!remainingBonusReserve.isFinite() || remainingBonusReserve.lt(calculation.bonusInitialAsset)) {
      return { transf: "global bonus reserve exhausted; administrative review required" };
    }

    const newBalanceInitial = userBalanceInitial.minus(requestedInitialAsset);
    const [date, time] = getDate();
    const reference = createFinancialReference(`GDISB${username}`);
    const [insertResult] = await tx.query(
      `INSERT INTO users_usdt_disbursements
       (username,payout_address,requested_amount,payout_amount,amount_raw,gross_initial_asset,
        sold_initial_asset,fee_amount,fee_initial_asset,tfees_rate_percent,price_value,disbursement_mode,global_run_id,
        balance_after_reservation,bsc_fee_recovered_usd,bonus_amount,bonus_initial_asset,
        estimated_fee_bnb,estimated_fee_usd,reference,status,created_at_ms,reservation_expires_at_ms,updated_at_ms)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,'global',?,?,0,?,?,0,0,?,'queued',?,?,?)`,
      [
        username, payoutAddress, calculation.grossBalance.toFixed(18),
        calculation.payoutBeforeGas.toFixed(18), calculation.amountRaw,
        requestedInitialAsset.toFixed(30), calculation.soldInitialAsset.toFixed(30),
        calculation.feeAmount.toFixed(18), calculation.feeInitialAsset.toFixed(30),
        new BigNumber(tfees).toFixed(10), requestPrice.toFixed(30), String(globalRun.id),
        newBalanceInitial.toFixed(30), calculation.bonusAmount.toFixed(18),
        calculation.bonusInitialAsset.toFixed(30), reference, String(now),
        String(now + 365 * 24 * 60 * 60 * 1000), String(now),
      ],
    );
    const newRequested = new BigNumber(participant.requested_initial_asset || "0").plus(requestedInitialAsset);
    const newRemaining = newBalanceInitial;
    const participantStatus = newRemaining.isZero() ? "request_pending" : "request_pending";
    await tx.query(
      `UPDATE global_disbursement_participants
       SET requested_initial_asset=?,remaining_initial_asset=?,request_count=request_count+1,
           last_disbursement_id=?,status=?,updated_at_ms=?
       WHERE run_id=? AND username=?`,
      [newRequested.toFixed(30), newRemaining.toFixed(30), String(insertResult.insertId), participantStatus,
        String(now), String(globalRun.id), username],
    );
    await tx.query(
      `UPDATE global_disbursement_runs
       SET total_requested_initial_asset=total_requested_initial_asset+?,
           admin_bonus_committed_initial_asset=admin_bonus_committed_initial_asset+?,updated_at_ms=?
       WHERE id=? AND status='active'`,
      [requestedInitialAsset.toFixed(30), calculation.bonusInitialAsset.toFixed(30), String(now), String(globalRun.id)],
    );
    await tx.query(
      "UPDATE users_stock SET balance=?,record_date=?,record_time=? WHERE username=?",
      [newBalanceInitial.toFixed(30), date, time, username],
    );
    await markPendingDepositBatchesDueTx(tx, username);
    await queueTelegramMessageTx(tx, username, `global-disbursement:${globalRun.id}:${insertResult.insertId}:queued`, [
      "OneX Global Disbursement Update",
      "Your global disbursement request to ONEX has been accepted.",
      `Gross amount requested: ${calculation.grossBalance.toFixed(8)} XTU`,
      `Net amount after tfees: ${calculation.netRequestedAmount.toFixed(8)} XTU`,
      `Global bonus: ${calculation.bonusAmount.toFixed(8)} BSC-USD`,
      ...(globalPhase === "extension" ? ["The 30-day extension is active; no bonus applies to new requests."] : []),
      `System tfees deducted from the gross sale: ${calculation.feeAmount.toFixed(8)} BSC-USD.`,
      "The estimated BSC network fee is deducted separately from your BSC-USD payout.",
      `Locked individual valuation: ${requestPrice.toFixed(12)} XTU per initial asset`,
      `Reference: ${reference}`,
      "Status: PROCESSING",
    ].join("\n"));
    return {
      transf: "processing",
      disbursement_mode: "global",
      disbursement_id: String(insertResult.insertId),
      gross_amount: calculation.grossBalance.toFixed(18),
      fee_amount: calculation.feeAmount.toFixed(18),
      bonus_amount: calculation.bonusAmount.toFixed(18),
      payout_amount_before_bsc_gas: calculation.payoutBeforeGas.toFixed(18),
      remaining_balance: newRemaining.multipliedBy(requestPrice).toFixed(18),
      payout_address: payoutAddress,
      locked_unit_price: requestPrice.toFixed(30),
      message: "La demande globale a été enregistrée. Le paiement BSC-USD sera envoyé après validation blockchain.",
    };
  }

  // Account eligibility follows the same configurable minimum as the individual request itself.
  const minimumEligibleBalanceXtu = minimumCheck.minimumAmount;
  if (!isIndividualDisbursementBalanceEligible(currentBalanceXtu, minimumEligibleBalanceXtu)) {
    return { transf: "not eligible", minimum_balance: minimumEligibleBalanceXtu.toFixed() };
  }
  const minimumRemainingXtu = new BigNumber(process.env.DISBURSEMENT_INDIVIDUAL_MINIMUM_REMAINING_XTU || "0");
  if (!minimumRemainingXtu.isFinite() || minimumRemainingXtu.isNegative()) {
    throw new Error("Invalid individual disbursement remaining-balance setting");
  }
  const calculation = calculateIndividualDisbursement(
    requestedGrossAmountXtu, userBalanceInitial, requestPrice, tfees,
  );
  const requiredPayoutRaw = new BigNumber(calculation.payoutAmount)
    .shiftedBy(18).integerValue(BigNumber.ROUND_DOWN).toFixed(0);
  const payoutLiquidity = await checkDisbursementLiquidity(
    requiredPayoutRaw,
    payoutAddress,
    { queryable: tx },
  );
  if (!payoutLiquidity.tokenAvailable) {
    return { transf: "insufficient res", liquidity: payoutLiquidity };
  }
  if (!payoutLiquidity.bnbAvailable || !payoutLiquidity.feeWithinLimit) {
    return { transf: "disbursement unavailable", liquidity: payoutLiquidity };
  }
  const newBalanceInitial = userBalanceInitial.minus(calculation.grossInitialAsset);
  const remainingBalanceXtu = newBalanceInitial.multipliedBy(requestPrice);
  if (remainingBalanceXtu.lt(minimumRemainingXtu)) {
    return { transf: "minimum remaining balance not met", minimum_remaining_balance: minimumRemainingXtu.toFixed(18) };
  }

  const protectedInitialAssets = calculateRemainingSystemAdminReserve(
    stock_limit, SYSTEM_ADMIN_RESERVE_RATIO, common.sys_inactive_init_asset || "0",
  ).remainingInitialAsset;
  const [pendingPayoutRows] = await tx.query(
    `SELECT sold_initial_asset FROM users_usdt_disbursements
     WHERE status IN ('queued','signed','submitted','manual_review') FOR UPDATE`,
  );
  const pendingPayoutInitial = pendingPayoutRows.reduce(
    (sum, row) => sum.plus(row.sold_initial_asset), new BigNumber(0),
  );
  const reserveAvailability = calculateUnreservedDistributableInitialAssets(
    common.backed_units, common.inactive_init_asset, protectedInitialAssets, pendingPayoutInitial,
  );
  if (!reserveAvailability.availableAfterPending.isFinite() || reserveAvailability.availableAfterPending.lt(calculation.soldInitialAsset)) {
    return { transf: "insufficient disbursement reserve" };
  }

  const reference = createFinancialReference(`INDISB${username}`);
  const [date, time] = getDate();
  await tx.query(
    `INSERT INTO users_usdt_disbursements
     (username,payout_address,requested_amount,payout_amount,amount_raw,gross_initial_asset,
      sold_initial_asset,fee_amount,fee_initial_asset,tfees_rate_percent,price_value,disbursement_mode,global_run_id,
      balance_after_reservation,bsc_fee_recovered_usd,reference,status,created_at_ms,
      reservation_expires_at_ms,updated_at_ms)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,'individual',NULL,?,0,?,'queued',?,?,?)`,
    [
      username, payoutAddress,
      calculation.grossAmountXtu.toFixed(18), calculation.payoutAmount.toFixed(18),
      calculation.amountRaw, calculation.grossInitialAsset.toFixed(30),
      calculation.soldInitialAsset.toFixed(30), calculation.feeAmount.toFixed(18),
      calculation.feeInitialAsset.toFixed(30), new BigNumber(tfees).toFixed(10),
      calculation.priceValue.toFixed(30), newBalanceInitial.toFixed(30), reference, String(now),
      String(now + DISBURSEMENT_RESERVATION_MS), String(now),
    ],
  );
  const [idRows] = await tx.query("SELECT id FROM users_usdt_disbursements WHERE reference=? LIMIT 1", [reference]);
  if (!idRows.length) throw new Error("Unable to read the queued individual disbursement");
  await tx.query(
    "UPDATE users_stock SET balance=?,record_date=?,record_time=? WHERE username=?",
    [newBalanceInitial.toFixed(30), date, time, username],
  );
  await markPendingDepositBatchesDueTx(tx, username);
  await queueTelegramMessageTx(tx, username, `disbursement:${idRows[0].id}:queued`, [
    "OneX Individual Disbursement Update",
    "Your individual disbursement request has been accepted and the requested balance is reserved.",
    `Gross amount requested: ${calculation.grossAmountXtu.toFixed(8)} XTU`,
    `System fee: ${calculation.feeAmount.toFixed(8)} XTU`,
    `Locked valuation price: ${calculation.priceValue.toFixed(12)} XTU per initial asset`,
    `Expected payment before BSC network fee: ${calculation.payoutAmount.toFixed(8)} BSC-USD`,
    "The estimated BSC network fee will be deducted from the BSC-USD payout before it is sent.",
    `Remaining balance: ${remainingBalanceXtu.toFixed(8)} XTU`,
    `Reference: ${reference}`,
    "Status: PROCESSING",
  ].join("\n"));
  return {
    transf: "processing",
    disbursement_mode: "individual",
    disbursement_id: String(idRows[0].id),
    gross_amount: calculation.grossAmountXtu.toFixed(18),
    fee_amount: calculation.feeAmount.toFixed(18),
    payout_amount: calculation.payoutAmount.toFixed(18),
    remaining_balance: remainingBalanceXtu.toFixed(18),
    payout_address: payoutAddress,
    locked_unit_price: calculation.priceValue.toFixed(30),
    message: "La demande individuelle est enregistrée. Le paiement BSC-USD sera envoyé après validation blockchain.",
  };
}

const DEPOSIT_HOLD_REASON_TEXT = {
  below_minimum: "The 60-minute session total has not reached the 70 BSC-USD minimum.",
  minimum_not_reached: "The 60-minute session total has not reached the 70 BSC-USD minimum.",
  initial_credit_limit: "The first credit tranche is capped at 100 BSC-USD. The remaining amount stays recorded and can be credited later without applying the 100 BSC-USD cap again.",
  maximum_user_balance: "Crediting the remaining amount would exceed the user's 300 XTU balance ceiling.",
  weekly_limit: "The seven-day system-reserve funding cooldown has not elapsed. Seller-reserve funding may still become available earlier; otherwise OneX retries when the cooldown expires.",
  weekly_receipt_limit: "The user's rolling seven-day BSC-USD receipt total exceeds 140 BSC-USD. This deposit remains pending until the earlier incoming amounts age out of the seven-day window.",
  manual_deposit_suspended: "Automatic deposit crediting is temporarily suspended by OneX administration.",
  payment_service_unavailable: "The deposit processing service is temporarily unavailable. The received funds remain recorded and will be retried when service resumes.",
  account_deactivated: "The account has been administratively deactivated. Existing uncredited deposit amounts and any new incoming transfers are held; automatic crediting remains paused until an administrator reactivates the account.",
  account_unavailable: "The account is unavailable or has not completed its first successful sign-in. Contact OneX support to resolve the account status; the received amount remains pending.",
  system_reserve: "Available distributable reserves are not currently sufficient. OneX retries automatically when reserves become available.",
  previous_batch_unresolved: "An older deposit remains in the FIFO queue and must be processed first.",
  outside_initial_grouping_window: "The 30-day maximum initial grouping period has expired. This transfer remains on hold for support review and will not reopen the expired session automatically.",
  received_after_global_disbursement_cutoff: "The transfer arrived after the global disbursement cutoff and requires administrative handling.",
  disbursement_pending: "A disbursement is still pending. The deposit will be retried when the account operation is resolved.",
};

function getReasonText(reasonCodes) {
  return reasonCodes.map((code) => DEPOSIT_HOLD_REASON_TEXT[code] || "This deposit remains pending for an operational review.");
}

function formatTelegramUtc(ms) {
  const value = Number(ms);
  return Number.isFinite(value) ? new Date(value).toISOString() : "Unavailable";
}

async function queueDepositBatchStatusTx(
  tx,
  username,
  batchId,
  status,
  reasonCodes = [],
  releaseAtMs = null,
  details = {},
) {
  const reasons = Array.isArray(reasonCodes) ? [...new Set(reasonCodes)] : [];
  const stateFingerprint = crypto.createHash("sha256").update(JSON.stringify({
    status,
    reasons,
    remaining: details.remainingAmount || null,
    credited: details.creditedAmount || null,
    sequence: details.creditSequence || null,
    transfer: details.txHash || null,
  })).digest("hex").slice(0, 16);
  const eventKey = `deposit:batch:${batchId}:${status}:${stateFingerprint}`;
  const lines = [
    "OneX Deposit Update",
    `Deposit batch: ${batchId}`,
    `Status: ${String(status).toUpperCase()}`,
  ];
  if (details.txHash) {
    lines.push(`Transaction: ${details.txHash}`);
    lines.push("Your incoming BSC-USD payment has been finalized on BNB Smart Chain and recorded by OneX.");
  }
  if (details.receivedAmount) lines.push(`Just received: ${details.receivedAmount} BSC-USD`);
  if (details.sessionTotal) lines.push(`Session total received: ${details.sessionTotal} BSC-USD`);
  if (details.creditedAmount != null) lines.push(`Total gross amount already credited: ${details.creditedAmount} BSC-USD`);
  if (details.remainingAmount != null) lines.push(`Amount still pending: ${details.remainingAmount} BSC-USD`);
  if (reasons.length) lines.push("Reason:", ...getReasonText(reasons));
  if (releaseAtMs != null) lines.push(`Next automatic retry no earlier than (UTC): ${formatTelegramUtc(releaseAtMs)}`);

  if (status === "collecting" || status === "batched") {
    lines.push("Current hold reason: the 60-minute grouping session is still open. OneX will calculate the exact first credit tranche after this window closes, using your account's XTU capacity, distributable reserves and applicable restrictions.");
  }
  if (reasons.includes("below_minimum") || reasons.includes("minimum_not_reached")) {
    lines.push("Suggested action: while the session is open, you may send another payment from your registered wallet to bring the total to at least 70 BSC-USD. If the session has already closed below the minimum, a later payment can reopen the pending minimum session. The existing amount remains recorded.");
  }
  if (reasons.includes("maximum_user_balance")) {
    lines.push("Suggested action: do not send another payment for this pending amount. Wait until your eligible XTU balance capacity is released; OneX retries automatically after balance changes.");
  }
  if (reasons.includes("system_reserve")) {
    lines.push("Suggested action: no additional payment is required. Wait for distributable reserves to become available; OneX retries automatically.");
  }
  if (reasons.includes("weekly_limit")) {
    lines.push("Suggested action: no additional payment is required. Wait for the applicable seven-day cooldown; OneX retries automatically when it expires.");
  }
  if (reasons.includes("weekly_receipt_limit")) {
    lines.push("Suggested action: do not send another deposit while the rolling seven-day receipt limit is exceeded. OneX will recheck automatically after earlier transfers age out of the seven-day window.");
  }
  if (reasons.includes("manual_deposit_suspended")) {
    lines.push("Suggested action: do not send another payment while deposits are suspended. The recorded amount will be reconsidered when the administration resumes the service.");
  }
  if (reasons.includes("account_deactivated")) {
    lines.push("Suggested action: your account has been administratively deactivated. Do not send another payment. Contact OneX support and wait for an administrator to reactivate the account; automatic deposit processing will resume after reactivation when all other credit conditions are met.");
  }
  if (reasons.includes("account_unavailable")) {
    lines.push("Suggested action: contact OneX support to resolve the account status. Do not send another payment until the account is available.");
  }
  if (details.accountReactivated) {
    lines.push("Account access has been restored. OneX has immediately requeued this pending deposit for automatic eligibility checks; credit remains subject to the session window, FIFO order, account balance capacity and available reserves.");
  }
  if (reasons.includes("initial_credit_limit")) {
    lines.push("Suggested action: no additional payment is required for the retained remainder. The first credit tranche is capped at 100 BSC-USD; the remainder will be retried automatically without reapplying the 100 BSC-USD tranche cap or the 70 BSC-USD minimum reception threshold when account and reserve capacity permit.");
  }
  if (reasons.includes("payment_service_unavailable")) {
    lines.push("Suggested action: no further payment is required. Keep the payment reference; OneX will retry processing when the payment service is restored.");
  }
  if (reasons.includes("disbursement_pending")) {
    lines.push("Suggested action: no additional payment is required. Wait until the pending disbursement is completed or reconciled; OneX will retry the deposit afterward.");
  }
  if (reasons.includes("previous_batch_unresolved")) {
    lines.push("Suggested action: do not send another payment for this reason. An older deposit is being processed first; OneX will retry this batch after the earlier pending batch is resolved.");
  }
  if (reasons.includes("outside_initial_grouping_window")) {
    lines.push("Suggested action: contact OneX support and provide this transaction reference. The initial 30-day grouping deadline has expired, so this transfer requires review.");
  }
  if (reasons.includes("received_after_global_disbursement_cutoff")) {
    lines.push("Suggested action: do not send another payment. Contact OneX support and provide this transaction reference because the transfer was received after the global-disbursement cutoff and requires administrative review.");
  }
  if (!reasons.length && (status === "collecting" || status === "batched")) {
    lines.push("Suggested action: no additional payment is required if the session total is at least 70 BSC-USD. Wait for the 60-minute session to close and for OneX to run the eligibility checks.");
  }

  lines.push("Incoming deposit tfees are applied only to each amount actually credited; OneX does not deduct BSC network gas from incoming deposits.");
  lines.push("A received deposit that remains pending cannot ordinarily be cancelled or refunded. OneX continues automatic processing when the applicable conditions are met; exceptional refunds require a user request and administrative approval under the Conditions of Use.");
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
    // Serialize incoming deposit intake against the global-run population snapshot.
    const [commonLockRows] = await tx.query(
      "SELECT lock_name FROM system_locks WHERE lock_name='common_state' FOR UPDATE",
    );
    if (!commonLockRows.length) throw new Error("The common-state lock row has not been initialized");
    const [authRows] = await tx.query(
      `SELECT username,wallet_address,created_at_ms,last_login_at_ms,account_active
       FROM auths WHERE LOWER(wallet_address)=? LIMIT 1 FOR UPDATE`,
      [String(event.fromAddress || "").toLowerCase()],
    );
    if (!authRows.length) return { unknown: true };

    const account = authRows[0];
    const username = account.username;
    if (!event.unknownTransferId) {
      const createdAtMs = Number(account.created_at_ms);
      const eventTimestampMs = Number(event.blockTimestampMs);
      if (
        !Number.isSafeInteger(createdAtMs) || createdAtMs <= 0 ||
        !Number.isSafeInteger(eventTimestampMs) || eventTimestampMs <= 0 ||
        eventTimestampMs < Math.ceil(createdAtMs / 1000) * 1000
      ) {
        return { unknown: true, reason: "transfer_precedes_or_may_precede_wallet_registration" };
      }
    }
    if (event.unknownTransferId) {
      const [unknownRows] = await tx.query(
        `SELECT id,from_address,tx_hash,log_index,amount_raw,status
         FROM bsc_unknown_incoming_transfers WHERE id=? LIMIT 1 FOR UPDATE`,
        [event.unknownTransferId],
      );
      if (!unknownRows.length || unknownRows[0].status !== "pending_admin" ||
          String(unknownRows[0].from_address).toLowerCase() !== String(event.fromAddress).toLowerCase() ||
          String(unknownRows[0].tx_hash).toLowerCase() !== String(event.txHash).toLowerCase() ||
          Number(unknownRows[0].log_index) !== Number(event.logIndex) ||
          String(unknownRows[0].amount_raw) !== String(event.amountRaw)) {
        return { unknown: true, reason: "unknown_transfer_changed_or_already_resolved" };
      }
    }
    const eventIdentity = createBscEventIdentity(event.txHash, event.logIndex, event.blockHash);
    const [eventInsert] = await tx.query(
      `INSERT IGNORE INTO users_usdt_transfer_events
       (username,batch_id,treasury_address,from_address,amount,amount_raw,tx_hash,log_index,
        block_number,block_hash,block_timestamp_ms,status,reason_codes,event_identity,created_at_ms)
       VALUES(?,NULL,?,?,?,?,?,?,?,?,?,'detected',NULL,?,?)`,
      [
        username,
        event.treasuryAddress,
        event.fromAddress,
        amountValue.toFixed(18),
        event.amountRaw,
        event.txHash,
        event.logIndex,
        event.blockNumber,
        event.blockHash,
        String(event.blockTimestampMs),
        eventIdentity,
        String(Date.now()),
      ],
    );
    if (eventInsert.affectedRows !== 1) return { duplicate: true };

    const [stockRows] = await tx.query(
      "SELECT balance FROM users_stock WHERE username=? LIMIT 1 FOR UPDATE", [username],
    );

    const now = Date.now();
    const [globalRunRows] = await tx.query(
      `SELECT id,status,effective_at_ms FROM global_disbursement_runs
       WHERE status IN ('announced','active','closed','manual_review','completed','resolved')
       ORDER BY id DESC LIMIT 1 FOR UPDATE`,
    );
    const globalRun = globalRunRows[0] || null;
    const [depositControlRows] = await tx.query(
      "SELECT is_suspended FROM deposit_service_control WHERE control_id=1 LIMIT 1 FOR UPDATE",
    );
    if (!depositControlRows.length) throw new Error("The deposit service control row has not been initialized");
    const manualDepositSuspended = Number(depositControlRows[0].is_suspended) === 1;
    const effectiveAt = globalRun ? Number(globalRun.effective_at_ms || 0) : 0;
    const cutoffStarted = Boolean(globalRun && isGlobalDisbursementEffective(globalRun.status));
    const transferAfterCutoff = Boolean(
      cutoffStarted && effectiveAt > 0 && Number(event.blockTimestampMs) >= effectiveAt,
    );
    const eventTimestampMs = Number(event.blockTimestampMs);
    const weeklyReceiptFloorMs = eventTimestampMs - DEPOSIT_COOLDOWN_MS;
    const [weeklyReceiptRows] = await tx.query(
      `SELECT COALESCE(SUM(amount),0) AS gross_amount,
              MIN(CAST(block_timestamp_ms AS UNSIGNED)) AS oldest_event_ms
       FROM users_usdt_transfer_events
       WHERE username=?
         AND CAST(block_timestamp_ms AS UNSIGNED)>?
         AND CAST(block_timestamp_ms AS UNSIGNED)<=?
         AND status NOT IN ('rejected','reversed')`,
      [username, String(weeklyReceiptFloorMs), String(eventTimestampMs)],
    );
    const weeklyReceiptGross = new BigNumber(weeklyReceiptRows[0]?.gross_amount || "0");
    const weeklyReceiptDecision = classifyRollingDepositReceipt(weeklyReceiptGross);
    const weeklyReceiptExceeded = !weeklyReceiptDecision.allowed;
    const weeklyReceiptReleaseAtMs = weeklyReceiptExceeded
      ? Math.max(now, Number(weeklyReceiptRows[0]?.oldest_event_ms || eventTimestampMs) + DEPOSIT_COOLDOWN_MS)
      : null;
    const [activeBatchRows] = (transferAfterCutoff || manualDepositSuspended || weeklyReceiptExceeded) ? [ [] ] : await tx.query(
      `SELECT * FROM users_usdt_deposit_batches
       WHERE username=? AND status IN ('collecting','pending_minimum')
       ORDER BY id ASC LIMIT 1 FOR UPDATE`,
      [username],
    );

    let batch = activeBatchRows[0] || null;
    let initialGroupingExpired = false;
    if (batch && batch.status === "collecting" && now >= Number(batch.expires_at_ms)) {
      await tx.query(
        "UPDATE users_usdt_deposit_batches SET status='ready',updated_at_ms=? WHERE id=? AND status='collecting'",
        [String(now), batch.id],
      );
      batch = null;
    }
    if (batch && batch.status === "pending_minimum") {
      const initialGroupDeadline = Number(batch.initial_group_deadline_ms || 0);
      if (!Number.isSafeInteger(initialGroupDeadline) || initialGroupDeadline <= 0 || eventTimestampMs > initialGroupDeadline) {
        initialGroupingExpired = true;
        batch = null;
      } else {
        const newExpiry = now + DEPOSIT_BATCH_WINDOW_MS;
        await tx.query(
          `UPDATE users_usdt_deposit_batches
           SET status='collecting',opened_at_ms=?,expires_at_ms=?,next_attempt_at_ms=NULL,
               reason_codes=NULL,updated_at_ms=? WHERE id=? AND status='pending_minimum'`,
          [String(now), String(newExpiry), String(now), batch.id],
        );
        batch.status = "collecting";
        batch.opened_at_ms = String(now);
        batch.expires_at_ms = String(newExpiry);
        batch.reason_codes = null;
      }
    }

    const accountDeactivated = Number(account.account_active) !== 1;
    const accountUnavailable = account.last_login_at_ms == null || !stockRows.length;
    let initialStatus = transferAfterCutoff
      ? "pending_global"
      : (manualDepositSuspended || initialGroupingExpired
        ? "pending_support" : (weeklyReceiptExceeded ? "pending_weekly" : "collecting"));
    let initialReasons = transferAfterCutoff
      ? ["received_after_global_disbursement_cutoff"]
      : (manualDepositSuspended ? ["manual_deposit_suspended"]
        : (initialGroupingExpired ? ["outside_initial_grouping_window"]
          : (weeklyReceiptExceeded ? ["weekly_receipt_limit"] : [])));
    if (accountDeactivated) {
      initialStatus = "pending_support";
      initialReasons.push("account_deactivated");
    }
    if (accountUnavailable) {
      initialStatus = "pending_support";
      initialReasons.push("account_unavailable");
    }

    if (!batch) {
      // The first finalized transfer fixes the tfees rate for this deposit session.
      const openedAt = now;
      const expiresAt = openedAt + DEPOSIT_BATCH_WINDOW_MS;
      const [batchInsert] = await tx.query(
        `INSERT INTO users_usdt_deposit_batches
         (username,treasury_address,opened_at_ms,expires_at_ms,initial_group_deadline_ms,total_amount,total_amount_raw,
          credited_amount,remaining_amount,refunded_amount,tfees_rate_percent,transfer_count,
          credit_sequence,minimum_met_at_ms,status,pending_since_ms,reason_codes,created_at_ms,updated_at_ms)
         VALUES(?,?,?,?,?,0,0,0,0,0,?,0,0,NULL,?,?,?,?,?)`,
        [
          username,
          event.treasuryAddress,
          String(openedAt),
          String(expiresAt),
          String(openedAt + 30 * 24 * 60 * 60 * 1000),
          String(tfees),
          initialStatus,
          initialStatus === "collecting" ? null : String(now),
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

    const nextStatus = (accountDeactivated || accountUnavailable || manualDepositSuspended || initialGroupingExpired)
      ? "pending_support"
      : (transferAfterCutoff ? "pending_global"
        : (weeklyReceiptExceeded ? "pending_weekly" : (batch.status === "collecting" ? "batched" : batch.status)));
    let reasonCodes = initialReasons;
    if (batch.reason_codes) {
      try {
        const parsedReasons = JSON.parse(batch.reason_codes);
        if (Array.isArray(parsedReasons)) reasonCodes = parsedReasons;
      } catch {
        reasonCodes = ["invalid_stored_reason_data"];
      }
    }
    const minimumMetAt = new BigNumber(batch.total_amount || "0").plus(amountValue).gte(MIN_DEPOSIT_AMOUNT)
      ? String(batch.minimum_met_at_ms || now)
      : null;
    await tx.query(
      `UPDATE users_usdt_deposit_batches
       SET total_amount=total_amount+?,total_amount_raw=total_amount_raw+?,
           remaining_amount=remaining_amount+?,transfer_count=transfer_count+1,
           minimum_met_at_ms=COALESCE(minimum_met_at_ms,?),updated_at_ms=?
       WHERE id=?`,
      [amountValue.toFixed(18), event.amountRaw, amountValue.toFixed(18), minimumMetAt, String(now), batch.id],
    );
    await tx.query(
      `UPDATE users_usdt_transfer_events SET batch_id=?,status=?,reason_codes=? WHERE event_identity=?`,
      [batch.id, nextStatus, reasonCodes.length ? safeJson(reasonCodes) : null, eventIdentity],
    );

    const batchTotal = new BigNumber(batch.total_amount || 0).plus(amountValue);
    const immediateReasons = [...reasonCodes];
    if (batchTotal.lt(MIN_DEPOSIT_AMOUNT)) immediateReasons.push("minimum_not_reached");
    if (weeklyReceiptExceeded && nextStatus === "pending_weekly") immediateReasons.push("weekly_receipt_limit");
    if (weeklyReceiptExceeded && reasonCodes.includes("weekly_receipt_limit")) {
      await tx.query(
        `UPDATE users_usdt_deposit_batches SET next_attempt_at_ms=?,updated_at_ms=? WHERE id=?`,
        [String(weeklyReceiptReleaseAtMs), String(now), String(batch.id)],
      );
    }
    await queueDepositBatchStatusTx(
      tx,
      username,
      batch.id,
      nextStatus,
      immediateReasons,
      weeklyReceiptExceeded && reasonCodes.includes("weekly_receipt_limit") ? weeklyReceiptReleaseAtMs : null,
      {
        txHash: event.txHash,
        receivedAmount: amountValue.toFixed(8),
        sessionTotal: batchTotal.toFixed(8),
        creditedAmount: new BigNumber(batch.credited_amount || "0").toFixed(8),
        remainingAmount: new BigNumber(batch.remaining_amount || "0").plus(amountValue).toFixed(8),
      },
    );
    if (event.unknownTransferId) {
      const decisionReason = String(event.adminResolutionReason || "Wallet matched registered account");
      const adminUsername = String(event.adminUsername || "configured_admin");
      await tx.query(
        `UPDATE bsc_unknown_incoming_transfers
         SET status='assigned_to_account',decision_action='assign',decision_username=?,
             decision_reason=?,decided_by=?,decided_at_ms=?,updated_at_ms=?
         WHERE id=? AND status='pending_admin'`,
        [username, decisionReason, adminUsername, String(now), String(now), String(event.unknownTransferId)],
      );
      await tx.query(
        `INSERT INTO admin_payment_resolutions
         (admin_username,username,batch_id,unknown_transfer_id,action,initial_asset_amount,gross_amount,fee_amount,net_amount,payout_address,tx_hash,reason,created_at_ms)
         VALUES(?, ?, NULL, ?, 'unknown_assigned', 0, ?, 0, ?, NULL, ?, ?, ?)`,
        [adminUsername, username, event.unknownTransferId, amountValue.toFixed(18), amountValue.toFixed(18),
          event.txHash, decisionReason, String(now)],
      );
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
     WHERE batch_id=? AND status NOT IN ('refund_queued','refunded','refund_confirmed','ignored')`,
    [status, reasonCodes ? safeJson(reasonCodes) : null, batchId],
  );
}

async function closeStaleDepositRefundRequestsTx(tx, batchId, username, remainingAmount) {
  const remaining = new BigNumber(remainingAmount);
  if (!remaining.isFinite() || remaining.isNegative()) {
    throw new Error("Invalid deposit remainder while reconciling refund requests");
  }
  const now = String(Date.now());
  let status = null;
  let message = null;
  let adminReason = null;
  if (remaining.isZero()) {
    status = "auto_closed";
    adminReason = "The uncredited deposit remainder was fully credited before the refund request was approved.";
    message = [
      "OneX Exceptional Refund Request Update",
      "The pending deposit remainder has now been fully credited automatically.",
      "Your refund request has therefore been closed because no uncredited amount remains to refund.",
      "The amount already credited to your XTU balance is not refundable under the pending-deposit refund procedure.",
    ].join("\n");
  } else {
    const threshold = MAX_INITIAL_CREDIT_TRANCHE_AMOUNT.multipliedBy(3);
    if (remaining.isLessThan(threshold)) {
      status = "remainder_changed";
      adminReason = "Automatic deposit credits reduced the uncredited remainder below the 300 BSC-USD threshold before administrative approval. A new emergency request may be submitted if the circumstances qualify.";
      message = [
        "OneX Exceptional Refund Request Update",
        `Automatic crediting changed the uncredited remainder to below ${threshold.toFixed(8)} BSC-USD.`,
        "The previous threshold-based refund request has been closed because its 300 BSC-USD eligibility condition is no longer met.",
        "If a genuine emergency applies, you may submit a new exceptional request with its reason; an emergency refund still requires explicit administrative approval.",
        "The pending deposit itself has not been cancelled and automatic credit processing continues.",
      ].join("\n");
    }
  }
  if (!status) return 0;
  const [requestRows] = await tx.query(
    `SELECT id,status FROM user_usdt_refund_requests
     WHERE batch_id=? AND status='pending_admin'
       AND (?='auto_closed' OR request_type='threshold') FOR UPDATE`,
    [String(batchId), status],
  );
  if (!requestRows.length) return 0;
  const [result] = await tx.query(
    `UPDATE user_usdt_refund_requests
     SET status=?,admin_reason=?,resolved_at_ms=?,updated_at_ms=?
     WHERE batch_id=? AND status='pending_admin'
       AND (?='auto_closed' OR request_type='threshold')`,
    [status, adminReason, now, now, String(batchId), status],
  );
  for (const request of requestRows) {
    await recordRefundRequestEventTx(tx, {
      requestId: request.id,
      eventKey: `refund-request:${request.id}:${status}`,
      eventType: status,
      actorType: "system",
      oldStatus: request.status,
      newStatus: status,
      reason: adminReason,
      grossAmount: remaining.toFixed(18),
      createdAtMs: now,
    });
  }
  if (Number(result.affectedRows || 0) > 0) {
    await queueTelegramMessageTx(tx, username,
      `deposit-refund-request:batch:${batchId}:${status}:${now}`, message);
  }
  return Number(result.affectedRows || 0);
}

async function isDepositBatchSafeDuringScannerReview(batchId) {
  const stateRows = await db.queryAsync(
    "SELECT health_status FROM bsc_incoming_scan_state WHERE singleton_id=1 LIMIT 1",
  );
  if (!stateRows.length || stateRows[0].health_status !== "manual_review") return true;
  const previewRows = await db.queryAsync(
    "SELECT id FROM bsc_scan_reconciliation_previews WHERE status='previewed' AND expires_at_ms>? ORDER BY id DESC LIMIT 1",
    [String(Date.now())],
  );
  if (!previewRows.length) return false;
  const unsafeRows = await db.queryAsync(
    `SELECT id FROM bsc_scan_reconciliation_items
     WHERE preview_id=? AND batch_id=?
       AND (classification IN ('orphaned','unverifiable'))
     LIMIT 1`,
    [previewRows[0].id, batchId],
  );
  return unsafeRows.length === 0;
}

async function processOneDepositBatch(batchId) {
  if (!(await isDepositBatchSafeDuringScannerReview(batchId))) {
    return { held: true, reason: "scanner_reconciliation_review" };
  }
  return withTransaction(async (tx) => {
    const [snapshotRows] = await tx.query(
      "SELECT username FROM users_usdt_deposit_batches WHERE id=? LIMIT 1",
      [batchId],
    );
    if (!snapshotRows.length) return { skipped: true };

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
        "UPDATE users_usdt_deposit_batches SET status='ready',updated_at_ms=? WHERE id=? AND status='collecting'",
        [String(now), batchId],
      );
      batch.status = "ready";
    }

    const retryableStatuses = [
      "ready", "finalizing", "pending_credit", "pending_weekly", "pending_reserve", "pending_support",
    ];
    if (!retryableStatuses.includes(batch.status)) return { skipped: true };
    const sessionExpiresAt = Number(batch.expires_at_ms || 0);
    if (batch.status !== "collecting" && Number.isSafeInteger(sessionExpiresAt) && sessionExpiresAt > now) {
      await tx.query(
        "UPDATE users_usdt_deposit_batches SET next_attempt_at_ms=?,updated_at_ms=? WHERE id=?",
        [String(sessionExpiresAt), String(now), String(batchId)],
      );
      return { waiting: true, reason: "deposit_session_window_open", nextAttemptAtMs: sessionExpiresAt };
    }
    if (batch.next_attempt_at_ms != null && Number(batch.next_attempt_at_ms) > now) {
      return { waiting: true, nextAttemptAtMs: Number(batch.next_attempt_at_ms) };
    }
    let batchReasonCodes = [];
    try {
      const parsed = batch.reason_codes ? JSON.parse(batch.reason_codes) : [];
      if (Array.isArray(parsed)) batchReasonCodes = parsed;
    } catch {
      batchReasonCodes = ["invalid_stored_reason_data"];
    }
    if (batchReasonCodes.includes("weekly_receipt_limit")) {
      const rollingFloor = now - DEPOSIT_COOLDOWN_MS;
      const [rollingRows] = await tx.query(
        `SELECT COALESCE(SUM(amount),0) AS gross_amount,
                MIN(CAST(block_timestamp_ms AS UNSIGNED)) AS oldest_event_ms
         FROM users_usdt_transfer_events
         WHERE username=? AND CAST(block_timestamp_ms AS UNSIGNED)>?
           AND status NOT IN ('rejected','reversed')`,
        [batch.username, String(rollingFloor)],
      );
      const rollingGross = new BigNumber(rollingRows[0]?.gross_amount || "0");
      const rollingDecision = classifyRollingDepositReceipt(rollingGross);
      if (!rollingDecision.allowed) {
        const oldestEventMs = Number(rollingRows[0]?.oldest_event_ms || now);
        const nextAttemptAt = Math.max(now + 30_000, oldestEventMs + DEPOSIT_COOLDOWN_MS);
        const stillHeldReasons = [...new Set([...batchReasonCodes, "weekly_receipt_limit"])];
        const holdStatus = batch.status === "pending_support" ? "pending_support" : "pending_weekly";
        await tx.query(
          `UPDATE users_usdt_deposit_batches SET status=?,next_attempt_at_ms=?,reason_codes=?,updated_at_ms=? WHERE id=?`,
          [holdStatus, String(nextAttemptAt), safeJson(stillHeldReasons), String(now), String(batchId)],
        );
        await updateBatchEventStatus(tx, batchId, holdStatus, stillHeldReasons);
        await queueDepositBatchStatusTx(tx, batch.username, batchId, holdStatus, stillHeldReasons, nextAttemptAt, {
          sessionTotal: new BigNumber(batch.total_amount || "0").toFixed(8),
          creditedAmount: String(batch.credited_amount || "0"),
          remainingAmount: String(batch.remaining_amount || "0"),
        });
        return { waiting: true, reason: "weekly_receipt_limit", nextAttemptAtMs: nextAttemptAt };
      }
      const remainingReasons = batchReasonCodes.filter((reason) => reason !== "weekly_receipt_limit");
      await tx.query(
        `UPDATE users_usdt_deposit_batches SET reason_codes=?,updated_at_ms=? WHERE id=?`,
        [remainingReasons.length ? safeJson(remainingReasons) : null, String(now), String(batchId)],
      );
    }

    const totalAmount = new BigNumber(batch.total_amount || "0");
    const creditedBefore = new BigNumber(batch.credited_amount || "0");
    const refundedBefore = new BigNumber(batch.refunded_amount || "0");
    let remainingAmount = new BigNumber(batch.remaining_amount == null
      ? totalAmount.minus(creditedBefore).minus(refundedBefore).minus(batch.reserved_refund_amount || "0")
      : batch.remaining_amount);
    if (![totalAmount, creditedBefore, refundedBefore, remainingAmount].every((value) => value.isFinite() && !value.isNegative())) {
      throw new Error(`Deposit batch ${batchId} contains invalid cumulative amounts`);
    }
    if (remainingAmount.isZero()) {
      await tx.query(
        `UPDATE users_usdt_deposit_batches
         SET status=?,reason_codes=NULL,next_attempt_at_ms=NULL,credited_at_ms=COALESCE(credited_at_ms,?),updated_at_ms=?
         WHERE id=?`,
        [refundedBefore.isGreaterThan(0) ? "refunded" : "credited", String(now), String(now), batchId],
      );
      return { completed: true, batchId: String(batchId) };
    }

    // Keep the oldest outstanding deposit first. A newer batch cannot bypass
    // an older pending minimum, account-capacity or reserve constraint.
    const [olderRows] = await tx.query(
      `SELECT id FROM users_usdt_deposit_batches
       WHERE username=? AND id<? AND remaining_amount>0
         AND status IN ('pending_minimum','pending_credit','pending_weekly','pending_reserve','pending_support','pending_global','ready','finalizing')
       ORDER BY id ASC LIMIT 1 FOR UPDATE`,
      [batch.username, String(batchId)],
    );
    if (olderRows.length) {
      const retryAt = now + 30_000;
      await tx.query(
        "UPDATE users_usdt_deposit_batches SET status=IF(status='ready','pending_credit',status),next_attempt_at_ms=?,updated_at_ms=? WHERE id=?",
        [String(retryAt), String(now), batchId],
      );
      return { waiting: true, reason: "older_deposit_pending", olderBatchId: String(olderRows[0].id) };
    }

    if (creditedBefore.isZero() && batch.minimum_met_at_ms == null && totalAmount.lt(MIN_DEPOSIT_AMOUNT)) {
      const reasons = ["minimum_not_reached"];
      await tx.query(
        `UPDATE users_usdt_deposit_batches
         SET status='pending_minimum',pending_since_ms=COALESCE(pending_since_ms,?),
             next_attempt_at_ms=NULL,reason_codes=?,updated_at_ms=? WHERE id=?`,
        [String(now), safeJson(reasons), String(now), batchId],
      );
      await updateBatchEventStatus(tx, batchId, "pending_minimum", reasons);
      await queueDepositBatchStatusTx(tx, batch.username, batchId, "pending_minimum", reasons, null, {
        sessionTotal: totalAmount.toFixed(8),
        creditedAmount: creditedBefore.toFixed(8),
        remainingAmount: remainingAmount.toFixed(8),
      });
      return { waiting: true, reason: "minimum_not_reached" };
    }

    if (batch.minimum_met_at_ms == null) {
      await tx.query(
        "UPDATE users_usdt_deposit_batches SET minimum_met_at_ms=?,updated_at_ms=? WHERE id=? AND minimum_met_at_ms IS NULL",
        [String(now), String(now), batchId],
      );
    }

    const [cutoffRows] = await tx.query(
      `SELECT status,effective_at_ms FROM global_disbursement_runs
       WHERE status IN ('announced','active','closed','manual_review','completed','resolved')
       ORDER BY id DESC LIMIT 1 FOR UPDATE`,
    );
    const cutoffStarted = cutoffRows.length > 0 && isGlobalDisbursementEffective(cutoffRows[0].status);
    const effectiveAt = cutoffStarted ? Number(cutoffRows[0].effective_at_ms || 0) : 0;
    const [eventTimeRows] = await tx.query(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN CAST(block_timestamp_ms AS UNSIGNED)>=? THEN 1 ELSE 0 END) AS post_effective
       FROM users_usdt_transfer_events WHERE batch_id=?`,
      [String(effectiveAt || Number.MAX_SAFE_INTEGER), batchId],
    );
    if (effectiveAt > 0 && Number(eventTimeRows[0]?.post_effective || 0) > 0) {
      const reasons = ["received_after_global_disbursement_cutoff"];
      await tx.query(
        `UPDATE users_usdt_deposit_batches SET status='pending_global',reason_codes=?,next_attempt_at_ms=NULL,updated_at_ms=? WHERE id=?`,
        [safeJson(reasons), String(now), batchId],
      );
      await updateBatchEventStatus(tx, batchId, "pending_global", reasons);
      await queueDepositBatchStatusTx(tx, batch.username, batchId, "pending_global", reasons, null, {
        sessionTotal: totalAmount.toFixed(8),
        creditedAmount: creditedBefore.toFixed(8),
        remainingAmount: remainingAmount.toFixed(8),
      });
      return { held: true, reason: "global_disbursement_cutoff" };
    }

    const initialCreditRemaining = creditedBefore.isZero()
      ? BigNumber.minimum(remainingAmount, MAX_INITIAL_CREDIT_TRANCHE_AMOUNT)
      : remainingAmount;
    const targetAmount = initialCreditRemaining;
    const [date, time] = formatUtcRecordDateTime(now);
    const sequence = Number(batch.credit_sequence || 0) + 1;
    if (!Number.isSafeInteger(sequence) || sequence < 1) throw new Error("Invalid deposit credit sequence");
    const reference = createFinancialReference(`TOP${batch.username}`);
    const creditResult = await applyUserTopUp(
      tx,
      batch.username,
      targetAmount,
      reference,
      date,
      time,
      now,
      {
        depositBatchId: batchId,
        preEffectiveBatch: true,
        enforceDepositRange: false,
        allowPartial: true,
        tfeesRatePercent: batch.tfees_rate_percent,
        priceCycleSource: "deposit",
      },
    );

    if (creditResult?.transf !== "sent") {
      let retryAt = now + 5 * 60 * 1000;
      let status = "pending_support";
      let reasons = ["account_unavailable"];
      let releaseAt = null;

      if (creditResult?.error === "account deactivated") {
        reasons = ["account_deactivated"];
        retryAt = null;
      } else if (creditResult?.error === "payment service disabled") {
        reasons = ["payment_service_unavailable"];
      } else if (creditResult?.error === "deposit manually suspended") {
        reasons = ["manual_deposit_suspended"];
      } else if (creditResult?.error === "global disbursement in progress") {
        status = "pending_reserve";
        reasons = ["system_reserve"];
      } else if (creditResult?.limit || creditResult?.error === "reserve unavailable" || creditResult?.error === "global bonus reserve unavailable during notice period") {
        status = "pending_reserve";
        reasons = ["system_reserve"];
        retryAt = now + 30_000;
      } else if (creditResult?.error === "weekly deposit limit reached") {
        status = "pending_weekly";
        reasons = ["weekly_limit"];
        const pendingSince = Number(batch.pending_since_ms || now);
        releaseAt = getWeeklyReleaseAt(pendingSince, creditResult.lastDepositMs);
        retryAt = Math.max(now + 30_000, releaseAt);
      } else if (creditResult?.error === "maximum user balance exceeded") {
        status = "pending_credit";
        reasons = ["maximum_user_balance"];
      } else if (creditResult?.error === "disbursement is pending") {
        status = "pending_credit";
        reasons = ["disbursement_pending"];
      } else if (creditResult?.error === "user not found") {
        status = "pending_support";
        reasons = ["account_unavailable"];
      } else {
        throw new Error(`Deposit batch credit failed: ${JSON.stringify(creditResult)}`);
      }
      if (creditedBefore.isZero() && totalAmount.gt(MAX_INITIAL_CREDIT_TRANCHE_AMOUNT) && !reasons.includes("initial_credit_limit")) {
        reasons.unshift("initial_credit_limit");
      }

      await tx.query(
        `UPDATE users_usdt_deposit_batches
         SET status=?,pending_since_ms=COALESCE(pending_since_ms,?),release_at_ms=?,
             next_attempt_at_ms=?,reason_codes=?,updated_at_ms=? WHERE id=?`,
        [status, String(now), releaseAt == null ? null : String(releaseAt), retryAt == null ? null : String(retryAt), safeJson(reasons), String(now), batchId],
      );
      await updateBatchEventStatus(tx, batchId, status, reasons);
      await queueDepositBatchStatusTx(tx, batch.username, batchId, status, reasons, releaseAt, {
        sessionTotal: totalAmount.toFixed(8),
        creditedAmount: creditedBefore.toFixed(8),
        remainingAmount: remainingAmount.toFixed(8),
      });
      return { waiting: true, status, reasons, retryAtMs: retryAt };
    }

    const creditedGross = new BigNumber(creditResult.gross_amount);
    const creditedFee = new BigNumber(creditResult.fee_amount);
    const creditedNet = creditedGross.minus(creditedFee);
    const creditedInitialAsset = new BigNumber(creditResult.credited_initial_asset);
    if (!creditedGross.isFinite() || !creditedGross.isGreaterThan(0) ||
        !creditedFee.isFinite() || creditedFee.isNegative() ||
        !creditedNet.isFinite() || !creditedNet.isGreaterThan(0) ||
        !creditedInitialAsset.isFinite() || !creditedInitialAsset.isGreaterThan(0) ||
        creditedGross.gt(remainingAmount) || creditedGross.gt(targetAmount)) {
      throw new Error(`Deposit batch ${batchId} returned an invalid partial-credit result`);
    }

    const creditedAfter = creditedBefore.plus(creditedGross);
    const remainingAfter = remainingAmount.minus(creditedGross);
    const nowString = String(now);
    await tx.query(
      `INSERT INTO users_usdt_deposit_credits
       (batch_id,username,credit_sequence,gross_amount,tfees_rate_percent,fee_amount,net_amount,
        credited_initial_asset,unit_price,financial_reference,created_at_ms)
       VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
      [
        String(batchId), batch.username, sequence, creditedGross.toFixed(18),
        String(batch.tfees_rate_percent), creditedFee.toFixed(18), creditedNet.toFixed(18),
        creditedInitialAsset.toFixed(30), String(creditResult.unit_price || "0"), reference, nowString,
      ],
    );

    let nextStatus = "credited";
    let nextReasons = [];
    let nextAttemptAt = null;
    if (remainingAfter.isGreaterThan(0)) {
      nextStatus = "pending_credit";
      nextAttemptAt = String(now + 5 * 60 * 1000);
      if (creditedBefore.isZero() && totalAmount.gt(MAX_INITIAL_CREDIT_TRANCHE_AMOUNT)) {
        nextReasons.push("initial_credit_limit");
      }
      if (creditResult.partialReason === "maximum_user_balance") {
        nextReasons.push("maximum_user_balance");
      } else if (creditResult.partialReason === "system_reserve") {
        nextReasons.push("system_reserve");
      } else if (creditResult.partialReason === "weekly_limit") {
        nextReasons.push("weekly_limit");
      }
      if (!nextReasons.length) nextReasons.push("maximum_user_balance");
    }

    await tx.query(
      `UPDATE users_usdt_deposit_batches
       SET credited_amount=?,remaining_amount=?,credit_sequence=?,status=?,reason_codes=?,
           next_attempt_at_ms=?,last_credit_at_ms=?,credited_at_ms=?,updated_at_ms=?
       WHERE id=?`,
      [
        creditedAfter.toFixed(18), remainingAfter.toFixed(18), sequence, nextStatus,
        nextReasons.length ? safeJson(nextReasons) : null, nextAttemptAt,
        nowString, remainingAfter.isZero() ? nowString : null, nowString, batchId,
      ],
    );
    await updateBatchEventStatus(tx, batchId, remainingAfter.isZero() ? "credited" : "pending_credit", nextReasons);
    await closeStaleDepositRefundRequestsTx(tx, batchId, batch.username, remainingAfter);
    await queueDepositBatchStatusTx(
      tx,
      batch.username,
      batchId,
      remainingAfter.isZero() ? "credited" : "pending_credit",
      nextReasons,
      nextAttemptAt,
      {
        creditedAmount: creditedAfter.toFixed(8),
        remainingAmount: remainingAfter.toFixed(8),
        creditSequence: sequence,
      },
    );
    await markPendingDepositBatchesDueTx(tx, batch.username, batchId);

    return {
      credited: true,
      partial: remainingAfter.isGreaterThan(0),
      batchId: String(batchId),
      creditSequence: sequence,
      grossCredited: creditedGross.toFixed(18),
      remaining: remainingAfter.toFixed(18),
      status: nextStatus,
    };
  });
}

let depositBatchWorkerTimer = null;
let depositBatchWorkerRunning = false;
const DEPOSIT_BATCH_WORKER_POLL_MS = Math.max(5000, Math.min(120000, Number(process.env.USDT_DEPOSIT_QUEUE_POLL_MS || 30000)));

function startDepositBatchWorker() {
  if (depositBatchWorkerTimer) return;
  const schedule = (delay = DEPOSIT_BATCH_WORKER_POLL_MS) => {
    if (depositBatchWorkerTimer) clearTimeout(depositBatchWorkerTimer);
    depositBatchWorkerTimer = setTimeout(() => {
      depositBatchWorkerTimer = null;
      void run();
    }, delay);
    if (typeof depositBatchWorkerTimer.unref === "function") depositBatchWorkerTimer.unref();
  };
  const run = async () => {
    if (depositBatchWorkerRunning) return schedule();
    depositBatchWorkerRunning = true;
    try {
      await processDepositBatchQueue();
    } catch (error) {
      console.error("Independent deposit batch worker failed:", error.message);
    } finally {
      depositBatchWorkerRunning = false;
      schedule();
    }
  };
  schedule(0);
}

async function processDepositBatchQueue() {
  const now = Date.now();
  const rows = await db.queryAsync(
    `SELECT id FROM users_usdt_deposit_batches
     WHERE (status='collecting' AND expires_at_ms<=?)
        OR status='ready'
        OR (status IN ('finalizing','pending_credit','pending_support','pending_reserve')
            AND (next_attempt_at_ms IS NULL OR next_attempt_at_ms<=?)
            AND CASE
              WHEN status='pending_support' AND JSON_VALID(reason_codes)=1
                THEN JSON_CONTAINS(reason_codes, JSON_QUOTE('account_deactivated'))=0
              ELSE 1
            END)
        OR (status='pending_weekly' AND (next_attempt_at_ms<=? OR release_at_ms<=?))
     ORDER BY id ASC LIMIT 50`,
    [String(now), String(now), String(now), String(now)],
  );
  for (const row of rows) {
    try {
      await processOneDepositBatch(row.id);
    } catch (error) {
      console.error(`Deposit batch ${row.id} failed:`, error.message);
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

const mailQueue = createEmailQueue(transporter);
let globalNoticeEmailWorkerStarted = false;
let globalNoticeEmailWorkerBusy = false;

async function processGlobalDisbursementEmailOutbox() {
  if (globalNoticeEmailWorkerBusy || !SERVER_MAIL || !SERVER_MAIL_PSWD) return;
  globalNoticeEmailWorkerBusy = true;
  try {
    const now = Date.now();
    await db.queryAsync(
      `UPDATE global_disbursement_email_outbox
       SET status='pending',claimed_at_ms=NULL,next_attempt_at_ms=?,
           last_error='Recovered an expired email worker claim.'
       WHERE status='sending' AND claimed_at_ms IS NOT NULL AND CAST(claimed_at_ms AS UNSIGNED)<=?`,
      [String(now), String(now - 10 * 60 * 1000)],
    );
    const rows = await db.queryAsync(
      `SELECT id,recipient,subject,message_text FROM global_disbursement_email_outbox
       WHERE status='pending' AND CAST(next_attempt_at_ms AS UNSIGNED)<=?
       ORDER BY id ASC LIMIT 1`,
      [String(now)],
    );
    if (!rows.length) return;
    const row = rows[0];
    const [claim] = await db.promise().query(
      `UPDATE global_disbursement_email_outbox
       SET status='sending',attempts=attempts+1,claimed_at_ms=?,last_error=NULL
       WHERE id=? AND status='pending'`,
      [String(now), row.id],
    );
    if (claim.affectedRows !== 1) return;
    try {
      await mailQueue.sendMail({
        from: SERVER_MAIL,
        to: row.recipient,
        subject: row.subject,
        text: row.message_text,
      });
      await db.queryAsync(
        `UPDATE global_disbursement_email_outbox
         SET status='sent',sent_at_ms=?,claimed_at_ms=NULL,last_error=NULL WHERE id=? AND status='sending'`,
        [String(Date.now()), row.id],
      );
    } catch (error) {
      const retryAt = Date.now() + (error.code === 'EMAIL_RATE_LIMIT' ? 60 * 60 * 1000 : 15 * 60 * 1000);
      await db.queryAsync(
        `UPDATE global_disbursement_email_outbox
         SET status='pending',next_attempt_at_ms=?,claimed_at_ms=NULL,last_error=?
         WHERE id=? AND status='sending'`,
        [String(retryAt), String(error.message || error).slice(0, 1000), row.id],
      );
    }
  } catch (error) {
    console.error("Global announcement email worker failed:", error.message);
  } finally {
    globalNoticeEmailWorkerBusy = false;
  }
}

function startGlobalDisbursementEmailOutbox() {
  if (globalNoticeEmailWorkerStarted) return;
  globalNoticeEmailWorkerStarted = true;
  void processGlobalDisbursementEmailOutbox();
  const timer = setInterval(() => void processGlobalDisbursementEmailOutbox(), 120 * 1000);
  if (typeof timer.unref === "function") timer.unref();
}

let accountSecurityEmailWorkerStarted = false;
let accountSecurityEmailWorkerBusy = false;

async function processAccountSecurityEmailOutbox() {
  if (accountSecurityEmailWorkerBusy || !SERVER_MAIL || !SERVER_MAIL_PSWD) return;
  accountSecurityEmailWorkerBusy = true;
  try {
    const now = Date.now();
    await db.queryAsync(
      `UPDATE account_security_email_outbox
       SET status='pending',claimed_at_ms=NULL,next_attempt_at_ms=?,
           last_error='Recovered an expired account-security email claim.'
       WHERE status='sending' AND claimed_at_ms IS NOT NULL AND CAST(claimed_at_ms AS UNSIGNED)<=?`,
      [String(now), String(now - 10 * 60 * 1000)],
    );
    const rows = await db.queryAsync(
      `SELECT id,recipient,subject,message_text,attempts FROM account_security_email_outbox
       WHERE status='pending' AND CAST(next_attempt_at_ms AS UNSIGNED)<=?
       ORDER BY id ASC LIMIT 1`,
      [String(now)],
    );
    if (!rows.length) return;
    const row = rows[0];
    const claim = await db.executeAsync(
      `UPDATE account_security_email_outbox
       SET status='sending',attempts=attempts+1,claimed_at_ms=?,last_error=NULL
       WHERE id=? AND status='pending'`,
      [String(now), row.id],
    );
    if (claim.affectedRows !== 1) return;

    try {
      await mailQueue.sendMail({
        from: SERVER_MAIL,
        to: row.recipient,
        subject: row.subject,
        text: row.message_text,
      });
      await db.executeAsync(
        `UPDATE account_security_email_outbox
         SET status='sent',sent_at_ms=?,claimed_at_ms=NULL,last_error=NULL
         WHERE id=? AND status='sending'`,
        [String(Date.now()), row.id],
      );
    } catch (error) {
      const nextAttempt = Number(row.attempts || 0) + 1;
      const permanentlyFailed = nextAttempt >= 8;
      const delayMs = error.code === "EMAIL_RATE_LIMIT"
        ? 60 * 60 * 1000
        : Math.min(60 * 60 * 1000, 15_000 * (2 ** Math.min(nextAttempt - 1, 7)));
      await db.executeAsync(
        `UPDATE account_security_email_outbox
         SET status=?,next_attempt_at_ms=?,claimed_at_ms=NULL,last_error=?
         WHERE id=? AND status='sending'`,
        [
          permanentlyFailed ? "failed" : "pending",
          String(Date.now() + delayMs),
          String(error.message || error).slice(0, 1000),
          row.id,
        ],
      );
    }
  } catch (error) {
    console.error("Account-security email worker failed:", error.message);
  } finally {
    accountSecurityEmailWorkerBusy = false;
  }
}

function startAccountSecurityEmailOutbox() {
  if (accountSecurityEmailWorkerStarted) return;
  accountSecurityEmailWorkerStarted = true;
  void processAccountSecurityEmailOutbox();
  const timer = setInterval(() => void processAccountSecurityEmailOutbox(), 5_000);
  if (typeof timer.unref === "function") timer.unref();
}

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

  if (!await requestTokenIsValid(req, tkn, P, U)) {
    return res.send({ status: "forbidden request" });
  }

  try {
    const passwordState = await getUserActivityPasswordState(U, P);
    if (passwordState === "deactivated") return res.send({ auths: "deactivated" });
    if (passwordState === "not_allowed") return res.send({ auth: "not allowed" });
    if (passwordState !== "ok") return res.send({ status: "error" });
    if (await accountApiLimitReached(res, U, "contact_onex", 3, DAY_MS)) return;
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
    await mailQueue.sendMail({
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
    nationality,
    residenceCountry,
    identityType,
    identityNumber,
    identityImage1,
    identityImage2,
    cni,
    pswd,
    seed,
    wallet_address,
    wallet,
    cniimg1,
    cniimg2,
  } = req.body || {};

  const ip = req.ip || req.socket.remoteAddress;
  const geo = geoip.lookup(ip);
  // IP geolocation is diagnostic only. It must never restrict signup by country.

  const submittedIdentityNumber = typeof identityNumber === "string" ? identityNumber : cni;
  const identity = validateSignupIdentity({
    nationality,
    residenceCountry,
    identityType,
    identityNumber: submittedIdentityNumber,
  });
  if (identity.error) {
    return res.status(400).send({ msg: identity.error });
  }

  const submittedWalletAddress = typeof wallet_address === "string" ? wallet_address.trim() :
    (typeof wallet === "string" ? wallet.trim() : "");
  let WalletAddress = "";
  if (!isEvmAddress(submittedWalletAddress) || /^0x0{40}$/i.test(submittedWalletAddress)) {
    return res.status(400).send({ auths: "addr error" });
  }
  try {
    WalletAddress = checksumEvmAddress(submittedWalletAddress);
  } catch {
    return res.status(400).send({ auths: "addr error" });
  }
  const treasuryAddressForSignup = String(
    process.env.USDT_BEP20_TREASURY_ADDRESS || process.env.USDT_BEP20_RECEIVER_ADDRESS || "",
  ).trim();
  if (treasuryAddressForSignup && WalletAddress.toLowerCase() === treasuryAddressForSignup.toLowerCase()) {
    return res.status(400).send({ auths: "addr error" });
  }

  const requiredTextValues = [email, birth, addr, name, pswd, seed];
  if (requiredTextValues.some((value) => typeof value !== "string")) {
    return res.status(400).send({ msg: "invalid input" });
  }

  const Email = email.trim().toLowerCase();
  const Birth = birth.trim();
  const rawAddress = addr.trim();
  const rawName = name.trim();
  const rawIdentityNumber = identity.identityNumber;
  if (
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(Email) || Buffer.byteLength(Email, "utf8") > 254 ||
    !Birth || Buffer.byteLength(Birth, "utf8") > 20 ||
    !rawAddress || Buffer.byteLength(rawAddress, "utf8") > 100 ||
    !rawName || Buffer.byteLength(rawName, "utf8") > 100 ||
    !pswd || !seed || Buffer.byteLength(pswd, "utf8") > 4096 || Buffer.byteLength(seed, "utf8") > 4096
  ) {
    return res.status(400).send({ msg: "invalid input" });
  }

  // The first image is required for both document types; the second image can contain additional or reverse-side details.
  const image1 = parseBase64Image(identityImage1 ?? cniimg1, "identity_document_1");
  const image2 = parseBase64Image(identityImage2 ?? cniimg2, "identity_document_2");
  if (image1 === false || image2 === false || !image1) {
    return res.status(400).send({ msg: "invalid identity image" });
  }

  let latinName;
  let latinAddress;
  try {
    // Transliterate free-form personal text before deriving usernames or storing data.
    latinName = transliterateUserText(rawName);
    latinAddress = transliterateUserText(rawAddress);
  } catch (error) {
    console.error("Signup text transliteration failed:", error);
    return res.status(400).send({ msg: "invalid input" });
  }

  if (!latinName || Buffer.byteLength(latinName, "utf8") > 50 || Buffer.byteLength(latinAddress, "utf8") > 50) {
    return res.status(400).send({ msg: "invalid name or address" });
  }

  const Address = latinAddress;
  const Name = latinName;
  const existingEmailRows = await db.queryAsync(
    "SELECT username FROM auths WHERE email=? LIMIT 1",
    [Email],
  );
  if (existingEmailRows.length) {
    return res.status(409).send({ msg: "email already registered" });
  }
  const encryptedIdentityNumber = encrypt(rawIdentityNumber, DB_CONFIG.password);
  let welcomeBonusSubjectHashes;
  try {
    welcomeBonusSubjectHashes = createWelcomeBonusSubjectHashes({
      email: Email,
      identityType: identity.identityType,
      nationality: identity.nationality,
      identityNumber: rawIdentityNumber,
      secret: WELCOME_BONUS_CLAIM_SECRET,
    });
  } catch (hashError) {
    console.error("Welcome-bonus lifetime identifier preparation failed:", hashError.message);
    return res.status(503).send({ msg: "signup temporarily unavailable" });
  }
  const passwordValue = pswd;
  const seedValue = seed;
  if (encryptedIdentityNumber.length > 255) {
    return res.status(400).send({ msg: "invalid identity document number" });
  }

  let PWD;
  let SEED;
  try {
    PWD = await hashSecret(passwordValue);
    SEED = await hashSecret(seedValue);
  } catch (hashError) {
    console.error("Signup secret hashing failed:", hashError);
    const status = ["ARGON2_QUEUE_FULL", "ARGON2_QUEUE_TIMEOUT"].includes(hashError.code) ? 503 : 400;
    return res.status(status).send({ msg: status === 503 ? "temporarily unavailable" : "invalid credentials" });
  }

  // The username column allows 30 characters, including the hyphen and six-character suffix.
  const prefix = getUserPrefixName(Name).slice(0, 23);
  if (!prefix) return res.status(400).send({ msg: "invalid name" });

  const [date, time] = getDate();
  let U;

  try {
    let accountCreated = false;
    for (let collisionAttempt = 0; collisionAttempt < 10; collisionAttempt += 1) {
      const suffix = createUserSuffixName();
      U = `${prefix}-${suffix}`.toUpperCase();

      const collisions = await db.queryAsync(
        `SELECT 1 AS collision FROM auths WHERE username=?
         UNION ALL
         SELECT 1 AS collision FROM activities WHERE sender=? OR receiver=?
         LIMIT 1`,
        [U, U, U],
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
        const [signupLockRows] = await connection.query(
          "SELECT lock_name FROM system_locks WHERE lock_name='common_state' FOR UPDATE",
        );
        if (!signupLockRows.length) throw new Error("The common-state lock row has not been initialized during signup");
        const [emailRows] = await connection.query(
          "SELECT username FROM auths WHERE email=? LIMIT 1 FOR UPDATE",
          [Email],
        );
        if (emailRows.length) {
          const emailConflict = new Error("The email address is already registered.");
          emailConflict.code = "ONEX_EMAIL_ALREADY_REGISTERED";
          throw emailConflict;
        }
        const walletLower = WalletAddress.toLowerCase();
        const [walletRows] = await connection.query(
          "SELECT username FROM bsc_wallet_address_registry WHERE wallet_address_lower=? LIMIT 1 FOR UPDATE",
          [walletLower],
        );
        if (walletRows.length) {
          const walletConflict = new Error("The BSC wallet address has already been registered.");
          walletConflict.code = "ONEX_WALLET_ALREADY_REGISTERED";
          throw walletConflict;
        }
        const [globalRunRows] = await connection.query(
          "SELECT status FROM global_disbursement_runs WHERE status IN ('active','closed','manual_review','completed','resolved') ORDER BY id DESC LIMIT 1 FOR UPDATE",
        );
        if (globalRunRows.length) {
          await connection.rollback();
          return res.status(423).send({ msg: "signup suspended during global disbursement" });
        }
        await connection.query(
          `INSERT IGNORE INTO account_registration_counters(counter_name,last_value)
           VALUES('registered_users',0)`,
        );
        const [registrationCounterRows] = await connection.query(
          `SELECT last_value FROM account_registration_counters
           WHERE counter_name='registered_users' LIMIT 1 FOR UPDATE`,
        );
        if (!registrationCounterRows.length) throw new Error("The account registration counter was not initialized");
        const registrationSequence = (BigInt(String(registrationCounterRows[0].last_value)) + 1n).toString();
        await connection.query(
          `UPDATE account_registration_counters SET last_value=?
           WHERE counter_name='registered_users'`,
          [registrationSequence],
        );

        const createdAtMs = String(Date.now());
        await connection.query(
          `INSERT INTO bsc_wallet_address_registry(wallet_address_lower,wallet_address,username,registered_at_ms)
           VALUES(?,?,?,?)`,
          [WalletAddress.toLowerCase(), WalletAddress, U, createdAtMs],
        );
        await connection.query(
          `INSERT INTO auths(
             registration_sequence,username,password,name,email,birthdate,nationality,residence_country,identity_document_type,
             identity_document_number,address,seed,wallet_address,welcome_bonus_email_hash,welcome_bonus_identity_hash,
             created_at_ms,last_login_at_ms,record_date,record_time
           ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [
            registrationSequence, U, PWD, Name, Email, Birth, identity.nationality, identity.residenceCountry,
            identity.identityType, encryptedIdentityNumber, Address, SEED, WalletAddress,
            welcomeBonusSubjectHashes.emailHash, welcomeBonusSubjectHashes.identityHash,
            createdAtMs, null, date, time,
          ],
        );
        await connection.query(
          "INSERT INTO users_stock(username,balance,record_date,record_time) VALUES(?,?,?,?)",
          [U, "0", date, time],
        );
        const signupCommon = await getLatestCommonTx(connection, true);
        await initializeUserPriceStateTx(connection, U, signupCommon.unit_price, tfees);
        await connection.commit();
      } catch (insertError) {
        if (conn) {
          try {
            await conn.promise().rollback();
          } catch (rollbackError) {
            console.error("Signup transaction rollback failed:", rollbackError);
          }
        }

        if (insertError.code === "ONEX_EMAIL_ALREADY_REGISTERED") {
          return res.status(409).send({ msg: "email already registered" });
        }
        if (insertError.code === "ONEX_WALLET_ALREADY_REGISTERED") {
          return res.status(409).send({ auths: "addr used" });
        }
        if (insertError.code === "ER_DUP_ENTRY") {
          const duplicateEmailRows = await db.queryAsync(
            "SELECT username FROM auths WHERE email=? LIMIT 1",
            [Email],
          );
          if (duplicateEmailRows.length) {
            return res.status(409).send({ msg: "email already registered" });
          }
          const duplicateWalletRows = await db.queryAsync(
            "SELECT username FROM bsc_wallet_address_registry WHERE wallet_address_lower=? LIMIT 1",
            [WalletAddress.toLowerCase()],
          );
          if (duplicateWalletRows.length) return res.status(409).send({ auths: "addr used" });
          continue;
        }
        throw insertError;
      } finally {
        if (conn) conn.release();
      }

      accountCreated = true;
      break;
    }
    if (!accountCreated) throw new Error("Unable to allocate a unique username after 10 attempts");

    res.send({ msg: "ok" });

    // Send only the generated username to the address supplied during signup.
    mailQueue.sendMail({
      from: SERVER_MAIL,
      to: Email,
      subject: "OneX username",
      text: U,
    }).catch((mailError) => {
      console.error("Welcome email failed:", mailError);
    });

    // Send identity documents for verification without modifying their encoded contents.
    mailQueue.sendMail({
      from: SERVER_MAIL,
      to: "eddy.heriniaina.rafidison@gmail.com",
      subject: "Account Verification",
      text: [
        `Username: ${U}`,
        `Name: ${Name}`,
        `Birth date: ${Birth}`,
        `Address: ${Address}`,
        `Nationality: ${identity.nationality}`,
        `Residence country: ${identity.residenceCountry}`,
        `Identity document type: ${identity.identityType}`,
        `Identity document number: ${rawIdentityNumber}`,
        `IP geolocation country (informational only): ${geo?.country || "unavailable"}`,
      ].join("\n"),
      attachments: [image1, image2].filter(Boolean),
    }).catch((mailError) => {
      console.error("Identity verification email failed:", mailError);
    });
  } catch (e) {
    console.error("Signup failed:", e);
    if (!res.headersSent) res.send({ msg: "failed" });
  }
});

// Device challenge. The Android client signs the returned challenge using its Android Keystore P-256 key.
router.post("/app/device/challenge", async (req, res) => {
  const U = normalizeUsername(req.body?.user);
  const deviceId = normalizeDeviceId(req.body?.device_id);
  const publicKeyDer = normalizeFormValue(req.body?.device_public_key);
  if (!U || !deviceId || !publicKeyDer) {
    return res.status(400).send({ auth: "invalid device request" });
  }

  try {
    if (await accountApiLimitReached(res, U, "device_challenge", 10, 15 * 60_000)) return;
    const accountRows = await db.queryAsync(
      "SELECT account_active FROM auths WHERE username=? LIMIT 1",
      [U],
    );
    if (!accountRows.length) return res.send({ auth: "incorrect" });
    if (Number(accountRows[0].account_active) !== 1) return res.send({ auths: "deactivated" });

    const challenge = createDeviceChallenge({
      username: U,
      deviceId,
      publicKeyBase64: publicKeyDer,
      nowMs: Date.now(),
      ttlMs: DEVICE_CHALLENGE_TTL_MS,
    });
    const currentDeviceRows = await db.queryAsync(
      `SELECT device_id,public_key_fingerprint FROM auth_devices
       WHERE username=? LIMIT 1`,
      [U],
    );
    const registeredDevice = currentDeviceRows.length > 0 &&
      currentDeviceRows[0].device_id === challenge.deviceId &&
      currentDeviceRows[0].public_key_fingerprint === challenge.publicKeyFingerprint;

    await db.executeAsync(
      `INSERT INTO auth_device_challenges(
         challenge_id,username,device_id,public_key_der,public_key_fingerprint,
         challenge_value,expires_at_ms,used_at_ms,created_at_ms
       ) VALUES(?,?,?,?,?,?,?,NULL,?)`,
      [
        challenge.challengeId, U, challenge.deviceId, challenge.publicKeyDerBase64,
        challenge.publicKeyFingerprint, challenge.challenge, String(challenge.expiresAtMs),
        String(Date.now()),
      ],
    );

    return res.send({
      auth: "device challenge created",
      challenge_id: challenge.challengeId,
      challenge_message: challenge.message,
      expires_at_ms: challenge.expiresAtMs,
      device_registered: registeredDevice,
      seed_required: !registeredDevice,
    });
  } catch (error) {
    console.error("Device challenge creation failed:", error.message);
    return res.status(400).send({ auth: "invalid device key or request" });
  }
});

// Sign-in binds the account to exactly one Android Keystore device key.
router.post("/app/signin", async (req, res) => {
  const { user, pswd, seed, device_id, device_challenge_id, device_signature } = req.body || {};
  const U = normalizeUsername(user);
  const P = normalizeFormValue(pswd);
  const submittedSeed = normalizeFormValue(seed);
  const deviceId = normalizeDeviceId(device_id);
  const challengeId = typeof device_challenge_id === "string" ? device_challenge_id.trim() : "";
  const signature = typeof device_signature === "string" ? device_signature.trim() : "";

  if (
    !U || !P || Buffer.byteLength(P, "utf8") > 4096 || !deviceId ||
    !/^[A-Za-z0-9_-]{43}$/.test(challengeId) || !signature || signature.length > 512
  ) {
    return res.status(400).send({ msg: "invalid device sign-in request", ua: "", tg_botLink: null });
  }

  try {
    const challengeRows = await db.queryAsync(
      `SELECT challenge_id,username,device_id,public_key_der,public_key_fingerprint,
              challenge_value,expires_at_ms,used_at_ms
       FROM auth_device_challenges WHERE challenge_id=? AND username=? LIMIT 1`,
      [challengeId, U],
    );
    if (!challengeRows.length) return res.send({ msg: "device challenge expired", ua: "", tg_botLink: null });
    const challenge = challengeRows[0];
    const challengeExpiresAt = Number(challenge.expires_at_ms);
    if (
      challenge.used_at_ms != null || challenge.device_id !== deviceId ||
      !Number.isFinite(challengeExpiresAt) || challengeExpiresAt <= Date.now()
    ) return res.send({ msg: "device challenge expired", ua: "", tg_botLink: null });

    const challengeMessage = buildDeviceChallengeMessage({
      username: U,
      deviceId,
      publicKeyFingerprint: challenge.public_key_fingerprint,
      challengeId,
      challenge: challenge.challenge_value,
      expiresAtMs: challengeExpiresAt,
    });
    if (!verifyDeviceSignature(challenge.public_key_der, challengeMessage, signature)) {
      return res.send({ msg: "invalid device proof", ua: "", tg_botLink: null });
    }

    const bonusSnapshotRows = await db.queryAsync(
      "SELECT id,registration_sequence,welcome_bonus_status FROM auths WHERE username=? LIMIT 1",
      [U],
    );
    const bonusSnapshot = bonusSnapshotRows[0] || null;
    if (!bonusSnapshot) return res.send({ msg: "incorrect password", ua: "", tg_botLink: null });
    const mustLockCommonForBonus = Boolean(
      bonusSnapshot.welcome_bonus_status === "pending" &&
      Number(bonusSnapshot.registration_sequence) <= WELCOME_BONUS_BENEFICIARIES &&
      WELCOME_BONUS_AMOUNT_XTU.isGreaterThan(0)
    );

    const result = await withTransaction(async (tx) => {
      if (mustLockCommonForBonus) {
        const [commonLockRows] = await tx.query(
          "SELECT lock_name FROM system_locks WHERE lock_name='common_state' FOR UPDATE",
        );
        if (!commonLockRows.length) throw new Error("The common-state lock row has not been initialized");
      }

      const [rows] = await tx.query(
        `SELECT id,registration_sequence,username,password,seed,email,account_active,welcome_bonus_status,welcome_bonus_amount_xtu,
                welcome_bonus_email_hash,welcome_bonus_identity_hash,
                consec_failed_auth,password_temp_expires_at_ms,tg_userId,tg_chat_id
         FROM auths WHERE username=? LIMIT 1 FOR UPDATE`,
        [U],
      );
      if (!rows.length) return { response: { msg: "incorrect password", ua: "", tg_botLink: null } };
      const row = rows[0];
      const now = Date.now();
      const passwordMatches = await verifySecret(row.password, P);
      if (passwordMatches && Number(row.account_active) !== 1) {
        return { response: { auths: "deactivated" } };
      }

      const authDecision = evaluatePasswordAuthentication({
        failedCount: Number(row.consec_failed_auth || 0),
        temporaryPasswordExpiresAtMs: row.password_temp_expires_at_ms,
        passwordMatches,
        nowMs: now,
      });
      if (!authDecision.allowed) {
        let failureCount = Number(row.consec_failed_auth || 0);
        if (authDecision.incrementFailureCount) {
          failureCount = nextFailedAuthCount(failureCount);
          await tx.query("UPDATE auths SET consec_failed_auth=? WHERE username=?", [failureCount, U]);
        }
        const locked = authDecision.recoveryRequired || failureCount >= 3;
        return { response: { msg: locked ? "account recovery required" : "incorrect password", ua: "", tg_botLink: null, recovery_required: locked } };
      }

      const [challengeLockRows] = await tx.query(
        `SELECT challenge_id,username,device_id,public_key_der,public_key_fingerprint,challenge_value,expires_at_ms,used_at_ms
         FROM auth_device_challenges WHERE challenge_id=? AND username=? LIMIT 1 FOR UPDATE`,
        [challengeId, U],
      );
      if (!challengeLockRows.length) return { response: { msg: "device challenge expired", ua: "", tg_botLink: null } };
      const lockedChallenge = challengeLockRows[0];
      const lockedExpiresAt = Number(lockedChallenge.expires_at_ms);
      if (
        lockedChallenge.used_at_ms != null || lockedChallenge.device_id !== deviceId ||
        !Number.isFinite(lockedExpiresAt) || lockedExpiresAt <= now
      ) return { response: { msg: "device challenge expired", ua: "", tg_botLink: null } };
      const lockedMessage = buildDeviceChallengeMessage({
        username: U,
        deviceId,
        publicKeyFingerprint: lockedChallenge.public_key_fingerprint,
        challengeId,
        challenge: lockedChallenge.challenge_value,
        expiresAtMs: lockedExpiresAt,
      });
      if (!verifyDeviceSignature(lockedChallenge.public_key_der, lockedMessage, signature)) {
        return { response: { msg: "invalid device proof", ua: "", tg_botLink: null } };
      }

      const [deviceRows] = await tx.query(
        `SELECT device_id,public_key_fingerprint FROM auth_devices
         WHERE username=? LIMIT 1 FOR UPDATE`,
        [U],
      );
      const previousDevice = deviceRows[0] || null;
      const sameDevice = Boolean(
        previousDevice && previousDevice.device_id === deviceId &&
        previousDevice.public_key_fingerprint === lockedChallenge.public_key_fingerprint
      );
      const requiresSeed = !sameDevice;
      if (requiresSeed) {
        if (!submittedSeed || Buffer.byteLength(submittedSeed, "utf8") > 4096) {
          return { response: { msg: "device registration requires seed", device_registration_required: true, ua: "", tg_botLink: null } };
        }
        await lockAccountSecurityActionTx(tx, U, "device_registration");
        const deviceCounts = await getRecentAccountSecurityEventsTx(tx, U, "device_registration", now);
        const deviceDecision = evaluateAccountActionLimit("device_registration", deviceCounts);
        if (!deviceDecision.allowed || !deviceDecision.canRecordFailure) {
          return { response: { msg: "device registration limit reached", recovery_required: false, ua: "", tg_botLink: null } };
        }
        const seedMatches = await verifySecret(row.seed, submittedSeed);
        if (!seedMatches) {
          await recordAccountSecurityEventTx(tx, U, "device_registration", "failed", now);
          await tx.query("UPDATE auth_device_challenges SET used_at_ms=? WHERE challenge_id=? AND used_at_ms IS NULL", [String(now), challengeId]);
          return { response: { msg: "incorrect seed", ua: "", tg_botLink: null } };
        }
        await recordAccountSecurityEventTx(tx, U, "device_registration", "successful", now);
      }

      await tx.query(
        "UPDATE auth_device_challenges SET used_at_ms=? WHERE challenge_id=? AND used_at_ms IS NULL",
        [String(now), challengeId],
      );

      const isTemporaryPassword = authDecision.passwordChangeRequired;
      const welcomeBonus = await applyWelcomeBonusAtFirstLoginTx(tx, row, now);
      if (authDecision.resetFailedAuthCount) {
        await tx.query("UPDATE auths SET consec_failed_auth=0 WHERE username=?", [U]);
      }

      const sessionToken = createSessionToken();
      const sessionTokenHash = hashSessionToken(sessionToken);
      const sessionExpiresAt = now + DEVICE_SESSION_TTL_MS;
      await tx.query(
        `INSERT INTO auth_devices(
           username,device_id,public_key_der,public_key_fingerprint,session_token_hash,
           session_expires_at_ms,registered_at_ms,last_seen_at_ms
         ) VALUES(?,?,?,?,?,?,?,?)
         ON DUPLICATE KEY UPDATE
           device_id=VALUES(device_id),public_key_der=VALUES(public_key_der),
           public_key_fingerprint=VALUES(public_key_fingerprint),session_token_hash=VALUES(session_token_hash),
           session_expires_at_ms=VALUES(session_expires_at_ms),registered_at_ms=VALUES(registered_at_ms),
           last_seen_at_ms=VALUES(last_seen_at_ms)`,
        [
          U, deviceId, lockedChallenge.public_key_der, lockedChallenge.public_key_fingerprint,
          sessionTokenHash, String(sessionExpiresAt), String(now), String(now),
        ],
      );

      const eventType = !previousDevice ? "device_registered" : (sameDevice ? "session_renewed" : "device_replaced");
      const userAgent = String(req.headers["user-agent"] || "").slice(0, 512);
      const ipHash = crypto.createHash("sha256").update(String(req.ip || req.socket?.remoteAddress || "unknown")).digest("hex");
      await tx.query(
        `INSERT INTO auth_device_events(
           username,event_type,old_device_id,new_device_id,old_key_fingerprint,new_key_fingerprint,
           ip_hash,user_agent,reason,created_at_ms
         ) VALUES(?,?,?,?,?,?,?,?,?,?)`,
        [
          U, eventType, previousDevice?.device_id || null, deviceId,
          previousDevice?.public_key_fingerprint || null, lockedChallenge.public_key_fingerprint,
          ipHash, userAgent, requiresSeed ? "New Android device authorized with password and account seed." : "Registered Android device signed in.",
          String(now),
        ],
      );

      if (requiresSeed) {
        const replaced = Boolean(previousDevice);
        const eventKey = `device-security:${U}:${challengeId}`;
        const subject = replaced ? "OneX security alert: registered device replaced" : "OneX security alert: Android device registered";
        const notificationText = [
          "OneX Account Security",
          replaced ? "A new Android device has replaced the previously registered device." : "An Android device has been registered for your OneX account.",
          `Username: ${U}`,
          `New device reference: ${deviceId.slice(-8)}`,
          `Date (UTC): ${new Date(now).toISOString()}`,
          replaced
            ? "The previous device session has been revoked."
            : "This is the first Android device registered for this account.",
          "If you did not authorize this change, contact OneX support immediately and secure your account.",
        ].join("\n");
        await tx.query(
          `INSERT IGNORE INTO account_security_email_outbox(
             event_key,username,recipient,subject,message_text,status,attempts,
             next_attempt_at_ms,claimed_at_ms,last_error,created_at_ms,sent_at_ms
           ) VALUES(?,?,?,?,?,'pending',0,?,NULL,NULL,?,NULL)`,
          [eventKey, U, row.email, subject, notificationText, String(now), String(now)],
        );
        await queueTelegramMessageTx(tx, U, eventKey, notificationText);
      }

      const loginAtMs = String(now);
      await tx.query(
        "UPDATE auths SET last_login_at_ms=? WHERE username=? AND account_active=1",
        [loginAtMs, U],
      );
      const tgBotLink = await createTelegramBotLinkTx(tx, U, row);
      return {
        response: {
          msg: 1,
          tkn: sessionToken,
          device_id: deviceId,
          device_session_expires_at_ms: sessionExpiresAt,
          device_auth_version: 1,
          device_replaced: Boolean(previousDevice && !sameDevice),
          tg_botLink: tgBotLink,
          password_change_required: isTemporaryPassword,
          welcome_bonus: welcomeBonus,
        },
      };
    });

    return res.send(result.response);
  } catch (error) {
    console.error("Device-bound sign-in failed:", error);
    return res.send({ msg: "error", ua: "", tg_botLink: null });
  }
});

async function getXtuDepositPublicState(username) {
  const unavailable = {
    enabled: false,
    ready: false,
    depositAllowed: false,
    reason: "xtu_deposit_worker_disabled",
    mainWalletAddress: null,
    tokenAddress: null,
    registeredSenderWallet: null,
    minAmount: "70",
    maxAmount: "140",
    initialCreditCap: "100",
    globalDisbursementActive: false,
    globalRunId: null,
  };
  if (!isXtuDepositWorkerEnabled()) return unavailable;
  try {
    const settings = getXtuSettings();
    const [scanRows, accountRows, globalRows] = await Promise.all([
      db.queryAsync("SELECT * FROM xtu_deposit_scan_state WHERE singleton_id=1 LIMIT 1"),
      db.queryAsync("SELECT wallet_address,account_active FROM auths WHERE username=? LIMIT 1", [username]),
      db.queryAsync(
        `SELECT id,status,effective_at_ms FROM global_disbursement_runs
         WHERE status IN ('active','closed','manual_review','completed','resolved')
         ORDER BY id DESC LIMIT 1`,
      ),
    ]);
    const scan = scanRows[0] || null;
    const account = accountRows[0] || null;
    const scanIdentityMatches = Boolean(scan && Number(scan.chain_id) === 56 &&
      String(scan.token_contract).toLowerCase() === settings.tokenAddress.toLowerCase() &&
      String(scan.hot_wallet_address).toLowerCase() === settings.mainWalletAddress.toLowerCase());
    const caughtUp = Boolean(scanIdentityMatches && scan.last_scanned_block != null &&
      scan.last_finalized_block != null && BigInt(String(scan.last_scanned_block)) >= BigInt(String(scan.last_finalized_block)));
    const scannerReady = Boolean(scanIdentityMatches && scan.health_status === "healthy" && caughtUp);
    const registeredSenderWallet = String(account?.wallet_address || "").trim();
    const walletReady = Boolean(account && Number(account.account_active) === 1 && isEvmAddress(registeredSenderWallet));
    const run = globalRows[0] || null;
    const globalActive = Boolean(run && isGlobalDisbursementEffective(run.status));
    const enabled = Boolean(settings.depositWorkerEnabled);
    const ready = Boolean(enabled && scannerReady);
    return {
      enabled,
      ready,
      depositAllowed: Boolean(ready && walletReady),
      reason: !enabled ? "xtu_deposit_worker_disabled"
        : !scannerReady ? (scan?.health_status === "manual_review" ? "xtu_scanner_manual_review" : "xtu_scanner_not_ready")
          : !walletReady ? "registered_bsc_wallet_required" : null,
      mainWalletAddress: settings.mainWalletAddress,
      tokenAddress: settings.tokenAddress,
      registeredSenderWallet: walletReady ? registeredSenderWallet : null,
      minAmount: settings.depositMinAmount,
      maxAmount: settings.depositMaxAmount,
      initialCreditCap: settings.depositInitialCreditCap,
      globalDisbursementActive: globalActive,
      globalRunId: globalActive ? String(run.id) : null,
      minConfirmations: settings.minConfirmations,
      batchWindowMinutes: Math.floor(settings.depositBatchWindowMs / 60000),
      initialGroupingTimeoutDays: Math.floor(settings.depositInitialGroupingTimeoutMs / 86400000),
      pendingRetryDays: Math.floor(settings.depositPendingRetryMs / 86400000),
    };
  } catch (error) {
    return { ...unavailable, reason: `xtu_configuration_error:${String(error.message || error).slice(0, 120)}` };
  }
}

// user-last-stock
router.post("/app/user-last-stock", async (req, res) => {
  const { user, pswd, tkn } = req.body || {};
  const U = normalizeUsername(user);
  const P = normalizeFormValue(pswd);
  if (!await requestTokenIsValid(req, tkn, P, U))
    return res.send({ msg: "forbidden request" });

  try {
    const passwordState = await getUserActivityPasswordState(U, P);
    if (passwordState === "deactivated") return res.send({ auths: "deactivated" });
    if (passwordState === "not_allowed") return res.send({ auth: "not allowed" });
    if (passwordState !== "ok") return res.send({ msg: "error" });
    if (await accountApiLimitReached(res, U, "user_last_stock", 60, 60_000)) return;

    let depositAvailability = await assessUserDepositAvailability(U);
    const paymentConfig = getPaymentPublicConfig();
    const scannerStatus = paymentConfig.enabled
      ? await getIncomingScannerStatus(db)
      : { initialized: false, health_status: "disabled" };
    let scannerCaughtUp = false;
    if (scannerStatus.initialized && scannerStatus.last_finalized_block != null) {
      const scannedBlock = scannerStatus.last_scanned_block == null
        ? -1n : BigInt(String(scannerStatus.last_scanned_block));
      const finalizedBlock = BigInt(String(scannerStatus.last_finalized_block));
      scannerCaughtUp = scannedBlock >= finalizedBlock;
    }
    const depositScannerReady = Boolean(
      scannerStatus.initialized && scannerStatus.health_status === "healthy" && scannerCaughtUp,
    );
    const sharedTreasuryAddress = depositAvailability.allowed && paymentConfig.enabled && depositScannerReady
      ? paymentConfig.treasuryAddress
      : null;
    let depositAddress = getVisibleDepositAddress(depositAvailability, sharedTreasuryAddress);
    if (depositAddress) {
      const latestAvailability = await assessUserDepositAvailability(U);
      depositAvailability = latestAvailability;
      depositAddress = getVisibleDepositAddress(latestAvailability, sharedTreasuryAddress);
    }
    const stockRow = depositAvailability.stock;
    const commonRow = depositAvailability.common;
    if (!stockRow || !commonRow) return res.send({ msg: "error" });
    const pendingDepositRows = await db.queryAsync(
      `SELECT 1 AS pending
       FROM users_usdt_deposit_batches
       WHERE username=? AND remaining_amount>0
         AND status IN ('collecting','batched','ready','finalizing','pending_minimum',
                        'pending_credit','pending_weekly','pending_reserve','pending_support','pending_global')
       LIMIT 1`,
      [U],
    );
    const hasPendingDeposit = pendingDepositRows.length > 0;
    const xtuDepositState = await getXtuDepositPublicState(U);
    const pendingXtuRows = await db.queryAsync(
      `SELECT 1 AS pending FROM xtu_deposit_batches
       WHERE username=? AND status IN ('collecting','ready','finalizing','consolidated_pending_credit',
                                       'pending_minimum','pending_weekly','pending_support','pending_reserve')
       LIMIT 1`, [U],
    );
    const hasPendingXtuDeposit = pendingXtuRows.length > 0;

    const individualSnapshot = await withTransaction(async (tx) => {
      const [lockRows] = await tx.query(
        "SELECT lock_name FROM system_locks WHERE lock_name='common_state' FOR UPDATE",
      );
      if (!lockRows.length) throw new Error("The common-state lock row has not been initialized");
      const latestCommon = await getLatestCommonTx(tx, true);
      const latestUnitPrice = new BigNumber(latestCommon.unit_price);
      const verifiedPrice = calculateGlobalUnitPrice(
        latestCommon.total_units_price, latestCommon.backed_units, latestUnitPrice,
      );
      if (!latestUnitPrice.isFinite() || !latestUnitPrice.isGreaterThan(0) ||
          verifiedPrice.minus(latestUnitPrice).gt("0.000000000000000000000000000001")) {
        throw new Error("The current XTU price snapshot is inconsistent");
      }
      const [latestStockRows] = await tx.query(
        `SELECT balance,run_balance,seller_status,seller_expires_at_ms
         FROM users_stock WHERE username=? LIMIT 1 FOR UPDATE`, [U],
      );
      if (!latestStockRows.length) throw new Error(`User stock is missing for ${U}`);
      const latestBalance = new BigNumber(latestStockRows[0].balance);
      const latestRunBalance = new BigNumber(latestStockRows[0].run_balance || "0");
      if (!latestBalance.isFinite() || latestBalance.isNegative() ||
          !latestRunBalance.isFinite() || latestRunBalance.isNegative()) {
        throw new Error("Invalid user initial-asset balance");
      }
      if (!depositAvailability.globalEffective) {
        await triggerUserPriceThresholdTx(tx, U, latestUnitPrice, null, latestBalance);
      }
      const state = await getUserPriceStateTx(tx, U, true);
      if (!state) throw new Error(`Individual remuneration state is missing for ${U}`);
      return {
        state,
        common: latestCommon,
        stock: latestStockRows[0],
        unitPrice: latestUnitPrice,
        balanceInitial: latestBalance,
        runBalanceInitial: latestRunBalance,
      };
    });
    const unitPrice = individualSnapshot.unitPrice;
    const balanceInitial = individualSnapshot.balanceInitial;
    const runBalanceInitial = individualSnapshot.runBalanceInitial;
    const latestStock = individualSnapshot.stock;
    const individualValuation = calculateEffectiveIndividualPrice(
      individualSnapshot.state, balanceInitial, unitPrice, maxStockDefault,
    );
    const globalRun = depositAvailability.globalRun || null;
    const globalEffective = Boolean(depositAvailability.globalEffective);
    let individualPrice = individualValuation.price;
    let individualPriceStatus = individualValuation.status;
    let individualBasePrice = new BigNumber(individualSnapshot.state.base_price);
    let individualRemunerationRate = new BigNumber(individualSnapshot.state.remuneration_rate);
    let individualTargetPrice = new BigNumber(individualSnapshot.state.target_price);
    let globalParticipantSnapshot = null;

    if (globalEffective && globalRun) {
      const participantRows = await db.queryAsync(
        `SELECT snapshot_base_price,snapshot_remuneration_rate,snapshot_target_price,
                snapshot_unit_price,snapshot_price_status
         FROM global_disbursement_participants
         WHERE run_id=? AND username=? LIMIT 1`,
        [globalRun.id, U],
      );
      if (!participantRows.length) {
        throw new Error(`Global disbursement price snapshot is missing for ${U}`);
      }
      globalParticipantSnapshot = participantRows[0];
      individualPrice = new BigNumber(globalParticipantSnapshot.snapshot_unit_price);
      individualPriceStatus = String(globalParticipantSnapshot.snapshot_price_status);
      individualBasePrice = new BigNumber(globalParticipantSnapshot.snapshot_base_price);
      individualRemunerationRate = new BigNumber(globalParticipantSnapshot.snapshot_remuneration_rate);
      individualTargetPrice = new BigNumber(globalParticipantSnapshot.snapshot_target_price);
      if (!individualPrice.isFinite() || !individualPrice.isGreaterThan(0) ||
          !individualBasePrice.isFinite() || !individualRemunerationRate.isFinite() ||
          !individualTargetPrice.isFinite()) {
        throw new Error(`Invalid global disbursement price snapshot for ${U}`);
      }
    }

    const balanceXtu = initialAssetToXtu(balanceInitial, individualPrice);
    const runBalanceXtu = initialAssetToXtu(runBalanceInitial, individualPrice);
    const numericBalance = balanceXtu.toNumber();
    if (!Number.isFinite(numericBalance)) throw new Error("User XTU balance is outside the supported numeric range");
    const globalPhase = globalRun
      ? resolveGlobalDisbursementPhase(
        globalRun.status,
        globalRun.request_deadline_at_ms,
        globalRun.extension_deadline_at_ms,
        Date.now(),
      )
      : "closed";
    const globalRequestOpen = globalPhase !== "closed";
    const masterDisbursementEnabled = String(process.env.USDT_DISBURSEMENTS_ENABLED || "false").toLowerCase() === "true";
    const individualDisbursementEnabled = String(process.env.USDT_INDIVIDUAL_DISBURSEMENT_ENABLED || "false").toLowerCase() === "true";
    const globalDisbursementEnabled = String(process.env.USDT_GLOBAL_DISBURSEMENT_ENABLED || "false").toLowerCase() === "true";
    const onexDisbursementAllowed = globalRequestOpen
      ? masterDisbursementEnabled && globalDisbursementEnabled
      : (!globalEffective && masterDisbursementEnabled && individualDisbursementEnabled);

    res.send({
      msg: numericBalance,
      fees: tfees,
      deposit_addr: depositAddress,
      deposit_status: depositAddress ? "available" : "unavailable",
      deposit_allowed: Boolean(depositAddress),
      has_pending_deposit: hasPendingDeposit,
      has_pending_xtu_deposit: hasPendingXtuDeposit,
      xtu_deposit_allowed: xtuDepositState.depositAllowed,
      xtu_deposit_status: xtuDepositState.ready ? "available" : "unavailable",
      xtu_deposit_unavailable_reason: xtuDepositState.reason,
      xtu_deposit_addr: xtuDepositState.depositAllowed ? xtuDepositState.mainWalletAddress : null,
      xtu_sender_wallet: xtuDepositState.depositAllowed ? xtuDepositState.registeredSenderWallet : null,
      xtu_token_contract: xtuDepositState.depositAllowed ? xtuDepositState.tokenAddress : null,
      xtu_deposit_minimum: xtuDepositState.minAmount,
      xtu_deposit_maximum: xtuDepositState.maxAmount,
      xtu_deposit_initial_credit_cap: xtuDepositState.initialCreditCap,
      xtu_deposit_fee_percent: xtuDepositState.globalDisbursementActive ? "0" : new BigNumber(tfees).multipliedBy("0.75").toFixed(10),
      xtu_deposit_gas_fee_deducted: true,
      xtu_blockchain_transfer_fee_percent: "0.1",
      xtu_global_disbursement_active: xtuDepositState.globalDisbursementActive,
      deposit_unavailable_reason: depositAddress ? null : (
        !depositScannerReady && paymentConfig.enabled
          ? (scannerStatus.health_status === "manual_review"
            ? "deposit_scanner_manual_review"
            : (scannerStatus.initialized ? "deposit_scanner_catching_up" : "deposit_scanner_initializing"))
          : (depositAvailability.reason || "deposit_service_unavailable")
      ),
      minimum_deposit_amount: MIN_DEPOSIT_AMOUNT.toFixed(0),
      minimum_deposit_net_amount: depositAvailability.minimumNetAmount
        ? depositAvailability.minimumNetAmount.toFixed(18)
        : null,
      projected_minimum_deposit_balance_xtu: depositAvailability.projectedBalanceXtu
        ? depositAvailability.projectedBalanceXtu.toFixed(18)
        : null,
      global_disbursement: globalRun ? {
        status: globalRun.status,
        effective_at_ms: Number(globalRun.effective_at_ms),
        request_deadline_at_ms: globalRun.request_deadline_at_ms == null ? null : Number(globalRun.request_deadline_at_ms),
        extension_deadline_at_ms: globalRun.extension_deadline_at_ms == null ? null : Number(globalRun.extension_deadline_at_ms),
        request_phase: globalPhase,
        effective: Boolean(globalEffective || depositAvailability.globalEffective),
        deposit_allowed: Boolean(depositAddress),
        p2p_allowed: !(globalEffective || depositAvailability.globalEffective),
        onex_disbursement_allowed: onexDisbursementAllowed,
        // Keep the former field as a compatibility alias for existing clients.
        individual_sale_to_onex_allowed: onexDisbursementAllowed,
        individual_sale_minimum_xtu: globalRequestOpen ? "1" : (globalEffective ? null : "200"),
        disbursement_mode: globalRequestOpen ? "global" : (globalEffective ? null : "individual"),
        global_disbursement_bonus_percent: globalPhase === "primary"
          ? String(globalRun.bonus_rate_percent || "0")
          : "0",
      } : null,
      unit_price: individualPrice.toFixed(30),
      global_unit_price: unitPrice.toFixed(30),
      base_price: individualBasePrice.toFixed(30),
      remuneration_rate: individualRemunerationRate.toFixed(10),
      target_price: individualTargetPrice.toFixed(30),
      remuneration_status: individualPriceStatus,
      price_snapshot_mode: globalParticipantSnapshot ? "global_disbursement" : "live_individual",
      maximum_user_stock: maxStockDefault,
      stock_limit_reached: balanceXtu.gte(maxStockDefault),
      stock_purchases_allowed: !globalEffective && individualPriceStatus !== "capped" && balanceXtu.lt(maxStockDefault),
      stock_capacity_remaining: BigNumber.maximum(
        0, new BigNumber(maxStockDefault).minus(balanceXtu),
      ).toFixed(18),
      balance_initial_asset: balanceInitial.toFixed(30),
      seller_status: Number(latestStock.seller_status || 0),
      run_balance: runBalanceXtu.toFixed(18),
      run_balance_unit_price: individualPrice.toFixed(30),
      run_balance_initial_asset: runBalanceInitial.toFixed(30),
      seller_expires_at_ms: latestStock.seller_expires_at_ms == null ? null : Number(latestStock.seller_expires_at_ms),
    });
  } catch {
    res.send({ msg: "error" });
  }
});

// BEP-20 deposit information. Payment sessions are opened automatically after a finalized transfer is detected.
router.post("/app/deposit", async (req, res) => {
  const { user, pswd, tkn, asset } = req.body || {};
  const U = normalizeUsername(user);
  const P = normalizeFormValue(pswd);
  if (!await requestTokenIsValid(req, tkn, P, U)) return res.send({ msg: "not allowed" });
  try {
    const passwordState = await getUserActivityPasswordState(U, P);
    if (passwordState === "deactivated") return res.send({ auths: "deactivated" });
    if (passwordState === "not_allowed") return res.send({ auth: "not allowed" });
    if (passwordState !== "ok") return res.send({ msg: "not allowed" });
    if (await accountApiLimitReached(res, U, "deposit_info", 10, 60_000)) return;

    if (String(asset || "BSC-USD").trim().toUpperCase() === "XTU") {
      const state = await getXtuDepositPublicState(U);
      if (!state.depositAllowed) {
        return res.status(503).send({
          msg: "deposit unavailable", asset: "XTU", deposit_allowed: false,
          reason: state.reason || "xtu_deposit_unavailable",
        });
      }
      return res.send({
        msg: "ok", asset: "XTU", deposit_allowed: true,
        network: "BNB Smart Chain Mainnet", chain_id: 56,
        token: "XTU", token_decimals: 18,
        token_contract: state.tokenAddress,
        deposit_to_address: state.mainWalletAddress,
        registered_sender_wallet: state.registeredSenderWallet,
        minimum_amount: state.minAmount,
        maximum_amount: state.maxAmount,
        per_user_limit_days: 7,
        maximum_initial_credit_tranche_xtu: state.initialCreditCap,
        blockchain_transfer_fee_percent: "0.1",
        onex_deposit_fee_percent: state.globalDisbursementActive ? "0" : new BigNumber(tfees).multipliedBy("0.75").toFixed(10),
        onex_deposit_fee_rate_factor: "0.75",
        gas_fee_always_deducted: true,
        global_disbursement_active: state.globalDisbursementActive,
        global_run_id: state.globalRunId,
        batch_window_minutes: state.batchWindowMinutes,
        initial_grouping_timeout_days: state.initialGroupingTimeoutDays,
        pending_retry_days: state.pendingRetryDays,
        min_confirmations: state.minConfirmations,
        no_automatic_xtu_bsc_usd_conversion: true,
      });
    }

    const config = getPaymentPublicConfig();
    if (!config.enabled) {
      return res.status(503).send({ msg: "deposit unavailable", deposit_allowed: false, reason: "payment_service_disabled" });
    }

    const availability = await assessUserDepositAvailability(U);
    if (!availability.allowed) {
      const unavailableStatus = ["global_disbursement_active", "deposit_manually_suspended"].includes(availability.reason)
        ? 423
        : 409;
      return res.status(unavailableStatus).send({
        msg: "deposit unavailable",
        deposit_allowed: false,
        reason: availability.reason || "maximum_user_balance",
        minimum_deposit_amount: MIN_DEPOSIT_AMOUNT.toFixed(0),
        minimum_deposit_net_amount: availability.minimumNetAmount
          ? availability.minimumNetAmount.toFixed(18)
          : null,
        current_balance_xtu: availability.currentBalanceXtu
          ? availability.currentBalanceXtu.toFixed(18)
          : null,
        projected_minimum_deposit_balance_xtu: availability.projectedBalanceXtu
          ? availability.projectedBalanceXtu.toFixed(18)
          : null,
        maximum_user_stock: maxStockDefault,
      });
    }

    return res.send({
      msg: "ok",
      deposit_allowed: true,
      network: config.network,
      chain_id: config.chainId,
      token: config.tokenName,
      token_contract: config.tokenContract,
      minimum_amount: MIN_DEPOSIT_AMOUNT.toFixed(0),
      maximum_amount: MAX_DEPOSIT_AMOUNT.toFixed(0),
      maximum_initial_credit_tranche_bsc_usd: MAX_INITIAL_CREDIT_TRANCHE_AMOUNT.toFixed(0),
      maximum_amount_semantics: "first_credit_tranche_only; later pending remainder is not capped again",
      maximum_system_funded_amount: MAX_INITIAL_CREDIT_TRANCHE_AMOUNT.toFixed(0),
      seller_funding_priority: true,
      maximum_user_stock: maxStockDefault,
      batch_window_minutes: 60,
      automatic_detection: true,
    });
  } catch (error) {
    console.error("BEP-20 deposit information failed:", error.message);
    return res.send({ msg: "not allowed" });
  }
});

// Lightweight reserve-availability polling endpoint. Authentication uses the
// signed user-agent token; it deliberately avoids an Argon2 password re-hash on
// every one-second poll. A shared one-second cache prevents repeated reserve scans.
router.post("/app/deposit/availability", async (req, res) => {
  const { user, pswd, tkn, asset } = req.body || {};
  const U = normalizeUsername(user);
  const P = normalizeFormValue(pswd);
  if (!await requestTokenIsValid(req, tkn, P, U)) {
    return res.status(401).send({ msg: "not allowed" });
  }

  try {
    if (String(asset || "BSC-USD").trim().toUpperCase() === "XTU") {
      const state = await getXtuDepositPublicState(U);
      return res.send({
        asset: "XTU", deposit_allowed: state.depositAllowed,
        reason: state.reason,
        minimum_deposit_amount_xtu: state.minAmount,
        maximum_deposit_amount_xtu: state.maxAmount,
        maximum_initial_credit_tranche_xtu: state.initialCreditCap,
        batch_window_minutes: state.batchWindowMinutes || 60,
        pending_retry_days: state.pendingRetryDays || 7,
      });
    }
    const accountRows = await db.queryAsync(
      "SELECT account_active FROM auths WHERE username=? LIMIT 1",
      [U],
    );
    if (accountRows.length && Number(accountRows[0].account_active) !== 1) {
      return res.send({ auths: "deactivated" });
    }
    // This endpoint exposes only the aggregate public indicator, not account data.
    const snapshot = await getPublicDepositAvailability(db, {
      stockLimit,
      adminReserveRatio: SYSTEM_ADMIN_RESERVE_RATIO.toString(),
    });

    return res.send({
      available_reserve_xtu: snapshot.availableReserveXtu,
      minimum_deposit_amount_bsc_usd: MIN_DEPOSIT_AMOUNT.toFixed(0),
      maximum_deposit_amount_bsc_usd: MAX_DEPOSIT_AMOUNT.toFixed(0),
    });
  } catch (error) {
    console.error("Public deposit-availability lookup failed:", error.message);
    return res.status(503).send({
      available_reserve_xtu: null,
      minimum_deposit_amount_bsc_usd: MIN_DEPOSIT_AMOUNT.toFixed(0),
      maximum_deposit_amount_bsc_usd: MAX_DEPOSIT_AMOUNT.toFixed(0),
    });
  }
});

router.post("/app/deposit/status", async (req, res) => {
  const { user, pswd, batch_id, tkn, asset } = req.body || {};
  const U = normalizeUsername(user);
  const P = normalizeFormValue(pswd);
  if (!await requestTokenIsValid(req, tkn, P, U)) return res.send({ transf: "forbidden request" });
  const id = String(batch_id ?? "").trim();
  if (id && !/^\d{1,20}$/.test(id)) return res.status(400).send({ transf: "invalid request" });
  try {
    const passwordState = await getUserActivityPasswordState(U, P);
    if (passwordState === "deactivated") return res.send({ auths: "deactivated" });
    if (passwordState === "not_allowed") return res.send({ auth: "not allowed" });
    if (passwordState !== "ok") return res.send({ auth: "incorrect" });
    if (await accountApiLimitReached(res, U, "deposit_status", 30, 60_000)) return;
    if (String(asset || "BSC-USD").trim().toUpperCase() === "XTU") {
      const rows = id
        ? await db.queryAsync(
          `SELECT id,status,gross_amount,hot_wallet_received_amount,commission_amount,returned_amount,
                  credited_amount,gas_allocated_usd,gas_allocated_xtu,deposit_fee_amount,opened_at_ms,
                  expires_at_ms,release_at_ms,reason_codes,global_run_id,updated_at_ms
           FROM xtu_deposit_batches WHERE id=? AND username=? LIMIT 1`, [id, U],
        )
        : await db.queryAsync(
          `SELECT id,status,gross_amount,hot_wallet_received_amount,commission_amount,returned_amount,
                  credited_amount,gas_allocated_usd,gas_allocated_xtu,deposit_fee_amount,opened_at_ms,
                  expires_at_ms,release_at_ms,reason_codes,global_run_id,updated_at_ms
           FROM xtu_deposit_batches WHERE username=? ORDER BY id DESC LIMIT 1`, [U],
        );
      if (!rows.length) return res.send({ transf: "not_found", asset: "XTU" });
      const row = rows[0];
      const eventRows = await db.queryAsync(
        `SELECT tx_hash,log_index,gross_amount,net_amount,commission_amount,status
         FROM xtu_deposit_transfer_events WHERE batch_id=? ORDER BY block_number ASC,log_index ASC`, [String(row.id)],
      );
      let reasons = [];
      try { reasons = JSON.parse(row.reason_codes || "[]"); } catch { reasons = ["invalid_reason_codes"]; }
      const consolidationRows = await db.queryAsync(
        `SELECT tx_hash,status,estimated_gas_fee_usd,actual_gas_fee_usd,block_number
         FROM xtu_deposit_consolidations WHERE batch_id=? LIMIT 1`, [String(row.id)],
      );
      return res.send({
        transf: row.status, asset: "XTU", batch_id: String(row.id),
        gross_amount_xtu: String(row.gross_amount),
        hot_wallet_received_xtu: String(row.hot_wallet_received_amount),
        contract_commission_xtu: String(row.commission_amount),
        gross_returned_xtu: String(row.returned_amount),
        credited_xtu: String(row.credited_amount),
        gas_allocated_bsc_usd: String(row.gas_allocated_usd),
        gas_allocated_xtu: String(row.gas_allocated_xtu),
        onex_deposit_fee_xtu: String(row.deposit_fee_amount),
        opened_at_ms: Number(row.opened_at_ms), expires_at_ms: Number(row.expires_at_ms),
        release_at_ms: row.release_at_ms == null ? null : Number(row.release_at_ms),
        global_run_id: row.global_run_id == null ? null : String(row.global_run_id),
        reason_codes: reasons,
        transactions: eventRows.map((event) => ({
          tx_hash: event.tx_hash, log_index: Number(event.log_index),
          gross_xtu: String(event.gross_amount), net_xtu: String(event.net_amount),
          commission_xtu: String(event.commission_amount), status: event.status,
        })),
        consolidation: consolidationRows[0] ? {
          tx_hash: consolidationRows[0].tx_hash, status: consolidationRows[0].status,
          estimated_gas_fee_bsc_usd: consolidationRows[0].estimated_gas_fee_usd,
          actual_gas_fee_bsc_usd: consolidationRows[0].actual_gas_fee_usd,
          block_number: consolidationRows[0].block_number == null ? null : Number(consolidationRows[0].block_number),
        } : null,
        updated_at_ms: Number(row.updated_at_ms),
      });
    }
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
    console.error("Deposit batch status lookup failed:", error.message);
    return res.send({ transf: "error" });
  }
});

// Submit an exceptional refund request for an uncredited deposit remainder.
// This records the user's request; it never initiates or signs a blockchain payment.
router.post("/app/deposit/refund-request", async (req, res) => {
  const { user, pswd, tkn, batch_id, reason } = req.body || {};
  const U = normalizeUsername(user);
  const P = normalizeFormValue(pswd);
  const batchId = String(batch_id ?? "").trim();
  const userReason = typeof reason === "string" ? reason.trim() : "";
  if (!await requestTokenIsValid(req, tkn, P, U)) return res.send({ transf: "forbidden request" });
  if (!/^\d{1,20}$/.test(batchId) || userReason.length < 10 || userReason.length > 2000) {
    return res.status(400).send({ transf: "invalid refund request" });
  }
  try {
    const passwordState = await getUserActivityPasswordState(U, P);
    if (passwordState === "deactivated") return res.send({ auths: "deactivated" });
    if (passwordState === "not_allowed") return res.send({ auth: "not allowed" });
    if (passwordState !== "ok") return res.send({ auth: "incorrect" });
    if (await accountApiLimitReached(res, U, "deposit_refund_request", 3, DAY_MS)) return;

    const result = await withTransaction(async (tx) => {
      const [batchRows] = await tx.query(
        `SELECT id,username,status,remaining_amount,credited_amount,refunded_amount,reserved_refund_amount,total_amount
         FROM users_usdt_deposit_batches
         WHERE id=? AND username=? LIMIT 1 FOR UPDATE`,
        [batchId, U],
      );
      if (!batchRows.length) return { transf: "deposit batch not found" };
      const batch = batchRows[0];
      const eligibleStatuses = new Set([
        "pending_minimum", "pending_credit", "pending_weekly", "pending_reserve", "pending_support", "pending_global",
      ]);
      if (!eligibleStatuses.has(String(batch.status))) {
        return { transf: "deposit is not eligible for an exceptional refund request" };
      }
      const remaining = new BigNumber(batch.remaining_amount == null ? new BigNumber(batch.total_amount)
        .minus(batch.credited_amount || 0).minus(batch.refunded_amount || 0).minus(batch.reserved_refund_amount || 0) : batch.remaining_amount);
      if (!remaining.isFinite() || !remaining.isGreaterThan(0)) {
        return { transf: "no uncredited deposit remainder" };
      }
      const [existingRows] = await tx.query(
        `SELECT id,request_reference,status FROM user_usdt_refund_requests
         WHERE batch_id=? AND status IN ('pending_admin','approved_queued','signed','submitted','manual_review')
         ORDER BY id DESC LIMIT 1 FOR UPDATE`,
        [batchId],
      );
      if (existingRows.length) {
        return {
          transf: "refund request already exists",
          request_id: String(existingRows[0].id),
          request_reference: existingRows[0].request_reference,
          status: existingRows[0].status,
        };
      }
      const threshold = MAX_INITIAL_CREDIT_TRANCHE_AMOUNT.multipliedBy(3);
      const requestType = remaining.gte(threshold) ? "threshold" : "emergency";
      const requestReference = createFinancialReference(`URF${U}`);
      const now = String(Date.now());
      const [insertResult] = await tx.query(
        `INSERT INTO user_usdt_refund_requests
         (request_reference,username,batch_id,request_type,user_reason,status,created_at_ms,updated_at_ms)
         VALUES(?,?,?,?,?,'pending_admin',?,?)`,
        [requestReference, U, batchId, requestType, userReason, now, now],
      );
      await recordRefundRequestEventTx(tx, {
        requestId: insertResult.insertId,
        eventKey: `refund-request:${insertResult.insertId}:submitted`,
        eventType: "user_submitted",
        actorType: "user",
        actorUsername: U,
        newStatus: "pending_admin",
        reason: userReason,
        grossAmount: remaining.toFixed(18),
        createdAtMs: now,
      });
      await queueTelegramMessageTx(tx, U, `deposit-refund-request:${insertResult.insertId}:submitted`, [
        "OneX Exceptional Deposit Refund Request",
        "Your request has been recorded for administrative review. It is not yet approved and no refund transaction has been created.",
        `Deposit batch: ${batchId}`,
        `Request reference: ${requestReference}`,
        `Request category: ${requestType}`,
        `Uncredited remainder at request time: ${remaining.toFixed(8)} BSC-USD`,
        "Only the uncredited remainder can be considered. Any amount already credited to your XTU balance is excluded.",
        "The request does not cancel the deposit. Automatic credit processing may continue until an administrator approves a refund and reserves the amount.",
      ].join("\n"));
      return {
        transf: "refund_request_recorded",
        request_id: String(insertResult.insertId),
        request_reference: requestReference,
        request_type: requestType,
        status: "pending_admin",
      };
    });
    return res.send(result);
  } catch (error) {
    console.error("User deposit refund request failed:", error.message);
    return res.send({ transf: "error" });
  }
});

// The BSC wallet is fixed at signup and is used for deposits and all outgoing payments.
router.post("/app/set-payout-address", async (req, res) => {
  const { user, pswd, tkn } = req.body || {};
  const U = normalizeUsername(user);
  const P = normalizeFormValue(pswd);
  if (!await requestTokenIsValid(req, tkn, P, U)) return res.send({ auth: "forbidden request" });
  try {
    const passwordState = await getUserActivityPasswordState(U, P);
    if (passwordState === "deactivated") return res.send({ auths: "deactivated" });
    if (passwordState === "not_allowed") return res.send({ auth: "not allowed" });
    if (passwordState !== "ok") return res.send({ auth: "incorrect" });
    const rows = await db.queryAsync(
      "SELECT wallet_address FROM auths WHERE username=? AND account_active=1 LIMIT 1",
      [U],
    );
    if (!rows.length) return res.send({ auth: "not allowed" });
    return res.send({ auth: "wallet fixed at signup", wallet_address: rows[0].wallet_address });
  } catch (error) {
    console.error("Fixed wallet lookup failed:", error.message);
    return res.send({ auth: "error" });
  }
});

// Seller participation locks a fixed reference amount and contributes half of it to the seller reserve.
router.post("/app/join-system-sellers", async (req, res) => {
  const { user, pswd, tkn } = req.body || {};
  const U = normalizeUsername(user);
  const P = normalizeFormValue(pswd);
  if (!await requestTokenIsValid(req, tkn, P, U)) return res.send({ msg: "not allowed" });
  try {
    const passwordState = await getUserActivityPasswordState(U, P);
    if (passwordState === "deactivated") return res.send({ auths: "deactivated" });
    if (passwordState === "not_allowed") return res.send({ auth: "not allowed" });
    if (passwordState !== "ok") return res.send({ msg: "not allowed" });
    if (await accountApiLimitReached(res, U, "join_system_sellers", 3, DAY_MS)) return;

    const result = await withTransaction(async (tx) => {
      const [commonLockRows] = await tx.query(
        "SELECT lock_name FROM system_locks WHERE lock_name=? FOR UPDATE", ["common_state"],
      );
      if (!commonLockRows.length) throw new Error("The common-state lock row has not been initialized");
      const common = await getLatestCommonTx(tx, true);
      const [activeGlobalRuns] = await tx.query(
        "SELECT id,status FROM global_disbursement_runs WHERE status IN ('announced','active','closed','manual_review','completed','resolved') ORDER BY id DESC LIMIT 1 FOR UPDATE",
      );
      if (activeGlobalRuns.length && isGlobalDisbursementEffective(activeGlobalRuns[0].status)) {
        return { msg: "not allowed", reason: "global_disbursement_in_progress" };
      }
      const unitPrice = new BigNumber(common.unit_price);
      const [authRows] = await tx.query(
        "SELECT last_login_at_ms,account_active,consec_failed_auth,password_temp_expires_at_ms FROM auths WHERE username=? LIMIT 1 FOR UPDATE",
        [U],
      );
      if (authRows.length && Number(authRows[0].account_active) !== 1) return { auths: "deactivated" };
      if (!authRows.length || authRows[0].last_login_at_ms == null) return { msg: "not allowed" };
      if (isPasswordProtectedActivityLocked({
        failedCount: Number(authRows[0].consec_failed_auth || 0),
        temporaryPasswordExpiresAtMs: authRows[0].password_temp_expires_at_ms,
      })) return { auth: "not allowed" };

      const [stockRows] = await tx.query(
        "SELECT balance,seller_status FROM users_stock WHERE username=? LIMIT 1 FOR UPDATE", [U],
      );
      if (!stockRows.length) return { msg: "not allowed" };
      if (Number(stockRows[0].seller_status || 0) !== 0) return { msg: "not allowed", reason: "seller_status_active" };

      const [pendingRows] = await tx.query(
        `SELECT id FROM users_usdt_disbursements
         WHERE username=? AND status IN ('queued','signed','submitted','manual_review')
         LIMIT 1 FOR UPDATE`, [U],
      );
      if (pendingRows.length) return { msg: "not allowed", reason: "disbursement_pending" };
      const [pendingXtuRows] = await tx.query(
        `SELECT id FROM xtu_withdrawals
         WHERE username=? AND status IN ('queued','signed','submitted','manual_review')
         LIMIT 1 FOR UPDATE`, [U],
      );
      if (pendingXtuRows.length) return { msg: "not allowed", reason: "xtu_withdrawal_pending" };

      // A threshold crossing must be applied synchronously before seller eligibility is checked.
      await triggerUserPriceThresholdTx(tx, U, unitPrice);
      const priceState = await getUserPriceStateTx(tx, U, true);
      if (!priceState) throw new Error(`Individual remuneration state is missing for ${U}`);
      const thresholdReached = priceState.status === "paused";
      const sellerIndividualPrice = calculateEffectiveIndividualPrice(
        priceState, stockRows[0].balance, unitPrice, maxStockDefault,
      ).price;
      const eligibility = validateSellerJoin(stockRows[0].balance, sellerIndividualPrice, thresholdReached);
      if (!eligibility.eligible) {
        return { msg: "not allowed", reason: eligibility.reason };
      }
      const priceCycleNumber = Number(priceState.cycle_number);
      if (!Number.isSafeInteger(priceCycleNumber) || priceCycleNumber < 1) {
        throw new Error("Invalid individual price cycle number");
      }

      const [previousRows] = await tx.query(
        `SELECT id FROM users_seller_campaigns
         WHERE username=? AND price_cycle_number=? LIMIT 1 FOR UPDATE`,
        [U, priceCycleNumber],
      );
      if (previousRows.length) return { msg: "not allowed", reason: "campaign_already_used_for_price_cycle" };

      const [walletRows] = await tx.query(
        `SELECT wallet_address,account_active FROM auths
         WHERE username=? LIMIT 1 FOR UPDATE`, [U],
      );
      const payoutAddress = walletRows[0]?.wallet_address || "";
      if (
        !walletRows.length || Number(walletRows[0].account_active) !== 1 ||
        !isEvmAddress(payoutAddress) || /^0x0{40}$/i.test(payoutAddress)
      ) return { msg: "not allowed", reason: "payout_wallet_required" };

      const sellersReserve = new BigNumber(common.sellers_res || "0");
      const totalRunBalance = new BigNumber(common.total_run_balance || "0");
      const newSellersReserve = sellersReserve.plus(eligibility.reservedInitialAsset);
      const newTotalRunBalance = totalRunBalance.plus(eligibility.runBalanceInitial);
      if (
        !sellersReserve.isFinite() || sellersReserve.isNegative() ||
        !totalRunBalance.isFinite() || totalRunBalance.isNegative() ||
        !newSellersReserve.isFinite() || !newTotalRunBalance.isFinite()
      ) throw new Error("Invalid seller reserve accounting values");

      const now = Date.now();
      const expiresAt = now + SELLER_STATUS_DURATION_MS;
      const [campaignResult] = await tx.query(
        `INSERT INTO users_seller_campaigns
         (username,run_balance,reserved_initial_asset,unit_price,price_cycle_number,sold_initial_asset,
          status,activated_at_ms,expires_at_ms,last_p2p_at_ms)
         VALUES(?,?,?,?,?,0,'active',?,?,?)`,
        [
          U,
          eligibility.runBalanceInitial.toFixed(30),
          eligibility.reservedInitialAsset.toFixed(30),
          sellerIndividualPrice.toFixed(30),
          String(priceCycleNumber),
          String(now),
          String(expiresAt),
          String(now),
        ],
      );
      await tx.query(
        `INSERT INTO users_seller_reserve_lots
         (campaign_id,username,original_initial_asset,remaining_initial_asset,unit_price,
          status,activated_at_ms,updated_at_ms)
         VALUES(?,?,?,?,?,'active',?,?)`,
        [
          campaignResult.insertId,
          U,
          eligibility.reservedInitialAsset.toFixed(30),
          eligibility.reservedInitialAsset.toFixed(30),
          sellerIndividualPrice.toFixed(30),
          String(now),
          String(now),
        ],
      );
      await tx.query(
        `UPDATE users_stock
         SET seller_status=1,run_balance=?,seller_activated_at_ms=?,seller_expires_at_ms=?,seller_last_p2p_at_ms=?
         WHERE username=?`,
        [eligibility.runBalanceInitial.toFixed(30), String(now), String(expiresAt), String(now), U],
      );
      const [date, time] = formatUtcRecordDateTime(now);
      await insertCommonSnapshotTx(tx, common, {
        sellers_res: newSellersReserve.toFixed(30),
        total_run_balance: newTotalRunBalance.toFixed(30),
      }, date, time);
      await queueTelegramMessageTx(tx, U, `seller-campaign:${campaignResult.insertId}:activated`, [
        "OneX Seller Update",
        "Your priority seller status is now active.",
        `Campaign: ${campaignResult.insertId}`,
        `Principal balance: ${eligibility.runBalanceXtu.toFixed(8)} XTU`,
        `Committed seller reserve (50%): ${eligibility.reservedInitialAsset.multipliedBy(sellerIndividualPrice).toFixed(8)} XTU`,
        `Individual valuation price locked: ${sellerIndividualPrice.toFixed(12)} XTU per initial asset`,
        `Price cycle: ${priceCycleNumber}`,
        `Expires (UTC): ${new Date(expiresAt).toISOString()}`,
        "Campaign activation is not counted toward the 5% grouped purchase or sale requirement.",
        "Status: ACTIVE",
      ].join("\n"));
      return {
        msg: "ok",
        campaign_id: String(campaignResult.insertId),
        seller_status: 1,
        run_balance: eligibility.runBalanceXtu.toFixed(18),
        run_balance_initial_asset: eligibility.runBalanceInitial.toFixed(30),
        reserved_units: eligibility.reservedInitialAsset.multipliedBy(sellerIndividualPrice).toFixed(18),
        reserved_initial_asset: eligibility.reservedInitialAsset.toFixed(30),
        unit_price: sellerIndividualPrice.toFixed(30),
        price_cycle_number: priceCycleNumber,
        expires_at_ms: expiresAt,
      };
    });
    return res.send(result);
  } catch (error) {
    console.error("Seller activation failed:", error.message);
    return res.send({ msg: "not allowed" });
  }
});

// Users may request cancellation; reserved units remain locked until the admin unlocks them.
router.post("/app/cancel-system-sellers", async (req, res) => {
  const { user, pswd, tkn } = req.body || {};
  const U = normalizeUsername(user);
  const P = normalizeFormValue(pswd);
  if (!await requestTokenIsValid(req, tkn, P, U)) return res.send({ msg: "not allowed" });
  try {
    const passwordState = await getUserActivityPasswordState(U, P);
    if (passwordState === "deactivated") return res.send({ auths: "deactivated" });
    if (passwordState === "not_allowed") return res.send({ auth: "not allowed" });
    if (passwordState !== "ok") return res.send({ msg: "not allowed" });
    if (await accountApiLimitReached(res, U, "cancel_system_sellers", 3, DAY_MS)) return;
    const result = await withTransaction(async (tx) => {
      const [authRows] = await tx.query(
        "SELECT last_login_at_ms,account_active,consec_failed_auth,password_temp_expires_at_ms FROM auths WHERE username=? LIMIT 1 FOR UPDATE",
        [U],
      );
      if (authRows.length && Number(authRows[0].account_active) !== 1) return { auths: "deactivated" };
      if (!authRows.length || authRows[0].last_login_at_ms == null) return { msg: "not allowed" };
      if (isPasswordProtectedActivityLocked({
        failedCount: Number(authRows[0].consec_failed_auth || 0),
        temporaryPasswordExpiresAtMs: authRows[0].password_temp_expires_at_ms,
      })) return { auth: "not allowed" };
      const [rows] = await tx.query(
        `SELECT id FROM users_seller_campaigns
         WHERE username=? AND status='active' ORDER BY id DESC LIMIT 1 FOR UPDATE`,
        [U],
      );
      if (!rows.length) return { msg: "not allowed" };
      const now = String(Date.now());
      await tx.query(
        "UPDATE users_seller_campaigns SET status='cancel_requested' WHERE id=? AND status='active'",
        [rows[0].id],
      );
      await tx.query("UPDATE users_stock SET seller_status=2 WHERE username=?", [U]);
      await queueTelegramMessageTx(tx, U, `seller-campaign:${rows[0].id}:cancel_requested`, [
        "OneX Seller Update",
        "Your seller cancellation request has been recorded. The remaining locked reserve will be released after OneX support unlocks it.",
        `Campaign: ${rows[0].id}`,
        "Status: CANCELLATION REQUESTED",
      ].join("\n"));
      return { msg: "cancellation_requested", campaign_id: String(rows[0].id), requested_at_ms: Number(now) };
    });
    return res.send(result);
  } catch (error) {
    console.error("Seller cancellation request failed:", error.message);
    return res.send({ msg: "error" });
  }
});

// Transaction history is limited to an exact rolling window of at most 30 days.
router.post("/app/transactions-history", async (req, res) => {
  const { user, pswd, days, limit: limitInput, before_id: beforeIdInput, tkn } = req.body || {};
  const U = normalizeUsername(user);
  const P = normalizeFormValue(pswd);
  if (!await requestTokenIsValid(req, tkn, P, U)) {
    return res.send({ trans: "forbidden request" });
  }

  const historyDays = normalizeTransactionHistoryDays(days);
  const pageLimit = limitInput == null || limitInput === "" ? 50 : Number(limitInput);
  const beforeId = beforeIdInput == null || beforeIdInput === "" ? "" : String(beforeIdInput).trim();
  if (
    historyDays === null ||
    !Number.isSafeInteger(pageLimit) || pageLimit < 1 || pageLimit > 100 ||
    (beforeId && !/^\d{1,20}$/.test(beforeId))
  ) {
    return res.status(400).send({ trans: "invalid request" });
  }

  try {
    const passwordState = await getUserActivityPasswordState(U, P);
    if (passwordState === "deactivated") return res.send({ auths: "deactivated" });
    if (passwordState === "not_allowed") return res.send({ auth: "not allowed" });
    if (passwordState !== "ok") return res.send({ trans: "error" });
    if (await accountApiLimitReached(res, U, "transactions_history", 20, 60_000)) return;

    const cutoffMs = getTransactionHistoryCutoffMs(Date.now(), historyDays);
    const [cutoffDate, cutoffTime] = formatUtcRecordDateTime(cutoffMs);
    const params = [cutoffDate, cutoffDate, cutoffTime, U, U];
    let sql = `SELECT id,sender,receiver,type,amount,unit_price,fees,reference,record_date,record_time
               FROM activities
               WHERE (record_date>? OR (record_date=? AND record_time>=?))
                 AND (sender=? OR receiver=?)`;
    if (beforeId) {
      sql += " AND id<?";
      params.push(beforeId);
    }
    sql += " ORDER BY id DESC LIMIT ?";
    params.push(pageLimit);

    const trans = await db.queryAsync(sql, params);
    const normalizedTransactions = trans.map((row) => {
      const initialAmount = new BigNumber(row.amount);
      const initialFees = new BigNumber(row.fees);
      const transactionPrice = new BigNumber(row.unit_price);
      if (
        !initialAmount.isFinite() || initialAmount.isNegative() ||
        !initialFees.isFinite() || initialFees.isNegative() ||
        !transactionPrice.isFinite() || !transactionPrice.isGreaterThan(0)
      ) throw new Error(`Activity ${row.id} contains invalid initial-asset amounts or historical price`);
      const amountXtu = initialAmount.multipliedBy(transactionPrice);
      const feesXtu = initialFees.multipliedBy(transactionPrice);
      return {
        ...row,
        id: String(row.id),
        amount_initial_asset: initialAmount.toFixed(30),
        fees_initial_asset: initialFees.toFixed(30),
        amount: amountXtu.toFixed(18),
        amount_xtu: amountXtu.toFixed(18),
        fees: feesXtu.toFixed(18),
        fees_xtu: feesXtu.toFixed(18),
        unit_price: transactionPrice.toFixed(30),
      };
    });
    const nextBeforeId = normalizedTransactions.length === pageLimit
      ? normalizedTransactions[normalizedTransactions.length - 1].id
      : null;

    return res.send({
      trans: normalizedTransactions,
      days: historyDays,
      limit: pageLimit,
      next_before_id: nextBeforeId,
    });
  } catch (error) {
    console.error("Transaction history lookup failed:", error.message);
    return res.send({ trans: "error" });
  }
});

// xtu-transfer
router.post("/app/xtu-transfer", async (req, res) => {
  const { sender, pswd, dest, amount, tkn } = req.body || {};
  const senderInput = normalizeUsername(sender);
  const P = normalizeFormValue(pswd);
  const destinationInput = normalizeUsername(dest);
  const amountText =
    typeof amount === "string" || typeof amount === "number"
      ? String(amount).trim()
      : "";

  if (!await requestTokenIsValid(req, tkn, P, senderInput)) {
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

  if (amountText.length > 100) {
    return res.status(400).send({ transf: "invalid amount" });
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
    if (await accountApiLimitReached(res, S, "near_transfer", 10, 60_000)) return;
    const verifiedPasswordHash = senderAuthRows[0].password;

    if (!Number.isFinite(tfees) || tfees < 0 || tfees >= 100) {
      throw new Error("Invalid transfer-fee configuration");
    }

    // Requests addressed to OneX use the same endpoint in both modes.
    // The server selects individual or global accounting from the locked run state.
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

    // P2P transfers are available from a minimum of one public XTU.
    if (requestedAmount.isLessThan(1)) {
      await queueUserTransactionStatus(S, "p2p", "failed", ["Your P2P transfer could not be completed because the requested amount is below the minimum."]);
      return res.send({ warning: "abusive operation" });
    }

    const result = await withTransaction(async (tx) => {
      // All financial transactions acquire common_state before account and stock rows.
      const [commonLockRows] = await tx.query(
        "SELECT lock_name FROM system_locks WHERE lock_name=? FOR UPDATE",
        ["common_state"],
      );
      if (commonLockRows.length === 0) {
        throw new Error("The common-state lock row has not been initialized");
      }
      const common = await getLatestCommonTx(tx, true);
      const [activeGlobalRuns] = await tx.query(
        `SELECT id,status,effective_at_ms FROM global_disbursement_runs
         WHERE status IN ('announced','active','closed','manual_review','completed','resolved')
         ORDER BY id DESC LIMIT 1 FOR UPDATE`,
      );
      const globalRun = activeGlobalRuns[0] || null;
      if (globalRun && isGlobalDisbursementEffective(globalRun.status, globalRun.effective_at_ms, Date.now())) {
        return { transf: "global disbursement in progress" };
      }

      const authNames = [S, D].sort();
      const authByName = new Map();
      for (const username of authNames) {
        const [rows] = await tx.query(
          "SELECT username,last_login_at_ms,account_active,password,consec_failed_auth,password_temp_expires_at_ms FROM auths WHERE username=? FOR UPDATE",
          [username],
        );
        if (rows.length > 0) authByName.set(username, rows[0]);
      }

      const senderAuth = authByName.get(S);
      const destinationAuth = authByName.get(D);
      if (
        (senderAuth && Number(senderAuth.account_active) !== 1) ||
        (destinationAuth && Number(destinationAuth.account_active) !== 1)
      ) return { auths: "deactivated" };
      if (senderAuth && (
        Number(senderAuth.consec_failed_auth || 0) >= 3 ||
        senderAuth.password_temp_expires_at_ms != null
      )) return { auth: "not allowed" };
      if (
        !senderAuth ||
        senderAuth.last_login_at_ms == null ||
        senderAuth.password !== verifiedPasswordHash ||
        !destinationAuth || destinationAuth.last_login_at_ms == null
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
      const [pendingXtuWithdrawals] = await tx.query(
        `SELECT id,username FROM xtu_withdrawals
         WHERE username IN (?,?)
           AND status IN ('queued','signed','submitted','manual_review')
         LIMIT 1 FOR UPDATE`,
        [S, D],
      );
      if (pendingXtuWithdrawals.length > 0) {
        return { transf: "XTU withdrawal pending" };
      }

      const stockNames = [...new Set([S, D])].sort();
      const stockByName = new Map();
      for (const username of stockNames) {
        const [rows] = await tx.query(
          `SELECT username,balance,seller_status,run_balance,seller_last_p2p_at_ms
           FROM users_stock WHERE username=? FOR UPDATE`, [username],
        );
        if (rows.length) stockByName.set(rows[0].username, rows[0]);
      }
      if (!stockByName.has(S) || !stockByName.has(D)) return { transf: "failed" };
      const senderStock = stockByName.get(S);
      const destinationStock = stockByName.get(D);
      const senderBalanceInitial = new BigNumber(senderStock.balance);
      const destinationBalanceInitial = new BigNumber(destinationStock.balance);
      const unitPrice = new BigNumber(common.unit_price);
      // Persist any threshold crossing at the pre-operation price before
      // converting the sender's public XTU amount or evaluating the recipient.
      await triggerUserPriceThresholdTx(tx, S, unitPrice, null, senderBalanceInitial);
      await triggerUserPriceThresholdTx(tx, D, unitPrice, null, destinationBalanceInitial);
      const senderPriceState = await getUserPriceStateTx(tx, S, true);
      const destinationPriceState = await getUserPriceStateTx(tx, D, true);
      if (!senderPriceState || !destinationPriceState) throw new Error("An individual remuneration state is missing during P2P transfer");
      const senderIndividualPrice = calculateEffectiveIndividualPrice(
        senderPriceState, senderBalanceInitial, unitPrice, maxStockDefault,
      ).price;
      const lastTotal = new BigNumber(common.total_units_price);
      const backedUnits = new BigNumber(common.backed_units);
      const inactiveInitialAssets = new BigNumber(common.inactive_init_asset);
      if (
        !unitPrice.isFinite() || !unitPrice.isGreaterThan(0) ||
        !lastTotal.isFinite() || !lastTotal.isGreaterThan(0) ||
        !backedUnits.isFinite() || !backedUnits.isGreaterThan(0) ||
        !inactiveInitialAssets.isFinite() || inactiveInitialAssets.isNegative() ||
        !senderBalanceInitial.isFinite() || senderBalanceInitial.isNegative() ||
        !destinationBalanceInitial.isFinite() || destinationBalanceInitial.isNegative()
      ) throw new Error("Invalid initial-asset balances or common reserve values in P2P transfer");

      // XTU remains the public transfer unit. Only the sender's XTU-to-initial-asset
      // conversion uses the sender's individual remuneration price.
      const requestedInitialAsset = xtuToInitialAsset(requestedAmount, senderIndividualPrice);
      const feesInitialAsset = requestedInitialAsset.multipliedBy(tfees).dividedBy(100);
      const recipientCreditInitial = requestedInitialAsset.minus(feesInitialAsset);
      const sellerStatus = Number(senderStock.seller_status || 0);
      if (sellerStatus > 0) {
        const [lockedLots] = await tx.query(
          `SELECT l.id,l.remaining_initial_asset
           FROM users_seller_reserve_lots l
           JOIN users_seller_campaigns c ON c.id=l.campaign_id
           WHERE l.username=? AND l.status='active' AND c.status IN ('active','cancel_requested')
             AND l.remaining_initial_asset>0
           ORDER BY l.activated_at_ms ASC,l.id ASC FOR UPDATE`,
          [S],
        );
        const lockedInitialAsset = lockedLots.reduce(
          (sum, lot) => sum.plus(lot.remaining_initial_asset), new BigNumber(0),
        );
        const maximumTransferableInitial = BigNumber.maximum(
          new BigNumber(0), senderBalanceInitial.minus(lockedInitialAsset),
        );
        if (requestedInitialAsset.isGreaterThan(maximumTransferableInitial)) {
          return { transf: "limit reached" };
        }
      }

      const futureSenderBalanceInitial = senderBalanceInitial.minus(requestedInitialAsset);
      const futureDestinationBalanceInitial = destinationBalanceInitial.plus(recipientCreditInitial);
      if (
        !recipientCreditInitial.isFinite() || !recipientCreditInitial.isGreaterThan(0) ||
        !futureSenderBalanceInitial.isFinite() || futureSenderBalanceInitial.isNegative() ||
        !futureDestinationBalanceInitial.isFinite() || futureDestinationBalanceInitial.isNegative()
      ) throw new Error("Invalid calculated P2P initial-asset amounts");
      if (futureSenderBalanceInitial.isNegative()) return { transf: "insufficient balance" };
      const feesXtu = feesInitialAsset.multipliedBy(unitPrice);
      const newTotalUnitsPrice = lastTotal.plus(feesXtu);
      const newBackedUnits = backedUnits.plus(feesInitialAsset);
      const resultingPrice = calculateGlobalUnitPrice(newTotalUnitsPrice, newBackedUnits, unitPrice);
      const destinationLimit = previewUserOperationCapacity(
        destinationPriceState, "purchase", recipientCreditInitial,
        destinationBalanceInitial, futureDestinationBalanceInitial, resultingPrice,
      );
      if (!destinationLimit.allowed) {
        return { transf: "unsupported", projected_balance: destinationLimit.projectedXtu.toFixed(18) };
      }

      // The pre-operation individual price states are now locked and stable.
      // Record the sender's gross sale and recipient's net acquisition against them.
      const newTotalTfees = new BigNumber(common.total_tfees || "0").plus(feesInitialAsset);
      const [date, time] = getDate();
      const reference = createFinancialReference(`P2P${S}`);

      await tx.query(
        `INSERT INTO activities(sender,receiver,type,amount,unit_price,fees,fee_unit_price,reference,record_date,record_time)
         VALUES(?,?,?,?,?,?,?,?,?,?)`,
        [
          S,
          D,
          1,
          recipientCreditInitial.toFixed(30),
          senderIndividualPrice.toFixed(30),
          feesInitialAsset.toFixed(30),
          unitPrice.toFixed(30),
          reference,
          date,
          time,
        ],
      );
      await tx.query(
        "UPDATE users_stock SET balance=?,record_date=?,record_time=? WHERE username=?",
        [futureSenderBalanceInitial.toFixed(30), date, time, S],
      );
      await tx.query(
        "UPDATE users_stock SET balance=?,record_date=?,record_time=? WHERE username=?",
        [futureDestinationBalanceInitial.toFixed(30), date, time, D],
      );
      await markPendingDepositBatchesDueTx(tx, S);
      await markPendingDepositBatchesDueTx(tx, D);
      await insertCommonSnapshotTx(tx, common, {
        total_units_price: newTotalUnitsPrice.toFixed(30),
        backed_units: newBackedUnits.toFixed(30),
        inactive_init_asset: inactiveInitialAssets.toFixed(30),
        total_tfees: newTotalTfees.toFixed(30),
      }, date, time);
      await recordUserOperationTx(
        tx, S, "sale", requestedInitialAsset, senderBalanceInitial,
        futureSenderBalanceInitial, resultingPrice, tfees, reference,
      );
      await recordUserOperationTx(
        tx, D, "purchase", recipientCreditInitial, destinationBalanceInitial,
        futureDestinationBalanceInitial, resultingPrice, tfees, reference,
      );
      // Evaluate the post-operation global price only after eligible groups have
      // had a chance to create their new cycle, avoiding a transient pause notice.
      await triggerUserPriceThresholdTx(tx, S, resultingPrice);
      await triggerUserPriceThresholdTx(tx, D, resultingPrice);
      const recipientPriceState = await getUserPriceStateTx(tx, D, true);
      const recipientIndividualPrice = calculateEffectiveIndividualPrice(
        recipientPriceState, futureDestinationBalanceInitial, resultingPrice, maxStockDefault,
      ).price;
      const recipientAmountXtu = recipientCreditInitial.multipliedBy(recipientIndividualPrice);
      const p2pTimestamp = Date.now();
      if (sellerStatus > 0) {
        await tx.query(
          "UPDATE users_stock SET seller_last_p2p_at_ms=? WHERE username=?",
          [String(p2pTimestamp), S],
        );
        await tx.query(
          `UPDATE users_seller_campaigns SET last_p2p_at_ms=?
           WHERE username=? AND status='active' ORDER BY id DESC LIMIT 1`,
          [String(p2pTimestamp), S],
        );
      }

      await queueTelegramMessageTx(
        tx,
        S,
        `p2p:${reference}:sender`,
        [
          "OneX Transaction Update",
          "Your P2P transfer was completed successfully.",
          `Recipient: ${D}`,
          `Gross amount sent: ${requestedAmount.toFixed(8)} public XTU`,
          `Initial assets debited at your individual price: ${requestedInitialAsset.toFixed(8)}`,
          `Recipient-paid tfees deducted from the gross transfer: ${tfees.toFixed(4)}%`,
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
          `Initial assets credited after tfees: ${recipientCreditInitial.toFixed(8)}`,
          `Individual valuation of the credited assets: ${recipientAmountXtu.toFixed(8)} XTU`,
          `Recipient-paid tfees deducted: ${feesInitialAsset.toFixed(8)} initial assets (${tfees.toFixed(4)}%)`,
          `Common-reserve valuation of tfees at the pre-transfer global price: ${feesXtu.toFixed(8)} XTU`,
          `Reference: ${reference}`,
          "Status: SUCCESS",
        ].join("\n"),
      );

      return { transf: "sent" };
    });

    if (result?.transf && result.transf !== "sent" && result.auth !== "not allowed" && result.auths !== "deactivated") {
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

  if (!await requestTokenIsValid(req, tkn, P, userInput)) {
    return res.send({ transf: "forbidden request" });
  }
  if (!/^\d{1,20}$/.test(id)) {
    return res.status(400).send({ transf: "invalid request" });
  }

  try {
    const passwordState = await getUserActivityPasswordState(U, P);
    if (passwordState === "deactivated") return res.send({ auths: "deactivated" });
    if (passwordState === "not_allowed") return res.send({ auth: "not allowed" });
    if (passwordState !== "ok") return res.send({ transf: "failed" });
    if (await accountApiLimitReached(res, U, "disbursement_status", 20, 60_000)) return;
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

// Individual disbursement intake is opened and closed only by an explicit administrative decision.
// The Telegram announcement is published manually outside the server; its reference is stored for audit.
router.post("/admin/individual-disbursement/control", async (req, res) => {
  const { pswd, pin, action, reason, notice_reference } = req.body || {};
  if (
    pswd !== decrypt(admin_pswd, DB_CONFIG.password) ||
    pin !== decrypt(admin_pin, DB_CONFIG.password)
  ) return res.send({ auth: "incorrect" });

  const requestedAction = String(action || "").trim().toLowerCase();
  if (!["open", "close", "status"].includes(requestedAction)) {
    return res.status(400).send({ error: "invalid action" });
  }
  const controlReason = typeof reason === "string" ? reason.trim() : "";
  const noticeReference = typeof notice_reference === "string" ? notice_reference.trim() : "";
  if (requestedAction !== "status" && (controlReason.length < 5 || controlReason.length > 1000)) {
    return res.status(400).send({ error: "a reason between 5 and 1000 characters is required" });
  }
  if (requestedAction === "open" && (noticeReference.length < 5 || noticeReference.length > 512)) {
    return res.status(400).send({ error: "a Telegram announcement reference between 5 and 512 characters is required before opening" });
  }
  if (noticeReference.length > 512) return res.status(400).send({ error: "notice reference is too long" });

  try {
    const result = await withTransaction(async (tx) => {
      const [lockRows] = await tx.query(
        "SELECT lock_name FROM system_locks WHERE lock_name='common_state' FOR UPDATE",
      );
      if (!lockRows.length) throw new Error("The common-state lock row has not been initialized");
      const [controlRows] = await tx.query(
        `SELECT is_open,opening_reason,notice_reference,changed_by,opened_at_ms,closed_at_ms,updated_at_ms
         FROM individual_disbursement_control WHERE control_id=1 LIMIT 1 FOR UPDATE`,
      );
      if (!controlRows.length) throw new Error("The individual disbursement control row has not been initialized");
      const current = controlRows[0];
      if (requestedAction === "status") {
        return {
          status: Number(current.is_open) === 1 ? "open" : "closed",
          reason: current.opening_reason,
          notice_reference: current.notice_reference,
          changed_by: current.changed_by,
          opened_at_ms: current.opened_at_ms == null ? null : Number(current.opened_at_ms),
          closed_at_ms: current.closed_at_ms == null ? null : Number(current.closed_at_ms),
          updated_at_ms: Number(current.updated_at_ms),
        };
      }
      const nextOpen = requestedAction === "open" ? 1 : 0;
      const now = String(Date.now());
      await tx.query(
        `UPDATE individual_disbursement_control
         SET is_open=?,opening_reason=?,notice_reference=?,changed_by='configured_admin',
             opened_at_ms=CASE WHEN ?=1 THEN ? ELSE opened_at_ms END,
             closed_at_ms=CASE WHEN ?=0 THEN ? ELSE closed_at_ms END,
             updated_at_ms=? WHERE control_id=1`,
        [nextOpen, nextOpen ? controlReason : null, nextOpen ? noticeReference : null,
          nextOpen, now, nextOpen, now, now],
      );
      await tx.query(
        `INSERT INTO individual_disbursement_control_events
         (action,previous_open,current_open,reason,notice_reference,changed_by,created_at_ms)
         VALUES(?,?,?,?,?,'configured_admin',?)`,
        [requestedAction, Number(current.is_open), nextOpen, controlReason,
          nextOpen ? noticeReference : null, now],
      );
      return {
        status: nextOpen ? "open" : "closed",
        reason: nextOpen ? controlReason : null,
        notice_reference: nextOpen ? noticeReference : null,
        changed_at_ms: Number(now),
      };
    });
    return res.send({ individual_disbursement_control: result });
  } catch (error) {
    console.error("Administrative individual disbursement control failed:", error.message);
    return res.status(500).send({ error: "individual disbursement control update failed" });
  }
});

// Administrative control for temporarily hiding deposit addresses and holding automatic deposit credits.
router.post("/admin/deposit/control", async (req, res) => {
  const { pswd, pin, action, reason } = req.body || {};
  if (
    pswd !== decrypt(admin_pswd, DB_CONFIG.password) ||
    pin !== decrypt(admin_pin, DB_CONFIG.password)
  ) return res.send({ auth: "incorrect" });

  const requestedAction = String(action || "").trim().toLowerCase();
  if (!["suspend", "resume", "status"].includes(requestedAction)) {
    return res.status(400).send({ error: "invalid action" });
  }
  const controlReason = typeof reason === "string" ? reason.trim() : "";
  if (requestedAction !== "status" && (controlReason.length < 5 || controlReason.length > 1000)) {
    return res.status(400).send({ error: "a reason between 5 and 1000 characters is required" });
  }

  try {
    const result = await withTransaction(async (tx) => {
      const [lockRows] = await tx.query(
        "SELECT lock_name FROM system_locks WHERE lock_name='common_state' FOR UPDATE",
      );
      if (!lockRows.length) throw new Error("The common-state lock row has not been initialized");
      const [controlRows] = await tx.query(
        `SELECT is_suspended,suspension_reason,changed_by,updated_at_ms
         FROM deposit_service_control WHERE control_id=1 LIMIT 1 FOR UPDATE`,
      );
      if (!controlRows.length) throw new Error("The deposit service control row has not been initialized");
      const current = controlRows[0];
      if (requestedAction === "status") {
        return {
          status: Number(current.is_suspended) === 1 ? "suspended" : "available",
          reason: current.suspension_reason,
          changed_by: current.changed_by,
          updated_at_ms: Number(current.updated_at_ms),
        };
      }

      const nextSuspended = requestedAction === "suspend" ? 1 : 0;
      const now = String(Date.now());
      await tx.query(
        `UPDATE deposit_service_control
         SET is_suspended=?,suspension_reason=?,changed_by='configured_admin',updated_at_ms=?
         WHERE control_id=1`,
        [nextSuspended, nextSuspended ? controlReason : null, now],
      );
      await tx.query(
        `INSERT INTO deposit_service_control_events
         (action,previous_suspended,current_suspended,reason,changed_by,created_at_ms)
         VALUES(?,?,?,?,?,?)`,
        [requestedAction, Number(current.is_suspended), nextSuspended, controlReason, "configured_admin", now],
      );
      if (requestedAction === "resume") {
        await tx.query(
          `UPDATE users_usdt_deposit_batches
           SET next_attempt_at_ms=?,updated_at_ms=?
           WHERE remaining_amount>0 AND status='pending_support'`,
          [now, now],
        );
      }
      return {
        status: nextSuspended ? "suspended" : "available",
        reason: nextSuspended ? controlReason : null,
        changed_at_ms: Number(now),
      };
    });
    return res.send({ deposit_control: result });
  } catch (error) {
    console.error("Administrative deposit control failed:", error.message);
    return res.status(500).send({ error: "deposit control update failed" });
  }
});

// Exceptional administrative credit of a support-held deposit batch.
// Normal weekly cooldown, 300 XTU stock cap and common reserve checks remain enforced.
// The administrator may bypass the automatic 70-140 BSC-USD rolling seven-day receipt range and the 100 BSC-USD first-credit tranche cap only after a documented support review.
router.post("/admin/deposit/credit", async (req, res) => {
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
        `SELECT id,username,total_amount,credited_amount,remaining_amount,refunded_amount,reserved_refund_amount,
                tfees_rate_percent,credit_sequence,status
         FROM users_usdt_deposit_batches
         WHERE id=? AND username=? LIMIT 1 FOR UPDATE`,
        [batchId, U],
      );
      if (!batchRows.length || batchRows[0].status !== "pending_support") {
        return { transf: "batch not available for manual credit" };
      }
      const batch = batchRows[0];

      const [resolutionRows] = await tx.query(
        `SELECT id FROM admin_payment_resolutions
         WHERE batch_id=? AND action IN ('manual_credit','manual_partial_credit','refund_queued','refund_confirmed','refund_manual_review')
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

      const creditedBefore = new BigNumber(batch.credited_amount || "0");
      const remainingBefore = new BigNumber(batch.remaining_amount || new BigNumber(batch.total_amount).minus(creditedBefore).minus(batch.refunded_amount || 0).minus(batch.reserved_refund_amount || 0));
      if (!remainingBefore.isFinite() || !remainingBefore.isGreaterThan(0) ||
          !creditedBefore.isFinite() || creditedBefore.isNegative()) {
        return { transf: "no remaining deposit amount to credit" };
      }
      const firstTranche = creditedBefore.isZero();
      const targetAmount = firstTranche ? BigNumber.minimum(remainingBefore, MAX_INITIAL_CREDIT_TRANCHE_AMOUNT) : remainingBefore;
      const now = Date.now();
      const [date, time] = formatUtcRecordDateTime(now);
      const sequence = Number(batch.credit_sequence || 0) + 1;
      if (!Number.isSafeInteger(sequence) || sequence < 1) throw new Error("Invalid manual deposit credit sequence");
      const reference = createFinancialReference(`ADMCREDIT${U}`);
      const creditResult = await applyUserTopUp(
        tx,
        U,
        targetAmount,
        reference,
        date,
        time,
        now,
        {
          enforceDepositRange: false,
          allowReviewedAdminCredit: true,
          allowPartial: true,
          tfeesRatePercent: batch.tfees_rate_percent,
          depositBatchId: batchId,
          priceCycleSource: "deposit",
        },
      );
      if (creditResult?.transf !== "sent") {
        return {
          transf: "manual credit not completed",
          reason: creditResult?.error || creditResult?.limit || "accounting validation failed",
        };
      }

      const gross = new BigNumber(creditResult.gross_amount);
      const fee = new BigNumber(creditResult.fee_amount);
      const net = gross.minus(fee);
      const newCredited = creditedBefore.plus(gross);
      const newRemaining = remainingBefore.minus(gross);
      if (!gross.isFinite() || !gross.isGreaterThan(0) || gross.gt(targetAmount) || gross.gt(remainingBefore) ||
          !fee.isFinite() || fee.isNegative() || !net.isFinite() || !net.isGreaterThan(0) || newRemaining.isNegative()) {
        throw new Error("Manual deposit credit returned inconsistent tranche amounts");
      }
      await tx.query(
        `INSERT INTO users_usdt_deposit_credits
         (batch_id,username,credit_sequence,gross_amount,tfees_rate_percent,fee_amount,net_amount,
          credited_initial_asset,unit_price,financial_reference,created_at_ms)
         VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
        [batchId, U, sequence, gross.toFixed(18), String(batch.tfees_rate_percent), fee.toFixed(18),
          net.toFixed(18), String(creditResult.credited_initial_asset), String(creditResult.unit_price), reference, String(now)],
      );
      const nextStatus = newRemaining.isZero() ? "credited" : "pending_credit";
      const nextReasons = newRemaining.isZero() ? [] : [creditResult.partialReason === "system_reserve"
        ? "system_reserve" : (creditResult.partialReason === "weekly_limit" ? "weekly_limit" : "maximum_user_balance")];
      const retryAt = newRemaining.isZero() ? null : String(now + (nextReasons[0] === "system_reserve" ? 30_000 : 5 * 60 * 1000));
      await tx.query(
        `UPDATE users_usdt_deposit_batches
         SET credited_amount=?,remaining_amount=?,credit_sequence=?,status=?,reason_codes=?,
             next_attempt_at_ms=?,last_credit_at_ms=?,credited_at_ms=?,updated_at_ms=?
         WHERE id=? AND status='pending_support'`,
        [newCredited.toFixed(18), newRemaining.toFixed(18), sequence, nextStatus,
          nextReasons.length ? safeJson(nextReasons) : null, retryAt, String(now),
          newRemaining.isZero() ? String(now) : null, String(now), batchId],
      );
      await updateBatchEventStatus(tx, batchId, nextStatus, nextReasons);
      await closeStaleDepositRefundRequestsTx(tx, batchId, U, newRemaining);
      await tx.query(
        `INSERT INTO admin_payment_resolutions
         (admin_username,username,batch_id,action,gross_amount,fee_amount,net_amount,payout_address,tx_hash,reason,created_at_ms)
         VALUES('configured_admin',?,?,?, ?,?,?,NULL,NULL,?,?)`,
        [U, batchId, newRemaining.isZero() ? "manual_credit" : "manual_partial_credit",
          gross.toFixed(18), fee.toFixed(18), net.toFixed(18), resolutionReason, String(now)],
      );
      await queueDepositBatchStatusTx(tx, U, batchId, nextStatus, nextReasons, retryAt, {
        creditedAmount: newCredited.toFixed(8),
        remainingAmount: newRemaining.toFixed(8),
        creditSequence: sequence,
      });
      return {
        transf: newRemaining.isZero() ? "credited" : "partially_credited",
        batch_id: batchId,
        gross_credited: gross.toFixed(18),
        tfees: fee.toFixed(18),
        net_credited: net.toFixed(18),
        remaining: newRemaining.toFixed(18),
        credit_sequence: sequence,
        reference,
      };
    });
    return res.send(result);
  } catch (error) {
    console.error("Administrative deposit credit failed:", error.message);
    return res.send({ transf: "error" });
  }
});

// List incoming BSC-USD transfers whose sender address is not registered to an account.
// Read the persisted state of the shared-treasury incoming scanner.
router.post("/admin/bsc/incoming-scanner/status", async (req, res) => {
  const { pswd, pin } = req.body || {};
  if (
    pswd !== decrypt(admin_pswd, DB_CONFIG.password) ||
    pin !== decrypt(admin_pin, DB_CONFIG.password)
  ) return res.send({ scanner: "incorrect admin credentials" });
  try {
    const state = await getIncomingScannerStatus(db, { includeRpcMetrics: true });
    return res.send({ scanner: "ok", state });
  } catch (error) {
    console.error("BSC incoming scanner status failed:", error.message);
    return res.send({ scanner: "error" });
  }
});

// Create a read-only forensic preview. No scanner cursor or financial balance is changed.
router.post("/admin/bsc/incoming-scanner/reconcile/preview", async (req, res) => {
  const { pswd, pin, reason } = req.body || {};
  if (
    pswd !== decrypt(admin_pswd, DB_CONFIG.password) ||
    pin !== decrypt(admin_pin, DB_CONFIG.password)
  ) return res.send({ scanner: "incorrect admin credentials" });
  try {
    const result = await previewIncomingScannerReconciliation(db, {
      reason,
      adminUsername: "configured_admin",
    });
    return res.send({ scanner: "previewed", ...result });
  } catch (error) {
    if (error.code === "ONEX_BSC_SCANNER_BUSY") return res.status(409).send({ scanner: "busy" });
    console.error("BSC incoming scanner reconciliation preview failed:", error.message);
    return res.status(400).send({ scanner: "preview rejected", reason: error.message });
  }
});

// Record a compensating ledger operation already applied by an administrator.
router.post("/admin/bsc/incoming-scanner/reconcile/resolve-event", async (req, res) => {
  const { pswd, pin, preview_id, item_id, compensation_reference, reason } = req.body || {};
  if (
    pswd !== decrypt(admin_pswd, DB_CONFIG.password) ||
    pin !== decrypt(admin_pin, DB_CONFIG.password)
  ) return res.send({ scanner: "incorrect admin credentials" });
  try {
    const result = await resolveIncomingScannerCompensation(db, {
      previewId: preview_id,
      itemId: item_id,
      compensationReference: compensation_reference,
      reason,
      adminUsername: "configured_admin",
    });
    return res.send({ scanner: "compensation recorded", ...result });
  } catch (error) {
    if (error.code === "ONEX_BSC_SCANNER_BUSY") return res.status(409).send({ scanner: "busy" });
    console.error("BSC scanner compensation attestation failed:", error.message);
    return res.status(400).send({ scanner: "compensation rejected", reason: error.message });
  }
});

// Commit only a current preview with RPC agreement and no unresolved financial impact.
router.post("/admin/bsc/incoming-scanner/reconcile/commit", async (req, res) => {
  const { pswd, pin, preview_id, reason } = req.body || {};
  if (
    pswd !== decrypt(admin_pswd, DB_CONFIG.password) ||
    pin !== decrypt(admin_pin, DB_CONFIG.password)
  ) return res.send({ scanner: "incorrect admin credentials" });
  try {
    const result = await commitIncomingScannerReconciliation(db, {
      previewId: preview_id,
      reason,
      adminUsername: "configured_admin",
    });
    return res.send({ scanner: "resumed", ...result });
  } catch (error) {
    if (error.code === "ONEX_BSC_SCANNER_BUSY") return res.status(409).send({ scanner: "busy" });
    console.error("BSC incoming scanner reconciliation commit failed:", error.message);
    return res.status(400).send({ scanner: "commit rejected", reason: error.message });
  }
});

// The previous direct cursor rewind is intentionally disabled; every resume must use preview and commit.
router.post("/admin/bsc/incoming-scanner/reconcile", async (req, res) => {
  const { pswd, pin } = req.body || {};
  if (
    pswd !== decrypt(admin_pswd, DB_CONFIG.password) ||
    pin !== decrypt(admin_pin, DB_CONFIG.password)
  ) return res.send({ scanner: "incorrect admin credentials" });
  return res.status(410).send({
    scanner: "preview_required",
    required_endpoints: [
      "/admin/bsc/incoming-scanner/reconcile/preview",
      "/admin/bsc/incoming-scanner/reconcile/resolve-event",
      "/admin/bsc/incoming-scanner/reconcile/commit",
    ],
  });
});

router.post("/admin/bsc/unknown-transfers/list", async (req, res) => {
  const { pswd, pin, limit } = req.body || {};
  if (
    pswd !== decrypt(admin_pswd, DB_CONFIG.password) ||
    pin !== decrypt(admin_pin, DB_CONFIG.password)
  ) return res.send({ transf: "incorrect admin credentials" });
  const requestedLimit = Number(limit || 100);
  const safeLimit = Number.isInteger(requestedLimit) ? Math.min(200, Math.max(1, requestedLimit)) : 100;
  try {
    const rows = await db.queryAsync(
      `SELECT id,from_address,to_address,amount,tx_hash,log_index,block_number,block_timestamp_ms,
              previous_username,status,decision_action,decision_username,decision_reason,refund_id,created_at_ms
       FROM bsc_unknown_incoming_transfers
       ORDER BY CASE WHEN status='pending_admin' THEN 0 ELSE 1 END,id DESC
       LIMIT ?`,
      [safeLimit],
    );
    return res.send({ transf: "ok", items: rows.map((row) => ({ ...row, id: String(row.id) })) });
  } catch (error) {
    console.error("Unknown BSC transfer listing failed:", error.message);
    return res.send({ transf: "error" });
  }
});

// Resolve an unknown incoming transfer by assigning it to the matching registered wallet,
// refunding it to the observed sender, or retaining it as an uncredited administrative case.
router.post("/admin/bsc/unknown-transfers/resolve", async (req, res) => {
  const { pswd, pin, transfer_id, action, username, reason } = req.body || {};
  if (
    pswd !== decrypt(admin_pswd, DB_CONFIG.password) ||
    pin !== decrypt(admin_pin, DB_CONFIG.password)
  ) return res.send({ transf: "incorrect admin credentials" });
  const transferId = String(transfer_id ?? "").trim();
  const requestedAction = String(action || "").trim().toLowerCase();
  const targetUsername = normalizeUsername(username);
  const resolutionReason = typeof reason === "string" ? reason.trim() : "";
  if (!/^\d{1,20}$/.test(transferId) || !["assign", "refund", "retain"].includes(requestedAction) ||
      resolutionReason.length < 5 || resolutionReason.length > 1000) {
    return res.status(400).send({ transf: "invalid request" });
  }

  try {
    const transferRows = await db.queryAsync(
      `SELECT * FROM bsc_unknown_incoming_transfers WHERE id=? AND status='pending_admin' LIMIT 1`,
      [transferId],
    );
    if (!transferRows.length) return res.send({ transf: "transfer not available" });
    const transfer = transferRows[0];
    const now = String(Date.now());

    if (requestedAction === "assign") {
      if (!targetUsername) return res.status(400).send({ transf: "username required" });
      const accountRows = await db.queryAsync(
        `SELECT username,wallet_address FROM auths WHERE username=? LIMIT 1`, [targetUsername],
      );
      if (!accountRows.length ||
          String(accountRows[0].wallet_address).toLowerCase() !== String(transfer.from_address).toLowerCase()) {
        return res.send({ transf: "sender does not match the selected account wallet" });
      }
      const assigned = await processConfirmedUsdtPayment({
        username: targetUsername,
        treasuryAddress: transfer.to_address,
        fromAddress: transfer.from_address,
        amount: transfer.amount,
        amountRaw: String(transfer.amount_raw),
        txHash: transfer.tx_hash,
        logIndex: Number(transfer.log_index),
        blockNumber: String(transfer.block_number),
        blockHash: transfer.block_hash,
        blockTimestampMs: Number(transfer.block_timestamp_ms),
        unknownTransferId: transferId,
        adminUsername: "configured_admin",
        adminResolutionReason: resolutionReason,
      });
      if (assigned?.unknown || assigned?.duplicate) {
        return res.send({ transf: "transfer changed or already processed", details: assigned });
      }
      return res.send({ transf: "assigned", ...assigned });
    }

    if (requestedAction === "retain") {
      const result = await withTransaction(async (tx) => {
        const [rows] = await tx.query(
          `SELECT * FROM bsc_unknown_incoming_transfers WHERE id=? AND status='pending_admin' LIMIT 1 FOR UPDATE`,
          [transferId],
        );
        if (!rows.length) return { transf: "transfer not available" };
        await tx.query(
          `UPDATE bsc_unknown_incoming_transfers
           SET status='resolved_uncredited',decision_action='retain',decision_reason=?,decided_by='configured_admin',
               decided_at_ms=?,updated_at_ms=? WHERE id=? AND status='pending_admin'`,
          [resolutionReason, now, now, transferId],
        );
        await tx.query(
          `INSERT INTO admin_payment_resolutions
           (admin_username,username,batch_id,unknown_transfer_id,action,initial_asset_amount,gross_amount,fee_amount,net_amount,payout_address,tx_hash,reason,created_at_ms)
           VALUES('configured_admin','ONEX',NULL,?,'unknown_retained',0,?,0,0,NULL,?,?,?)`,
          [transferId, String(rows[0].amount), rows[0].tx_hash, resolutionReason, now],
        );
        return { transf: "retained_uncredited", transfer_id: transferId };
      });
      return res.send(result);
    }

    if (String(process.env.USDT_DISBURSEMENTS_ENABLED || "false").toLowerCase() !== "true") {
      return res.send({ transf: "treasury payout service disabled" });
    }
    const grossAmount = new BigNumber(transfer.amount);
    const grossRaw = new BigNumber(String(transfer.amount_raw));
    const maximumGasRecovery = getConfiguredMaxBscTxFeeUsd();
    if (!grossAmount.isFinite() || !grossAmount.isGreaterThan(0) ||
        !grossRaw.isFinite() || !grossRaw.isInteger() ||
        grossAmount.minus(maximumGasRecovery).isLessThan(MINIMUM_REFUND_NET_BSC_USD)) {
      return res.send({ transf: `unknown transfer is below the minimum refundable net amount of ${MINIMUM_REFUND_NET_BSC_USD.toString()} BSC-USD` });
    }
    const liquidity = await checkTreasuryLiquidity(grossRaw.toFixed(0), transfer.from_address, { reservationCredit: grossAmount.toFixed(18) });
    if (!liquidity.tokenAvailable) {
      return res.send({ transf: "insufficient treasury BSC-USD balance", liquidity });
    }
    const refundResult = await withTransaction(async (tx) => {
      const [rows] = await tx.query(
        `SELECT * FROM bsc_unknown_incoming_transfers WHERE id=? AND status='pending_admin' LIMIT 1 FOR UPDATE`,
        [transferId],
      );
      if (!rows.length) return { transf: "transfer not available" };
      const [existingRows] = await tx.query(
        `SELECT id FROM users_usdt_refunds WHERE unknown_transfer_id=?
         AND status IN ('queued','signed','submitted','confirmed','manual_review') LIMIT 1 FOR UPDATE`,
        [transferId],
      );
      if (existingRows.length) return { transf: "refund already exists", refund_id: String(existingRows[0].id) };
      const reference = createFinancialReference("UNKREF");
      const [refundInsert] = await tx.query(
        `INSERT INTO users_usdt_refunds
         (username,batch_id,unknown_transfer_id,payout_address,amount,gross_amount,fee_amount,amount_raw,
          estimated_fee_bnb,estimated_fee_usd,bnb_usd_price,reference,status,created_at_ms,updated_at_ms)
         VALUES('ONEX',NULL,?,?,?,?,?, ?,0,0,0,?,'queued',?,?)`,
        [transferId, rows[0].from_address, grossAmount.toFixed(18), grossAmount.toFixed(18), "0", grossRaw.toFixed(0), reference, now, now],
      );
      await tx.query(
        `UPDATE bsc_unknown_incoming_transfers
         SET status='refund_queued',decision_action='refund',decision_reason=?,decided_by='configured_admin',
             decided_at_ms=?,refund_id=?,updated_at_ms=? WHERE id=? AND status='pending_admin'`,
        [resolutionReason, now, String(refundInsert.insertId), now, transferId],
      );
      await tx.query(
        `INSERT INTO admin_payment_resolutions
         (admin_username,username,batch_id,unknown_transfer_id,action,initial_asset_amount,gross_amount,fee_amount,net_amount,payout_address,tx_hash,reason,created_at_ms)
         VALUES('configured_admin','ONEX',NULL,?,'unknown_refund_queued',0,?,0,?, ?,NULL,?,?)`,
        [transferId, grossAmount.toFixed(18), grossAmount.toFixed(18), rows[0].from_address, resolutionReason, now],
      );
      return { transf: "refund_queued", refund_id: String(refundInsert.insertId), amount: grossAmount.toFixed(18) };
    });
    return res.send(refundResult);
  } catch (error) {
    console.error("Unknown BSC transfer resolution failed:", error.message);
    if (error.code === "ER_DUP_ENTRY") return res.send({ transf: "refund already exists" });
    return res.send({ transf: "error" });
  }
});

// Administrative refund of a deposit batch held for support.
// The refund is queued for the isolated treasury worker; gas is paid separately in BNB.
router.post("/admin/deposit/refund", async (req, res) => {
  const { pswd, pin, request_id, reason, emergency_approved } = req.body || {};
  if (
    pswd !== decrypt(admin_pswd, DB_CONFIG.password) ||
    pin !== decrypt(admin_pin, DB_CONFIG.password)
  ) return res.send({ transf: "incorrect admin credentials" });

  const requestId = String(request_id ?? "").trim();
  const resolutionReason = typeof reason === "string" ? reason.trim() : "";
  if (!/^\d{1,20}$/.test(requestId) || resolutionReason.length < 5 || resolutionReason.length > 1000) {
    return res.status(400).send({ transf: "invalid request; a persisted user refund request and administrative reason are required" });
  }

  try {
    if (String(process.env.USDT_DISBURSEMENTS_ENABLED || "false").toLowerCase() !== "true") {
      return res.send({ transf: "treasury payout service disabled" });
    }
    const snapshotRows = await db.queryAsync(
      `SELECT r.id AS request_id,r.request_reference,r.request_type,r.status AS request_status,
              b.id AS batch_id,b.username,b.total_amount,b.credited_amount,b.remaining_amount,
              b.refunded_amount,b.reserved_refund_amount,b.status AS batch_status,
              a.wallet_address AS payout_address,a.account_active
       FROM user_usdt_refund_requests r
       JOIN users_usdt_deposit_batches b ON b.id=r.batch_id AND b.username=r.username
       JOIN auths a ON a.username=b.username
       WHERE r.id=? LIMIT 1`,
      [requestId],
    );
    if (!snapshotRows.length) return res.send({ transf: "refund request not found" });
    const snapshot = snapshotRows[0];
    if (snapshot.request_status !== "pending_admin") return res.send({ transf: "refund request already resolved" });
    const eligibleStatuses = new Set([
      "pending_minimum", "pending_credit", "pending_weekly", "pending_reserve", "pending_support", "pending_global",
    ]);
    if (!eligibleStatuses.has(String(snapshot.batch_status))) return res.send({ transf: "batch not refundable in its current state" });
    if (Number(snapshot.account_active) !== 1) return res.send({ transf: "account unavailable" });
    if (!isEvmAddress(snapshot.payout_address) || /^0x0{40}$/i.test(snapshot.payout_address) ||
        String(snapshot.payout_address).toLowerCase() === String(process.env.USDT_BEP20_TREASURY_ADDRESS || "").toLowerCase()) {
      return res.send({ transf: "payout wallet not registered" });
    }

    const remaining = new BigNumber(snapshot.remaining_amount == null
      ? new BigNumber(snapshot.total_amount).minus(snapshot.credited_amount || 0)
        .minus(snapshot.refunded_amount || 0).minus(snapshot.reserved_refund_amount || 0)
      : snapshot.remaining_amount);
    if (!remaining.isFinite() || !remaining.isGreaterThan(0)) return res.send({ transf: "no uncredited pending amount to refund" });
    const exceptionalThreshold = MAX_INITIAL_CREDIT_TRANCHE_AMOUNT.multipliedBy(3);
    const thresholdEligible = remaining.gte(exceptionalThreshold);
    const emergencyEligible = snapshot.request_type === "emergency" && emergency_approved === true;
    if (!thresholdEligible && !emergencyEligible) {
      return res.send({
        transf: "refund not eligible",
        reason: "A user-requested remainder of at least three times the initial credit limit, or a separately approved emergency request, is required.",
        required_remainder: exceptionalThreshold.toFixed(18),
      });
    }
    const grossRaw = remaining.shiftedBy(18);
    if (!grossRaw.isInteger() || !grossRaw.isGreaterThan(0)) return res.send({ transf: "invalid refund amount" });
    const maximumGasRecovery = getConfiguredMaxBscTxFeeUsd();
    if (remaining.minus(maximumGasRecovery).isLessThan(MINIMUM_REFUND_NET_BSC_USD)) {
      return res.send({
        transf: `gross refund is too small to guarantee the minimum net refund of ${MINIMUM_REFUND_NET_BSC_USD.toFixed(8)} BSC-USD within the configured gas-fee cap`,
        gross_amount: remaining.toFixed(18),
        maximum_gas_recovery: maximumGasRecovery.toFixed(18),
      });
    }
    const liquidityEstimate = await checkTreasuryLiquidity(grossRaw.toFixed(0), snapshot.payout_address, { reservationCredit: remaining.toFixed(18) });
    if (!liquidityEstimate.tokenAvailable) {
      return res.send({ transf: "insufficient treasury BSC-USD balance", liquidity: liquidityEstimate });
    }

    const result = await withTransaction(async (tx) => {
      const [requestRows] = await tx.query(
        "SELECT * FROM user_usdt_refund_requests WHERE id=? LIMIT 1 FOR UPDATE", [requestId],
      );
      if (!requestRows.length || requestRows[0].status !== "pending_admin") {
        return { transf: "refund request already resolved" };
      }
      const request = requestRows[0];
      const [batchRows] = await tx.query(
        `SELECT id,username,total_amount,credited_amount,remaining_amount,refunded_amount,
                reserved_refund_amount,status
         FROM users_usdt_deposit_batches WHERE id=? AND username=? LIMIT 1 FOR UPDATE`,
        [snapshot.batch_id, snapshot.username],
      );
      const [walletRows] = await tx.query(
        "SELECT wallet_address,account_active FROM auths WHERE username=? LIMIT 1 FOR UPDATE",
        [snapshot.username],
      );
      if (!batchRows.length || !eligibleStatuses.has(String(batchRows[0].status))) {
        return { transf: "batch not refundable in its current state" };
      }
      const lockedBatch = batchRows[0];
      const lockedRemaining = new BigNumber(lockedBatch.remaining_amount == null
        ? new BigNumber(lockedBatch.total_amount).minus(lockedBatch.credited_amount || 0)
          .minus(lockedBatch.refunded_amount || 0).minus(lockedBatch.reserved_refund_amount || 0)
        : lockedBatch.remaining_amount);
      const lockedReserved = new BigNumber(lockedBatch.reserved_refund_amount || "0");
      if (!lockedRemaining.isFinite() || !lockedRemaining.eq(remaining) || !lockedRemaining.isGreaterThan(0)) {
        return { transf: "pending amount changed; refresh and review again" };
      }
      if (!walletRows.length || Number(walletRows[0].account_active) !== 1 ||
          String(walletRows[0].wallet_address || "").toLowerCase() !== String(snapshot.payout_address).toLowerCase()) {
        return { transf: "payout wallet changed or account unavailable" };
      }
      const [existingRequestRefundRows] = await tx.query(
        "SELECT id,status FROM users_usdt_refunds WHERE user_request_id=? LIMIT 1 FOR UPDATE",
        [requestId],
      );
      if (existingRequestRefundRows.length) {
        return { transf: "this user request already has a refund record", refund_id: String(existingRequestRefundRows[0].id) };
      }
      const [existingRows] = await tx.query(
        "SELECT id FROM users_usdt_refunds WHERE batch_id=? AND status IN ('queued','signed','submitted','confirmed','manual_review') LIMIT 1 FOR UPDATE",
        [snapshot.batch_id],
      );
      if (existingRows.length) return { transf: "refund already exists", refund_id: String(existingRows[0].id) };

      const reference = createFinancialReference(`REF${snapshot.username}`);
      const now = String(Date.now());
      const [refundInsert] = await tx.query(
        `INSERT INTO users_usdt_refunds
         (username,batch_id,user_request_id,payout_address,amount,gross_amount,fee_amount,amount_raw,
          estimated_fee_bnb,estimated_fee_usd,bnb_usd_price,reference,status,created_at_ms,updated_at_ms)
         VALUES(?,?,?,?,?,?,0,?,0,0,0,?,'queued',?,?)`,
        [snapshot.username, snapshot.batch_id, requestId, snapshot.payout_address,
          remaining.toFixed(18), remaining.toFixed(18), grossRaw.toFixed(0), reference, now, now],
      );
      const refundId = String(refundInsert.insertId);
      const [batchUpdate] = await tx.query(
        `UPDATE users_usdt_deposit_batches
         SET reserved_refund_amount=reserved_refund_amount+?,remaining_amount=remaining_amount-?,
             status='refund_queued',reason_codes=NULL,next_attempt_at_ms=NULL,updated_at_ms=?
         WHERE id=? AND remaining_amount=? AND reserved_refund_amount=? AND status=?`,
        [remaining.toFixed(18), remaining.toFixed(18), now, snapshot.batch_id,
          lockedRemaining.toFixed(18), lockedReserved.toFixed(18), lockedBatch.status],
      );
      if (Number(batchUpdate.affectedRows || 0) !== 1) throw new Error("Deposit batch changed while reserving its refund");
      const [requestUpdate] = await tx.query(
        `UPDATE user_usdt_refund_requests
         SET status='approved_queued',refund_id=?,admin_username='configured_admin',admin_reason=?,
             approved_at_ms=?,updated_at_ms=?,resolved_at_ms=NULL,last_error=NULL
         WHERE id=? AND status='pending_admin' AND refund_id IS NULL`,
        [refundId, resolutionReason, now, now, requestId],
      );
      if (Number(requestUpdate.affectedRows || 0) !== 1) throw new Error("Refund request changed while approving it");
      await tx.query(
        "UPDATE users_usdt_transfer_events SET status='refund_queued' WHERE batch_id=? AND status NOT IN ('refunded','refund_confirmed','ignored')",
        [snapshot.batch_id],
      );
      const adminReason = `${resolutionReason} | user_request=${snapshot.request_reference} | request_type=${snapshot.request_type} | threshold_eligible=${thresholdEligible} | emergency_approved=${emergencyEligible}`;
      await tx.query(
        `INSERT INTO admin_payment_resolutions
         (admin_username,username,batch_id,user_refund_request_id,refund_id,action,gross_amount,fee_amount,
          net_amount,payout_address,tx_hash,reason,created_at_ms)
         VALUES('configured_admin',?,?,?,?,'refund_queued',?,0,?, ?,NULL,?,?)`,
        [snapshot.username, snapshot.batch_id, requestId, refundId, remaining.toFixed(18),
          remaining.toFixed(18), snapshot.payout_address, adminReason, now],
      );
      await recordRefundRequestEventTx(tx, {
        requestId,
        refundId,
        eventKey: `refund-request:${requestId}:approved:${refundId}`,
        eventType: "admin_approved",
        actorType: "admin",
        actorUsername: "configured_admin",
        oldStatus: "pending_admin",
        newStatus: "approved_queued",
        reason: adminReason,
        grossAmount: remaining.toFixed(18),
        netAmount: remaining.toFixed(18),
        createdAtMs: now,
      });
      await queueTelegramMessageTx(tx, snapshot.username, `refund:${refundId}:queued`, [
        "OneX Refund Update",
        "An exceptional refund of the uncredited pending deposit remainder has been approved and reserved.",
        `Uncredited gross amount reserved: ${remaining.toFixed(8)} BSC-USD`,
        `Maximum permitted estimated gas recovery: ${maximumGasRecovery.toFixed(8)} BSC-USD`,
        "The reserved amount is not counted as refunded until the BSC-USD transfer is confirmed on BNB Smart Chain.",
        "The outgoing BSC gas estimate will be deducted from the refund by the payout worker. The amount already credited to your XTU balance is not included.",
        `Refund ID: ${refundId}`,
        `Destination: ${snapshot.payout_address}`,
        `User request reference: ${snapshot.request_reference}`,
        "Status: QUEUED",
      ].join("\n"));
      return {
        transf: "refund_processing",
        refund_id: refundId,
        gross_amount: remaining.toFixed(18),
        reserved_amount: remaining.toFixed(18),
        refunded_amount: "0",
        maximum_gas_recovery: maximumGasRecovery.toFixed(18),
        payout_address: snapshot.payout_address,
        credited_amount_preserved: String(lockedBatch.credited_amount || "0"),
        user_request_reference: snapshot.request_reference,
      };
    });
    return res.send(result);
  } catch (error) {
    console.error("Administrative deposit refund failed:", error.message);
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
    if (!isPositivePayoutAmount(snapshot.payout_amount)) {
      return res.send({ transf: "invalid payout amount" });
    }
    if (!isEvmAddress(snapshot.payout_address)) return res.send({ transf: "invalid payout address" });

    // The HTTP process checks balances only; the isolated worker owns the signing key.
    const reservationCreditRaw = new BigNumber(snapshot.payout_amount || "0")
      .shiftedBy(18).integerValue(BigNumber.ROUND_CEIL).toFixed(0);
    const liquidity = await checkDisbursementLiquidity(
      snapshot.amount_raw,
      snapshot.payout_address,
      { reservationCreditRaw },
    );
    if (!liquidity.available) {
      return res.send({ transf: "insufficient treasury liquidity", liquidity });
    }

    const result = await withTransaction(async (tx) => {
      const [authRows] = await tx.query(
        "SELECT last_login_at_ms,account_active FROM auths WHERE username=? LIMIT 1 FOR UPDATE", [username],
      );
      const [stockRows] = await tx.query(
        "SELECT balance FROM users_stock WHERE username=? LIMIT 1 FOR UPDATE", [username],
      );
      const [jobRows] = await tx.query(
        `SELECT id,status,raw_tx,tx_hash,payout_amount,amount_raw,payout_address,reservation_expires_at_ms
         FROM users_usdt_disbursements WHERE id=? AND username=? LIMIT 1 FOR UPDATE`,
        [id, username],
      );
      if (!authRows.length || authRows[0].last_login_at_ms == null || Number(authRows[0].account_active) !== 1 || !stockRows.length || jobRows.length === 0) {
        return { transf: "account unavailable" };
      }
      const job = jobRows[0];
      if (
        job.status !== "manual_review" || job.raw_tx || job.tx_hash ||
        Number(job.reservation_expires_at_ms) > Date.now() ||
        !isPositivePayoutAmount(job.payout_amount)
      ) return { transf: "not eligible for unlock" };
      const balanceInitial = new BigNumber(stockRows[0].balance);
      if (!balanceInitial.isZero()) return { transf: "reserved balance changed" };
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

// A user may record at most three failed password-change attempts and one successful change in any rolling 24-hour period.
router.post("/app/modify-pin-or-password", async (req, res) => {
  const { user, pswd1, pswd2, tkn } = req.body || {};
  const U = normalizeUsername(user);
  const P1 = normalizeFormValue(pswd1);
  const P2 = normalizeFormValue(pswd2);

  if (!U || U.length > 30 || !P1 || Buffer.byteLength(P1, "utf8") > 4096) {
    return res.status(400).send({ auth: "invalid request" });
  }
  if (!await requestTokenIsValid(req, tkn, P1, U)) {
    return res.send({ auth: "forbidden request" });
  }
  if (!P2 || Buffer.byteLength(P2, "utf8") > 4096) {
    return res.status(400).send({ auth: "invalid password" });
  }

  try {
    // Perform Argon2 work before opening a transaction so account rows are not locked while hashing.
    const snapshotRows = await db.queryAsync(
      `SELECT password,password_temp_expires_at_ms,consec_failed_auth,account_active
       FROM auths WHERE username=? LIMIT 1`,
      [U],
    );
    if (!snapshotRows.length) return res.send({ auth: "incorrect" });
    const snapshot = snapshotRows[0];
    const passwordMatches = await verifySecret(snapshot.password, P1);
    if (Number(snapshot.account_active) !== 1) {
      return res.send(passwordMatches ? { auths: "deactivated" } : { auth: "incorrect" });
    }

    const successEvents = await db.queryAsync(
      `SELECT id FROM account_security_events
       WHERE username=? AND action='password_change' AND outcome='successful' AND created_at_ms>=?
       LIMIT 1`,
      [U, String(Date.now() - DAY_MS)],
    );
    if (successEvents.length) return res.send({ auth: "limit reached" });

    const snapshotIsTemporary = snapshot.password_temp_expires_at_ms != null;
    const snapshotNow = Date.now();
    if (Number(snapshot.consec_failed_auth || 0) >= 3 && !snapshotIsTemporary) {
      return res.send({ auth: "not allowed" });
    }
    if (snapshotIsTemporary) {
      const expiresAt = Number(snapshot.password_temp_expires_at_ms);
      if (!Number.isFinite(expiresAt) || expiresAt <= snapshotNow) {
        return res.send({ auth: "temporary password expired" });
      }
    }

    const samePassword = P2 === P1;
    const passwordHash = passwordMatches && !samePassword ? await hashSecret(P2) : null;

    const result = await withTransaction(async (tx) => {
      const now = Date.now();
      const [rows] = await tx.query(
        `SELECT password,password_temp_expires_at_ms,consec_failed_auth,account_active
         FROM auths WHERE username=? LIMIT 1 FOR UPDATE`,
        [U],
      );
      if (!rows.length) return { auth: "incorrect" };

      await lockAccountSecurityActionTx(tx, U, "password_change");
      const counts = await getRecentAccountSecurityEventsTx(tx, U, "password_change", now);
      const actionDecision = evaluateAccountActionLimit("password_change", counts);
      if (!actionDecision.allowed) return { auth: "limit reached" };

      const current = rows[0];
      if (Number(current.account_active) !== 1) return { auths: "deactivated" };
      // Reject a stale credential snapshot rather than applying a result verified against an old password.
      if (current.password !== snapshot.password) return { auth: "incorrect" };

      const isRecoveryPassword = current.password_temp_expires_at_ms != null;
      const accountLocked = Number(current.consec_failed_auth || 0) >= 3;
      if (accountLocked && !isRecoveryPassword) return { auth: "not allowed" };
      if (isRecoveryPassword) {
        const expiresAt = Number(current.password_temp_expires_at_ms);
        if (!Number.isFinite(expiresAt) || expiresAt <= now) {
          return { auth: "temporary password expired" };
        }
      }

      if (!passwordMatches || samePassword) {
        if (!actionDecision.canRecordFailure) return { auth: "limit reached" };
        await recordAccountSecurityEventTx(tx, U, "password_change", "failed", now);
        return { auth: !passwordMatches ? "incorrect" : "new password must be different" };
      }

      if (!passwordHash) throw new Error("Password hash was not prepared");
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
      await recordAccountSecurityEventTx(tx, U, "password_change", "successful", now);
      await tx.query(
        `UPDATE auth_devices SET session_token_hash=REPEAT('0',64),session_expires_at_ms=0
         WHERE username=?`,
        [U],
      );
      await tx.query(
        `INSERT INTO auth_device_events(
           username,event_type,old_device_id,new_device_id,old_key_fingerprint,new_key_fingerprint,
           ip_hash,user_agent,reason,created_at_ms
         ) SELECT username,'password_changed_session_revoked',device_id,device_id,
                  public_key_fingerprint,public_key_fingerprint,NULL,NULL,
                  'All existing device sessions were revoked after a password change.',?
           FROM auth_devices WHERE username=?`,
        [String(now), U],
      );
      return { auth: "updated", recovery_completed: isRecoveryPassword, device_session_revoked: true };
    });
    return res.send(result);
  } catch (error) {
    console.error("Password update failed:", error.message);
    if (["ARGON2_QUEUE_FULL", "ARGON2_QUEUE_TIMEOUT"].includes(error.code)) {
      return res.status(503).send({ auth: "temporarily unavailable" });
    }
    return res.send({ auth: "error" });
  }
});

// delete-user
router.post("/app/delete-user", async (req, res) => {
  const { user, pswd, tkn } = req.body || {};
  const U = normalizeUsername(user);
  const P = normalizeFormValue(pswd);
  if (!await requestTokenIsValid(req, tkn, P, U)) return res.send({ auth: "forbidden request" });
  try {
    const passwordState = await getUserActivityPasswordState(U, P);
    if (passwordState === "deactivated") return res.send({ auths: "deactivated" });
    if (passwordState === "not_allowed") return res.send({ auth: "not allowed" });
    if (passwordState !== "ok") return res.send({ auth: "incorrect" });
    if (await accountApiLimitReached(res, U, "delete_user", 2, DAY_MS)) return;
    const result = await withTransaction(async (tx) => {
      // Serialize deletion against global valuation, seller and treasury operations.
      const [commonLockRows] = await tx.query(
        "SELECT lock_name FROM system_locks WHERE lock_name=? FOR UPDATE", ["common_state"],
      );
      if (!commonLockRows.length) throw new Error("The common-state lock row has not been initialized");
      const common = await getLatestCommonTx(tx, true);
      const [activeGlobalRuns] = await tx.query(
        `SELECT id,status FROM global_disbursement_runs
         WHERE status IN ('active','closed','manual_review','completed','resolved')
         ORDER BY id DESC LIMIT 1 FOR UPDATE`,
      );
      if (activeGlobalRuns.length) return { auth: "global_disbursement_in_progress" };

      const [authRows] = await tx.query(
        "SELECT username,last_login_at_ms,account_active,consec_failed_auth,password_temp_expires_at_ms FROM auths WHERE username=? FOR UPDATE",
        [U],
      );
      if (authRows.length && Number(authRows[0].account_active) !== 1) return { auths: "deactivated" };
      if (!authRows.length || authRows[0].last_login_at_ms == null) return { auth: "not allowed" };
      if (isPasswordProtectedActivityLocked({
        failedCount: Number(authRows[0].consec_failed_auth || 0),
        temporaryPasswordExpiresAtMs: authRows[0].password_temp_expires_at_ms,
      })) return { auth: "not allowed" };
      const [stockRows] = await tx.query(
        "SELECT balance,seller_status FROM users_stock WHERE username=? FOR UPDATE", [U],
      );
      if (!stockRows.length) return { auth: "error" };
      const stockBalanceInitial = new BigNumber(stockRows[0].balance);
      const globalUnitPrice = new BigNumber(common.unit_price);
      if (
        !stockBalanceInitial.isFinite() || stockBalanceInitial.isNegative() ||
        !globalUnitPrice.isFinite() || !globalUnitPrice.isGreaterThan(0)
      ) throw new Error("Invalid user stock balance or global unit price");
      if (stockBalanceInitial.multipliedBy(globalUnitPrice).isGreaterThan(2)) {
        return { auth: "failed, balance > 2" };
      }

      const [pendingDisbursements] = await tx.query(
        `SELECT id FROM users_usdt_disbursements
         WHERE username=? AND status IN ('queued','signed','submitted','manual_review') LIMIT 1 FOR UPDATE`, [U],
      );
      const [pendingXtuWithdrawals] = await tx.query(
        `SELECT id FROM xtu_withdrawals
         WHERE username=? AND status IN ('queued','signed','submitted','manual_review') LIMIT 1 FOR UPDATE`, [U],
      );
      const [pendingBatches] = await tx.query(
        `SELECT id FROM users_usdt_deposit_batches
         WHERE username=? AND status IN ('collecting','batched','ready','finalizing','pending_minimum','pending_credit','pending_weekly','pending_reserve','pending_support','pending_global','refund_queued')
         LIMIT 1 FOR UPDATE`, [U],
      );
      const [pendingEvents] = await tx.query(
        `SELECT id FROM users_usdt_transfer_events
         WHERE username=? AND status IN ('detected','batched','pending_minimum','pending_credit','pending_weekly','pending_reserve','pending_support','pending_global','refund_queued')
         LIMIT 1 FOR UPDATE`, [U],
      );
      const [pendingRefunds] = await tx.query(
        `SELECT id FROM users_usdt_refunds
         WHERE username=? AND status IN ('queued','signed','submitted','manual_review')
         LIMIT 1 FOR UPDATE`, [U],
      );
      const [sellerCampaignRows] = await tx.query(
        `SELECT id FROM users_seller_campaigns
         WHERE username=? AND status IN ('active','cancel_requested')
         LIMIT 1 FOR UPDATE`, [U],
      );
      const [sellerLotRows] = await tx.query(
        `SELECT id FROM users_seller_reserve_lots
         WHERE username=? AND (
           remaining_initial_asset>0 OR payout_pending_initial_asset>0 OR payout_reserved_initial_asset>0
         ) LIMIT 1 FOR UPDATE`, [U],
      );
      const [sellerPayoutRows] = await tx.query(
        `SELECT id FROM users_usdt_seller_payouts
         WHERE username=? AND status IN ('queued','signed','submitted','manual_review')
         LIMIT 1 FOR UPDATE`, [U],
      );
      if (pendingDisbursements.length) return { auth: "failed, disbursement pending" };
      if (pendingXtuWithdrawals.length) return { auth: "failed, XTU withdrawal pending" };
      if (pendingBatches.length || pendingEvents.length || pendingRefunds.length) return { auth: "failed, deposit pending" };
      if (
        Number(stockRows[0].seller_status || 0) !== 0 || sellerCampaignRows.length ||
        sellerLotRows.length || sellerPayoutRows.length
      ) return { auth: "failed, seller reserve pending" };

      // Record device removal before deleting live credentials; keep historical device events.
      await tx.query(
        `INSERT INTO auth_device_events(
           username,event_type,old_device_id,new_device_id,old_key_fingerprint,new_key_fingerprint,
           ip_hash,user_agent,reason,created_at_ms
         ) SELECT username,'device_removed_account_deleted',device_id,NULL,
                  public_key_fingerprint,NULL,NULL,NULL,
                  'The account owner deleted the account; the active device credential was removed.',?
           FROM auth_devices WHERE username=?`,
        [String(Date.now()), U],
      );
      await tx.query("DELETE FROM auth_device_challenges WHERE username=?", [U]);
      await tx.query("DELETE FROM auth_device_request_nonces WHERE username=?", [U]);
      await tx.query("DELETE FROM auth_devices WHERE username=?", [U]);

      // Keep the public wallet address permanently reserved in bsc_wallet_address_registry.
      // The account row is removed only after all financial operations have been settled.
      await tx.query("DELETE FROM user_price_state WHERE username=?", [U]);
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

// Account recovery is limited to two requests per account in a rolling 24-hour period.
router.post("/app/recover-account", async (req, res) => {
  const { user, seed } = req.body || {};
  const U = normalizeUsername(user);
  const S = normalizeFormValue(seed);
  if (!U || U.length > 30 || !S || Buffer.byteLength(S, "utf8") > 4096) {
    return res.status(400).send({ auth: "invalid request" });
  }

  try {
    const accountRows = await db.queryAsync(
      "SELECT username FROM auths WHERE username=? LIMIT 1",
      [U],
    );
    if (!accountRows.length) return res.send({ auth: "incorrect" });

    const quotaResult = await withTransaction(async (tx) => {
      const now = Date.now();
      const [accessRows] = await tx.query(
        "SELECT username FROM auths WHERE username=? LIMIT 1 FOR UPDATE", [U],
      );
      if (!accessRows.length) return { allowed: false };
      await lockAccountSecurityActionTx(tx, U, "account_recovery");
      const counts = await getRecentAccountSecurityEventsTx(tx, U, "account_recovery", now);
      if (!evaluateAccountActionLimit("account_recovery", counts).allowed) {
        return { allowed: false };
      }
      // Count the recovery attempt before seed verification so invalid seeds also consume a request.
      await recordAccountSecurityEventTx(tx, U, "account_recovery", "request", now);
      return { allowed: true };
    });
    if (!quotaResult.allowed) return res.send({ auth: "limit reached" });

    const rows = await db.queryAsync(
      "SELECT email,seed,account_active FROM auths WHERE username=? LIMIT 1",
      [U],
    );
    if (!rows.length || !(await verifySecret(rows[0].seed, S))) {
      return res.send({ auth: "incorrect" });
    }
    if (Number(rows[0].account_active) !== 1) return res.send({ auths: "deactivated" });

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
    if (["ARGON2_QUEUE_FULL", "ARGON2_QUEUE_TIMEOUT"].includes(error.code)) {
      return res.status(503).send({ auth: "temporarily unavailable" });
    }
    return res.send({ auth: "error" });
  }
});

// A user may record at most three failed seed-change attempts and one successful change in any rolling 24-hour period.
router.post("/app/modify-seed", async (req, res) => {
  const { user, pswd, seed, tkn } = req.body || {};
  const U = normalizeUsername(user);
  const P = normalizeFormValue(pswd);
  const S = normalizeFormValue(seed);

  if (!U || U.length > 30 || !P || Buffer.byteLength(P, "utf8") > 4096) {
    return res.status(400).send({ auth: "invalid request" });
  }
  if (!await requestTokenIsValid(req, tkn, P, U)) {
    return res.send({ auth: "forbidden request" });
  }
  if (!S || Buffer.byteLength(S, "utf8") > 4096) {
    return res.status(400).send({ auth: "invalid seed" });
  }

  try {
    // Verify and hash outside the transaction to keep MySQL row locks short-lived.
    const snapshotRows = await db.queryAsync(
      `SELECT password,consec_failed_auth,password_temp_expires_at_ms,account_active
       FROM auths WHERE username=? LIMIT 1`,
      [U],
    );
    if (!snapshotRows.length) return res.send({ auth: "incorrect" });
    const snapshot = snapshotRows[0];
    const passwordMatches = await verifySecret(snapshot.password, P);
    if (Number(snapshot.account_active) !== 1) {
      return res.send(passwordMatches ? { auths: "deactivated" } : { auth: "incorrect" });
    }

    const successEvents = await db.queryAsync(
      `SELECT id FROM account_security_events
       WHERE username=? AND action='seed_change' AND outcome='successful' AND created_at_ms>=?
       LIMIT 1`,
      [U, String(Date.now() - DAY_MS)],
    );
    if (successEvents.length) return res.send({ auth: "limit reached" });

    if (isPasswordProtectedActivityLocked({
      failedCount: Number(snapshot.consec_failed_auth || 0),
      temporaryPasswordExpiresAtMs: snapshot.password_temp_expires_at_ms,
    })) return res.send({ auth: "not allowed" });

    const seedHash = passwordMatches ? await hashSecret(S) : null;

    const result = await withTransaction(async (tx) => {
      const now = Date.now();
      const [rows] = await tx.query(
        `SELECT password,consec_failed_auth,password_temp_expires_at_ms,account_active
         FROM auths WHERE username=? LIMIT 1 FOR UPDATE`,
        [U],
      );
      if (!rows.length) return { auth: "incorrect" };

      await lockAccountSecurityActionTx(tx, U, "seed_change");
      const counts = await getRecentAccountSecurityEventsTx(tx, U, "seed_change", now);
      const actionDecision = evaluateAccountActionLimit("seed_change", counts);
      if (!actionDecision.allowed) return { auth: "limit reached" };

      const current = rows[0];
      if (Number(current.account_active) !== 1) return { auths: "deactivated" };
      if (current.password !== snapshot.password) return { auth: "incorrect" };
      if (isPasswordProtectedActivityLocked({
        failedCount: Number(current.consec_failed_auth || 0),
        temporaryPasswordExpiresAtMs: current.password_temp_expires_at_ms,
      })) return { auth: "not allowed" };

      if (!passwordMatches) {
        if (!actionDecision.canRecordFailure) return { auth: "limit reached" };
        await recordAccountSecurityEventTx(tx, U, "seed_change", "failed", now);
        return { auth: "incorrect" };
      }

      if (!seedHash) throw new Error("Seed hash was not prepared");
      await tx.query("UPDATE auths SET seed=? WHERE username=?", [seedHash, U]);
      await recordAccountSecurityEventTx(tx, U, "seed_change", "successful", now);
      await tx.query(
        `UPDATE auth_devices SET session_token_hash=REPEAT('0',64),session_expires_at_ms=0
         WHERE username=?`,
        [U],
      );
      await tx.query(
        `INSERT INTO auth_device_events(
           username,event_type,old_device_id,new_device_id,old_key_fingerprint,new_key_fingerprint,
           ip_hash,user_agent,reason,created_at_ms
         ) SELECT username,'seed_changed_session_revoked',device_id,device_id,
                  public_key_fingerprint,public_key_fingerprint,NULL,NULL,
                  'All existing device sessions were revoked after a seed change.',?
           FROM auth_devices WHERE username=?`,
        [String(now), U],
      );
      return { auth: "updated", device_session_revoked: true };
    });
    return res.send(result);
  } catch (error) {
    console.error("Seed update failed:", error.message);
    if (["ARGON2_QUEUE_FULL", "ARGON2_QUEUE_TIMEOUT"].includes(error.code)) {
      return res.status(503).send({ auth: "temporarily unavailable" });
    }
    return res.send({ auth: "not exists" });
  }
});

// ----- ADMIN POSTS -----
// A global disbursement is an explicit, audited administrative decision. The
// environment flags only authorize this endpoint; they never start a run by themselves.
router.post("/admin/start-global-disbursement", async (req, res) => {
  const { pswd, pin, reason, decision_reference, notice_method, notice_reference,
    activation_at_ms } = req.body || {};
  if (
    pswd !== decrypt(admin_pswd, DB_CONFIG.password) ||
    pin !== decrypt(admin_pin, DB_CONFIG.password)
  ) return res.send({ auth: "incorrect" });

  const enabled = (name) => String(process.env[name] || "false").toLowerCase() === "true";
  if (!enabled("USDT_DISBURSEMENTS_ENABLED") || !enabled("USDT_GLOBAL_DISBURSEMENT_ENABLED")) {
    return res.status(403).send({ auth: "global_disbursement_disabled" });
  }
  const triggerReason = typeof reason === "string" ? reason.trim() : "";
  const decisionReference = typeof decision_reference === "string" ? decision_reference.trim() : "";
  const notificationMethod = String(notice_method || "external").trim().toLowerCase();
  const notificationReference = typeof notice_reference === "string" ? notice_reference.trim() : "";
  const windowDays = GLOBAL_DISBURSEMENT_REQUEST_WINDOW_DAYS;
  const extensionDays = GLOBAL_DISBURSEMENT_EXTENSION_DAYS;
  const now = Date.now();
  const activationAt = activation_at_ms == null || String(activation_at_ms).trim() === ""
    ? now + GLOBAL_DISBURSEMENT_NOTICE_MS
    : Number(activation_at_ms);
  if (
    triggerReason.length < 20 || triggerReason.length > 2000 ||
    !/^[A-Za-z0-9._:/-]{6,128}$/.test(decisionReference) ||
    !["external", "email", "telegram", "email_telegram"].includes(notificationMethod) ||
    notificationReference.length < 4 || notificationReference.length > 255
  ) return res.status(400).send({ error: "invalid decision or notice details" });
  try {
    validateGlobalAnnouncement({
      announcedAtMs: now,
      activationAtMs: activationAt,
      requestWindowDays: windowDays,
      extensionDays,
    });
  } catch (error) {
    return res.status(400).send({ error: error.message });
  }

  const treasuryAddress = String(process.env.USDT_BEP20_TREASURY_ADDRESS || "").trim();
  if (!process.env.BSC_RPC_URL || !isEvmAddress(treasuryAddress) || /^0x0{40}$/i.test(treasuryAddress)) {
    return res.status(503).send({ error: "BSC treasury configuration is incomplete" });
  }
  if (["email", "email_telegram"].includes(notificationMethod) && (!SERVER_MAIL || !SERVER_MAIL_PSWD)) {
    return res.status(503).send({ error: "email notification channel is not configured" });
  }

  try {
    const result = await withTransaction(async (tx) => {
      const [lockRows] = await tx.query(
        "SELECT lock_name FROM system_locks WHERE lock_name='common_state' FOR UPDATE",
      );
      if (!lockRows.length) throw new Error("The common-state lock row has not been initialized");
      const common = await getLatestCommonTx(tx, true);
      const [existingRows] = await tx.query(
        `SELECT id,status FROM global_disbursement_runs
         WHERE status IN ('announced','active','closed','manual_review','completed','resolved')
         ORDER BY id DESC LIMIT 1 FOR UPDATE`,
      );
      if (existingRows.length) {
        return { auth: "global_disbursement_already_active", run_id: String(existingRows[0].id), status: existingRows[0].status };
      }

      const [snapshotRows] = await tx.query(
        `SELECT COALESCE(MAX(id),0) AS max_id,
                SUM(CASE WHEN username<>? THEN 1 ELSE 0 END) AS total_users,
                COALESCE(SUM(CASE WHEN username<>? THEN balance ELSE 0 END),0) AS total_initial_asset,
                COALESCE(SUM(CASE WHEN username<>? AND balance<0 THEN 1 ELSE 0 END),0) AS negative_balance_count
         FROM users_stock`, [OneX, OneX, OneX],
      );
      const totalUsers = Number(snapshotRows[0]?.total_users || 0);
      const plannedTotal = new BigNumber(snapshotRows[0]?.total_initial_asset || "0");
      const snapshotPrice = new BigNumber(common.unit_price);
      const snapshotTotal = new BigNumber(common.total_units_price);
      if (!Number.isSafeInteger(totalUsers) || totalUsers < 1 ||
          Number(snapshotRows[0]?.negative_balance_count || 0) !== 0 ||
          !plannedTotal.isFinite() || !plannedTotal.isGreaterThan(0) ||
          !snapshotPrice.isFinite() || !snapshotPrice.isGreaterThan(0) ||
          !snapshotTotal.isFinite() || !snapshotTotal.isGreaterThan(0)) {
        return { auth: "invalid_global_disbursement_snapshot" };
      }

      const bonusRate = CONFIGURED_GLOBAL_DISBURSEMENT_BONUS;
      const provisionalBonusReserve = calculateRequiredAdminBonusReserve(
        plannedTotal.multipliedBy(new BigNumber(1).minus(new BigNumber(tfees).dividedBy(100))), bonusRate,
      );
      const availableAdminReserve = calculateRemainingSystemAdminReserve(
        stock_limit, SYSTEM_ADMIN_RESERVE_RATIO, common.sys_inactive_init_asset || "0",
      ).remainingInitialAsset;
      if (provisionalBonusReserve.gt(availableAdminReserve) || provisionalBonusReserve.gt(common.backed_units)) {
        return { auth: "insufficient_administrative_bonus_reserve" };
      }

      const messageText = [
        "OneX Global Disbursement Announcement",
        "OneX has announced a definitive global disbursement decision.",
        `Planned activation (UTC): ${new Date(activationAt).toISOString()}`,
        `The primary request period will remain open for ${windowDays} days after explicit administrative activation.`,
        `A further ${extensionDays}-day extension follows the primary period. New requests during the extension receive no global bonus.`,
        `The global bonus during the primary period is ${bonusRate.toFixed(2)}% of each accepted net request, subject to the administrative reserve.`,
        "After activation, new deposits and user-to-user P2P transfers will be suspended.",
        "Each user must submit a disbursement request addressed to ONEX before the final extension deadline. The minimum request during both global periods is 1 XTU.",
        "Requests accepted during the primary period retain their bonus even if paid during the extension. Requests accepted during the extension receive no bonus. Accepted but unpaid requests remain protected.",
        "After the extension, no new requests are accepted. Unclaimed balances may then be subject to a separately recorded administrative reallocation.",
        "System tfees are deducted from each gross sale. Estimated BSC network fees are also deducted from each BSC-USD payout.",
      ].join("\n");
      let emailCount = 0;
      let telegramCount = 0;
      if (["email", "email_telegram"].includes(notificationMethod)) {
        const [emailRows] = await tx.query(
          "SELECT COUNT(*) AS count FROM auths WHERE email IS NOT NULL AND TRIM(email)<>''",
        );
        emailCount = Number(emailRows[0]?.count || 0);
        if (emailCount < 1) return { auth: "no_email_recipients" };
      }
      if (["telegram", "email_telegram"].includes(notificationMethod)) {
        const [telegramRows] = await tx.query(
          "SELECT COUNT(*) AS count FROM auths WHERE tg_userId IS NOT NULL AND tg_chat_id IS NOT NULL",
        );
        telegramCount = Number(telegramRows[0]?.count || 0);
        if (telegramCount < 1) return { auth: "no_telegram_recipients" };
      }
      const [insertResult] = await tx.query(
        `INSERT INTO global_disbursement_runs
         (status,trigger_reason,decision_reference,notice_method,notice_reference,request_window_days,extension_days,
          planned_activation_at_ms,request_deadline_at_ms,extension_deadline_at_ms,activated_at_ms,closed_at_ms,
          snapshot_unit_price,snapshot_total_units_price,planned_total_initial_asset,
          last_user_stock_id,max_user_stock_id,total_users,processed_users,total_gross_initial_asset,
          total_requested_initial_asset,total_paid_bsc_usd,bonus_rate_percent,
          admin_bonus_reserved_initial_asset,admin_bonus_committed_initial_asset,
          total_bonus_paid_bsc_usd,total_bonus_paid_initial_asset,total_bsc_gas_actual_usd,
          announced_at_ms,effective_at_ms,last_error,created_at_ms,updated_at_ms)
         VALUES('announced',?,?,?,?,?,?,?,0,0,NULL,NULL,?,?,?,0,?,?,0,0,0,0,?,?,0,0,0,0,?,?,NULL,?,?)`,
        [
          triggerReason, decisionReference, notificationMethod, notificationReference,
          String(windowDays), String(extensionDays), String(activationAt),
          snapshotPrice.toFixed(30), snapshotTotal.toFixed(30), plannedTotal.toFixed(30),
          String(snapshotRows[0]?.max_id || 0), String(totalUsers), bonusRate.toFixed(10),
          provisionalBonusReserve.toFixed(30), String(now), String(activationAt), String(now), String(now),
        ],
      );
      const runId = String(insertResult.insertId);
      if (["email", "email_telegram"].includes(notificationMethod)) {
        await tx.query(
          `INSERT IGNORE INTO global_disbursement_email_outbox
           (run_id,username,recipient,subject,message_text,status,attempts,next_attempt_at_ms,
            claimed_at_ms,last_error,created_at_ms,sent_at_ms)
           SELECT ?,username,email,?,?,'pending',0,?,NULL,NULL,?,NULL
           FROM auths WHERE email IS NOT NULL AND TRIM(email)<>''`,
          [runId, "OneX Global Disbursement Announcement", messageText, String(now), String(now)],
        );
      }
      if (["telegram", "email_telegram"].includes(notificationMethod)) {
        await tx.query(
          `INSERT IGNORE INTO telegram_outbox
           (event_key,username,chat_id,message_text,status,attempts,next_attempt_at_ms,
            claimed_at_ms,last_error,created_at_ms,sent_at_ms)
           SELECT CONCAT(?,':',username),username,tg_chat_id,?,'pending',0,?,NULL,NULL,?,NULL
           FROM auths WHERE tg_userId IS NOT NULL AND tg_chat_id IS NOT NULL`,
          [`global-announcement:${runId}`, messageText, String(now), String(now)],
        );
      }
      return {
        auth: "global_disbursement_announced",
        run_id: runId,
        notice_method: notificationMethod,
        notice_reference: notificationReference,
        announced_at_ms: now,
        planned_activation_at_ms: activationAt,
        notice_period_days: 7,
        request_window_days: windowDays,
        extension_days: extensionDays,
        bonus_rate_percent: bonusRate.toFixed(10),
        provisional_bonus_reserve_initial_asset: provisionalBonusReserve.toFixed(30),
        notification_recipients: { email: emailCount, telegram: telegramCount },
      };
    });
    return res.send(result);
  } catch (error) {
    console.error("Global disbursement announcement failed:", error.message);
    return res.status(500).send({ error: "global disbursement announcement failed" });
  }
});

router.post("/admin/activate-global-disbursement", async (req, res) => {
  const { pswd, pin, run_id } = req.body || {};
  if (
    pswd !== decrypt(admin_pswd, DB_CONFIG.password) ||
    pin !== decrypt(admin_pin, DB_CONFIG.password)
  ) return res.send({ auth: "incorrect" });
  const runId = String(run_id || "").trim();
  if (!/^\d{1,20}$/.test(runId)) return res.status(400).send({ error: "invalid run id" });
  try {
    const result = await withTransaction(async (tx) => {
      const [lockRows] = await tx.query(
        "SELECT lock_name FROM system_locks WHERE lock_name='common_state' FOR UPDATE",
      );
      if (!lockRows.length) throw new Error("The common-state lock row has not been initialized");
      const common = await getLatestCommonTx(tx, true);
      const [runRows] = await tx.query(
        "SELECT * FROM global_disbursement_runs WHERE id=? LIMIT 1 FOR UPDATE", [runId],
      );
      if (!runRows.length || runRows[0].status !== "announced") return { auth: "global_run_not_announced" };
      const run = runRows[0];
      const now = Date.now();
      const plannedActivation = Number(run.planned_activation_at_ms || run.effective_at_ms || 0);
      if (!Number.isSafeInteger(plannedActivation) || now < plannedActivation ||
          now < Number(run.announced_at_ms) + GLOBAL_DISBURSEMENT_NOTICE_MS) {
        return { auth: "global_notice_period_not_completed", planned_activation_at_ms: plannedActivation };
      }
      if (["email", "email_telegram"].includes(run.notice_method)) {
        const [emailRows] = await tx.query(
          `SELECT COUNT(*) AS pending_count,MAX(sent_at_ms) AS last_sent_at
           FROM global_disbursement_email_outbox WHERE run_id=? AND status<>'sent'`, [runId],
        );
        if (Number(emailRows[0]?.pending_count || 0) > 0) return { auth: "global_email_notice_pending" };
        if (emailRows[0]?.last_sent_at && now < Number(emailRows[0].last_sent_at) + GLOBAL_DISBURSEMENT_NOTICE_MS) {
          return { auth: "global_notice_period_after_email_not_completed" };
        }
      }
      if (["telegram", "email_telegram"].includes(run.notice_method)) {
        const [telegramRows] = await tx.query(
          `SELECT COUNT(*) AS pending_count,MAX(sent_at_ms) AS last_sent_at
           FROM telegram_outbox WHERE event_key LIKE ? AND status<>'sent'`, [`global-announcement:${runId}:%`],
        );
        if (Number(telegramRows[0]?.pending_count || 0) > 0) return { auth: "global_telegram_notice_pending" };
        const [sentRows] = await tx.query(
          "SELECT MAX(sent_at_ms) AS last_sent_at FROM telegram_outbox WHERE event_key LIKE ? AND status='sent'",
          [`global-announcement:${runId}:%`],
        );
        if (sentRows[0]?.last_sent_at && now < Number(sentRows[0].last_sent_at) + GLOBAL_DISBURSEMENT_NOTICE_MS) {
          return { auth: "global_notice_period_after_telegram_not_completed" };
        }
      }

      const blockers = [
        ["individual_disbursements", `SELECT id FROM users_usdt_disbursements WHERE disbursement_mode='individual' AND status IN ('queued','signed','submitted','manual_review') LIMIT 1 FOR UPDATE`],
        ["xtu_withdrawals", `SELECT id FROM xtu_withdrawals WHERE status IN ('queued','signed','submitted','manual_review') LIMIT 1 FOR UPDATE`],
        ["seller_campaigns", `SELECT id FROM users_seller_campaigns WHERE status IN ('active','cancel_requested') LIMIT 1 FOR UPDATE`],
        ["seller_payouts", `SELECT id FROM users_usdt_seller_payouts WHERE status IN ('queued','signed','submitted','manual_review') LIMIT 1 FOR UPDATE`],
        ["seller_lots", `SELECT id FROM users_seller_reserve_lots WHERE status='active' AND remaining_initial_asset>0 LIMIT 1 FOR UPDATE`],
        ["seller_allocations", `SELECT id FROM users_seller_payout_allocations WHERE status='reserved' LIMIT 1 FOR UPDATE`],
        ["refunds", `SELECT id FROM users_usdt_refunds WHERE status IN ('queued','signed','submitted','manual_review') LIMIT 1 FOR UPDATE`],
        ["deposit_batches", `SELECT id FROM users_usdt_deposit_batches WHERE status IN ('collecting','batched','ready','finalizing','pending_weekly','pending_reserve','pending_support','refund_queued') LIMIT 1 FOR UPDATE`],
      ];
      for (const [name, sql] of blockers) {
        const [rows] = await tx.query(sql);
        if (rows.length) return { auth: "global_activation_waiting_for_operations", blocker: name };
      }

      const [snapshotRows] = await tx.query(
        `SELECT COALESCE(MAX(id),0) AS max_id,
                SUM(CASE WHEN username<>? THEN 1 ELSE 0 END) AS total_users,
                COALESCE(SUM(CASE WHEN username<>? AND balance<0 THEN 1 ELSE 0 END),0) AS negative_balance_count
         FROM users_stock`, [OneX, OneX],
      );
      const totalUsers = Number(snapshotRows[0]?.total_users || 0);
      const snapshotPrice = new BigNumber(common.unit_price);
      const snapshotTotal = new BigNumber(common.total_units_price);
      if (!Number.isSafeInteger(totalUsers) || totalUsers < 1 ||
          Number(snapshotRows[0]?.negative_balance_count || 0) !== 0 ||
          !snapshotPrice.isFinite() || !snapshotPrice.isGreaterThan(0) ||
          !snapshotTotal.isFinite() || !snapshotTotal.isGreaterThan(0)) {
        return { auth: "invalid_global_activation_snapshot" };
      }

      const [participantStockRows] = await tx.query(
        `SELECT username,balance FROM users_stock WHERE username<>? ORDER BY username ASC FOR UPDATE`,
        [OneX],
      );
      if (participantStockRows.length !== totalUsers) {
        throw new Error("Global disbursement participant count changed during activation");
      }
      const bonusRate = new BigNumber(run.bonus_rate_percent || "0");
      const tfeesRate = new BigNumber(tfees);
      const participantSnapshots = [];
      let totalInitial = new BigNumber(0);
      let totalXtuLiability = new BigNumber(0);
      let requiredBonusReserve = new BigNumber(0);
      for (const participantStock of participantStockRows) {
        const participantBalance = new BigNumber(participantStock.balance);
        if (!participantBalance.isFinite() || participantBalance.isNegative()) {
          throw new Error(`Invalid global participant balance for ${participantStock.username}`);
        }
        await triggerUserPriceThresholdTx(tx, participantStock.username, snapshotPrice);
        const participantPriceState = await getUserPriceStateTx(tx, participantStock.username, true);
        if (!participantPriceState) {
          throw new Error(`Individual remuneration state is missing for ${participantStock.username}`);
        }
        const participantPrice = calculateEffectiveIndividualPrice(
          participantPriceState, participantBalance, snapshotPrice, maxStockDefault,
        ).price;
        const grossXtu = participantBalance.multipliedBy(participantPrice);
        const feeInitial = participantBalance.multipliedBy(tfeesRate).dividedBy(100);
        const netInitial = participantBalance.minus(feeInitial);
        const netXtu = netInitial.multipliedBy(participantPrice);
        const bonusXtu = netXtu.multipliedBy(bonusRate).dividedBy(100);
        const bonusInitial = bonusXtu.dividedBy(participantPrice);
        totalInitial = totalInitial.plus(participantBalance);
        totalXtuLiability = totalXtuLiability.plus(netXtu).plus(bonusXtu);
        requiredBonusReserve = requiredBonusReserve.plus(bonusInitial);
        participantSnapshots.push({
          username: participantStock.username,
          balance: participantBalance,
          basePrice: new BigNumber(participantPriceState.base_price),
          remunerationRate: new BigNumber(participantPriceState.remuneration_rate),
          targetPrice: new BigNumber(participantPriceState.target_price),
          unitPrice: participantPrice,
          status: participantPriceState.status,
        });
      }
      if (!totalInitial.isFinite() || !totalInitial.isGreaterThan(0)) {
        return { auth: "invalid_global_activation_snapshot" };
      }
      const adminReserveAvailable = calculateRemainingSystemAdminReserve(
        stock_limit, SYSTEM_ADMIN_RESERVE_RATIO, common.sys_inactive_init_asset || "0",
      ).remainingInitialAsset;
      if (requiredBonusReserve.gt(adminReserveAvailable) || requiredBonusReserve.gt(common.backed_units)) {
        return { auth: "insufficient_administrative_bonus_reserve", required: requiredBonusReserve.toFixed(30), available: adminReserveAvailable.toFixed(30) };
      }
      const capacity = validateGlobalDisbursementCapacity(snapshotTotal, snapshotPrice, totalInitial, totalXtuLiability);
      if (!capacity.available) return { auth: "global_liability_exceeds_stock_value" };
      const payoutReserve = await checkDisbursementReserveCapacity(
        totalXtuLiability.toFixed(18),
        { queryable: tx },
      );
      if (!payoutReserve.available) {
        return {
          auth: "insufficient_disbursement_wallet_reserve",
          required_bsc_usd: payoutReserve.required_bsc_usd,
          available_bsc_usd: payoutReserve.spendable_bsc_usd,
        };
      }

      let requestWindowDays;
      let extensionDays;
      try {
        requestWindowDays = resolveGlobalDisbursementRequestWindowDays(run.request_window_days);
        extensionDays = resolveGlobalDisbursementExtensionDays(run.extension_days);
      } catch (durationError) {
        return { auth: "invalid_global_disbursement_duration", reason: durationError.message };
      }
      const deadline = getGlobalRequestDeadline(now, requestWindowDays);
      const extensionDeadline = getGlobalRequestDeadline(deadline, extensionDays);
      for (const participant of participantSnapshots) {
        await tx.query(
          `INSERT INTO global_disbursement_participants
           (run_id,username,snapshot_balance_initial,snapshot_base_price,snapshot_remuneration_rate,
            snapshot_target_price,snapshot_unit_price,snapshot_price_status,requested_initial_asset,
            paid_initial_asset,remaining_initial_asset,request_count,last_disbursement_id,status,created_at_ms,updated_at_ms)
           VALUES(?,?,?,?,?,?,?, ?,0,0,?,0,NULL,?,?,?)`,
          [runId, participant.username, participant.balance.toFixed(30), participant.basePrice.toFixed(30),
            participant.remunerationRate.toFixed(10), participant.targetPrice.toFixed(30), participant.unitPrice.toFixed(30),
            participant.status, participant.balance.toFixed(30), participant.balance.isGreaterThan(0) ? "awaiting_request" : "no_balance",
            String(now), String(now)],
        );
      }
      await tx.query(
        `UPDATE global_disbursement_runs
         SET status='active',snapshot_unit_price=?,snapshot_total_units_price=?,
             planned_total_initial_asset=?,last_user_stock_id=0,max_user_stock_id=?,
             total_users=?,processed_users=0,total_gross_initial_asset=0,total_requested_initial_asset=0,
             admin_bonus_reserved_initial_asset=?,admin_bonus_committed_initial_asset=0,
             effective_at_ms=?,activated_at_ms=?,request_deadline_at_ms=?,extension_deadline_at_ms=?,last_error=NULL,updated_at_ms=?
         WHERE id=? AND status='announced'`,
        [snapshotPrice.toFixed(30), snapshotTotal.toFixed(30), totalInitial.toFixed(30),
          String(snapshotRows[0]?.max_id || 0), String(totalUsers), requiredBonusReserve.toFixed(30),
          String(now), String(now), String(deadline), String(extensionDeadline), String(now), runId],
      );
      return {
        auth: "global_disbursement_activated",
        run_id: runId,
        activated_at_ms: now,
        request_deadline_at_ms: deadline,
        extension_deadline_at_ms: extensionDeadline,
        request_window_days: requestWindowDays,
        extension_days: extensionDays,
        snapshot_unit_price: snapshotPrice.toFixed(30),
        participants: totalUsers,
        reserved_bonus_initial_asset: requiredBonusReserve.toFixed(30),
      };
    });
    return res.send(result);
  } catch (error) {
    console.error("Global disbursement activation failed:", error.message);
    return res.status(500).send({ error: "global disbursement activation failed" });
  }
});

router.post("/admin/global-disbursement-participants", async (req, res) => {
  const { pswd, pin, run_id, before_id, status } = req.body || {};
  if (
    pswd !== decrypt(admin_pswd, DB_CONFIG.password) ||
    pin !== decrypt(admin_pin, DB_CONFIG.password)
  ) return res.send({ auth: "incorrect" });
  const runId = String(run_id || "").trim();
  const cursor = before_id == null || String(before_id).trim() === "" ? null : String(before_id).trim();
  const requestedStatus = status == null || String(status).trim() === "" ? null : String(status).trim();
  const allowedStatuses = new Set(["no_balance", "awaiting_request", "request_pending", "paid", "manual_review", "resolved"]);
  if (!/^\d{1,20}$/.test(runId) || (cursor !== null && !/^\d{1,20}$/.test(cursor)) ||
      (requestedStatus !== null && !allowedStatuses.has(requestedStatus))) {
    return res.status(400).send({ error: "invalid participant query" });
  }
  try {
    const conditions = ["run_id=?"];
    const parameters = [runId];
    if (cursor !== null) { conditions.push("id<?"); parameters.push(cursor); }
    if (requestedStatus !== null) { conditions.push("status=?"); parameters.push(requestedStatus); }
    const rows = await db.queryAsync(
      `SELECT id,run_id,username,snapshot_balance_initial,snapshot_base_price,snapshot_remuneration_rate,
              snapshot_target_price,snapshot_unit_price,snapshot_price_status,requested_initial_asset,
              paid_initial_asset,remaining_initial_asset,request_count,last_disbursement_id,
              status,resolution_action,resolution_reference,resolution_reason,resolved_at_ms,
              created_at_ms,updated_at_ms
       FROM global_disbursement_participants
       WHERE ${conditions.join(" AND ")} ORDER BY id DESC LIMIT 50`,
      parameters,
    );
    return res.send({
      run_id: runId,
      participants: rows,
      limit: 50,
      next_before_id: rows.length === 50 ? String(rows[rows.length - 1].id) : null,
    });
  } catch (error) {
    console.error("Global disbursement participant lookup failed:", error.message);
    return res.status(500).send({ error: "global participant history unavailable" });
  }
});

router.post("/admin/resolve-global-disbursement-participant", async (req, res) => {
  const { pswd, pin, run_id, username, action, reference, reason } = req.body || {};
  if (
    pswd !== decrypt(admin_pswd, DB_CONFIG.password) ||
    pin !== decrypt(admin_pin, DB_CONFIG.password)
  ) return res.send({ auth: "incorrect" });
  const runId = String(run_id || "").trim();
  const U = normalizeUsername(username);
  const resolutionAction = String(action || "").trim();
  const resolutionReference = String(reference || "").trim();
  const resolutionReason = typeof reason === "string" ? reason.trim() : "";
  const allowedActions = new Set(["settled_externally", "balance_reconciled", "account_closed"]);
  if (!/^\d{1,20}$/.test(runId) || !U || !allowedActions.has(resolutionAction) ||
      resolutionReference.length < 6 || resolutionReference.length > 255 ||
      resolutionReason.length < 10 || resolutionReason.length > 1000) {
    return res.status(400).send({ error: "invalid participant resolution details" });
  }
  try {
    const result = await withTransaction(async (tx) => {
      const [lockRows] = await tx.query(
        "SELECT lock_name FROM system_locks WHERE lock_name='common_state' FOR UPDATE",
      );
      if (!lockRows.length) throw new Error("The common-state lock row has not been initialized");
      await getLatestCommonTx(tx, true);
      const [runRows] = await tx.query(
        "SELECT id,status,request_deadline_at_ms,extension_deadline_at_ms FROM global_disbursement_runs WHERE id=? LIMIT 1 FOR UPDATE",
        [runId],
      );
      if (!runRows.length || !["closed", "manual_review"].includes(runRows[0].status)) {
        return { auth: "global_run_not_ready_for_manual_resolution" };
      }
      const [participantRows] = await tx.query(
        `SELECT * FROM global_disbursement_participants
         WHERE run_id=? AND username=? LIMIT 1 FOR UPDATE`, [runId, U],
      );
      if (!participantRows.length) return { auth: "global_participant_not_found" };
      const participant = participantRows[0];
      if (!["manual_review", "awaiting_request"].includes(participant.status)) {
        return { auth: "global_participant_not_in_review", status: participant.status };
      }
      const [pendingRows] = await tx.query(
        `SELECT id,status FROM users_usdt_disbursements
         WHERE global_run_id=? AND username=? AND status IN ('queued','signed','submitted','manual_review')
         ORDER BY id DESC LIMIT 1 FOR UPDATE`, [runId, U],
      );
      if (pendingRows.length) return { auth: "disbursement_requires_transaction_reconciliation", disbursement_id: String(pendingRows[0].id) };

      const now = String(Date.now());
      await tx.query(
        `UPDATE global_disbursement_participants
         SET status='resolved',resolution_action=?,resolution_reference=?,resolution_reason=?,
             resolved_at_ms=?,updated_at_ms=?
         WHERE run_id=? AND username=?`,
        [resolutionAction, resolutionReference, resolutionReason, now, now, runId, U],
      );
      await tx.query(
        `INSERT INTO admin_payment_resolutions
         (admin_username,username,batch_id,action,initial_asset_amount,gross_amount,fee_amount,net_amount,
          payout_address,tx_hash,reason,created_at_ms)
         VALUES('configured_admin',?,NULL,?, ?,0,0,0,NULL,NULL,?,?)`,
        [U, `global_${resolutionAction}`, participant.remaining_initial_asset || "0", `${resolutionReference}: ${resolutionReason}`, now],
      );
      return {
        auth: "global_participant_resolution_recorded",
        run_id: runId,
        username: U,
        action: resolutionAction,
        remaining_initial_asset: String(participant.remaining_initial_asset || "0"),
        note: "This endpoint records the administrative resolution only. Any external payment or balance correction must already have been independently reconciled and documented before this action is submitted.",
      };
    });
    return res.send(result);
  } catch (error) {
    console.error("Global participant resolution failed:", error.message);
    return res.status(500).send({ error: "global participant resolution failed" });
  }
});

// Read-only audit endpoint for the latest common reserve snapshots.
router.post("/admin/common-history", async (req, res) => {
  const { pswd, pin, before_id } = req.body || {};
  if (
    pswd !== decrypt(admin_pswd, DB_CONFIG.password) ||
    pin !== decrypt(admin_pin, DB_CONFIG.password)
  ) return res.send({ auth: "incorrect" });
  const cursor = before_id == null || String(before_id).trim() === "" ? null : String(before_id).trim();
  if (cursor !== null && !/^\d{1,20}$/.test(cursor)) {
    return res.status(400).send({ error: "invalid pagination cursor" });
  }
  try {
    const columns = [
      "id", "total_units_price", "unit_price", "backed_units", "inactive_init_asset",
      "sys_inactive_init_asset", "sellers_res", "total_run_balance", "total_tfees",
      "total_tfees_bsc_cost_usd", "total_tfees_bsc_uncovered_usd", "total_bnb_fee_actual",
      "total_bnb_fee_estimated", "total_bnb_fee_actual_value", "total_bnb_fee_estimated_value",
      "record_date", "record_time",
    ];
    const sql = `SELECT ${columns.join(",")} FROM common ${cursor ? "WHERE id<?" : ""} ORDER BY id DESC LIMIT 50`;
    const [rows, hotWallet] = await Promise.all([
      db.queryAsync(sql, cursor ? [cursor] : []),
      getHotWalletTreasurySnapshot(db),
    ]);
    return res.send({
      history: rows,
      limit: 50,
      next_before_id: rows.length === 50 ? String(rows[rows.length - 1].id) : null,
      hot_wallet: hotWallet,
    });
  } catch (error) {
    console.error("Administrative common history lookup failed:", error.message);
    return res.status(500).send({ error: "common history unavailable" });
  }
});

// Release a global run from manual review only when no on-chain payment still
// requires accounting reconciliation. Unpaid balances remain available for a later run.
router.post("/admin/resolve-global-disbursement-review", async (req, res) => {
  const { pswd, pin, run_id, reason } = req.body || {};
  if (
    pswd !== decrypt(admin_pswd, DB_CONFIG.password) ||
    pin !== decrypt(admin_pin, DB_CONFIG.password)
  ) return res.send({ auth: "incorrect" });

  const runId = String(run_id ?? "").trim();
  const resolutionReason = typeof reason === "string" ? reason.trim() : "";
  if (!/^\d{1,20}$/.test(runId) || resolutionReason.length < 10 || resolutionReason.length > 1000) {
    return res.status(400).send({ error: "invalid resolution details" });
  }

  try {
    const result = await withTransaction(async (tx) => {
      const [commonLockRows] = await tx.query(
        "SELECT lock_name FROM system_locks WHERE lock_name='common_state' FOR UPDATE",
      );
      if (!commonLockRows.length) throw new Error("The common-state lock row has not been initialized");
      await getLatestCommonTx(tx, true);
      const [runRows] = await tx.query(
        "SELECT id,status FROM global_disbursement_runs WHERE id=? LIMIT 1 FOR UPDATE", [runId],
      );
      if (!runRows.length || !["closed", "manual_review"].includes(runRows[0].status)) {
        return { auth: "global_run_not_closed_for_review" };
      }

      const [reviewRows] = await tx.query(
        `SELECT id,username,tx_hash,raw_tx,gross_initial_asset,sold_initial_asset,
                bonus_initial_asset,balance_after_reservation
         FROM users_usdt_disbursements
         WHERE global_run_id=? AND status='manual_review'
         ORDER BY id ASC FOR UPDATE`,
        [runId],
      );
      for (const row of reviewRows) {
        if (row.tx_hash || row.raw_tx) {
          return { auth: "on_chain_transaction_requires_reconciliation", disbursement_id: String(row.id) };
        }
        const [stockRows] = await tx.query(
          "SELECT balance FROM users_stock WHERE username=? LIMIT 1 FOR UPDATE", [row.username],
        );
        if (!stockRows.length || !new BigNumber(stockRows[0].balance).eq(row.balance_after_reservation)) {
          return { auth: "user_balance_changed_requires_reconciliation", username: row.username };
        }
      }

      const now = String(Date.now());
      for (const row of reviewRows) {
        const [stockRows] = await tx.query(
          "SELECT balance FROM users_stock WHERE username=? LIMIT 1 FOR UPDATE", [row.username],
        );
        const restoredBalance = new BigNumber(stockRows[0].balance).plus(row.gross_initial_asset || "0");
        const [date, time] = getDate();
        await tx.query(
          "UPDATE users_stock SET balance=?,record_date=?,record_time=? WHERE username=?",
          [restoredBalance.toFixed(30), date, time, row.username],
        );
        await markPendingDepositBatchesDueTx(tx, row.username);
        await tx.query(
          `UPDATE users_usdt_disbursements
           SET status='failed',last_error=?,updated_at_ms=? WHERE id=? AND status='manual_review'`,
          [`Admin confirmed no transaction was broadcast; reserved principal restored. ${resolutionReason}`, now, row.id],
        );
        await tx.query(
          `UPDATE global_disbursement_participants
           SET requested_initial_asset=GREATEST(0,requested_initial_asset-?),
               remaining_initial_asset=?,status='manual_review',updated_at_ms=?
           WHERE run_id=? AND username=?`,
          [String(row.gross_initial_asset || "0"), restoredBalance.toFixed(30), now, runId, row.username],
        );
        await tx.query(
          `UPDATE global_disbursement_runs
           SET admin_bonus_committed_initial_asset=GREATEST(0,admin_bonus_committed_initial_asset-?),
               total_requested_initial_asset=GREATEST(0,total_requested_initial_asset-?),updated_at_ms=?
           WHERE id=?`,
          [String(row.bonus_initial_asset || "0"), String(row.gross_initial_asset || "0"), now, runId],
        );
        await tx.query(
          `INSERT INTO admin_payment_resolutions
           (admin_username,username,batch_id,action,initial_asset_amount,gross_amount,fee_amount,net_amount,
            payout_address,tx_hash,reason,created_at_ms)
           VALUES('configured_admin',?,NULL,'global_job_released',?,0,0,0,NULL,NULL,?,?)`,
          [row.username, String(row.gross_initial_asset || "0"), resolutionReason, now],
        );
      }
      await tx.query(
        `UPDATE global_disbursement_runs
         SET last_error=?,updated_at_ms=?
         WHERE id=? AND status IN ('closed','manual_review')`,
        [`A payout job was released by administration: ${resolutionReason}`, now, runId],
      );
      return {
        auth: "global_payment_jobs_review_released",
        run_id: runId,
        released_manual_review_accounts: reviewRows.length,
        note: "No payment was issued for released review rows. The participant remains subject to the global administrative resolution process.",
      };
    });
    return res.send(result);
  } catch (error) {
    console.error("Global disbursement review resolution failed:", error.message);
    return res.status(500).send({ error: "global review resolution failed" });
  }
});

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
        account_deactivated: "deactivated",
      };
      return res.send({ auth: messages[issue.reason] || "error" });
    }

    return res.send({ auth: "temporary password sent", expires_in: issue.expiresInSeconds });
  } catch (error) {
    console.error("Admin temporary-password issuance failed:", error.message);
    return res.send({ auth: "error" });
  }
});

// Account access changes are always recorded with the administrator-provided reason.
function parseDepositBatchReasons(raw) {
  try {
    const parsed = JSON.parse(raw || "[]");
    return Array.isArray(parsed) ? [...new Set(parsed.filter((item) => typeof item === "string"))] : [];
  } catch {
    return ["invalid_stored_reason_data"];
  }
}

async function holdOutstandingDepositBatchesForDeactivatedAccount(username) {
  return withTransaction(async (tx) => {
    const [batchRows] = await tx.query(
      `SELECT * FROM users_usdt_deposit_batches
       WHERE username=? AND remaining_amount>0
         AND status IN ('collecting','batched','ready','finalizing','pending_minimum',
                        'pending_credit','pending_weekly','pending_reserve','pending_support','pending_global')
       ORDER BY id ASC FOR UPDATE`,
      [username],
    );
    const now = Date.now();
    const batchIds = [];
    for (const batch of batchRows) {
      const reasons = parseDepositBatchReasons(batch.reason_codes)
        .filter((reason) => reason !== "account_unavailable");
      if (!reasons.includes("account_deactivated")) reasons.push("account_deactivated");
      const reasonJson = safeJson(reasons);
      await tx.query(
        `UPDATE users_usdt_deposit_batches
         SET status='pending_support',pending_since_ms=COALESCE(pending_since_ms,?),
             next_attempt_at_ms=NULL,reason_codes=?,updated_at_ms=?
         WHERE id=? AND remaining_amount>0`,
        [String(now), reasonJson, String(now), String(batch.id)],
      );
      await updateBatchEventStatus(tx, batch.id, "pending_support", reasons);
      await queueDepositBatchStatusTx(
        tx,
        username,
        batch.id,
        "pending_support",
        reasons,
        null,
        {
          sessionTotal: String(batch.total_amount || "0"),
          creditedAmount: String(batch.credited_amount || "0"),
          remainingAmount: String(batch.remaining_amount || "0"),
        },
      );
      batchIds.push(String(batch.id));
    }
    return { count: batchIds.length, batchIds };
  });
}

async function releaseDeactivatedDepositBatches(username) {
  return withTransaction(async (tx) => {
    const [batchRows] = await tx.query(
      `SELECT * FROM users_usdt_deposit_batches
       WHERE username=? AND remaining_amount>0 AND status='pending_support'
         AND JSON_VALID(reason_codes)=1
         AND JSON_CONTAINS(reason_codes, JSON_QUOTE('account_deactivated'))=1
       ORDER BY id ASC FOR UPDATE`,
      [username],
    );
    const now = Date.now();
    const batchIds = [];
    for (const batch of batchRows) {
      const reasons = parseDepositBatchReasons(batch.reason_codes)
        .filter((reason) => reason !== "account_deactivated");
      const reasonJson = reasons.length ? safeJson(reasons) : null;
      const expiresAt = Number(batch.expires_at_ms || now);
      const nextAttemptAt = Math.max(now, Number.isSafeInteger(expiresAt) && expiresAt > 0 ? expiresAt : now);
      await tx.query(
        `UPDATE users_usdt_deposit_batches
         SET status='pending_support',next_attempt_at_ms=?,reason_codes=?,updated_at_ms=?
         WHERE id=? AND remaining_amount>0 AND status='pending_support'`,
        [String(nextAttemptAt), reasonJson, String(now), String(batch.id)],
      );
      await updateBatchEventStatus(tx, batch.id, "pending_support", reasons);
      await queueDepositBatchStatusTx(
        tx,
        username,
        batch.id,
        "pending_support",
        reasons,
        nextAttemptAt > now ? nextAttemptAt : null,
        {
          sessionTotal: String(batch.total_amount || "0"),
          creditedAmount: String(batch.credited_amount || "0"),
          remainingAmount: String(batch.remaining_amount || "0"),
          accountReactivated: true,
        },
      );
      batchIds.push(String(batch.id));
    }
    return { count: batchIds.length, batchIds };
  });
}

function wakeDepositBatchesImmediately(batchIds) {
  const ids = [...new Set((batchIds || []).map((id) => String(id)).filter((id) => /^\d+$/.test(id)))];
  if (!ids.length) return;
  setImmediate(() => {
    void (async () => {
      for (const batchId of ids) {
        try {
          await processOneDepositBatch(batchId);
        } catch (error) {
          console.error(`Immediate deposit wake-up failed for batch ${batchId}:`, error.message);
        }
      }
      try {
        await processDepositBatchQueue();
      } catch (error) {
        console.error("Deposit queue wake-up failed after account reactivation:", error.message);
      }
    })();
  });
}

async function changeAccountAccess(req, res, action) {
  const { pswd, pin, user, username, reason } = req.body || {};
  if (
    pswd !== decrypt(admin_pswd, DB_CONFIG.password) ||
    pin !== decrypt(admin_pin, DB_CONFIG.password)
  ) return res.send({ auth: "incorrect" });

  const U = normalizeUsername(username || user);
  const normalizedReason = typeof reason === "string" ? reason.trim() : "";
  if (!U || U.length > 30) {
    return res.status(400).send({ auth: "invalid username" });
  }
  if (action === "deactivated" && (normalizedReason.length < 5 || normalizedReason.length > 1000)) {
    return res.status(400).send({ auth: "invalid reason" });
  }
  if (action === "activated" && normalizedReason.length > 1000) {
    return res.status(400).send({ auth: "invalid reason" });
  }

  try {
    let result = await withTransaction(async (tx) => {
      const [authRows] = await tx.query(
        "SELECT username,account_active FROM auths WHERE username=? LIMIT 1 FOR UPDATE",
        [U],
      );
      if (!authRows.length) return { account: "not found" };

      const currentlyActive = Number(authRows[0].account_active) === 1;
      if (action === "deactivated" && !currentlyActive) {
        return { account: "already deactivated", account_active: 0 };
      }
      if (action === "activated" && currentlyActive) {
        return { account: "already active", account_active: 1 };
      }

      const now = String(Date.now());
      const auditReason = action === "deactivated"
        ? normalizedReason
        : (normalizedReason || "Account reactivated by an administrator.");
      if (action === "deactivated") {
        await tx.query(
          `UPDATE auths
           SET account_active=0,account_deactivation_reason=?,account_deactivated_at_ms=?,account_deactivated_by='admin'
           WHERE username=? AND account_active=1`,
          [normalizedReason, now, U],
        );
      } else {
        await tx.query(
          `UPDATE auths
           SET account_active=1,account_deactivation_reason=NULL,account_deactivated_at_ms=NULL,account_deactivated_by=NULL
           WHERE username=? AND account_active=0`,
          [U],
        );
      }
      await tx.query(
        `INSERT INTO account_access_events(username,action,reason,changed_by,created_at_ms)
         VALUES(?,?,?,?,?)`,
        [U, action, auditReason, "admin", now],
      );
      return {
        account: action,
        account_active: action === "activated" ? 1 : 0,
        reason: auditReason,
        changed_at_ms: Number(now),
      };
    });

    if (action === "deactivated" && ["deactivated", "already deactivated"].includes(result.account)) {
      const holdResult = await holdOutstandingDepositBatchesForDeactivatedAccount(U);
      result = { ...result, deposit_batches_held: holdResult.count };
    }

    if (action === "activated" && ["activated", "already active"].includes(result.account)) {
      const wakeResult = await releaseDeactivatedDepositBatches(U);
      wakeDepositBatchesImmediately(wakeResult.batchIds);
      result = { ...result, deposit_batches_woken: wakeResult.count };
    }

    return res.send(result);
  } catch (error) {
    console.error(`Account ${action} operation failed:`, error.message);
    return res.status(500).send({ auth: "error" });
  }
}

router.post("/admin/deactivate-account", async (req, res) => {
  return changeAccountAccess(req, res, "deactivated");
});

router.post("/admin/activate-account", async (req, res) => {
  return changeAccountAccess(req, res, "activated");
});

// Admin unlock releases only the seller lot's remaining units; sold units remain in payout settlement.
router.post("/admin/unlock-system-seller", async (req, res) => {
  const { pswd, pin, username, campaign_id, reason } = req.body || {};
  if (
    pswd !== decrypt(admin_pswd, DB_CONFIG.password) ||
    pin !== decrypt(admin_pin, DB_CONFIG.password)
  ) return res.send({ auth: "incorrect" });
  const U = normalizeUsername(username);
  const campaignId = String(campaign_id ?? "").trim();
  const resolutionReason = typeof reason === "string" ? reason.trim() : "";
  if (!U || !/^\d{1,20}$/.test(campaignId) || resolutionReason.length < 5 || resolutionReason.length > 1000) {
    return res.status(400).send({ auth: "invalid request" });
  }
  try {
    const result = await withTransaction(async (tx) => {
      const [commonLockRows] = await tx.query(
        "SELECT lock_name FROM system_locks WHERE lock_name=? FOR UPDATE", ["common_state"],
      );
      if (!commonLockRows.length) throw new Error("The common-state lock row has not been initialized");
      const common = await getLatestCommonTx(tx, true);
      const [campaignRows] = await tx.query(
        `SELECT * FROM users_seller_campaigns
         WHERE id=? AND username=? AND status IN ('active','cancel_requested') LIMIT 1 FOR UPDATE`,
        [campaignId, U],
      );
      if (!campaignRows.length) return { auth: "not eligible" };
      const [lotRows] = await tx.query(
        "SELECT * FROM users_seller_reserve_lots WHERE campaign_id=? LIMIT 1 FOR UPDATE",
        [campaignId],
      );
      if (!lotRows.length) throw new Error("Seller reserve lot is missing");
      const lot = lotRows[0];
      const remainingInitialAsset = new BigNumber(lot.remaining_initial_asset);
      const lockedRunBalanceInitial = new BigNumber(campaignRows[0].run_balance);
      const currentRunBalance = new BigNumber(common.total_run_balance || "0");
      const newSellersReserve = new BigNumber(common.sellers_res).minus(remainingInitialAsset);
      const newTotalRunBalance = currentRunBalance.minus(lockedRunBalanceInitial);
      const campaignPrice = new BigNumber(campaignRows[0].unit_price);
      if (
        !remainingInitialAsset.isFinite() || remainingInitialAsset.isNegative() ||
        !lockedRunBalanceInitial.isFinite() || lockedRunBalanceInitial.isNegative() ||
        !campaignPrice.isFinite() || !campaignPrice.isGreaterThan(0) ||
        newSellersReserve.isNegative() || newTotalRunBalance.isNegative()
      ) throw new Error("Seller reserve totals are inconsistent");
      const releasedXtuAtCampaignPrice = remainingInitialAsset.multipliedBy(campaignPrice);
      const now = String(Date.now());
      await tx.query(
        `UPDATE users_seller_reserve_lots
         SET remaining_initial_asset=0,status='cancelled',updated_at_ms=? WHERE id=?`,
        [now, lot.id],
      );
      await tx.query(
        `UPDATE users_seller_campaigns SET status='cancelled',closed_at_ms=?,close_reason='admin_unlock'
         WHERE id=?`,
        [now, campaignId],
      );
      await tx.query(
        `UPDATE users_stock SET seller_status=0,run_balance=0,seller_activated_at_ms=NULL,seller_expires_at_ms=NULL
         WHERE username=?`,
        [U],
      );
      const [date, time] = formatUtcRecordDateTime(Number(now));
      await insertCommonSnapshotTx(tx, common, {
        sellers_res: newSellersReserve.toFixed(30),
        total_run_balance: newTotalRunBalance.toFixed(30),
      }, date, time);
      await tx.query(
        `INSERT INTO admin_payment_resolutions
         (admin_username,username,batch_id,action,initial_asset_amount,gross_amount,fee_amount,net_amount,payout_address,tx_hash,reason,created_at_ms)
         VALUES('configured_admin',?,NULL,'seller_unlocked',?,'0','0','0',NULL,NULL,?,?)`,
        [U, remainingInitialAsset.toFixed(30), resolutionReason, now],
      );
      await queueTelegramMessageTx(tx, U, `seller-campaign:${campaignId}:unlocked`, [
        "OneX Seller Update",
        "OneX support has released the unused part of your seller reserve.",
        `Released: ${releasedXtuAtCampaignPrice.toFixed(8)} XTU at the campaign-locked valuation`,
        `Released initial assets: ${remainingInitialAsset.toFixed(30)}`,
        `Campaign: ${campaignId}`,
        "Previously sold amounts remain in the seller payout queue.",
        "Status: UNLOCKED",
      ].join("\n"));
      return {
        auth: "ok",
        campaign_id: campaignId,
        released_units: releasedXtuAtCampaignPrice.toFixed(18),
        released_initial_asset: remainingInitialAsset.toFixed(30),
      };
    });
    return res.send(result);
  } catch (error) {
    console.error("Admin seller unlock failed:", error.message);
    return res.send({ auth: "error" });
  }
});

// Administrative account and financial overview. Sensitive authentication secrets are never returned.
router.post("/admin/user-info", async (req, res) => {
  const { pswd, pin, username, user } = req.body || {};
  if (
    pswd !== decrypt(admin_pswd, DB_CONFIG.password) ||
    pin !== decrypt(admin_pin, DB_CONFIG.password)
  ) return res.send({ auth: "incorrect" });

  const U = normalizeUsername(username ?? user);
  if (!U || U === OneX) return res.status(400).send({ error: "invalid user" });

  try {
    const [accountRows, stockRows, commonRows, depositRows, disbursementRows, refundRequestRows, refundRows, sellerPayoutRows] = await Promise.all([
      db.queryAsync(
        `SELECT username,name,email,birthdate,wallet_address,account_active,account_deactivation_reason,
                account_deactivated_at_ms,account_deactivated_by,created_at_ms,last_login_at_ms
         FROM auths WHERE username=? LIMIT 1`, [U],
      ),
      db.queryAsync(
        "SELECT balance,run_balance,seller_status,seller_activated_at_ms,seller_expires_at_ms FROM users_stock WHERE username=? LIMIT 1", [U],
      ),
      db.queryAsync("SELECT unit_price FROM common ORDER BY id DESC LIMIT 1"),
      db.queryAsync(
        `SELECT id,total_amount,credited_amount,remaining_amount,refunded_amount,reserved_refund_amount,
                tfees_rate_percent,transfer_count,status,reason_codes,opened_at_ms,expires_at_ms,
                release_at_ms,next_attempt_at_ms,created_at_ms,updated_at_ms
         FROM users_usdt_deposit_batches
         WHERE username=? AND (remaining_amount>0 OR reserved_refund_amount>0)
         ORDER BY id ASC`, [U],
      ),
      db.queryAsync(
        `SELECT id,requested_amount,payout_amount,fee_amount,disbursement_mode,status,tx_hash,
                last_error,created_at_ms,updated_at_ms,confirmed_at_ms,payout_address
         FROM users_usdt_disbursements
         WHERE username=? AND status IN ('queued','signed','submitted','manual_review')
         ORDER BY id ASC`, [U],
      ),
      db.queryAsync(
        `SELECT r.id,r.request_reference,r.batch_id,r.request_type,r.user_reason,r.status,
                r.refund_id,r.admin_username,r.admin_reason,r.last_error,r.created_at_ms,
                r.updated_at_ms,r.approved_at_ms,r.resolved_at_ms,r.completed_at_ms,r.failed_at_ms,
                f.status AS refund_status,f.tx_hash,f.gross_amount,f.fee_amount,f.amount AS net_amount
         FROM user_usdt_refund_requests r
         LEFT JOIN users_usdt_refunds f ON f.id=r.refund_id
         WHERE r.username=? ORDER BY r.id DESC LIMIT 100`, [U],
      ),
      db.queryAsync(
        `SELECT id,reference,batch_id,user_request_id,amount,gross_amount,fee_amount,status,
                tx_hash,payout_address,last_error,created_at_ms,updated_at_ms,confirmed_at_ms,
                estimated_fee_usd,actual_fee_usd
         FROM users_usdt_refunds WHERE username=? ORDER BY id DESC LIMIT 100`, [U],
      ),
      db.queryAsync(
        `SELECT id,batch_id,gross_amount,payout_amount,status,tx_hash,last_error,created_at_ms,
                updated_at_ms,confirmed_at_ms,payout_address
         FROM users_usdt_seller_payouts
         WHERE username=? AND status IN ('queued','signed','submitted','manual_review')
         ORDER BY id ASC`, [U],
      ),
    ]);

    if (!accountRows.length) return res.send({ auth: "user not found" });
    const account = accountRows[0];
    const stock = stockRows[0] || { balance: "0", run_balance: "0", seller_status: 0 };
    const unitPrice = new BigNumber(commonRows[0]?.unit_price || "0");
    const balanceInitial = new BigNumber(stock.balance || "0");
    const runBalanceInitial = new BigNumber(stock.run_balance || "0");
    const pendingDepositAmount = depositRows.reduce(
      (sum, row) => sum.plus(row.remaining_amount || "0"), new BigNumber(0),
    );
    const refundReservedAmount = depositRows.reduce(
      (sum, row) => sum.plus(row.reserved_refund_amount || "0"), new BigNumber(0),
    );

    return res.send({
      auth: "ok",
      user: {
        username: account.username,
        name: account.name,
        email: account.email,
        birthdate: account.birthdate,
        wallet_address: account.wallet_address,
        account_status: Number(account.account_active) === 1 ? "active" : "deactivated",
        deactivation_reason: account.account_deactivation_reason,
        deactivated_at_ms: account.account_deactivated_at_ms == null ? null : Number(account.account_deactivated_at_ms),
        deactivated_by: account.account_deactivated_by,
        created_at_ms: Number(account.created_at_ms),
        last_login_at_ms: account.last_login_at_ms == null ? null : Number(account.last_login_at_ms),
      },
      balance: {
        principal_initial_asset: balanceInitial.toFixed(30),
        principal_xtu: balanceInitial.multipliedBy(unitPrice).toFixed(18),
        run_balance_initial_asset: runBalanceInitial.toFixed(30),
        run_balance_xtu: runBalanceInitial.multipliedBy(unitPrice).toFixed(18),
        seller_status: Number(stock.seller_status || 0),
        global_unit_price: unitPrice.toFixed(30),
      },
      deposits: {
        has_pending: depositRows.length > 0,
        pending_amount_bsc_usd: pendingDepositAmount.toFixed(18),
        refund_reserved_amount_bsc_usd: refundReservedAmount.toFixed(18),
        batches: depositRows.map((row) => ({
          id: String(row.id),
          total_amount_bsc_usd: String(row.total_amount),
          credited_amount_bsc_usd: String(row.credited_amount),
          remaining_amount_bsc_usd: String(row.remaining_amount),
          refund_reserved_amount_bsc_usd: String(row.reserved_refund_amount),
          refunded_amount_bsc_usd: String(row.refunded_amount),
          tfees_rate_percent: String(row.tfees_rate_percent),
          transfer_count: Number(row.transfer_count),
          status: row.status,
          reason_codes: parseDepositBatchReasons(row.reason_codes),
          opened_at_ms: Number(row.opened_at_ms),
          expires_at_ms: Number(row.expires_at_ms),
          release_at_ms: row.release_at_ms == null ? null : Number(row.release_at_ms),
          next_attempt_at_ms: row.next_attempt_at_ms == null ? null : Number(row.next_attempt_at_ms),
          created_at_ms: Number(row.created_at_ms),
          updated_at_ms: Number(row.updated_at_ms),
        })),
      },
      disbursements: disbursementRows.map((row) => ({
        id: String(row.id), status: row.status, mode: row.disbursement_mode,
        requested_amount_xtu: String(row.requested_amount), payout_amount_bsc_usd: String(row.payout_amount),
        fee_amount_bsc_usd: String(row.fee_amount), tx_hash: row.tx_hash, last_error: row.last_error,
        payout_address: row.payout_address, created_at_ms: Number(row.created_at_ms),
        updated_at_ms: Number(row.updated_at_ms), confirmed_at_ms: row.confirmed_at_ms == null ? null : Number(row.confirmed_at_ms),
      })),
      refund_requests: refundRequestRows.map((row) => ({
        id: String(row.id), request_reference: row.request_reference, batch_id: String(row.batch_id),
        request_type: row.request_type, user_reason: row.user_reason, status: row.status,
        refund_id: row.refund_id == null ? null : String(row.refund_id), refund_status: row.refund_status,
        admin_username: row.admin_username, admin_reason: row.admin_reason, last_error: row.last_error,
        tx_hash: row.tx_hash, gross_amount_bsc_usd: row.gross_amount == null ? null : String(row.gross_amount),
        fee_amount_bsc_usd: row.fee_amount == null ? null : String(row.fee_amount),
        net_amount_bsc_usd: row.net_amount == null ? null : String(row.net_amount),
        created_at_ms: Number(row.created_at_ms), updated_at_ms: Number(row.updated_at_ms),
        approved_at_ms: row.approved_at_ms == null ? null : Number(row.approved_at_ms),
        resolved_at_ms: row.resolved_at_ms == null ? null : Number(row.resolved_at_ms),
        completed_at_ms: row.completed_at_ms == null ? null : Number(row.completed_at_ms),
        failed_at_ms: row.failed_at_ms == null ? null : Number(row.failed_at_ms),
      })),
      refunds: refundRows.map((row) => ({
        id: String(row.id), reference: row.reference, batch_id: row.batch_id == null ? null : String(row.batch_id),
        user_request_id: row.user_request_id == null ? null : String(row.user_request_id),
        gross_amount_bsc_usd: String(row.gross_amount), amount_net_bsc_usd: String(row.amount),
        fee_amount_bsc_usd: String(row.fee_amount), status: row.status, tx_hash: row.tx_hash,
        payout_address: row.payout_address, last_error: row.last_error,
        estimated_fee_usd: String(row.estimated_fee_usd), actual_fee_usd: row.actual_fee_usd == null ? null : String(row.actual_fee_usd),
        created_at_ms: Number(row.created_at_ms), updated_at_ms: Number(row.updated_at_ms),
        confirmed_at_ms: row.confirmed_at_ms == null ? null : Number(row.confirmed_at_ms),
      })),
      seller_payouts: sellerPayoutRows.map((row) => ({
        id: String(row.id), batch_id: String(row.batch_id), gross_amount_bsc_usd: String(row.gross_amount),
        payout_amount_bsc_usd: String(row.payout_amount), status: row.status, tx_hash: row.tx_hash,
        payout_address: row.payout_address, last_error: row.last_error,
        created_at_ms: Number(row.created_at_ms), updated_at_ms: Number(row.updated_at_ms),
        confirmed_at_ms: row.confirmed_at_ms == null ? null : Number(row.confirmed_at_ms),
      })),
    });
  } catch (error) {
    console.error("Administrative user-info lookup failed:", error.message);
    return res.status(500).send({ auth: "error" });
  }
});

// Apply an administrator-approved credit to one user's stock through the
// normal deposit allocation rules. The automatic minimum is bypassed, while
// reserve priority, system-funded cooldown/cap, fees and the 300 XTU balance cap remain enforced.
router.post("/admin/update-user-stock", async (req, res) => {
  const { pswd, pin, amount, user } = req.body || {};
  if (
    pswd !== decrypt(admin_pswd, DB_CONFIG.password) ||
    pin !== decrypt(admin_pin, DB_CONFIG.password)
  ) {
    return res.send({ auth: "incorrect" });
  }

  const U = normalizeUsername(user);
  if (!U || U === OneX) {
    return res.status(400).send({ error: "invalid user" });
  }

  const amountText = String(amount ?? "").trim();
  if (!amountText || amountText.length > 100) {
    return res.status(400).send({ error: "invalid amount" });
  }
  const amountValue = new BigNumber(amountText);
  if (!amountValue.isFinite() || !amountValue.isGreaterThan(0)) {
    return res.status(400).send({ error: "invalid amount" });
  }

  const [date, time] = getDate();
  const eventTimestampMs = Date.now();
  try {
    const result = await withTransaction(async (tx) => {
      const reference = createFinancialReference(`ADMTOP${U}`);
      return applyUserTopUp(
        tx,
        U,
        amountValue,
        reference,
        date,
        time,
        eventTimestampMs,
        { enforceDepositRange: false, allowReviewedAdminCredit: true },
      );
    });

    return res.send(result);
  } catch (error) {
    console.error("Administrative user-stock credit failed:", error);
    return res.send({ error: "error" });
  }
});

// Spend XTU from the protected administrative portion of the common stock.
// This endpoint never modifies an individual user's balance.
router.post("/admin/update-common-stock", async (req, res) => {
  const { pswd, pin, amount, user } = req.body || {};
  if (
    pswd !== decrypt(admin_pswd, DB_CONFIG.password) ||
    pin !== decrypt(admin_pin, DB_CONFIG.password)
  ) {
    return res.send({ auth: "incorrect" });
  }

  // Accept the former explicit common marker, but never route a username here.
  if (req.body?.username !== undefined || (user !== undefined && (
    typeof user !== "string" || user.trim().toLowerCase() !== "common"
  ))) {
    return res.status(400).send({ error: "use /admin/update-user-stock for individual user balances" });
  }

  const amountText = String(amount ?? "").trim();
  if (!amountText || amountText.length > 100) {
    return res.status(400).send({ error: "invalid amount" });
  }
  const amountValue = new BigNumber(amountText);
  if (!amountValue.isFinite() || !amountValue.isGreaterThan(0)) {
    return res.status(400).send({ error: "invalid amount" });
  }

  const [date, time] = getDate();
  try {
    const result = await withTransaction(async (tx) => {
      const [commonLockRows] = await tx.query(
        "SELECT lock_name FROM system_locks WHERE lock_name=? FOR UPDATE",
        ["common_state"],
      );
      if (commonLockRows.length === 0) {
        throw new Error("The common-state lock row has not been initialized");
      }

      const common = await getLatestCommonTx(tx, true);
      const [activeGlobalRuns] = await tx.query(
        "SELECT id FROM global_disbursement_runs WHERE status IN ('announced','active','closed','manual_review','completed','resolved') ORDER BY id DESC LIMIT 1 FOR UPDATE",
      );
      if (activeGlobalRuns.length) return { error: "global disbursement in progress" };
      const calculation = calculateAdminCommonStockUpdate(
        amountValue,
        common.total_units_price,
        common.unit_price,
        common.backed_units,
        common.sys_inactive_init_asset || "0",
        stock_limit,
        SYSTEM_ADMIN_RESERVE_RATIO,
      );
      if (!calculation.available) {
        return { limit: `BSC-USD ${calculation.availableValue.toFixed(18)}` };
      }

      await insertCommonSnapshotTx(tx, common, {
        total_units_price: calculation.newTotalUnitsPrice.toFixed(),
        unit_price: calculation.newUnitPrice.toFixed(),
        backed_units: calculation.newBackedUnits.toFixed(),
        sys_inactive_init_asset: calculation.newSysInactiveInitAsset.toFixed(),
      }, date, time);
      return {
        total_units_price: "updated",
        amount_xtu: amountValue.toFixed(18),
        spent_initial_asset: calculation.spentInitialAsset.toFixed(30),
        remaining_admin_initial_asset: calculation.remainingAdminInitialAsset.toFixed(30),
      };
    });

    return res.send(result);
  } catch (error) {
    console.error("Administrative common-stock expenditure failed:", error);
    return res.send({ error: "error" });
  }
});

async function initializeDepositPayments() {
  startGlobalDisbursementEmailOutbox();
  startAccountSecurityEmailOutbox();
  const providerInfo = await initializePaymentProvider();
  if (providerInfo.enabled) {
    const treasuryLower = String(providerInfo.treasuryAddress || "").toLowerCase();
    const walletCollisionRows = await db.queryAsync(
      `SELECT username FROM bsc_wallet_address_registry
       WHERE wallet_address_lower=? LIMIT 1`,
      [treasuryLower],
    );
    if (walletCollisionRows.length) {
      throw new Error(
        `The configured OneX treasury address is permanently registered as a user wallet (${walletCollisionRows[0].username}). Choose a different treasury address.`,
      );
    }
    startDepositBatchWorker();
    startUsdtPaymentWatcher(db, processConfirmedUsdtPayment);
  }
  return providerInfo;
}

router.initializeDepositPayments = initializeDepositPayments;

module.exports = router;
