"use strict";

const BigNumber = require("bignumber.js");
const { queueTelegramMessageTx } = require("./telegram");
const { MAX_DEFAULT_STOCK } = require("./recharge-policy");

BigNumber.config({ DECIMAL_PLACES: 36, ROUNDING_MODE: BigNumber.ROUND_HALF_UP });

const PRICE_DECIMALS = 30;
const INITIAL_ASSET_DECIMALS = 30;
const USER_PRICE_TRIGGER_RATIO = new BigNumber(3);
const MINIMUM_OPERATION_RATIO = new BigNumber("0.05");
const MAXIMUM_OPERATION_RATIO = new BigNumber(1);
const DEFAULT_MAX_STOCK_XTU = new BigNumber(MAX_DEFAULT_STOCK);

function finiteNonNegative(value, fieldName) {
  const number = new BigNumber(value);
  if (!number.isFinite() || number.isNegative()) throw new RangeError(`${fieldName} must be finite and non-negative`);
  return number;
}

function finitePositive(value, fieldName) {
  const number = finiteNonNegative(value, fieldName);
  if (!number.isGreaterThan(0)) throw new RangeError(`${fieldName} must be positive`);
  return number;
}

function calculateIndividualRemunerationRate(volumeValue, principalValue, feeRateValue) {
  const volume = finitePositive(volumeValue, "eligible operation volume");
  const principal = finitePositive(principalValue, "principal before eligible operation");
  const feeRate = finiteNonNegative(feeRateValue, "operation tfees rate");
  if (!feeRate.isLessThan(100)) throw new RangeError("tfees rate must be less than 100 percent");
  const normalizedVolume = BigNumber.minimum(
    MAXIMUM_OPERATION_RATIO,
    volume.multipliedBy(2).dividedBy(principal),
  );
  return USER_PRICE_TRIGGER_RATIO.multipliedBy(feeRate).multipliedBy(normalizedVolume);
}

function calculateIndividualTargetPrice(basePriceValue, remunerationRateValue) {
  const basePrice = finitePositive(basePriceValue, "individual base price");
  const remunerationRate = finiteNonNegative(remunerationRateValue, "individual remuneration rate");
  return basePrice.multipliedBy(new BigNumber(1).plus(remunerationRate.dividedBy(100)));
}

function calculateEffectiveIndividualPrice(state, balanceValue, globalPriceValue, maximumXtuValue = DEFAULT_MAX_STOCK_XTU) {
  const balance = finiteNonNegative(balanceValue, "initial-asset balance");
  const globalPrice = finitePositive(globalPriceValue, "global unit price");
  const maximumXtu = finitePositive(maximumXtuValue, "maximum user stock");
  if (balance.isZero()) return { price: globalPrice, status: "watching", cappedBy: null, targetPrice: null, capPrice: null };
  const targetPrice = state ? finitePositive(state.target_price, "individual target price") : globalPrice;
  const capPrice = maximumXtu.dividedBy(balance);
  const stateStatus = String(state?.status || "watching");

  if (stateStatus === "paused") {
    const frozen = finitePositive(state.frozen_price || state.triggered_price || targetPrice, "paused individual price");
    return { price: frozen, status: "paused", cappedBy: "target", targetPrice, capPrice };
  }
  if (stateStatus === "capped") {
    const frozen = finitePositive(state.frozen_price || capPrice, "capped individual price");
    return { price: frozen, status: "capped", cappedBy: "maximum_user_stock", targetPrice, capPrice };
  }

  const effectivePrice = BigNumber.minimum(globalPrice, targetPrice, capPrice);
  const cappedBy = effectivePrice.eq(capPrice) && capPrice.lte(globalPrice) && capPrice.lte(targetPrice)
    ? "maximum_user_stock"
    : (effectivePrice.eq(targetPrice) && targetPrice.lte(globalPrice) ? "target" : null);
  return { price: effectivePrice, status: cappedBy === "maximum_user_stock" ? "capped" : (cappedBy === "target" ? "paused" : "watching"), cappedBy, targetPrice, capPrice };
}

