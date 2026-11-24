"use strict";

const BigNumber = require("bignumber.js");
const {
  getXtuSettings,
  isXtuWorkerEnabled,
  getXtuRuntime,
  estimateXtuWithdrawal,
  transactionHashFromRaw,
} = require("./xtu-withdrawal-chain");
const {
  getLatestCommonTx,
  insertCommonSnapshotTx,
} = require("./common-accounting");
const {
  recordEstimatedBscFeeTx,
  recordActualBscFeeTx,
  calculateActualGasFee,
} = require("./bsc-fee-accounting");
const { getBnbUsdPrice } = require("./bsc-price-oracle");
const { queueTelegramMessageTx } = require("./telegram");
const {
  calculateXtuWithdrawalInactiveReserve,
  calculateXtuWithdrawalReversal,
} = require("./xtu-withdrawal-accounting");

BigNumber.config({ DECIMAL_PLACES: 36, ROUNDING_MODE: BigNumber.ROUND_HALF_UP });

function getPoolConnection(pool) {
  return new Promise((resolve, reject) => {
    pool.getConnection((error, connection) => error ? reject(error) : resolve(connection));
  });
}

async function withTransaction(pool, work, maxAttempts = 3) {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const connection = await getPoolConnection(pool);
    const tx = connection.promise();
    let retry = false;
    try {
      await tx.beginTransaction();
      const result = await work(tx);
      await tx.commit();
      return result;
    } catch (error) {
      try { await tx.rollback(); } catch (rollbackError) {
        console.error("XTU withdrawal transaction rollback failed:", rollbackError.message);
      }
      if (!error || !["ER_LOCK_DEADLOCK", "ER_LOCK_WAIT_TIMEOUT"].includes(error.code) || attempt === maxAttempts) {
        throw error;
      }
      retry = true;
    } finally {
      connection.release();
    }
    if (retry) await new Promise((resolve) => setTimeout(resolve, attempt * 50));
  }
  throw new Error("XTU withdrawal transaction retry limit reached.");
}

function utcDateTime() {
  const now = new Date();
  const date = Number(`${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, "0")}${String(now.getUTCDate()).padStart(2, "0")}`);
  const time = `${String(now.getUTCHours()).padStart(2, "0")}${String(now.getUTCMinutes()).padStart(2, "0")}${String(now.getUTCSeconds()).padStart(2, "0")}`;
  return [date, time];
}

async function appendEvent(tx, row, eventType, nextStatus, details, txHash = row.tx_hash || null) {
  const eventKey = `xtu-withdrawal:${row.id}:${eventType}`;
  await tx.query(
    `INSERT IGNORE INTO xtu_withdrawal_events
     (event_key,withdrawal_id,event_type,previous_status,current_status,actor,tx_hash,details,created_at_ms)
     VALUES(?,?,?,?,?,'system',?,?,?)`,
    [eventKey, String(row.id), eventType, row.status, nextStatus, txHash, details || null, String(Date.now())],
  );
}

async function acquireCommonAndXtuLocks(tx) {
  const [commonLockRows] = await tx.query(
    "SELECT lock_name FROM system_locks WHERE lock_name='common_state' FOR UPDATE",
  );
  if (!commonLockRows.length) throw new Error("The common-state lock row has not been initialized.");
  const [xtuLockRows] = await tx.query(
    "SELECT lock_name FROM system_locks WHERE lock_name='onex_xtu_wallet_spend' FOR UPDATE",
  );
  if (!xtuLockRows.length) throw new Error("The XTU wallet-spend lock row has not been initialized.");
}

async function deferWithdrawal(pool, rowId, error, retryMs) {
  const message = String(error?.message || error || "XTU withdrawal is waiting for a retry.").slice(0, 990);
  await pool.queryAsync(
    `UPDATE xtu_withdrawals SET last_error=?,next_attempt_at_ms=?,updated_at_ms=?
     WHERE id=? AND status='queued'`,
    [message, String(Date.now() + retryMs), String(Date.now()), String(rowId)],
  );
}

