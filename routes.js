require("dotenv").config();

const express = require("express");
const crypto = require("crypto");
const { getAddress: checksumEvmAddress } = require("ethers");
const fs = require("fs");
const geoip = require("geoip-country");
const nodemailer = require("nodemailer");
const { createEmailQueue } = require("./email-queue");
const BigNumber = require("bignumber.js");
const {
  xtuToInitialAsset,
  initialAssetToXtu,
  calculateGlobalUnitPrice,
  calculateRechargeFundingAllocation,
  calculateRemainingSystemAdminReserve,
  calculateAdminCommonStockUpdate,
  calculateUnreservedDistributableInitialAssets,
} = require("./stock-accounting");
const {
  MIN_RECHARGE_AMOUNT,
  MAX_RECHARGE_AMOUNT,
  MAX_DEFAULT_STOCK,
  RECHARGE_BATCH_WINDOW_MS,
  RECHARGE_COOLDOWN_MS,
  DISBURSEMENT_COOLDOWN_DAYS,
  getLastOnexRecharge,
  assessRechargeCooldown,
  formatUtcRecordDateTime,
  getWeeklyReleaseAt,
  SYSTEM_ADMIN_RESERVE_RATIO,
} = require("./recharge-policy");
const {
  DISBURSEMENT_COOLDOWN_MS,
  DISBURSEMENT_RESERVATION_MS,
  calculateIndividualDisbursement,
  validateGlobalDisbursementCapacity,
  isRequestedPayoutWithinTolerance,
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
  getOrCreateUserDepositAddress,
  startPaymentWatcher: startUsdtPaymentWatcher,
  getPaymentPublicConfig,
  isAddress: isEvmAddress,
} = require("./pay");
const { startDepositSweeper } = require("./sweep");
const { checkTreasuryLiquidity } = require("./disbursement");
const { createTelegramBotLinkTx, queueTelegramMessageTx } = require("./telegram");
const { resetUserPriceBasisTx, triggerUserPriceThresholdTx, recordUserP2PSaleTx } = require("./user-price-accounting");
const {
  getLatestCommonTx,
  insertCommonSnapshotTx,
} = require("./common-accounting");
const { BSC_FEE_RECHARGE_DEFAULT_USD } = require("./fee-policy");
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

