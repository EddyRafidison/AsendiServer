"use strict";

require("dotenv").config();
const mysql = require("mysql2");
const BigNumber = require("bignumber.js");
const { getDate, getDateBefore } = require("./utils");
const { MAX_DEFAULT_STOCK } = require("./recharge-policy");

const OneX = "ONEX";
const maxStockDefault = MAX_DEFAULT_STOCK;
const P2Pallowed = String(process.env.P2P_ALLOWED || "false").toLowerCase() === "true";
const stock_limit = process.env.STOCK_LIMIT || "0";
// Initial distributable reserve in initial-asset units for a brand-new database.
// It defaults to zero so the system cannot accept top-ups before an operator
// deliberately configures the reserve that is actually available.
const initial_backed_units = process.env.INITIAL_BACKED_UNITS || "0";
const first_welcome_clients = process.env.FIRST_WELCOME_CLIENTS || "0";
const welcome_bonus = process.env.WELCOME_BONUS || "0";
const tfees = Number(process.env.FEES || 0);
const admin_pswd = process.env.ADMIN_PSWD || "";
const admin_pin = process.env.ADMIN_PIN || "";
const APP_VERSION = process.env.APP_VERSION || "";
const PORT_DB = Number(process.env.DB_PORT || 3306);
const PORT_SERVER = Number(process.env.SERVER_PORT || 3000);
const MAIL_PORT = Number(process.env.MAIL_PORT || 587);
const SERVER_MAIL = process.env.SERV_MAIL || "";
const SERVER_MAIL_PSWD = process.env.SERV_MAIL_PSWD || "";

const DB_CONFIG = {
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PSWD,
  database: process.env.DB_NAME,
  port: PORT_DB,
  waitForConnections: true,
  connectionLimit: Number(process.env.DB_CONNECTION_LIMIT || 50),
  queueLimit: 200,
  multipleStatements: true,
  timezone: "Z",
};

if (!DB_CONFIG.host || !DB_CONFIG.user || !DB_CONFIG.database) {
  console.warn("Database configuration is incomplete. Set DB_HOST, DB_USER and DB_NAME.");
}
const db = mysql.createPool(DB_CONFIG);
db.on("connection", (connection) => {
  connection.query("SET time_zone = '+00:00'", (error) => {
    if (error) console.error("Unable to set MySQL session timezone to UTC:", error);
  });
});
db.queryAsync = (sql, params = []) => new Promise((resolve, reject) => {
  db.query(sql, params, (error, result) => error ? reject(error) : resolve(result));
});