async function refreshQueuedQuote(pool, row, runtime) {
  const quote = await estimateXtuWithdrawal({
    destination: row.payout_address,
    grossAmount: String(row.gross_amount),
  });
  await withTransaction(pool, async (tx) => {
    await acquireCommonAndXtuLocks(tx);
    const [rows] = await tx.query(
      "SELECT * FROM xtu_withdrawals WHERE id=? LIMIT 1 FOR UPDATE",
      [String(row.id)],
    );
    if (!rows.length || rows[0].status !== "queued") return;
    // The user's reserved principal is fixed at the captured individual price.
    // A refreshed gas quote changes only the net on-chain amount, not the reserve debit.
    await getLatestCommonTx(tx, true);
    await tx.query(
      `UPDATE xtu_withdrawals SET estimated_gas_fee_bnb=?,estimated_gas_fee_usd=?,estimated_gas_fee_xtu=?,
       contract_transfer_amount=?,contract_fee_amount=?,net_amount=?,bnb_usd_price=?,
       amount_raw=?,gas_limit=?,gas_price_wei=?,token_contract_address=?,last_error=NULL,
       next_attempt_at_ms=?,updated_at_ms=? WHERE id=? AND status='queued'`,
      [
        quote.estimatedGasFeeBnb, quote.estimatedGasFeeUsd, quote.estimatedGasFeeXtu.toFixed(18),
        quote.contractTransferAmount.toFixed(18), quote.contractFeeAmount.toFixed(18), quote.netAmount.toFixed(18),
        quote.bnbUsdPrice, quote.contractTransferRaw,
        quote.gasLimit, quote.gasPriceWei, quote.tokenContract, String(Date.now()), String(Date.now()), String(row.id),
      ],
    );
  });
}

async function signQueuedWithdrawal(pool, row, runtime) {
  const rawAmount = BigInt(String(row.amount_raw));
  const data = runtime.contract.interface.encodeFunctionData("transfer", [row.payout_address, rawAmount]);
  const nonce = await runtime.provider.getTransactionCount(runtime.settings.distributionAddress, "pending");
  const txRequest = {
    to: runtime.settings.tokenAddress,
    data,
    value: 0n,
    chainId: 56n,
    nonce,
    gasLimit: BigInt(String(row.gas_limit)),
    gasPrice: BigInt(String(row.gas_price_wei)),
  };
  const rawTx = await runtime.signer.signTransaction(txRequest);
  const txHash = transactionHashFromRaw(rawTx);
  await withTransaction(pool, async (tx) => {
    await acquireCommonAndXtuLocks(tx);
    const [rows] = await tx.query(
      "SELECT * FROM xtu_withdrawals WHERE id=? LIMIT 1 FOR UPDATE",
      [String(row.id)],
    );
    if (!rows.length || rows[0].status !== "queued") return;
    await recordEstimatedBscFeeTx(tx, {
      txHash,
      operation: "xtu_withdrawal",
      gasLimit: txRequest.gasLimit.toString(),
      gasPriceWei: txRequest.gasPrice.toString(),
      bnbUsdPrice: row.bnb_usd_price,
    });
    const now = String(Date.now());
    await tx.query(
      `UPDATE xtu_withdrawals SET raw_tx=?,tx_hash=?,nonce=?,status='signed',signed_at_ms=?,
       last_error=NULL,next_attempt_at_ms=?,updated_at_ms=? WHERE id=? AND status='queued'`,
      [rawTx, txHash, String(nonce), now, now, now, String(row.id)],
    );
    await appendEvent(tx, { ...rows[0], tx_hash: txHash }, "signed", "signed", `Signed XTU transaction with nonce ${nonce}.`, txHash);
  });
  return { rawTx, txHash, nonce };
}

