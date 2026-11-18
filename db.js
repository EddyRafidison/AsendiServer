"use strict";

require("dotenv").config();
const mysql = require("mysql2");
const BigNumber = require("bignumber.js");
const { getDate, getDateBefore } = require("./utils");
const { MAX_DEFAULT_STOCK, SYSTEM_ADMIN_RESERVE_RATIO } = require("./recharge-policy");
const { calculateRemainingSystemAdminReserve } = require("./stock-accounting");

const OneX = "ONEX";
const maxStockDefault = MAX_DEFAULT_STOCK;
const P2Pallowed = String(process.env.P2P_ALLOWED || "false").toLowerCase() === "true";
const stock_limit = process.env.STOCK_LIMIT || "10000000";
// The default launch configuration initializes 10,000,000 public XTU and
// 10,000,000 backed initial assets, giving an initial global price of 1.
// Operators may override these values; the price is always derived from T / B.
const initial_backed_units = process.env.INITIAL_BACKED_UNITS || stock_limit;
const tfees = Number(process.env.FEES || 0);
const admin_pswd = process.env.ADMIN_PSWD || "";
const admin_pin = process.env.ADMIN_PIN || "";
const APP_VERSION = process.env.APP_VERSION || "";
const PORT_DB = Number(process.env.DB_PORT || 3306);
const PORT_SERVER = Number(process.env.SERVER_PORT || 3000);
const MAIL_PORT = Number(process.env.MAIL_PORT || 587);
const SERVER_MAIL = process.env.SERV_MAIL || "";
const SERVER_MAIL_PSWD = process.env.SERV_MAIL_PSWD || "";
const configuredConnectionLimit = Number(process.env.DB_CONNECTION_LIMIT || 20);
const DB_CONNECTION_LIMIT = Number.isInteger(configuredConnectionLimit)
  ? Math.max(5, Math.min(configuredConnectionLimit, 50))
  : 20;
const configuredQueueLimit = Number(process.env.DB_QUEUE_LIMIT || 100);
const DB_QUEUE_LIMIT = Number.isInteger(configuredQueueLimit)
  ? Math.max(10, Math.min(configuredQueueLimit, 500))
  : 100;
const configuredLockWaitTimeout = Number(process.env.DB_LOCK_WAIT_TIMEOUT_SECONDS || 30);
const DB_LOCK_WAIT_TIMEOUT_SECONDS = Number.isInteger(configuredLockWaitTimeout)
  ? Math.max(5, Math.min(configuredLockWaitTimeout, 60))
  : 30;

const DB_CONFIG = {
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PSWD,
  database: process.env.DB_NAME,
  port: PORT_DB,
  waitForConnections: true,
  connectionLimit: DB_CONNECTION_LIMIT,
  queueLimit: DB_QUEUE_LIMIT,
  connectTimeout: 10000,
  multipleStatements: false,
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
  // Bound row-lock waits so an abusive or stalled transaction cannot occupy a pooled connection indefinitely.
  connection.query(`SET SESSION innodb_lock_wait_timeout=${DB_LOCK_WAIT_TIMEOUT_SECONDS}`, (error) => {
    if (error) console.error("Unable to configure MySQL lock wait timeout:", error.message);
  });
});
db.queryAsync = (sql, params = []) => new Promise((resolve, reject) => {
  db.query(sql, params, (error, result) => error ? reject(error) : resolve(result));
});
db.executeAsync = (sql, params = []) => new Promise((resolve, reject) => {
  db.execute(sql, params, (error, result) => error ? reject(error) : resolve(result));
});