async function getLatestPriceEventIdTx(tx) {
  const [rows] = await tx.query("SELECT COALESCE(MAX(id),0) AS id FROM common_price_events");
  return String(rows[0]?.id || "0");
}

async function insertPriceCycleHistoryTx(tx, username, cycleNumber, basePrice, feeRate, remunerationRate, targetPrice, startEventId, now) {
  await tx.query(
    `INSERT INTO user_price_cycle_history
     (username,cycle_number,base_price,tfees_rate,remuneration_rate,target_price,start_price_event_id,
      triggered_price,triggered_at_ms,principal_before_operation,operation_direction,operation_volume_initial_asset,
      resumed_at_ms,resume_reason,created_at_ms,updated_at_ms)
     VALUES(?,?,?,?,?,?,?,NULL,NULL,NULL,NULL,'0',NULL,NULL,?,?)`,
    [username, String(cycleNumber), basePrice.toFixed(PRICE_DECIMALS), feeRate.toFixed(PRICE_DECIMALS),
      remunerationRate.toFixed(PRICE_DECIMALS), targetPrice.toFixed(PRICE_DECIMALS), startEventId, String(now), String(now)],
  );
}

async function closePriceCycleHistoryTx(tx, username, cycleNumber, now, reason) {
  const [result] = await tx.query(
    `UPDATE user_price_cycle_history SET resumed_at_ms=?,resume_reason=?,updated_at_ms=?
     WHERE username=? AND cycle_number=? AND resumed_at_ms IS NULL`,
    [String(now), reason, String(now), username, String(cycleNumber)],
  );
  if (Number(result.affectedRows || 0) !== 1) throw new Error(`Active individual price history is missing for ${username}, cycle ${cycleNumber}`);
}

async function startNextPriceCycleTx(tx, username, currentCycle, basePrice, feeRate, remunerationRate, targetPrice, startEventId, now, reason) {
  const nextCycle = Number(currentCycle) + 1;
  if (!Number.isSafeInteger(nextCycle) || nextCycle < 2) throw new Error(`Invalid next individual price cycle for ${username}`);
  await closePriceCycleHistoryTx(tx, username, currentCycle, now, reason);
  const [stateUpdate] = await tx.query(
    `UPDATE user_price_state SET cycle_number=?,base_price=?,tfees_rate=?,remuneration_rate=?,target_price=?,
       status='watching',start_price_event_id=?,triggered_price=NULL,triggered_at_ms=NULL,frozen_price=NULL,
       sale_group_base_initial_asset=NULL,sale_group_volume_initial_asset='0',sale_group_fee_weighted='0',
       purchase_group_base_initial_asset=NULL,purchase_group_volume_initial_asset='0',purchase_group_fee_weighted='0',
       updated_at_ms=? WHERE username=?`,
    [String(nextCycle), basePrice.toFixed(PRICE_DECIMALS), feeRate.toFixed(PRICE_DECIMALS),
      remunerationRate.toFixed(PRICE_DECIMALS), targetPrice.toFixed(PRICE_DECIMALS), String(startEventId), String(now), username],
  );
  if (Number(stateUpdate.affectedRows || 0) !== 1) throw new Error(`Individual price state could not advance for ${username}`);
  await insertPriceCycleHistoryTx(tx, username, nextCycle, basePrice, feeRate, remunerationRate, targetPrice, startEventId, now);
  return nextCycle;
}

