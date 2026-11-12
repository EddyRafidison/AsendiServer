"use strict";

const BigNumber = require("bignumber.js");

BigNumber.config({ DECIMAL_PLACES: 36, ROUNDING_MODE: BigNumber.ROUND_HALF_UP });
const { queueTelegramMessageTx } = require("./telegram");

const SELLER_MIN_RUN_BALANCE = new BigNumber("12");
const SELLER_LOCK_RATIO = new BigNumber("0.5");
const SELLER_BONUS_RATIO = new BigNumber("0.1");
const SELLER_STATUS_DURATION_MS = 7 * 24 * 60 * 60 * 1000;
const SELLER_BONUS_GRACE_MS = 24 * 60 * 60 * 1000;
const SELLER_PAYOUT_BATCH_LIMIT = new BigNumber("300");

function finiteNonNegative(value, fieldName) {
  const number = new BigNumber(value);
  if (!number.isFinite() || number.isNegative()) throw new RangeError(`${fieldName} must be finite and non-negative`);
  return number;
}

function validateSellerJoin(balanceValue, initAssetValue, runBalanceValue, pendingBonusValue) {
  const balance = finiteNonNegative(balanceValue, "users_stock.balance");
  const initAsset = finiteNonNegative(initAssetValue, "users_stock.init_asset");
  const runBalance = finiteNonNegative(runBalanceValue, "run_balance");
  const pendingBonus = finiteNonNegative(pendingBonusValue, "pending_bonus");
  if (!balance.isGreaterThan(SELLER_MIN_RUN_BALANCE)) return { eligible: false, reason: "balance_too_low" };
  if (!initAsset.isGreaterThan(0)) return { eligible: false, reason: "invalid_initial_asset_basis" };
  if (!runBalance.isGreaterThanOrEqualTo(SELLER_MIN_RUN_BALANCE)) return { eligible: false, reason: "run_balance_too_low" };
  if (runBalance.isLessThan(balance.multipliedBy(SELLER_LOCK_RATIO))) return { eligible: false, reason: "run_balance_below_half_balance" };
  if (runBalance.isGreaterThan(balance)) return { eligible: false, reason: "run_balance_exceeds_balance" };
  const requiredBonus = runBalance.multipliedBy(SELLER_BONUS_RATIO);
  if (pendingBonus.isLessThan(requiredBonus)) return { eligible: false, reason: "pending_bonus_below_threshold", requiredBonus };
  const reservedUnits = runBalance.multipliedBy(SELLER_LOCK_RATIO);
  const reservedInitAsset = initAsset.multipliedBy(reservedUnits).dividedBy(balance);
  return {
    eligible: true,
    runBalance,
    reservedUnits,
    reservedInitAsset,
    requiredBonus,
    priceValue: balance.dividedBy(initAsset),
  };
}

function sumActiveSellerReserveLots(lots) {
  return lots.reduce((sum, lot) => {
    const remaining = finiteNonNegative(lot.remaining_units, "seller lot remaining_units");
    return sum.plus(remaining);
  }, new BigNumber(0));
}

async function getActiveSellerReserveAvailableTx(tx) {
  const [rows] = await tx.query(
    `SELECT l.id,l.remaining_units
     FROM users_seller_reserve_lots l
     JOIN users_seller_campaigns c ON c.id=l.campaign_id
     WHERE l.status='active' AND c.status='active' AND l.remaining_units>0
     ORDER BY l.activated_at_ms ASC,l.id ASC
     FOR UPDATE`,
  );
  return sumActiveSellerReserveLots(rows);
}

function allocateSellerLotConsumption(lots, requestedUnits) {
  let remaining = finiteNonNegative(requestedUnits, "requested seller units");
  const allocations = [];
  let totalUnits = new BigNumber(0);
  let totalInitAsset = new BigNumber(0);
  for (const lot of lots) {
    if (remaining.isZero()) break;
    const availableUnits = finiteNonNegative(lot.remaining_units, "seller lot remaining_units");
    const availableBasis = finiteNonNegative(lot.remaining_init_asset, "seller lot remaining_init_asset");
    if (availableUnits.isZero()) continue;
    const used = BigNumber.minimum(availableUnits, remaining);
    const basis = availableBasis.multipliedBy(used).dividedBy(availableUnits);
    allocations.push({ lotId: String(lot.id), username: lot.username, units: used, initAsset: basis });
    totalUnits = totalUnits.plus(used);
    totalInitAsset = totalInitAsset.plus(basis);
    remaining = remaining.minus(used);
  }
  return {
    available: remaining.isZero(),
    requestedUnits: new BigNumber(requestedUnits),
    consumedUnits: totalUnits,
    consumedInitAsset: totalInitAsset,
    remainingUnits: remaining,
    allocations,
  };
}

