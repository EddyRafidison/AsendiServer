"use strict";

const BigNumber = require("bignumber.js");

BigNumber.config({ DECIMAL_PLACES: 36, ROUNDING_MODE: BigNumber.ROUND_HALF_UP });
const { queueTelegramMessageTx } = require("./telegram");
const { markPendingRechargeBatchesDueTx } = require("./recharge-retry");

// The public minimum is expressed in XTU. Stored campaign and reserve amounts
// are initial assets and are converted using the global price at campaign entry.
const SELLER_MIN_RUN_BALANCE = new BigNumber("10");
const SELLER_LOCK_RATIO = new BigNumber("0.5");
const SELLER_STATUS_DURATION_MS = 7 * 24 * 60 * 60 * 1000;
const SELLER_PAYOUT_BATCH_LIMIT = new BigNumber("300"); // BSC-USD gross payout value.
const DB_ASSET_DECIMALS = 30;
const TOKEN_DECIMALS = 18;

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

function validateSellerJoin(balanceInitialValue, unitPriceValue, thresholdReached) {
  const balanceInitial = finiteNonNegative(balanceInitialValue, "users_stock.balance");
  const unitPrice = finitePositive(unitPriceValue, "common.unit_price");
  if (thresholdReached !== true) return { eligible: false, reason: "price_threshold_not_reached" };
  const balanceXtu = balanceInitial.multipliedBy(unitPrice);
  if (balanceXtu.isLessThan(SELLER_MIN_RUN_BALANCE)) {
    return { eligible: false, reason: "balance_too_low", minimumBalanceXtu: SELLER_MIN_RUN_BALANCE };
  }
  const runBalanceInitial = balanceInitial;
  const reservedInitialAsset = balanceInitial.multipliedBy(SELLER_LOCK_RATIO);
  return {
    eligible: true,
    runBalanceInitial,
    runBalanceXtu: balanceXtu,
    reservedInitialAsset,
    balanceXtu,
    unitPrice,
  };
}

function sumActiveSellerReserveLots(lots) {
  return lots.reduce(
    (sum, lot) => sum.plus(finiteNonNegative(lot.remaining_initial_asset, "seller lot remaining initial assets")),
    new BigNumber(0),
  );
}

async function getActiveSellerReserveAvailableTx(tx, excludedUsername = null) {
  const exclude = typeof excludedUsername === "string" && excludedUsername.length > 0;
  const [rows] = await tx.query(
    `SELECT l.id,l.remaining_initial_asset
     FROM users_seller_reserve_lots l
     JOIN users_seller_campaigns c ON c.id=l.campaign_id
     WHERE l.status='active' AND c.status='active' AND l.remaining_initial_asset>0
       ${exclude ? "AND l.username<>?" : ""}
     ORDER BY l.activated_at_ms ASC,l.id ASC
     FOR UPDATE`,
    exclude ? [excludedUsername] : [],
  );
  return sumActiveSellerReserveLots(rows);
}

function allocateSellerLotConsumption(lots, requestedInitialAssetValue) {
  let remaining = finiteNonNegative(requestedInitialAssetValue, "requested seller initial assets");
  const allocations = [];
  let totalInitialAsset = new BigNumber(0);
  for (const lot of lots) {
    if (remaining.isZero()) break;
    const available = finiteNonNegative(lot.remaining_initial_asset, "seller lot remaining initial assets");
    if (available.isZero()) continue;
    const consumed = BigNumber.minimum(available, remaining);
    allocations.push({
      lotId: String(lot.id),
      username: lot.username,
      initialAsset: consumed,
      unitPrice: finitePositive(lot.unit_price, "seller lot unit_price"),
    });
    totalInitialAsset = totalInitialAsset.plus(consumed);
    remaining = remaining.minus(consumed);
  }
  return {
    available: remaining.isZero(),
    requestedInitialAsset: new BigNumber(requestedInitialAssetValue),
    consumedInitialAsset: totalInitialAsset,
    remainingInitialAsset: remaining,
    allocations,
  };
}