async function submitSignedTransaction(pool, row, runtime) {
  const txHash = String(row.tx_hash || "").toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(txHash) || !row.raw_tx) {
    await markManualReview(pool, row, "Signed withdrawal is missing its transaction hash or signed raw transaction.");
    return;
  }

  let transaction = null;
  let receipt = null;
  try {
    [transaction, receipt] = await Promise.all([
      runtime.provider.getTransaction(txHash),
      runtime.provider.getTransactionReceipt(txHash),
    ]);
  } catch (error) {
    await recordActiveError(pool, row.id, error.message, runtime.settings.retryMs);
    return;
  }

  if (!receipt) {
    if (transaction) {
      await markSubmitted(pool, row);
      return;
    }
    let latestNonce;
    try {
      latestNonce = await runtime.provider.getTransactionCount(runtime.settings.distributionAddress, "latest");
    } catch (error) {
      await recordActiveError(pool, row.id, error.message, runtime.settings.retryMs);
      return;
    }
    if (latestNonce > Number(row.nonce)) {
      await markManualReview(pool, row, "The distribution wallet nonce advanced but the signed XTU transaction is not visible by its hash. Automatic resubmission is blocked to prevent a duplicate payment.");
      return;
    }
    try {
      const sent = await runtime.provider.broadcastTransaction(row.raw_tx);
      if (String(sent.hash).toLowerCase() !== txHash) {
        await markManualReview(pool, row, "The RPC returned a transaction hash different from the persisted signed transaction hash.");
        return;
      }
      await markSubmitted(pool, row);
    } catch (error) {
      // Rebroadcasting the identical raw transaction preserves the same hash and nonce.
      // It cannot create a second distinct withdrawal; an uncertain result remains reconcilable.
      await recordActiveError(pool, row.id, error.message, runtime.settings.retryMs);
    }
    return;
  }

  const currentBlock = await runtime.provider.getBlockNumber();
  const confirmations = currentBlock - Number(receipt.blockNumber) + 1;
  if (confirmations < runtime.settings.minConfirmations) {
    await markSubmitted(pool, row);
    return;
  }
  const canonicalBlock = await runtime.provider.getBlock(Number(receipt.blockNumber));
  if (!canonicalBlock || String(canonicalBlock.hash).toLowerCase() !== String(receipt.blockHash).toLowerCase()) {
    await markSubmitted(pool, row);
    return;
  }

  if (Number(receipt.status) !== 1) {
    await finalizeFailedWithdrawal(pool, row, receipt, runtime);
    return;
  }

  const events = parseXtuTransferEvents(runtime, receipt, row);
  if (!events.valid) {
    await recordActualFeeAndRequireReview(pool, row, receipt, runtime, events.reason);
    return;
  }
  try {
    await finalizeSuccessfulWithdrawal(pool, row, receipt, events, runtime);
  } catch (error) {
    if (/Confirmed XTU withdrawal requires manual reserve reconciliation/.test(String(error?.message || error))) {
      await recordActualFeeAndRequireReview(
        pool,
        row,
        receipt,
        runtime,
        `The XTU transfer is confirmed on-chain, but automatic reserve settlement failed: ${String(error.message).slice(0, 700)}`,
      );
      return;
    }
    throw error;
  }
}

function parseXtuTransferEvents(runtime, receipt, row) {
  let netRaw = null;
  let feeRaw = null;
  for (const log of receipt.logs || []) {
    if (String(log.address).toLowerCase() !== runtime.settings.tokenAddress.toLowerCase()) continue;
    let parsed;
    try { parsed = runtime.contract.interface.parseLog(log); } catch { continue; }
    if (!parsed) continue;
    if (parsed.name === "Transfer" &&
        String(parsed.args.from).toLowerCase() === runtime.settings.distributionAddress.toLowerCase() &&
        String(parsed.args.to).toLowerCase() === String(row.payout_address).toLowerCase()) {
      netRaw = BigInt(parsed.args.value);
    }
    if (parsed.name === "FeeCollected" &&
        String(parsed.args.from).toLowerCase() === runtime.settings.distributionAddress.toLowerCase() &&
        String(parsed.args.collector).toLowerCase() === runtime.settings.distributionAddress.toLowerCase()) {
      feeRaw = BigInt(parsed.args.amount);
    }
  }
  const expectedNet = BigInt(new BigNumber(row.net_amount).multipliedBy("1e18").integerValue(BigNumber.ROUND_DOWN).toFixed(0));
  const expectedFee = BigInt(new BigNumber(row.contract_fee_amount).multipliedBy("1e18").integerValue(BigNumber.ROUND_DOWN).toFixed(0));
  if (netRaw == null) return { valid: false, reason: "The finalized XTU transaction does not contain the expected distribution-wallet-to-user Transfer event." };
  if (feeRaw == null) return { valid: false, reason: "The finalized XTU transaction is missing the mandatory FeeCollected event." };
  if (netRaw !== expectedNet || feeRaw !== expectedFee) {
    return { valid: false, reason: "Finalized XTU Transfer/FeeCollected amounts do not match the reserved withdrawal quote." };
  }
  return { valid: true, netRaw, feeRaw };
}