function requestTokenIsValid(req, token, password, username) {
  const ua = req.headers["user-agent"];
  if (
    typeof token !== "string" || Buffer.byteLength(token, "utf8") > 32_768 ||
    typeof password !== "string" || Buffer.byteLength(password, "utf8") > 4096 ||
    typeof username !== "string" || username.length > 30 ||
    typeof ua !== "string" || Buffer.byteLength(ua, "utf8") > 16_384
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
  if (!amountValue.isFinite() || !amountValue.isGreaterThan(0)) return { error: "invalid top-up amount" };
  if (enforceRechargeRange && amountValue.isLessThan(MIN_RECHARGE_AMOUNT)) {
    return { error: "minimum recharge amount not met" };
  }
  if (!Number.isFinite(tfees) || tfees < 0 || tfees >= 100) throw new Error("Invalid transfer-fee configuration");

  const [lockRows] = await tx.query(
    "SELECT lock_name FROM system_locks WHERE lock_name=? FOR UPDATE", ["common_state"],
  );
  if (!lockRows.length) throw new Error("The common-state lock row has not been initialized");
  const common = await getLatestCommonTx(tx, true);
  const [activeGlobalRuns] = await tx.query(
    "SELECT id FROM global_disbursement_runs WHERE status IN ('queued','staging','settling','manual_review') ORDER BY id DESC LIMIT 1 FOR UPDATE",
  );
  if (activeGlobalRuns.length) return { error: "global disbursement in progress" };
  const [authRows] = await tx.query(
    "SELECT status FROM auths WHERE username=? FOR UPDATE", [username],
  );
  if (!authRows.length || Number(authRows[0].status) <= 0) return { error: "user not found" };
  const [userRows] = await tx.query(
    "SELECT balance FROM users_stock WHERE username=? FOR UPDATE", [username],
  );
  if (!userRows.length) return { error: "user not found" };
  const [pendingDisbursementRows] = await tx.query(
    `SELECT id FROM users_usdt_disbursements
     WHERE username=? AND status IN ('queued','signed','submitted','manual_review')
     ORDER BY id DESC LIMIT 1 FOR UPDATE`, [username],
  );
  if (pendingDisbursementRows.length) return { error: "disbursement is pending" };

  const userBalanceInitial = new BigNumber(userRows[0].balance);
  if (!userBalanceInitial.isFinite() || userBalanceInitial.isNegative()) {
    throw new Error("Invalid initial-asset user balance during top-up");
  }
  const total = new BigNumber(common.total_units_price);
  const price = new BigNumber(common.unit_price);
  const backed = new BigNumber(common.backed_units);
  const inactive = new BigNumber(common.inactive_init_asset);
  const sellersReserve = new BigNumber(common.sellers_res || "0");
  // Do not recycle a beneficiary's own locked seller reserve into their recharge.
  const activeSellerReserve = await getActiveSellerReserveAvailableTx(tx, username);
  if (
    !total.isFinite() || !total.isGreaterThan(0) || !price.isFinite() || !price.isGreaterThan(0) ||
    !backed.isFinite() || !backed.isGreaterThan(0) || !inactive.isFinite() || inactive.isNegative() ||
    !sellersReserve.isFinite() || sellersReserve.isNegative()
  ) throw new Error("Invalid common reserve values during top-up");
  if (activeSellerReserve.gt(sellersReserve)) {
    throw new Error("Active seller lots exceed common.sellers_res");
  }

  const feeAmountXtu = amountValue.multipliedBy(tfees).dividedBy(100);
  const bscFeeRecovery = new BigNumber(BSC_FEE_RECHARGE_DEFAULT_USD);
  if (!bscFeeRecovery.isFinite() || bscFeeRecovery.isNegative()) {
    throw new Error("RECHARGE_BSC_FEE_RECOVERY_USD must be finite and non-negative");
  }
  const netAmountXtu = amountValue.minus(feeAmountXtu).minus(bscFeeRecovery);
  if (!netAmountXtu.isFinite() || !netAmountXtu.isGreaterThan(0)) {
    return { error: "fees exceed the received recharge amount" };
  }

  // Funding priority: inactive OneX reserve, seller lots, then backed assets.
  const requestedInitialAsset = netAmountXtu.dividedBy(price);
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
  const fundingAllocation = calculateRechargeFundingAllocation(
    requestedInitialAsset,
    price,
    backed,
    inactive,
    activeSellerReserve,
    total,
    protectedFloor,
    pendingPayoutInitial,
  );
  if (!fundingAllocation.available) {
    const systemAvailable = BigNumber.maximum(0, fundingAllocation.availableAfterPending);
    const availableTotal = systemAvailable.plus(activeSellerReserve);
    return { limit: `BSC-USD ${availableTotal.multipliedBy(price).toFixed(18)}` };
  }

  const sellerAmountInitial = fundingAllocation.sellerInitialAsset;
  const systemAmountInitial = fundingAllocation.systemInitialAsset;
  const systemAmountXtu = systemAmountInitial.multipliedBy(price);

  if (systemAmountXtu.isGreaterThan(0) && systemAmountXtu.isGreaterThan(MAX_RECHARGE_AMOUNT)) {
    return { error: "maximum system-funded recharge amount exceeded" };
  }
  const lastRecharge = systemAmountXtu.isGreaterThan(0)
    ? await getLastOnexRecharge(tx, username, OneX)
    : null;
  const cooldown = systemAmountXtu.isGreaterThan(0)
    ? assessRechargeCooldown(lastRecharge, eventTimestampMs)
    : { allowed: true, remainingMs: 0, lastRechargeMs: null };
  if (systemAmountXtu.isGreaterThan(0) && !cooldown.allowed) {
    return {
      error: "weekly recharge limit reached",
      remaining_seconds: Math.ceil(cooldown.remainingMs / 1000),
      lastRechargeMs: cooldown.lastRechargeMs,
      sellerReserveAvailable: sellersReserve.toFixed(),
    };
  }

  // Validate the resulting balance and all common values before consuming any
  // seller lot. Returning an API error after a reserve write would otherwise
  // commit a partial transaction in the shared transaction wrapper.
  const sellerBasis = sellerAmountInitial;
  const systemBasis = systemAmountInitial;
  const creditedBasis = sellerBasis.plus(systemBasis);
  const feeBasis = feeAmountXtu.dividedBy(price);
  const newTotal = total.plus(systemAmountXtu).plus(feeAmountXtu);
  const newBacked = backed.minus(fundingAllocation.consumedBacked).plus(feeBasis);
  const newInactive = fundingAllocation.newInactive;
  const newSellersReserve = sellersReserve.minus(sellerBasis);
  const totalTfees = new BigNumber(common.total_tfees || "0").plus(feeBasis);
  if (newSellersReserve.isNegative()) throw new Error("Seller reserve totals would become negative");

  const newPrice = calculateGlobalUnitPrice(newTotal, newBacked);
  const newBalanceInitial = userBalanceInitial.plus(creditedBasis);
  const maxStockXtu = new BigNumber(maxStockDefault);
  if (newBalanceInitial.multipliedBy(newPrice).gt(maxStockXtu)) {
    return { error: "maximum user balance exceeded" };
  }

  // Capture any threshold reached before this acquisition, using the user's
  // pre-recharge principal balance. The acquisition then resets the price basis.
  await triggerUserPriceThresholdTx(tx, username, price);

  const sellerAllocation = sellerAmountInitial.isGreaterThan(0)
    ? await consumeSellerReserveTx(tx, sellerAmountInitial, reference, date, time, username)
    : { consumedInitialAsset: new BigNumber(0), allocations: [] };
  if (!sellerAllocation.consumedInitialAsset.eq(sellerAmountInitial)) {
    throw new Error("The seller reserve changed during recharge allocation");
  }
  const sellerFeeBasis = requestedInitialAsset.isGreaterThan(0)
    ? feeBasis.multipliedBy(sellerBasis).dividedBy(requestedInitialAsset)
    : new BigNumber(0);
  const systemFeeBasis = feeBasis.minus(sellerFeeBasis);
  if (sellerBasis.isGreaterThan(0)) {
    await tx.query(
      `INSERT INTO activities(sender,receiver,type,amount,unit_price,fees,reference,record_date,record_time)
       VALUES('XUSER',?,?,?, ?,?,?,?,?)`,
      [username, 2, sellerBasis.toFixed(30), price.toFixed(30), sellerFeeBasis.toFixed(30), `${reference}S`.slice(0, 64), date, time],
    );
  }
  if (systemBasis.isGreaterThan(0)) {
    await tx.query(
      `INSERT INTO activities(sender,receiver,type,amount,unit_price,fees,reference,record_date,record_time)
       VALUES(?,?,2,?,?,?,?,?,?)`,
      [OneX, username, systemBasis.toFixed(30), price.toFixed(30), systemFeeBasis.toFixed(30), `${reference}O`.slice(0, 64), date, time],
    );
  }
  await tx.query(
    "UPDATE users_stock SET balance=?,record_date=?,record_time=? WHERE username=?",
    [newBalanceInitial.toFixed(30), date, time, username],
  );
  await insertCommonSnapshotTx(tx, common, {
    total_units_price: newTotal.toFixed(30),
    backed_units: newBacked.toFixed(30),
    inactive_init_asset: newInactive.toFixed(30),
    sellers_res: newSellersReserve.toFixed(30),
    total_tfees: totalTfees.toFixed(30),
  }, date, time);

  const resultingPrice = calculateGlobalUnitPrice(newTotal, newBacked);
  await resetUserPriceBasisTx(tx, username, resultingPrice, tfees);

  const creditedXtuAtTransactionPrice = creditedBasis.multipliedBy(price);
  await queueTelegramMessageTx(
    tx,
    username,
    `recharge:${reference}:credited`,
    [
      "OneX Recharge Update",
      "Your recharge has been credited successfully.",
      `Amount received: ${amountValue.toFixed(8)} BSC-USD`,
      `System fee: ${feeAmountXtu.toFixed(8)} BSC-USD`,
      `BSC cost recovery: ${bscFeeRecovery.toFixed(8)} BSC-USD`,
      `Amount credited: ${creditedXtuAtTransactionPrice.toFixed(8)} XTU at transaction price ${price.toFixed(12)}`,
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
    fee_amount: feeAmountXtu.toFixed(18),
    bsc_fee_recovery: bscFeeRecovery.toFixed(18),
    credited_amount: creditedXtuAtTransactionPrice.toFixed(18),
    credited_initial_asset: creditedBasis.toFixed(30),
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
  if (!enabled("USDT_DISBURSEMENTS_ENABLED") || !enabled("USDT_INDIVIDUAL_DISBURSEMENT_ENABLED")) {
    return { transf: "individual disbursement unavailable" };
  }
  const paymentConfig = getPaymentPublicConfig();
  if (!paymentConfig.enabled || !process.env.USDT_BEP20_TREASURY_ADDRESS) {
    return { transf: "disbursement unavailable" };
  }
  if (!requestedGrossAmountXtu.isFinite() || !requestedGrossAmountXtu.isGreaterThan(0)) {
    return { transf: "invalid disbursement amount" };
  }

  const [commonLockRows] = await tx.query(
    "SELECT lock_name FROM system_locks WHERE lock_name=? FOR UPDATE", ["common_state"],
  );
  if (!commonLockRows.length) throw new Error("The common-state lock row has not been initialized");
  const common = await getLatestCommonTx(tx, true);
  const commonPrice = new BigNumber(common.unit_price);
  const commonTotal = new BigNumber(common.total_units_price);
  const commonBacked = new BigNumber(common.backed_units);
  const commonInactive = new BigNumber(common.inactive_init_asset);
  if (!commonPrice.isFinite() || !commonPrice.isGreaterThan(0)) throw new Error("Invalid global unit price");

  const [activeGlobalRuns] = await tx.query(
    "SELECT id FROM global_disbursement_runs WHERE status IN ('queued','staging','settling','manual_review') ORDER BY id DESC LIMIT 1 FOR UPDATE",
  );
  if (activeGlobalRuns.length) return { transf: "global disbursement in progress" };

  const [authRows] = await tx.query(
    "SELECT status,password,consec_failed_auth,password_temp_expires_at_ms FROM auths WHERE username=? FOR UPDATE",
    [username],
  );
  if (authRows.length && (
    Number(authRows[0].consec_failed_auth || 0) >= 3 || authRows[0].password_temp_expires_at_ms != null
  )) return { auth: "not allowed" };
  if (
    authRows.length === 0 || Number(authRows[0].status) <= 0 ||
    authRows[0].password !== verifiedPasswordHash
  ) return { transf: "failed" };

  const [stockRows] = await tx.query(
    "SELECT balance,seller_status FROM users_stock WHERE username=? FOR UPDATE", [username],
  );
  if (!stockRows.length) return { transf: "failed" };
  if (Number(stockRows[0].seller_status || 0) !== 0) return { transf: "seller campaign active" };

  const [walletRows] = await tx.query(
    `SELECT payout_address FROM users_usdt_deposit_wallets
     WHERE username=? LIMIT 1 FOR UPDATE`, [username],
  );
  const payoutAddress = walletRows[0]?.payout_address || "";
  if (!isEvmAddress(payoutAddress) || /^0x0{40}$/i.test(payoutAddress)) {
    return { transf: "payout wallet not registered" };
  }
  if (String(payoutAddress).toLowerCase() === String(process.env.USDT_BEP20_TREASURY_ADDRESS).toLowerCase()) {
    return { transf: "invalid payout wallet" };
  }

  const now = Date.now();
  const [successfulRows] = await tx.query(
    `SELECT id FROM users_usdt_disbursements
     WHERE username=? AND status='confirmed' AND CAST(confirmed_at_ms AS UNSIGNED)>=?
     ORDER BY confirmed_at_ms DESC LIMIT 1 FOR UPDATE`,
    [username, String(now - DISBURSEMENT_COOLDOWN_MS)],
  );
  if (successfulRows.length) return { transf: "disbursement limit reached", cooldown_days: DISBURSEMENT_COOLDOWN_DAYS };
  const [activeRows] = await tx.query(
    `SELECT id FROM users_usdt_disbursements
     WHERE username=? AND status IN ('queued','signed','submitted','manual_review')
     ORDER BY id DESC LIMIT 1 FOR UPDATE`, [username],
  );
  if (activeRows.length) return { transf: "disbursement pending" };

  const userBalanceInitial = new BigNumber(stockRows[0].balance);
  const currentBalanceXtu = userBalanceInitial.multipliedBy(commonPrice);
  const minimumEligibleBalanceXtu = new BigNumber(maxStockDefault).minus(10);
  const minimumIndividualAmountXtu = new BigNumber(process.env.DISBURSEMENT_INDIVIDUAL_MINIMUM_XTU || "10");
  const minimumRemainingXtu = new BigNumber(process.env.DISBURSEMENT_INDIVIDUAL_MINIMUM_REMAINING_XTU || "0");
  if (
    !userBalanceInitial.isFinite() || !userBalanceInitial.isGreaterThan(0) ||
    !currentBalanceXtu.isFinite() || currentBalanceXtu.isLessThan(minimumEligibleBalanceXtu)
  ) return { transf: "not eligible", minimum_balance: minimumEligibleBalanceXtu.toFixed() };
  if (
    !minimumIndividualAmountXtu.isFinite() || !minimumIndividualAmountXtu.isGreaterThan(0) ||
    !minimumRemainingXtu.isFinite() || minimumRemainingXtu.isNegative()
  ) throw new Error("Invalid individual disbursement minimum settings");
  if (requestedGrossAmountXtu.isLessThan(minimumIndividualAmountXtu)) {
    return { transf: "below individual minimum", minimum_amount: minimumIndividualAmountXtu.toFixed(18) };
  }

  const calculation = calculateIndividualDisbursement(
    requestedGrossAmountXtu, userBalanceInitial, commonPrice, tfees,
  );
  // Capture a price threshold reached before this system sale. The sale to OneX
  // is excluded from the 50-percent P2P-sale requirement and does not reset A/B.
  await triggerUserPriceThresholdTx(tx, username, commonPrice);

  const newBalanceInitial = userBalanceInitial.minus(calculation.grossInitialAsset);
  const remainingBalanceXtu = newBalanceInitial.multipliedBy(commonPrice);
  if (remainingBalanceXtu.isLessThan(minimumRemainingXtu)) {
    return {
      transf: "minimum remaining balance not met",
      minimum_remaining_balance: minimumRemainingXtu.toFixed(18),
    };
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
    commonBacked, commonInactive, protectedInitialAssets, pendingPayoutInitial,
  );
  const availableAfterPending = reserveAvailability.availableAfterPending;
  if (
    !commonTotal.isFinite() || !commonTotal.isGreaterThan(0) ||
    !commonBacked.isFinite() || !commonBacked.isGreaterThan(0) ||
    !commonInactive.isFinite() || commonInactive.isNegative() ||
    !availableAfterPending.isFinite() || availableAfterPending.lt(calculation.soldInitialAsset)
  ) return { transf: "insufficient disbursement reserve" };

  const reference = createFinancialReference(`INDISB${username}`);
  const [date, time] = getDate();
  await tx.query(
    `INSERT INTO users_usdt_disbursements
     (username,payout_address,requested_amount,payout_amount,amount_raw,gross_initial_asset,
      sold_initial_asset,fee_amount,fee_initial_asset,price_value,disbursement_mode,global_run_id,
      balance_after_reservation,bsc_fee_recovered_usd,reference,status,created_at_ms,
      reservation_expires_at_ms,updated_at_ms)
     VALUES(?,?,?,?,?,?,?,?,?,?,'individual',NULL,?,0,?,'queued',?,?,?)`,
    [
      username,
      payoutAddress,
      calculation.grossAmountXtu.toFixed(18),
      calculation.payoutAmount.toFixed(18),
      calculation.amountRaw,
      calculation.grossInitialAsset.toFixed(30),
      calculation.soldInitialAsset.toFixed(30),
      calculation.feeAmount.toFixed(18),
      calculation.feeInitialAsset.toFixed(30),
      calculation.priceValue.toFixed(30),
      newBalanceInitial.toFixed(30),
      reference,
      String(now),
      String(now + DISBURSEMENT_RESERVATION_MS),
      String(now),
    ],
  );
  const [idRows] = await tx.query("SELECT id FROM users_usdt_disbursements WHERE reference=? LIMIT 1", [reference]);
  if (!idRows.length) throw new Error("Unable to read the queued individual disbursement");

  await tx.query(
    "UPDATE users_stock SET balance=?,record_date=?,record_time=? WHERE username=?",
    [newBalanceInitial.toFixed(30), date, time, username],
  );
  await queueTelegramMessageTx(tx, username, `disbursement:${idRows[0].id}:queued`, [
    "OneX Individual Disbursement Update",
    "Your individual disbursement request has been accepted and the requested balance is reserved.",
    `Gross amount requested: ${calculation.grossAmountXtu.toFixed(8)} XTU`,
    `System fee: ${calculation.feeAmount.toFixed(8)} XTU`,
    `Locked valuation price: ${calculation.priceValue.toFixed(12)} XTU per initial asset`,
    `Expected payment: ${calculation.payoutAmount.toFixed(8)} BSC-USD`,
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

const RECHARGE_HOLD_REASON_TEXT = {
  below_minimum: "The total received during the 60-minute session is below 12 BSC-USD.",
  above_maximum: "The portion that requires ONEX system reserves exceeds 140 BSC-USD.",
  weekly_limit: "ONEX reserves cannot be used yet. The system may retry earlier if seller reserve becomes sufficient; otherwise it retries at the displayed release time.",
  maximum_user_balance: "Crediting this recharge would exceed the maximum account balance of 300 XTU.",
  account_unavailable: "The OneX account is disabled, deleted or unavailable.",
  system_reserve: "The active seller and ONEX reserves are not currently sufficient to credit this payment.",
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
    // Serialize incoming deposit intake against the global-run population snapshot.
    const [commonLockRows] = await tx.query(
      "SELECT lock_name FROM system_locks WHERE lock_name='common_state' FOR UPDATE",
    );
    if (!commonLockRows.length) throw new Error("The common-state lock row has not been initialized");
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
    if (batch.status === "pending_weekly" && Number(batch.next_attempt_at_ms || 0) > now) return { waiting: true };
    if (batch.status === "pending_reserve" && Number(batch.next_attempt_at_ms || 0) > now) return { waiting: true };

    const amount = new BigNumber(batch.total_amount);
    const reasons = [];
    if (!amount.isFinite() || amount.isLessThan(MIN_RECHARGE_AMOUNT)) reasons.push("below_minimum");
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
      if (creditResult?.error === "global disbursement in progress") {
        const retryAt = now + 5 * 60 * 1000;
        const reasonCodes = ["global_disbursement_in_progress"];
        await tx.query(
          `UPDATE users_usdt_deposit_batches
           SET status='pending_reserve',pending_since_ms=COALESCE(pending_since_ms,?),
               next_attempt_at_ms=?,reason_codes=?,updated_at_ms=? WHERE id=?`,
          [String(now), String(retryAt), safeJson(reasonCodes), String(now), batchId],
        );
        await updateBatchEventStatus(tx, batchId, "pending_reserve", reasonCodes);
        await queueRechargeBatchStatusTx(tx, batch.username, batchId, "pending_reserve", reasonCodes, retryAt);
        return { waiting: true, reason: "global_disbursement_in_progress", retryAtMs: retryAt };
      }
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
        const releaseAt = getWeeklyReleaseAt(pendingSince, creditResult.lastRechargeMs);
        const retryAt = Math.min(releaseAt, now + 5 * 60 * 1000);
        await tx.query(
          `UPDATE users_usdt_deposit_batches SET status='pending_weekly',pending_since_ms=COALESCE(pending_since_ms,?),release_at_ms=?,next_attempt_at_ms=?,reason_codes=?,updated_at_ms=? WHERE id=?`,
          [String(pendingSince), String(releaseAt), String(retryAt), safeJson(["weekly_limit"]), String(now), batchId],
        );
        await updateBatchEventStatus(tx, batchId, "pending_weekly", ["weekly_limit"]);
        await queueRechargeBatchStatusTx(tx, batch.username, batchId, "pending_weekly", ["weekly_limit"], releaseAt);
        return { waiting: true, releaseAtMs: releaseAt, retryAtMs: retryAt };
      }
      if (creditResult?.error === "user not found") {
        reasons.push("account_unavailable");
        await tx.query(
          `UPDATE users_usdt_deposit_batches SET status='pending_support',reason_codes=?,pending_since_ms=COALESCE(pending_since_ms,?),updated_at_ms=? WHERE id=?`,
          [safeJson(reasons), String(now), String(now), batchId],
        );
        await updateBatchEventStatus(tx, batchId, "pending_support", reasons);
        await queueRechargeBatchStatusTx(tx, batch.username, batchId, "pending_support", reasons);
        return { held: true, reasons };
      }
      if (creditResult?.error === "maximum user balance exceeded") {
        reasons.push("maximum_user_balance");
        await tx.query(
          `UPDATE users_usdt_deposit_batches SET status='pending_support',reason_codes=?,pending_since_ms=COALESCE(pending_since_ms,?),updated_at_ms=? WHERE id=?`,
          [safeJson(reasons), String(now), String(now), batchId],
        );
        await updateBatchEventStatus(tx, batchId, "pending_support", reasons);
        await queueRechargeBatchStatusTx(tx, batch.username, batchId, "pending_support", reasons);
        return { held: true, reasons };
      }
      if (creditResult?.error === "maximum system-funded recharge amount exceeded") {
        reasons.push("above_maximum");
        await tx.query(
          `UPDATE users_usdt_deposit_batches SET status='pending_support',reason_codes=?,pending_since_ms=COALESCE(pending_since_ms,?),updated_at_ms=? WHERE id=?`,
          [safeJson(reasons), String(now), String(now), batchId],
        );
        await updateBatchEventStatus(tx, batchId, "pending_support", reasons);
        await queueRechargeBatchStatusTx(tx, batch.username, batchId, "pending_support", reasons);
        return { held: true, reasons };
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
        OR (status='pending_weekly' AND (next_attempt_at_ms<=? OR release_at_ms<=?))
        OR (status='pending_reserve' AND next_attempt_at_ms<=?)
     ORDER BY id ASC LIMIT 50`,
    [String(now), String(now), String(now), String(now)],
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

const mailQueue = createEmailQueue(transporter);

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
    cni,
    pswd,
    seed,
    cniimg1,
    cniimg2,
  } = req.body || {};

  const ip = req.ip || req.socket.remoteAddress;
  const geo = geoip.lookup(ip);
  if (!geo) return res.send({ msg: "what country" });

  // First launch if Madagascar only allowed
  if (geo.country !== "MG")
    return res.send({ msg: "unsupported country" });

  const requiredTextValues = [email, birth, addr, name, cni, pswd, seed];
  if (requiredTextValues.some((value) => typeof value !== "string")) {
    return res.status(400).send({ msg: "invalid input" });
  }

  const Email = email.trim();
  const Birth = birth.trim();
  const rawAddress = addr.trim();
  const rawName = name.trim();
  const rawCni = cni.trim();
  if (
    !Email || Buffer.byteLength(Email, "utf8") > 254 ||
    !Birth || Buffer.byteLength(Birth, "utf8") > 20 ||
    !rawAddress || Buffer.byteLength(rawAddress, "utf8") > 100 ||
    !rawName || Buffer.byteLength(rawName, "utf8") > 100 ||
    !rawCni || Buffer.byteLength(rawCni, "utf8") > 128 ||
    !pswd || !seed || Buffer.byteLength(pswd, "utf8") > 4096 || Buffer.byteLength(seed, "utf8") > 4096
  ) {
    return res.status(400).send({ msg: "invalid input" });
  }

  const cniAttachment1 = parseBase64Image(cniimg1, "cni_1");
  const cniAttachment2 = parseBase64Image(cniimg2, "cni_2");
  if (cniAttachment1 === false || cniAttachment2 === false) {
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
  const CNI = encrypt(rawCni, DB_CONFIG.password);
  const passwordValue = pswd;
  const seedValue = seed;
  if (CNI.length > 255) return res.status(400).send({ msg: "invalid CNI" });

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
          "INSERT INTO users_stock(username,balance,record_date,record_time) VALUES(?,?,?,?)",
          [U, "0", date, time],
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

      accountCreated = true;
      break;
    }
    if (!accountCreated) throw new Error("Unable to allocate a unique username after 10 attempts");

    res.send({ msg: "ok" });

    // Send the welcome email after the account is committed.
    mailQueue.sendMail({
      from: SERVER_MAIL,
      to: Email,
      subject: "New member",
      text: `Welcome to OneX.\nYour username: ${U}`,
    }).catch((mailError) => {
      console.error("Welcome email failed:", mailError);
    });

    // Send the identity documents for verification without modifying their encoded contents.
    mailQueue.sendMail({
      from: SERVER_MAIL,
      to: "eddy.heriniaina.rafidison@gmail.com",
      subject: "Account Verification",
      text: [U, Name, Birth, Address, cni].join("\n"),
      attachments: [cniAttachment1, cniAttachment2].filter(Boolean),
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

  if (!U || !P || Buffer.byteLength(P, "utf8") > 4096) {
    return res.status(400).send({ msg: "invalid request", ua: "", tg_botLink: null });
  }
  if (needsSeed && (!submittedSeed || Buffer.byteLength(submittedSeed, "utf8") > 4096)) {
    return res.status(400).send({ msg: "invalid seed", ua: "", tg_botLink: null });
  }
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
    if (await accountApiLimitReached(res, U, "user_last_stock", 60, 60_000)) return;

    const stockRows = await db.queryAsync(
      `SELECT balance,seller_status,run_balance,seller_expires_at_ms
       FROM users_stock WHERE username=? LIMIT 1`,
      [U],
    );
    const commonRows = await db.queryAsync(
      "SELECT total_units_price,backed_units,unit_price FROM common ORDER BY id DESC LIMIT 1",
    );
    if (stockRows.length === 0 || commonRows.length === 0) return res.send({ msg: "error" });

    const commonTotal = new BigNumber(commonRows[0].total_units_price);
    const commonBacked = new BigNumber(commonRows[0].backed_units);
    const unitPrice = new BigNumber(commonRows[0].unit_price);
    const verifiedPrice = calculateGlobalUnitPrice(commonTotal, commonBacked);
    if (verifiedPrice.minus(unitPrice).abs().gt("0.000000000000000000000000000001")) {
      throw new Error("The current XTU price snapshot is inconsistent");
    }
    const balanceInitial = new BigNumber(stockRows[0].balance);
    const runBalanceInitial = new BigNumber(stockRows[0].run_balance || "0");
    if (
      !unitPrice.isFinite() || !unitPrice.isGreaterThan(0) ||
      !balanceInitial.isFinite() || balanceInitial.isNegative() ||
      !runBalanceInitial.isFinite() || runBalanceInitial.isNegative()
    ) throw new Error("Invalid user stock or global unit price");

    const balanceXtu = initialAssetToXtu(balanceInitial, unitPrice);
    const runBalanceXtu = initialAssetToXtu(runBalanceInitial, unitPrice);
    const numericBalance = balanceXtu.toNumber();
    if (!Number.isFinite(numericBalance)) throw new Error("User XTU balance is outside the supported numeric range");

    const depositAddress = await getOrCreateUserDepositAddress(db, U);
    res.send({
      msg: numericBalance,
      fees: tfees,
      deposit_addr: depositAddress,
      unit_price: unitPrice.toFixed(30),
      balance_initial_asset: balanceInitial.toFixed(30),
      seller_status: Number(stockRows[0].seller_status || 0),
      run_balance: runBalanceXtu.toFixed(18),
      run_balance_initial_asset: runBalanceInitial.toFixed(30),
      seller_expires_at_ms: stockRows[0].seller_expires_at_ms == null ? null : Number(stockRows[0].seller_expires_at_ms),
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
    if (await accountApiLimitReached(res, U, "recharge_info", 10, 60_000)) return;
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
      maximum_system_funded_amount: MAX_RECHARGE_AMOUNT.toFixed(0),
      seller_funding_priority: true,
      maximum_user_stock: maxStockDefault,
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
    if (await accountApiLimitReached(res, U, "recharge_status", 30, 60_000)) return;
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
    if (await accountApiLimitReached(res, U, "set_payout_address", 3, DAY_MS)) return;
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

// Seller participation locks a fixed reference amount and contributes half of it to the seller reserve.
router.post("/app/join-system-sellers", async (req, res) => {
  const { user, pswd, tkn } = req.body || {};
  const U = normalizeUsername(user);
  const P = normalizeFormValue(pswd);
  if (!requestTokenIsValid(req, tkn, P, U)) return res.send({ msg: "not allowed" });
  try {
    const passwordState = await getUserActivityPasswordState(U, P);
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
        "SELECT id FROM global_disbursement_runs WHERE status IN ('queued','staging','settling','manual_review') ORDER BY id DESC LIMIT 1 FOR UPDATE",
      );
      if (activeGlobalRuns.length) return { msg: "not allowed", reason: "global_disbursement_in_progress" };
      const unitPrice = new BigNumber(common.unit_price);
      const [authRows] = await tx.query(
        "SELECT status,consec_failed_auth,password_temp_expires_at_ms FROM auths WHERE username=? LIMIT 1 FOR UPDATE",
        [U],
      );
      if (!authRows.length || Number(authRows[0].status) <= 0) return { msg: "not allowed" };
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

      // A threshold crossing must be applied synchronously before seller eligibility is checked.
      await triggerUserPriceThresholdTx(tx, U, unitPrice);
      const [priceStateRows] = await tx.query(
        `SELECT cycle_number,status FROM user_price_state WHERE username=? LIMIT 1 FOR UPDATE`, [U],
      );
      const thresholdReached = priceStateRows.length > 0 && priceStateRows[0].status === "paused";
      const eligibility = validateSellerJoin(stockRows[0].balance, unitPrice, thresholdReached);
      if (!eligibility.eligible) {
        return { msg: "not allowed", reason: eligibility.reason };
      }
      const priceCycleNumber = Number(priceStateRows[0].cycle_number);
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
        `SELECT payout_address,account_status FROM users_usdt_deposit_wallets
         WHERE username=? LIMIT 1 FOR UPDATE`, [U],
      );
      const payoutAddress = walletRows[0]?.payout_address || "";
      if (
        !walletRows.length || walletRows[0].account_status !== "active" ||
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
          unitPrice.toFixed(30),
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
          unitPrice.toFixed(30),
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
        `Committed seller reserve (50%): ${eligibility.reservedInitialAsset.multipliedBy(unitPrice).toFixed(8)} XTU`,
        `Valuation price locked: ${unitPrice.toFixed(12)} XTU per initial asset`,
        `Price cycle: ${priceCycleNumber}`,
        `Expires (UTC): ${new Date(expiresAt).toISOString()}`,
        "Activation is not counted as a P2P sale toward the 50% threshold requirement.",
        "Status: ACTIVE",
      ].join("\n"));
      return {
        msg: "ok",
        campaign_id: String(campaignResult.insertId),
        seller_status: 1,
        run_balance: eligibility.runBalanceXtu.toFixed(18),
        run_balance_initial_asset: eligibility.runBalanceInitial.toFixed(30),
        reserved_units: eligibility.reservedInitialAsset.multipliedBy(unitPrice).toFixed(18),
        reserved_initial_asset: eligibility.reservedInitialAsset.toFixed(30),
        unit_price: unitPrice.toFixed(30),
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
  if (!requestTokenIsValid(req, tkn, P, U)) return res.send({ msg: "not allowed" });
  try {
    const passwordState = await getUserActivityPasswordState(U, P);
    if (passwordState === "not_allowed") return res.send({ auth: "not allowed" });
    if (passwordState !== "ok") return res.send({ msg: "not allowed" });
    if (await accountApiLimitReached(res, U, "cancel_system_sellers", 3, DAY_MS)) return;
    const result = await withTransaction(async (tx) => {
      const [authRows] = await tx.query(
        "SELECT status,consec_failed_auth,password_temp_expires_at_ms FROM auths WHERE username=? LIMIT 1 FOR UPDATE",
        [U],
      );
      if (!authRows.length || Number(authRows[0].status) <= 0) return { msg: "not allowed" };
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
  if (!requestTokenIsValid(req, tkn, P, U)) {
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

    // Selling to OneX is an individual disbursement. The amount supplied by
    // the app is the gross XTU amount to convert at the locked global price.
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
        "SELECT id FROM global_disbursement_runs WHERE status IN ('queued','staging','settling','manual_review') ORDER BY id DESC LIMIT 1 FOR UPDATE",
      );
      if (activeGlobalRuns.length) return { transf: "global disbursement in progress" };

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

      // P2P requests are public XTU amounts; every stored balance and activity
      // amount is in initial assets and uses the same frozen global price.
      const requestedInitialAsset = xtuToInitialAsset(requestedAmount, unitPrice);
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

      // Preserve any threshold already reached before this transfer. The recipient
      // is also checked against their pre-transfer balance before their A/B basis resets.
      await triggerUserPriceThresholdTx(tx, S, unitPrice);
      await triggerUserPriceThresholdTx(tx, D, unitPrice);

      const futureSenderBalanceInitial = senderBalanceInitial.minus(requestedInitialAsset);
      const futureDestinationBalanceInitial = destinationBalanceInitial.plus(recipientCreditInitial);
      const maxStockXtu = new BigNumber(maxStockDefault);
      if (
        !recipientCreditInitial.isFinite() || !recipientCreditInitial.isGreaterThan(0) ||
        !futureSenderBalanceInitial.isFinite() || futureSenderBalanceInitial.isNegative() ||
        !futureDestinationBalanceInitial.isFinite() || futureDestinationBalanceInitial.isNegative() ||
        !maxStockXtu.isFinite() || !maxStockXtu.isGreaterThan(0)
      ) throw new Error("Invalid calculated P2P initial-asset amounts");
      if (futureSenderBalanceInitial.isNegative()) return { transf: "insufficient balance" };
      if (futureDestinationBalanceInitial.multipliedBy(unitPrice).gt(maxStockXtu)) {
        return { transf: "unsupported" };
      }

      const feesXtu = feesInitialAsset.multipliedBy(unitPrice);
      const newTotalUnitsPrice = lastTotal.plus(feesXtu);
      const newBackedUnits = backedUnits.plus(feesInitialAsset);
      const newTotalTfees = new BigNumber(common.total_tfees || "0").plus(feesInitialAsset);
      const [date, time] = getDate();
      const reference = createFinancialReference(`P2P${S}`);

      await tx.query(
        `INSERT INTO activities(sender,receiver,type,amount,unit_price,fees,reference,record_date,record_time)
         VALUES(?,?,?,?,?,?,?,?,?)`,
        [
          S,
          D,
          1,
          recipientCreditInitial.toFixed(30),
          unitPrice.toFixed(30),
          feesInitialAsset.toFixed(30),
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
      await insertCommonSnapshotTx(tx, common, {
        total_units_price: newTotalUnitsPrice.toFixed(30),
        backed_units: newBackedUnits.toFixed(30),
        inactive_init_asset: inactiveInitialAssets.toFixed(30),
        total_tfees: newTotalTfees.toFixed(30),
      }, date, time);
      const resultingPrice = calculateGlobalUnitPrice(newTotalUnitsPrice, newBackedUnits);
      // Only completed outgoing P2P transfers count toward the 50% sale requirement.
      await recordUserP2PSaleTx(tx, S, requestedInitialAsset, resultingPrice, tfees);
      // Incoming P2P value also resets the recipient's A/B reference basis.
      await resetUserPriceBasisTx(tx, D, resultingPrice, tfees);
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
          `Amount debited: ${requestedAmount.toFixed(8)} XTU`,
          "The recipient pays the transfer fee.",
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
          `Amount received after fee: ${recipientCreditInitial.multipliedBy(unitPrice).toFixed(8)} XTU`,
          `Transfer fee: ${feesXtu.toFixed(8)} XTU`,
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

// Exceptional administrative credit of a support-held recharge batch.
// Normal weekly cooldown, 300 XTU stock cap and common reserve checks remain enforced.
// The administrator may bypass the automatic 12 BSC-USD minimum; the 140 BSC-USD system-funded cap remains enforced.
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

    const grossAmount = new BigNumber(snapshot.total_amount);
    if (!grossAmount.isFinite() || !grossAmount.isGreaterThan(0)) {
      return res.send({ transf: "invalid refund amount" });
    }
    const grossRaw = grossAmount.shiftedBy(18);
    if (!grossRaw.isInteger() || grossRaw.isLessThanOrEqualTo(0)) {
      return res.send({ transf: "invalid refund amount" });
    }
    const liquidityEstimate = await checkTreasuryLiquidity(grossRaw.toFixed(0));
    const bscFeeRecovery = new BigNumber(liquidityEstimate.estimatedFeeUsd || "0");
    const amount = grossAmount.minus(bscFeeRecovery);
    if (!amount.isFinite() || amount.isLessThan(10)) {
      return res.send({ transf: "minimum net refund is 10 BSC-USD", gross_amount: grossAmount.toFixed(18), gas_fee_estimated: bscFeeRecovery.toFixed(18) });
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
         (username,batch_id,payout_address,amount,gross_amount,fee_amount,amount_raw,estimated_fee_bnb,estimated_fee_usd,bnb_usd_price,reference,status,created_at_ms,updated_at_ms)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,'queued',?,?)`,
        [U, batchId, snapshot.payout_address, amount.toFixed(18), grossAmount.toFixed(18), bscFeeRecovery.toFixed(18), amountRaw,
          liquidity.estimatedFeeBnb || "0", bscFeeRecovery.toFixed(18), liquidity.bnbUsdPrice || "0", reference, now, now],
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
         VALUES('configured_admin',?,?,'refund_queued',?,?,?, ?,NULL,?,?)`,
        [U, batchId, grossAmount.toFixed(18), bscFeeRecovery.toFixed(18), amount.toFixed(18), snapshot.payout_address, resolutionReason, now],
      );
      await queueTelegramMessageTx(
        tx,
        U,
        `refund:${refundInsert.insertId}:queued`,
        [
          "OneX Refund Update",
          "Your BSC-USD refund has been accepted and queued for processing.",
          `Gross amount: ${grossAmount.toFixed(8)} BSC-USD`,
          `BSC gas recovery: ${bscFeeRecovery.toFixed(8)} BSC-USD`,
          `Net refund: ${amount.toFixed(8)} BSC-USD`,
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
        "SELECT balance FROM users_stock WHERE username=? LIMIT 1 FOR UPDATE", [username],
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
  if (!requestTokenIsValid(req, tkn, P1, U)) {
    return res.send({ auth: "forbidden request" });
  }
  if (!P2 || Buffer.byteLength(P2, "utf8") > 4096) {
    return res.status(400).send({ auth: "invalid password" });
  }

  try {
    // Perform Argon2 work before opening a transaction so account rows are not locked while hashing.
    const snapshotRows = await db.queryAsync(
      `SELECT password,password_temp_expires_at_ms,consec_failed_auth
       FROM auths WHERE username=? LIMIT 1`,
      [U],
    );
    if (!snapshotRows.length) return res.send({ auth: "incorrect" });

    const successEvents = await db.queryAsync(
      `SELECT id FROM account_security_events
       WHERE username=? AND action='password_change' AND outcome='successful' AND created_at_ms>=?
       LIMIT 1`,
      [U, String(Date.now() - DAY_MS)],
    );
    if (successEvents.length) return res.send({ auth: "limit reached" });

    const snapshot = snapshotRows[0];
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

    const passwordMatches = await verifySecret(snapshot.password, P1);
    const samePassword = P2 === P1;
    const passwordHash = passwordMatches && !samePassword ? await hashSecret(P2) : null;

    const result = await withTransaction(async (tx) => {
      const now = Date.now();
      const [rows] = await tx.query(
        `SELECT password,password_temp_expires_at_ms,consec_failed_auth
         FROM auths WHERE username=? LIMIT 1 FOR UPDATE`,
        [U],
      );
      if (!rows.length) return { auth: "incorrect" };

      await lockAccountSecurityActionTx(tx, U, "password_change");
      const counts = await getRecentAccountSecurityEventsTx(tx, U, "password_change", now);
      const actionDecision = evaluateAccountActionLimit("password_change", counts);
      if (!actionDecision.allowed) return { auth: "limit reached" };

      const current = rows[0];
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
      return { auth: "updated", recovery_completed: isRecoveryPassword };
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
  if (!requestTokenIsValid(req, tkn, P, U)) return res.send({ auth: "forbidden request" });
  try {
    const passwordState = await getUserActivityPasswordState(U, P);
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
         WHERE status IN ('queued','staging','settling','manual_review')
         ORDER BY id DESC LIMIT 1 FOR UPDATE`,
      );
      if (activeGlobalRuns.length) return { auth: "global_disbursement_in_progress" };

      const [authRows] = await tx.query(
        "SELECT username,consec_failed_auth,password_temp_expires_at_ms FROM auths WHERE username=? FOR UPDATE",
        [U],
      );
      if (!authRows.length) return { auth: "error" };
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
      if (pendingBatches.length || pendingEvents.length || pendingRefunds.length) return { auth: "failed, recharge pending" };
      if (
        Number(stockRows[0].seller_status || 0) !== 0 || sellerCampaignRows.length ||
        sellerLotRows.length || sellerPayoutRows.length
      ) return { auth: "failed, seller reserve pending" };

      // Keep the deposit address reserved forever; remove personal account data and disable payout.
      await tx.query(
        `UPDATE users_usdt_deposit_wallets
         SET account_status='deleted',payout_address=NULL WHERE username=?`, [U],
      );
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
  if (!requestTokenIsValid(req, tkn, P, U)) {
    return res.send({ auth: "forbidden request" });
  }
  if (!S || Buffer.byteLength(S, "utf8") > 4096) {
    return res.status(400).send({ auth: "invalid seed" });
  }

  try {
    // Verify and hash outside the transaction to keep MySQL row locks short-lived.
    const snapshotRows = await db.queryAsync(
      `SELECT password,consec_failed_auth,password_temp_expires_at_ms
       FROM auths WHERE username=? LIMIT 1`,
      [U],
    );
    if (!snapshotRows.length) return res.send({ auth: "incorrect" });

    const successEvents = await db.queryAsync(
      `SELECT id FROM account_security_events
       WHERE username=? AND action='seed_change' AND outcome='successful' AND created_at_ms>=?
       LIMIT 1`,
      [U, String(Date.now() - DAY_MS)],
    );
    if (successEvents.length) return res.send({ auth: "limit reached" });

    const snapshot = snapshotRows[0];
    if (isPasswordProtectedActivityLocked({
      failedCount: Number(snapshot.consec_failed_auth || 0),
      temporaryPasswordExpiresAtMs: snapshot.password_temp_expires_at_ms,
    })) return res.send({ auth: "not allowed" });

    const passwordMatches = await verifySecret(snapshot.password, P);
    const seedHash = passwordMatches ? await hashSecret(S) : null;

    const result = await withTransaction(async (tx) => {
      const now = Date.now();
      const [rows] = await tx.query(
        `SELECT password,consec_failed_auth,password_temp_expires_at_ms
         FROM auths WHERE username=? LIMIT 1 FOR UPDATE`,
        [U],
      );
      if (!rows.length) return { auth: "incorrect" };

      await lockAccountSecurityActionTx(tx, U, "seed_change");
      const counts = await getRecentAccountSecurityEventsTx(tx, U, "seed_change", now);
      const actionDecision = evaluateAccountActionLimit("seed_change", counts);
      if (!actionDecision.allowed) return { auth: "limit reached" };

      const current = rows[0];
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
      return { auth: "updated" };
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
  const { pswd, pin, reason, decision_reference } = req.body || {};
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
  if (
    triggerReason.length < 20 || triggerReason.length > 2000 ||
    !/^[A-Za-z0-9._:/-]{6,128}$/.test(decisionReference)
  ) return res.status(400).send({ error: "invalid decision details" });

  const treasuryAddress = String(process.env.USDT_BEP20_TREASURY_ADDRESS || "").trim();
  if (!process.env.BSC_RPC_URL || !isEvmAddress(treasuryAddress) || /^0x0{40}$/i.test(treasuryAddress)) {
    return res.status(503).send({ error: "BSC treasury configuration is incomplete" });
  }

  try {
    const result = await withTransaction(async (tx) => {
      const [commonLockRows] = await tx.query(
        "SELECT lock_name FROM system_locks WHERE lock_name='common_state' FOR UPDATE",
      );
      if (!commonLockRows.length) throw new Error("The common-state lock row has not been initialized");
      const common = await getLatestCommonTx(tx, true);

      const [existingRunRows] = await tx.query(
        `SELECT id,status FROM global_disbursement_runs
         WHERE status IN ('queued','staging','settling','manual_review')
         ORDER BY id DESC LIMIT 1 FOR UPDATE`,
      );
      if (existingRunRows.length) {
        return { auth: "global_disbursement_already_active", run_id: String(existingRunRows[0].id), status: existingRunRows[0].status };
      }

      const [individualRows] = await tx.query(
        `SELECT id FROM users_usdt_disbursements
         WHERE status IN ('queued','signed','submitted','manual_review')
         LIMIT 1 FOR UPDATE`,
      );
      if (individualRows.length) return { auth: "individual_disbursements_pending" };

      const [sellerCampaignRows] = await tx.query(
        `SELECT id FROM users_seller_campaigns
         WHERE status IN ('active','cancel_requested') LIMIT 1 FOR UPDATE`,
      );
      const [sellerPayoutRows] = await tx.query(
        `SELECT id FROM users_usdt_seller_payouts
         WHERE status IN ('queued','signed','submitted','manual_review') LIMIT 1 FOR UPDATE`,
      );
      const [sellerReserveRows] = await tx.query(
        "SELECT remaining_initial_asset FROM users_seller_reserve_lots WHERE status='active' AND remaining_initial_asset>0 LIMIT 1 FOR UPDATE",
      );
      const [sellerPendingLotRows] = await tx.query(
        `SELECT id FROM users_seller_reserve_lots
         WHERE payout_pending_initial_asset>payout_reserved_initial_asset
            OR payout_reserved_initial_asset>paid_initial_asset
         LIMIT 1 FOR UPDATE`,
      );
      const [sellerAllocationRows] = await tx.query(
        "SELECT id FROM users_seller_payout_allocations WHERE status='reserved' LIMIT 1 FOR UPDATE",
      );
      const sellerReserve = new BigNumber(common.sellers_res || "0");
      const totalRunBalance = new BigNumber(common.total_run_balance || "0");
      if (
        sellerCampaignRows.length || sellerPayoutRows.length || sellerReserveRows.length ||
        sellerPendingLotRows.length || sellerAllocationRows.length ||
        !sellerReserve.isFinite() || sellerReserve.isNegative() || !sellerReserve.isZero() ||
        !totalRunBalance.isFinite() || totalRunBalance.isNegative() || !totalRunBalance.isZero()
      ) return { auth: "seller_campaigns_or_reserves_pending" };

      const [refundRows] = await tx.query(
        `SELECT id FROM users_usdt_refunds
         WHERE status IN ('queued','signed','submitted','manual_review') LIMIT 1 FOR UPDATE`,
      );
      if (refundRows.length) return { auth: "recharge_refunds_pending" };

      const [rechargeRows] = await tx.query(
        `SELECT id FROM users_usdt_deposit_batches
         WHERE status IN ('collecting','batched','ready','finalizing','pending_weekly','pending_reserve','pending_support','refund_queued')
         LIMIT 1 FOR UPDATE`,
      );
      if (rechargeRows.length) return { auth: "recharge_batches_pending" };

      const [userSnapshotRows] = await tx.query(
        `SELECT COALESCE(MAX(id),0) AS max_id,
                SUM(CASE WHEN username<>? THEN 1 ELSE 0 END) AS total_users,
                COALESCE(SUM(CASE WHEN username<>? THEN balance ELSE 0 END),0) AS total_initial_asset,
                COALESCE(SUM(CASE WHEN username<>? AND balance<0 THEN 1 ELSE 0 END),0) AS negative_balance_count
         FROM users_stock`,
        [OneX, OneX, OneX],
      );
      const maxUserStockId = String(userSnapshotRows[0]?.max_id || 0);
      const totalUsers = Number(userSnapshotRows[0]?.total_users || 0);
      const plannedTotalInitialAsset = new BigNumber(userSnapshotRows[0]?.total_initial_asset || "0");
      const negativeBalanceCount = Number(userSnapshotRows[0]?.negative_balance_count || 0);
      if (
        !Number.isSafeInteger(totalUsers) || totalUsers < 1 || !/^\d+$/.test(maxUserStockId) ||
        !plannedTotalInitialAsset.isFinite() || !plannedTotalInitialAsset.isGreaterThan(0) ||
        !Number.isSafeInteger(negativeBalanceCount) || negativeBalanceCount !== 0
      ) {
        return { auth: "no_valid_account_balances_to_disburse" };
      }
      const snapshotPrice = new BigNumber(common.unit_price);
      const snapshotTotalUnitsPrice = new BigNumber(common.total_units_price);
      if (!snapshotPrice.isFinite() || !snapshotPrice.isGreaterThan(0) ||
          !snapshotTotalUnitsPrice.isFinite() || !snapshotTotalUnitsPrice.isGreaterThan(0)) {
        throw new Error("The global price or total stock-value snapshot is invalid");
      }
      const capacity = validateGlobalDisbursementCapacity(
        snapshotTotalUnitsPrice, snapshotPrice, plannedTotalInitialAsset,
      );
      if (!capacity.available) {
        return {
          auth: "global_liability_exceeds_stock_value",
          planned_gross_liability: capacity.grossLiability.toFixed(18),
          snapshot_total_units_price: snapshotTotalUnitsPrice.toFixed(18),
        };
      }

      const now = String(Date.now());
      const [insertResult] = await tx.query(
        `INSERT INTO global_disbursement_runs
         (status,trigger_reason,decision_reference,snapshot_unit_price,snapshot_total_units_price,
          planned_total_initial_asset,last_user_stock_id,max_user_stock_id,total_users,processed_users,
          total_gross_initial_asset,total_paid_bsc_usd,last_error,created_at_ms,updated_at_ms)
         VALUES('queued',?,?,?,?,?,0,?,?,0,0,0,NULL,?,?)`,
        [
          triggerReason,
          decisionReference,
          snapshotPrice.toFixed(30),
          snapshotTotalUnitsPrice.toFixed(30),
          plannedTotalInitialAsset.toFixed(30),
          maxUserStockId,
          String(totalUsers),
          now,
          now,
        ],
      );
      return {
        auth: "global_disbursement_queued",
        run_id: String(insertResult.insertId),
        total_users: totalUsers,
        planned_total_initial_asset: plannedTotalInitialAsset.toFixed(30),
        planned_gross_liability: capacity.grossLiability.toFixed(18),
        expected_remaining_stock_value: capacity.remainingValue.toFixed(18),
        max_user_stock_id: maxUserStockId,
        snapshot_unit_price: snapshotPrice.toFixed(30),
        snapshot_total_units_price: snapshotTotalUnitsPrice.toFixed(30),
        decision_reference: decisionReference,
      };
    });
    return res.send(result);
  } catch (error) {
    console.error("Global disbursement launch failed:", error.message);
    return res.status(500).send({ error: "global disbursement launch failed" });
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
      if (!runRows.length || runRows[0].status !== "manual_review") {
        return { auth: "global_run_not_in_manual_review" };
      }

      const [reviewRows] = await tx.query(
        `SELECT id,username,tx_hash,raw_tx,gross_initial_asset,sold_initial_asset,balance_after_reservation
         FROM users_usdt_disbursements
         WHERE global_run_id=? AND status='manual_review'
         ORDER BY id ASC FOR UPDATE`,
        [runId],
      );
      for (const row of reviewRows) {
        if (row.tx_hash || row.raw_tx || !new BigNumber(row.gross_initial_asset).isZero() || !new BigNumber(row.sold_initial_asset).isZero()) {
          return { auth: "on_chain_or_reserved_payment_requires_reconciliation", disbursement_id: String(row.id) };
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
        await tx.query(
          `UPDATE users_usdt_disbursements
           SET status='failed',last_error=?,updated_at_ms=? WHERE id=? AND status='manual_review'`,
          [`Admin review released without payment; balance remains available. ${resolutionReason}`, now, row.id],
        );
        await tx.query(
          `INSERT INTO admin_payment_resolutions
           (admin_username,username,batch_id,action,initial_asset_amount,gross_amount,fee_amount,net_amount,
            payout_address,tx_hash,reason,created_at_ms)
           VALUES('configured_admin',?,NULL,'global_review_released',0,0,0,0,NULL,NULL,?,?)`,
          [row.username, resolutionReason, now],
        );
      }
      await tx.query(
        `UPDATE global_disbursement_runs SET status='resolved',last_error=?,completed_at_ms=?,updated_at_ms=?
         WHERE id=? AND status='manual_review'`,
        [`Manual review released by administration: ${resolutionReason}`, now, now, runId],
      );
      return {
        auth: "global_run_review_resolved",
        run_id: runId,
        released_manual_review_accounts: reviewRows.length,
        note: "No payment was issued for released review rows; their current balances remain available for a later run.",
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

  const U = normalizeUsername(user);
  const stat = Number(status);
  if (!U || !Number.isSafeInteger(stat)) return res.status(400).send({ error: "invalid status or user" });

  try {
    await db.queryAsync("UPDATE auths SET status=? WHERE username=?", [
      stat,
      U,
    ]);
    res.send({ account: "updated" });
  } catch {
    res.send({ error: "error" });
  }
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

// Apply an administrator-approved credit to one user's stock through the
// normal recharge allocation rules. The automatic minimum is bypassed, while
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
        { enforceRechargeRange: false },
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
        "SELECT id FROM global_disbursement_runs WHERE status IN ('queued','staging','settling','manual_review') ORDER BY id DESC LIMIT 1 FOR UPDATE",
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