function calculateSellerPayoutNet(grossValue, gasFeeValue) {
  const gross = finiteNonNegative(grossValue, "seller payout gross amount");
  const gasFee = finiteNonNegative(gasFeeValue, "seller payout gas recovery");
  const net = gross.minus(gasFee);
  if (!net.isGreaterThan(0)) throw new RangeError("Estimated BSC gas fee must be lower than the seller payout");
  return { grossAmount: gross, gasFee, payoutAmount: net };
}


async function consumeSellerReserveTx(tx, requestedUnitsValue, reference, date, time) {
  const requestedUnits = finiteNonNegative(requestedUnitsValue, "seller reserve consumption");
  if (requestedUnits.isZero()) {
    return { consumedUnits: new BigNumber(0), consumedInitAsset: new BigNumber(0), allocations: [] };
  }

  const [lotRows] = await tx.query(
    `SELECT l.id,l.campaign_id,l.username,l.remaining_units,l.remaining_init_asset,
            l.payout_pending_units,l.payout_reserved_units,c.status AS campaign_status
     FROM users_seller_reserve_lots l
     JOIN users_seller_campaigns c ON c.id=l.campaign_id
     WHERE l.status='active' AND c.status='active' AND l.remaining_units>0
     ORDER BY l.activated_at_ms ASC,l.id ASC
     FOR UPDATE`,
  );
  const allocation = allocateSellerLotConsumption(lotRows, requestedUnits);
  if (allocation.consumedUnits.isZero()) {
    return { consumedUnits: allocation.consumedUnits, consumedInitAsset: allocation.consumedInitAsset, allocations: [] };
  }

  for (const item of allocation.allocations) {
    const lot = lotRows.find((row) => String(row.id) === item.lotId);
    if (!lot) throw new Error(`Seller reserve lot ${item.lotId} disappeared during allocation`);
    const [stockRows] = await tx.query(
      "SELECT balance,init_asset FROM users_stock WHERE username=? LIMIT 1 FOR UPDATE",
      [item.username],
    );
    if (!stockRows.length) throw new Error(`Seller stock row is missing for ${item.username}`);
    const balance = finiteNonNegative(stockRows[0].balance, "seller balance");
    const initAsset = finiteNonNegative(stockRows[0].init_asset, "seller init_asset");
    if (balance.isLessThan(item.units) || initAsset.isLessThan(item.initAsset)) {
      throw new Error(`Seller ${item.username} has insufficient balance to settle consumed reserve units`);
    }

    const remainingUnits = finiteNonNegative(lot.remaining_units, "seller lot remaining units").minus(item.units);
    const remainingInitAsset = finiteNonNegative(lot.remaining_init_asset, "seller lot remaining initial assets").minus(item.initAsset);
    const newBalance = balance.minus(item.units);
    const newInitAsset = initAsset.minus(item.initAsset);
    if (remainingUnits.isNegative() || remainingInitAsset.isNegative() || newBalance.isNegative() || newInitAsset.isNegative()) {
      throw new Error(`Seller reserve consumption would make ${item.username} negative`);
    }

    await tx.query(
      `UPDATE users_seller_reserve_lots
       SET remaining_units=?,remaining_init_asset=?,payout_pending_units=payout_pending_units+?,
           status=?,updated_at_ms=? WHERE id=?`,
      [
        remainingUnits.toFixed(),
        remainingInitAsset.toFixed(),
        item.units.toFixed(),
        remainingUnits.isZero() ? "depleted" : "active",
        String(Date.now()),
        item.lotId,
      ],
    );
    await tx.query(
      "UPDATE users_stock SET balance=?,init_asset=?,record_date=?,record_time=? WHERE username=?",
      [newBalance.toFixed(), newInitAsset.toFixed(), date, time, item.username],
    );
    await tx.query(
      "UPDATE users_seller_campaigns SET sold_units=sold_units+? WHERE id=? AND status IN ('active','cancel_requested')",
      [item.units.toFixed(), lot.campaign_id],
    );
    const unitPrice = item.units.dividedBy(item.initAsset);
    const activityReference = `SELL${String(reference).slice(0, 40)}${item.lotId}`.slice(0, 64);
    await tx.query(
      `INSERT INTO activities(sender,receiver,type,amount,unit_price,fees,reference,record_date,record_time)
       VALUES(?, 'XUSER', 3, ?, ?, 0, ?, ?, ?)`,
      [item.username, item.initAsset.toFixed(), unitPrice.toFixed(), activityReference, date, time],
    );
  }

  await queueSellerPayoutBatchesTx(tx);
  return allocation;
}