const TABLES = [
  `CREATE TABLE IF NOT EXISTS auths(
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    username VARCHAR(30) NOT NULL,
    password VARCHAR(255) NOT NULL,
    name VARCHAR(50) NOT NULL,
    email VARCHAR(254) NOT NULL,
    birthdate VARCHAR(20) NOT NULL,
    nationality CHAR(2) NOT NULL COMMENT 'Declared nationality using ISO 3166-1 alpha-2',
    residence_country CHAR(2) NOT NULL COMMENT 'Declared country of residence using ISO 3166-1 alpha-2',
    identity_document_type ENUM('NATIONAL_ID','PASSPORT') NOT NULL COMMENT 'National identity card or passport; foreign residents must use passport',
    identity_document_number VARCHAR(255) NOT NULL COMMENT 'Encrypted national ID card or passport number',
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
    balance DECIMAL(50,30) NOT NULL DEFAULT 0 COMMENT 'Initial-asset balance; public XTU is calculated using common.unit_price',
    seller_status TINYINT UNSIGNED NOT NULL DEFAULT 0,
    run_balance DECIMAL(50,30) NOT NULL DEFAULT 0,
    seller_activated_at_ms BIGINT UNSIGNED NULL,
    seller_expires_at_ms BIGINT UNSIGNED NULL,
    seller_last_p2p_at_ms BIGINT UNSIGNED NULL,
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
    KEY idx_activities_sender_type(sender,type,id),
    KEY idx_activities_sender_id(sender,id),
    KEY idx_activities_receiver_id(receiver,id),
    KEY idx_activities_history_sender(sender,record_date,record_time,id),
    KEY idx_activities_history_receiver(receiver,record_date,record_time,id)
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS common(
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    total_units_price DECIMAL(50,30) NOT NULL DEFAULT 10000000,
    unit_price DECIMAL(50,30) NOT NULL DEFAULT 1,
    backed_units DECIMAL(50,30) NOT NULL DEFAULT 10000000,
    inactive_init_asset DECIMAL(50,30) NOT NULL DEFAULT 0,
    sys_inactive_init_asset DECIMAL(50,30) NOT NULL DEFAULT 0,
    sellers_res DECIMAL(50,30) NOT NULL DEFAULT 0,
    total_run_balance DECIMAL(50,30) NOT NULL DEFAULT 0,
    total_bnb_fee_actual DECIMAL(50,30) NOT NULL DEFAULT 0,
    total_bnb_fee_estimated DECIMAL(50,30) NOT NULL DEFAULT 0,
    total_bnb_fee_actual_value DECIMAL(50,30) NOT NULL DEFAULT 0,
    total_bnb_fee_estimated_value DECIMAL(50,30) NOT NULL DEFAULT 0,
    total_tfees DECIMAL(50,30) NOT NULL DEFAULT 0,
    record_date INT NOT NULL,
    record_time CHAR(6) NOT NULL
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS common_price_events(
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    old_price DECIMAL(50,30) NOT NULL,
    new_price DECIMAL(50,30) NOT NULL,
    status VARCHAR(16) NOT NULL DEFAULT 'pending',
    last_username VARCHAR(30) NOT NULL DEFAULT '',
    processed_at_ms BIGINT UNSIGNED NULL,
    created_at_ms BIGINT UNSIGNED NOT NULL,
    updated_at_ms BIGINT UNSIGNED NOT NULL,
    KEY idx_common_price_events_status_id(status,id)
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS user_price_state(
    username VARCHAR(30) PRIMARY KEY,
    cycle_number INT UNSIGNED NOT NULL,
    base_price DECIMAL(50,30) NOT NULL,
    tfees_rate DECIMAL(20,10) NOT NULL,
    target_price DECIMAL(50,30) NOT NULL,
    status VARCHAR(16) NOT NULL DEFAULT 'watching',
    start_price_event_id BIGINT UNSIGNED NOT NULL DEFAULT 0,
    triggered_price DECIMAL(50,30) NULL,
    triggered_at_ms BIGINT UNSIGNED NULL,
    trigger_balance_initial_asset DECIMAL(50,30) NULL,
    required_sale_initial_asset DECIMAL(50,30) NULL,
    sold_since_trigger_initial_asset DECIMAL(50,30) NOT NULL DEFAULT 0,
    updated_at_ms BIGINT UNSIGNED NOT NULL,
    created_at_ms BIGINT UNSIGNED NOT NULL,
    KEY idx_user_price_state_threshold(status,target_price,start_price_event_id,username)
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS user_price_cycle_history(
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    username VARCHAR(30) NOT NULL,
    cycle_number INT UNSIGNED NOT NULL,
    base_price DECIMAL(50,30) NOT NULL,
    tfees_rate DECIMAL(20,10) NOT NULL,
    target_price DECIMAL(50,30) NOT NULL,
    start_price_event_id BIGINT UNSIGNED NOT NULL,
    triggered_price DECIMAL(50,30) NULL,
    triggered_at_ms BIGINT UNSIGNED NULL,
    trigger_balance_initial_asset DECIMAL(50,30) NULL,
    required_sale_initial_asset DECIMAL(50,30) NULL,
    sold_since_trigger_initial_asset DECIMAL(50,30) NOT NULL DEFAULT 0,
    resumed_at_ms BIGINT UNSIGNED NULL,
    created_at_ms BIGINT UNSIGNED NOT NULL,
    updated_at_ms BIGINT UNSIGNED NOT NULL,
    UNIQUE KEY uq_user_price_cycle(username,cycle_number),
    KEY idx_user_price_history_trigger(username,triggered_at_ms)
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS users_seller_campaigns(
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    username VARCHAR(30) NOT NULL,
    run_balance DECIMAL(50,30) NOT NULL COMMENT 'Initial assets; unit_price stores the frozen public valuation',
    reserved_initial_asset DECIMAL(50,30) NOT NULL,
    unit_price DECIMAL(50,30) NOT NULL COMMENT 'Immutable global price captured when the seller submitted this campaign; not a live account price',
    price_cycle_number INT UNSIGNED NOT NULL,
    sold_initial_asset DECIMAL(50,30) NOT NULL DEFAULT 0,
    status VARCHAR(24) NOT NULL DEFAULT 'active',
    activated_at_ms BIGINT UNSIGNED NOT NULL,
    expires_at_ms BIGINT UNSIGNED NOT NULL,
    last_p2p_at_ms BIGINT UNSIGNED NULL,
    closed_at_ms BIGINT UNSIGNED NULL,
    close_reason VARCHAR(32) NULL,
    KEY idx_seller_campaign_user_status(username,status,id),
    UNIQUE KEY uq_seller_campaign_user_cycle(username,price_cycle_number),
    KEY idx_seller_campaign_expiry(status,expires_at_ms,id)
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS users_seller_reserve_lots(
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    campaign_id BIGINT UNSIGNED NOT NULL,
    username VARCHAR(30) NOT NULL,
    original_initial_asset DECIMAL(50,30) NOT NULL,
    remaining_initial_asset DECIMAL(50,30) NOT NULL,
    unit_price DECIMAL(50,30) NOT NULL COMMENT 'Immutable campaign-submission price used for seller payout valuation',
    payout_pending_initial_asset DECIMAL(50,30) NOT NULL DEFAULT 0,
    payout_reserved_initial_asset DECIMAL(50,30) NOT NULL DEFAULT 0,
    paid_initial_asset DECIMAL(50,30) NOT NULL DEFAULT 0,
    status VARCHAR(24) NOT NULL DEFAULT 'active',
    activated_at_ms BIGINT UNSIGNED NOT NULL,
    updated_at_ms BIGINT UNSIGNED NOT NULL,
    UNIQUE KEY uq_seller_lot_campaign(campaign_id),
    KEY idx_seller_lot_fifo(status,activated_at_ms,id),
    KEY idx_seller_lot_user(username,status,id)
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS users_usdt_seller_payout_batches(
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    gross_amount DECIMAL(36,18) NOT NULL,
    status VARCHAR(24) NOT NULL DEFAULT 'queued',
    created_at_ms BIGINT UNSIGNED NOT NULL,
    updated_at_ms BIGINT UNSIGNED NOT NULL,
    completed_at_ms BIGINT UNSIGNED NULL,
    KEY idx_seller_payout_batch_status(status,id)
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS users_usdt_seller_payouts(
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    batch_id BIGINT UNSIGNED NOT NULL,
    username VARCHAR(30) NOT NULL,
    payout_address CHAR(42) NOT NULL,
    gross_amount DECIMAL(36,18) NOT NULL,
    gross_initial_asset DECIMAL(50,30) NOT NULL,
    effective_unit_price DECIMAL(50,30) NOT NULL,
    gas_fee_estimated DECIMAL(36,18) NOT NULL DEFAULT 0,
    actual_fee_bnb DECIMAL(50,30) NULL,
    actual_fee_usd DECIMAL(36,18) NULL,
    payout_amount DECIMAL(36,18) NOT NULL DEFAULT 0,
    amount_raw DECIMAL(65,0) NOT NULL DEFAULT 0,
    bnb_usd_price DECIMAL(36,18) NOT NULL DEFAULT 0,
    raw_tx LONGTEXT NULL,
    tx_hash CHAR(66) NULL,
    nonce BIGINT UNSIGNED NULL,
    block_number BIGINT UNSIGNED NULL,
    status VARCHAR(24) NOT NULL DEFAULT 'queued',
    last_error TEXT NULL,
    created_at_ms BIGINT UNSIGNED NOT NULL,
    updated_at_ms BIGINT UNSIGNED NOT NULL,
    confirmed_at_ms BIGINT UNSIGNED NULL,
    UNIQUE KEY uq_seller_payout_tx_hash(tx_hash),
    KEY idx_seller_payout_status(status,id),
    KEY idx_seller_payout_user(username,status,id),
    KEY idx_seller_payout_batch(batch_id,status,id)
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS users_seller_payout_allocations(
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    payout_id BIGINT UNSIGNED NOT NULL,
    lot_id BIGINT UNSIGNED NOT NULL,
    initial_asset_amount DECIMAL(50,30) NOT NULL,
    gross_amount DECIMAL(36,18) NOT NULL,
    unit_price DECIMAL(50,30) NOT NULL COMMENT 'Immutable source-lot campaign price snapshot',
    status VARCHAR(16) NOT NULL DEFAULT 'reserved',
    created_at_ms BIGINT UNSIGNED NOT NULL,
    UNIQUE KEY uq_seller_payout_lot(payout_id,lot_id),
    KEY idx_seller_payout_allocation_lot(lot_id,status,id)
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS bsc_fee_ledger(
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    tx_hash CHAR(66) NOT NULL,
    operation VARCHAR(32) NOT NULL,
    estimated_fee_bnb DECIMAL(50,30) NOT NULL DEFAULT 0,
    estimated_fee_usd DECIMAL(50,30) NOT NULL DEFAULT 0,
    bnb_usd_price DECIMAL(36,18) NOT NULL DEFAULT 0,
    gas_used DECIMAL(50,0) NULL,
    effective_gas_price_wei DECIMAL(65,0) NULL,
    actual_fee_bnb DECIMAL(50,30) NULL,
    actual_fee_usd DECIMAL(50,30) NULL,
    created_at_ms BIGINT UNSIGNED NOT NULL,
    confirmed_at_ms BIGINT UNSIGNED NULL,
    UNIQUE KEY uq_bsc_fee_tx_hash(tx_hash),
    KEY idx_bsc_fee_operation(operation,created_at_ms)
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS account_security_action_locks(
    username VARCHAR(30) NOT NULL,
    action VARCHAR(32) NOT NULL,
    updated_at_ms BIGINT UNSIGNED NOT NULL,
    PRIMARY KEY(username,action)
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS account_security_events(
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    username VARCHAR(30) NOT NULL,
    action VARCHAR(32) NOT NULL,
    outcome VARCHAR(16) NOT NULL,
    created_at_ms BIGINT UNSIGNED NOT NULL,
    KEY idx_account_security_events_window(username,action,created_at_ms,outcome)
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS account_api_rate_limits(
    username VARCHAR(30) NOT NULL,
    action VARCHAR(48) NOT NULL,
    window_start_ms BIGINT UNSIGNED NOT NULL,
    request_count INT UNSIGNED NOT NULL DEFAULT 0,
    updated_at_ms BIGINT UNSIGNED NOT NULL,
    PRIMARY KEY(username,action,window_start_ms),
    KEY idx_account_api_rate_cleanup(window_start_ms)
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
    gross_initial_asset DECIMAL(50,30) NOT NULL,
    sold_initial_asset DECIMAL(50,30) NOT NULL,
    fee_amount DECIMAL(36,18) NOT NULL COMMENT 'BSC-USD fee value locked at submission',
    fee_initial_asset DECIMAL(50,30) NOT NULL,
    price_value DECIMAL(50,30) NOT NULL COMMENT 'Immutable common.unit_price captured at user request submission',
    disbursement_mode VARCHAR(16) NOT NULL DEFAULT 'individual',
    global_run_id BIGINT UNSIGNED NULL,
    balance_after_reservation DECIMAL(50,30) NOT NULL DEFAULT 0,
    bsc_fee_recovered_usd DECIMAL(36,18) NOT NULL DEFAULT 0,
    estimated_fee_bnb DECIMAL(50,30) NOT NULL DEFAULT 0,
    estimated_fee_usd DECIMAL(50,30) NOT NULL DEFAULT 0,
    actual_fee_bnb DECIMAL(50,30) NULL,
    actual_fee_usd DECIMAL(50,30) NULL,
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
  `CREATE TABLE IF NOT EXISTS global_disbursement_runs(
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    status VARCHAR(24) NOT NULL DEFAULT 'queued',
    trigger_reason TEXT NOT NULL,
    decision_reference VARCHAR(128) NOT NULL,
    snapshot_unit_price DECIMAL(50,30) NOT NULL,
    snapshot_total_units_price DECIMAL(50,30) NOT NULL,
    planned_total_initial_asset DECIMAL(50,30) NOT NULL DEFAULT 0,
    last_user_stock_id BIGINT UNSIGNED NOT NULL DEFAULT 0,
    max_user_stock_id BIGINT UNSIGNED NOT NULL DEFAULT 0,
    total_users BIGINT UNSIGNED NOT NULL DEFAULT 0,
    processed_users BIGINT UNSIGNED NOT NULL DEFAULT 0,
    total_gross_initial_asset DECIMAL(50,30) NOT NULL DEFAULT 0,
    total_paid_bsc_usd DECIMAL(50,18) NOT NULL DEFAULT 0,
    last_error TEXT NULL,
    created_at_ms BIGINT UNSIGNED NOT NULL,
    updated_at_ms BIGINT UNSIGNED NOT NULL,
    completed_at_ms BIGINT UNSIGNED NULL,
    UNIQUE KEY uq_global_disbursement_decision(decision_reference),
    KEY idx_global_disbursement_status(status,id)
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS users_usdt_refunds(
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    username VARCHAR(30) NOT NULL,
    batch_id BIGINT UNSIGNED NOT NULL,
    payout_address CHAR(42) NOT NULL,
    amount DECIMAL(36,18) NOT NULL,
    gross_amount DECIMAL(36,18) NOT NULL DEFAULT 0,
    fee_amount DECIMAL(36,18) NOT NULL DEFAULT 0,
    amount_raw DECIMAL(65,0) NOT NULL,
    estimated_fee_bnb DECIMAL(50,30) NOT NULL DEFAULT 0,
    estimated_fee_usd DECIMAL(50,30) NOT NULL DEFAULT 0,
    actual_fee_bnb DECIMAL(50,30) NULL,
    actual_fee_usd DECIMAL(50,30) NULL,
    bnb_usd_price DECIMAL(36,18) NOT NULL DEFAULT 0,
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
    initial_asset_amount DECIMAL(50,30) NOT NULL DEFAULT 0,
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
  // This pre-deployment project uses a fresh schema. Do not ALTER or backfill legacy tables;
  // fail fast unless the database was created from the current schema below.
  const requiredColumns = {
    auths: [
      "username", "password", "name", "email", "birthdate", "nationality", "residence_country", "identity_document_type", "identity_document_number", "address",
      "seed", "status", "consec_failed_auth", "password_temp_expires_at_ms",
      "tg_userId", "tg_chat_id", "record_date", "record_time",
    ],
    users_stock: [
      "username", "balance", "seller_status", "run_balance",
      "seller_activated_at_ms", "seller_expires_at_ms", "seller_last_p2p_at_ms", "record_date", "record_time",
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
      "total_units_price", "unit_price", "backed_units", "inactive_init_asset", "sys_inactive_init_asset",
      "sellers_res", "total_run_balance", "total_tfees", "total_bnb_fee_actual", "total_bnb_fee_estimated",
      "total_bnb_fee_actual_value", "total_bnb_fee_estimated_value", "record_date", "record_time",
    ],
    common_price_events: ["old_price", "new_price", "status", "last_username", "processed_at_ms", "created_at_ms", "updated_at_ms"],
    user_price_state: ["username", "cycle_number", "base_price", "tfees_rate", "target_price", "status", "start_price_event_id", "triggered_price", "triggered_at_ms", "trigger_balance_initial_asset", "required_sale_initial_asset", "sold_since_trigger_initial_asset", "updated_at_ms", "created_at_ms"],
    user_price_cycle_history: ["username", "cycle_number", "base_price", "tfees_rate", "target_price", "start_price_event_id", "triggered_price", "triggered_at_ms", "trigger_balance_initial_asset", "required_sale_initial_asset", "sold_since_trigger_initial_asset", "resumed_at_ms", "created_at_ms", "updated_at_ms"],
    users_seller_campaigns: [
      "username", "run_balance", "reserved_initial_asset", "unit_price", "price_cycle_number",
      "sold_initial_asset", "status", "activated_at_ms", "expires_at_ms", "last_p2p_at_ms", "closed_at_ms", "close_reason",
    ],
    users_seller_reserve_lots: [
      "campaign_id", "username", "original_initial_asset", "remaining_initial_asset", "unit_price",
      "payout_pending_initial_asset", "payout_reserved_initial_asset", "paid_initial_asset",
      "status", "activated_at_ms", "updated_at_ms",
    ],
    users_usdt_seller_payout_batches: ["gross_amount", "status", "created_at_ms", "updated_at_ms", "completed_at_ms"],
    users_usdt_seller_payouts: [
      "batch_id", "username", "payout_address", "gross_amount", "gross_initial_asset", "effective_unit_price", "gas_fee_estimated", "actual_fee_bnb",
      "actual_fee_usd", "payout_amount", "amount_raw", "bnb_usd_price", "raw_tx", "tx_hash", "nonce", "block_number", "status",
      "last_error", "created_at_ms", "updated_at_ms", "confirmed_at_ms",
    ],
    users_seller_payout_allocations: ["payout_id", "lot_id", "initial_asset_amount", "gross_amount", "unit_price", "status", "created_at_ms"],
    bsc_fee_ledger: [
      "tx_hash", "operation", "estimated_fee_bnb", "estimated_fee_usd", "bnb_usd_price", "gas_used",
      "effective_gas_price_wei", "actual_fee_bnb", "actual_fee_usd", "created_at_ms", "confirmed_at_ms",
    ],
    account_security_action_locks: ["username", "action", "updated_at_ms"],
    account_security_events: ["username", "action", "outcome", "created_at_ms"],
    account_api_rate_limits: ["username", "action", "window_start_ms", "request_count", "updated_at_ms"],
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
      "gross_initial_asset", "sold_initial_asset", "fee_amount", "fee_initial_asset",
      "price_value", "disbursement_mode", "global_run_id", "balance_after_reservation", "bsc_fee_recovered_usd",
      "estimated_fee_bnb", "estimated_fee_usd", "actual_fee_bnb", "actual_fee_usd",
      "reference", "status", "raw_tx", "tx_hash", "nonce", "block_number",
      "last_error", "created_at_ms", "reservation_expires_at_ms", "updated_at_ms", "confirmed_at_ms",
    ],
    global_disbursement_runs: ["status", "trigger_reason", "decision_reference", "snapshot_unit_price", "snapshot_total_units_price", "planned_total_initial_asset", "last_user_stock_id", "max_user_stock_id", "total_users", "processed_users", "total_gross_initial_asset", "total_paid_bsc_usd", "last_error", "created_at_ms", "updated_at_ms", "completed_at_ms"],
    users_usdt_refunds: [
      "username", "batch_id", "payout_address", "amount", "gross_amount", "fee_amount", "amount_raw",
      "estimated_fee_bnb", "estimated_fee_usd", "actual_fee_bnb", "actual_fee_usd", "bnb_usd_price",
      "reference", "status", "raw_tx", "tx_hash", "nonce", "block_number", "last_error",
      "created_at_ms", "updated_at_ms", "confirmed_at_ms",
    ],
    admin_payment_resolutions: [
      "admin_username", "username", "batch_id", "action", "initial_asset_amount", "gross_amount", "fee_amount",
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

  const requiredIndexes = {
    activities: [
      "idx_activities_sender_id",
      "idx_activities_receiver_id",
      "idx_activities_history_sender",
      "idx_activities_history_receiver",
    ],
  };
  for (const [table, expected] of Object.entries(requiredIndexes)) {
    const indexes = await db.queryAsync(
      "SELECT DISTINCT INDEX_NAME FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=?",
      [table],
    );
    const actual = new Set(indexes.map((row) => row.INDEX_NAME));
    const missing = expected.filter((indexName) => !actual.has(indexName));
    if (missing.length) {
      throw new Error(
        `The database table ${table} is missing required performance indexes: ${missing.join(", ")}. Apply the current schema indexes before starting OneX.`,
      );
    }
  }
}

async function initDbIfEmpty() {
  const [date, time] = getDate();
  const initialTotal = new BigNumber(stock_limit);
  const initialBacked = new BigNumber(initial_backed_units);
  const initialAdminReserve = initialTotal.multipliedBy(SYSTEM_ADMIN_RESERVE_RATIO);
  if (
    !initialTotal.isFinite() || !initialTotal.isGreaterThan(0) ||
    !initialBacked.isFinite() || !initialBacked.isGreaterThan(0) ||
    !SYSTEM_ADMIN_RESERVE_RATIO.isFinite() || SYSTEM_ADMIN_RESERVE_RATIO.isNegative() ||
    !SYSTEM_ADMIN_RESERVE_RATIO.isLessThan(1) ||
    initialBacked.isLessThan(initialAdminReserve)
  ) {
    throw new Error("STOCK_LIMIT, SYSTEM_ADMIN_RESERVE_RATIO and INITIAL_BACKED_UNITS must be valid; initial backed assets must cover the non-distributable administrative reserve.");
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
      "INSERT INTO users_stock(username,balance,record_date,record_time) VALUES(?,?,?,?)",
      [OneX, "0", date, time],
    );
  }

  const commonRows = await db.queryAsync("SELECT id FROM common ORDER BY id DESC LIMIT 1");
  if (!commonRows.length) {
    await db.queryAsync(
      "INSERT INTO common(total_units_price,unit_price,backed_units,inactive_init_asset,sys_inactive_init_asset,sellers_res,total_run_balance,total_tfees,record_date,record_time) VALUES(?,?,?,?,?,?,?,?,?,?)",
      [initialTotal.toFixed(), initialTotal.dividedBy(initialBacked).toFixed(30), initialBacked.toFixed(), "0", "0", "0", "0", "0", date, time],
    );
  }

  const latestCommonRows = await db.queryAsync(
    `SELECT total_units_price,unit_price,backed_units,inactive_init_asset,sys_inactive_init_asset
     FROM common ORDER BY id DESC LIMIT 1`,
  );
  if (!latestCommonRows.length) throw new Error("Common reserve initialization failed");
  const latestCommon = latestCommonRows[0];
  const remainingAdminReserve = calculateRemainingSystemAdminReserve(
    initialTotal,
    SYSTEM_ADMIN_RESERVE_RATIO,
    latestCommon.sys_inactive_init_asset || "0",
  ).remainingInitialAsset;
  const currentBackedInitialAssets = new BigNumber(latestCommon.backed_units);
  const currentTotalUnitsPrice = new BigNumber(latestCommon.total_units_price);
  const storedUnitPrice = new BigNumber(latestCommon.unit_price);
  if (
    !currentBackedInitialAssets.isFinite() || !currentBackedInitialAssets.isGreaterThan(0) ||
    !currentTotalUnitsPrice.isFinite() || !currentTotalUnitsPrice.isGreaterThan(0)
  ) {
    throw new Error("common.total_units_price and common.backed_units must remain finite and strictly positive.");
  }
  if (currentBackedInitialAssets.isLessThan(remainingAdminReserve)) {
    throw new Error("common.backed_units does not cover the remaining non-distributable administrative reserve quota.");
  }
  const expectedUnitPrice = currentTotalUnitsPrice.dividedBy(currentBackedInitialAssets);
  if (!storedUnitPrice.isFinite() || storedUnitPrice.minus(expectedUnitPrice).abs().gt("0.000000000000000000000000000001")) {
    throw new Error("common.unit_price must equal common.total_units_price / common.backed_units");
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
    await db.queryAsync(
      "DELETE FROM account_security_events WHERE created_at_ms<?",
      [String(Date.now() - 8 * 24 * 60 * 60 * 1000)],
    );
    await db.queryAsync(
      "DELETE FROM account_api_rate_limits WHERE window_start_ms<?",
      [String(Date.now() - 2 * 24 * 60 * 60 * 1000)],
    );
    await db.queryAsync(
      `DELETE action_lock FROM account_security_action_locks AS action_lock
       LEFT JOIN auths ON auths.username=action_lock.username
       WHERE auths.username IS NULL AND action_lock.updated_at_ms<?`,
      [String(Date.now() - 30 * 24 * 60 * 60 * 1000)],
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
  tfees,
  admin_pswd,
  admin_pin,
  APP_VERSION,
  PORT_SERVER,
  MAIL_PORT,
  SERVER_MAIL,
  SERVER_MAIL_PSWD,
  DB_CONNECTION_LIMIT,
  DB_QUEUE_LIMIT,
  DB_LOCK_WAIT_TIMEOUT_SECONDS,
  initDbIfEmpty,
  cleanup,
};