async function markSubmitted(pool, row) {
  const now = String(Date.now());
  await withTransaction(pool, async (tx) => {
    const [rows] = await tx.query("SELECT * FROM xtu_withdrawals WHERE id=? LIMIT 1 FOR UPDATE", [String(row.id)]);
    if (!rows.length || !["signed", "submitted"].includes(rows[0].status)) return;
    await tx.query(
      `UPDATE xtu_withdrawals SET status='submitted',submitted_at_ms=COALESCE(submitted_at_ms,?),
       last_error=NULL,next_attempt_at_ms=?,updated_at_ms=? WHERE id=?`,
      [now, String(Date.now() + 15000), now, String(row.id)],
    );
    if (rows[0].status === "signed") {
      await appendEvent(tx, rows[0], "submitted", "submitted", "The signed transaction is visible to the outgoing BSC RPC.");
    }
  });
}

async function recordActiveError(pool, rowId, error, retryMs) {
  await pool.queryAsync(
    `UPDATE xtu_withdrawals SET last_error=?,next_attempt_at_ms=?,updated_at_ms=?
     WHERE id=? AND status IN ('signed','submitted')`,
    [String(error || "RPC reconciliation pending").slice(0, 990), String(Date.now() + retryMs), String(Date.now()), String(rowId)],
  );
}

async function markManualReview(pool, row, reason) {
  await withTransaction(pool, async (tx) => {
    await acquireCommonAndXtuLocks(tx);
    const [rows] = await tx.query("SELECT * FROM xtu_withdrawals WHERE id=? LIMIT 1 FOR UPDATE", [String(row.id)]);
    if (!rows.length || rows[0].status === "manual_review") return;
    const now = String(Date.now());
    await tx.query(
      `UPDATE xtu_withdrawals SET status='manual_review',last_error=?,next_attempt_at_ms=?,updated_at_ms=? WHERE id=?`,
      [String(reason).slice(0, 990), now, now, String(row.id)],
    );
    await appendEvent(tx, rows[0], "manual_review", "manual_review", reason);
  });
  console.error(`XTU withdrawal ${row.reference} requires manual review: ${reason}`);
}

async function recordActualFeeAndRequireReview(pool, row, receipt, runtime, reason) {
  try {
    const bnbUsdPrice = await getBnbUsdPrice(runtime.provider, { forceRefresh: true });
    await withTransaction(pool, async (tx) => {
      await acquireCommonAndXtuLocks(tx);
      const actualGas = calculateActualGasFee(receipt, bnbUsdPrice);
      await recordActualBscFeeTx(tx, {
        txHash: row.tx_hash,
        operation: "xtu_withdrawal",
        receipt,
        bnbUsdPrice,
      });
      const [rows] = await tx.query("SELECT * FROM xtu_withdrawals WHERE id=? LIMIT 1 FOR UPDATE", [String(row.id)]);
      if (!rows.length || rows[0].status === "confirmed") return;
      const now = String(Date.now());
      await tx.query(
        `UPDATE xtu_withdrawals SET status='manual_review',block_number=?,actual_gas_fee_bnb=?,
         actual_gas_fee_usd=?,last_error=?,next_attempt_at_ms=?,updated_at_ms=? WHERE id=?`,
        [String(receipt.blockNumber), actualGas.feeBnb.toFixed(30), actualGas.feeUsd.toFixed(30), String(reason).slice(0, 990), now, now, String(row.id)],
      );
      await appendEvent(tx, rows[0], "manual_review", "manual_review", reason);
    });
  } catch (error) {
    console.error("Unable to record XTU transaction requiring manual review:", error.message);
  }
}