async function initializeUserPriceStateTx(tx, username, basePriceValue, feeRateValue) {
  const [existing] = await tx.query("SELECT username FROM user_price_state WHERE username=? LIMIT 1 FOR UPDATE", [username]);
  if (existing.length) return { initialized: false };
  const basePrice = finitePositive(basePriceValue, "initial global unit price");
  const feeRate = finiteNonNegative(feeRateValue, "initial tfees rate");
  const remunerationRate = USER_PRICE_TRIGGER_RATIO.multipliedBy(feeRate);
  const targetPrice = calculateIndividualTargetPrice(basePrice, remunerationRate);
  const now = String(Date.now());
  const startEventId = await getLatestPriceEventIdTx(tx);
  await tx.query(
    `INSERT INTO user_price_state
     (username,cycle_number,base_price,tfees_rate,remuneration_rate,target_price,status,start_price_event_id,
      triggered_price,triggered_at_ms,frozen_price,sale_group_base_initial_asset,sale_group_volume_initial_asset,
      sale_group_fee_weighted,purchase_group_base_initial_asset,purchase_group_volume_initial_asset,
      purchase_group_fee_weighted,updated_at_ms,created_at_ms)
     VALUES(?,1,?,?,?,?,'watching',?,NULL,NULL,NULL,NULL,'0','0',NULL,'0','0',?,?)`,
    [username, basePrice.toFixed(PRICE_DECIMALS), feeRate.toFixed(PRICE_DECIMALS), remunerationRate.toFixed(PRICE_DECIMALS),
      targetPrice.toFixed(PRICE_DECIMALS), startEventId, now, now],
  );
  await insertPriceCycleHistoryTx(tx, username, 1, basePrice, feeRate, remunerationRate, targetPrice, startEventId, now);
  return { initialized: true, status: "watching", cycleNumber: 1, basePrice, remunerationRate, targetPrice };
}

async function getUserPriceStateTx(tx, username, lock = false) {
  const [rows] = await tx.query(
    `SELECT * FROM user_price_state WHERE username=? LIMIT 1${lock ? " FOR UPDATE" : ""}`,
    [username],
  );
  return rows[0] || null;
}

async function getUserIndividualPriceTx(tx, username, balanceValue, globalPriceValue, lock = false) {
  let state = await getUserPriceStateTx(tx, username, lock);
  if (!state) {
    await initializeUserPriceStateTx(tx, username, globalPriceValue, 0);
    state = await getUserPriceStateTx(tx, username, lock);
  }
  return { state, ...calculateEffectiveIndividualPrice(state, balanceValue, globalPriceValue) };
}

function previewUserOperationCapacity(state, direction, volumeValue, principalBeforeValue, projectedBalanceValue, globalPriceValue) {
  const operationDirection = String(direction);
  if (!["purchase", "sale"].includes(operationDirection)) throw new RangeError("Operation direction must be purchase or sale");
  const volume = finitePositive(volumeValue, "eligible operation volume");
  const principalBefore = finiteNonNegative(principalBeforeValue, "principal before operation");
  const projectedBalance = finiteNonNegative(projectedBalanceValue, "projected principal balance");
  const globalPrice = finitePositive(globalPriceValue, "projected global price");
  if (!state) {
    const projectedXtu = projectedBalance.multipliedBy(globalPrice);
    return {
      allowed: operationDirection === "sale" || projectedXtu.lte(DEFAULT_MAX_STOCK_XTU),
      price: globalPrice,
      startsCycle: true,
      projectedXtu,
    };
  }
  const isSale = operationDirection === "sale";
  if (!isSale && state.status === "capped") {
    const frozenPrice = finitePositive(state.frozen_price || state.triggered_price, "capped individual price");
    const projectedXtu = projectedBalance.multipliedBy(frozenPrice);
    return {
      allowed: false,
      reason: "account_capped_requires_sale",
      price: frozenPrice,
      startsCycle: false,
      projectedXtu,
      stateStatus: state.status,
    };
  }
  const baseField = isSale ? "sale_group_base_initial_asset" : "purchase_group_base_initial_asset";
  const volumeField = isSale ? "sale_group_volume_initial_asset" : "purchase_group_volume_initial_asset";
  const existingVolume = finiteNonNegative(state[volumeField] || "0", `user_price_state.${volumeField}`);
  const groupBase = existingVolume.gt(0) ? finitePositive(state[baseField], `user_price_state.${baseField}`) : (principalBefore.gt(0) ? principalBefore : volume);
  const groupedVolume = existingVolume.plus(volume);
  const startsCycle = (!isSale && principalBefore.isZero()) || groupedVolume.gte(groupBase.multipliedBy(MINIMUM_OPERATION_RATIO));

  let price;
  if (startsCycle) {
    price = globalPrice;
  } else if (state.status === "paused" || state.status === "capped") {
    price = calculateEffectiveIndividualPrice(state, projectedBalance, globalPrice).price;
  } else {
    // Do not apply the 300 XTU clamp before checking capacity: doing so would
    // turn every over-limit projection into exactly 300 XTU and incorrectly allow it.
    const targetPrice = finitePositive(state.target_price, "user_price_state.target_price");
    price = BigNumber.minimum(globalPrice, targetPrice);
  }
  const projectedXtu = projectedBalance.multipliedBy(price);
  // A sale must remain possible above the cap so the user can reduce the balance.
  // Purchases are accepted only when their effective projected valuation stays within 300 XTU.
  const allowed = isSale || projectedXtu.lte(DEFAULT_MAX_STOCK_XTU);
  return { allowed, price, startsCycle, projectedXtu, stateStatus: state.status };
}

