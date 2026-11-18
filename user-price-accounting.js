"use strict";

const BigNumber = require("bignumber.js");
const { queueTelegramMessageTx } = require("./telegram");

BigNumber.config({ DECIMAL_PLACES: 36, ROUNDING_MODE: BigNumber.ROUND_HALF_UP });

const PRICE_DECIMALS = 30;
const INITIAL_ASSET_DECIMALS = 30;
const USER_PRICE_TRIGGER_RATIO = new BigNumber(2);
const USER_PRICE_SALE_RATIO = new BigNumber("0.5");

function finiteNonNegative(value, fieldName) {
  const number = new BigNumber(value);
  if (!number.isFinite() || number.isNegative()) {
    throw new RangeError(`${fieldName} must be finite and non-negative`);
  }
  return number;
}

function finitePositive(value, fieldName) {
  const number = finiteNonNegative(value, fieldName);
  if (!number.isGreaterThan(0)) throw new RangeError(`${fieldName} must be positive`);
  return number;
}

function calculateIndividualTargetPrice(basePriceValue, feeRateValue) {
  const basePrice = finitePositive(basePriceValue, "individual base price");
  const feeRate = finiteNonNegative(feeRateValue, "tfees rate");
  if (!feeRate.isLessThan(100)) throw new RangeError("tfees rate must be less than 100 percent");
  return basePrice.multipliedBy(
    new BigNumber(1).plus(feeRate.multipliedBy(USER_PRICE_TRIGGER_RATIO).dividedBy(100)),
  );
}

async function getLatestPriceEventIdTx(tx) {
  const [rows] = await tx.query("SELECT COALESCE(MAX(id),0) AS id FROM common_price_events");
  return String(rows[0]?.id || "0");
}

async function insertPriceCycleHistoryTx(tx, username, cycleNumber, basePrice, feeRate, targetPrice, startEventId, now) {
  await tx.query(
    `INSERT INTO user_price_cycle_history
     (username,cycle_number,base_price,tfees_rate,target_price,start_price_event_id,
      triggered_price,triggered_at_ms,trigger_balance_initial_asset,required_sale_initial_asset,
      sold_since_trigger_initial_asset,resumed_at_ms,created_at_ms,updated_at_ms)
     VALUES(?,?,?,?,?,?,NULL,NULL,NULL,NULL,'0',NULL,?,?)`,
    [
      username,
      String(cycleNumber),
      basePrice.toFixed(PRICE_DECIMALS),
      feeRate.toFixed(PRICE_DECIMALS),
      targetPrice.toFixed(PRICE_DECIMALS),
      startEventId,
      String(now),
      String(now),
    ],
  );
}

/**
 * Reset A and B after an acquisition or sale. A paused account remains paused;
 * only the 50-percent sale requirement may resume its remuneration cycle.
 */
