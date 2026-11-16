"use strict";

const BigNumber = require("bignumber.js");

const COMMON_NUMERIC_FIELDS = Object.freeze([
  "total_units_price",
  "unit_price",
  "backed_units",
  "inactive_init_asset",
  "sys_inactive_init_asset",
  "sellers_res",
  "sellers_init_asset",
  "total_tfees",
  "total_bnb_fee_actual",
  "total_bnb_fee_estimated",
  "total_bnb_fee_actual_value",
  "total_bnb_fee_estimated_value",
]);

function commonSnapshotValues(row, overrides = {}) {
  const values = {};
  for (const field of COMMON_NUMERIC_FIELDS) {
    values[field] = String(overrides[field] ?? row?.[field] ?? "0");
  }
  return values;
}

function assertCumulativeNonNegative(fieldName, previousValue, nextValue) {
  const previous = new BigNumber(previousValue ?? "0");
  const next = new BigNumber(nextValue ?? "0");
  if (
    !previous.isFinite() || previous.isNegative() ||
    !next.isFinite() || next.isNegative() ||
    next.isLessThan(previous)
  ) {
    throw new RangeError(`common.${fieldName} must remain finite, non-negative and cumulative.`);
  }
}

async function insertCommonSnapshotTx(tx, currentRow, overrides, date, time) {
  const values = commonSnapshotValues(currentRow, overrides);
  assertCumulativeNonNegative(
    "sys_inactive_init_asset",
    currentRow?.sys_inactive_init_asset || "0",
    values.sys_inactive_init_asset,
  );
  assertCumulativeNonNegative(
    "total_tfees",
    currentRow?.total_tfees || "0",
    values.total_tfees,
  );

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
  getLatestCommonTx,
};