async function queueSellerPayoutBatchesTx(tx) {
  const now = String(Date.now());
  for (let batchIndex = 0; batchIndex < 10; batchIndex += 1) {
    const [rows] = await tx.query(
      `SELECT l.id,l.username,l.payout_pending_units,l.payout_reserved_units,w.payout_address
       FROM users_seller_reserve_lots l
       JOIN users_usdt_deposit_wallets w ON w.username=l.username
       WHERE l.payout_pending_units>l.payout_reserved_units
         AND w.account_status='active' AND w.payout_address IS NOT NULL AND w.payout_address<>'' 
       ORDER BY l.activated_at_ms ASC,l.id ASC
       FOR UPDATE`,
    );
    const eligible = rows.map((row) => {
      const rawAvailable = new BigNumber(row.payout_pending_units).minus(row.payout_reserved_units);
      const tokenPrecisionAvailable = rawAvailable
        .shiftedBy(18)
        .integerValue(BigNumber.ROUND_DOWN)
        .shiftedBy(-18);
      return { ...row, available: tokenPrecisionAvailable };
    }).filter((row) => row.available.isGreaterThan(0));
    const availableTotal = eligible.reduce((sum, row) => sum.plus(row.available), new BigNumber(0));
    if (availableTotal.isLessThan(SELLER_PAYOUT_BATCH_LIMIT)) break;

    const grouped = new Map();
    let batchRemaining = new BigNumber(SELLER_PAYOUT_BATCH_LIMIT);
    for (const row of eligible) {
      if (batchRemaining.isZero()) break;
      const amount = BigNumber.minimum(row.available, batchRemaining);
      if (!grouped.has(row.username)) {
        grouped.set(row.username, { username: row.username, payoutAddress: row.payout_address, amount: new BigNumber(0), allocations: [] });
      }
      const seller = grouped.get(row.username);
      if (String(seller.payoutAddress).toLowerCase() !== String(row.payout_address).toLowerCase()) {
        throw new Error(`Seller ${row.username} has inconsistent payout addresses across reserve lots`);
      }
      seller.amount = seller.amount.plus(amount);
      seller.allocations.push({ lotId: String(row.id), amount });
      await tx.query(
        "UPDATE users_seller_reserve_lots SET payout_reserved_units=payout_reserved_units+?,updated_at_ms=? WHERE id=?",
        [amount.toFixed(), now, row.id],
      );
      batchRemaining = batchRemaining.minus(amount);
    }

    const [batchResult] = await tx.query(
      "INSERT INTO users_usdt_seller_payout_batches(gross_amount,status,created_at_ms,updated_at_ms) VALUES(?,'queued',?,?)",
      [SELLER_PAYOUT_BATCH_LIMIT.toFixed(18), now, now],
    );
    for (const seller of grouped.values()) {
      const [payoutResult] = await tx.query(
        `INSERT INTO users_usdt_seller_payouts
         (batch_id,username,payout_address,gross_amount,gas_fee_estimated,payout_amount,amount_raw,status,created_at_ms,updated_at_ms)
         VALUES(?,?,?,?,'0','0','0','queued',?,?)`,
        [batchResult.insertId, seller.username, seller.payoutAddress, seller.amount.toFixed(18), now, now],
      );
      for (const allocation of seller.allocations) {
        await tx.query(
          "INSERT INTO users_seller_payout_allocations(payout_id,lot_id,amount,status,created_at_ms) VALUES(?,?,?,'reserved',?)",
          [payoutResult.insertId, allocation.lotId, allocation.amount.toFixed(18), now],
        );
      }
      await queueTelegramMessageTx(
        tx,
        seller.username,
        `seller-payout:${payoutResult.insertId}:queued`,
        [
          "OneX Seller Update",
          "Your sold reserve units have reached a payout batch and are queued for BSC-USD settlement.",
          `Payout ID: ${payoutResult.insertId}`,
          `Gross amount: ${seller.amount.toFixed(8)} BSC-USD`,
          "The outgoing BSC gas fee will be deducted from your payout.",
          "Status: PROCESSING",
        ].join("\n"),
      );
    }
  }
}