async function resetUserPriceBasisTx(tx, username, basePriceValue, feeRateValue) {
  const basePrice = finitePositive(basePriceValue, "common.unit_price");
  const feeRate = finiteNonNegative(feeRateValue, "applied tfees rate");
  const targetPrice = calculateIndividualTargetPrice(basePrice, feeRate);
  const now = String(Date.now());
  const startEventId = await getLatestPriceEventIdTx(tx);
  const [stateRows] = await tx.query(
    `SELECT cycle_number,status FROM user_price_state
     WHERE username=? LIMIT 1 FOR UPDATE`,
    [username],
  );

  if (!stateRows.length) {
    await tx.query(
      `INSERT INTO user_price_state
       (username,cycle_number,base_price,tfees_rate,target_price,status,start_price_event_id,
        triggered_price,triggered_at_ms,trigger_balance_initial_asset,required_sale_initial_asset,
        sold_since_trigger_initial_asset,updated_at_ms,created_at_ms)
       VALUES(?,1,?,?,?,'watching',?,NULL,NULL,NULL,NULL,'0',?,?)`,
      [
        username,
        basePrice.toFixed(PRICE_DECIMALS),
        feeRate.toFixed(PRICE_DECIMALS),
        targetPrice.toFixed(PRICE_DECIMALS),
        startEventId,
        now,
        now,
      ],
    );
    await insertPriceCycleHistoryTx(tx, username, 1, basePrice, feeRate, targetPrice, startEventId, now);
    return { status: "watching", cycleNumber: 1, basePrice, targetPrice };
  }

  const currentCycle = Number(stateRows[0].cycle_number);
  if (!Number.isSafeInteger(currentCycle) || currentCycle < 1) {
    throw new Error(`Invalid individual price cycle for ${username}`);
  }

  if (stateRows[0].status === "paused") {
    await tx.query(
      `UPDATE user_price_state
       SET base_price=?,tfees_rate=?,target_price=?,start_price_event_id=?,updated_at_ms=?
       WHERE username=?`,
      [
        basePrice.toFixed(PRICE_DECIMALS),
        feeRate.toFixed(PRICE_DECIMALS),
        targetPrice.toFixed(PRICE_DECIMALS),
        startEventId,
        now,
        username,
      ],
    );
    return { status: "paused", cycleNumber: currentCycle, basePrice, targetPrice };
  }

  const nextCycle = currentCycle + 1;
  await tx.query(
    `UPDATE user_price_cycle_history
     SET resumed_at_ms=?,updated_at_ms=?
     WHERE username=? AND cycle_number=? AND resumed_at_ms IS NULL`,
    [now, now, username, String(currentCycle)],
  );
  await tx.query(
    `UPDATE user_price_state
     SET cycle_number=?,base_price=?,tfees_rate=?,target_price=?,status='watching',
         start_price_event_id=?,triggered_price=NULL,triggered_at_ms=NULL,
         trigger_balance_initial_asset=NULL,required_sale_initial_asset=NULL,
         sold_since_trigger_initial_asset='0',updated_at_ms=?
     WHERE username=?`,
    [
      String(nextCycle),
      basePrice.toFixed(PRICE_DECIMALS),
      feeRate.toFixed(PRICE_DECIMALS),
      targetPrice.toFixed(PRICE_DECIMALS),
      startEventId,
      now,
      username,
    ],
  );
  await insertPriceCycleHistoryTx(tx, username, nextCycle, basePrice, feeRate, targetPrice, startEventId, now);
  return { status: "watching", cycleNumber: nextCycle, basePrice, targetPrice };
}

