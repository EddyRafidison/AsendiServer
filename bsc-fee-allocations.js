"use strict";

const BigNumber = require("bignumber.js");

const ALLOCATION_TYPE_RECHARGE = "recharge_batch";
const ALLOCATION_PRECISION = 30;

function allocateFeeByRawAmount(totalFeeValue, batchRawRows) {
  const totalFee = new BigNumber(totalFeeValue);
  if (!totalFee.isFinite() || totalFee.isNegative()) {
    throw new RangeError("BSC fee to allocate must be finite and non-negative");
  }
  const rows = (batchRawRows || []).map((row) => ({
    batchId: String(row.batchId ?? row.batch_id),
    rawAmount: new BigNumber(row.rawAmount ?? row.amount_raw),
  }));
  if (!rows.length) throw new RangeError("A confirmed sweep has no deposit batches to allocate");
  const seenBatchIds = new Set();
  for (const row of rows) {
    if (!/^\d{1,20}$/.test(row.batchId) || !row.rawAmount.isFinite() || !row.rawAmount.isGreaterThan(0)) {
      throw new RangeError("Invalid BSC sweep allocation amount");
    }
    if (seenBatchIds.has(row.batchId)) throw new RangeError("Duplicate recharge batch in BSC fee allocation");
    seenBatchIds.add(row.batchId);
  }
  rows.sort((a, b) => {
    const left = BigInt(a.batchId);
    const right = BigInt(b.batchId);
    return left < right ? -1 : (left > right ? 1 : 0);
  });

  const totalRaw = rows.reduce((sum, row) => sum.plus(row.rawAmount), new BigNumber(0));
  if (!totalRaw.isGreaterThan(0)) throw new RangeError("BSC sweep allocation total must be positive");

  let allocated = new BigNumber(0);
  return rows.map((row, index) => {
    const amount = index === rows.length - 1
      ? totalFee.minus(allocated)
      : totalFee.multipliedBy(row.rawAmount).dividedBy(totalRaw)
        .decimalPlaces(ALLOCATION_PRECISION, BigNumber.ROUND_DOWN);
    allocated = allocated.plus(amount);
    return { batchId: row.batchId, allocatedFeeUsd: amount };
  });
}

async function getRechargeBatchBscFeeCostTx(tx, batchIdValue) {
  const batchId = String(batchIdValue);
  if (!/^\d{1,20}$/.test(batchId)) throw new TypeError("Invalid recharge batch id");

  const [batchRows] = await tx.query(
    `SELECT b.id,b.deposit_wallet_id,w.last_scanned_block
     FROM users_usdt_deposit_batches b
     JOIN users_usdt_deposit_wallets w ON w.id=b.deposit_wallet_id
     WHERE b.id=? LIMIT 1 FOR UPDATE`,
    [batchId],
  );
  if (!batchRows.length) throw new Error(`Recharge batch ${batchId} does not exist`);

  const [unsweptRows] = await tx.query(
    `SELECT COUNT(*) AS count FROM users_usdt_transfer_events
     WHERE batch_id=? AND swept_at_ms IS NULL`,
    [batchId],
  );
  if (Number(unsweptRows[0]?.count || 0) > 0) return { ready: false, actualFeeUsd: new BigNumber(0) };

  const [sweepRows] = await tx.query(
    `SELECT DISTINCT s.id,s.deposit_wallet_id,s.snapshot_block,s.confirmed_at_ms,
            s.fund_tx_hash,s.token_tx_hash,s.status,w.last_scanned_block
     FROM users_usdt_sweeps s
     JOIN users_usdt_transfer_events e
       ON e.deposit_wallet_id=s.deposit_wallet_id
      AND e.swept_at_ms=s.confirmed_at_ms
     JOIN users_usdt_deposit_wallets w ON w.id=s.deposit_wallet_id
     WHERE e.batch_id=? AND s.status='confirmed'
     ORDER BY s.id ASC FOR UPDATE`,
    [batchId],
  );
  if (!sweepRows.length && Number(unsweptRows[0]?.count || 0) === 0) {
    return { ready: true, actualFeeUsd: new BigNumber(0) };
  }

  for (const sweep of sweepRows) {
    if (BigInt(String(sweep.last_scanned_block || 0)) < BigInt(String(sweep.snapshot_block))) {
      return { ready: false, actualFeeUsd: new BigNumber(0) };
    }
    const [batchRawRows] = await tx.query(
      `SELECT batch_id,CAST(SUM(CAST(amount_raw AS DECIMAL(65,0))) AS CHAR) AS amount_raw
       FROM users_usdt_transfer_events
       WHERE deposit_wallet_id=? AND swept_at_ms=? AND batch_id IS NOT NULL
       GROUP BY batch_id ORDER BY batch_id ASC`,
      [sweep.deposit_wallet_id, String(sweep.confirmed_at_ms)],
    );
    if (!batchRawRows.length) return { ready: false, actualFeeUsd: new BigNumber(0) };

    const txHashes = [sweep.fund_tx_hash, sweep.token_tx_hash].filter(Boolean);
    for (const txHashValue of txHashes) {
      const txHash = String(txHashValue).toLowerCase();
      const [feeRows] = await tx.query(
        `SELECT actual_fee_usd FROM bsc_fee_ledger
         WHERE tx_hash=? AND actual_fee_usd IS NOT NULL LIMIT 1 FOR UPDATE`,
        [txHash],
      );
      if (!feeRows.length) return { ready: false, actualFeeUsd: new BigNumber(0) };

      const allocations = allocateFeeByRawAmount(feeRows[0].actual_fee_usd, batchRawRows);
      for (const allocation of allocations) {
        await tx.query(
          `INSERT IGNORE INTO bsc_fee_allocations
           (tx_hash,allocation_type,allocation_id,allocated_fee_usd,created_at_ms)
           VALUES(?,?,?, ?,?)`,
          [txHash, ALLOCATION_TYPE_RECHARGE, allocation.batchId, allocation.allocatedFeeUsd.toFixed(ALLOCATION_PRECISION), String(Date.now())],
        );
      }
    }
  }

  const [allocatedRows] = await tx.query(
    `SELECT COALESCE(SUM(allocated_fee_usd),0) AS total_fee_usd
     FROM bsc_fee_allocations WHERE allocation_type=? AND allocation_id=?`,
    [ALLOCATION_TYPE_RECHARGE, batchId],
  );
  const actualFeeUsd = new BigNumber(allocatedRows[0]?.total_fee_usd || "0");
  if (!actualFeeUsd.isFinite() || actualFeeUsd.isNegative()) {
    throw new Error(`Recharge batch ${batchId} has invalid allocated BSC fee accounting`);
  }
  return { ready: true, actualFeeUsd };
}

module.exports = {
  ALLOCATION_TYPE_RECHARGE,
  allocateFeeByRawAmount,
  getRechargeBatchBscFeeCostTx,
};