async function closeExpiredSellerCampaignsTx(tx, nowMs = Date.now()) {
  const now = String(nowMs);
  // Use the common-state lock first, matching recharge, seller activation and admin unlock.
  const [lockRows] = await tx.query("SELECT lock_name FROM system_locks WHERE lock_name=? FOR UPDATE", ["common_state"]);
  if (!lockRows.length) throw new Error("The common-state lock row has not been initialized");
  const [commonRows] = await tx.query(
    "SELECT sellers_res,sellers_init_asset FROM common ORDER BY id DESC LIMIT 1 FOR UPDATE",
  );
  if (!commonRows.length) throw new Error("Common reserve is not initialized");
  const [campaigns] = await tx.query(
    `SELECT id,username,reserved_units,reserved_init_asset
     FROM users_seller_campaigns
     WHERE status IN ('active','cancel_requested') AND CAST(expires_at_ms AS UNSIGNED)<=?
     ORDER BY expires_at_ms ASC,id ASC
     FOR UPDATE`,
    [now],
  );
  if (!campaigns.length) return 0;
  const sellersRes = finiteNonNegative(commonRows[0].sellers_res, "common.sellers_res");
  const sellersInit = finiteNonNegative(commonRows[0].sellers_init_asset, "common.sellers_init_asset");
  let releaseUnits = new BigNumber(0);
  let releaseBasis = new BigNumber(0);
  for (const campaign of campaigns) {
    const [lotRows] = await tx.query(
      "SELECT id,remaining_units,remaining_init_asset FROM users_seller_reserve_lots WHERE campaign_id=? LIMIT 1 FOR UPDATE",
      [campaign.id],
    );
    if (lotRows.length) {
      releaseUnits = releaseUnits.plus(finiteNonNegative(lotRows[0].remaining_units, "seller lot remaining_units"));
      releaseBasis = releaseBasis.plus(finiteNonNegative(lotRows[0].remaining_init_asset, "seller lot remaining_init_asset"));
      await tx.query(
        "UPDATE users_seller_reserve_lots SET remaining_units=0,remaining_init_asset=0,status='expired',updated_at_ms=? WHERE id=?",
        [now, lotRows[0].id],
      );
    }
    await tx.query(
      "UPDATE users_seller_campaigns SET status='expired',closed_at_ms=?,close_reason='expired' WHERE id=? AND status IN ('active','cancel_requested')",
      [now, campaign.id],
    );
    await tx.query(
      `UPDATE users_stock SET seller_status=0,run_balance=0,seller_activated_at_ms=NULL,seller_expires_at_ms=NULL
       WHERE username=? AND seller_status IN (1,2)`,
      [campaign.username],
    );
    await queueTelegramMessageTx(tx, campaign.username, `seller-campaign:${campaign.id}:expired`, [
      "OneX Seller Update",
      "Your 7-day seller status has expired. Unused seller reserve units have been released.",
      `Campaign: ${campaign.id}`,
      "Status: EXPIRED",
    ].join("\n"));
  }
  const newSellersRes = sellersRes.minus(releaseUnits);
  const newSellersInit = sellersInit.minus(releaseBasis);
  if (newSellersRes.isNegative() || newSellersInit.isNegative()) {
    throw new Error("Seller reserve totals are inconsistent with expired campaign lots");
  }
  if (releaseUnits.isGreaterThan(0) || releaseBasis.isGreaterThan(0)) {
    const [date, time] = require("./utils").getDate();
    const current = await require("./common-accounting").getLatestCommonTx(tx, true);
    await require("./common-accounting").insertCommonSnapshotTx(tx, current, {
      sellers_res: newSellersRes.toFixed(),
      sellers_init_asset: newSellersInit.toFixed(),
    }, date, time);
  }
  return campaigns.length;
}

module.exports = {
  SELLER_MIN_RUN_BALANCE,
  SELLER_LOCK_RATIO,
  SELLER_BONUS_RATIO,
  SELLER_STATUS_DURATION_MS,
  SELLER_BONUS_GRACE_MS,
  SELLER_PAYOUT_BATCH_LIMIT,
  validateSellerJoin,
  allocateSellerLotConsumption,
  sumActiveSellerReserveLots,
  getActiveSellerReserveAvailableTx,
  calculateSellerPayoutNet,
  consumeSellerReserveTx,
  queueSellerPayoutBatchesTx,
  closeExpiredSellerCampaignsTx,
};
