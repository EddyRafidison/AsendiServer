"use strict";

const BigNumber = require("bignumber.js");
const { getAddress, isAddress } = require("ethers");
const {
  validateWithdrawalRequestAmount,
} = require("./xtu-withdrawal-policy");
const { calculateXtuWithdrawalReservation } = require("./xtu-withdrawal-accounting");
const {
  getXtuSettings,
  isXtuWorkerEnabled,
  estimateXtuWithdrawal,
} = require("./xtu-withdrawal-chain");

function addWithdrawalEvent(tx, {
  eventKey,
  withdrawalId,
  eventType,
  previousStatus = null,
  currentStatus,
  actor,
  details = null,
  txHash = null,
}) {
  return tx.query(
    `INSERT IGNORE INTO xtu_withdrawal_events
     (event_key,withdrawal_id,event_type,previous_status,current_status,actor,tx_hash,details,created_at_ms)
     VALUES(?,?,?,?,?,?,?,?,?)`,
    [eventKey, String(withdrawalId), eventType, previousStatus, currentStatus, actor, txHash, details, String(Date.now())],
  );
}

function registerXtuWithdrawalRoutes(router, context) {
  const {
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
    calculateRemainingSystemAdminReserve,
    stock_limit,
    SYSTEM_ADMIN_RESERVE_RATIO,
  } = context;

  router.post("/app/xtu2wallet", async (req, res) => {
    const { user, pswd, amount, tkn } = req.body || {};
    const username = normalizeUsername(user);
    const password = normalizeFormValue(pswd);
    if (!await requestTokenIsValid(req, tkn, password, username)) {
      return res.status(403).send({ auth: "forbidden request" });
    }
    if (!username || username === OneX || !password) {
      return res.status(400).send({ error: "invalid withdrawal request" });
    }

    let grossAmount;
    try {
      grossAmount = validateWithdrawalRequestAmount(amount);
    } catch (error) {
      return res.status(400).send({ error: error.message });
    }

    try {
      const passwordRows = await db.queryAsync(
        `SELECT password,consec_failed_auth,password_temp_expires_at_ms,wallet_address,account_active
         FROM auths WHERE username=? LIMIT 1`,
        [username],
      );
      if (!passwordRows.length || Number(passwordRows[0].account_active) !== 1) {
        return res.status(403).send({ auth: "not allowed" });
      }
      if (
        Number(passwordRows[0].consec_failed_auth || 0) >= 3 ||
        passwordRows[0].password_temp_expires_at_ms != null
      ) return res.status(403).send({ auth: "not allowed" });
      const passwordState = await getUserActivityPasswordState(username, password);
      if (passwordState !== "ok") return res.status(403).send({ auth: passwordState });
      if (await accountApiLimitReached(res, username, "xtu_withdrawal", 3, 60 * 60_000)) return;

      if (!isXtuWorkerEnabled()) {
        return res.status(503).send({ error: "XTU wallet withdrawals are not enabled on this server." });
      }
      const settings = getXtuSettings();
      if (!settings.workerEnabled) {
        return res.status(503).send({ error: "XTU wallet withdrawals are not enabled on this server." });
      }
      const registeredWallet = String(passwordRows[0].wallet_address || "").trim();
      if (!isAddress(registeredWallet)) {
        return res.status(409).send({ error: "The account has no valid registered BSC wallet address." });
      }
      const walletAddress = getAddress(registeredWallet);
      if (walletAddress === settings.distributionAddress) {
        return res.status(409).send({ error: "The registered XTU wallet address is not eligible for withdrawal." });
      }

      // The user cannot submit a destination. The only destination is the fixed wallet from signup.
      const quote = await estimateXtuWithdrawal({ destination: walletAddress, grossAmount: grossAmount.toFixed(18) });
      const verifiedPasswordHash = passwordRows[0].password;
      const reference = createFinancialReference("XTUW");
      const [date, time] = getDate();
      const now = String(Date.now());

      const result = await withTransaction(async (tx) => {
        const [commonLockRows] = await tx.query(
          "SELECT lock_name FROM system_locks WHERE lock_name=? FOR UPDATE",
          ["common_state"],
        );
        if (!commonLockRows.length) throw new Error("The common-state lock row has not been initialized");
        const [xtuLockRows] = await tx.query(
          "SELECT lock_name FROM system_locks WHERE lock_name=? FOR UPDATE",
          ["onex_xtu_wallet_spend"],
        );
        if (!xtuLockRows.length) throw new Error("The XTU withdrawal lock row has not been initialized");

        const [controlRows] = await tx.query(
          `SELECT is_open,reason FROM xtu_withdrawal_control WHERE control_id=1 LIMIT 1 FOR UPDATE`,
        );
        if (!controlRows.length) throw new Error("The XTU withdrawal control row has not been initialized");
        if (Number(controlRows[0].is_open) !== 1) return { status: "closed" };

        const [authRows] = await tx.query(
          `SELECT username,password,last_login_at_ms,account_active,consec_failed_auth,
                  password_temp_expires_at_ms,wallet_address
           FROM auths WHERE username=? LIMIT 1 FOR UPDATE`,
          [username],
        );
        if (!authRows.length || Number(authRows[0].account_active) !== 1 ||
            authRows[0].last_login_at_ms == null || authRows[0].password !== verifiedPasswordHash ||
            getAddress(String(authRows[0].wallet_address || "")) !== walletAddress ||
            Number(authRows[0].consec_failed_auth || 0) >= 3 || authRows[0].password_temp_expires_at_ms != null) {
          return { status: "account_changed" };
        }

        const [pendingRows] = await tx.query(
          `SELECT id,status FROM xtu_withdrawals
           WHERE username=? AND status IN ('queued','signed','submitted','manual_review')
           ORDER BY id DESC LIMIT ? FOR UPDATE`,
          [username, settings.maxPendingPerUser],
        );
        if (pendingRows.length >= settings.maxPendingPerUser) return { status: "withdrawal_pending" };

        const [otherPendingRows] = await tx.query(
          `SELECT id FROM users_usdt_disbursements
           WHERE username=? AND status IN ('queued','signed','submitted','manual_review')
           LIMIT 1 FOR UPDATE`,
          [username],
        );
        if (otherPendingRows.length) return { status: "other_disbursement_pending" };
        const [sellerPayoutRows] = await tx.query(
          `SELECT id FROM users_usdt_seller_payouts
           WHERE username=? AND status IN ('queued','signed','submitted','manual_review')
           LIMIT 1 FOR UPDATE`,
          [username],
        );
        if (sellerPayoutRows.length) return { status: "other_disbursement_pending" };

        const [globalRows] = await tx.query(
          `SELECT id,status,effective_at_ms FROM global_disbursement_runs
           WHERE status IN ('announced','active','closed','manual_review','completed','resolved')
           ORDER BY id DESC LIMIT 1 FOR UPDATE`,
        );
        const globalRun = globalRows[0] || null;
        if (globalRun && ["announced", "active", "closed", "manual_review", "completed", "resolved"].includes(globalRun.status)) {
          return { status: "global_disbursement_in_progress" };
        }

        const [stockRows] = await tx.query(
          `SELECT balance,seller_status,run_balance FROM users_stock
           WHERE username=? LIMIT 1 FOR UPDATE`,
          [username],
        );
        if (!stockRows.length) return { status: "stock_missing" };
        const stock = stockRows[0];
        if (Number(stock.seller_status || 0) !== 0) return { status: "seller_campaign_active" };

        const common = await getLatestCommonTx(tx, true);
        const globalPrice = new BigNumber(common.unit_price);
        const totalUnitsPrice = new BigNumber(common.total_units_price);
        const backedUnits = new BigNumber(common.backed_units);
        const principal = new BigNumber(stock.balance);
        if (!globalPrice.isFinite() || !globalPrice.isGreaterThan(0) ||
            !totalUnitsPrice.isFinite() || !totalUnitsPrice.isGreaterThan(0) ||
            !backedUnits.isFinite() || !backedUnits.isGreaterThan(0) ||
            !principal.isFinite() || principal.isNegative()) {
          throw new Error("Invalid common reserve or user principal values for XTU withdrawal.");
        }

        const priceState = await getUserPriceStateTx(tx, username, true);
        if (!priceState) throw new Error("The user's individual remuneration state is missing.");
        const individualPrice = calculateEffectiveIndividualPrice(
          priceState, principal, globalPrice,
        ).price;
        if (!individualPrice.isFinite() || !individualPrice.isGreaterThan(0) || individualPrice.gt(globalPrice)) {
          throw new Error("The user's effective individual XTU price is invalid.");
        }
        const protectedAdminReserve = calculateRemainingSystemAdminReserve(
          stock_limit,
          SYSTEM_ADMIN_RESERVE_RATIO,
          common.sys_inactive_init_asset || "0",
        ).remainingInitialAsset;
        let reservation;
        try {
          reservation = calculateXtuWithdrawalReservation({
            grossAmount: quote.grossAmount,
            individualPrice,
            totalUnitsPrice,
            backedUnits,
            protectedBackedFloor: protectedAdminReserve,
          });
        } catch (error) {
          if (/protected backed-assets reserve/.test(error.message)) return { status: "protected_reserve" };
          if (/common XTU reserve/.test(error.message)) return { status: "system_reserve" };
          throw error;
        }
        const reservedInitialAsset = reservation.reservedInitialAsset;
        const reservedXtuValue = reservation.reservedXtuValue;
        const futurePrincipal = principal.minus(reservedInitialAsset);
        if (futurePrincipal.isNegative()) return { status: "insufficient_balance" };
        const futureBackedUnits = reservation.newBackedUnits;
        const futureTotalUnitsPrice = reservation.newTotalUnitsPrice;

        await tx.query(
          `UPDATE users_stock SET balance=?,record_date=?,record_time=? WHERE username=?`,
          [futurePrincipal.toFixed(30), date, time, username],
        );
        await insertCommonSnapshotTx(tx, common, {
          total_units_price: futureTotalUnitsPrice.toFixed(30),
          backed_units: futureBackedUnits.toFixed(30),
        }, date, time);

        const [insertResult] = await tx.query(
          `INSERT INTO xtu_withdrawals
           (reference,username,payout_address,gross_amount,reserved_initial_asset,effective_unit_price,global_unit_price,
            estimated_gas_fee_bnb,estimated_gas_fee_usd,estimated_gas_fee_xtu,contract_transfer_amount,
            contract_fee_amount,net_amount,reserved_xtu_value,bnb_usd_price,amount_raw,gas_limit,
            gas_price_wei,token_contract_address,status,last_error,next_attempt_at_ms,created_at_ms,updated_at_ms)
           VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,?,?,?)`,
          [
            reference, username, walletAddress, quote.grossAmount.toFixed(18), reservedInitialAsset.toFixed(30),
            individualPrice.toFixed(30), globalPrice.toFixed(30), quote.estimatedGasFeeBnb,
            quote.estimatedGasFeeUsd, quote.estimatedGasFeeXtu.toFixed(18),
            quote.contractTransferAmount.toFixed(18), quote.contractFeeAmount.toFixed(18), quote.netAmount.toFixed(18),
            reservedXtuValue.toFixed(30), quote.bnbUsdPrice, quote.contractTransferRaw,
            quote.gasLimit, quote.gasPriceWei, quote.tokenContract, "queued", now, now, now,
          ],
        );
        await addWithdrawalEvent(tx, {
          eventKey: `xtu-withdrawal:${reference}:queued`,
          withdrawalId: insertResult.insertId,
          eventType: "queued",
          currentStatus: "queued",
          actor: username,
          details: "User requested XTU externalization to the fixed registered wallet.",
        });
        return {
          status: "queued",
          withdrawalId: String(insertResult.insertId),
          reference,
          grossAmount: quote.grossAmount.toFixed(18),
          estimatedNetAmount: quote.netAmount.toFixed(18),
          estimatedGasFeeXtu: quote.estimatedGasFeeXtu.toFixed(18),
          estimatedContractFeeXtu: quote.contractFeeAmount.toFixed(18),
          estimatedTotalFeesXtu: quote.estimatedCombinedFees.toFixed(18),
          reservedInitialAsset: reservedInitialAsset.toFixed(30),
          reservedXtuValue: reservedXtuValue.toFixed(30),
          payoutAddress: walletAddress,
        };
      });

      if (result.status !== "queued") {
        const statusCodes = {
          closed: [409, "XTU wallet withdrawals are currently closed."],
          account_changed: [403, "Account state changed; sign in again before retrying."],
          withdrawal_pending: [409, "An XTU withdrawal is already pending for this account."],
          other_disbursement_pending: [409, "Another disbursement is pending for this account."],
          global_disbursement_in_progress: [409, "A global disbursement is in progress."],
          stock_missing: [409, "The account's initial-asset balance is unavailable."],
          seller_campaign_active: [409, "Cancel or complete the active seller campaign before requesting an XTU withdrawal."],
          insufficient_balance: [409, "Insufficient XTU balance for this withdrawal."],
          protected_reserve: [409, "The protected system reserve cannot cover this withdrawal."],
          system_reserve: [409, "The system reserve cannot cover this withdrawal at the moment."],
        };
        const [httpStatus, message] = statusCodes[result.status] || [409, "The XTU withdrawal request could not be accepted."];
        return res.status(httpStatus).send({ error: message, status: result.status });
      }
      return res.status(202).send({
        transf: "processing",
        ...result,
        message: "La demande de retrait XTU est enregistrée. Le transfert sera confirmé après validation sur BNB Smart Chain.",
      });
    } catch (error) {
      console.error("XTU withdrawal request failed:", error.message);
      if (error.code === "BSC_GAS_FEE_LIMIT_EXCEEDED") {
        return res.status(503).send({ error: "The current BSC network fee is above the configured 0.4 BSC-USD ceiling. Try again later." });
      }
      return res.status(503).send({ error: "XTU withdrawal service is temporarily unavailable." });
    }
  });

  router.post("/app/xtu2wallet/status", async (req, res) => {
    const { user, pswd, reference, tkn } = req.body || {};
    const username = normalizeUsername(user);
    const password = normalizeFormValue(pswd);
    const requestReference = String(reference || "").trim();
    if (!await requestTokenIsValid(req, tkn, password, username)) {
      return res.status(403).send({ auth: "forbidden request" });
    }
    if (!username || !password || !/^XTUW[A-Za-z0-9]{8,60}$/.test(requestReference)) {
      return res.status(400).send({ error: "invalid XTU withdrawal status request" });
    }
    try {
      const passwordState = await getUserActivityPasswordState(username, password);
      if (passwordState !== "ok") return res.status(403).send({ auth: passwordState });
      if (await accountApiLimitReached(res, username, "xtu_withdrawal_status", 20, 60 * 60_000)) return;
      const rows = await db.queryAsync(
        `SELECT reference,gross_amount,payout_address,estimated_gas_fee_usd,estimated_gas_fee_xtu,
                contract_fee_amount,net_amount,actual_gas_fee_usd,actual_contract_fee_amount,
                actual_net_amount,tx_hash,block_number,status,last_error,created_at_ms,confirmed_at_ms,failed_at_ms
         FROM xtu_withdrawals WHERE reference=? AND username=? LIMIT 1`,
        [requestReference, username],
      );
      if (!rows.length) return res.status(404).send({ error: "XTU withdrawal reference not found." });
      const row = rows[0];
      return res.send({
        reference: row.reference,
        status: row.status,
        gross_amount: row.gross_amount,
        payout_address: row.payout_address,
        estimated_gas_fee_usd: row.estimated_gas_fee_usd,
        estimated_gas_fee_xtu: row.estimated_gas_fee_xtu,
        estimated_contract_fee_xtu: row.contract_fee_amount,
        estimated_net_amount: row.net_amount,
        actual_gas_fee_usd: row.actual_gas_fee_usd,
        actual_contract_fee_xtu: row.actual_contract_fee_amount,
        actual_net_amount: row.actual_net_amount,
        tx_hash: row.tx_hash,
        block_number: row.block_number,
        created_at_ms: Number(row.created_at_ms),
        confirmed_at_ms: row.confirmed_at_ms == null ? null : Number(row.confirmed_at_ms),
        failed_at_ms: row.failed_at_ms == null ? null : Number(row.failed_at_ms),
        last_error: row.status === "manual_review" ? row.last_error : null,
      });
    } catch (error) {
      console.error("XTU withdrawal status lookup failed:", error.message);
      return res.status(503).send({ error: "XTU withdrawal status is temporarily unavailable." });
    }
  });

  router.post("/admin/withdraw/start", async (req, res) => {
    const { pswd, pin, action, reason } = req.body || {};
    if (
      pswd !== decrypt(admin_pswd, DB_CONFIG.password) ||
      pin !== decrypt(admin_pin, DB_CONFIG.password)
    ) return res.send({ auth: "incorrect" });

    const requestedAction = String(action || "").trim().toLowerCase();
    if (!["start", "stop", "status"].includes(requestedAction)) {
      return res.status(400).send({ error: "action must be start, stop or status" });
    }
    const controlReason = typeof reason === "string" ? reason.trim() : "";
    if (requestedAction !== "status" && (controlReason.length < 5 || controlReason.length > 1000)) {
      return res.status(400).send({ error: "a reason between 5 and 1000 characters is required" });
    }

    try {
      if (requestedAction === "start") {
        if (!isXtuWorkerEnabled()) {
          return res.status(503).send({ error: "XTU_WITHDRAWAL_WORKER_ENABLED must be true before opening withdrawals." });
        }
        const settings = getXtuSettings();
        if (!settings.workerEnabled) {
          return res.status(503).send({ error: "XTU_WITHDRAWAL_WORKER_ENABLED must be true before opening withdrawals." });
        }
        await require("./xtu-withdrawal-chain").getXtuRuntime({ requireSigner: true });
      }

      const control = await withTransaction(async (tx) => {
        const [commonLockRows] = await tx.query(
          "SELECT lock_name FROM system_locks WHERE lock_name='common_state' FOR UPDATE",
        );
        if (!commonLockRows.length) throw new Error("The common-state lock row has not been initialized");
        const [rows] = await tx.query(
          `SELECT is_open,reason,changed_by,started_at_ms,stopped_at_ms,updated_at_ms
           FROM xtu_withdrawal_control WHERE control_id=1 LIMIT 1 FOR UPDATE`,
        );
        if (!rows.length) throw new Error("The XTU withdrawal control row has not been initialized");
        const current = rows[0];
        if (requestedAction === "start") {
          const [manualReviewRows] = await tx.query(
            `SELECT id FROM xtu_withdrawals WHERE status='manual_review' ORDER BY id ASC LIMIT 1 FOR UPDATE`,
          );
          if (manualReviewRows.length) {
            return { error: "manual_review_pending", withdrawal_id: String(manualReviewRows[0].id) };
          }
        }
        if (requestedAction === "status") {
          return {
            status: Number(current.is_open) === 1 ? "open" : "closed",
            reason: current.reason,
            changed_by: current.changed_by,
            started_at_ms: current.started_at_ms == null ? null : Number(current.started_at_ms),
            stopped_at_ms: current.stopped_at_ms == null ? null : Number(current.stopped_at_ms),
            updated_at_ms: Number(current.updated_at_ms),
          };
        }
        const nextOpen = requestedAction === "start" ? 1 : 0;
        const now = String(Date.now());
        await tx.query(
          `UPDATE xtu_withdrawal_control
           SET is_open=?,reason=?,changed_by='configured_admin',
               started_at_ms=CASE WHEN ?=1 THEN ? ELSE started_at_ms END,
               stopped_at_ms=CASE WHEN ?=0 THEN ? ELSE stopped_at_ms END,
               updated_at_ms=? WHERE control_id=1`,
          [nextOpen, nextOpen ? controlReason : null, nextOpen, now, nextOpen, now, now],
        );
        await tx.query(
          `INSERT INTO xtu_withdrawal_control_events
           (action,previous_open,current_open,reason,changed_by,created_at_ms)
           VALUES(?,?,?,?,?,?)`,
          [requestedAction, Number(current.is_open), nextOpen, controlReason, "configured_admin", now],
        );
        return {
          status: nextOpen ? "open" : "closed",
          reason: nextOpen ? controlReason : null,
          changed_by: "configured_admin",
          changed_at_ms: Number(now),
        };
      });
      if (control.error) return res.status(409).send({ error: control.error, withdrawal_id: control.withdrawal_id });
      return res.send({ xtu_withdrawal_control: control });
    } catch (error) {
      console.error("Administrative XTU withdrawal control failed:", error.message);
      return res.status(503).send({ error: "XTU withdrawal control update failed." });
    }
  });
}

module.exports = { registerXtuWithdrawalRoutes };