async function previewUserOperationCapacityTx(tx, username, direction, volumeValue, principalBeforeValue, projectedBalanceValue, globalPriceValue) {
  const state = await getUserPriceStateTx(tx, username, true);
  return previewUserOperationCapacity(state, direction, volumeValue, principalBeforeValue, projectedBalanceValue, globalPriceValue);
}

async function triggerUserPriceThresholdTx(tx, username, currentPriceValue, eventId = null, balanceOverrideValue = null) {
  const currentPrice = finitePositive(currentPriceValue, "current global unit price");
  const [stockRows] = await tx.query("SELECT balance FROM users_stock WHERE username=? LIMIT 1 FOR UPDATE", [username]);
  if (!stockRows.length) return { triggered: false, reason: "account_not_found" };
  const balance = balanceOverrideValue == null
    ? finiteNonNegative(stockRows[0].balance, "users_stock.balance")
    : finiteNonNegative(balanceOverrideValue, "threshold principal override");
  if (balance.isZero()) return { triggered: false, reason: "empty_balance" };
  const state = await getUserPriceStateTx(tx, username, true);
  if (!state || state.status !== "watching") return { triggered: false, reason: state?.status || "state_missing" };

  const targetPrice = finitePositive(state.target_price, "user_price_state.target_price");
  const capPrice = DEFAULT_MAX_STOCK_XTU.dividedBy(balance);
  const limitPrice = BigNumber.minimum(targetPrice, capPrice);
  if (currentPrice.lt(limitPrice)) return { triggered: false, reason: "below_threshold", targetPrice, capPrice };

  const basePrice = finitePositive(state.base_price, "user_price_state.base_price");
  const alreadyAboveCapAtCycleStart = capPrice.lt(basePrice);
  const status = targetPrice.lt(capPrice) ? "paused" : "capped";
  // Fresh cycles cannot start above the cap. This branch protects any account
  // already over the ceiling when the rule is first evaluated: freeze its
  // current recognized price instead of repricing its existing balance down to 300.
  const frozenPrice = status === "paused"
    ? targetPrice
    : (alreadyAboveCapAtCycleStart ? currentPrice : capPrice);
  const now = String(Date.now());
  const [update] = await tx.query(
    `UPDATE user_price_state SET status=?,triggered_price=?,triggered_at_ms=?,frozen_price=?,updated_at_ms=?
     WHERE username=? AND cycle_number=? AND status='watching'`,
    [status, frozenPrice.toFixed(PRICE_DECIMALS), now, frozenPrice.toFixed(PRICE_DECIMALS), now, username, String(state.cycle_number)],
  );
  if (Number(update.affectedRows || 0) !== 1) return { triggered: false, reason: "state_changed" };
  await tx.query(
    `UPDATE user_price_cycle_history SET triggered_price=?,triggered_at_ms=?,updated_at_ms=?
     WHERE username=? AND cycle_number=? AND resumed_at_ms IS NULL`,
    [frozenPrice.toFixed(PRICE_DECIMALS), now, now, username, String(state.cycle_number)],
  );

  const message = status === "paused"
    ? [
      "OneX Individual Remuneration Update",
      "Your individual remuneration target has been reached.",
      `Principal balance: ${balance.toFixed(8)} initial assets`,
      `Base price A: ${new BigNumber(state.base_price).toFixed(12)} XTU per initial asset`,
      `Individual remuneration rate C: ${new BigNumber(state.remuneration_rate).toFixed(8)}%`,
      `Target price B: ${targetPrice.toFixed(12)} XTU per initial asset`,
      "Your individual valuation is now capped at B. Complete eligible purchases or sales totaling at least 5% of the principal to start a new remuneration cycle.",
      "Partial operations of the same type are grouped until the 5% minimum is reached.",
    ].join("\n")
    : [
      "OneX Account Limit Update",
      alreadyAboveCapAtCycleStart
        ? "Your account was already above the 300 XTU ceiling when this limit was evaluated. Its existing recognized price has been preserved; no retroactive downward repricing has been applied."
        : "Your individual account valuation has reached the 300 XTU maximum.",
      `Principal balance: ${balance.toFixed(8)} initial assets`,
      `Frozen individual price: ${frozenPrice.toFixed(12)} XTU per initial asset`,
      "Further remuneration accumulation is stopped. Purchases are unavailable while capped. A new remuneration cycle can start after eligible sales bring the projected global valuation below 300 XTU and the 5% operation minimum is met.",
    ].join("\n");
  await queueTelegramMessageTx(tx, username, `price-threshold:${username}:${state.cycle_number}:${status}`, message);
  return { triggered: true, status, cycleNumber: Number(state.cycle_number), balance, targetPrice, capPrice, triggeredPrice: frozenPrice, eventId };
}

