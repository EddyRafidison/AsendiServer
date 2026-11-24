"use strict";

const BigNumber = require("bignumber.js");
const { calculateGlobalUnitPrice } = require("./stock-accounting");

const COMMON_NUMERIC_FIELDS = Object.freeze([
  "total_units_price",
  "unit_price",
  "xtu_wallets",
  "xtu_wallets_reserved",
  "backed_units",
  "inactive_init_asset",
  "sys_inactive_init_asset",
  "sellers_res",
  "total_run_balance",
  "total_tfees",
  "total_tfees_bsc_cost_usd",
  "total_tfees_bsc_uncovered_usd",
  "total_bnb_fee_actual",
  "total_bnb_fee_estimated",
  "total_bnb_fee_actual_value",
  "total_bnb_fee_estimated_value",
]);

function commonSnapshotValues(row, overrides = {}) {
  const values = {};
  for (const field of COMMON_NUMERIC_FIELDS) {
    if (field === "unit_price") continue;
    values[field] = String(overrides[field] ?? row?.[field] ?? "0");
  }
  const previousPrice = new BigNumber(row?.unit_price ?? "0");
  const requestedPrice = new BigNumber(overrides.unit_price ?? row?.unit_price ?? "0");
  if (!previousPrice.isFinite() || previousPrice.isNegative() || !requestedPrice.isFinite() || requestedPrice.isNegative()) {
    throw new RangeError("The global XTU price floor must be finite and non-negative.");
  }
  const minimumPrice = BigNumber.maximum(previousPrice, requestedPrice);
  const calculatedPrice = calculateGlobalUnitPrice(values.total_units_price, values.backed_units, minimumPrice);
  values.unit_price = calculatedPrice.toFixed(30);
  return values;
}

function assertNonNegative(fieldName, nextValue) {
  const next = new BigNumber(nextValue ?? "0");
  if (!next.isFinite() || next.isNegative()) {
    throw new RangeError(`common.${fieldName} must remain finite and non-negative.`);
  }
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
  // Unlike cumulative counters, this is the outstanding net XTU amount and must rise/fall.
  assertNonNegative("xtu_wallets", values.xtu_wallets);
  assertNonNegative("xtu_wallets_reserved", values.xtu_wallets_reserved);
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
  assertCumulativeNonNegative(
    "total_tfees_bsc_cost_usd",
    currentRow?.total_tfees_bsc_cost_usd || "0",
    values.total_tfees_bsc_cost_usd,
  );
  assertCumulativeNonNegative(
    "total_tfees_bsc_uncovered_usd",
    currentRow?.total_tfees_bsc_uncovered_usd || "0",
    values.total_tfees_bsc_uncovered_usd,
  );
  const columns = [...COMMON_NUMERIC_FIELDS, "record_date", "record_time"];
  const placeholders = columns.map(() => "?").join(",");
  const params = [...COMMON_NUMERIC_FIELDS.map((field) => values[field]), date, time];
  await tx.query(
    `INSERT INTO common(${columns.map((column) => `\`${column}\``).join(",")}) VALUES(${placeholders})`,
    params,
  );

  const previousPrice = new BigNumber(currentRow?.unit_price ?? values.unit_price);
  const nextPrice = new BigNumber(values.unit_price);
  if (previousPrice.isFinite() && nextPrice.isFinite() && !previousPrice.eq(nextPrice)) {
    const now = String(Date.now());
    await tx.query(
      `INSERT INTO common_price_events(old_price,new_price,status,last_username,created_at_ms,updated_at_ms)
       VALUES(?,?,'pending','',?,?)`,
      [previousPrice.toFixed(30), nextPrice.toFixed(30), now, now],
    );
  }
  return values;
}

async function getLatestCommonTx(tx, lock = true) {
  const suffix = lock ? " FOR UPDATE" : "";
  const [rows] = await tx.query(
    `SELECT ${COMMON_NUMERIC_FIELDS.map((field) => `\`${field}\``).join(",")} FROM common ORDER BY id DESC LIMIT 1${suffix}`,
  );
  if (!rows.length) throw new Error("Common reserve is not initialized");
  const row = rows[0];
  const minimumRequired = calculateGlobalUnitPrice(row.total_units_price, row.backed_units);
  const stored = new BigNumber(row.unit_price);
  if (!stored.isFinite() || !stored.isGreaterThan(0) ||
      minimumRequired.minus(stored).gt("0.000000000000000000000000000001")) {
    throw new Error("common.unit_price must be positive and not below common.total_units_price / common.backed_units");
  }
  return row;
}

module.exports = {
  COMMON_NUMERIC_FIELDS,
  commonSnapshotValues,
  insertCommonSnapshotTx,
  getLatestCommonTx,
};