async function finalizeFailedWithdrawal(pool, row, receipt, runtime) {
  const bnbUsdPrice = await getBnbUsdPrice(runtime.provider, { forceRefresh: true });
  const actualGas = calculateActualGasFee(receipt, bnbUsdPrice);
  await withTransaction(pool, async (tx) => {
    await acquireCommonAndXtuLocks(tx);
    const [rows] = await tx.query("SELECT * FROM xtu_withdrawals WHERE id=? LIMIT 1 FOR UPDATE", [String(row.id)]);
    if (!rows.length || ["failed", "confirmed"].includes(rows[0].status)) return;
    const current = rows[0];
    await recordActualBscFeeTx(tx, {
      txHash: current.tx_hash,
      operation: "xtu_withdrawal",
      receipt,
      bnbUsdPrice,
    });
    const common = await getLatestCommonTx(tx, true);
    const reversal = calculateXtuWithdrawalReversal({
      totalUnitsPrice: common.total_units_price,
      backedUnits: common.backed_units,
      reservedXtuValue: current.reserved_xtu_value,
      reservedInitialAsset: current.reserved_initial_asset,
      actualGasFeeUsd: actualGas.feeUsd,
    });
    const restoredTotal = reversal.restoredTotalUnitsPrice;
    const restoredBacked = reversal.restoredBackedUnits;
    const [date, time] = utcDateTime();
    if (!restoredTotal.isFinite() || !restoredTotal.isGreaterThan(0) || !restoredBacked.isFinite() || !restoredBacked.isGreaterThan(0)) {
      throw new Error("Failed XTU withdrawal cannot be automatically reversed without violating common reserve invariants.");
    }
    await insertCommonSnapshotTx(tx, common, {
      total_units_price: restoredTotal.toFixed(30),
      backed_units: restoredBacked.toFixed(30),
    }, date, time);
    const [stockRows] = await tx.query("SELECT balance FROM users_stock WHERE username=? LIMIT 1 FOR UPDATE", [current.username]);
    if (!stockRows.length) throw new Error("User stock is missing while reversing a failed XTU withdrawal.");
    const restoredBalance = new BigNumber(stockRows[0].balance).plus(current.reserved_initial_asset);
    await tx.query(
      "UPDATE users_stock SET balance=?,record_date=?,record_time=? WHERE username=?",
      [restoredBalance.toFixed(30), date, time, current.username],
    );
    const now = String(Date.now());
    await tx.query(
      `UPDATE xtu_withdrawals SET status='failed',block_number=?,actual_gas_fee_bnb=?,actual_gas_fee_usd=?,
       failed_at_ms=?,last_error='The XTU token transfer reverted on-chain; principal reservation was restored.',
       next_attempt_at_ms=?,updated_at_ms=? WHERE id=?`,
      [String(receipt.blockNumber), actualGas.feeBnb.toFixed(30), actualGas.feeUsd.toFixed(30), now, now, now, String(row.id)],
    );
    await appendEvent(tx, current, "failed", "failed", "The XTU transfer reverted on-chain; reserved principal was restored.");
  });
}