async function recordUserOperationTx(tx, username, direction, volumeValue, principalBeforeValue, newBalanceValue, newGlobalPriceValue, feeRateValue, reference = "") {
  const operationDirection = String(direction);
  if (!(["purchase", "sale"].includes(operationDirection))) throw new RangeError("Operation direction must be purchase or sale");
  const volume = finitePositive(volumeValue, "eligible operation volume");
  const principalBefore = finiteNonNegative(principalBeforeValue, "principal before operation");
  const newBalance = finiteNonNegative(newBalanceValue, "principal after operation");
  const newGlobalPrice = finitePositive(newGlobalPriceValue, "post-operation global unit price");
  const feeRate = finiteNonNegative(feeRateValue, "actual operation tfees rate");
  if (!feeRate.isLessThan(100)) throw new RangeError("tfees rate must be less than 100 percent");

  await initializeUserPriceStateTx(tx, username, newGlobalPrice, feeRate);
  const state = await getUserPriceStateTx(tx, username, true);
  const now = String(Date.now());
  const isSale = operationDirection === "sale";
  const baseField = isSale ? "sale_group_base_initial_asset" : "purchase_group_base_initial_asset";
  const volumeField = isSale ? "sale_group_volume_initial_asset" : "purchase_group_volume_initial_asset";
  const weightedField = isSale ? "sale_group_fee_weighted" : "purchase_group_fee_weighted";
  const existingVolume = finiteNonNegative(state[volumeField] || "0", `user_price_state.${volumeField}`);
  const groupBase = existingVolume.isGreaterThan(0)
    ? finitePositive(state[baseField], `user_price_state.${baseField}`)
    : (principalBefore.isGreaterThan(0) ? principalBefore : volume);
  const groupVolume = existingVolume.plus(volume);
  const previousWeighted = finiteNonNegative(state[weightedField] || "0", `user_price_state.${weightedField}`);
  const feeWeighted = previousWeighted.plus(volume.multipliedBy(feeRate));
  const firstAcquisition = !isSale && principalBefore.isZero();
  const requiredVolume = groupBase.multipliedBy(MINIMUM_OPERATION_RATIO);
  const eligible = firstAcquisition || groupVolume.gte(requiredVolume);

  if (!eligible) {
    await tx.query(
      `UPDATE user_price_state SET ${baseField}=?,${volumeField}=?,${weightedField}=?,updated_at_ms=? WHERE username=?`,
      [groupBase.toFixed(INITIAL_ASSET_DECIMALS), groupVolume.toFixed(INITIAL_ASSET_DECIMALS),
        feeWeighted.toFixed(PRICE_DECIMALS), now, username],
    );
    await tx.query(
      `UPDATE user_price_cycle_history SET principal_before_operation=COALESCE(principal_before_operation,?),
       operation_direction=COALESCE(operation_direction,?),operation_volume_initial_asset=operation_volume_initial_asset+?,updated_at_ms=?
       WHERE username=? AND cycle_number=? AND resumed_at_ms IS NULL`,
      [groupBase.toFixed(INITIAL_ASSET_DECIMALS), operationDirection,
        volume.toFixed(INITIAL_ASSET_DECIMALS), now, username, String(state.cycle_number)],
    );
    return { started: false, status: state.status, grouped: true, groupVolume, requiredVolume, direction: operationDirection };
  }

  // The first credited acquisition establishes the initial principal and receives the maximum rate.
  const referencePrincipal = firstAcquisition ? volume : groupBase;
  const totalEligibleVolume = firstAcquisition ? volume : groupVolume;
  const effectiveFeeRate = firstAcquisition
    ? feeRate
    : feeWeighted.dividedBy(groupVolume);
  const remunerationRate = firstAcquisition
    ? USER_PRICE_TRIGGER_RATIO.multipliedBy(effectiveFeeRate)
    : calculateIndividualRemunerationRate(totalEligibleVolume, referencePrincipal, effectiveFeeRate);
  const targetPrice = calculateIndividualTargetPrice(newGlobalPrice, remunerationRate);
  const currentCycle = Number(state.cycle_number);
  const startEventId = await getLatestPriceEventIdTx(tx);
  const projectedXtu = newBalance.multipliedBy(newGlobalPrice);

  if (newBalance.isGreaterThan(0) && projectedXtu.gte(DEFAULT_MAX_STOCK_XTU)) {
    // A completed group cannot restart remuneration while the projected global
    // valuation is at or above the account ceiling. If the prior cycle was
    // already frozen, preserve that recognized price rather than repricing the
    // existing balance down to 300 XTU after a partial sale.
    const priorFrozenPrice = (state.status === "paused" || state.status === "capped")
      ? finitePositive(state.frozen_price || state.triggered_price, "previous frozen individual price")
      : null;
    const capPrice = priorFrozenPrice || DEFAULT_MAX_STOCK_XTU.dividedBy(newBalance);
    await tx.query(
      `UPDATE user_price_state SET status='capped',triggered_price=?,triggered_at_ms=?,frozen_price=?,
       updated_at_ms=? WHERE username=?`,
      [capPrice.toFixed(PRICE_DECIMALS), now, capPrice.toFixed(PRICE_DECIMALS), now, username],
    );
    if (state.status !== "capped") {
      await queueTelegramMessageTx(tx, username, `price-cycle:${username}:${currentCycle}:cap-blocked`, [
        "OneX Account Limit Update",
        "Your eligible operation group has been completed, but a new remuneration cycle cannot start because the account would be valued at or above 300 XTU at the current global price.",
        `Projected valuation at the global price: ${projectedXtu.toFixed(8)} XTU`,
        `Recognized individual price remains frozen at: ${capPrice.toFixed(12)} XTU per initial asset`,
        "Continue eligible sales; same-direction sale volume remains grouped until the projected global valuation is below 300 XTU and a new cycle can start. Purchases remain unavailable while the account is capped.",
      ].join("\n"));
    }
    return { started: false, status: "capped", grouped: true, remunerationRate, reason: "maximum_user_balance" };
  }

  await startNextPriceCycleTx(
    tx, username, currentCycle, newGlobalPrice, effectiveFeeRate, remunerationRate,
    targetPrice, startEventId, now, `${operationDirection}_minimum_met`,
  );
  await queueTelegramMessageTx(tx, username, `price-cycle:${username}:${currentCycle + 1}:started:${String(reference).slice(0, 60)}`, [
    "OneX Individual Remuneration Update",
    `A qualifying ${operationDirection} group has started a new remuneration cycle.`,
    `Grouped operation volume: ${totalEligibleVolume.toFixed(8)} initial assets`,
    `Reference principal: ${referencePrincipal.toFixed(8)} initial assets`,
    `Applied tfees rate (volume-weighted): ${effectiveFeeRate.toFixed(6)}%`,
    `New base price A: ${newGlobalPrice.toFixed(12)} XTU per initial asset`,
    `New individual remuneration rate C: ${remunerationRate.toFixed(8)}%`,
    `New target price B: ${targetPrice.toFixed(12)} XTU per initial asset`,
    "Your individual valuation will follow the global XTU price until B or the 300 XTU account limit is reached.",
  ].join("\n"));
  return { started: true, status: "watching", cycleNumber: currentCycle + 1, remunerationRate, targetPrice, groupedVolume: totalEligibleVolume };
}