function calculateSellerPayoutGrossAtLockedPrice(initialAssetValue, lockedUnitPriceValue) {
  const initialAsset = finiteNonNegative(initialAssetValue, "seller payout initial assets");
  const lockedUnitPrice = finitePositive(lockedUnitPriceValue, "seller request locked unit price");
  return initialAsset.multipliedBy(lockedUnitPrice)
    .decimalPlaces(TOKEN_DECIMALS, BigNumber.ROUND_DOWN);
}

function calculateSellerPayoutNet(grossValue, gasFeeValue) {
  const gross = finiteNonNegative(grossValue, "seller payout gross amount");
  const gasFee = finiteNonNegative(gasFeeValue, "seller payout gas recovery");
  const net = gross.minus(gasFee);
  if (!net.isGreaterThan(0)) throw new RangeError("Estimated BSC gas fee must be lower than the seller payout");
  return { grossAmount: gross, gasFee, payoutAmount: net };
}

async function consumeSellerReserveTx(tx, requestedInitialAssetValue, reference, date, time, excludedUsername = null) {
  const requestedInitialAsset = finiteNonNegative(requestedInitialAssetValue, "seller reserve consumption");
  if (requestedInitialAsset.isZero()) {
    return { consumedInitialAsset: new BigNumber(0), allocations: [] };
  }

  const [lotRows] = await tx.query(
    `SELECT l.id,l.campaign_id,l.username,l.remaining_initial_asset,l.unit_price,
            l.payout_pending_initial_asset,l.payout_reserved_initial_asset,c.status AS campaign_status
     FROM users_seller_reserve_lots l
     JOIN users_seller_campaigns c ON c.id=l.campaign_id
     WHERE l.status='active' AND c.status='active' AND l.remaining_initial_asset>0
       AND (? IS NULL OR l.username<>?)
     ORDER BY l.activated_at_ms ASC,l.id ASC
     FOR UPDATE`,
    [excludedUsername, excludedUsername],
  );
  const allocation = allocateSellerLotConsumption(lotRows, requestedInitialAsset);
  if (!allocation.available) {
    throw new Error("The active seller reserve cannot cover the requested initial-asset amount");
  }

  for (const item of allocation.allocations) {
    const lot = lotRows.find((row) => String(row.id) === item.lotId);
    if (!lot) throw new Error(`Seller reserve lot ${item.lotId} disappeared during allocation`);
    const [stockRows] = await tx.query(
      "SELECT balance FROM users_stock WHERE username=? LIMIT 1 FOR UPDATE",
      [item.username],
    );
    if (!stockRows.length) throw new Error(`Seller stock row is missing for ${item.username}`);
    const balance = finiteNonNegative(stockRows[0].balance, "seller balance");
    if (balance.isLessThan(item.initialAsset)) {
      throw new Error(`Seller ${item.username} has insufficient initial-asset balance to settle consumed reserve assets`);
    }

    const remainingInitialAsset = finiteNonNegative(lot.remaining_initial_asset, "seller lot remaining initial assets").minus(item.initialAsset);
    const pendingInitialAsset = finiteNonNegative(lot.payout_pending_initial_asset, "seller payout pending initial assets").plus(item.initialAsset);
    const newBalance = balance.minus(item.initialAsset);
    if (remainingInitialAsset.isNegative() || newBalance.isNegative()) {
      throw new Error(`Seller reserve consumption would make ${item.username} negative`);
    }

    await tx.query(
      `UPDATE users_seller_reserve_lots
       SET remaining_initial_asset=?,payout_pending_initial_asset=?,status=?,updated_at_ms=?
       WHERE id=?`,
      [
        remainingInitialAsset.toFixed(DB_ASSET_DECIMALS),
        pendingInitialAsset.toFixed(DB_ASSET_DECIMALS),
        remainingInitialAsset.isZero() ? "depleted" : "active",
        String(Date.now()),
        item.lotId,
      ],
    );
    await tx.query(
      "UPDATE users_stock SET balance=?,record_date=?,record_time=? WHERE username=?",
      [newBalance.toFixed(DB_ASSET_DECIMALS), date, time, item.username],
    );
    await markPendingRechargeBatchesDueTx(tx, item.username);
    await tx.query(
      "UPDATE users_seller_campaigns SET sold_initial_asset=sold_initial_asset+? WHERE id=? AND status IN ('active','cancel_requested')",
      [item.initialAsset.toFixed(DB_ASSET_DECIMALS), lot.campaign_id],
    );
    const activityReference = `SELL${String(reference).slice(0, 40)}${item.lotId}`.slice(0, 64);
    await tx.query(
      `INSERT INTO activities(sender,receiver,type,amount,unit_price,fees,reference,record_date,record_time)
       VALUES(?, 'XUSER', 3, ?, ?, 0, ?, ?, ?)`,
      [item.username, item.initialAsset.toFixed(DB_ASSET_DECIMALS), item.unitPrice.toFixed(30), activityReference, date, time],
    );
  }

  await queueSellerPayoutBatchesTx(tx);
  return allocation;
}