const TABLES = [
  `CREATE TABLE IF NOT EXISTS auths(
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    username VARCHAR(30) NOT NULL,
    password VARCHAR(255) NOT NULL,
    name VARCHAR(50) NOT NULL,
    email VARCHAR(254) NOT NULL,
    birthdate VARCHAR(20) NOT NULL,
    cni VARCHAR(255) NOT NULL,
    address VARCHAR(100) NOT NULL,
    seed TEXT NOT NULL,
    status INT NOT NULL DEFAULT 1,
    consec_failed_auth INT UNSIGNED NOT NULL DEFAULT 0,
    password_temp_expires_at_ms BIGINT UNSIGNED NULL,
    tg_userId VARCHAR(32) NULL,
    tg_chat_id VARCHAR(32) NULL,
    record_date INT NOT NULL,
    record_time CHAR(6) NOT NULL,
    UNIQUE KEY uq_auths_username(username),
    UNIQUE KEY uq_auths_tg_user_id(tg_userId),
    UNIQUE KEY uq_auths_tg_chat_id(tg_chat_id),
    KEY idx_auths_failed_auth(consec_failed_auth)
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS users_stock(
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    username VARCHAR(30) NOT NULL,
    balance DECIMAL(50,30) NOT NULL DEFAULT 0,
    init_asset DECIMAL(50,30) NOT NULL DEFAULT 0,
    record_date INT NOT NULL,
    record_time CHAR(6) NOT NULL,
    UNIQUE KEY uq_users_stock_username(username)
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS activities(
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    sender VARCHAR(30) NOT NULL,
    receiver VARCHAR(30) NOT NULL,
    type INT NOT NULL,
    amount DECIMAL(50,30) NOT NULL,
    unit_price DECIMAL(50,30) NOT NULL DEFAULT 0,
    fees DECIMAL(50,30) NOT NULL DEFAULT 0,
    reference VARCHAR(64) NULL,
    record_date INT NOT NULL,
    record_time CHAR(6) NOT NULL,
    UNIQUE KEY uq_activities_reference(reference),
    KEY idx_activities_recharge_user(sender,receiver,type,record_date,record_time,id),
    KEY idx_activities_sender_type(sender,type,id)
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS common(
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    total_units_price DECIMAL(50,30) NOT NULL DEFAULT 0,
    unit_price DECIMAL(50,30) NOT NULL DEFAULT 0,
    backed_units DECIMAL(50,30) NOT NULL DEFAULT 0,
    inactive_init_asset DECIMAL(50,30) NOT NULL DEFAULT 0,
    record_date INT NOT NULL,
    record_time CHAR(6) NOT NULL
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS system_locks(
    lock_name VARCHAR(64) PRIMARY KEY
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS telegram_link_challenges(
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    username VARCHAR(30) NOT NULL,
    token_hash CHAR(64) NOT NULL,
    created_at_ms BIGINT UNSIGNED NOT NULL,
    expires_at_ms BIGINT UNSIGNED NOT NULL,
    used_at_ms BIGINT UNSIGNED NULL,
    UNIQUE KEY uq_telegram_link_token_hash(token_hash),
    KEY idx_telegram_link_user(username,expires_at_ms,used_at_ms)
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS telegram_outbox(
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    event_key VARCHAR(191) NOT NULL,
    username VARCHAR(30) NOT NULL,
    chat_id VARCHAR(32) NOT NULL,
    message_text TEXT NOT NULL,
    status VARCHAR(16) NOT NULL DEFAULT 'pending',
    attempts INT UNSIGNED NOT NULL DEFAULT 0,
    next_attempt_at_ms BIGINT UNSIGNED NOT NULL,
    claimed_at_ms BIGINT UNSIGNED NULL,
    last_error TEXT NULL,
    created_at_ms BIGINT UNSIGNED NOT NULL,
    sent_at_ms BIGINT UNSIGNED NULL,
    UNIQUE KEY uq_telegram_outbox_event(event_key),
    KEY idx_telegram_outbox_due(status,next_attempt_at_ms,id),
    KEY idx_telegram_outbox_user(username,id)
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS telegram_bot_state(
    state_key VARCHAR(64) PRIMARY KEY,
    state_value BIGINT UNSIGNED NOT NULL DEFAULT 0,
    updated_at_ms BIGINT UNSIGNED NOT NULL
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS users_usdt_deposit_wallets(
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    username VARCHAR(30) NOT NULL,
    wallet_address CHAR(42) NOT NULL,
    payout_address CHAR(42) NULL,
    derivation_index BIGINT UNSIGNED NOT NULL,
    created_block BIGINT UNSIGNED NOT NULL,
    last_scanned_block BIGINT UNSIGNED NOT NULL,
    created_at_ms BIGINT UNSIGNED NOT NULL,
    last_sweep_at_ms BIGINT UNSIGNED NULL,
    sweep_lock_until_ms BIGINT UNSIGNED NOT NULL DEFAULT 0,
    account_status VARCHAR(16) NOT NULL DEFAULT 'active',
    UNIQUE KEY uq_usdt_deposit_username(username),
    UNIQUE KEY uq_usdt_deposit_address(wallet_address),
    UNIQUE KEY uq_usdt_deposit_derivation_index(derivation_index),
    KEY idx_usdt_deposit_scan(id,last_scanned_block),
    KEY idx_usdt_deposit_status(account_status,id)
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS users_usdt_deposit_batches(
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    username VARCHAR(30) NOT NULL,
    deposit_wallet_id BIGINT UNSIGNED NOT NULL,
    deposit_address CHAR(42) NOT NULL,
    opened_at_ms BIGINT UNSIGNED NOT NULL,
    expires_at_ms BIGINT UNSIGNED NOT NULL,
    total_amount DECIMAL(36,18) NOT NULL DEFAULT 0,
    total_amount_raw DECIMAL(65,0) NOT NULL DEFAULT 0,
    transfer_count INT UNSIGNED NOT NULL DEFAULT 0,
    status VARCHAR(32) NOT NULL DEFAULT 'collecting',
    pending_since_ms BIGINT UNSIGNED NULL,
    release_at_ms BIGINT UNSIGNED NULL,
    next_attempt_at_ms BIGINT UNSIGNED NULL,
    reason_codes TEXT NULL,
    credited_at_ms BIGINT UNSIGNED NULL,
    created_at_ms BIGINT UNSIGNED NOT NULL,
    updated_at_ms BIGINT UNSIGNED NOT NULL,
    KEY idx_deposit_batches_user_status(username,status,id),
    KEY idx_deposit_batches_due(status,expires_at_ms,release_at_ms,next_attempt_at_ms),
    KEY idx_deposit_batches_wallet(deposit_wallet_id,opened_at_ms)
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS users_usdt_transfer_events(
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    username VARCHAR(30) NOT NULL,
    deposit_wallet_id BIGINT UNSIGNED NOT NULL,
    batch_id BIGINT UNSIGNED NULL,
    deposit_address CHAR(42) NOT NULL,
    from_address CHAR(42) NOT NULL,
    amount DECIMAL(36,18) NOT NULL,
    amount_raw DECIMAL(65,0) NOT NULL,
    tx_hash CHAR(66) NOT NULL,
    log_index INT UNSIGNED NOT NULL,
    block_number BIGINT UNSIGNED NOT NULL,
    block_hash CHAR(66) NOT NULL,
    block_timestamp_ms BIGINT UNSIGNED NOT NULL,
    status VARCHAR(32) NOT NULL DEFAULT 'detected',
    reason_codes TEXT NULL,
    swept_at_ms BIGINT UNSIGNED NULL,
    created_at_ms BIGINT UNSIGNED NOT NULL,
    UNIQUE KEY uq_usdt_transfer_event(tx_hash,log_index),
    KEY idx_usdt_transfer_user_status(username,status,id),
    KEY idx_usdt_transfer_batch(batch_id,status,id),
    KEY idx_usdt_transfer_sweep(deposit_address,swept_at_ms,status),
    KEY idx_usdt_transfer_block(block_number)
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS users_usdt_sweeps(
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    deposit_wallet_id BIGINT UNSIGNED NOT NULL,
    deposit_address CHAR(42) NOT NULL,
    snapshot_block BIGINT UNSIGNED NOT NULL,
    amount_raw DECIMAL(65,0) NOT NULL,
    fund_raw_tx LONGTEXT NULL,
    token_raw_tx LONGTEXT NOT NULL,
    fund_tx_hash CHAR(66) NULL,
    token_tx_hash CHAR(66) NOT NULL,
    status VARCHAR(24) NOT NULL,
    attempts INT UNSIGNED NOT NULL DEFAULT 0,
    last_error TEXT NULL,
    created_at_ms BIGINT UNSIGNED NOT NULL,
    updated_at_ms BIGINT UNSIGNED NOT NULL,
    confirmed_at_ms BIGINT UNSIGNED NULL,
    UNIQUE KEY uq_usdt_sweep_token_hash(token_tx_hash),
    KEY idx_usdt_sweeps_wallet_status(deposit_wallet_id,status,id)
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS users_usdt_disbursements(
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    username VARCHAR(30) NOT NULL,
    payout_address CHAR(42) NOT NULL,
    requested_amount DECIMAL(36,18) NOT NULL,
    payout_amount DECIMAL(36,18) NOT NULL,
    amount_raw DECIMAL(65,0) NOT NULL,
    gross_balance DECIMAL(50,30) NOT NULL,
    gross_init_asset DECIMAL(50,30) NOT NULL,
    sold_init_asset DECIMAL(50,30) NOT NULL,
    fee_amount DECIMAL(50,30) NOT NULL,
    fee_init_asset DECIMAL(50,30) NOT NULL,
    price_value DECIMAL(50,30) NOT NULL,
    reference VARCHAR(64) NOT NULL,
    status VARCHAR(24) NOT NULL DEFAULT 'queued',
    raw_tx LONGTEXT NULL,
    tx_hash CHAR(66) NULL,
    nonce BIGINT UNSIGNED NULL,
    block_number BIGINT UNSIGNED NULL,
    last_error TEXT NULL,
    created_at_ms BIGINT UNSIGNED NOT NULL,
    reservation_expires_at_ms BIGINT UNSIGNED NOT NULL,
    updated_at_ms BIGINT UNSIGNED NOT NULL,
    confirmed_at_ms BIGINT UNSIGNED NULL,
    UNIQUE KEY uq_usdt_disbursement_reference(reference),
    UNIQUE KEY uq_usdt_disbursement_tx_hash(tx_hash),
    KEY idx_usdt_disbursement_user_success(username,status,confirmed_at_ms),
    KEY idx_usdt_disbursement_status(status,id),
    KEY idx_usdt_disbursement_reservation(status,reservation_expires_at_ms)
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS users_usdt_refunds(
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    username VARCHAR(30) NOT NULL,
    batch_id BIGINT UNSIGNED NOT NULL,
    payout_address CHAR(42) NOT NULL,
    amount DECIMAL(36,18) NOT NULL,
    amount_raw DECIMAL(65,0) NOT NULL,
    reference VARCHAR(64) NOT NULL,
    status VARCHAR(24) NOT NULL DEFAULT 'queued',
    raw_tx LONGTEXT NULL,
    tx_hash CHAR(66) NULL,
    nonce BIGINT UNSIGNED NULL,
    block_number BIGINT UNSIGNED NULL,
    last_error TEXT NULL,
    created_at_ms BIGINT UNSIGNED NOT NULL,
    updated_at_ms BIGINT UNSIGNED NOT NULL,
    confirmed_at_ms BIGINT UNSIGNED NULL,
    UNIQUE KEY uq_usdt_refund_reference(reference),
    UNIQUE KEY uq_usdt_refund_tx_hash(tx_hash),
    KEY idx_usdt_refund_batch(batch_id,status,id),
    KEY idx_usdt_refund_status(status,id)
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS admin_payment_resolutions(
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    admin_username VARCHAR(64) NOT NULL,
    username VARCHAR(30) NOT NULL,
    batch_id BIGINT UNSIGNED NULL,
    action VARCHAR(32) NOT NULL,
    gross_amount DECIMAL(36,18) NOT NULL,
    fee_amount DECIMAL(36,18) NOT NULL DEFAULT 0,
    net_amount DECIMAL(36,18) NOT NULL,
    payout_address CHAR(42) NULL,
    tx_hash CHAR(66) NULL,
    reason TEXT NOT NULL,
    created_at_ms BIGINT UNSIGNED NOT NULL,
    UNIQUE KEY uq_admin_resolution_tx_hash(tx_hash),
    KEY idx_admin_resolution_batch(batch_id,id),
    KEY idx_admin_resolution_user(username,id)
  ) ENGINE=InnoDB`,
];