async function triggerUserPriceThresholdTx(tx, username, currentPriceValue, eventId = null) {
  const currentPrice = finitePositive(currentPriceValue, "current global unit price");
  // All financial routes lock the stock row before the individual price state.
  const [stockRows] = await tx.query(
    "SELECT balance FROM users_stock WHERE username=? LIMIT 1 FOR UPDATE",
    [username],
  );
  if (!stockRows.length) return { triggered: false, reason: "stock_not_found" };
  const balance = finiteNonNegative(stockRows[0].balance, "users_stock.balance");
  if (!balance.isGreaterThan(0)) return { triggered: false, reason: "empty_balance" };

  const [stateRows] = await tx.query(
    `SELECT cycle_number,base_price,tfees_rate,target_price,status,start_price_event_id
     FROM user_price_state WHERE username=? LIMIT 1 FOR UPDATE`,
    [username],
  );
  if (!stateRows.length || stateRows[0].status !== "watching") return { triggered: false };
  const state = stateRows[0];
  if (eventId != null && BigInt(state.start_price_event_id || 0) >= BigInt(eventId)) {
    return { triggered: false, reason: "cycle_started_after_price_event" };
  }
  const targetPrice = finitePositive(state.target_price, "user_price_state.target_price");
  let effectivePrice = currentPrice;
  let effectiveEventId = eventId;
  if (eventId == null) {
    const [crossingEvents] = await tx.query(
      `SELECT id,new_price FROM common_price_events
       WHERE status='pending' AND id>? AND old_price<? AND new_price>=? AND new_price>old_price
       ORDER BY id ASC LIMIT 1`,
      [
        String(state.start_price_event_id || 0),
        targetPrice.toFixed(PRICE_DECIMALS),
        targetPrice.toFixed(PRICE_DECIMALS),
      ],
    );
    if (crossingEvents.length) {
      effectivePrice = finitePositive(crossingEvents[0].new_price, "common_price_events.new_price");
      effectiveEventId = crossingEvents[0].id;
    }
  }
  if (effectiveEventId != null && BigInt(state.start_price_event_id || 0) >= BigInt(effectiveEventId)) {
    return { triggered: false, reason: "cycle_started_after_price_event" };
  }
  if (effectivePrice.isLessThan(targetPrice)) return { triggered: false };

  const requiredSale = balance.multipliedBy(USER_PRICE_SALE_RATIO);
  const now = String(Date.now());
  const cycleNumber = String(state.cycle_number);
  const [updateResult] = await tx.query(
    `UPDATE user_price_state
     SET status='paused',triggered_price=?,triggered_at_ms=?,
         trigger_balance_initial_asset=?,required_sale_initial_asset=?,
         sold_since_trigger_initial_asset='0',updated_at_ms=?
     WHERE username=? AND status='watching'`,
    [
      effectivePrice.toFixed(PRICE_DECIMALS),
      now,
      balance.toFixed(INITIAL_ASSET_DECIMALS),
      requiredSale.toFixed(INITIAL_ASSET_DECIMALS),
      now,
      username,
    ],
  );
  if (updateResult.affectedRows !== 1) return { triggered: false, reason: "state_changed" };

  await tx.query(
    `UPDATE user_price_cycle_history
     SET triggered_price=?,triggered_at_ms=?,trigger_balance_initial_asset=?,
         required_sale_initial_asset=?,sold_since_trigger_initial_asset='0',updated_at_ms=?
     WHERE username=? AND cycle_number=? AND resumed_at_ms IS NULL`,
    [
      effectivePrice.toFixed(PRICE_DECIMALS),
      now,
      balance.toFixed(INITIAL_ASSET_DECIMALS),
      requiredSale.toFixed(INITIAL_ASSET_DECIMALS),
      now,
      username,
      cycleNumber,
    ],
  );
  await queueTelegramMessageTx(
    tx,
    username,
    `price-threshold:${username}:${cycleNumber}:reached`,
    [
      "OneX Individual Price Update",
      "The global XTU price has reached your individual remuneration threshold.",
      `Base price A: ${new BigNumber(state.base_price).toFixed(12)} XTU per initial asset`,
      `Individual threshold B: ${targetPrice.toFixed(12)} XTU per initial asset`,
      `Price reached: ${effectivePrice.toFixed(12)} XTU per initial asset`,
      "Your individual remuneration accumulation is temporarily paused.",
      `Required P2P sales: ${requiredSale.toFixed(8)} initial assets (50% of your principal balance at the trigger).`,
      "You may activate priority-seller status, which commits 50% of your principal balance, or make outgoing P2P sales. Seller activation itself does not count as a sale.",
      "After the required P2P sales are completed, a new individual price cycle starts automatically.",
    ].join("\n"),
  );
  return { triggered: true, cycleNumber: Number(cycleNumber), balance, requiredSale, targetPrice, triggeredPrice: effectivePrice };
}