async function queueSellerPayoutBatchesTx(tx) {
  const now = String(Date.now());
  for (let batchIndex = 0; batchIndex < 10; batchIndex += 1) {
    const [rows] = await tx.query(
      `SELECT l.id,l.username,l.payout_pending_initial_asset,l.payout_reserved_initial_asset,
              l.unit_price,a.wallet_address AS payout_address
       FROM users_seller_reserve_lots l
       JOIN auths a ON a.username=l.username
       WHERE l.payout_pending_initial_asset>l.payout_reserved_initial_asset
         AND a.account_active=1 AND a.wallet_address IS NOT NULL AND a.wallet_address<>''
       ORDER BY l.activated_at_ms ASC,l.id ASC
       FOR UPDATE`,
    );
    const eligible = rows.map((row) => {
      const rawInitial = new BigNumber(row.payout_pending_initial_asset).minus(row.payout_reserved_initial_asset);
      const price = finitePositive(row.unit_price, "seller payout locked unit price");
      const availableInitialAsset = rawInitial.shiftedBy(DB_ASSET_DECIMALS)
        .integerValue(BigNumber.ROUND_DOWN).shiftedBy(-DB_ASSET_DECIMALS);
      // The lot price was frozen when the seller submitted the campaign request.
      // Never revalue this seller liability using the price at payout time.
      const grossAvailable = calculateSellerPayoutGrossAtLockedPrice(availableInitialAsset, price);
      return { ...row, price, availableInitialAsset, grossAvailable };
    }).filter((row) => row.availableInitialAsset.isGreaterThan(0) && row.grossAvailable.isGreaterThan(0));
    const availableGrossTotal = eligible.reduce((sum, row) => sum.plus(row.grossAvailable), new BigNumber(0));
    if (availableGrossTotal.isLessThan(SELLER_PAYOUT_BATCH_LIMIT)) break;

    const grouped = new Map();
    let batchRemainingUsd = new BigNumber(SELLER_PAYOUT_BATCH_LIMIT);
    for (const row of eligible) {
      if (batchRemainingUsd.isZero()) break;
      const maxInitialByBatch = batchRemainingUsd.dividedBy(row.price);
      let initialAssetAmount = BigNumber.minimum(row.availableInitialAsset, maxInitialByBatch)
        .decimalPlaces(DB_ASSET_DECIMALS, BigNumber.ROUND_DOWN);
      let grossAmount = calculateSellerPayoutGrossAtLockedPrice(initialAssetAmount, row.price);
      if (!initialAssetAmount.isGreaterThan(0) || !grossAmount.isGreaterThan(0)) continue;
      if (grossAmount.isGreaterThan(batchRemainingUsd)) {
        initialAssetAmount = initialAssetAmount.minus(new BigNumber(1).shiftedBy(-DB_ASSET_DECIMALS));
        grossAmount = calculateSellerPayoutGrossAtLockedPrice(initialAssetAmount, row.price);
      }
      if (!initialAssetAmount.isGreaterThan(0) || !grossAmount.isGreaterThan(0)) continue;

      if (!grouped.has(row.username)) {
        grouped.set(row.username, {
          username: row.username,
          payoutAddress: row.payout_address,
          grossAmount: new BigNumber(0),
          initialAssetAmount: new BigNumber(0),
          allocations: [],
        });
      }
      const seller = grouped.get(row.username);
      if (String(seller.payoutAddress).toLowerCase() !== String(row.payout_address).toLowerCase()) {
        throw new Error(`Seller ${row.username} has inconsistent payout addresses across reserve lots`);
      }
      seller.grossAmount = seller.grossAmount.plus(grossAmount);
      seller.initialAssetAmount = seller.initialAssetAmount.plus(initialAssetAmount);
      seller.allocations.push({ lotId: String(row.id), initialAssetAmount, grossAmount, unitPrice: row.price });
      await tx.query(
        `UPDATE users_seller_reserve_lots
         SET payout_reserved_initial_asset=payout_reserved_initial_asset+?,updated_at_ms=?
         WHERE id=?`,
        [initialAssetAmount.toFixed(DB_ASSET_DECIMALS), now, row.id],
      );
      batchRemainingUsd = batchRemainingUsd.minus(grossAmount);
    }
    if (grouped.size === 0) break;
    const batchGross = [...grouped.values()].reduce((sum, seller) => sum.plus(seller.grossAmount), new BigNumber(0));
    const [batchResult] = await tx.query(
      "INSERT INTO users_usdt_seller_payout_batches(gross_amount,status,created_at_ms,updated_at_ms) VALUES(?,'queued',?,?)",
      [batchGross.toFixed(TOKEN_DECIMALS), now, now],
    );
    for (const seller of grouped.values()) {
      const effectiveUnitPrice = seller.grossAmount.dividedBy(seller.initialAssetAmount);
      const [payoutResult] = await tx.query(
        `INSERT INTO users_usdt_seller_payouts
         (batch_id,username,payout_address,gross_amount,gross_initial_asset,effective_unit_price,
          gas_fee_estimated,payout_amount,amount_raw,status,created_at_ms,updated_at_ms)
         VALUES(?,?,?,?,?,?,'0','0','0','queued',?,?)`,
        [
          batchResult.insertId,
          seller.username,
          seller.payoutAddress,
          seller.grossAmount.toFixed(TOKEN_DECIMALS),
          seller.initialAssetAmount.toFixed(DB_ASSET_DECIMALS),
          effectiveUnitPrice.toFixed(30),
          now,
          now,
        ],
      );
      for (const allocation of seller.allocations) {
        await tx.query(
          `INSERT INTO users_seller_payout_allocations
           (payout_id,lot_id,initial_asset_amount,gross_amount,unit_price,status,created_at_ms)
           VALUES(?,?,?,?,?,'reserved',?)`,
          [
            payoutResult.insertId,
            allocation.lotId,
            allocation.initialAssetAmount.toFixed(DB_ASSET_DECIMALS),
            allocation.grossAmount.toFixed(TOKEN_DECIMALS),
            allocation.unitPrice.toFixed(30),
            now,
          ],
        );
      }
      await queueTelegramMessageTx(
        tx,
        seller.username,
        `seller-payout:${payoutResult.insertId}:queued`,
        [
          "OneX Seller Update",
          "Your sold seller-reserve assets have reached a payout batch and are queued for BSC-USD settlement.",
          `Payout ID: ${payoutResult.insertId}`,
          `Gross amount: ${seller.grossAmount.toFixed(8)} BSC-USD`,
          `Valuation price locked at campaign submission: ${effectiveUnitPrice.toFixed(12)} XTU per initial asset`,
          "The outgoing BSC gas fee will be deducted from your payout. No transaction fee is charged to priority sellers.",
          "Status: PROCESSING",
        ].join("\n"),
      );
    }
  }
}

