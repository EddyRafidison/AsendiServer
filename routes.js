require("dotenv").config();

const express = require("express");
const crypto = require("crypto");
const { getAddress: checksumEvmAddress, verifyMessage, hashMessage, Interface: EthersInterface, JsonRpcProvider } = require("ethers");
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
  calculateRemainingAdministrativeBacking,
  calculateAdministrativeReserveExpense,
  calculateAdministrativeReserveRecovery,
  calculateCommonReserveGift,
  calculateUnreservedDistributableInitialAssets,
  calculateTopUpReserveAllocation,
} = require("./stock-accounting");
const {
  MIN_DEPOSIT_AMOUNT,
  MAX_DEPOSIT_AMOUNT,
  MAX_INITIAL_CREDIT_TRANCHE_AMOUNT,
  MAX_DEFAULT_STOCK,
  DEPOSIT_PENDING_EXPIRATION_DAYS,
  DEPOSIT_PENDING_EXPIRATION_MS,
  DISBURSEMENT_COOLDOWN_DAYS,
  getLastOneXSystemFundedPurchase,
  assessOneXSystemFundingCooldown,
  formatUtcRecordDateTime,
  getSystemFundingCooldownReleaseAt,
  validateDepositAmount,
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
const {
  ensureWalletFinancialLockTx,
  registerAutomaticRefundEventTx,
  getOutstandingRefundObligationsTx,
} = require("./automatic-refund-service");
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
  const protectedFloor = calculateRemainingAdministrativeBacking(
    stock_limit,
    SYSTEM_ADMIN_RESERVE_RATIO,
    common.admin_expens || "0",
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


const { getXtuSettings, getXtuRuntime, isXtuDepositWorkerEnabled } = require("./xtu-withdrawal-chain");
const { assignUnknownXtuTransferToAccount } = require("./xtu-deposit-worker");
const EIP1271_INTERFACE = new EthersInterface([
  "function isValidSignature(bytes32 hash, bytes signature) view returns (bytes4)",
]);
const EIP1271_MAGIC_VALUE = "0x1626ba7e";

async function getBscAddressProofProvider() {
  const candidates = [
    process.env.BSC_INCOMING_RPC_URL,
    process.env.BSC_RPC_URL,
    process.env.BSC_INCOMING_RPC_FALLBACK_URL,
  ].map((value) => String(value || "").trim()).filter(Boolean);
  let lastError = null;
  for (const url of [...new Set(candidates)]) {
    if (!/^https:\/\//i.test(url)) continue;
    const provider = new JsonRpcProvider(url, { name: "bnb-smart-chain", chainId: 56 });
    try {
      const network = await provider.getNetwork();
      if (Number(network.chainId) === 56) return provider;
      lastError = new Error("Configured BSC proof RPC is not on chain ID 56.");
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error("No HTTPS BSC RPC endpoint is configured for sender-address proof.");
}

async function captureLiveSignupFinalizedReferenceBlock() {
  const bscProvider = await getBscAddressProofProvider();
  let xtuProvider = null;
  try {
    const xtuSettings = getXtuSettings();
    if (!xtuSettings.incomingRpcUrl) throw new Error("The XTU incoming RPC is not configured for signup synchronization.");
    xtuProvider = new JsonRpcProvider(xtuSettings.incomingRpcUrl, { name: "bnb-smart-chain", chainId: 56 });
    const [bscNetwork, xtuNetwork] = await Promise.all([bscProvider.getNetwork(), xtuProvider.getNetwork()]);
    if (Number(bscNetwork.chainId) !== 56 || Number(xtuNetwork.chainId) !== 56) {
      throw new Error("Both signup synchronization RPCs must be connected to BNB Smart Chain Mainnet.");
    }
    const [bscLatest, xtuLatest] = await Promise.all([bscProvider.getBlockNumber(), xtuProvider.getBlockNumber()]);
    const bscConfirmations = Math.max(1, Math.min(200, Number(process.env.USDT_MIN_CONFIRMATIONS || 15)));
    const xtuConfirmations = Number(xtuSettings.minConfirmations || 15);
    const bscFinalized = Math.max(0, bscLatest - bscConfirmations + 1);
    const xtuFinalized = Math.max(0, xtuLatest - xtuConfirmations + 1);
    const referenceBlock = Math.min(bscFinalized, xtuFinalized);
    if (!Number.isSafeInteger(referenceBlock) || referenceBlock <= 0) {
      throw new Error("A common finalized BSC reference block could not be captured.");
    }
    const [bscBlock, xtuBlock] = await Promise.all([
      bscProvider.getBlock(referenceBlock), xtuProvider.getBlock(referenceBlock),
    ]);
    if (!bscBlock || !xtuBlock || String(bscBlock.hash).toLowerCase() !== String(xtuBlock.hash).toLowerCase()) {
      throw new Error("The BSC and XTU RPCs disagree on the common finalized reference block hash.");
    }
    return BigInt(referenceBlock);
  } finally {
    try { await bscProvider.destroy(); } catch {}
    try { if (xtuProvider) await xtuProvider.destroy(); } catch {}
  }
}
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
  calculateRemainingAdministrativeBacking,
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
    const protectedFloor = calculateRemainingAdministrativeBacking(
      stock_limit,
      SYSTEM_ADMIN_RESERVE_RATIO,
      common.admin_expens || "0",
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
  const protectedFloor = calculateRemainingAdministrativeBacking(
    stock_limit, SYSTEM_ADMIN_RESERVE_RATIO, common.admin_expens || "0",
  ).remainingInitialAsset;
  const [pendingPayoutRows] = await tx.query(
    `SELECT sold_initial_asset FROM users_usdt_disbursements
     WHERE status IN ('queued','signed','submitted','manual_review') FOR UPDATE`,
  );
  const pendingPayoutInitial = pendingPayoutRows.reduce(
    (sum, row) => sum.plus(row.sold_initial_asset), new BigNumber(0),
  );
  // Shared BSC-USD/XTU allowance: only a type-2 purchase funded by OneX
  // system reserves counts, regardless of amount. XUSER seller credits do not.
  const lastSystemPurchase = await getLastOneXSystemFundedPurchase(tx, username, OneX);
  const cooldown = assessOneXSystemFundingCooldown(lastSystemPurchase, Date.now());
  let sameBatchAlreadyUsedSystemPurchase = false;
  if (options.depositBatchId != null) {
    const [sameBatchSystemRows] = await tx.query(
      `SELECT 1
       FROM users_usdt_deposit_credits c
       INNER JOIN activities a ON a.reference=CONCAT(c.financial_reference,'O')
       WHERE c.batch_id=? AND c.username=? AND a.sender=? AND a.receiver=? AND a.type=2
       LIMIT 1 FOR UPDATE`,
      [String(options.depositBatchId), username, OneX, username],
    );
    sameBatchAlreadyUsedSystemPurchase = sameBatchSystemRows.length > 0;
  }
  // A multi-tranche credit is still one purchase. If this exact deposit batch
  // already consumed the OneX weekly allowance, its own remainder may continue.
  const systemFundingAllowed = cooldown.allowed || sameBatchAlreadyUsedSystemPurchase;
  const bonusRate = globalRun && globalRun.status === "announced" && !globalEffective
    ? new BigNumber(globalRun.bonus_rate_percent || "0")
    : new BigNumber(0);
  const adminQuotaRemaining = calculateRemainingAdministrativeBacking(
    stock_limit, SYSTEM_ADMIN_RESERVE_RATIO, common.admin_expens || "0",
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
    systemFundingAllowed,
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
    if (creditPlan.reason === "system_funding_cooldown") {
      return {
        error: "weekly OneX-funded purchase cooldown active",
        code: "weekly_system_funding_cooldown",
        remaining_seconds: Math.ceil(cooldown.remainingMs / 1000),
        lastPurchaseMs: cooldown.lastPurchaseMs,
        sellerReserveAvailable: activeSellerReserve.toFixed(),
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

  const protectedInitialAssets = calculateRemainingAdministrativeBacking(
    stock_limit, SYSTEM_ADMIN_RESERVE_RATIO, common.admin_expens || "0",
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
  minimum_not_reached: "The cumulative amount received in this asset has not yet reached the minimum of 20.",
  maximum_user_balance: "The account does not currently have enough eligible balance capacity to receive the remaining credit.",
  system_funding_cooldown: "The user has already used the one-per-seven-day purchase funded from OneX system reserves. Eligible seller-campaign reserves may still fund this purchase.",
  manual_deposit_suspended: "Deposit processing is temporarily suspended by OneX administration.",
  payment_service_unavailable: "The deposit processing service is temporarily unavailable. The recorded amount remains protected and will be retried when service resumes.",
  account_deactivated: "The account has been administratively deactivated. Processing remains paused until the account is reactivated.",
  account_unavailable: "The account is unavailable or has not completed its first successful sign-in.",
  system_reserve: "Available distributable reserves are not currently sufficient. OneX will retry when eligible reserves become available.",
  previous_batch_unresolved: "An older deposit is being processed first. This deposit remains in the FIFO queue.",
  received_after_global_disbursement_cutoff: "The transfer arrived after the global-disbursement cutoff and cannot create a new purchase obligation.",
  disbursement_pending: "A disbursement is still pending and must be reconciled before this credit can proceed.",
  scanner_reconciliation_review: "The blockchain scanner is under reconciliation review. This amount is protected while the review is unresolved.",
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
  const asset = String(details.asset || "BSC-USD").toUpperCase();
  const expiry = Number(details.expiresAtMs || 0);
  const remainingMs = expiry > 0 ? Math.max(0, expiry - Date.now()) : null;
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
    `Asset: ${asset}`,
    `Status: ${String(status).toUpperCase()}`,
  ];
  if (details.txHash) {
    lines.push(`Transaction: ${details.txHash}`);
    lines.push(`Your incoming ${asset} transfer has been finalized on BNB Smart Chain and recorded by OneX.`);
  }
  if (details.accountReactivated) {
    lines.push("Your account access has been restored. OneX has immediately re-evaluated this pending deposit; the original 30-day expiry remains unchanged.");
  }
  if (details.receivedAmount != null) lines.push(`Just received: ${details.receivedAmount} ${asset}`);
  if (details.sessionTotal != null) lines.push(`Total received in this deposit: ${details.sessionTotal} ${asset}`);
  if (details.creditedAmount != null) lines.push(`Total already credited: ${details.creditedAmount} ${asset}`);
  if (details.remainingAmount != null) lines.push(`Amount still pending: ${details.remainingAmount} ${asset}`);
  if (reasons.length) lines.push("Reason:", ...getReasonText(reasons));
  if (releaseAtMs != null) lines.push(`OneX system-reserve funding may be reconsidered from (UTC): ${formatTelegramUtc(releaseAtMs)}. Eligible seller-campaign reserves may allow earlier processing.`);

  if (reasons.includes("minimum_not_reached")) {
    const missing = details.minimumRemaining == null ? null : String(details.minimumRemaining);
    lines.push(`Action required: complete the minimum deposit of 20 ${asset}${missing ? `; the remaining amount required is ${missing} ${asset}` : ""}.`);
  }
  if (reasons.includes("maximum_user_balance")) {
    lines.push("Action recommended: sell, transfer or withdraw part of your existing assets to free eligible balance capacity. OneX rechecks this pending amount after every balance update and through its retry worker.");
  }
  if (reasons.includes("system_reserve")) {
    lines.push("No additional payment is required for this reason. OneX will retry when eligible distributable reserves become available.");
  }
  if (reasons.includes("system_funding_cooldown")) {
    lines.push("No additional payment is required. An eligible seller campaign may fund the purchase; otherwise OneX system-reserve funding can be reconsidered when the seven-day cooldown expires.");
  }
  if (reasons.includes("manual_deposit_suspended")) {
    lines.push("Do not send another payment while deposits are suspended. The expiration clock is paused for this formal system suspension and resumes when processing is restored.");
  }
  if (reasons.includes("account_deactivated")) {
    lines.push("Contact OneX support to resolve the account status. The 30-day expiry continues unless OneX has formally suspended deposit processing for a documented system-wide reason.");
  }
  if (reasons.includes("account_unavailable")) {
    lines.push("Contact OneX support to resolve the account status. Do not send another payment until the account is available.");
  }
  if (reasons.includes("disbursement_pending")) {
    lines.push("Wait until the pending disbursement is completed or reconciled. OneX will retry the deposit afterward.");
  }
  if (details.expiresAtMs) {
    lines.push(`Deposit expiry (UTC): ${formatTelegramUtc(expiry)}.`);
    lines.push(`Time remaining: ${Math.ceil((remainingMs || 0) / 86400000)} day(s).`);
    lines.push(`IMPORTANT: if this BSC-USD purchase batch has not reached 20 BSC-USD gross within at most five transfers by the 30-day deadline, only its still-uncredited source amounts are routed to the automatic Category D refund register. A 1% retention is applied per source transfer and estimated gas is deducted once per grouped payout. Net refunds below 1 BSC-USD are retained without a time limit; they are not moved to common reserves.`);
  }
  if (status === "credited") lines.push("The eligible amount has been credited to your initial-asset balance.");
  if (status === "refund_queued") lines.push("The uncredited BSC-USD source amounts have been transferred to the automatic refund register. The same-token refund is sent to the original source address when the grouped net amount reaches at least 1 BSC-USD after the 1% per-transfer retention and one estimated gas deduction.");
  if (status === "forfeited_to_common_reserve") lines.push("This legacy batch was previously reconciled to common reserves. New MAJ6 Category D expirations are not allocated to common reserves.");
  lines.push("The 20-unit minimum and 100-unit maximum apply to each credit tranche. BSC-USD and XTU are separate deposit records and are never combined.");
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

  const result = await withTransaction(async (tx) => {
    const [commonLockRows] = await tx.query(
      "SELECT lock_name FROM system_locks WHERE lock_name='common_state' FOR UPDATE",
    );
    if (!commonLockRows.length) throw new Error("The common-state lock row has not been initialized");
    const senderAddressLower = String(event.fromAddress || "").trim().toLowerCase();
    await ensureWalletFinancialLockTx(tx, senderAddressLower, Date.now());
    const [authRows] = await tx.query(
      `SELECT username,wallet_address,created_at_ms,last_login_at_ms,account_active
       FROM auths WHERE LOWER(wallet_address)=? LIMIT 1 FOR UPDATE`,
      [String(event.fromAddress || "").toLowerCase()],
    );
    if (!authRows.length) {
      if (!event.unknownTransferId) return { unknown: true };
      const [unknownRows] = await tx.query(
        `SELECT * FROM bsc_unknown_incoming_transfers WHERE id=? LIMIT 1 FOR UPDATE`,
        [String(event.unknownTransferId)],
      );
      if (!unknownRows.length) return { unknown: true, reason: "unknown_source_missing" };
      const source = unknownRows[0];
      const registeredAtMs = Number(source.block_timestamp_ms || 0);
      const group = await registerAutomaticRefundEventTx(tx, {
        chainId: 56,
        tokenContract: source.token_contract,
        assetCode: "BSC-USD",
        senderAddress: source.from_address,
        payoutAddress: source.from_address,
        sourceTable: "bsc_unknown_incoming_transfers",
        sourceId: String(source.id),
        sourceKind: "bsc_usd_unknown",
        eventIdentity: String(source.event_identity),
        txHash: String(source.tx_hash),
        logIndex: Number(source.log_index),
        blockNumber: String(source.block_number),
        blockHash: String(source.block_hash),
        grossAmount: String(source.amount),
        finalizedAtMs: Date.now(),
        category: "A",
        reasonCode: "official_unknown_sender",
        nowMs: Date.now(),
      });
      await tx.query(
        `UPDATE bsc_unknown_incoming_transfers
         SET status='automatic_refund_pending',decision_action='automatic_refund',
             decision_reason='Official BSC-USD transfer from an unregistered wallet; automatic refund category A.',
             updated_at_ms=? WHERE id=? AND status IN ('pending_admin','refund_failed','automatic_refund_pending')`,
        [String(Date.now()), String(source.id)],
      );
      return { automaticRefund: true, category: "A", groupId: group.groupId, duplicate: Boolean(group.duplicate) };
    }

    const account = authRows[0];
    const username = account.username;
    const eventTimestampMs = Number(event.blockTimestampMs);
    const finalizedAtMs = Date.now();
    const [registryRows] = await tx.query(
      `SELECT registered_at_block FROM bsc_wallet_address_registry
       WHERE wallet_address_lower=? LIMIT 1 FOR UPDATE`, [String(event.fromAddress).toLowerCase()],
    );
    const registrationBoundary = registryRows.length ? BigInt(String(registryRows[0].registered_at_block || "0")) : null;
    const eventBlock = BigInt(String(event.blockNumber));
    const [globalRows] = await tx.query(
      `SELECT id,status,effective_at_ms,request_deadline_at_ms,extension_deadline_at_ms
       FROM global_disbursement_runs
       WHERE status IN ('announced','active','closed','manual_review','completed','resolved')
       ORDER BY id DESC LIMIT 1 FOR UPDATE`,
    );
    const refundGlobalRun = globalRows[0] || null;
    const globalStart = Number(refundGlobalRun?.effective_at_ms || 0);
    const globalEnd = Number(refundGlobalRun?.extension_deadline_at_ms || refundGlobalRun?.request_deadline_at_ms || 0);
    const inGlobalRefundPeriod = Boolean(refundGlobalRun && globalStart > 0 && globalEnd >= globalStart &&
      eventTimestampMs >= globalStart && eventTimestampMs <= globalEnd);
    const accountInactiveForRefund = Number(account.account_active) !== 1;
    const preRegistrationBoundary = registrationBoundary != null && registrationBoundary > 0n && eventBlock <= registrationBoundary;
    if (inGlobalRefundPeriod || accountInactiveForRefund || preRegistrationBoundary) {
      const eventIdentityForRefund = createBscEventIdentity(event.txHash, event.logIndex, event.blockHash);
      const [sourceInsert] = await tx.query(
        `INSERT IGNORE INTO users_usdt_transfer_events
         (username,batch_id,treasury_address,from_address,amount,amount_raw,tx_hash,log_index,
          block_number,block_hash,block_timestamp_ms,status,reason_codes,event_identity,created_at_ms)
         VALUES(?,NULL,?,?,?,?,?,?,?,?,?,'automatic_refund_pending',?,?,?)`,
        [String(account.username), event.treasuryAddress, event.fromAddress, amountValue.toFixed(18), event.amountRaw,
          event.txHash, event.logIndex, event.blockNumber, event.blockHash, String(eventTimestampMs),
          safeJson([inGlobalRefundPeriod ? "global_disbursement_refund" : accountInactiveForRefund ? "account_deactivated_refund" : "pre_registration_refund"]),
          eventIdentityForRefund, String(finalizedAtMs)],
      );
      if (Number(sourceInsert.affectedRows || 0) !== 1) return { duplicate: true };
      const category = inGlobalRefundPeriod ? "B" : (preRegistrationBoundary ? "A" : (accountInactiveForRefund ? "C" : "A"));
      const [sourceRows] = await tx.query(
        `SELECT id FROM users_usdt_transfer_events WHERE event_identity=? LIMIT 1 FOR UPDATE`, [eventIdentityForRefund],
      );
      if (!sourceRows.length) throw new Error("Unable to retrieve the persisted BSC-USD refund source event.");
      const registered = await registerAutomaticRefundEventTx(tx, {
        chainId: 56,
        tokenContract: process.env.USDT_BEP20_CONTRACT || "0x55d398326f99059fF775485246999027B3197955",
        assetCode: "BSC-USD",
        senderAddress: event.fromAddress,
        payoutAddress: event.fromAddress,
        sourceTable: "users_usdt_transfer_events",
        sourceId: String(sourceRows[0].id),
        sourceKind: "bsc_usd_registered",
        eventIdentity: eventIdentityForRefund,
        txHash: event.txHash,
        logIndex: Number(event.logIndex),
        blockNumber: String(event.blockNumber),
        blockHash: event.blockHash,
        grossAmount: amountValue.toFixed(18),
        finalizedAtMs,
        category,
        username: account.username,
        reasonCode: category === "B" ? "global_disbursement_period" : category === "C" ? "account_deactivated" : "pre_registration_boundary",
        nowMs: finalizedAtMs,
      });
      return { automaticRefund: true, category, username, groupId: registered.groupId, duplicate: Boolean(registered.duplicate) };
    }
    if (!event.unknownTransferId) {
      const createdAtMs = Number(account.created_at_ms);
      if (!Number.isSafeInteger(createdAtMs) || createdAtMs <= 0 ||
          !Number.isSafeInteger(eventTimestampMs) || eventTimestampMs <= 0 ||
          eventTimestampMs < Math.ceil(createdAtMs / 1000) * 1000) {
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
    const now = Date.now();
    const [eventInsert] = await tx.query(
      `INSERT IGNORE INTO users_usdt_transfer_events
       (username,batch_id,treasury_address,from_address,amount,amount_raw,tx_hash,log_index,
        block_number,block_hash,block_timestamp_ms,status,reason_codes,event_identity,created_at_ms)
       VALUES(?,NULL,?,?,?,?,?,?,?,?,?,'detected',NULL,?,?)`,
      [username, event.treasuryAddress, event.fromAddress, amountValue.toFixed(18), event.amountRaw,
        event.txHash, event.logIndex, event.blockNumber, event.blockHash, String(eventTimestampMs), eventIdentity, String(now)],
    );
    if (eventInsert.affectedRows !== 1) return { duplicate: true };

    const [stockRows] = await tx.query(
      "SELECT balance FROM users_stock WHERE username=? LIMIT 1 FOR UPDATE", [username],
    );
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
    const transferAfterCutoff = Boolean(cutoffStarted && effectiveAt > 0 && eventTimestampMs >= effectiveAt);
    const accountDeactivated = Number(account.account_active) !== 1;
    const accountUnavailable = account.last_login_at_ms == null || !stockRows.length;

    let batch = null;
    if (!transferAfterCutoff && !manualDepositSuspended && !accountDeactivated && !accountUnavailable) {
      const [activeBatchRows] = await tx.query(
        `SELECT * FROM users_usdt_deposit_batches
         WHERE username=? AND status='collecting' AND CAST(expires_at_ms AS UNSIGNED)>?
         ORDER BY opened_at_ms ASC,id ASC LIMIT 1 FOR UPDATE`,
        [username, String(eventTimestampMs)],
      );
      batch = activeBatchRows[0] || null;
      if (batch && (new BigNumber(batch.total_amount || "0").gte(MIN_DEPOSIT_AMOUNT) || Number(batch.transfer_count || 0) >= 5)) batch = null;
    }

    let initialReasons = [];
    let blockedStatus = null;
    if (transferAfterCutoff) {
      blockedStatus = "pending_global";
      initialReasons = ["received_after_global_disbursement_cutoff"];
    } else if (manualDepositSuspended) {
      blockedStatus = "pending_support";
      initialReasons = ["manual_deposit_suspended"];
    } else if (accountDeactivated) {
      blockedStatus = "pending_support";
      initialReasons = ["account_deactivated"];
    } else if (accountUnavailable) {
      blockedStatus = "pending_support";
      initialReasons = ["account_unavailable"];
    }

    if (!batch) {
      const openedAt = eventTimestampMs;
      const expiresAt = openedAt + DEPOSIT_PENDING_EXPIRATION_MS;
      const firstStatus = blockedStatus || (amountValue.gte(MIN_DEPOSIT_AMOUNT) ? "ready" : "collecting");
      const firstReasons = blockedStatus ? initialReasons : (amountValue.lt(MIN_DEPOSIT_AMOUNT) ? ["minimum_not_reached"] : []);
      const [insert] = await tx.query(
        `INSERT INTO users_usdt_deposit_batches
         (username,treasury_address,opened_at_ms,expires_at_ms,initial_group_deadline_ms,total_amount,total_amount_raw,
          credited_amount,remaining_amount,refunded_amount,tfees_rate_percent,transfer_count,
          credit_sequence,minimum_met_at_ms,status,pending_since_ms,reason_codes,created_at_ms,updated_at_ms)
         VALUES(?,?,?,?,?,0,0,0,0,0,?,0,0,NULL,?,?,?,?,?)`,
        [username, event.treasuryAddress, String(openedAt), String(expiresAt), String(expiresAt), String(tfees),
          firstStatus, String(now), firstReasons.length ? safeJson(firstReasons) : null, String(now), String(now)],
      );
      const [rows] = await tx.query("SELECT * FROM users_usdt_deposit_batches WHERE id=? LIMIT 1 FOR UPDATE", [insert.insertId]);
      batch = rows[0];
      initialReasons = firstReasons;
    }

    const currentTotal = new BigNumber(batch.total_amount || "0");
    const nextTotal = currentTotal.plus(amountValue);
    const expiry = Number(batch.expires_at_ms);
    const status = blockedStatus || (nextTotal.gte(MIN_DEPOSIT_AMOUNT) ? "ready" : "collecting");
    const reasons = blockedStatus ? initialReasons : (nextTotal.lt(MIN_DEPOSIT_AMOUNT) ? ["minimum_not_reached"] : []);
    const minAt = nextTotal.gte(MIN_DEPOSIT_AMOUNT) ? String(batch.minimum_met_at_ms || now) : null;
    await tx.query(
      `UPDATE users_usdt_deposit_batches
       SET total_amount=total_amount+?,total_amount_raw=total_amount_raw+?,
           remaining_amount=remaining_amount+?,transfer_count=transfer_count+1,
           minimum_met_at_ms=COALESCE(minimum_met_at_ms,?),status=?,pending_since_ms=COALESCE(pending_since_ms,?),
           reason_codes=?,next_attempt_at_ms=NULL,updated_at_ms=? WHERE id=?`,
      [amountValue.toFixed(18), event.amountRaw, amountValue.toFixed(18), minAt,
        status, String(now), reasons.length ? safeJson(reasons) : null, String(now), batch.id],
    );
    await tx.query(
      `UPDATE users_usdt_transfer_events SET batch_id=?,status=?,reason_codes=? WHERE event_identity=?`,
      [batch.id, status, reasons.length ? safeJson(reasons) : null, eventIdentity],
    );

    await queueDepositBatchStatusTx(tx, username, batch.id, status, reasons, null, {
      asset: "BSC-USD", txHash: event.txHash,
      receivedAmount: amountValue.toFixed(8), sessionTotal: nextTotal.toFixed(8),
      creditedAmount: new BigNumber(batch.credited_amount || "0").toFixed(8),
      remainingAmount: new BigNumber(batch.remaining_amount || "0").plus(amountValue).toFixed(8),
      expiresAtMs: expiry,
      minimumRemaining: BigNumber.maximum(0, MIN_DEPOSIT_AMOUNT.minus(nextTotal)).toFixed(8),
    });

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
    return { accepted: true, username, batchId: String(batch.id), status, expiresAtMs: expiry, ready: status === "ready" };
  });

  if (result?.ready && result.batchId) {
    setImmediate(() => processOneDepositBatch(result.batchId)
      .catch((error) => console.error("Immediate BSC-USD deposit credit failed:", error.message)));
  }
  return result;
}

async function updateBatchEventStatus(tx, batchId, status, reasonCodes = null) {
  await tx.query(
    `UPDATE users_usdt_transfer_events
     SET status=?,reason_codes=?
     WHERE batch_id=? AND status NOT IN ('refund_queued','refunded','refund_confirmed','ignored')`,
    [status, reasonCodes ? safeJson(reasonCodes) : null, batchId],
  );
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
    const expiresAt = Number(batch.expires_at_ms || 0);
    if (expiresAt > 0 && now >= expiresAt &&
        new BigNumber(batch.total_amount || "0").lt(MIN_DEPOSIT_AMOUNT)) {
      return { waiting: true, reason: "expiry_due", expiresAtMs: expiresAt };
    }

    if (batch.status === "collecting") {
      const collectingTotal = new BigNumber(batch.total_amount || "0");
      if (collectingTotal.lt(MIN_DEPOSIT_AMOUNT)) return { waiting: true, reason: "minimum_not_reached" };
      await tx.query(
        "UPDATE users_usdt_deposit_batches SET status='ready',updated_at_ms=? WHERE id=? AND status='collecting'",
        [String(now), batchId],
      );
      batch.status = "ready";
    }

    const retryableStatuses = [
      "ready", "pending_credit", "pending_weekly", "pending_reserve", "pending_support",
    ];
    if (!retryableStatuses.includes(batch.status)) return { skipped: true };
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

    const initialCreditRemaining = BigNumber.minimum(remainingAmount, MAX_INITIAL_CREDIT_TRANCHE_AMOUNT);
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
      } else if (creditResult?.code === "weekly_system_funding_cooldown") {
        status = "pending_weekly";
        reasons = ["system_funding_cooldown"];
        const pendingSince = Number(batch.pending_since_ms || now);
        releaseAt = getSystemFundingCooldownReleaseAt(pendingSince, creditResult.lastPurchaseMs);
        // Recheck seller campaign reserves frequently; the OneX cooldown only
        // gates system-funded purchases and must not block seller-funded credit.
        retryAt = now + 30_000;
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
      if (totalAmount.gt(MAX_INITIAL_CREDIT_TRANCHE_AMOUNT) && !reasons.includes("maximum_user_balance")) {
        reasons.unshift("maximum_user_balance");
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
      if (creditResult.partialReason === "maximum_user_balance") {
        nextReasons.push("maximum_user_balance");
      } else if (creditResult.partialReason === "system_reserve") {
        nextReasons.push("system_reserve");
      } else if (creditResult.partialReason === "system_funding_cooldown") {
        nextReasons.push("system_funding_cooldown");
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

async function getUncreditedBscBatchEventSlicesTx(tx, batch) {
  const [eventRows] = await tx.query(
    `SELECT id,event_identity,tx_hash,log_index,amount,status,from_address,block_number,block_hash,block_timestamp_ms,created_at_ms
     FROM users_usdt_transfer_events WHERE batch_id=? ORDER BY block_number ASC,log_index ASC,id ASC FOR UPDATE`,
    [String(batch.id)],
  );
  const [creditRows] = await tx.query(
    `SELECT gross_amount FROM users_usdt_deposit_credits WHERE batch_id=? ORDER BY credit_sequence ASC,id ASC FOR UPDATE`,
    [String(batch.id)],
  );
  let creditRemaining = creditRows.reduce((sum, row) => sum.plus(row.gross_amount || "0"), new BigNumber(0));
  if (!creditRemaining.isFinite() || creditRemaining.isNegative()) throw new Error("The BSC-USD batch credit ledger is invalid.");
  const slices = [];
  let totalUncredited = new BigNumber(0);
  for (const event of eventRows) {
    const sourceAmount = new BigNumber(event.amount || "0");
    if (!sourceAmount.isFinite() || !sourceAmount.isGreaterThan(0)) throw new Error("A BSC-USD source event has an invalid amount.");
    const creditedFromEvent = BigNumber.minimum(sourceAmount, creditRemaining);
    creditRemaining = BigNumber.maximum(0, creditRemaining.minus(creditedFromEvent));
    const uncredited = sourceAmount.minus(creditedFromEvent);
    if (uncredited.isGreaterThan(0)) {
      slices.push({ ...event, uncreditedAmount: uncredited });
      totalUncredited = totalUncredited.plus(uncredited);
    }
  }
  const expectedRemaining = new BigNumber(batch.remaining_amount || "0");
  if (!expectedRemaining.isFinite() || expectedRemaining.isNegative() ||
      creditRemaining.isGreaterThan(0) || !totalUncredited.eq(expectedRemaining)) {
    throw new Error("The BSC-USD source-event FIFO allocation does not reconcile with the batch remaining amount.");
  }
  return { eventRows, slices, totalUncredited };
}

async function transferBscBatchRemainderToAutomaticRefundTx(tx, batch, category, nowMs, reasonCode) {
  const senderAddress = String(batch.sender_address || batch.from_address || "").toLowerCase();
  const [authRows] = await tx.query(
    `SELECT username,wallet_address,account_active FROM auths WHERE username=? LIMIT 1 FOR UPDATE`, [String(batch.username)],
  );
  if (!authRows.length || String(authRows[0].wallet_address || "").toLowerCase() !== senderAddress) {
    throw new Error("The BSC-USD refund source wallet does not match the account wallet.");
  }
  const { slices, totalUncredited } = await getUncreditedBscBatchEventSlicesTx(tx, batch);
  if (totalUncredited.isZero()) return { queued: false, amount: "0" };
  const [scannerIdentityRows] = await tx.query(
    `SELECT token_contract FROM bsc_incoming_scan_state WHERE singleton_id=1 LIMIT 1 FOR UPDATE`,
  );
  const sourceContract = String(scannerIdentityRows[0]?.token_contract || process.env.USDT_BEP20_CONTRACT ||
    "0x55d398326f99059fF775485246999027B3197955").toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(sourceContract)) throw new Error("The official BSC-USD scanner token contract is unavailable.");
  const now = Number(nowMs);
  await ensureWalletFinancialLockTx(tx, senderAddress, now);
  let registeredCount = 0;
  for (const event of slices) {
    if (!/^[0-9a-f]{64}$/i.test(String(event.event_identity)) ||
        !/^0x[0-9a-f]{64}$/i.test(String(event.tx_hash)) ||
        !/^0x[0-9a-f]{64}$/i.test(String(event.block_hash))) {
      throw new Error("A BSC-USD refund source event is missing its immutable chain identity.");
    }
    const registered = await registerAutomaticRefundEventTx(tx, {
      chainId: 56,
      tokenContract: sourceContract,
      assetCode: "BSC-USD",
      senderAddress,
      payoutAddress: senderAddress,
      sourceTable: "users_usdt_transfer_events",
      sourceId: String(event.id),
      sourceKind: "bsc_usd_batch",
      eventIdentity: String(event.event_identity),
      txHash: String(event.tx_hash),
      logIndex: Number(event.log_index),
      blockNumber: String(event.block_number),
      blockHash: String(event.block_hash),
      grossAmount: event.uncreditedAmount.toFixed(18),
      finalizedAtMs: Number(event.created_at_ms) > 0 ? Number(event.created_at_ms) : now,
      category,
      username: batch.username,
      reasonCode,
      nowMs: now,
    });
    if (!registered.duplicate) registeredCount += 1;
    await tx.query(
      `UPDATE users_usdt_transfer_events SET status='automatic_refund_pending',reason_codes=? WHERE id=?
       AND status NOT IN ('credited','refund_confirmed','refunded','ignored')`,
      [safeJson([reasonCode]), String(event.id)],
    );
  }
  await tx.query(
    `UPDATE users_usdt_deposit_batches SET reserved_refund_amount=reserved_refund_amount+?,
     remaining_amount=0,status='refund_queued',reason_codes=?,next_attempt_at_ms=NULL,
     expiration_paused_at_ms=NULL,expiration_pause_reason=NULL,forfeited_at_ms=?,updated_at_ms=?
     WHERE id=? AND remaining_amount=? AND status NOT IN ('refund_queued','refunded')`,
    [totalUncredited.toFixed(18), safeJson([reasonCode]), String(now), String(now), String(batch.id), totalUncredited.toFixed(18)],
  );
  return { queued: true, amount: totalUncredited.toFixed(18), events: registeredCount, category };
}


async function getBscExpiryScannerCatchupBoundary(expiresAtMs) {
  const [scannerRows] = await db.queryAsync(
    `SELECT scan_start_block,last_scanned_block,last_finalized_block,health_status
     FROM bsc_incoming_scan_state WHERE singleton_id=1 LIMIT 1`,
  );
  if (!scannerRows.length) return { ready: false, reason: "bsc_scanner_state_missing" };
  const state = scannerRows[0];
  if (String(state.health_status || "") === "manual_review") {
    return { ready: true, boundaryBlock: "0", scannerManualReview: true };
  }
  if (String(state.health_status || "") !== "healthy") {
    return { ready: false, reason: `bsc_scanner_${String(state.health_status || "unavailable")}` };
  }
  const scanStart = Number(state.scan_start_block || 0);
  if (!Number.isSafeInteger(scanStart) || scanStart < 0 || state.last_scanned_block == null || state.last_finalized_block == null) {
    return { ready: false, reason: "bsc_scanner_cursor_unavailable" };
  }
  const provider = await getBscAddressProofProvider();
  try {
    const latest = await provider.getBlockNumber();
    const confirmations = Math.max(1, Math.min(200, Number(process.env.USDT_MIN_CONFIRMATIONS || 15)));
    const finalizedNumber = Math.max(0, latest - confirmations + 1);
    if (finalizedNumber < scanStart) return { ready: false, reason: "finalized_boundary_before_scan_start" };
    const finalizedBlock = await provider.getBlock(finalizedNumber);
    const deadlineSeconds = Math.floor(Number(expiresAtMs) / 1000);
    if (!finalizedBlock || Number(finalizedBlock.timestamp) < deadlineSeconds) {
      return { ready: false, reason: "expiry_boundary_not_finalized" };
    }

    let low = scanStart;
    let high = finalizedNumber;
    let boundary = scanStart - 1;
    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      const block = await provider.getBlock(mid);
      if (!block) throw new Error(`BSC block ${mid} is unavailable while locating the BSC-USD deposit expiry boundary.`);
      if (Number(block.timestamp) <= deadlineSeconds) {
        boundary = mid;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }
    if (boundary < scanStart) return { ready: true, boundaryBlock: String(boundary), noSourceBlockBeforeDeadline: true };
    const scanned = BigInt(String(state.last_scanned_block));
    const scannedFinalized = BigInt(String(state.last_finalized_block));
    const required = BigInt(String(boundary));
    if (scanned < required || scannedFinalized < required) {
      return { ready: false, reason: "bsc_scanner_catching_up", boundaryBlock: String(boundary), lastScannedBlock: String(scanned), lastFinalizedBlock: String(scannedFinalized) };
    }
    return { ready: true, boundaryBlock: String(boundary) };
  } finally {
    try { await provider.destroy(); } catch {}
  }
}

async function expireOneUsdtDepositBatch(batchId, now = Date.now()) {
  const [expiryRows] = await db.queryAsync("SELECT expires_at_ms,status FROM users_usdt_deposit_batches WHERE id=? LIMIT 1", [String(batchId)]);
  if (!expiryRows.length) return { skipped: true };
  if (["refund_queued", "refunded", "credited", "rejected", "forfeited_to_common_reserve"].includes(String(expiryRows[0].status))) {
    return { skipped: true, status: String(expiryRows[0].status) };
  }
  if (Number(expiryRows[0].expires_at_ms || 0) > now) return { waiting: true };
  const catchup = await getBscExpiryScannerCatchupBoundary(Number(expiryRows[0].expires_at_ms));
  if (!catchup.ready) return { waitingForScannerCatchup: true, reason: catchup.reason, boundaryBlock: catchup.boundaryBlock || null };
  return withTransaction(async (tx) => {
    const [lockRows] = await tx.query("SELECT lock_name FROM system_locks WHERE lock_name='common_state' FOR UPDATE");
    if (!lockRows.length) throw new Error("The common-state lock row has not been initialized");
    const [batchRows] = await tx.query("SELECT * FROM users_usdt_deposit_batches WHERE id=? LIMIT 1 FOR UPDATE", [String(batchId)]);
    if (!batchRows.length) return { skipped: true };
    const batch = batchRows[0];
    if (["credited", "forfeited_to_common_reserve", "refunded", "refund_queued", "rejected"].includes(String(batch.status))) {
      return { skipped: true, status: batch.status };
    }
    const expiresAt = Number(batch.expires_at_ms || 0);
    if (!Number.isSafeInteger(expiresAt) || expiresAt <= 0 || now < expiresAt) return { waiting: true };

    const [controlRows] = await tx.query("SELECT is_suspended FROM deposit_service_control WHERE control_id=1 LIMIT 1 FOR UPDATE");
    const [scannerRows] = await tx.query(
      "SELECT health_status,last_scanned_block,last_finalized_block FROM bsc_incoming_scan_state WHERE singleton_id=1 LIMIT 1 FOR UPDATE",
    );
    const scannerUnavailable = !scannerRows.length || String(scannerRows[0]?.health_status || "") !== "healthy" ||
      scannerRows[0]?.last_scanned_block == null || scannerRows[0]?.last_finalized_block == null ||
      BigInt(String(scannerRows[0]?.last_scanned_block || "0")) < BigInt(String(catchup.boundaryBlock)) ||
      BigInt(String(scannerRows[0]?.last_finalized_block || "0")) < BigInt(String(catchup.boundaryBlock));
    const systemHold = Number(controlRows[0]?.is_suspended || 0) === 1 || scannerUnavailable;
    if (systemHold) {
      if (batch.expiration_paused_at_ms == null) {
        await tx.query(
          `UPDATE users_usdt_deposit_batches SET expiration_paused_at_ms=?,expiration_pause_reason=?,updated_at_ms=? WHERE id=?`,
          [String(now), Number(controlRows[0]?.is_suspended || 0) === 1 ? "administrative_deposit_suspension" : "scanner_reconciliation_review", String(now), String(batchId)],
        );
      }
      return { paused: true };
    }
    if (batch.expiration_paused_at_ms != null) {
      const pausedAt = Number(batch.expiration_paused_at_ms);
      if (!Number.isSafeInteger(pausedAt) || pausedAt > now) throw new Error("Invalid BSC deposit expiry pause timestamp");
      const extendedExpiry = expiresAt + (now - pausedAt);
      await tx.query(
        `UPDATE users_usdt_deposit_batches SET expires_at_ms=?,initial_group_deadline_ms=?,
         expiration_paused_at_ms=NULL,expiration_pause_reason=NULL,updated_at_ms=? WHERE id=?`,
        [String(extendedExpiry), String(extendedExpiry), String(now), String(batchId)],
      );
      return { resumed: true, expiresAtMs: extendedExpiry };
    }

    const [eventRows] = await tx.query(
      `SELECT id,event_identity,tx_hash,log_index,amount,status,from_address,block_number,block_hash,block_timestamp_ms
       FROM users_usdt_transfer_events WHERE batch_id=? ORDER BY block_number ASC,log_index ASC FOR UPDATE`, [String(batchId)],
    );
    if (eventRows.length !== Number(batch.transfer_count || 0) || eventRows.some((row) => ["detected", "pending_reconciliation", "orphaned"].includes(String(row.status)))) {
      await tx.query(
        `UPDATE users_usdt_deposit_batches SET status='pending_support',reason_codes=?,expiration_paused_at_ms=?,
         expiration_pause_reason='deposit_event_reconciliation',updated_at_ms=? WHERE id=?`,
        [safeJson(["scanner_reconciliation_review"]), String(now), String(now), String(batchId)],
      );
      await queueTelegramMessageTx(tx, batch.username, `deposit:expiry-reconciliation:${batchId}`,
        "OneX deposit protected pending reconciliation",
        `Your ${"BSC-USD"} deposit batch ${batchId} reached its expiry date, but its blockchain event records do not reconcile. No amount has been reclassified or credited. The expiry is paused while OneX completes the technical review.`);
      return { held: true, reason: "event_reconciliation_mismatch" };
    }

    const totalGross = new BigNumber(batch.total_amount || "0");
    if (!totalGross.isFinite() || totalGross.isNegative()) throw new Error("Invalid BSC-USD deposit gross amount at expiry");
    const uncreditedAtExpiry = new BigNumber(batch.remaining_amount || "0");
    if (!uncreditedAtExpiry.isFinite() || uncreditedAtExpiry.isNegative()) throw new Error("Invalid BSC-USD deposit remainder at expiry");
    if (uncreditedAtExpiry.isZero()) {
      await tx.query(
        `UPDATE users_usdt_deposit_batches SET status='credited',forfeited_at_ms=?,updated_at_ms=? WHERE id=?`,
        [String(now), String(now), String(batchId)],
      );
      return { completed: true, amount: "0" };
    }
    if (Number(batch.transfer_count || 0) > 5) {
      await tx.query(
        `UPDATE users_usdt_deposit_batches SET status='manual_review',reason_codes=?,expiration_paused_at_ms=?,
         expiration_pause_reason='deposit_event_cap_exceeded',updated_at_ms=? WHERE id=?`,
        [safeJson(["deposit_event_cap_exceeded_at_expiry"]), String(now), String(now), String(batchId)],
      );
      return { held: true, reason: "deposit_event_cap_exceeded" };
    }
    if (totalGross.gte(MIN_DEPOSIT_AMOUNT)) {
      // A qualified batch remains a normal purchase even when funding/credit is delayed.
      return { skipped: true, reason: "qualified_purchase_remains_normal" };
    }
    const [accountRows] = await tx.query(
      `SELECT wallet_address,account_active,account_deactivated_at_ms FROM auths WHERE username=? LIMIT 1 FOR UPDATE`, [String(batch.username)],
    );
    if (!accountRows.length) {
      await tx.query(
        `UPDATE users_usdt_deposit_batches SET status='manual_review',reason_codes=?,updated_at_ms=? WHERE id=?`,
        [safeJson(["deposit_account_missing_at_expiry"]), String(now), String(batchId)],
      );
      return { held: true, reason: "account_missing" };
    }
    const senderAddress = String(accountRows[0].wallet_address || "").toLowerCase();
    await ensureWalletFinancialLockTx(tx, senderAddress, now);
    const [globalRows] = await tx.query(
      `SELECT status,effective_at_ms,request_deadline_at_ms,extension_deadline_at_ms
       FROM global_disbursement_runs
       WHERE status IN ('announced','active','closed','manual_review','completed','resolved')
       ORDER BY id DESC LIMIT 1 FOR UPDATE`,
    );
    const globalRun = globalRows[0] || null;
    const globalStart = Number(globalRun?.effective_at_ms || 0);
    const globalEnd = Number(globalRun?.extension_deadline_at_ms || globalRun?.request_deadline_at_ms || 0);
    const deactivatedAt = accountRows[0].account_deactivated_at_ms == null
      ? null : Number(accountRows[0].account_deactivated_at_ms);
    // A deactivation strictly after the immutable batch deadline cannot turn
    // an already-expired active-account batch from D into C merely because
    // the expiry worker is catching up later.
    const wasActiveAtExpiry = Number(accountRows[0].account_active) === 1 ||
      (Number.isSafeInteger(deactivatedAt) && deactivatedAt > expiresAt);
    const category = wasActiveAtExpiry ? "D" : "C";
    const reasonCode = category === "B" ? "global_disbursement_period" :
      category === "C" ? "account_deactivated" : "deposit_expired_without_minimum";
    const remaining = new BigNumber(batch.remaining_amount || "0");
    if (!remaining.isFinite() || remaining.isNegative()) throw new Error("Invalid BSC-USD deposit remainder at expiry");
    const transferred = await transferBscBatchRemainderToAutomaticRefundTx(tx, {
      ...batch, sender_address: senderAddress,
    }, category, now, reasonCode);
    if (transferred.queued) {
      await queueDepositBatchStatusTx(tx, batch.username, batchId, "refund_queued", [reasonCode], null, {
        asset: "BSC-USD", sessionTotal: String(batch.total_amount),
        creditedAmount: String(batch.credited_amount || "0"),
        remainingAmount: transferred.amount, refundCategory: category,
      });
    }
    return { automaticRefund: true, category, amount: transferred.amount, events: transferred.events };
    
  });
}

async function expireDueUsdtDepositBatches(now = Date.now()) {
  const rows = await db.queryAsync(
    `SELECT id FROM users_usdt_deposit_batches
     WHERE remaining_amount>0 AND CAST(expires_at_ms AS UNSIGNED)<=?
       AND status NOT IN ('credited','forfeited_to_common_reserve','refunded','refund_queued','rejected')
     ORDER BY CAST(expires_at_ms AS UNSIGNED) ASC,id ASC LIMIT 100`, [String(now)],
  );
  for (const row of rows) {
    try { await expireOneUsdtDepositBatch(row.id, now); }
    catch (error) { console.error(`BSC-USD deposit expiry failed for batch ${row.id}:`, error.message); }
  }
}

async function notifyDueUsdtDepositExpirations(now = Date.now()) {
  const warningWindow = 24 * 60 * 60 * 1000;
  const rows = await db.queryAsync(
    `SELECT id,username,total_amount,credited_amount,remaining_amount,expires_at_ms FROM users_usdt_deposit_batches
     WHERE remaining_amount>0 AND expiration_warning_sent_at_ms IS NULL
       AND CAST(expires_at_ms AS UNSIGNED)>? AND CAST(expires_at_ms AS UNSIGNED)<=?
       AND status NOT IN ('forfeited_to_common_reserve','credited')
     ORDER BY expires_at_ms ASC,id ASC LIMIT 100`, [String(now), String(now + warningWindow)],
  );
  for (const row of rows) {
    await withTransaction(async (tx) => {
      const [locked] = await tx.query("SELECT * FROM users_usdt_deposit_batches WHERE id=? LIMIT 1 FOR UPDATE", [String(row.id)]);
      if (!locked.length || locked[0].expiration_warning_sent_at_ms != null) return;
      const batch = locked[0];
      const remaining = new BigNumber(batch.remaining_amount || "0");
      await queueTelegramMessageTx(tx, batch.username, `deposit:expiry-warning:${batch.id}`,
        "OneX deposit expiry warning",
        `Your BSC-USD deposit batch ${batch.id} has ${remaining.toFixed(8)} BSC-USD still pending and expires at ${formatTelegramUtc(batch.expires_at_ms)}. If the batch has not reached 20 BSC-USD gross within at most five finalized transfers by that deadline, only its still-uncredited source amounts will enter the automatic Category D refund process. A 1% retention applies to each source transfer; estimated gas is deducted once per grouped payout. A net refund below 1 BSC-USD remains held without a time limit and is not allocated to common reserves.`);
      await tx.query("UPDATE users_usdt_deposit_batches SET expiration_warning_sent_at_ms=?,updated_at_ms=? WHERE id=? AND expiration_warning_sent_at_ms IS NULL", [String(now), String(now), String(row.id)]);
    });
  }
}

async function reconcileDeactivatedBscDepositBatches() {
  const rows = await db.queryAsync(
    `SELECT DISTINCT b.username
     FROM users_usdt_deposit_batches b
     INNER JOIN auths a ON a.username=b.username
     WHERE a.account_active=0 AND b.remaining_amount>0
       AND b.status IN ('collecting','batched','ready','finalizing','pending_minimum',
                        'pending_credit','pending_weekly','pending_reserve','pending_support','pending_global')
     ORDER BY b.username ASC LIMIT 100`,
  );
  for (const row of rows) {
    try {
      await holdOutstandingDepositBatchesForDeactivatedAccount(row.username);
    } catch (error) {
      console.error(`Deactivated BSC-USD account ${row.username} still requires refund routing:`, error.message);
    }
  }
}

async function processDepositBatchQueue() {
  const now = Date.now();
  await reconcileDeactivatedBscDepositBatches();
  await expireDueUsdtDepositBatches(now);
  await notifyDueUsdtDepositExpirations(now);
  const rows = await db.queryAsync(
    `SELECT id FROM users_usdt_deposit_batches
     WHERE (status='collecting' AND CAST(total_amount AS DECIMAL(36,18))>=?)
        OR status='ready'
        OR (status IN ('pending_credit','pending_support','pending_reserve')
            AND (next_attempt_at_ms IS NULL OR CAST(next_attempt_at_ms AS UNSIGNED)<=?)
            AND CASE
              WHEN status='pending_support' AND JSON_VALID(reason_codes)=1
                THEN JSON_CONTAINS(reason_codes, JSON_QUOTE('account_deactivated'))=0
                 AND JSON_CONTAINS(reason_codes, JSON_QUOTE('manual_deposit_suspended'))=0
              ELSE 1
            END)
        OR (status='pending_weekly' AND (CAST(next_attempt_at_ms AS UNSIGNED)<=? OR CAST(release_at_ms AS UNSIGNED)<=?))
     ORDER BY opened_at_ms ASC,id ASC LIMIT 50`,
    [String(MIN_DEPOSIT_AMOUNT), String(now), String(now), String(now)],
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
        await ensureWalletFinancialLockTx(connection, walletLower, Date.now());

        // Signup is fail-closed until both finalized scanners have covered a
        // common reference block. This prevents a finalized but not-yet-indexed
        // transfer from being silently treated as a new-account deposit.
        const [bscScanRows] = await connection.query(
          `SELECT last_scanned_block,last_finalized_block,health_status
           FROM bsc_incoming_scan_state WHERE singleton_id=1 LIMIT 1 FOR UPDATE`,
        );
        const [xtuScanRows] = await connection.query(
          `SELECT last_scanned_block,last_finalized_block,health_status
           FROM xtu_deposit_scan_state WHERE singleton_id=1 LIMIT 1 FOR UPDATE`,
        );
        if (!bscScanRows.length || !xtuScanRows.length ||
            String(bscScanRows[0].health_status) !== "healthy" || String(xtuScanRows[0].health_status) !== "healthy") {
          const scanUnavailable = new Error("Wallet refund synchronization is unavailable.");
          scanUnavailable.code = "ONEX_REFUND_CHECK_UNAVAILABLE";
          throw scanUnavailable;
        }
        let registeredAtBlock;
        try {
          registeredAtBlock = await captureLiveSignupFinalizedReferenceBlock();
        } catch (referenceError) {
          const scanUnavailable = new Error(`A live finalized signup reference block is unavailable: ${referenceError.message}`);
          scanUnavailable.code = "ONEX_REFUND_CHECK_UNAVAILABLE";
          throw scanUnavailable;
        }
        const referenceReached = registeredAtBlock > 0n &&
          BigInt(String(bscScanRows[0].last_scanned_block || "0")) >= registeredAtBlock &&
          BigInt(String(bscScanRows[0].last_finalized_block || "0")) >= registeredAtBlock &&
          BigInt(String(xtuScanRows[0].last_scanned_block || "0")) >= registeredAtBlock &&
          BigInt(String(xtuScanRows[0].last_finalized_block || "0")) >= registeredAtBlock;
        if (!referenceReached) {
          const scanLag = new Error("Wallet refund scanners have not reached the live common finalized reference block.");
          scanLag.code = "ONEX_REFUND_CHECK_UNAVAILABLE";
          throw scanLag;
        }

        const obligations = await getOutstandingRefundObligationsTx(connection, walletLower, Date.now());
        if (obligations.hasPending) {
          const refundPending = new Error("The submitted wallet address has an outstanding automatic refund.");
          refundPending.code = "ONEX_REFUND_PENDING";
          refundPending.details = obligations;
          throw refundPending;
        }

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
          `INSERT INTO bsc_wallet_address_registry(wallet_address_lower,wallet_address,username,registered_at_ms,registered_at_block)
           VALUES(?,?,?,?,?)`,
          [WalletAddress.toLowerCase(), WalletAddress, U, createdAtMs, registeredAtBlock.toString()],
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

        if (insertError.code === "ONEX_REFUND_PENDING") {
          return res.status(423).send({
            auth: "refund_pending",
            message: "Signup is temporarily blocked because this wallet address has an outstanding automatic refund. Complete the required minimum or wait until the refund is fully completed, as indicated below.",
            pending_totals_by_asset: insertError.details?.pending_totals_by_asset || [],
            pending_refunds: insertError.details?.pending_refunds || [],
          });
        }
        if (insertError.code === "ONEX_REFUND_CHECK_UNAVAILABLE") {
          return res.status(503).send({
            auth: "refund_check_unavailable",
            message: "We cannot verify outstanding refunds for this wallet right now. Please try again later.",
          });
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
    if (!res.headersSent && e?.code === "ONEX_REFUND_PENDING") {
      return res.status(423).send({
        auth: "refund_pending",
        message: "Signup is temporarily blocked because this wallet address has an outstanding automatic refund. Complete the required minimum or wait until the refund is fully completed, as indicated below.",
        pending_totals_by_asset: e.details?.pending_totals_by_asset || [],
        pending_refunds: e.details?.pending_refunds || [],
      });
    }
    if (!res.headersSent && e?.code === "ONEX_REFUND_CHECK_UNAVAILABLE") {
      return res.status(503).send({
        auth: "refund_check_unavailable",
        message: "We cannot verify outstanding refunds for this wallet right now. Please try again later.",
      });
    }
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
    minAmount: MIN_DEPOSIT_AMOUNT.toFixed(0),
    maxAmount: MAX_DEPOSIT_AMOUNT.toFixed(0),
    initialCreditCap: "100",
    consolidationMinBatchXtu: "100",
    weeklySystemFundedPurchaseLimit: 1,
    weeklySystemFundedPurchasePeriodDays: 7,
    weeklySystemFundedPurchaseAmountIndependent: true,
    weeklySystemFundedPurchaseScope: "onex_system_reserves_only",
    weeklySystemFundedPurchaseSharedAcrossAssets: true,
    sellerCampaignFundingMayBypassWeeklyCooldown: true,
    sellerCampaignActivationRequiresOptIn: true,
    sellerCampaignCreatedAfterEligibleOptIn: true,
    globalDisbursementActive: false,
    globalRunId: null,
    pendingExpirationDays: DEPOSIT_PENDING_EXPIRATION_DAYS,
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
      consolidationMinBatchXtu: settings.depositConsolidationMinBatchXtu,
      weeklySystemFundedPurchaseLimit: 1,
      weeklySystemFundedPurchasePeriodDays: 7,
      weeklySystemFundedPurchaseAmountIndependent: true,
      weeklySystemFundedPurchaseScope: "onex_system_reserves_only",
      weeklySystemFundedPurchaseSharedAcrossAssets: true,
      sellerCampaignFundingMayBypassWeeklyCooldown: true,
      sellerCampaignActivationRequiresOptIn: true,
      sellerCampaignCreatedAfterEligibleOptIn: true,
      globalDisbursementActive: globalActive,
      globalRunId: globalActive ? String(run.id) : null,
      minConfirmations: settings.minConfirmations,
      pendingExpirationDays: settings.depositPendingExpirationDays,
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
      `SELECT id,total_amount,credited_amount,remaining_amount,status,reason_codes,expires_at_ms
       FROM users_usdt_deposit_batches
       WHERE username=? AND remaining_amount>0
         AND status NOT IN ('credited','forfeited_to_common_reserve','refunded','refund_queued','rejected')
       ORDER BY opened_at_ms ASC,id ASC`, [U],
    );
    const xtuDepositState = await getXtuDepositPublicState(U);
    const pendingXtuRows = await db.queryAsync(
      `SELECT id,gross_amount,credited_amount,remaining_amount,status,reason_codes,expires_at_ms
       FROM xtu_deposit_batches
       WHERE username=? AND remaining_amount>0
         AND status NOT IN ('credited','forfeited_to_common_reserve','rejected','reversed')
       ORDER BY opened_at_ms ASC,id ASC`, [U],
    );
    const nowForPending = Date.now();
    const mapPendingDeposit = (row, asset) => {
      let reasons = [];
      try { reasons = JSON.parse(row.reason_codes || '[]'); } catch { reasons = ['invalid_reason_codes']; }
      const remaining = new BigNumber(row.remaining_amount || '0');
      const total = new BigNumber(row.total_amount ?? row.gross_amount ?? '0');
      const expiry = Number(row.expires_at_ms || 0);
      return {
        batch_id: String(row.id),
        pending_amount: remaining.toFixed(18),
        total_received: total.toFixed(18),
        credited_amount: new BigNumber(row.credited_amount || '0').toFixed(18),
        status: String(row.status),
        reason: reasons[0] || (total.lt(MIN_DEPOSIT_AMOUNT) ? 'minimum_not_reached' : 'credit_pending'),
        reason_codes: reasons,
        minimum_remaining: total.lt(MIN_DEPOSIT_AMOUNT)
          ? BigNumber.maximum(0, MIN_DEPOSIT_AMOUNT.minus(total)).toFixed(18) : '0',
        expires_at_ms: expiry || null,
        remaining_ms: expiry > 0 ? Math.max(0, expiry - nowForPending) : null,
        asset,
      };
    };
    const pendingBscDetails = pendingDepositRows.map((row) => mapPendingDeposit(row, 'BSC-USD'));
    const pendingXtuDetails = pendingXtuRows.map((row) => mapPendingDeposit(row, 'XTU'));
    const totalPendingBsc = pendingBscDetails.reduce((sum, row) => sum.plus(row.pending_amount), new BigNumber(0));
    const totalPendingXtu = pendingXtuDetails.reduce((sum, row) => sum.plus(row.pending_amount), new BigNumber(0));
    const hasPendingDeposit = pendingBscDetails.length > 0;
    const hasPendingXtuDeposit = pendingXtuDetails.length > 0;

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
      pending_deposits: {
        bsc_usd: { total_pending_amount: totalPendingBsc.toFixed(18), batches: pendingBscDetails },
        xtu: { total_pending_amount: totalPendingXtu.toFixed(18), batches: pendingXtuDetails },
      },
      xtu_deposit_allowed: xtuDepositState.depositAllowed,
      xtu_deposit_status: xtuDepositState.ready ? "available" : "unavailable",
      xtu_deposit_unavailable_reason: xtuDepositState.reason,
      xtu_deposit_addr: xtuDepositState.depositAllowed ? xtuDepositState.mainWalletAddress : null,
      xtu_sender_wallet: xtuDepositState.depositAllowed ? xtuDepositState.registeredSenderWallet : null,
      xtu_token_contract: xtuDepositState.depositAllowed ? xtuDepositState.tokenAddress : null,
      xtu_deposit_minimum: xtuDepositState.minAmount,
      xtu_deposit_maximum: xtuDepositState.maxAmount,
      xtu_deposit_initial_credit_cap: xtuDepositState.initialCreditCap,
      xtu_deposit_consolidation_minimum_batch: xtuDepositState.consolidationMinBatchXtu,
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
        weekly_system_funded_purchase_limit: state.weeklySystemFundedPurchaseLimit,
        weekly_system_funded_purchase_period_days: state.weeklySystemFundedPurchasePeriodDays,
        weekly_system_funded_purchase_amount_independent: state.weeklySystemFundedPurchaseAmountIndependent,
        weekly_system_funded_purchase_scope: state.weeklySystemFundedPurchaseScope,
        weekly_system_funded_purchase_shared_across_assets: state.weeklySystemFundedPurchaseSharedAcrossAssets,
        seller_campaign_funding_may_bypass_weekly_cooldown: state.sellerCampaignFundingMayBypassWeeklyCooldown,
        seller_campaign_activation_requires_opt_in: state.sellerCampaignActivationRequiresOptIn,
        seller_campaign_created_by_system_after_eligible_opt_in: state.sellerCampaignCreatedAfterEligibleOptIn,
        maximum_initial_credit_tranche_xtu: state.initialCreditCap,
        consolidation_minimum_batch_xtu: state.consolidationMinBatchXtu,
        blockchain_transfer_fee_percent: "0.1",
        onex_deposit_fee_percent: state.globalDisbursementActive ? "0" : new BigNumber(tfees).multipliedBy("0.75").toFixed(10),
        onex_deposit_fee_rate_factor: "0.75",
        gas_fee_always_deducted: true,
        global_disbursement_active: state.globalDisbursementActive,
        global_run_id: state.globalRunId,
        pending_expiration_days: state.pendingExpirationDays,
        credit_is_event_driven: true,
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
      maximum_amount_semantics: "maximum_per_credit_tranche",
      pending_expiration_days: DEPOSIT_PENDING_EXPIRATION_DAYS,
      weekly_system_funded_purchase_limit: 1,
      weekly_system_funded_purchase_period_days: 7,
      weekly_system_funded_purchase_amount_independent: true,
      weekly_system_funded_purchase_scope: "onex_system_reserves_only",
      weekly_system_funded_purchase_shared_across_assets: true,
      seller_campaign_funding_may_bypass_weekly_cooldown: true,
      seller_campaign_activation_requires_opt_in: true,
      seller_campaign_created_by_system_after_eligible_opt_in: true,
      maximum_initial_credit_tranche_bsc_usd: MAX_INITIAL_CREDIT_TRANCHE_AMOUNT.toFixed(0),
      seller_funding_priority: true,
      maximum_user_stock: maxStockDefault,
      credit_is_event_driven: true,
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
        weekly_system_funded_purchase_limit: 1,
        weekly_system_funded_purchase_period_days: 7,
        weekly_system_funded_purchase_amount_independent: state.weeklySystemFundedPurchaseAmountIndependent,
        weekly_system_funded_purchase_scope: state.weeklySystemFundedPurchaseScope,
        weekly_system_funded_purchase_shared_across_assets: state.weeklySystemFundedPurchaseSharedAcrossAssets,
        seller_campaign_funding_may_bypass_weekly_cooldown: state.sellerCampaignFundingMayBypassWeeklyCooldown,
        seller_campaign_activation_requires_opt_in: state.sellerCampaignActivationRequiresOptIn,
        seller_campaign_created_by_system_after_eligible_opt_in: state.sellerCampaignCreatedAfterEligibleOptIn,
        maximum_initial_credit_tranche_xtu: state.initialCreditCap,
        consolidation_minimum_batch_xtu: state.consolidationMinBatchXtu,
        pending_expiration_days: state.pendingExpirationDays || DEPOSIT_PENDING_EXPIRATION_DAYS,
        credit_is_event_driven: true,
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
      weekly_system_funded_purchase_limit: 1,
      weekly_system_funded_purchase_period_days: 7,
      weekly_system_funded_purchase_amount_independent: true,
      weekly_system_funded_purchase_scope: "onex_system_reserves_only",
      weekly_system_funded_purchase_shared_across_assets: true,
      seller_campaign_funding_may_bypass_weekly_cooldown: true,
      seller_campaign_activation_requires_opt_in: true,
      seller_campaign_created_by_system_after_eligible_opt_in: true,
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
        `SELECT c.tx_hash,c.status,c.estimated_gas_fee_usd,c.actual_gas_fee_usd,c.block_number,
                i.estimated_gas_fee_usd AS batch_estimated_gas_fee_usd,
                i.allocated_gas_fee_usd AS batch_actual_gas_fee_usd
         FROM xtu_deposit_consolidation_items i
         JOIN xtu_deposit_consolidations c ON c.id=i.consolidation_id
         WHERE i.batch_id=? LIMIT 1`, [String(row.id)],
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
          estimated_gas_fee_bsc_usd: consolidationRows[0].batch_estimated_gas_fee_usd,
          actual_gas_fee_bsc_usd: consolidationRows[0].batch_actual_gas_fee_usd,
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

// Known-account deposit balances and expired remainders are never refundable.
// The only refund workflow is the separate administrative workflow for official-token transfers from unregistered sender addresses.
router.post("/app/deposit/refund-request", async (_req, res) => res.status(410).send({
  transf: "automatic_refund_only",
  message: "Eligible official-token transfers are processed automatically. A user refund request is not required or accepted.",
}));
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
// The administrator may bypass the 20-100 BSC-USD per-session limits and the separate first-credit tranche cap only after a documented support review.
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
        ? "system_reserve" : (creditResult.partialReason === "system_funding_cooldown" ? "system_funding_cooldown" : "maximum_user_balance")];
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

// Public challenge endpoint for a finalized official XTU transfer sent from an unregistered address.
// The refund destination is never supplied by the requester: it is bound to the source transaction's `from` address.
router.post("/public/xtu/unknown-transfers/refund-challenge", async (_req, res) => res.status(410).send({
  refund: "automatic_refund_only",
  message: "Eligible official XTU transfers are processed automatically. Sender signatures and refund requests are not required.",
}));
router.post("/public/xtu/unknown-transfers/refund-request", async (_req, res) => res.status(410).send({
  refund: "automatic_refund_only",
  message: "Eligible official XTU transfers are processed automatically. Sender signatures and refund requests are not required.",
}));
router.post("/admin/xtu/unknown-transfers/list", async (req, res) => {
  const { pswd, pin, limit } = req.body || {};
  if (pswd !== decrypt(admin_pswd, DB_CONFIG.password) || pin !== decrypt(admin_pin, DB_CONFIG.password)) {
    return res.send({ transf: "incorrect admin credentials" });
  }
  const requestedLimit = Number(limit || 100);
  const safeLimit = Number.isInteger(requestedLimit) ? Math.min(200, Math.max(1, requestedLimit)) : 100;
  try {
    const rows = await db.queryAsync(
      `SELECT u.*,r.request_reference,r.contact_email,r.requester_reason,r.status AS request_status,
              r.proof_verified_at_ms,r.admin_reason,rf.reference AS refund_reference,rf.status AS refund_status,
              rf.base_received_amount,rf.gas_equivalent_xtu,rf.gross_transfer_amount,rf.contract_fee_amount,
              rf.net_amount,rf.estimated_fee_usd,rf.actual_fee_usd,rf.tx_hash AS refund_tx_hash
       FROM xtu_unknown_incoming_transfers u
       LEFT JOIN xtu_unknown_refund_requests r ON r.unknown_transfer_id=u.id
       LEFT JOIN xtu_unknown_refunds rf ON rf.unknown_transfer_id=u.id
       ORDER BY CASE WHEN u.status IN ('pending_admin','refund_failed') THEN 0 ELSE 1 END,u.id DESC
       LIMIT ?`, [safeLimit],
    );
    return res.send({ transf: "ok", items: rows.map((row) => ({ ...row, id: String(row.id) })) });
  } catch (error) {
    console.error("Unknown XTU transfer listing failed:", error.message);
    return res.send({ transf: "error" });
  }
});

router.post("/admin/xtu/unknown-transfers/resolve", async (req, res) => {
  const { pswd, pin, transfer_id, action, username, reason } = req.body || {};
  if (pswd !== decrypt(admin_pswd, DB_CONFIG.password) || pin !== decrypt(admin_pin, DB_CONFIG.password)) {
    return res.send({ transf: "incorrect admin credentials" });
  }
  const transferId = String(transfer_id ?? "").trim();
  const requestedAction = String(action || "").trim().toLowerCase();
  const targetUsername = normalizeUsername(username);
  const resolutionReason = typeof reason === "string" ? reason.trim() : "";
  if (!/^\d{1,20}$/.test(transferId) || !["assign", "refund", "retain"].includes(requestedAction) ||
      resolutionReason.length < 5 || resolutionReason.length > 1000) {
    return res.status(400).send({ transf: "invalid request" });
  }

  try {
    if (requestedAction === "assign") {
      if (!targetUsername) return res.status(400).send({ transf: "username required" });
      const result = await assignUnknownXtuTransferToAccount(db, transferId, targetUsername);
      if (result.status === "assigned") return res.send({ transf: "assigned", ...result });
      return res.status(409).send({ transf: result.status || "assignment_rejected" });
    }

    if (requestedAction === "retain") {
      const result = await withTransaction(async (tx) => {
        const [rows] = await tx.query(
          `SELECT * FROM xtu_unknown_incoming_transfers WHERE id=? AND status IN ('pending_admin','refund_failed') LIMIT 1 FOR UPDATE`,
          [transferId],
        );
        if (!rows.length) return { transf: "transfer_not_available" };
        const transfer = rows[0];
        const [requests] = await tx.query(
          `SELECT * FROM xtu_unknown_refund_requests WHERE unknown_transfer_id=? LIMIT 1 FOR UPDATE`, [transferId],
        );
        if (requests.length && ["approved", "refund_signed", "completed", "manual_review"].includes(String(requests[0].status))) {
          return { transf: "refund_already_resolved_or_in_progress" };
        }
        const now = String(Date.now());
        await tx.query(
          `UPDATE xtu_unknown_incoming_transfers SET status='retained_uncredited',decision_action='retain',
           decision_reason=?,decided_by='configured_admin',decided_at_ms=?,updated_at_ms=? WHERE id=?`,
          [resolutionReason, now, now, transferId],
        );
        if (requests.length) {
          await tx.query(
            `UPDATE xtu_unknown_refund_requests SET status='retained',admin_username='configured_admin',
             admin_reason=?,resolved_at_ms=?,updated_at_ms=? WHERE id=?`,
            [resolutionReason, now, now, String(requests[0].id)],
          );
        }
        await tx.query(
          `UPDATE xtu_deposit_transfer_events SET status='retained_uncredited'
           WHERE tx_hash=? AND log_index=? AND username IS NULL`,
          [String(transfer.tx_hash), String(transfer.log_index)],
        );
        await tx.query(
          `INSERT IGNORE INTO xtu_unknown_refund_events
           (unknown_transfer_id,request_id,refund_id,event_key,event_type,actor_type,actor_reference,old_status,new_status,reason,tx_hash,
            gross_amount,fee_amount,net_amount,created_at_ms)
           VALUES(?,?,NULL,?,'retained','admin','configured_admin',?,'retained',?,?,0,0,0,?)`,
          [transferId, requests.length ? String(requests[0].id) : null,
            `xtu-unknown-transfer:${transferId}:retained:${now}`,
            String(requests[0]?.status || transfer.status), resolutionReason, String(transfer.tx_hash), now],
        );
        return { transf: "retained_uncredited", transfer_id: transferId };
      });
      return res.send(result);
    }

    const result = await withTransaction(async (tx) => {
      const [transfers] = await tx.query(
        `SELECT * FROM xtu_unknown_incoming_transfers WHERE id=? AND status IN ('pending_admin','refund_failed') LIMIT 1 FOR UPDATE`,
        [transferId],
      );
      if (!transfers.length) return { transf: "transfer_not_available" };
      const transfer = transfers[0];
      const [requests] = await tx.query(
        `SELECT * FROM xtu_unknown_refund_requests WHERE unknown_transfer_id=? LIMIT 1 FOR UPDATE`, [transferId],
      );
      if (!requests.length || !requests[0].proof_verified_at_ms ||
          !["pending_admin", "failed"].includes(String(requests[0].status))) {
        return { transf: "verified_sender_request_required" };
      }
      const [refundRows] = await tx.query(
        `SELECT id,status FROM xtu_unknown_refunds WHERE unknown_transfer_id=? LIMIT 1 FOR UPDATE`, [transferId],
      );
      if (refundRows.length && !["failed", "cancelled"].includes(String(refundRows[0].status))) {
        return { transf: "refund_already_exists", refund_id: String(refundRows[0].id), status: refundRows[0].status };
      }
      const now = String(Date.now());
      await tx.query(
        `UPDATE xtu_unknown_incoming_transfers SET status='refund_approved',decision_action='refund',
         decision_reason=?,decided_by='configured_admin',decided_at_ms=?,updated_at_ms=? WHERE id=?`,
        [resolutionReason, now, now, transferId],
      );
      await tx.query(
        `UPDATE xtu_unknown_refund_requests SET status='approved',admin_username='configured_admin',
         admin_reason=?,approved_at_ms=?,resolved_at_ms=?,updated_at_ms=? WHERE id=?`,
        [resolutionReason, now, now, now, String(requests[0].id)],
      );
      await tx.query(
        `INSERT IGNORE INTO xtu_unknown_refund_events
         (unknown_transfer_id,request_id,refund_id,event_key,event_type,actor_type,actor_reference,old_status,new_status,reason,tx_hash,
          gross_amount,fee_amount,net_amount,created_at_ms)
         VALUES(?,?,NULL,?,'approved','admin','configured_admin',?,'approved',?,?,0,0,0,?)`,
        [transferId, String(requests[0].id), `xtu-unknown-refund:${requests[0].id}:approved:${now}`,
          String(requests[0].status), resolutionReason, String(transfer.tx_hash), now],
      );
      return { transf: "refund_approved", transfer_id: transferId, request_reference: requests[0].request_reference };
    });
    return res.send(result);
  } catch (error) {
    console.error("Unknown XTU transfer resolution failed:", error.message);
    if (error.code === "ER_DUP_ENTRY") return res.status(409).send({ transf: "already_resolved" });
    return res.status(409).send({ transf: "resolution_failed", reason: error.message });
  }
});

router.post("/admin/xtu/unknown-refunds/list", async (req, res) => {
  const { pswd, pin, limit } = req.body || {};
  if (pswd !== decrypt(admin_pswd, DB_CONFIG.password) || pin !== decrypt(admin_pin, DB_CONFIG.password)) {
    return res.send({ refund: "incorrect admin credentials" });
  }
  const requestedLimit = Number(limit || 100);
  const safeLimit = Number.isInteger(requestedLimit) ? Math.min(200, Math.max(1, requestedLimit)) : 100;
  try {
    const rows = await db.queryAsync(
      `SELECT rf.id,rf.unknown_transfer_id,rf.request_id,rf.payout_address,rf.base_received_amount,
              rf.gas_equivalent_xtu,rf.gas_adjustment_xtu,rf.gross_transfer_amount,rf.contract_fee_amount,rf.net_amount,
              rf.amount_raw,rf.estimated_fee_bnb,rf.estimated_fee_usd,rf.actual_fee_bnb,rf.actual_fee_usd,
              rf.bnb_usd_price,rf.gas_limit,rf.gas_price_wei,rf.reference,rf.status,rf.tx_hash,rf.nonce,
              rf.block_number,rf.receipt_json,rf.last_error,rf.created_at_ms,rf.updated_at_ms,rf.confirmed_at_ms,rf.failed_at_ms,
              u.from_address,u.tx_hash AS source_tx_hash,u.log_index,u.gross_amount AS source_gross_amount,
              u.hot_wallet_received_amount,u.commission_amount,r.request_reference,r.contact_email,r.status AS request_status,
              r.admin_reason
       FROM xtu_unknown_refunds rf
       INNER JOIN xtu_unknown_incoming_transfers u ON u.id=rf.unknown_transfer_id
       INNER JOIN xtu_unknown_refund_requests r ON r.id=rf.request_id
       ORDER BY rf.id DESC LIMIT ?`, [safeLimit],
    );
    return res.send({ refund: "ok", items: rows.map((row) => ({ ...row, id: String(row.id) })) });
  } catch (error) {
    console.error("Unknown XTU refund listing failed:", error.message);
    return res.send({ refund: "error" });
  }
});

// Public challenge for a finalized official BSC-USD transfer from an unregistered sender.
// The refund destination is bound to the original transaction's from address.
router.post("/public/bsc/unknown-transfers/refund-challenge", async (_req, res) => res.status(410).send({
  refund: "automatic_refund_only",
  message: "Eligible official BSC-USD transfers are processed automatically. Sender signatures and refund requests are not required.",
}));
router.post("/public/bsc/unknown-transfers/refund-request", async (_req, res) => res.status(410).send({
  refund: "automatic_refund_only",
  message: "Eligible official BSC-USD transfers are processed automatically. Sender signatures and refund requests are not required.",
}));
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
      `SELECT u.id,u.from_address,u.to_address,u.amount,u.tx_hash,u.log_index,u.block_number,u.block_timestamp_ms,
              u.previous_username,u.status,u.decision_action,u.decision_username,u.decision_reason,u.refund_id,u.created_at_ms,
              r.request_reference,r.contact_email,r.requester_reason,r.status AS refund_request_status,
              r.proof_verified_at_ms,r.admin_reason AS refund_admin_reason
       FROM bsc_unknown_incoming_transfers u
       LEFT JOIN bsc_unknown_refund_requests r ON r.unknown_transfer_id=u.id
       ORDER BY CASE WHEN u.status IN ('pending_admin','refund_failed') THEN 0 ELSE 1 END,u.id DESC
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
      `SELECT * FROM bsc_unknown_incoming_transfers WHERE id=? AND status IN ('pending_admin','refund_failed') LIMIT 1`,
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
      await db.queryAsync(
        `UPDATE bsc_unknown_refund_requests SET status='assigned',admin_username='configured_admin',
           admin_reason=?,resolved_at_ms=?,updated_at_ms=? WHERE unknown_transfer_id=? AND status IN ('challenge_pending','pending_admin')`,
        [resolutionReason, now, now, transferId],
      );
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
        await tx.query(
          `UPDATE bsc_unknown_refund_requests SET status='retained',admin_username='configured_admin',admin_reason=?,
             resolved_at_ms=?,updated_at_ms=? WHERE unknown_transfer_id=? AND status IN ('challenge_pending','pending_admin')`,
          [resolutionReason, now, now, transferId],
        );
        return { transf: "retained_uncredited", transfer_id: transferId };
      });
      return res.send(result);
    }

    const refundRequests = await db.queryAsync(
      `SELECT * FROM bsc_unknown_refund_requests
       WHERE unknown_transfer_id=? AND status='pending_admin' AND proof_verified_at_ms IS NOT NULL LIMIT 1`,
      [transferId],
    );
    if (!refundRequests.length || String(refundRequests[0].sender_address).toLowerCase() !== String(transfer.from_address).toLowerCase()) {
      return res.status(409).send({ transf: "sender_request_and_address_proof_required" });
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
        `SELECT * FROM bsc_unknown_incoming_transfers WHERE id=? AND status IN ('pending_admin','refund_failed') LIMIT 1 FOR UPDATE`,
        [transferId],
      );
      if (!rows.length) return { transf: "transfer not available" };
      const [requestRows] = await tx.query(
        `SELECT * FROM bsc_unknown_refund_requests WHERE unknown_transfer_id=? AND status='pending_admin'
         AND proof_verified_at_ms IS NOT NULL LIMIT 1 FOR UPDATE`, [transferId],
      );
      if (!requestRows.length || String(requestRows[0].sender_address).toLowerCase() !== String(rows[0].from_address).toLowerCase()) {
        return { transf: "sender_request_and_address_proof_required" };
      }
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
             decided_at_ms=?,refund_id=?,updated_at_ms=? WHERE id=? AND status IN ('pending_admin','refund_failed')`,
        [resolutionReason, now, String(refundInsert.insertId), now, transferId],
      );
      await tx.query(
        `UPDATE bsc_unknown_refund_requests SET status='approved',admin_username='configured_admin',admin_reason=?,
           refund_id=?,approved_at_ms=?,resolved_at_ms=?,updated_at_ms=? WHERE id=? AND status='pending_admin'`,
        [resolutionReason, String(refundInsert.insertId), now, now, now, String(requestRows[0].id)],
      );
      await tx.query(
        `INSERT IGNORE INTO bsc_unknown_refund_request_events
         (request_id,event_key,event_type,actor_type,actor_reference,old_status,new_status,reason,tx_hash,created_at_ms)
         VALUES(?,?,'admin_approved','admin','configured_admin','pending_admin','approved',?,?,?)`,
        [String(requestRows[0].id), `bsc-unknown-refund:${requestRows[0].id}:approved:${now}`, resolutionReason, rows[0].tx_hash, now],
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
router.post("/admin/deposit/refund", async (_req, res) => {
  return res.status(403).send({
    transf: "known_account_deposit_refund_disabled",
    reason: "Refunds are restricted to official BSC-USD or XTU transfers from sender addresses not registered in any OneX account. Use the dedicated unknown-transfer administrative workflow.",
  });
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
      const availableAdminReserve = calculateRemainingAdministrativeBacking(
        stock_limit, SYSTEM_ADMIN_RESERVE_RATIO, common.admin_expens || "0",
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
      const adminReserveAvailable = calculateRemainingAdministrativeBacking(
        stock_limit, SYSTEM_ADMIN_RESERVE_RATIO, common.admin_expens || "0",
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
      "sys_inactive_init_asset", "admin_expens", "total_gifts", "sellers_res", "total_run_balance", "total_tfees",
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
    const [commonLockRows] = await tx.query(
      `SELECT lock_name FROM system_locks WHERE lock_name='common_state' FOR UPDATE`,
    );
    if (!commonLockRows.length) throw new Error("The common-state lock row has not been initialized");
    const [accountRows] = await tx.query(
      `SELECT username,wallet_address,account_active FROM auths WHERE username=? LIMIT 1 FOR UPDATE`, [username],
    );
    if (!accountRows.length || Number(accountRows[0].account_active) !== 0) {
      throw new Error("The account must be confirmed deactivated before routing its deposits to automatic refunds.");
    }
    const wallet = String(accountRows[0].wallet_address || "").toLowerCase();
    await ensureWalletFinancialLockTx(tx, wallet, Date.now());
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
    let queuedAmount = new BigNumber(0);
    for (const batch of batchRows) {
      try {
        const result = await transferBscBatchRemainderToAutomaticRefundTx(
          tx, { ...batch, sender_address: wallet }, "C", now, "account_deactivated",
        );
        if (result.queued) {
          queuedAmount = queuedAmount.plus(result.amount);
          batchIds.push(String(batch.id));
          await queueDepositBatchStatusTx(tx, username, batch.id, "refund_queued", ["account_deactivated"], null, {
            asset: "BSC-USD", sessionTotal: String(batch.total_amount || "0"),
            creditedAmount: String(batch.credited_amount || "0"), remainingAmount: result.amount,
            refundCategory: "C",
          });
        }
      } catch (error) {
        await tx.query(
          `UPDATE users_usdt_deposit_batches SET status='manual_review',reason_codes=?,
           expiration_paused_at_ms=?,expiration_pause_reason='account_deactivation_refund_reconciliation',updated_at_ms=?
           WHERE id=?`,
          [safeJson(["account_deactivation_refund_reconciliation"]), String(now), String(now), String(batch.id)],
        );
        await updateBatchEventStatus(tx, batch.id, "manual_review", ["account_deactivation_refund_reconciliation"]);
        console.error(`Deactivated account deposit batch ${batch.id} requires refund reconciliation:`, error.message);
      }
    }
    return { count: batchIds.length, batchIds, queuedAmount: queuedAmount.toFixed(18) };
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
      // Reactivation removes the deactivation hold and immediately re-evaluates
      // the unchanged 30-day deadline and any remaining eligibility reasons.
      await tx.query(
        `UPDATE users_usdt_deposit_batches
         SET status='pending_support',next_attempt_at_ms=NULL,reason_codes=?,updated_at_ms=?
         WHERE id=? AND remaining_amount>0 AND status='pending_support'`,
        [reasonJson, String(now), String(batch.id)],
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
      const { routeOutstandingXtuBatchesToAutomaticRefund } = require("./xtu-deposit-worker");
      const xtuHoldResult = await routeOutstandingXtuBatchesToAutomaticRefund(db, U);
      result = {
        ...result,
        deposit_batches_held: holdResult.count,
        xtu_batches_refund_queued: xtuHoldResult.count,
        xtu_refund_events_queued: xtuHoldResult.events,
      };
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

// Administrative reserve settlements are recorded only after the external
// BSC-USD transfer has already been verified by the administrator.
function parseAdminReserveAmount(value) {
  const text = String(value ?? "").trim();
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,18})?$/.test(text)) return null;
  if (text.split(".")[0].length > 18) return null;
  const amount = new BigNumber(text);
  return amount.isFinite() && amount.isGreaterThan(0) ? amount : null;
}

function validateAdminExternalProof(body) {
  const txHash = body.tx_hash == null || body.tx_hash === "" ? null : String(body.tx_hash).trim();
  const tokenContract = body.token_contract == null || body.token_contract === ""
    ? null : String(body.token_contract).trim();
  const senderAddress = body.sender_address == null || body.sender_address === ""
    ? null : String(body.sender_address).trim();
  const recipientAddress = body.recipient_address == null || body.recipient_address === ""
    ? null : String(body.recipient_address).trim();
  const logIndexText = body.log_index == null || body.log_index === "" ? null : String(body.log_index).trim();

  if (txHash && !/^0x[0-9a-fA-F]{64}$/.test(txHash)) return { error: "invalid tx_hash" };
  for (const [field, value] of [["token_contract", tokenContract], ["sender_address", senderAddress], ["recipient_address", recipientAddress]]) {
    if (value && !isEvmAddress(value)) return { error: `invalid ${field}` };
  }
  if (logIndexText !== null && !/^\d{1,10}$/.test(logIndexText)) return { error: "invalid log_index" };
  if (logIndexText !== null && Number(logIndexText) > 4294967295) return { error: "invalid log_index" };
  if ((txHash || tokenContract || senderAddress || recipientAddress || logIndexText !== null) &&
      !(txHash && tokenContract && senderAddress && recipientAddress && logIndexText !== null)) {
    return { error: "blockchain proof fields must be supplied together" };
  }
  return {
    txHash: txHash ? txHash.toLowerCase() : null,
    tokenContract: tokenContract ? checksumEvmAddress(tokenContract) : null,
    senderAddress: senderAddress ? checksumEvmAddress(senderAddress) : null,
    recipientAddress: recipientAddress ? checksumEvmAddress(recipientAddress) : null,
    logIndex: logIndexText === null ? null : Number(logIndexText),
  };
}

async function lockCommonStateTx(tx) {
  const [commonLockRows] = await tx.query(
    "SELECT lock_name FROM system_locks WHERE lock_name='common_state' FOR UPDATE",
  );
  if (!commonLockRows.length) throw new Error("The common-state lock row has not been initialized");
}

async function checkAdminReserveGlobalStateTx(tx) {
  // A closed run is not blocked merely because it remains in the audit table;
  // the unresolved-payout checks below determine whether any obligation remains.
  const [activeRuns] = await tx.query(
    `SELECT id,status FROM global_disbursement_runs
     WHERE status IN ('announced','active','manual_review','claim_extension','extension','settlement_pending','closed_pending_settlement')
     ORDER BY id DESC LIMIT 1 FOR UPDATE`,
  );
  if (activeRuns.length) return { blocked: true, reason: "global_disbursement_open_or_unsettled" };

  const [unresolvedBsc] = await tx.query(
    `SELECT id,status FROM users_usdt_disbursements
     WHERE global_run_id IS NOT NULL
       AND status NOT IN ('confirmed','completed','failed','cancelled','rejected','expired')
     ORDER BY id ASC LIMIT 1 FOR UPDATE`,
  );
  if (unresolvedBsc.length) return { blocked: true, reason: "global_bsc_settlement_unresolved" };

  const [unresolvedXtu] = await tx.query(
    `SELECT id,status FROM xtu_global_settlement_payouts
     WHERE status NOT IN ('confirmed','completed','failed','cancelled','rejected')
     ORDER BY id ASC LIMIT 1 FOR UPDATE`,
  );
  if (unresolvedXtu.length) return { blocked: true, reason: "global_xtu_settlement_unresolved" };
  return { blocked: false };
}

async function getAdminSettlementRetryTx(tx, externalReference, operationType, amount) {
  const [rows] = await tx.query(
    `SELECT id,operation_type,external_reference,internal_reference,amount_bsc_usd,
            common_id,activity_id,gift_id
     FROM admin_external_settlements WHERE external_reference=? LIMIT 1 FOR UPDATE`,
    [externalReference],
  );
  if (!rows.length) return null;
  const row = rows[0];
  if (row.operation_type !== operationType || !new BigNumber(row.amount_bsc_usd).eq(amount)) {
    return { conflict: true };
  }
  const [commonRows] = await tx.query("SELECT * FROM common WHERE id=? LIMIT 1", [row.common_id]);
  if (!commonRows.length) throw new Error("The common snapshot linked to the external settlement is missing");
  let gift = null;
  if (row.gift_id) {
    const [giftRows] = await tx.query("SELECT * FROM gifts WHERE id=? LIMIT 1", [row.gift_id]);
    gift = giftRows[0] || null;
  }
  return {
    retry: true,
    common: commonRows[0],
    reference: row.internal_reference,
    activity_id: row.activity_id == null ? null : String(row.activity_id),
    gift,
  };
}

async function insertAdminSettlementTx(tx, {
  operationType, externalReference, internalReference, amount, commonId,
  activityId = null, giftId = null, proof, now,
}) {
  await tx.query(
    `INSERT INTO admin_external_settlements(
       operation_type,external_reference,internal_reference,amount_bsc_usd,common_id,
       activity_id,gift_id,admin_username,tx_hash,log_index,token_contract,
       sender_address,recipient_address,created_at_ms
     ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [operationType, externalReference, internalReference, amount.toFixed(18), commonId,
      activityId, giftId, "configured_admin", proof.txHash, proof.logIndex,
      proof.tokenContract, proof.senderAddress, proof.recipientAddress, now],
  );
}

async function createAdminReserveRoute({
  path, operationType, activityType, sender, receiver, calculator,
}) {
  router.post(path, async (req, res) => {
    const body = req.body || {};
    const { pswd, pin } = body;
    if (
      pswd !== decrypt(admin_pswd, DB_CONFIG.password) ||
      pin !== decrypt(admin_pin, DB_CONFIG.password)
    ) return res.send({ auth: "incorrect" });

    const amount = parseAdminReserveAmount(body.amount);
    const externalReference = typeof body.external_reference === "string"
      ? body.external_reference.trim() : "";
    if (!amount || externalReference.length < 1 || externalReference.length > 191) {
      return res.status(400).send({ error: "invalid amount or external_reference" });
    }
    const proof = validateAdminExternalProof(body);
    if (proof.error) return res.status(400).send({ error: proof.error });

    const [date, time] = getDate();
    const now = Date.now();
    try {
      const result = await withTransaction(async (tx) => {
        await lockCommonStateTx(tx);
        const common = await getLatestCommonTx(tx, true);
        const previous = await getAdminSettlementRetryTx(tx, externalReference, operationType, amount);
        if (previous?.conflict) return { error: "external_reference_idempotency_conflict", http_status: 409 };
        if (previous?.retry) return { ...previous, status: "ok" };
        const gate = await checkAdminReserveGlobalStateTx(tx);
        if (gate.blocked) return { error: gate.reason, http_status: 409 };

        const calculation = calculator({
          amountBscUsdValue: amount,
          totalUnitsPriceValue: common.total_units_price,
          unitPriceValue: common.unit_price,
          backedUnitsValue: common.backed_units,
          adminExpensesValue: common.admin_expens || "0",
          initialStockValue: stock_limit,
          ratioValue: SYSTEM_ADMIN_RESERVE_RATIO,
        });
        if (calculation.available === false) {
          return {
            error: operationType === "reserve_minus"
              ? "administrative_reserve_capacity_exceeded"
              : "administrative_recovery_exceeds_outstanding_expense",
            maximum_bsc_usd: (calculation.availableValue || calculation.maximumRecoverableValue || new BigNumber(0)).toFixed(18),
            http_status: 409,
          };
        }

        await insertCommonSnapshotTx(tx, common, {
          total_units_price: calculation.newTotalUnitsPrice.toFixed(30),
          unit_price: calculation.newUnitPrice.toFixed(30),
          backed_units: calculation.newBackedUnits.toFixed(30),
          admin_expens: calculation.newAdminExpenses.toFixed(30),
        }, date, time);
        const [snapshotRows] = await tx.query("SELECT * FROM common ORDER BY id DESC LIMIT 1");
        if (!snapshotRows.length) throw new Error("New common snapshot was not created");
        const commonSnapshot = snapshotRows[0];
        const internalReference = createFinancialReference(operationType === "reserve_minus" ? "ADMEXP" : "ADMREC");
        const [activityResult] = await tx.query(
          `INSERT INTO activities(
             sender,receiver,type,amount,unit_price,fees,fee_unit_price,bsc_fee_cost_usd,
             reference,record_date,record_time
           ) VALUES(?,?,?,?,?,0,?,0,?,?,?)`,
          [sender, receiver, activityType, calculation.initialAssetAmount.toFixed(30),
            common.unit_price, common.unit_price, internalReference, date, time],
        );
        await insertAdminSettlementTx(tx, {
          operationType, externalReference, internalReference, amount,
          commonId: commonSnapshot.id, activityId: activityResult.insertId,
          proof, now,
        });
        return {
          status: "ok",
          common: commonSnapshot,
          reference: internalReference,
          activity_id: String(activityResult.insertId),
        };
      });
      if (result.http_status) return res.status(result.http_status).send(result);
      return res.send(result);
    } catch (error) {
      console.error(`${path} failed:`, error);
      if (error.code === "ER_DUP_ENTRY") return res.status(409).send({ error: "external_reference_already_used" });
      return res.status(500).send({ error: "administrative reserve operation failed" });
    }
  });
}

createAdminReserveRoute({
  path: "/admin/res/minus",
  operationType: "reserve_minus",
  activityType: 6,
  sender: "ONEX",
  receiver: "XADMIN",
  calculator: calculateAdministrativeReserveExpense,
});

createAdminReserveRoute({
  path: "/admin/res/plus",
  operationType: "reserve_plus",
  activityType: 7,
  sender: "XADMIN",
  receiver: "ONEX",
  calculator: calculateAdministrativeReserveRecovery,
});

// A gift is a physical BSC-USD contribution already received outside the server.
router.post("/admin/res/give", async (req, res) => {
  const body = req.body || {};
  const { pswd, pin } = body;
  if (
    pswd !== decrypt(admin_pswd, DB_CONFIG.password) ||
    pin !== decrypt(admin_pin, DB_CONFIG.password)
  ) return res.send({ auth: "incorrect" });

  const amount = parseAdminReserveAmount(body.amount);
  const externalReference = typeof body.external_reference === "string"
    ? body.external_reference.trim() : "";
  if (!amount || externalReference.length < 1 || externalReference.length > 191) {
    return res.status(400).send({ error: "invalid amount or external_reference" });
  }
  const proof = validateAdminExternalProof(body);
  if (proof.error) return res.status(400).send({ error: proof.error });
  const [date, time] = getDate();
  const now = Date.now();

  try {
    const result = await withTransaction(async (tx) => {
      await lockCommonStateTx(tx);
      const common = await getLatestCommonTx(tx, true);
      const previous = await getAdminSettlementRetryTx(tx, externalReference, "gift", amount);
      if (previous?.conflict) return { error: "external_reference_idempotency_conflict", http_status: 409 };
      if (previous?.retry) return { ...previous, status: "ok" };
      const gate = await checkAdminReserveGlobalStateTx(tx);
      if (gate.blocked) return { error: gate.reason, http_status: 409 };

      const calculation = calculateCommonReserveGift({
        amountBscUsdValue: amount,
        totalUnitsPriceValue: common.total_units_price,
        unitPriceValue: common.unit_price,
        backedUnitsValue: common.backed_units,
      });
      const newTotalGifts = new BigNumber(common.total_gifts || "0").plus(amount);
      await insertCommonSnapshotTx(tx, common, {
        total_units_price: calculation.newTotalUnitsPrice.toFixed(30),
        unit_price: calculation.newUnitPrice.toFixed(30),
        total_gifts: newTotalGifts.toFixed(30),
      }, date, time);
      const [snapshotRows] = await tx.query("SELECT * FROM common ORDER BY id DESC LIMIT 1");
      if (!snapshotRows.length) throw new Error("New common snapshot was not created");
      const commonSnapshot = snapshotRows[0];
      const internalReference = createFinancialReference("GIFT");
      const [giftResult] = await tx.query(
        `INSERT INTO gifts(
           reference,external_reference,amount_bsc_usd,unit_price_before,unit_price_after,
           common_id,admin_username,tx_hash,log_index,token_contract,sender_address,
           recipient_address,created_at_ms
         ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [internalReference, externalReference, amount.toFixed(18), common.unit_price,
          calculation.newUnitPrice.toFixed(30), commonSnapshot.id, "configured_admin",
          proof.txHash, proof.logIndex, proof.tokenContract, proof.senderAddress,
          proof.recipientAddress, now],
      );
      await insertAdminSettlementTx(tx, {
        operationType: "gift", externalReference, internalReference, amount,
        commonId: commonSnapshot.id, giftId: giftResult.insertId, proof, now,
      });
      const [giftRows] = await tx.query("SELECT * FROM gifts WHERE id=? LIMIT 1", [giftResult.insertId]);
      return {
        status: "ok",
        common: commonSnapshot,
        reference: internalReference,
        gift: giftRows[0] || null,
      };
    });
    if (result.http_status) return res.status(result.http_status).send(result);
    return res.send(result);
  } catch (error) {
    console.error("/admin/res/give failed:", error);
    if (error.code === "ER_DUP_ENTRY") return res.status(409).send({ error: "external_reference_already_used" });
    return res.status(500).send({ error: "administrative reserve gift failed" });
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