async function recordUserP2PSaleTx(tx, username, soldInitialAssetValue, newPriceValue, feeRateValue) {
  const soldInitialAsset = finitePositive(soldInitialAssetValue, "P2P sale initial-asset amount");
  const newPrice = finitePositive(newPriceValue, "post-sale global unit price");
  const feeRate = finiteNonNegative(feeRateValue, "P2P fee rate");
  const [stateRows] = await tx.query(
    `SELECT cycle_number,status,tfees_rate,required_sale_initial_asset,sold_since_trigger_initial_asset
     FROM user_price_state WHERE username=? LIMIT 1 FOR UPDATE`,
    [username],
  );
  if (!stateRows.length) {
    return resetUserPriceBasisTx(tx, username, newPrice, feeRate);
  }

  const state = stateRows[0];
  // A sale changes A, but the threshold fee rate remains the rate actually
  // charged on the user's most recent acquisition.
  const appliedFeeRate = finiteNonNegative(
    state.tfees_rate == null ? feeRate : state.tfees_rate,
    "user_price_state.tfees_rate",
  );
  const now = String(Date.now());
  if (state.status !== "paused") {
    return resetUserPriceBasisTx(tx, username, newPrice, appliedFeeRate);
  }

  const requiredSale = finitePositive(state.required_sale_initial_asset, "user_price_state.required_sale_initial_asset");
  const soldSinceTrigger = finiteNonNegative(
    state.sold_since_trigger_initial_asset,
    "user_price_state.sold_since_trigger_initial_asset",
  ).plus(soldInitialAsset);
  const currentCycle = Number(state.cycle_number);
  await tx.query(
    `UPDATE user_price_cycle_history
     SET sold_since_trigger_initial_asset=?,updated_at_ms=?
     WHERE username=? AND cycle_number=? AND resumed_at_ms IS NULL`,
    [soldSinceTrigger.toFixed(INITIAL_ASSET_DECIMALS), now, username, String(currentCycle)],
  );
  await tx.query(
    `UPDATE user_price_state
     SET sold_since_trigger_initial_asset=?,updated_at_ms=?
     WHERE username=? AND status='paused'`,
    [soldSinceTrigger.toFixed(INITIAL_ASSET_DECIMALS), now, username],
  );

  if (soldSinceTrigger.isLessThan(requiredSale)) {
    await resetUserPriceBasisTx(tx, username, newPrice, appliedFeeRate);
    return {
      status: "paused",
      soldSinceTrigger,
      requiredSale,
      remainingSale: requiredSale.minus(soldSinceTrigger),
    };
  }

  await tx.query(
    `UPDATE user_price_cycle_history
     SET resumed_at_ms=?,sold_since_trigger_initial_asset=?,updated_at_ms=?
     WHERE username=? AND cycle_number=? AND resumed_at_ms IS NULL`,
    [now, soldSinceTrigger.toFixed(INITIAL_ASSET_DECIMALS), now, username, String(currentCycle)],
  );
  const [priceCycle] = await tx.query(
    `SELECT cycle_number FROM user_price_state WHERE username=? LIMIT 1 FOR UPDATE`,
    [username],
  );
  const nextCycle = Number(priceCycle[0].cycle_number) + 1;
  const targetPrice = calculateIndividualTargetPrice(newPrice, appliedFeeRate);
  const startEventId = await getLatestPriceEventIdTx(tx);
  await tx.query(
    `UPDATE user_price_state
     SET cycle_number=?,base_price=?,tfees_rate=?,target_price=?,status='watching',
         start_price_event_id=?,triggered_price=NULL,triggered_at_ms=NULL,
         trigger_balance_initial_asset=NULL,required_sale_initial_asset=NULL,
         sold_since_trigger_initial_asset='0',updated_at_ms=?
     WHERE username=?`,
    [
      String(nextCycle),
      newPrice.toFixed(PRICE_DECIMALS),
      appliedFeeRate.toFixed(PRICE_DECIMALS),
      targetPrice.toFixed(PRICE_DECIMALS),
      startEventId,
      now,
      username,
    ],
  );
  await insertPriceCycleHistoryTx(tx, username, nextCycle, newPrice, appliedFeeRate, targetPrice, startEventId, now);
  await queueTelegramMessageTx(
    tx,
    username,
    `price-threshold:${username}:${currentCycle}:resumed`,
    [
      "OneX Individual Price Update",
      "Your required P2P sales have been completed. Individual remuneration accumulation has resumed.",
      `P2P sales completed: ${soldSinceTrigger.toFixed(8)} initial assets`,
      `Required amount: ${requiredSale.toFixed(8)} initial assets`,
      `New base price A: ${newPrice.toFixed(12)} XTU per initial asset`,
      `New individual threshold B: ${targetPrice.toFixed(12)} XTU per initial asset`,
      "Status: WATCHING",
    ].join("\n"),
  );
  return { status: "watching", resumed: true, soldSinceTrigger, requiredSale, targetPrice };
}