async function resetUserPriceBasisTx(tx, username, basePriceValue, feeRateValue, options = {}) {
  const source = String(options.source || "basis_update");
  if (source === "initialization" || source === "welcome_bonus") {
    return initializeUserPriceStateTx(tx, username, basePriceValue, feeRateValue);
  }
  if (options.direction && options.operationVolumeInitialAsset != null && options.principalBeforeInitialAsset != null) {
    return recordUserOperationTx(tx, username, options.direction, options.operationVolumeInitialAsset,
      options.principalBeforeInitialAsset, options.newBalanceInitialAsset, basePriceValue, feeRateValue, options.operationReference || "");
  }
  // Legacy callers must not silently reset an established cycle; initialise only when absent.
  return initializeUserPriceStateTx(tx, username, basePriceValue, feeRateValue);
}

async function recordUserP2PSaleTx(tx, username, soldInitialAssetValue, newPriceValue, feeRateValue, principalBeforeValue, newBalanceValue, reference) {
  return recordUserOperationTx(tx, username, "sale", soldInitialAssetValue, principalBeforeValue,
    newBalanceValue, newPriceValue, feeRateValue, reference);
}

async function recalculateWatchingPriceTargets(pool) {
  const connection = await new Promise((resolve, reject) => pool.getConnection((error, value) => error ? reject(error) : resolve(value)));
  const tx = connection.promise();
  let started = false;
  try {
    await tx.beginTransaction(); started = true;
    const [rows] = await tx.query("SELECT username,cycle_number,base_price,remuneration_rate FROM user_price_state WHERE status='watching' ORDER BY username ASC FOR UPDATE");
    const now = String(Date.now());
    for (const row of rows) {
      const target = calculateIndividualTargetPrice(row.base_price, row.remuneration_rate);
      await tx.query("UPDATE user_price_state SET target_price=?,updated_at_ms=? WHERE username=? AND status='watching'", [target.toFixed(PRICE_DECIMALS), now, row.username]);
      await tx.query("UPDATE user_price_cycle_history SET target_price=?,updated_at_ms=? WHERE username=? AND cycle_number=? AND resumed_at_ms IS NULL", [target.toFixed(PRICE_DECIMALS), now, row.username, String(row.cycle_number)]);
    }
    await tx.commit(); started = false;
    return { updated: rows.length };
  } catch (error) {
    if (started) await tx.rollback().catch((rollbackError) => console.error("Individual price recalculation rollback failed:", rollbackError.message));
    throw error;
  } finally { connection.release(); }
}