async function finalizeSuccessfulWithdrawal(pool, row, receipt, events, runtime) {
  const bnbUsdPrice = await getBnbUsdPrice(runtime.provider, { forceRefresh: true });
  const actualGas = calculateActualGasFee(receipt, bnbUsdPrice);
  const actualNetAmount = new BigNumber(events.netRaw.toString()).shiftedBy(-18);
  const actualContractFee = new BigNumber(events.feeRaw.toString()).shiftedBy(-18);

  await withTransaction(pool, async (tx) => {
    await acquireCommonAndXtuLocks(tx);
    const [rows] = await tx.query("SELECT * FROM xtu_withdrawals WHERE id=? LIMIT 1 FOR UPDATE", [String(row.id)]);
    if (!rows.length || rows[0].status === "confirmed") return;
    const current = rows[0];
    if (!["signed", "submitted"].includes(current.status)) return;

    await recordActualBscFeeTx(tx, {
      txHash: current.tx_hash,
      operation: "xtu_withdrawal",
      receipt,
      bnbUsdPrice,
    });
    const common = await getLatestCommonTx(tx, true);
    const newInactiveInitialAsset = calculateXtuWithdrawalInactiveReserve(
      common.inactive_init_asset || "0",
      current.reserved_initial_asset,
    );
    const newXtuWallets = new BigNumber(common.xtu_wallets || "0").plus(actualNetAmount);
    if (!newXtuWallets.isFinite() || newXtuWallets.isNegative()) {
      throw new Error("Confirmed XTU withdrawal requires manual reserve reconciliation because the XTU wallet ledger is invalid.");
    }

    const [date, time] = utcDateTime();
    await insertCommonSnapshotTx(tx, common, {
      inactive_init_asset: newInactiveInitialAsset.toFixed(30),
      xtu_wallets: newXtuWallets.toFixed(30),
    }, date, time);

    const [existingActivityRows] = await tx.query(
      "SELECT id FROM activities WHERE reference=? LIMIT 1 FOR UPDATE",
      [current.reference],
    );
    if (!existingActivityRows.length) {
      const combinedFees = actualGas.feeUsd.plus(actualContractFee);
      const individualPrice = new BigNumber(current.effective_unit_price);
      if (!individualPrice.isFinite() || !individualPrice.isGreaterThan(0)) {
        throw new Error("The recorded individual XTU price is invalid for the activity history.");
      }
      // activities.amount and activities.fees are stored in initial-asset units;
      // /app/transactions-history multiplies them by the saved individual price.
      await tx.query(
        `INSERT INTO activities
         (sender,receiver,type,amount,unit_price,fees,fee_unit_price,bsc_fee_cost_usd,reference,record_date,record_time)
         VALUES(?,?,5,?,?,?,?,?,?,?,?)`,
        [
          current.username,
          `${current.username}-WALLET`,
          actualNetAmount.dividedBy(individualPrice).toFixed(30),
          individualPrice.toFixed(30),
          combinedFees.dividedBy(individualPrice).toFixed(30),
          common.unit_price,
          actualGas.feeUsd.toFixed(30),
          current.reference,
          date,
          time,
        ],
      );
    }

    const now = String(Date.now());
    await tx.query(
      `UPDATE xtu_withdrawals SET status='confirmed',block_number=?,actual_gas_fee_bnb=?,actual_gas_fee_usd=?,
       actual_contract_fee_amount=?,actual_net_amount=?,confirmed_at_ms=?,last_error=NULL,
       next_attempt_at_ms=?,updated_at_ms=? WHERE id=?`,
      [
        String(receipt.blockNumber), actualGas.feeBnb.toFixed(30), actualGas.feeUsd.toFixed(30),
        actualContractFee.toFixed(18), actualNetAmount.toFixed(18), now, now, now, String(row.id),
      ],
    );
    await appendEvent(tx, current, "confirmed", "confirmed", `Confirmed ${actualNetAmount.toFixed(18)} XTU to the registered wallet.`, current.tx_hash);
    await queueTelegramMessageTx(
      tx,
      current.username,
      `xtu-withdrawal:${current.id}:confirmed`,
      [
        "OneX XTU Withdrawal Confirmed",
        `Net amount sent: ${actualNetAmount.toFixed(8)} XTU`,
        `Contract fee (0.1%): ${actualContractFee.toFixed(8)} XTU`,
        `BSC network fee: ${actualGas.feeUsd.toFixed(8)} XTU equivalent`,
        `Destination: ${current.payout_address}`,
        `Transaction: ${current.tx_hash}`,
        `Reference: ${current.reference}`,
      ].join("\n"),
    );
  });
}