async function initializeUserPriceStateTx(tx, username, basePriceValue, feeRateValue) {
  const [rows] = await tx.query("SELECT username FROM user_price_state WHERE username=? LIMIT 1 FOR UPDATE", [username]);
  if (rows.length) return { initialized: false };
  await resetUserPriceBasisTx(tx, username, basePriceValue, feeRateValue);
  return { initialized: true };
}

async function processPriceEventBatch(pool, batchSize = 500) {
  const connection = await new Promise((resolve, reject) => {
    pool.getConnection((error, result) => error ? reject(error) : resolve(result));
  });
  const tx = connection.promise();
  let started = false;
  try {
    await tx.beginTransaction();
    started = true;
    const [commonLockRows] = await tx.query(
      "SELECT lock_name FROM system_locks WHERE lock_name='common_state' FOR UPDATE",
    );
    if (!commonLockRows.length) throw new Error("The common-state lock row has not been initialized");
    const [eventRows] = await tx.query(
      `SELECT id,old_price,new_price,last_username
       FROM common_price_events WHERE status='pending'
       ORDER BY id ASC LIMIT 1 FOR UPDATE`,
    );
    if (!eventRows.length) {
      await tx.commit();
      started = false;
      return { processed: false };
    }

    const event = eventRows[0];
    const oldPrice = finitePositive(event.old_price, "common_price_events.old_price");
    const newPrice = finitePositive(event.new_price, "common_price_events.new_price");
    if (newPrice.isGreaterThan(oldPrice)) {
      const [candidateRows] = await tx.query(
        `SELECT username,cycle_number,target_price
         FROM user_price_state
         WHERE status='watching' AND target_price>? AND target_price<=?
           AND start_price_event_id<? AND username>?
         ORDER BY username ASC LIMIT ?`,
        [
          oldPrice.toFixed(PRICE_DECIMALS),
          newPrice.toFixed(PRICE_DECIMALS),
          String(event.id),
          String(event.last_username || ""),
          Math.max(1, Math.min(1000, Number(batchSize) || 500)),
        ],
      );

      if (candidateRows.length) {
        for (const candidate of candidateRows) {
          await triggerUserPriceThresholdTx(tx, candidate.username, newPrice, event.id);
        }
        await tx.query(
          "UPDATE common_price_events SET last_username=?,updated_at_ms=? WHERE id=?",
          [candidateRows[candidateRows.length - 1].username, String(Date.now()), event.id],
        );
      } else {
        await tx.query(
          "UPDATE common_price_events SET status='processed',processed_at_ms=?,updated_at_ms=? WHERE id=?",
          [String(Date.now()), String(Date.now()), event.id],
        );
      }
    } else {
      await tx.query(
        "UPDATE common_price_events SET status='processed',processed_at_ms=?,updated_at_ms=? WHERE id=?",
        [String(Date.now()), String(Date.now()), event.id],
      );
    }

    await tx.commit();
    started = false;
    return { processed: true, eventId: String(event.id), candidates: eventRows.length };
  } catch (error) {
    if (started) {
      try { await tx.rollback(); } catch (rollbackError) {
        console.error("Price-event rollback failed:", rollbackError.message);
      }
    }
    throw error;
  } finally {
    connection.release();
  }
}

module.exports = {
  USER_PRICE_TRIGGER_RATIO,
  USER_PRICE_SALE_RATIO,
  calculateIndividualTargetPrice,
  getLatestPriceEventIdTx,
  resetUserPriceBasisTx,
  triggerUserPriceThresholdTx,
  recordUserP2PSaleTx,
  initializeUserPriceStateTx,
  processPriceEventBatch,
};