async function processPriceEventBatch(pool, batchSize = 500) {
  const connection = await new Promise((resolve, reject) => pool.getConnection((error, result) => error ? reject(error) : resolve(result)));
  const tx = connection.promise();
  let started = false;
  try {
    await tx.beginTransaction(); started = true;
    const [lockRows] = await tx.query("SELECT lock_name FROM system_locks WHERE lock_name='common_state' FOR UPDATE");
    if (!lockRows.length) throw new Error("The common-state lock row has not been initialized");
    const [eventRows] = await tx.query("SELECT id,old_price,new_price,last_username FROM common_price_events WHERE status='pending' ORDER BY id ASC LIMIT 1 FOR UPDATE");
    if (!eventRows.length) { await tx.commit(); started = false; return { processed: false }; }
    const event = eventRows[0];
    const oldPrice = finitePositive(event.old_price, "common_price_events.old_price");
    const newPrice = finitePositive(event.new_price, "common_price_events.new_price");
    let candidateCount = 0;
    if (newPrice.gt(oldPrice)) {
      const [candidateRows] = await tx.query(
        `SELECT p.username FROM user_price_state p JOIN users_stock u ON u.username=p.username
         WHERE p.status='watching' AND p.start_price_event_id<? AND p.username>?
           AND (p.target_price>? AND p.target_price<=?
             OR (u.balance>0 AND u.balance*?>= ? AND u.balance*?<?))
         ORDER BY p.username ASC LIMIT ?`,
        [String(event.id), String(event.last_username || ""), oldPrice.toFixed(PRICE_DECIMALS), newPrice.toFixed(PRICE_DECIMALS),
          newPrice.toFixed(PRICE_DECIMALS), DEFAULT_MAX_STOCK_XTU.toFixed(PRICE_DECIMALS), oldPrice.toFixed(PRICE_DECIMALS),
          DEFAULT_MAX_STOCK_XTU.toFixed(PRICE_DECIMALS), Math.max(1, Math.min(1000, Number(batchSize) || 500))],
      );
      candidateCount = candidateRows.length;
      if (candidateRows.length) {
        for (const candidate of candidateRows) await triggerUserPriceThresholdTx(tx, candidate.username, newPrice, event.id);
        await tx.query("UPDATE common_price_events SET last_username=?,updated_at_ms=? WHERE id=?", [candidateRows[candidateRows.length - 1].username, String(Date.now()), event.id]);
      } else {
        await tx.query("UPDATE common_price_events SET status='processed',processed_at_ms=?,updated_at_ms=? WHERE id=?", [String(Date.now()), String(Date.now()), event.id]);
      }
    } else {
      await tx.query("UPDATE common_price_events SET status='processed',processed_at_ms=?,updated_at_ms=? WHERE id=?", [String(Date.now()), String(Date.now()), event.id]);
    }
    await tx.commit(); started = false;
    return { processed: true, eventId: String(event.id), candidates: candidateCount };
  } catch (error) {
    if (started) await tx.rollback().catch((rollbackError) => console.error("Price-event rollback failed:", rollbackError.message));
    throw error;
  } finally { connection.release(); }
}

module.exports = {
  USER_PRICE_TRIGGER_RATIO,
  MINIMUM_OPERATION_RATIO,
  calculateIndividualRemunerationRate,
  calculateIndividualTargetPrice,
  calculateEffectiveIndividualPrice,
  getUserPriceStateTx,
  getUserIndividualPriceTx,
  previewUserOperationCapacity,
  previewUserOperationCapacityTx,
  getLatestPriceEventIdTx,
  initializeUserPriceStateTx,
  resetUserPriceBasisTx,
  triggerUserPriceThresholdTx,
  recordUserOperationTx,
  recordUserP2PSaleTx,
  processPriceEventBatch,
  recalculateWatchingPriceTargets,
};
