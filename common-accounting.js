"use strict";

const crypto = require("crypto");
const BigNumber = require("bignumber.js");
const { getAdminFeesTransferConfig, calculateAdminFeesTransfer } = require("./admin-fees-policy");

const COMMON_NUMERIC_FIELDS = Object.freeze([
  "total_units_price",
  "unit_price",
  "backed_units",
  "inactive_init_asset",
  "sellers_res",
  "sellers_init_asset",
  "total_bnb_fee_actual",
  "total_bnb_fee_estimated",
  "total_bnb_fee_actual_value",
  "total_bnb_fee_estimated_value",
  "total_adminFees",
  "remaining_adminFees",
  "total_common_share",
]);

function commonSnapshotValues(row, overrides = {}) {
  const values = {};
  for (const field of COMMON_NUMERIC_FIELDS) {
    values[field] = String(overrides[field] ?? row?.[field] ?? "0");
  }
  return values;
}

async function queueAdminFeesTransferIfDueTx(tx, remainingValue) {
  const config = getAdminFeesTransferConfig();
  if (!config.enabled) return null;

  const transfer = calculateAdminFeesTransfer(
    remainingValue,
    config.threshold,
    config.retainedBalance,
  );
  if (!transfer) return null;

  const [activeRows] = await tx.query(
    `SELECT id FROM admin_fees_transfers
     WHERE status IN ('queued','signed','submitted','manual_review')
     ORDER BY id DESC LIMIT 1 FOR UPDATE`,
  );
  if (activeRows.length) return null;

  const now = String(Date.now());
  const reference = `ADMFEE${crypto.randomBytes(16).toString("hex")}`;
  const [result] = await tx.query(
    `INSERT INTO admin_fees_transfers
     (amount,amount_raw,destination_address,reference,status,created_at_ms,updated_at_ms)
     VALUES(?,?,?,?, 'queued', ?, ?)`,
    [
      transfer.amount.toFixed(18),
      transfer.amountRaw,
      config.payoutAddress,
      reference,
      now,
      now,
    ],
  );
  return { id: result.insertId, reference, amount: transfer.amount.toFixed(18) };
}

async function insertCommonSnapshotTx(tx, currentRow, overrides, date, time, options = {}) {
  const values = commonSnapshotValues(currentRow, overrides);
  const previousTotalAdminFees = new BigNumber(currentRow?.total_adminFees || "0");
  const nextTotalAdminFees = new BigNumber(values.total_adminFees);
  const previousRemainingAdminFees = new BigNumber(currentRow?.remaining_adminFees || "0");
  const nextRemainingAdminFees = new BigNumber(values.remaining_adminFees);
  if (
    !previousTotalAdminFees.isFinite() || previousTotalAdminFees.isNegative() ||
    !nextTotalAdminFees.isFinite() || nextTotalAdminFees.isNegative() ||
    nextTotalAdminFees.isLessThan(previousTotalAdminFees)
  ) {
    throw new RangeError("common.total_adminFees must be finite, non-negative and cumulative.");
  }
  if (
    !previousRemainingAdminFees.isFinite() || previousRemainingAdminFees.isNegative() ||
    !nextRemainingAdminFees.isFinite() || nextRemainingAdminFees.isNegative() ||
    nextRemainingAdminFees.isGreaterThan(nextTotalAdminFees)
  ) {
    throw new RangeError("common.remaining_adminFees must be finite, non-negative and cannot exceed total_adminFees.");
  }
  if (
    nextRemainingAdminFees.isLessThan(previousRemainingAdminFees) &&
    options.allowAdminFeesDecrease !== true
  ) {
    throw new Error("common.remaining_adminFees can decrease only after a confirmed admin-fees blockchain transfer.");
  }
  const columns = [...COMMON_NUMERIC_FIELDS, "record_date", "record_time"];
  const placeholders = columns.map(() => "?").join(",");
  const params = [...COMMON_NUMERIC_FIELDS.map((field) => values[field]), date, time];
  await tx.query(
    `INSERT INTO common(${columns.map((column) => `\`${column}\``).join(",")}) VALUES(${placeholders})`,
    params,
  );
  return values;
}

async function getLatestCommonTx(tx, lock = true) {
  const suffix = lock ? " FOR UPDATE" : "";
  const [rows] = await tx.query(
    `SELECT ${COMMON_NUMERIC_FIELDS.map((field) => `\`${field}\``).join(",")} FROM common ORDER BY id DESC LIMIT 1${suffix}`,
  );
  if (!rows.length) throw new Error("Common reserve is not initialized");
  return rows[0];
}

module.exports = {
  COMMON_NUMERIC_FIELDS,
  commonSnapshotValues,
  insertCommonSnapshotTx,
  queueAdminFeesTransferIfDueTx,
  getLatestCommonTx,
};
