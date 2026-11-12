"use strict";

const BigNumber = require("bignumber.js");

const MAX_DEFAULT_STOCK = "300";
const MIN_RECHARGE_AMOUNT = new BigNumber("12");
const MAX_RECHARGE_AMOUNT = new BigNumber("140");
const SYSTEM_RESERVE_RATIO = new BigNumber(process.env.SYSTEM_RESERVE_RATIO || "0.20");
const RECHARGE_COOLDOWN_DAYS = 7;
const RECHARGE_BATCH_WINDOW_MINUTES = 60;
const DEPOSIT_SWEEP_THRESHOLD = new BigNumber("70");
const DEPOSIT_SWEEP_MAX_AGE_DAYS = 30;
const DISBURSEMENT_COOLDOWN_DAYS = 90;
const DISBURSEMENT_RESERVATION_MINUTES = 60;

const RECHARGE_COOLDOWN_MS = RECHARGE_COOLDOWN_DAYS * 24 * 60 * 60 * 1000;
const RECHARGE_BATCH_WINDOW_MS = RECHARGE_BATCH_WINDOW_MINUTES * 60 * 1000;
const DEPOSIT_SWEEP_MAX_AGE_MS = DEPOSIT_SWEEP_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
const DISBURSEMENT_COOLDOWN_MS = DISBURSEMENT_COOLDOWN_DAYS * 24 * 60 * 60 * 1000;
const DISBURSEMENT_RESERVATION_MS = DISBURSEMENT_RESERVATION_MINUTES * 60 * 1000;

function recordDateTimeToUtcMs(recordDate, recordTime) {
  const date = String(recordDate ?? "").replace(/\D/g, "").padStart(8, "0");
  const time = String(recordTime ?? "").replace(/\D/g, "").padStart(6, "0");
  if (!/^\d{8}$/.test(date) || !/^\d{6}$/.test(time)) return null;

  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(4, 6));
  const day = Number(date.slice(6, 8));
  const hour = Number(time.slice(0, 2));
  const minute = Number(time.slice(2, 4));
  const second = Number(time.slice(4, 6));
  if (year < 2000 || month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) return null;

  const value = Date.UTC(year, month - 1, day, hour, minute, second);
  const parsed = new Date(value);
  if (
    parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day || parsed.getUTCHours() !== hour ||
    parsed.getUTCMinutes() !== minute || parsed.getUTCSeconds() !== second
  ) return null;
  return value;
}

async function getLastOnexRecharge(queryable, username, onexUsername) {
  const [rows] = await queryable.query(
    `SELECT id,record_date,record_time
     FROM activities
     WHERE sender=? AND receiver=? AND type=2
     ORDER BY record_date DESC,record_time DESC,id DESC
     LIMIT 1 FOR UPDATE`,
    [onexUsername, username],
  );
  return rows.length ? rows[0] : null;
}

function assessRechargeCooldown(lastRecharge, nowMs = Date.now()) {
  if (!lastRecharge) return { allowed: true, remainingMs: 0, lastRechargeMs: null };
  const lastRechargeMs = recordDateTimeToUtcMs(lastRecharge.record_date, lastRecharge.record_time);
  if (lastRechargeMs === null || lastRechargeMs > nowMs) {
    return { allowed: false, remainingMs: RECHARGE_COOLDOWN_MS, lastRechargeMs: null, invalidDate: true };
  }
  const remainingMs = Math.max(0, RECHARGE_COOLDOWN_MS - (nowMs - lastRechargeMs));
  return { allowed: remainingMs === 0, remainingMs, lastRechargeMs };
}

function formatUtcRecordDateTime(timestampMs) {
  const date = new Date(timestampMs);
  if (!Number.isFinite(date.getTime())) throw new TypeError("Invalid UTC timestamp");
  const yyyy = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(date.getUTCDate()).padStart(2, "0");
  const hh = String(date.getUTCHours()).padStart(2, "0");
  const mi = String(date.getUTCMinutes()).padStart(2, "0");
  const ss = String(date.getUTCSeconds()).padStart(2, "0");
  return [Number(`${yyyy}${mm}${dd}`), `${hh}${mi}${ss}`];
}

function getWeeklyReleaseAt(pendingSinceMs, lastRechargeMs) {
  const pendingRelease = Number(pendingSinceMs) + RECHARGE_COOLDOWN_MS;
  const rechargeRelease = lastRechargeMs == null ? 0 : Number(lastRechargeMs) + RECHARGE_COOLDOWN_MS;
  if (!Number.isSafeInteger(pendingRelease) || pendingRelease <= 0) throw new TypeError("Invalid pending timestamp");
  return Math.max(pendingRelease, rechargeRelease);
}

module.exports = {
  MAX_DEFAULT_STOCK,
  MIN_RECHARGE_AMOUNT,
  MAX_RECHARGE_AMOUNT,
  SYSTEM_RESERVE_RATIO,
  RECHARGE_COOLDOWN_DAYS,
  RECHARGE_COOLDOWN_MS,
  RECHARGE_BATCH_WINDOW_MINUTES,
  RECHARGE_BATCH_WINDOW_MS,
  DEPOSIT_SWEEP_THRESHOLD,
  DEPOSIT_SWEEP_MAX_AGE_DAYS,
  DEPOSIT_SWEEP_MAX_AGE_MS,
  DISBURSEMENT_COOLDOWN_DAYS,
  DISBURSEMENT_COOLDOWN_MS,
  DISBURSEMENT_RESERVATION_MINUTES,
  DISBURSEMENT_RESERVATION_MS,
  getLastOnexRecharge,
  assessRechargeCooldown,
  formatUtcRecordDateTime,
  getWeeklyReleaseAt,
};