async function closeExpiredSellerCampaignsTx(tx, nowMs = Date.now()) {
  const now = String(nowMs);
  const [lockRows] = await tx.query("SELECT lock_name FROM system_locks WHERE lock_name=? FOR UPDATE", ["common_state"]);
  if (!lockRows.length) throw new Error("The common-state lock row has not been initialized");
  const [commonRows] = await tx.query(
    "SELECT sellers_res,total_run_balance FROM common ORDER BY id DESC LIMIT 1 FOR UPDATE",
  );
  if (!commonRows.length) throw new Error("Common reserve is not initialized");
  const [campaigns] = await tx.query(
    `SELECT id,username,run_balance,unit_price
     FROM users_seller_campaigns
     WHERE status IN ('active','cancel_requested') AND CAST(expires_at_ms AS UNSIGNED)<=?
     ORDER BY expires_at_ms ASC,id ASC
     FOR UPDATE`,
    [now],
  );
  if (!campaigns.length) return 0;

  const sellersReserve = finiteNonNegative(commonRows[0].sellers_res, "common.sellers_res");
  const totalRunBalance = finiteNonNegative(commonRows[0].total_run_balance, "common.total_run_balance");
  let releaseInitialAsset = new BigNumber(0);
  let closedRunBalance = new BigNumber(0);

  for (const campaign of campaigns) {
    const [lotRows] = await tx.query(
      "SELECT id,remaining_initial_asset,unit_price FROM users_seller_reserve_lots WHERE campaign_id=? LIMIT 1 FOR UPDATE",
      [campaign.id],
    );
    let releasedXtu = new BigNumber(0);
    if (lotRows.length) {
      const remaining = finiteNonNegative(lotRows[0].remaining_initial_asset, "seller lot remaining initial assets");
      const campaignPrice = finitePositive(lotRows[0].unit_price, "seller lot unit_price");
      releasedXtu = remaining.multipliedBy(campaignPrice);
      releaseInitialAsset = releaseInitialAsset.plus(remaining);
      await tx.query(
        "UPDATE users_seller_reserve_lots SET remaining_initial_asset=0,status='expired',updated_at_ms=? WHERE id=?",
        [now, lotRows[0].id],
      );
    }
    closedRunBalance = closedRunBalance.plus(finiteNonNegative(campaign.run_balance, "campaign.run_balance"));
    await tx.query(
      "UPDATE users_seller_campaigns SET status='expired',closed_at_ms=?,close_reason='expired' WHERE id=? AND status IN ('active','cancel_requested')",
      [now, campaign.id],
    );
    await tx.query(
      `UPDATE users_stock SET seller_status=0,run_balance=0,seller_activated_at_ms=NULL,seller_expires_at_ms=NULL
       WHERE username=? AND seller_status IN (1,2)`,
      [campaign.username],
    );
    const price = finitePositive(campaign.unit_price, "campaign.unit_price");
    await queueTelegramMessageTx(tx, campaign.username, `seller-campaign:${campaign.id}:expired`, [
      "OneX Seller Update",
      "Your 7-day seller status has expired. Unused seller-reserve assets have been released.",
      `Campaign: ${campaign.id}`,
      `Released value: ${releasedXtu.toFixed(8)} XTU at campaign valuation`,
      `Released initial assets: ${new BigNumber(lotRows[0]?.remaining_initial_asset || "0").toFixed(30)}`,
      `Campaign valuation price: ${price.toFixed(12)} XTU per initial asset`,
      "Status: EXPIRED",
    ].join("\n"));
  }

  const newSellersReserve = sellersReserve.minus(releaseInitialAsset);
  const newTotalRunBalance = totalRunBalance.minus(closedRunBalance);
  if (newSellersReserve.isNegative() || newTotalRunBalance.isNegative()) {
    throw new Error("Seller reserve totals are inconsistent with expired campaign lots");
  }
  if (releaseInitialAsset.isGreaterThan(0) || closedRunBalance.isGreaterThan(0)) {
    const [date, time] = require("./utils").getDate();
    const current = await require("./common-accounting").getLatestCommonTx(tx, true);
    await require("./common-accounting").insertCommonSnapshotTx(tx, current, {
      sellers_res: newSellersReserve.toFixed(DB_ASSET_DECIMALS),
      total_run_balance: newTotalRunBalance.toFixed(DB_ASSET_DECIMALS),
    }, date, time);
  }
  return campaigns.length;
}

module.exports = {
  SELLER_MIN_RUN_BALANCE,
  SELLER_LOCK_RATIO,
  SELLER_STATUS_DURATION_MS,
  SELLER_PAYOUT_BATCH_LIMIT,
  validateSellerJoin,
  allocateSellerLotConsumption,
  sumActiveSellerReserveLots,
  getActiveSellerReserveAvailableTx,
  calculateSellerPayoutGrossAtLockedPrice,
  calculateSellerPayoutNet,
  consumeSellerReserveTx,
  queueSellerPayoutBatchesTx,
  closeExpiredSellerCampaignsTx,
};