async function assertLatestSchema() {
  // This project is not deployed yet. Do not ALTER or backfill legacy tables:
  // fail fast unless the database was created from the current schema below.
  const requiredColumns = {
    auths: [
      "username", "password", "name", "email", "birthdate", "cni", "address",
      "seed", "status", "consec_failed_auth", "password_temp_expires_at_ms",
      "tg_userId", "tg_chat_id", "record_date", "record_time",
    ],
    users_stock: [
      "username", "balance", "init_asset", "record_date", "record_time",
    ],
    activities: [
      "sender", "receiver", "type", "amount", "unit_price", "fees", "reference",
      "record_date", "record_time",
    ],
    telegram_link_challenges: [
      "username", "token_hash", "created_at_ms", "expires_at_ms", "used_at_ms",
    ],
    telegram_outbox: [
      "event_key", "username", "chat_id", "message_text", "status", "attempts",
      "next_attempt_at_ms", "claimed_at_ms", "last_error", "created_at_ms", "sent_at_ms",
    ],
    telegram_bot_state: ["state_key", "state_value", "updated_at_ms"],
    common: [
      "total_units_price", "unit_price", "backed_units", "inactive_init_asset",
      "record_date", "record_time",
    ],
    system_locks: ["lock_name"],
    users_usdt_deposit_wallets: [
      "username", "wallet_address", "payout_address", "derivation_index", "created_block",
      "last_scanned_block", "created_at_ms", "last_sweep_at_ms", "sweep_lock_until_ms", "account_status",
    ],
    users_usdt_deposit_batches: [
      "username", "deposit_wallet_id", "deposit_address", "opened_at_ms", "expires_at_ms",
      "total_amount", "total_amount_raw", "transfer_count", "status", "pending_since_ms",
      "release_at_ms", "next_attempt_at_ms", "reason_codes", "credited_at_ms", "created_at_ms",
      "updated_at_ms",
    ],
    users_usdt_transfer_events: [
      "username", "deposit_wallet_id", "batch_id", "deposit_address", "from_address", "amount",
      "amount_raw", "tx_hash", "log_index", "block_number", "block_hash", "block_timestamp_ms",
      "status", "reason_codes", "swept_at_ms", "created_at_ms",
    ],
    users_usdt_sweeps: [
      "deposit_wallet_id", "deposit_address", "snapshot_block", "amount_raw", "fund_raw_tx",
      "token_raw_tx", "fund_tx_hash", "token_tx_hash", "status", "attempts", "last_error",
      "created_at_ms", "updated_at_ms", "confirmed_at_ms",
    ],
    users_usdt_disbursements: [
      "username", "payout_address", "requested_amount", "payout_amount", "amount_raw",
      "gross_balance", "gross_init_asset", "sold_init_asset", "fee_amount", "fee_init_asset",
      "price_value", "reference", "status", "raw_tx", "tx_hash", "nonce", "block_number",
      "last_error", "created_at_ms", "reservation_expires_at_ms", "updated_at_ms", "confirmed_at_ms",
    ],
    users_usdt_refunds: [
      "username", "batch_id", "payout_address", "amount", "amount_raw", "reference", "status",
      "raw_tx", "tx_hash", "nonce", "block_number", "last_error", "created_at_ms", "updated_at_ms",
      "confirmed_at_ms",
    ],
    admin_payment_resolutions: [
      "admin_username", "username", "batch_id", "action", "gross_amount", "fee_amount",
      "net_amount", "payout_address", "tx_hash", "reason", "created_at_ms",
    ],
  };

  for (const [table, expected] of Object.entries(requiredColumns)) {
    const columns = await db.queryAsync(
      "SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=?",
      [table],
    );
    const actual = new Set(columns.map((row) => row.COLUMN_NAME));
    const missing = expected.filter((column) => !actual.has(column));
    if (missing.length) {
      throw new Error(
        `The database schema for ${table} is not the current OneX schema. Missing: ${missing.join(", ")}. Use a clean, empty development database; automatic legacy migrations are intentionally disabled.`,
      );
    }
  }
}

