const express = require("express");
const fs = require("fs");
const geoip = require("geoip-country");
const nodemailer = require("nodemailer");
const BigNumber = require("bignumber.js");
const { deriveUnitPrice, deriveInitAsset, calculateTopUpReserveAllocation } = require("./stock-accounting");
const {
  MIN_RECHARGE_AMOUNT,
  MAX_RECHARGE_AMOUNT,
  MAX_DEFAULT_STOCK,
  getLastOnexRecharge,
  assessRechargeCooldown,
  formatUtcRecordDateTime,
} = require("./recharge-policy");
const {
  DISBURSEMENT_COOLDOWN_MS,
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
  createTxId,
  getUserPrefixName,
  transliterateUserText,
  createUserSuffixName,
  hashSecret,
  verifySecret,
} = require("./utils");

const {
  initializePaymentProvider,
  createPaymentRequest,
  getOrCreateUserDepositAddress,
  getPaymentStatus,
  startPaymentWatcher: startUsdtPaymentWatcher,
  getPaymentPublicConfig,
  isAddress: isEvmAddress,
} = require("./pay");
const { startDepositSweeper } = require("./sweep");

const router = express.Router();

function normalizeFormValue(value) {
  return typeof value === "string" ? value.replaceAll(" ", "+") : "";
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

async function verifyUserPassword(username, submittedPassword) {
  if (!username || typeof submittedPassword !== "string") return false;
  const rows = await db.queryAsync(
    "SELECT password FROM auths WHERE username=? LIMIT 1",
    [username],
  );
  if (rows.length === 0) return false;
  return verifySecret(rows[0].password, submittedPassword);
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
  const newInitAsset = deriveInitAsset(newBalance, lastPrice);

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
    "SELECT status,password FROM auths WHERE username=? FOR UPDATE",
    [username],
  );
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
  const [monthlyRows] = await tx.query(
    `SELECT id,status FROM users_usdt_disbursements
     WHERE username=? AND CAST(created_at_ms AS UNSIGNED)>=?
     ORDER BY id DESC LIMIT 1 FOR UPDATE`,
    [username, String(now - DISBURSEMENT_COOLDOWN_MS)],
  );
  if (monthlyRows.length > 0) {
    return { transf: "monthly disbursement limit reached" };
  }

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

  const reference = createTxId(`DISB${username}`);
  const amountRaw = calculation.amountRaw;
  const [date, time] = getDate();
  await tx.query(
    `INSERT INTO users_usdt_disbursements
     (username,payout_address,requested_amount,payout_amount,amount_raw,gross_balance,gross_init_asset,
      sold_init_asset,fee_amount,fee_init_asset,price_value,reference,status,created_at_ms,updated_at_ms)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,'queued',?,?)`,
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

  return {
    transf: "processing",
    disbursement_id: String(idRows[0].id),
    payout_amount: calculation.payoutAmount.toFixed(18),
    payout_address: payoutAddress,
    message: "La demande est enregistrée. Le paiement BSC-USD sera envoyé après validation blockchain.",
  };
}

const RECHARGE_HOLD_REASON_TEXT = {
  no_active_request: "Aucune commande de recharge valide n'était ouverte au moment du transfert.",
  late_payment: "Le transfert a été reçu après l'expiration du délai d'une heure.",
  request_already_used: "La commande avait déjà été utilisée ou clôturée par un autre transfert.",
  below_minimum: "Le montant reçu est inférieur au minimum autorisé de 70 BSC-USD.",
  above_maximum: "Le montant reçu dépasse le maximum autorisé de 140 BSC-USD.",
  amount_mismatch: "Le montant reçu ne correspond pas au montant indiqué dans la commande de recharge.",
  weekly_limit: "Une recharge OneX a déjà été créditée sur ce compte au cours des sept derniers jours.",
  maximum_user_balance: "Le crédit ferait dépasser le solde maximal autorisé de 300 One-Val.",
  account_unavailable: "Le compte OneX n'est pas actif ou n'est plus disponible pour recevoir un crédit.",
  system_reserve: "La réserve système ne permet pas actuellement de créditer automatiquement ce montant.",
};

function getReasonText(reasonCodes) {
  return reasonCodes
    .map((code) => RECHARGE_HOLD_REASON_TEXT[code] || "Le transfert nécessite une vérification manuelle.")
    .filter(Boolean);
}

function safeJson(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return "{}";
  }
}