async function processOne(pool, runtime) {
  const activeRows = await pool.queryAsync(
    `SELECT * FROM xtu_withdrawals
     WHERE status IN ('signed','submitted','manual_review')
     ORDER BY id ASC LIMIT 1`,
  );
  if (activeRows.length) {
    const active = activeRows[0];
    if (active.status === "manual_review") return;
    if (Number(active.next_attempt_at_ms) > Date.now()) return;
    await submitSignedTransaction(pool, active, runtime);
    return;
  }

  const rows = await pool.queryAsync(
    `SELECT * FROM xtu_withdrawals
     WHERE status='queued' AND next_attempt_at_ms<=?
     ORDER BY id ASC LIMIT 1`,
    [String(Date.now())],
  );
  if (!rows.length) return;
  const row = rows[0];
  try {
    await refreshQueuedQuote(pool, row, runtime);
    const [freshRows] = await pool.queryAsync("SELECT * FROM xtu_withdrawals WHERE id=? LIMIT 1", [String(row.id)]);
    if (!freshRows.length || freshRows[0].status !== "queued") return;
    const signed = await signQueuedWithdrawal(pool, freshRows[0], runtime);
    try {
      const sent = await runtime.provider.broadcastTransaction(signed.rawTx);
      if (String(sent.hash).toLowerCase() !== signed.txHash) {
        await markManualReview(pool, { ...freshRows[0], tx_hash: signed.txHash }, "The RPC returned a hash different from the persisted signed XTU transaction.");
        return;
      }
      await markSubmitted(pool, { ...freshRows[0], ...signed, tx_hash: signed.txHash });
    } catch (error) {
      // The raw transaction and its hash were committed before broadcast. The next cycle reconciles or rebroadcasts this exact transaction.
      await recordActiveError(pool, row.id, error.message, runtime.settings.retryMs);
    }
  } catch (error) {
    await deferWithdrawal(pool, row.id, error, runtime.settings.retryMs);
  }
}

async function startXtuWithdrawalWorker(pool) {
  if (!isXtuWorkerEnabled()) return false;
  let settings;
  try { settings = getXtuSettings(); } catch (error) {
    console.error("XTU withdrawal worker configuration is invalid:", error.message);
    return false;
  }
  if (!settings.workerEnabled) {
    console.log("XTU withdrawal worker is disabled by XTU_WITHDRAWAL_WORKER_ENABLED.");
    return false;
  }

  let runtime;
  try { runtime = await getXtuRuntime({ requireSigner: true }); } catch (error) {
    console.error("XTU withdrawal worker did not start:", error.message);
    return false;
  }

  const lockConnection = await getPoolConnection(pool);
  const lockTx = lockConnection.promise();
  const [lockRows] = await lockTx.query("SELECT GET_LOCK('onex_xtu_withdrawal_worker',0) AS acquired");
  if (Number(lockRows[0]?.acquired) !== 1) {
    lockConnection.release();
    console.log("Another OneX process already owns the XTU withdrawal worker lock.");
    return false;
  }

  let stopping = false;
  let timer = null;
  const tick = async () => {
    if (stopping) return;
    try {
      await processOne(pool, runtime);
    } catch (error) {
      console.error("XTU withdrawal worker cycle failed:", error.message);
    }
    if (!stopping) {
      timer = setTimeout(tick, runtime.settings.pollMs);
      if (typeof timer.unref === "function") timer.unref();
    }
  };
  void tick();

  const stop = async () => {
    stopping = true;
    if (timer) clearTimeout(timer);
    try { await lockTx.query("SELECT RELEASE_LOCK('onex_xtu_withdrawal_worker')"); } catch {}
    lockConnection.release();
  };
  process.once("SIGINT", () => { void stop(); });
  process.once("SIGTERM", () => { void stop(); });
  console.log("XTU withdrawal worker started with the dedicated distribution wallet.");
  return { stop };
}

module.exports = { startXtuWithdrawalWorker, processOne };

if (require.main === module) {
  const { initDbIfEmpty, db } = require("./db");
  initDbIfEmpty()
    .then(() => startXtuWithdrawalWorker(db))
    .catch((error) => {
      console.error("Standalone XTU withdrawal worker failed to initialize:", error.message);
      process.exitCode = 1;
    });
}