async function initDbIfEmpty() {
  const [date, time] = getDate();
  const initialTotal = new BigNumber(stock_limit);
  const initialBacked = new BigNumber(initial_backed_units);
  if (
    !initialTotal.isFinite() || !initialTotal.isGreaterThan(0) ||
    !initialBacked.isFinite() || initialBacked.isNegative() ||
    initialBacked.isGreaterThan(initialTotal)
  ) {
    throw new Error("STOCK_LIMIT and INITIAL_BACKED_UNITS must be valid; initial backed reserve must be between zero and STOCK_LIMIT.");
  }
  for (const statement of TABLES) await db.queryAsync(statement);
  await assertLatestSchema();
  await db.queryAsync(
    "INSERT IGNORE INTO system_locks(lock_name) VALUES(?),(?),(?),(?)",
    ["common_state", "deposit_wallet_index", "onex_bsc_disbursement_worker", "onex_bsc_sweeper_global"],
  );
  await db.queryAsync(
    "INSERT IGNORE INTO telegram_bot_state(state_key,state_value,updated_at_ms) VALUES('update_offset',0,?)",
    [String(Date.now())],
  );

  const stockRows = await db.queryAsync("SELECT id FROM users_stock WHERE username=? LIMIT 1", [OneX]);
  if (!stockRows.length) {
    await db.queryAsync(
      "INSERT INTO users_stock(username,balance,init_asset,record_date,record_time) VALUES(?,?,?,?,?)",
      [OneX, "0", "0", date, time],
    );
  }

  const commonRows = await db.queryAsync("SELECT id FROM common ORDER BY id DESC LIMIT 1");
  if (!commonRows.length) {
    await db.queryAsync(
      "INSERT INTO common(total_units_price,unit_price,backed_units,inactive_init_asset,record_date,record_time) VALUES(?,?,?,?,?,?)",
      [initialTotal.toFixed(), "1", initialBacked.toFixed(), "0", date, time],
    );
  }

  console.log(`OneX database ready. UTC time: ${date} ${time}`);
}

async function cleanup() {
  const [cutoffDate] = getDateBefore(90);
  try {
    // Financial ledgers and blockchain evidence are never deleted by routine cleanup.
    // Sent Telegram delivery rows are transient queue records, not notification history.
    await db.queryAsync(
      "DELETE FROM telegram_outbox WHERE status IN ('sent','skipped','failed') AND created_at_ms<?",
      [String(Date.now() - 14 * 24 * 60 * 60 * 1000)],
    );
    await db.queryAsync(
      "DELETE FROM telegram_link_challenges WHERE expires_at_ms<? OR used_at_ms IS NOT NULL",
      [String(Date.now() - 24 * 60 * 60 * 1000)],
    );
  } catch (error) {
    console.error("Database cleanup failed:", error.message);
  }
}

module.exports = {
  db,
  DB_CONFIG,
  OneX,
  maxStockDefault,
  P2Pallowed,
  stock_limit,
  initial_backed_units,
  first_welcome_clients,
  welcome_bonus,
  tfees,
  admin_pswd,
  admin_pin,
  APP_VERSION,
  PORT_SERVER,
  MAIL_PORT,
  SERVER_MAIL,
  SERVER_MAIL_PSWD,
  initDbIfEmpty,
  cleanup,
};