async function processConfirmedUsdtPayment(event) {
  const amountValue = new BigNumber(event.amount);
  if (!amountValue.isFinite() || !amountValue.isGreaterThan(0)) {
    throw new Error("The detected BEP-20 transfer amount is invalid.");
  }

  return withTransaction(async (tx) => {
    // Read the mapping first without a lock, then acquire user/account locks in
    // the same order as createPaymentRequest and administrative top-ups.
    const [mappedWalletRows] = await tx.query(
      `SELECT id,username,wallet_address,payout_address
       FROM users_usdt_deposit_wallets
       WHERE id=? AND wallet_address=?
       LIMIT 1`,
      [event.depositWalletId, event.depositAddress],
    );
    if (mappedWalletRows.length === 0) {
      throw new Error("The confirmed transfer does not match a registered OneX deposit wallet.");
    }

    const username = mappedWalletRows[0].username;
    const [accountRows] = await tx.query(
      "SELECT status FROM auths WHERE username=? LIMIT 1 FOR UPDATE",
      [username],
    );
    const [stockRows] = await tx.query(
      "SELECT balance FROM users_stock WHERE username=? LIMIT 1 FOR UPDATE",
      [username],
    );
    const lastRecharge = await getLastOnexRecharge(tx, username, OneX);
    const cooldown = assessRechargeCooldown(lastRecharge, event.blockTimestampMs);

    const [walletRows] = await tx.query(
      `SELECT id,username,wallet_address,payout_address
       FROM users_usdt_deposit_wallets
       WHERE id=? AND wallet_address=? AND username=?
       LIMIT 1 FOR UPDATE`,
      [event.depositWalletId, event.depositAddress, username],
    );
    if (walletRows.length === 0) {
      throw new Error("The OneX deposit-wallet mapping changed during payment processing.");
    }

    const now = Date.now();
    const [eventInsert] = await tx.query(
      `INSERT IGNORE INTO users_usdt_transfer_events
       (username,deposit_wallet_id,deposit_address,from_address,amount,amount_raw,tx_hash,log_index,
        block_number,block_hash,block_timestamp_ms,request_id,status,reason_codes,email_status,
        email_attempts,email_last_attempt_ms,created_at_ms)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,NULL,'processing',NULL,'not_required',0,NULL,?)`,
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
        String(now),
      ],
    );
    if (eventInsert.affectedRows !== 1) {
      return { duplicate: true };
    }

    const [requestRows] = await tx.query(
      `SELECT id,requested_amount,status,created_at_ms,expires_at_ms
       FROM users_usdt_tx
       WHERE username=? AND tx_addr=? AND CAST(created_at_ms AS UNSIGNED)<=?
       ORDER BY CAST(created_at_ms AS UNSIGNED) DESC,id DESC
       LIMIT 1 FOR UPDATE`,
      [username, event.depositAddress, String(event.blockTimestampMs)],
    );
    const request = requestRows[0] || null;
    const reasonCodes = [];

    if (!request) {
      reasonCodes.push("no_active_request");
    } else {
      const createdAt = Number(request.created_at_ms);
      const expiresAt = Number(request.expires_at_ms);
      if (
        !Number.isFinite(createdAt) ||
        !Number.isFinite(expiresAt) ||
        event.blockTimestampMs < createdAt
      ) {
        reasonCodes.push("no_active_request");
      } else if (event.blockTimestampMs > expiresAt) {
        reasonCodes.push("late_payment");
      } else if (!['pending', 'expired'].includes(String(request.status))) {
        reasonCodes.push("request_already_used");
      }
    }

    if (amountValue.isLessThan(MIN_RECHARGE_AMOUNT)) {
      reasonCodes.push("below_minimum");
    }
    if (amountValue.isGreaterThan(MAX_RECHARGE_AMOUNT)) {
      reasonCodes.push("above_maximum");
    }
    if (request && !amountValue.isEqualTo(new BigNumber(request.requested_amount))) {
      reasonCodes.push("amount_mismatch");
    }

    if (!cooldown.allowed) reasonCodes.push("weekly_limit");

    if (
      !accountRows.length ||
      Number(accountRows[0].status) <= 0 ||
      !stockRows.length
    ) {
      reasonCodes.push("account_unavailable");
    } else {
      const currentBalance = new BigNumber(stockRows[0].balance);
      if (
        !currentBalance.isFinite() ||
        currentBalance.isNegative() ||
        currentBalance.plus(amountValue).isGreaterThan(new BigNumber(MAX_DEFAULT_STOCK))
      ) {
        reasonCodes.push("maximum_user_balance");
      }
    }

    const distinctReasons = [...new Set(reasonCodes)];
    const [recordDate, recordTime] = formatUtcRecordDateTime(event.blockTimestampMs);
    const reference = createTxId(OneX);
    let creditResult = null;

    if (distinctReasons.length === 0) {
      creditResult = await applyUserTopUp(
        tx,
        username,
        amountValue,
        reference,
        recordDate,
        recordTime,
        event.blockTimestampMs,
      );
      if (creditResult.transf !== "sent") {
        if (creditResult.error === "weekly recharge limit reached") {
          distinctReasons.push("weekly_limit");
        } else if (creditResult.error === "maximum user balance exceeded") {
          distinctReasons.push("maximum_user_balance");
        } else if (creditResult.error === "user not found") {
          distinctReasons.push("account_unavailable");
        } else if (creditResult.limit) {
          distinctReasons.push("system_reserve");
        } else {
          throw new Error(`Unexpected automatic recharge credit result: ${safeJson(creditResult)}`);
        }
      }
    }

    if (distinctReasons.length === 0 && creditResult?.transf === "sent") {
      // Only a direct ERC-20 transfer initiated by the logged sender can seed
      // the user's BSC payout destination. It is never overwritten automatically.
      if (event.directWalletTransfer) {
        await tx.query(
          `UPDATE users_usdt_deposit_wallets
           SET payout_address=COALESCE(NULLIF(payout_address,''),?)
           WHERE id=? AND username=?`,
          [event.fromAddress, event.depositWalletId, username],
        );
      }

      const response = {
        transf: "sent",
        amount: amountValue.toFixed(18),
        tx_hash: event.txHash,
        deposit_address: event.depositAddress,
      };
      await tx.query(
        `UPDATE users_usdt_transfer_events
         SET request_id=?,status='credited',reason_codes=NULL,email_status='not_required'
         WHERE tx_hash=? AND log_index=?`,
        [request ? request.id : null, event.txHash, event.logIndex],
      );
      if (request) {
        await tx.query(
          `UPDATE users_usdt_tx
           SET amount=?,tx_hash=?,status='completed',pending_username=NULL,pending_tx_addr=NULL,record_date=?,record_time=?
           WHERE id=?`,
          [amountValue.toFixed(18), event.txHash, recordDate, recordTime, request.id],
        );
        await tx.query(
          `UPDATE users_usdt_recharge_status
           SET status='completed',response_json=?,updated_at_ms=?
           WHERE request_id=? AND username=?`,
          [safeJson(response), String(now), request.id, username],
        );
      }

      // A delayed scan can confirm an older in-window payment after the user
      // has already opened a newer request. The successful credit starts the
      // seven-day cooldown, so close any other still-pending request atomically.
      const cancellationResponse = {
        transf: "cancelled",
        message: "Une recharge précédente a été confirmée. Le délai de sept jours est maintenant appliqué.",
      };
      await tx.query(
        `UPDATE users_usdt_tx
         SET status='cancelled',pending_username=NULL,pending_tx_addr=NULL
         WHERE username=? AND status='pending' AND id<>?`,
        [username, request ? request.id : 0],
      );
      await tx.query(
        `UPDATE users_usdt_recharge_status s
         JOIN users_usdt_tx p ON p.id=s.request_id
         SET s.status='cancelled',s.response_json=?,s.updated_at_ms=?
         WHERE p.username=? AND p.status='cancelled' AND s.status='pending'`,
        [safeJson(cancellationResponse), String(now), username],
      );
      return { credited: true, username, amount: amountValue.toFixed(18), txHash: event.txHash };
    }

    const response = {
      transf: "pending_support",
      amount: amountValue.toFixed(18),
      tx_hash: event.txHash,
      deposit_address: event.depositAddress,
      reason_codes: distinctReasons,
      reasons: getReasonText(distinctReasons),
      message: "Le transfert a été reçu, mais il nécessite une vérification par le support OneX.",
    };
    await tx.query(
      `UPDATE users_usdt_transfer_events
       SET request_id=?,status='pending_support',reason_codes=?,email_status='pending'
       WHERE tx_hash=? AND log_index=?`,
      [request ? request.id : null, safeJson(distinctReasons), event.txHash, event.logIndex],
    );

    if (request && ["pending", "expired"].includes(String(request.status))) {
      await tx.query(
        `UPDATE users_usdt_tx
         SET amount=?,tx_hash=IF(tx_hash IS NULL,?,tx_hash),status='pending_support',
             pending_username=NULL,pending_tx_addr=NULL,record_date=?,record_time=?
         WHERE id=?`,
        [amountValue.toFixed(18), event.txHash, recordDate, recordTime, request.id],
      );
      await tx.query(
        `UPDATE users_usdt_recharge_status
         SET status='pending_support',response_json=?,updated_at_ms=?
         WHERE request_id=? AND username=?`,
        [safeJson(response), String(now), request.id, username],
      );
    }

    return {
      held: true,
      username,
      amount: amountValue.toFixed(18),
      txHash: event.txHash,
      reasonCodes: distinctReasons,
    };
  });
}

async function notifyPendingRechargeCases() {
  const now = Date.now();
  await db.queryAsync(
    `UPDATE users_usdt_transfer_events
     SET email_status=IF(email_attempts>=5,'failed','retry')
     WHERE email_status='sending' AND email_last_attempt_ms<?`,
    [String(now - 10 * 60 * 1000)],
  );

  const rows = await db.queryAsync(
    `SELECT e.id,e.username,e.deposit_address,e.from_address,e.amount,e.tx_hash,e.block_timestamp_ms,
            e.reason_codes,e.email_attempts,a.email
     FROM users_usdt_transfer_events e
     LEFT JOIN auths a ON a.username=e.username
     WHERE e.status='pending_support'
       AND (
         e.email_status='pending'
         OR (e.email_status='retry' AND e.email_last_attempt_ms<=?)
       )
       AND e.email_attempts<5
     ORDER BY e.id ASC
     LIMIT 20`,
    [String(now - 60 * 1000)],
  );

  for (const row of rows) {
    const claim = await db.queryAsync(
      `UPDATE users_usdt_transfer_events
       SET email_status='sending',email_attempts=email_attempts+1,email_last_attempt_ms=?
       WHERE id=? AND email_status IN ('pending','retry') AND email_attempts<5`,
      [String(now), row.id],
    );
    if (!claim || claim.affectedRows !== 1) continue;

    const email = String(row.email || "").trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      await db.queryAsync(
        "UPDATE users_usdt_transfer_events SET email_status='failed',email_last_error=? WHERE id=?",
        ["The user has no valid email address in auths.email.", row.id],
      );
      console.error(`Cannot notify OneX user ${row.username}: missing or invalid auths.email.`);
      continue;
    }

    let reasonCodes = [];
    try {
      reasonCodes = JSON.parse(row.reason_codes || "[]");
      if (!Array.isArray(reasonCodes)) reasonCodes = [];
    } catch {
      reasonCodes = [];
    }
    const reasons = getReasonText(reasonCodes);
    const supportEmail = String(process.env.ONEX_SUPPORT_EMAIL || SERVER_MAIL || "").trim();
    const supportPhone = String(process.env.ONEX_SUPPORT_PHONE || "").trim();
    const when = new Date(Number(row.block_timestamp_ms)).toISOString();
    const supportLines = [
      supportEmail ? `E-mail du support : ${supportEmail}` : "Répondez directement à cet e-mail pour contacter le support OneX.",
      supportPhone ? `Téléphone du support : ${supportPhone}` : "Téléphone : utilisez le numéro de contact publié dans votre application OneX.",
    ];
    const text = [
      `Bonjour ${row.username},`,
      "",
      "OneX a détecté et confirmé un transfert BSC-USD vers votre adresse de dépôt, mais ce paiement n'a pas pu être crédité automatiquement.",
      "",
      "Motif(s) exact(s) :",
      ...reasons.map((reason) => `- ${reason}`),
      "",
      `Montant reçu : ${row.amount} BSC-USD`,
      `Adresse de dépôt : ${row.deposit_address}`,
      `Adresse expéditrice observée : ${row.from_address}`,
      `Transaction BNB Smart Chain : ${row.tx_hash}`,
      `Date de confirmation : ${when}`,
      "",
      "Votre paiement est conservé dans le registre de rapprochement OneX et nécessite une vérification manuelle. Ne renvoyez pas le paiement avant d'avoir contacté le support.",
      "",
      "Veuillez contacter OneX par e-mail ou par téléphone :",
      ...supportLines,
      "",
      "Cordialement,",
      "Support OneX",
    ].join("\n");

    try {
      await transporter.sendMail({
        from: SERVER_MAIL,
        to: email,
        replyTo: supportEmail || SERVER_MAIL,
        subject: "OneX – Votre transfert BSC-USD nécessite une vérification",
        text,
      });
      await db.queryAsync(
        `UPDATE users_usdt_transfer_events
         SET email_status='sent',email_sent_at_ms=?,email_last_error=NULL
         WHERE id=?`,
        [String(Date.now()), row.id],
      );
    } catch (error) {
      await db.queryAsync(
        `UPDATE users_usdt_transfer_events
         SET email_status=IF(email_attempts>=5,'failed','retry'),email_last_error=?
         WHERE id=?`,
        [String(error.message || error).slice(0, 2000), row.id],
      );
      console.error(`Unable to send recharge hold notice to ${email}:`, error.message);
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
  console.warn("Recharge email notifications are not configured: set SERV_MAIL and SERV_MAIL_PSWD.");
}

// ----- PUBLIC GET -----
router.get("/", (_r, s) => s.redirect("/app/download-latest-apk"));

router.get("/app/privacy-terms-info", async (req, res) => {
  const file = `./${req.query.r === "terms" ? "terms" : "privacy"}_${
    req.query.l
  }.html`;
  try {
    res.send(await fs.promises.readFile(file, "utf8"));
  } catch {
    res.send("error");
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
  const U = normalizeFormValue(user);
  const P = normalizeFormValue(pswd);

  if (!requestTokenIsValid(req, tkn, P, U)) {
    return res.send({ status: "forbidden request" });
  }

  try {
    const rows = await db.queryAsync(
      "SELECT password,email FROM auths WHERE username=? LIMIT 1",
      [U],
    );
    if (rows.length === 0 || !(await verifySecret(rows[0].password, P))) {
      return res.send({ status: "error" });
    }

    await transporter.sendMail({
      from: SERVER_MAIL,
      to: SERVER_MAIL,
      subject: typeof subj === "string" ? subj : "OneX contact",
      html: `<b>From</b> ${rows[0].email} (${U})<br>${String(msg ?? "")}`,
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

  const Email = email.replaceAll(" ", "+");
  const Birth = birth.replaceAll(" ", "+");
  const Address = latinAddress.replaceAll(" ", "+");
  const Name = latinName.replaceAll(" ", "+");
  const CNI = encrypt(cni.replaceAll(" ", "+"), DB_CONFIG.password);
  const passwordValue = normalizeFormValue(pswd);
  const seedValue = normalizeFormValue(seed);
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
        "SELECT 1 FROM auths WHERE username=? LIMIT 1",
        [U],
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
      html: `<h2>Welcome,</h2>Your ID: <b>${U}</b>`,
    }).catch((mailError) => {
      console.error("Welcome email failed:", mailError);
    });

    // Send the identity documents for verification without modifying their encoded contents.
    transporter.sendMail({
      from: SERVER_MAIL,
      to: "eddy.heriniaina.rafidison@gmail.com",
      subject: "Account Verification",
      html: `${U}<br>${Name}<br>${Birth}<br>${Address}<br>${cni}`,
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
  const U = normalizeFormValue(user);
  const P = normalizeFormValue(pswd);
  const submittedSeed = normalizeFormValue(seed);
  const needsSeed = String(recon) === "0";

  if (!U || !P) return res.status(400).send({ msg: "invalid request", ua: "" });
  if (needsSeed && !requestTokenIsValid(req, tkn, P, U)) {
    return res.send({ msg: "forbidden request", ua: "" });
  }

  try {
    const rows = await db.queryAsync(
      "SELECT id,password,seed,status FROM auths WHERE username=? LIMIT 1",
      [U],
    );
    if (rows.length === 0) {
      return res.send({ msg: "incorrect password", ua: "" });
    }

    const row = rows[0];
    if (!(await verifySecret(row.password, P))) {
      return res.send({ msg: "incorrect password", ua: "" });
    }
    if (needsSeed && !(await verifySecret(row.seed, submittedSeed))) {
      return res.send({ msg: "incorrect seed", ua: "" });
    }

    const ua = req.headers["user-agent"];
    if (typeof ua !== "string") {
      return res.send({ msg: "error", ua: "" });
    }

    const encUA = encrypt(ua, P + U);
    let status = Number(row.status);
    if (status === 0) {
      await db.queryAsync("UPDATE auths SET status=1 WHERE username=?", [U]);
      status = 1;

      if (Number(row.id) <= Number(first_welcome_clients)) {
        const configuredBonus = new BigNumber(welcome_bonus);
        const maximumBonus = new BigNumber(maxStockDefault);
        if (
          !configuredBonus.isFinite() ||
          configuredBonus.isNegative() ||
          !maximumBonus.isFinite() ||
          maximumBonus.isNegative()
        ) {
          throw new Error("Invalid welcome bonus or maximum stock configuration");
        }

        // The welcome bonus is already in One-Val and cannot exceed the user stock cap.
        const welcomeBonus = BigNumber.minimum(configuredBonus, maximumBonus);
        const reference = createTxId(OneX);
        const [d, t] = getDate();
        await db.queryAsync(
          "UPDATE users_stock SET balance=?,init_asset=?,record_date=?,record_time=? WHERE username=?",
          [welcomeBonus.toFixed(), welcomeBonus.toFixed(), d, t, U],
        );
        await db.queryAsync(
          "INSERT INTO activities(sender,receiver,type,amount,unit_price,fees,reference,record_date,record_time) VALUES(?,?,?,?,?,?,?,?,?)",
          [OneX, U, 2, welcomeBonus.toFixed(), 1, 0, reference, d, t],
        );
      }
    }

    res.send({ msg: status, ua: encUA });
  } catch (error) {
    console.error("Sign-in failed:", error);
    res.send({ msg: "error", ua: "" });
  }
});

// feed
router.post("/app/feed", async (req, res) => {
  const { user, pswd, tkn } = req.body || {};
  const U = normalizeFormValue(user);
  const P = normalizeFormValue(pswd);
  if (!requestTokenIsValid(req, tkn, P, U))
    return res.send({ feed: "forbidden request" });

  try {
    const passOK = await verifyUserPassword(U, P);
    if (!passOK) return res.send({ feed: "incorrect auth" });

    const [date] = getDate();
    const notifs = await db.queryAsync(
      "SELECT * FROM notifs WHERE record_date=? ORDER BY id DESC",
      [date],
    );
    res.send({ feed: notifs });
  } catch {
    res.send({ feed: "error" });
  }
});

// user-last-stock
router.post("/app/user-last-stock", async (req, res) => {
  const { user, pswd, tkn } = req.body || {};
  const U = normalizeFormValue(user);
  const P = normalizeFormValue(pswd);
  if (!requestTokenIsValid(req, tkn, P, U))
    return res.send({ msg: "forbidden request" });

  try {
    const passOK = await verifyUserPassword(U, P);
    if (!passOK) return res.send({ msg: "error" });

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

// USDT BEP-20 recharge
router.post("/app/recharge", async (req, res) => {
  const { user, pswd, amount, tkn } = req.body || {};
  const U = normalizeFormValue(user);
  const P = normalizeFormValue(pswd);
  const requestedAmount = typeof amount === "string" ? amount.trim() : String(amount ?? "").trim();

  if (!requestTokenIsValid(req, tkn, P, U)) {
    return res.send({ msg: "not allowed" });
  }
  if (
    !/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(requestedAmount) ||
    !new BigNumber(requestedAmount).isFinite() ||
    new BigNumber(requestedAmount).isLessThan(MIN_RECHARGE_AMOUNT) ||
    new BigNumber(requestedAmount).isGreaterThan(MAX_RECHARGE_AMOUNT)
  ) {
    return res.send({ msg: "not allowed" });
  }

  try {
    if (!(await verifyUserPassword(U, P))) {
      return res.send({ msg: "not allowed" });
    }

    const paymentConfig = getPaymentPublicConfig();
    if (!paymentConfig.enabled) {
      return res.send({ msg: "not allowed" });
    }

    const request = await createPaymentRequest(db, U, requestedAmount);
    if (request.error) {
      return res.send({ msg: "not allowed" });
    }

    return res.send({ msg: "ok", ...request.response });
  } catch (error) {
    console.error("BEP-20 recharge request failed:", error);
    return res.send({ msg: "not allowed" });
  }
});

// USDT BEP-20 recharge status
router.post("/app/recharge/status", async (req, res) => {
  const { user, pswd, request_id, tkn } = req.body || {};
  const U = normalizeFormValue(user);
  const P = normalizeFormValue(pswd);
  const requestId = String(request_id ?? "");

  if (!requestTokenIsValid(req, tkn, P, U)) {
    return res.send({ transf: "forbidden request" });
  }
  if (!/^\d{1,20}$/.test(requestId)) {
    return res.status(400).send({ transf: "invalid request" });
  }

  try {
    if (!(await verifyUserPassword(U, P))) {
      return res.send({ auth: "incorrect" });
    }
    return res.send(await getPaymentStatus(db, U, requestId));
  } catch (error) {
    console.error("USDT recharge status lookup failed:", error);
    return res.send({ transf: "error" });
  }
});

// transactions-history
router.post("/app/transactions-history", async (req, res) => {
  const { user, pswd, days, tkn } = req.body || {};
  const U = normalizeFormValue(user);
  const P = normalizeFormValue(pswd);
  if (!requestTokenIsValid(req, tkn, P, U))
    return res.send({ trans: "forbidden request" });

  try {
    const passOK = await verifyUserPassword(U, P);
    if (!passOK) return res.send({ trans: "error" });

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
  const senderInput = normalizeFormValue(sender);
  const P = normalizeFormValue(pswd);
  const destinationInput = normalizeFormValue(dest);
  const amountText =
    typeof amount === "string" || typeof amount === "number"
      ? normalizeFormValue(String(amount))
      : "";

  if (!requestTokenIsValid(req, tkn, P, senderInput)) {
    return res.send({ transf: "forbidden request" });
  }

  const S = senderInput.toUpperCase();
  const D = destinationInput.toUpperCase();
  if (!S || !P || !D || !amountText || S === D) {
    return res.status(400).send({ transf: "invalid request" });
  }

  const requestedAmount = new BigNumber(amountText);
  if (!requestedAmount.isFinite() || !requestedAmount.isGreaterThan(0)) {
    return res.send({ warning: "abusive operation" });
  }

  try {
    const senderAuthRows = await db.queryAsync(
      "SELECT password FROM auths WHERE username=? LIMIT 1",
      [S],
    );
    if (
      senderAuthRows.length === 0 ||
      !(await verifySecret(senderAuthRows[0].password, P))
    ) {
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
      return res.send(result);
    }

    // P2P_ALLOWED controls user-to-user transfers only. Selling to the system
    // is governed independently by USDT_DISBURSEMENTS_ENABLED.
    if (!P2Pallowed) return res.send({ transf: "not yet allowed" });

    // The legacy P2P minimum applies only to transfers between users.
    if (requestedAmount.isLessThan(10000)) {
      return res.send({ warning: "abusive operation" });
    }

    const result = await withTransaction(async (tx) => {
      const authNames = [S, D].sort();
      const authByName = new Map();
      for (const username of authNames) {
        const [rows] = await tx.query(
          "SELECT username,status,password FROM auths WHERE username=? FOR UPDATE",
          [username],
        );
        if (rows.length > 0) authByName.set(username, rows[0]);
      }

      const senderAuth = authByName.get(S);
      const destinationAuth = authByName.get(D);
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

      const stockNames = [...new Set([S, D, OneX])].sort();
      const stockByName = new Map();
      for (const username of stockNames) {
        const [rows] = await tx.query(
          "SELECT username,balance,init_asset FROM users_stock WHERE username=? FOR UPDATE",
          [username],
        );
        if (rows.length > 0) stockByName.set(rows[0].username, rows[0]);
      }
      if (!stockByName.has(S) || !stockByName.has(D) || !stockByName.has(OneX)) {
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
      const systemStock = stockByName.get(OneX);
      const senderBalance = new BigNumber(senderStock.balance);
      const senderInitAsset = new BigNumber(senderStock.init_asset);
      const destinationBalance = new BigNumber(destinationStock.balance);
      const destinationInitAsset = new BigNumber(destinationStock.init_asset);
      const systemBalance = new BigNumber(systemStock.balance);
      const systemInitAsset = new BigNumber(systemStock.init_asset);
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
        !destinationInitAsset.isFinite() ||
        destinationInitAsset.isNegative() ||
        !systemBalance.isFinite() ||
        !systemInitAsset.isFinite() ||
        systemInitAsset.isNegative()
      ) {
        throw new Error("Invalid balances or reserve values in the database");
      }

      // P2P input amounts are One-Val; activity amounts retain the initial-asset unit.
      const amountUnits = requestedAmount.dividedBy(priceValue);
      const fees = amountUnits.multipliedBy(tfees).dividedBy(100);
      const senderFee = fees.dividedBy(2);
      const receiverFee = fees.dividedBy(2);
      const totalDebit = amountUnits.plus(senderFee);
      const receiverAmount = amountUnits.minus(receiverFee);
      const sharedFees = fees.multipliedBy(3).dividedBy(4);
      const adminFees = fees.minus(sharedFees);

      const senderStockDebit = totalDebit.multipliedBy(priceValue);
      const receiverStockCredit = receiverAmount.multipliedBy(priceValue);
      const adminStockCredit = adminFees.multipliedBy(priceValue);
      const futureSenderBalance = senderBalance.minus(senderStockDebit);
      const futureDestinationBalance = destinationBalance.plus(receiverStockCredit);
      const futureSystemBalance = systemBalance.plus(adminStockCredit);

      if (
        !fees.isFinite() ||
        fees.isNegative() ||
        !senderStockDebit.isFinite() ||
        !receiverStockCredit.isFinite() ||
        !adminStockCredit.isFinite() ||
        !futureSenderBalance.isFinite() ||
        !futureDestinationBalance.isFinite() ||
        !futureSystemBalance.isFinite()
      ) {
        throw new Error("Invalid calculated transfer amounts");
      }
      if (!receiverAmount.isFinite() || !receiverAmount.isGreaterThan(0)) {
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

      const newTotal = lastTotal.plus(sharedFees.multipliedBy(priceValue));
      const newPrice = newTotal.dividedBy(lastTotal).multipliedBy(priceValue);
      const newBackedUnits = backedUnits.plus(fees);
      const [date, time] = getDate();
      const reference = createTxId(S);

      const senderInitAssetAfter = deriveInitAsset(futureSenderBalance, priceValue);
      const destinationInitAssetAfter = deriveInitAsset(futureDestinationBalance, priceValue);
      const systemInitAssetAfter = deriveInitAsset(futureSystemBalance, priceValue);

      await tx.query(
        "INSERT INTO activities(sender,receiver,type,amount,unit_price,fees,reference,record_date,record_time) VALUES(?,?,?,?,?,?,?,?,?)",
        [
          S,
          D,
          1,
          receiverAmount.toFixed(),
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
        "UPDATE users_stock SET balance=?,init_asset=?,record_date=?,record_time=? WHERE username=?",
        [futureSystemBalance.toFixed(), systemInitAssetAfter.toFixed(), date, time, OneX],
      );
      await tx.query(
        `INSERT INTO common(total_units_price,unit_price,backed_units,inactive_init_asset,record_date,record_time)
         VALUES(?,?,?,?,?,?)`,
        [newTotal.toFixed(), newPrice.toFixed(), newBackedUnits.toFixed(), inactiveInitAsset.toFixed(), date, time],
      );

      return { transf: "sent" };
    });

    return res.send(result);
  } catch (error) {
    console.error("Near-transfer failed:", error);
    return res.send({ transf: "failed" });
  }
});

// Disbursement status
router.post("/app/disbursement/status", async (req, res) => {
  const { user, pswd, disbursement_id, tkn } = req.body || {};
  const userInput = normalizeFormValue(user);
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
    if (!(await verifyUserPassword(U, P))) {
      return res.send({ transf: "failed" });
    }
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

// modify-pin-or-password
router.post("/app/modify-pin-or-password", async (req, res) => {
  const { user, pswd1, pswd2, tkn } = req.body || {};
  const U = normalizeFormValue(user);
  const P1 = normalizeFormValue(pswd1);
  const P2 = normalizeFormValue(pswd2);

  if (!requestTokenIsValid(req, tkn, P1, U)) {
    return res.send({ auth: "forbidden request" });
  }
  if (!P2) return res.status(400).send({ auth: "invalid password" });

  try {
    if (!(await verifyUserPassword(U, P1))) {
      return res.send({ auth: "incorrect" });
    }

    const passwordHash = await hashSecret(P2);
    await db.queryAsync("UPDATE auths SET password=? WHERE username=?", [
      passwordHash,
      U,
    ]);
    res.send({ auth: "updated" });
  } catch (error) {
    console.error("Password update failed:", error);
    res.send({ auth: "error" });
  }
});

// delete-user
router.post("/app/delete-user", async (req, res) => {
  const { user, pswd, tkn } = req.body || {};
  const U = normalizeFormValue(user);
  const P = normalizeFormValue(pswd);

  if (!requestTokenIsValid(req, tkn, P, U)) {
    return res.send({ auth: "forbidden request" });
  }

  try {
    if (!(await verifyUserPassword(U, P))) {
      return res.send({ auth: "incorrect" });
    }

    const stocks = await db.queryAsync(
      "SELECT balance FROM users_stock WHERE username=? LIMIT 1",
      [U],
    );
    if (stocks.length === 0) {
      return res.send({ auth: "error" });
    }

    const stockBalance = new BigNumber(stocks[0].balance);
    if (!stockBalance.isFinite() || stockBalance.isNegative()) {
      throw new Error("Invalid user stock balance");
    }
    const pendingDisbursements = await db.queryAsync(
      `SELECT id FROM users_usdt_disbursements
       WHERE username=? AND status IN ('queued','signed','submitted','manual_review')
       LIMIT 1`,
      [U],
    );
    if (pendingDisbursements.length > 0) {
      return res.send({ auth: "failed, disbursement pending" });
    }

    // The stored stock balance is already denominated in One-Val.
    if (stockBalance.isGreaterThan(2)) {
      return res.send({ auth: "failed, balance > 2" });
    }

    await db.queryAsync("DELETE FROM auths WHERE username=?", [U]);
    res.send({ auth: "deleted" });
  } catch (error) {
    console.error("User deletion failed:", error);
    res.send({ auth: "error" });
  }
});

// recover-account
router.post("/app/recover-account", async (req, res) => {
  const { user, seed } = req.body || {};
  const U = normalizeFormValue(user);
  const S = normalizeFormValue(seed);
  if (!U || !S) return res.status(400).send({ auth: "invalid request" });

  try {
    if (!(await verifyUserSeed(U, S))) {
      return res.send({ auth: "incorrect" });
    }

    const newPasswordHash = await hashSecret("123456");
    await db.queryAsync("UPDATE auths SET password=? WHERE username=?", [
      newPasswordHash,
      U,
    ]);
    res.send({ auth: "updated" });
  } catch (error) {
    console.error("Account recovery failed:", error);
    res.send({ auth: "error" });
  }
});

// modify-seed
router.post("/app/modify-seed", async (req, res) => {
  const { user, pswd, seed, tkn } = req.body || {};
  const U = normalizeFormValue(user);
  const P = normalizeFormValue(pswd);
  const S = normalizeFormValue(seed);

  if (!requestTokenIsValid(req, tkn, P, U)) {
    return res.send({ auth: "forbidden request" });
  }
  if (!S) return res.status(400).send({ auth: "invalid seed" });

  try {
    if (!(await verifyUserPassword(U, P))) {
      return res.send({ auth: "incorrect" });
    }

    const seedHash = await hashSecret(S);
    await db.queryAsync("UPDATE auths SET seed=? WHERE username=?", [
      seedHash,
      U,
    ]);
    res.send({ auth: "updated" });
  } catch (error) {
    console.error("Seed update failed:", error);
    res.send({ auth: "not exists" });
  }
});

// ----- ADMIN POSTS -----
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

// add-to-feed
router.post("/admin/add-to-feed", async (req, res) => {
  const { pswd, pin, content } = req.body;
  if (
    pswd !== decrypt(admin_pswd, DB_CONFIG.password) ||
    pin !== decrypt(admin_pin, DB_CONFIG.password)
  )
    return res.send({ auth: "incorrect" });

  const [date, time] = getDate();
  try {
    await db.queryAsync(
      "INSERT INTO notifs(content,record_date,record_time) VALUES(?,?,?)",
      [content.replaceAll(" ", "&nbsp;"), date, time],
    );
    res.send({ notif: "added" });
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
  const U = isUserTopUp ? user.toUpperCase().replaceAll(" ", "+") : null;

  try {
    const result = await withTransaction(async (tx) => {
      if (isUserTopUp) {
        const reference = createTxId(OneX);
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
    startUsdtPaymentWatcher(db, processConfirmedUsdtPayment, notifyPendingRechargeCases);
  }
  return providerInfo;
}

router.initializeRechargePayments = initializeRechargePayments;

module.exports = router;
