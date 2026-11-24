"use strict";

require("dotenv").config();
const mysql = require("mysql2");
const BigNumber = require("bignumber.js");
const { getDate, getDateBefore } = require("./utils");
const { MAX_DEFAULT_STOCK, SYSTEM_ADMIN_RESERVE_RATIO } = require("./deposit-policy");
const { calculateRemainingSystemAdminReserve } = require("./stock-accounting");

const OneX = "ONEX";
const maxStockDefault = MAX_DEFAULT_STOCK;
const P2Pallowed = String(process.env.P2P_ALLOWED || "false").toLowerCase() === "true";
const stock_limit = process.env.STOCK_LIMIT || "18000000";
// The default launch configuration initializes 18,000,000 public XTU and
// 18,000,000 backed initial assets, giving an initial global price of 1.
// Operators may override these values; the initial price is derived from T / B. Later snapshots preserve the prior global price as a floor.
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
    registration_sequence BIGINT UNSIGNED NOT NULL,
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
    wallet_address CHAR(42) NOT NULL COMMENT 'User-declared fixed BNB Smart Chain wallet; ownership is not cryptographically verified',
    account_active TINYINT UNSIGNED NOT NULL DEFAULT 1 COMMENT 'Administrative account access switch',
    account_deactivation_reason VARCHAR(1000) NULL,
    account_deactivated_at_ms BIGINT UNSIGNED NULL,
    account_deactivated_by VARCHAR(64) NULL,
    welcome_bonus_status VARCHAR(24) NOT NULL DEFAULT 'pending',
    welcome_bonus_amount_xtu DECIMAL(36,18) NOT NULL DEFAULT 0,
    welcome_bonus_initial_asset DECIMAL(50,30) NOT NULL DEFAULT 0,
    welcome_bonus_email_hash CHAR(64) NOT NULL,
    welcome_bonus_identity_hash CHAR(64) NOT NULL,
    welcome_bonus_unit_price DECIMAL(50,30) NULL,
    welcome_bonus_decided_at_ms BIGINT UNSIGNED NULL,
    welcome_bonus_credited_at_ms BIGINT UNSIGNED NULL,
    created_at_ms BIGINT UNSIGNED NOT NULL,
    last_login_at_ms BIGINT UNSIGNED NULL,
    consec_failed_auth INT UNSIGNED NOT NULL DEFAULT 0,
    password_temp_expires_at_ms BIGINT UNSIGNED NULL,
    tg_userId VARCHAR(32) NULL,
    tg_chat_id VARCHAR(32) NULL,
    record_date INT NOT NULL,
    record_time CHAR(6) NOT NULL,
    UNIQUE KEY uq_auths_username(username),
    UNIQUE KEY uq_auths_registration_sequence(registration_sequence),
    UNIQUE KEY uq_auths_email(email),
    UNIQUE KEY uq_auths_wallet_address(wallet_address),
    KEY idx_auths_first_login_cleanup(last_login_at_ms,created_at_ms),
    KEY idx_auths_welcome_email_hash(welcome_bonus_email_hash),
    KEY idx_auths_welcome_identity_hash(welcome_bonus_identity_hash),
    UNIQUE KEY uq_auths_tg_user_id(tg_userId),
    UNIQUE KEY uq_auths_tg_chat_id(tg_chat_id),
    KEY idx_auths_failed_auth(consec_failed_auth)
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS auth_devices(
    username VARCHAR(30) PRIMARY KEY,
    device_id VARCHAR(80) NOT NULL,
    public_key_der TEXT NOT NULL,
    public_key_fingerprint CHAR(64) NOT NULL,
    session_token_hash CHAR(64) NOT NULL,
    session_expires_at_ms BIGINT UNSIGNED NOT NULL,
    registered_at_ms BIGINT UNSIGNED NOT NULL,
    last_seen_at_ms BIGINT UNSIGNED NOT NULL,
    KEY idx_auth_devices_fingerprint(public_key_fingerprint),
    KEY idx_auth_devices_session_expiry(session_expires_at_ms)
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS auth_device_challenges(
    challenge_id CHAR(43) PRIMARY KEY,
    username VARCHAR(30) NOT NULL,
    device_id VARCHAR(80) NOT NULL,
    public_key_der TEXT NOT NULL,
    public_key_fingerprint CHAR(64) NOT NULL,
    challenge_value CHAR(43) NOT NULL,
    expires_at_ms BIGINT UNSIGNED NOT NULL,
    used_at_ms BIGINT UNSIGNED NULL,
    created_at_ms BIGINT UNSIGNED NOT NULL,
    KEY idx_auth_device_challenge_user(username,expires_at_ms,used_at_ms),
    KEY idx_auth_device_challenge_expiry(expires_at_ms)
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS auth_device_request_nonces(
    username VARCHAR(30) NOT NULL,
    device_id VARCHAR(80) NOT NULL,
    nonce VARCHAR(80) NOT NULL,
    expires_at_ms BIGINT UNSIGNED NOT NULL,
    created_at_ms BIGINT UNSIGNED NOT NULL,
    PRIMARY KEY(username,device_id,nonce),
    KEY idx_auth_device_nonce_expiry(expires_at_ms)
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS auth_device_events(
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    username VARCHAR(30) NOT NULL,
    event_type VARCHAR(32) NOT NULL,
    old_device_id VARCHAR(80) NULL,
    new_device_id VARCHAR(80) NULL,
    old_key_fingerprint CHAR(64) NULL,
    new_key_fingerprint CHAR(64) NULL,
    ip_hash CHAR(64) NULL,
    user_agent VARCHAR(512) NULL,
    reason VARCHAR(1000) NULL,
    created_at_ms BIGINT UNSIGNED NOT NULL,
    KEY idx_auth_device_events_user(username,id),
    KEY idx_auth_device_events_created(created_at_ms)
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS account_security_email_outbox(
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    event_key VARCHAR(191) NOT NULL,
    username VARCHAR(30) NOT NULL,
    recipient VARCHAR(254) NOT NULL,
    subject VARCHAR(255) NOT NULL,
    message_text TEXT NOT NULL,
    status VARCHAR(16) NOT NULL DEFAULT 'pending',
    attempts INT UNSIGNED NOT NULL DEFAULT 0,
    next_attempt_at_ms BIGINT UNSIGNED NOT NULL,
    claimed_at_ms BIGINT UNSIGNED NULL,
    last_error TEXT NULL,
    created_at_ms BIGINT UNSIGNED NOT NULL,
    sent_at_ms BIGINT UNSIGNED NULL,
    UNIQUE KEY uq_account_security_email_event(event_key),
    KEY idx_account_security_email_due(status,next_attempt_at_ms,id)
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS users_stock(
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    username VARCHAR(30) NOT NULL,
    balance DECIMAL(50,30) NOT NULL DEFAULT 0 COMMENT 'Initial-asset principal; user XTU value uses the individual effective price',
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
    receiver VARCHAR(40) NOT NULL,
    type INT NOT NULL,
    amount DECIMAL(50,30) NOT NULL,
    unit_price DECIMAL(50,30) NOT NULL DEFAULT 0,
    fees DECIMAL(50,30) NOT NULL DEFAULT 0,
    fee_unit_price DECIMAL(50,30) NOT NULL DEFAULT 0 COMMENT 'Global price used to value system tfees in common reserves',
    bsc_fee_cost_usd DECIMAL(50,30) NOT NULL DEFAULT 0 COMMENT 'Actual BSC network cost allocated to this activity',
    reference VARCHAR(64) NULL,
    record_date INT NOT NULL,
    record_time CHAR(6) NOT NULL,
    UNIQUE KEY uq_activities_reference(reference),
    KEY idx_activities_deposit_user(sender,receiver,type,record_date,record_time,id),
    KEY idx_activities_sender_type(sender,type,id),
    KEY idx_activities_sender_id(sender,id),
    KEY idx_activities_receiver_id(receiver,id),
    KEY idx_activities_history_sender(sender,record_date,record_time,id),
    KEY idx_activities_history_receiver(receiver,record_date,record_time,id)
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS common(
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    total_units_price DECIMAL(50,30) NOT NULL DEFAULT 18000000,
    unit_price DECIMAL(50,30) NOT NULL DEFAULT 1,
    xtu_wallets DECIMAL(50,30) NOT NULL DEFAULT 0 COMMENT 'Net XTU currently externalized to user wallets and not yet returned; never add it to reserves',
    xtu_wallets_reserved DECIMAL(50,30) NOT NULL DEFAULT 0 COMMENT 'BSC-USD cover provisionally reserved for in-flight XTU withdrawals',
    backed_units DECIMAL(50,30) NOT NULL DEFAULT 18000000,
    inactive_init_asset DECIMAL(50,30) NOT NULL DEFAULT 0,
    sys_inactive_init_asset DECIMAL(50,30) NOT NULL DEFAULT 0,
    sellers_res DECIMAL(50,30) NOT NULL DEFAULT 0,
    total_run_balance DECIMAL(50,30) NOT NULL DEFAULT 0,
    total_bnb_fee_actual DECIMAL(50,30) NOT NULL DEFAULT 0,
    total_bnb_fee_estimated DECIMAL(50,30) NOT NULL DEFAULT 0,
    total_bnb_fee_actual_value DECIMAL(50,30) NOT NULL DEFAULT 0,
    total_bnb_fee_estimated_value DECIMAL(50,30) NOT NULL DEFAULT 0,
    total_tfees DECIMAL(50,30) NOT NULL DEFAULT 0,
    total_tfees_bsc_cost_usd DECIMAL(50,30) NOT NULL DEFAULT 0,
    total_tfees_bsc_uncovered_usd DECIMAL(50,30) NOT NULL DEFAULT 0,
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
    remuneration_rate DECIMAL(20,10) NOT NULL,
    target_price DECIMAL(50,30) NOT NULL,
    status VARCHAR(16) NOT NULL DEFAULT 'watching',
    start_price_event_id BIGINT UNSIGNED NOT NULL DEFAULT 0,
    triggered_price DECIMAL(50,30) NULL,
    triggered_at_ms BIGINT UNSIGNED NULL,
    frozen_price DECIMAL(50,30) NULL,
    sale_group_base_initial_asset DECIMAL(50,30) NULL,
    sale_group_volume_initial_asset DECIMAL(50,30) NOT NULL DEFAULT 0,
    sale_group_fee_weighted DECIMAL(50,30) NOT NULL DEFAULT 0,
    purchase_group_base_initial_asset DECIMAL(50,30) NULL,
    purchase_group_volume_initial_asset DECIMAL(50,30) NOT NULL DEFAULT 0,
    purchase_group_fee_weighted DECIMAL(50,30) NOT NULL DEFAULT 0,
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
    remuneration_rate DECIMAL(20,10) NOT NULL,
    target_price DECIMAL(50,30) NOT NULL,
    start_price_event_id BIGINT UNSIGNED NOT NULL,
    triggered_price DECIMAL(50,30) NULL,
    triggered_at_ms BIGINT UNSIGNED NULL,
    principal_before_operation DECIMAL(50,30) NULL,
    operation_direction VARCHAR(16) NULL,
    operation_volume_initial_asset DECIMAL(50,30) NOT NULL DEFAULT 0,
    resumed_at_ms BIGINT UNSIGNED NULL,
    resume_reason VARCHAR(48) NULL,
    created_at_ms BIGINT UNSIGNED NOT NULL,
    updated_at_ms BIGINT UNSIGNED NOT NULL,
    UNIQUE KEY uq_user_price_cycle(username,cycle_number),
    KEY idx_user_price_history_trigger(username,triggered_at_ms)
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS users_seller_campaigns(
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    username VARCHAR(30) NOT NULL,
    run_balance DECIMAL(50,30) NOT NULL COMMENT 'Initial assets; unit_price stores the frozen individual valuation',
    reserved_initial_asset DECIMAL(50,30) NOT NULL COMMENT 'User initial-asset principal reserved until the XTU transaction is resolved',
    unit_price DECIMAL(50,30) NOT NULL COMMENT 'Immutable individual price captured when the seller submitted this campaign',
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
    unit_price DECIMAL(50,30) NOT NULL COMMENT 'Immutable individual campaign price used for seller payout valuation',
    payout_pending_initial_asset DECIMAL(50,30) NOT NULL DEFAULT 0,
    payout_reserved_initial_asset DECIMAL(50,30) NOT NULL DEFAULT 0,
    paid_initial_asset DECIMAL(50,30) NOT NULL DEFAULT 0,
    status VARCHAR(24) NOT NULL DEFAULT 'active',
    activated_at_ms BIGINT UNSIGNED NOT NULL,
    updated_at_ms BIGINT UNSIGNED NOT NULL,
    UNIQUE KEY uq_seller_lot_campaign(campaign_id),
    KEY idx_seller_lot_fifo(status,activated_at_ms,id),
    KEY idx_seller_lot_availability(status,remaining_initial_asset,campaign_id),
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
  `CREATE TABLE IF NOT EXISTS deposit_service_control(
    control_id TINYINT UNSIGNED PRIMARY KEY,
    is_suspended TINYINT UNSIGNED NOT NULL DEFAULT 0,
    suspension_reason VARCHAR(1000) NULL,
    changed_by VARCHAR(64) NOT NULL DEFAULT 'system',
    updated_at_ms BIGINT UNSIGNED NOT NULL
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS deposit_service_control_events(
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    action VARCHAR(16) NOT NULL,
    previous_suspended TINYINT UNSIGNED NOT NULL,
    current_suspended TINYINT UNSIGNED NOT NULL,
    reason VARCHAR(1000) NOT NULL,
    changed_by VARCHAR(64) NOT NULL,
    created_at_ms BIGINT UNSIGNED NOT NULL,
    KEY idx_deposit_control_events_created(created_at_ms,id)
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS individual_disbursement_control(
    control_id TINYINT UNSIGNED PRIMARY KEY,
    is_open TINYINT UNSIGNED NOT NULL DEFAULT 0,
    opening_reason VARCHAR(1000) NULL,
    notice_reference VARCHAR(512) NULL,
    changed_by VARCHAR(64) NOT NULL DEFAULT 'system',
    opened_at_ms BIGINT UNSIGNED NULL,
    closed_at_ms BIGINT UNSIGNED NULL,
    updated_at_ms BIGINT UNSIGNED NOT NULL
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS individual_disbursement_control_events(
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    action VARCHAR(16) NOT NULL,
    previous_open TINYINT UNSIGNED NOT NULL,
    current_open TINYINT UNSIGNED NOT NULL,
    reason VARCHAR(1000) NOT NULL,
    notice_reference VARCHAR(512) NULL,
    changed_by VARCHAR(64) NOT NULL,
    created_at_ms BIGINT UNSIGNED NOT NULL,
    KEY idx_individual_disbursement_control_events_created(created_at_ms,id)
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS xtu_withdrawal_control(
    control_id TINYINT UNSIGNED PRIMARY KEY,
    is_open TINYINT UNSIGNED NOT NULL DEFAULT 0,
    reason VARCHAR(1000) NULL,
    changed_by VARCHAR(64) NOT NULL DEFAULT 'system',
    started_at_ms BIGINT UNSIGNED NULL,
    stopped_at_ms BIGINT UNSIGNED NULL,
    updated_at_ms BIGINT UNSIGNED NOT NULL
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS xtu_withdrawal_control_events(
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    action VARCHAR(16) NOT NULL,
    previous_open TINYINT UNSIGNED NOT NULL,
    current_open TINYINT UNSIGNED NOT NULL,
    reason VARCHAR(1000) NOT NULL,
    changed_by VARCHAR(64) NOT NULL,
    created_at_ms BIGINT UNSIGNED NOT NULL,
    KEY idx_xtu_withdrawal_control_events_created(created_at_ms,id)
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS xtu_withdrawals(
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    reference VARCHAR(64) NOT NULL,
    username VARCHAR(30) NOT NULL,
    payout_address CHAR(42) NOT NULL,
    gross_amount DECIMAL(36,18) NOT NULL,
    reserved_initial_asset DECIMAL(50,30) NOT NULL COMMENT 'User initial-asset principal reserved until the XTU transaction is resolved',
    effective_unit_price DECIMAL(50,30) NOT NULL,
    global_unit_price DECIMAL(50,30) NOT NULL,
    estimated_gas_fee_bnb DECIMAL(50,30) NOT NULL DEFAULT 0,
    estimated_gas_fee_usd DECIMAL(50,30) NOT NULL DEFAULT 0,
    estimated_gas_fee_xtu DECIMAL(36,18) NOT NULL DEFAULT 0,
    contract_transfer_amount DECIMAL(36,18) NOT NULL,
    contract_fee_amount DECIMAL(36,18) NOT NULL,
    net_amount DECIMAL(36,18) NOT NULL,
    reserved_xtu_value DECIMAL(50,30) NOT NULL COMMENT 'Gross XTU reserve value removed at the captured individual price',
    bnb_usd_price DECIMAL(36,18) NOT NULL,
    amount_raw VARCHAR(80) NOT NULL,
    gas_limit BIGINT UNSIGNED NOT NULL,
    gas_price_wei VARCHAR(80) NOT NULL,
    token_contract_address CHAR(42) NOT NULL,
    raw_tx LONGTEXT NULL,
    tx_hash CHAR(66) NULL,
    nonce BIGINT UNSIGNED NULL,
    block_number BIGINT UNSIGNED NULL,
    actual_gas_fee_bnb DECIMAL(50,30) NULL,
    actual_gas_fee_usd DECIMAL(50,30) NULL,
    actual_contract_fee_amount DECIMAL(36,18) NULL,
    actual_net_amount DECIMAL(36,18) NULL,
    receipt_json LONGTEXT NULL,
    status VARCHAR(24) NOT NULL DEFAULT 'queued',
    last_error VARCHAR(1000) NULL,
    next_attempt_at_ms BIGINT UNSIGNED NOT NULL,
    created_at_ms BIGINT UNSIGNED NOT NULL,
    updated_at_ms BIGINT UNSIGNED NOT NULL,
    signed_at_ms BIGINT UNSIGNED NULL,
    submitted_at_ms BIGINT UNSIGNED NULL,
    confirmed_at_ms BIGINT UNSIGNED NULL,
    failed_at_ms BIGINT UNSIGNED NULL,
    UNIQUE KEY uq_xtu_withdrawals_reference(reference),
    UNIQUE KEY uq_xtu_withdrawals_tx_hash(tx_hash),
    KEY idx_xtu_withdrawals_status_due(status,next_attempt_at_ms,id),
    KEY idx_xtu_withdrawals_username_status(username,status,id)
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS xtu_withdrawal_events(
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    event_key VARCHAR(100) NOT NULL,
    withdrawal_id BIGINT UNSIGNED NOT NULL,
    event_type VARCHAR(32) NOT NULL,
    previous_status VARCHAR(24) NULL,
    current_status VARCHAR(24) NOT NULL,
    actor VARCHAR(64) NOT NULL,
    tx_hash CHAR(66) NULL,
    details VARCHAR(1000) NULL,
    created_at_ms BIGINT UNSIGNED NOT NULL,
    UNIQUE KEY uq_xtu_withdrawal_event_key(event_key),
    KEY idx_xtu_withdrawal_events_withdrawal(withdrawal_id,id)
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS xtu_deposit_scan_state(
    singleton_id TINYINT UNSIGNED PRIMARY KEY,
    chain_id BIGINT UNSIGNED NOT NULL,
    token_contract CHAR(42) NOT NULL,
    hot_wallet_address CHAR(42) NOT NULL,
    start_block BIGINT UNSIGNED NOT NULL,
    last_scanned_block BIGINT UNSIGNED NOT NULL,
    last_scanned_block_hash CHAR(66) NULL,
    last_finalized_block BIGINT UNSIGNED NOT NULL DEFAULT 0,
    finality_method VARCHAR(24) NOT NULL DEFAULT 'confirmations',
    health_status VARCHAR(24) NOT NULL DEFAULT 'initializing',
    last_error VARCHAR(1000) NULL,
    updated_at_ms BIGINT UNSIGNED NOT NULL
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS xtu_deposit_batches(
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    username VARCHAR(30) NOT NULL,
    hot_wallet_address CHAR(42) NOT NULL,
    opened_at_ms BIGINT UNSIGNED NOT NULL,
    expires_at_ms BIGINT UNSIGNED NOT NULL,
    initial_group_deadline_ms BIGINT UNSIGNED NOT NULL,
    gross_amount DECIMAL(36,18) NOT NULL DEFAULT 0,
    hot_wallet_received_amount DECIMAL(36,18) NOT NULL DEFAULT 0,
    commission_amount DECIMAL(36,18) NOT NULL DEFAULT 0,
    returned_amount DECIMAL(36,18) NOT NULL DEFAULT 0,
    credited_amount DECIMAL(36,18) NOT NULL DEFAULT 0,
    remaining_amount DECIMAL(36,18) NOT NULL DEFAULT 0,
    transfer_count INT UNSIGNED NOT NULL DEFAULT 0,
    credit_sequence INT UNSIGNED NOT NULL DEFAULT 0,
    pending_since_ms BIGINT UNSIGNED NULL,
    release_at_ms BIGINT UNSIGNED NULL,
    gas_allocated_usd DECIMAL(36,18) NOT NULL DEFAULT 0,
    gas_allocated_xtu DECIMAL(36,18) NOT NULL DEFAULT 0,
    deposit_fee_amount DECIMAL(36,18) NOT NULL DEFAULT 0,
    status VARCHAR(32) NOT NULL DEFAULT 'collecting',
    reason_codes TEXT NULL,
    global_run_id BIGINT UNSIGNED NULL,
    tfees_rate_percent DECIMAL(20,10) NOT NULL DEFAULT 0,
    created_at_ms BIGINT UNSIGNED NOT NULL,
    updated_at_ms BIGINT UNSIGNED NOT NULL,
    KEY idx_xtu_deposit_batch_user_status(username,status,id),
    KEY idx_xtu_deposit_batch_due(status,expires_at_ms,release_at_ms,id)
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS xtu_deposit_transfer_events(
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    username VARCHAR(30) NULL,
    batch_id BIGINT UNSIGNED NULL,
    token_contract CHAR(42) NOT NULL,
    from_address CHAR(42) NOT NULL,
    hot_wallet_address CHAR(42) NOT NULL,
    gross_amount DECIMAL(36,18) NOT NULL,
    net_amount DECIMAL(36,18) NOT NULL,
    commission_amount DECIMAL(36,18) NOT NULL,
    gross_amount_raw DECIMAL(65,0) NOT NULL,
    net_amount_raw DECIMAL(65,0) NOT NULL,
    commission_amount_raw DECIMAL(65,0) NOT NULL,
    allocated_gas_fee_usd DECIMAL(36,18) NOT NULL DEFAULT 0,
    allocated_gas_fee_xtu DECIMAL(36,18) NOT NULL DEFAULT 0,
    tx_hash CHAR(66) NOT NULL,
    log_index INT UNSIGNED NOT NULL,
    block_number BIGINT UNSIGNED NOT NULL,
    block_hash CHAR(66) NOT NULL,
    block_timestamp_ms BIGINT UNSIGNED NOT NULL,
    event_identity CHAR(64) NOT NULL,
    status VARCHAR(32) NOT NULL DEFAULT 'detected',
    reason_codes TEXT NULL,
    created_at_ms BIGINT UNSIGNED NOT NULL,
    UNIQUE KEY uq_xtu_deposit_event_identity(event_identity),
    UNIQUE KEY uq_xtu_deposit_event_tx_log(tx_hash,log_index),
    KEY idx_xtu_deposit_event_user_status(username,status,id),
    KEY idx_xtu_deposit_event_batch(batch_id,status,id),
    KEY idx_xtu_deposit_event_block(block_number)
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS xtu_deposit_consolidations(
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    anchor_batch_id BIGINT UNSIGNED NOT NULL,
    amount DECIMAL(36,18) NOT NULL,
    amount_raw DECIMAL(65,0) NOT NULL,
    hot_wallet_address CHAR(42) NOT NULL,
    distribution_address CHAR(42) NOT NULL,
    estimated_gas_fee_bnb DECIMAL(50,30) NOT NULL DEFAULT 0,
    estimated_gas_fee_usd DECIMAL(50,30) NOT NULL DEFAULT 0,
    actual_gas_fee_bnb DECIMAL(50,30) NULL,
    actual_gas_fee_usd DECIMAL(50,30) NULL,
    gas_bnb_usd_price DECIMAL(36,18) NULL,
    gas_limit BIGINT UNSIGNED NOT NULL,
    gas_price_wei VARCHAR(80) NULL,
    gas_allocation_method VARCHAR(64) NOT NULL DEFAULT 'gross_weighted_event_identity_v1',
    raw_tx LONGTEXT NULL,
    tx_hash CHAR(66) NULL,
    nonce BIGINT UNSIGNED NULL,
    block_number BIGINT UNSIGNED NULL,
    receipt_json LONGTEXT NULL,
    status VARCHAR(24) NOT NULL DEFAULT 'queued',
    last_error VARCHAR(1000) NULL,
    created_at_ms BIGINT UNSIGNED NOT NULL,
    updated_at_ms BIGINT UNSIGNED NOT NULL,
    confirmed_at_ms BIGINT UNSIGNED NULL,
    KEY idx_xtu_deposit_consolidation_anchor_batch(anchor_batch_id),
    UNIQUE KEY uq_xtu_deposit_consolidation_hash(tx_hash),
    KEY idx_xtu_deposit_consolidation_status(status,id)
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS xtu_deposit_consolidation_items(
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    consolidation_id BIGINT UNSIGNED NOT NULL,
    batch_id BIGINT UNSIGNED NOT NULL,
    username VARCHAR(30) NOT NULL,
    gross_returned_xtu DECIMAL(36,18) NOT NULL,
    hot_wallet_received_xtu DECIMAL(36,18) NOT NULL,
    contract_commission_xtu DECIMAL(36,18) NOT NULL,
    estimated_gas_fee_bnb DECIMAL(50,30) NOT NULL DEFAULT 0,
    estimated_gas_fee_usd DECIMAL(50,30) NOT NULL DEFAULT 0,
    allocated_gas_fee_bnb DECIMAL(50,30) NOT NULL DEFAULT 0,
    allocated_gas_fee_usd DECIMAL(50,30) NOT NULL DEFAULT 0,
    allocated_gas_fee_xtu DECIMAL(50,30) NOT NULL DEFAULT 0,
    status VARCHAR(24) NOT NULL DEFAULT 'queued',
    created_at_ms BIGINT UNSIGNED NOT NULL,
    updated_at_ms BIGINT UNSIGNED NOT NULL,
    UNIQUE KEY uq_xtu_consolidation_item_batch(batch_id),
    KEY idx_xtu_consolidation_items_lot(consolidation_id,batch_id),
    KEY idx_xtu_consolidation_items_user(username,status,id)
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS xtu_deposit_credits(
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    batch_id BIGINT UNSIGNED NOT NULL,
    username VARCHAR(30) NOT NULL,
    credit_sequence INT UNSIGNED NOT NULL,
    gross_returned_xtu DECIMAL(36,18) NOT NULL,
    deposit_fee_xtu DECIMAL(36,18) NOT NULL,
    gas_fee_xtu DECIMAL(36,18) NOT NULL,
    creditable_xtu DECIMAL(36,18) NOT NULL,
    credited_initial_asset DECIMAL(50,30) NOT NULL,
    global_unit_price DECIMAL(50,30) NOT NULL,
    reference VARCHAR(64) NOT NULL,
    global_run_id BIGINT UNSIGNED NULL,
    source_event_hashes_json LONGTEXT NOT NULL,
    consolidation_tx_hash CHAR(66) NOT NULL,
    status VARCHAR(24) NOT NULL DEFAULT 'credited',
    created_at_ms BIGINT UNSIGNED NOT NULL,
    UNIQUE KEY uq_xtu_deposit_credit_batch_seq(batch_id,credit_sequence),
    UNIQUE KEY uq_xtu_deposit_credit_reference(reference),
    KEY idx_xtu_deposit_credit_user(username,created_at_ms,id)
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS xtu_global_settlement_ledger(
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    global_run_id BIGINT UNSIGNED NOT NULL,
    username VARCHAR(30) NOT NULL,
    deposit_batch_id BIGINT UNSIGNED NOT NULL,
    credit_sequence INT UNSIGNED NOT NULL,
    tx_hash CHAR(66) NOT NULL,
    source_event_hashes_json LONGTEXT NOT NULL,
    consolidation_tx_hash CHAR(66) NOT NULL,
    gross_returned_xtu DECIMAL(36,18) NOT NULL,
    deposit_fee_xtu DECIMAL(36,18) NOT NULL DEFAULT 0,
    gas_fee_xtu DECIMAL(36,18) NOT NULL,
    global_unit_price DECIMAL(50,30) NOT NULL,
    credited_initial_asset DECIMAL(50,30) NOT NULL,
    reserved_xtu_amount DECIMAL(36,18) NOT NULL,
    remaining_xtu_amount DECIMAL(36,18) NOT NULL,
    settled_xtu_amount DECIMAL(36,18) NOT NULL DEFAULT 0,
    status VARCHAR(24) NOT NULL DEFAULT 'reserved',
    created_at_ms BIGINT UNSIGNED NOT NULL,
    updated_at_ms BIGINT UNSIGNED NOT NULL,
    UNIQUE KEY uq_xtu_global_settlement_deposit_tranche(deposit_batch_id,credit_sequence),
    KEY idx_xtu_global_settlement_run_user(global_run_id,username,status,id)
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS xtu_deposit_email_outbox(
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    event_key VARCHAR(120) NOT NULL,
    username VARCHAR(30) NOT NULL,
    recipient VARCHAR(254) NOT NULL,
    subject VARCHAR(200) NOT NULL,
    message_text TEXT NOT NULL,
    status VARCHAR(16) NOT NULL DEFAULT 'pending',
    attempts INT UNSIGNED NOT NULL DEFAULT 0,
    next_attempt_at_ms BIGINT UNSIGNED NOT NULL,
    last_error VARCHAR(1000) NULL,
    created_at_ms BIGINT UNSIGNED NOT NULL,
    sent_at_ms BIGINT UNSIGNED NULL,
    UNIQUE KEY uq_xtu_deposit_email_event(event_key),
    KEY idx_xtu_deposit_email_due(status,next_attempt_at_ms,id)
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS xtu_global_settlement_payouts(
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    ledger_id BIGINT UNSIGNED NOT NULL,
    global_run_id BIGINT UNSIGNED NOT NULL,
    username VARCHAR(30) NOT NULL,
    payout_address CHAR(42) NOT NULL,
    net_amount DECIMAL(36,18) NOT NULL,
    gross_amount DECIMAL(36,18) NOT NULL,
    contract_fee_amount DECIMAL(36,18) NOT NULL,
    estimated_gas_fee_bnb DECIMAL(50,30) NOT NULL DEFAULT 0,
    estimated_gas_fee_usd DECIMAL(50,30) NOT NULL DEFAULT 0,
    actual_gas_fee_bnb DECIMAL(50,30) NULL,
    actual_gas_fee_usd DECIMAL(50,30) NULL,
    raw_tx LONGTEXT NULL,
    tx_hash CHAR(66) NULL,
    nonce BIGINT UNSIGNED NULL,
    gas_limit BIGINT UNSIGNED NULL,
    gas_price_wei DECIMAL(50,0) NULL,
    block_number BIGINT UNSIGNED NULL,
    receipt_json LONGTEXT NULL,
    status VARCHAR(24) NOT NULL DEFAULT 'queued',
    last_error VARCHAR(1000) NULL,
    created_at_ms BIGINT UNSIGNED NOT NULL,
    updated_at_ms BIGINT UNSIGNED NOT NULL,
    confirmed_at_ms BIGINT UNSIGNED NULL,
    UNIQUE KEY uq_xtu_global_settlement_payout_ledger(ledger_id),
    UNIQUE KEY uq_xtu_global_settlement_payout_hash(tx_hash),
    KEY idx_xtu_global_settlement_payout_status(status,id)
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS account_cleanup_holds(
    username VARCHAR(30) PRIMARY KEY,
    reason_codes VARCHAR(1000) NOT NULL,
    first_detected_at_ms BIGINT UNSIGNED NOT NULL,
    last_checked_at_ms BIGINT UNSIGNED NOT NULL,
    KEY idx_account_cleanup_holds_checked(last_checked_at_ms)
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS welcome_bonus_claims(
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    subject_type ENUM('email','identity') NOT NULL,
    subject_hash CHAR(64) NOT NULL,
    username VARCHAR(30) NOT NULL,
    amount_xtu DECIMAL(36,18) NOT NULL,
    credited_at_ms BIGINT UNSIGNED NOT NULL,
    UNIQUE KEY uq_welcome_bonus_subject(subject_type,subject_hash),
    KEY idx_welcome_bonus_claim_username(username,credited_at_ms)
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS account_registration_counters(
    counter_name VARCHAR(64) PRIMARY KEY,
    last_value BIGINT UNSIGNED NOT NULL DEFAULT 0
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS account_access_events(
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    username VARCHAR(30) NOT NULL,
    action VARCHAR(24) NOT NULL,
    reason VARCHAR(1000) NOT NULL,
    changed_by VARCHAR(64) NOT NULL,
    created_at_ms BIGINT UNSIGNED NOT NULL,
    KEY idx_account_access_events_user(username,id),
    KEY idx_account_access_events_created(created_at_ms,id)
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS system_locks(
    lock_name VARCHAR(64) PRIMARY KEY
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS bsc_wallet_address_registry(
    wallet_address_lower CHAR(42) PRIMARY KEY,
    wallet_address CHAR(42) NOT NULL,
    username VARCHAR(30) NOT NULL,
    registered_at_ms BIGINT UNSIGNED NOT NULL,
    KEY idx_bsc_wallet_registry_username(username)
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS bsc_treasury_sweeps(
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    token_contract CHAR(42) NOT NULL,
    source_address CHAR(42) NOT NULL,
    destination_address CHAR(42) NOT NULL,
    amount DECIMAL(36,18) NOT NULL,
    amount_raw DECIMAL(65,0) NOT NULL,
    balance_before DECIMAL(36,18) NOT NULL,
    reserves_snapshot DECIMAL(36,18) NOT NULL,
    minimum_operating_snapshot DECIMAL(36,18) NOT NULL,
    available_snapshot DECIMAL(36,18) NOT NULL,
    sweep_percent DECIMAL(10,4) NOT NULL,
    gas_fee_estimated_bnb DECIMAL(50,30) NOT NULL DEFAULT 0,
    gas_fee_estimated_usd DECIMAL(36,18) NOT NULL DEFAULT 0,
    actual_fee_bnb DECIMAL(50,30) NULL,
    actual_fee_usd DECIMAL(36,18) NULL,
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
    UNIQUE KEY uq_treasury_sweep_tx_hash(tx_hash),
    KEY idx_treasury_sweep_status(status,id)
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS bsc_incoming_scan_state(
    singleton_id TINYINT UNSIGNED PRIMARY KEY,
    chain_id SMALLINT UNSIGNED NOT NULL,
    token_contract CHAR(42) NOT NULL,
    treasury_address CHAR(42) NOT NULL,
    scan_start_block BIGINT UNSIGNED NOT NULL,
    last_scanned_block BIGINT UNSIGNED NULL,
    last_scanned_block_hash CHAR(66) NULL,
    last_finalized_block BIGINT UNSIGNED NULL,
    finality_method VARCHAR(16) NOT NULL DEFAULT 'confirmations',
    health_status VARCHAR(24) NOT NULL DEFAULT 'healthy',
    manual_review_code VARCHAR(48) NULL,
    manual_review_at_ms BIGINT UNSIGNED NULL,
    last_error TEXT NULL,
    updated_at_ms BIGINT UNSIGNED NOT NULL
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS bsc_scan_checkpoints(
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    block_number BIGINT UNSIGNED NOT NULL,
    block_hash CHAR(66) NOT NULL,
    finality_method VARCHAR(16) NOT NULL,
    checkpoint_status VARCHAR(16) NOT NULL DEFAULT 'canonical',
    created_at_ms BIGINT UNSIGNED NOT NULL,
    UNIQUE KEY uq_bsc_scan_checkpoint_hash(block_number,block_hash),
    KEY idx_bsc_scan_checkpoint_status_block(checkpoint_status,block_number)
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS bsc_scan_reconciliation_previews(
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    status VARCHAR(16) NOT NULL DEFAULT 'previewed',
    scanner_reason_code VARCHAR(48) NULL,
    previous_block BIGINT UNSIGNED NULL,
    previous_block_hash CHAR(66) NULL,
    candidate_resume_block BIGINT UNSIGNED NOT NULL,
    candidate_resume_hash CHAR(66) NOT NULL,
    observed_finalized_block BIGINT UNSIGNED NOT NULL,
    rpc_endpoints_count TINYINT UNSIGNED NOT NULL,
    total_events INT UNSIGNED NOT NULL DEFAULT 0,
    canonical_events INT UNSIGNED NOT NULL DEFAULT 0,
    re_included_events INT UNSIGNED NOT NULL DEFAULT 0,
    orphaned_events INT UNSIGNED NOT NULL DEFAULT 0,
    unverifiable_events INT UNSIGNED NOT NULL DEFAULT 0,
    compensation_required_events INT UNSIGNED NOT NULL DEFAULT 0,
    summary_json LONGTEXT NULL,
    created_by VARCHAR(64) NOT NULL,
    created_at_ms BIGINT UNSIGNED NOT NULL,
    expires_at_ms BIGINT UNSIGNED NOT NULL,
    committed_at_ms BIGINT UNSIGNED NULL,
    last_error TEXT NULL,
    KEY idx_bsc_scan_preview_status(status,id),
    KEY idx_bsc_scan_preview_expiry(expires_at_ms)
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS bsc_scan_reconciliation_items(
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    preview_id BIGINT UNSIGNED NOT NULL,
    source_table VARCHAR(48) NOT NULL,
    source_id BIGINT UNSIGNED NOT NULL,
    tx_hash CHAR(66) NOT NULL,
    log_index INT UNSIGNED NOT NULL,
    batch_id BIGINT UNSIGNED NULL,
    amount DECIMAL(36,18) NOT NULL,
    amount_raw DECIMAL(65,0) NOT NULL,
    old_block BIGINT UNSIGNED NOT NULL,
    old_block_hash CHAR(66) NOT NULL,
    observed_block BIGINT UNSIGNED NULL,
    observed_block_hash CHAR(66) NULL,
    observed_timestamp_ms BIGINT UNSIGNED NULL,
    observed_log_index INT UNSIGNED NULL,
    classification VARCHAR(24) NOT NULL,
    financial_impact TINYINT UNSIGNED NOT NULL DEFAULT 0,
    resolution_status VARCHAR(24) NOT NULL DEFAULT 'pending',
    compensation_reference VARCHAR(64) NULL,
    resolution_reason VARCHAR(1000) NULL,
    resolved_by VARCHAR(64) NULL,
    resolved_at_ms BIGINT UNSIGNED NULL,
    details_json TEXT NULL,
    created_at_ms BIGINT UNSIGNED NOT NULL,
    UNIQUE KEY uq_bsc_scan_reconcile_item(preview_id,source_table,source_id),
    KEY idx_bsc_scan_reconcile_preview_class(preview_id,classification,resolution_status),
    KEY idx_bsc_scan_reconcile_batch(preview_id,batch_id)
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS bsc_unknown_incoming_transfers(
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    token_contract CHAR(42) NOT NULL,
    from_address CHAR(42) NOT NULL,
    to_address CHAR(42) NOT NULL,
    amount DECIMAL(36,18) NOT NULL,
    amount_raw DECIMAL(65,0) NOT NULL,
    tx_hash CHAR(66) NOT NULL,
    log_index INT UNSIGNED NOT NULL,
    block_number BIGINT UNSIGNED NOT NULL,
    block_hash CHAR(66) NOT NULL,
    block_timestamp_ms BIGINT UNSIGNED NOT NULL,
    previous_username VARCHAR(30) NULL,
    status VARCHAR(32) NOT NULL DEFAULT 'pending_admin',
    decision_action VARCHAR(32) NULL,
    decision_username VARCHAR(30) NULL,
    decision_reason TEXT NULL,
    decided_by VARCHAR(64) NULL,
    decided_at_ms BIGINT UNSIGNED NULL,
    refund_id BIGINT UNSIGNED NULL,
    created_at_ms BIGINT UNSIGNED NOT NULL,
    updated_at_ms BIGINT UNSIGNED NOT NULL,
    event_identity CHAR(64) NOT NULL,
    UNIQUE KEY uq_bsc_unknown_event_identity(event_identity),
    KEY idx_bsc_unknown_tx_log(tx_hash,log_index),
    KEY idx_bsc_unknown_status(status,id),
    KEY idx_bsc_unknown_sender(from_address,block_number)
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS bsc_scan_admin_events(
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    admin_username VARCHAR(64) NOT NULL,
    action VARCHAR(32) NOT NULL,
    previous_block BIGINT UNSIGNED NULL,
    previous_block_hash CHAR(66) NULL,
    resume_after_block BIGINT UNSIGNED NOT NULL,
    resume_block_hash CHAR(66) NOT NULL,
    observed_finalized_block BIGINT UNSIGNED NOT NULL,
    reason TEXT NOT NULL,
    created_at_ms BIGINT UNSIGNED NOT NULL,
    KEY idx_bsc_scan_admin_events_created(created_at_ms,id)
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
  `CREATE TABLE IF NOT EXISTS users_usdt_deposit_batches(
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    username VARCHAR(30) NOT NULL,
    treasury_address CHAR(42) NOT NULL,
    opened_at_ms BIGINT UNSIGNED NOT NULL,
    expires_at_ms BIGINT UNSIGNED NOT NULL,
    initial_group_deadline_ms BIGINT UNSIGNED NOT NULL,
    total_amount DECIMAL(36,18) NOT NULL DEFAULT 0,
    total_amount_raw DECIMAL(65,0) NOT NULL DEFAULT 0,
    credited_amount DECIMAL(36,18) NOT NULL DEFAULT 0,
    remaining_amount DECIMAL(36,18) NOT NULL DEFAULT 0,
    refunded_amount DECIMAL(36,18) NOT NULL DEFAULT 0,
    reserved_refund_amount DECIMAL(36,18) NOT NULL DEFAULT 0,
    tfees_rate_percent DECIMAL(20,10) NOT NULL,
    transfer_count INT UNSIGNED NOT NULL DEFAULT 0,
    credit_sequence INT UNSIGNED NOT NULL DEFAULT 0,
    minimum_met_at_ms BIGINT UNSIGNED NULL,
    status VARCHAR(32) NOT NULL DEFAULT 'collecting',
    pending_since_ms BIGINT UNSIGNED NULL,
    release_at_ms BIGINT UNSIGNED NULL,
    next_attempt_at_ms BIGINT UNSIGNED NULL,
    reason_codes TEXT NULL,
    last_credit_at_ms BIGINT UNSIGNED NULL,
    credited_at_ms BIGINT UNSIGNED NULL,
    created_at_ms BIGINT UNSIGNED NOT NULL,
    updated_at_ms BIGINT UNSIGNED NOT NULL,
    KEY idx_deposit_batches_user_status(username,status,id),
    KEY idx_deposit_batches_due(status,expires_at_ms,release_at_ms,next_attempt_at_ms),
    KEY idx_deposit_batches_pending_user(username,status,remaining_amount,id)
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS users_usdt_deposit_credits(
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    batch_id BIGINT UNSIGNED NOT NULL,
    username VARCHAR(30) NOT NULL,
    credit_sequence INT UNSIGNED NOT NULL,
    gross_amount DECIMAL(36,18) NOT NULL,
    tfees_rate_percent DECIMAL(20,10) NOT NULL,
    fee_amount DECIMAL(36,18) NOT NULL,
    net_amount DECIMAL(36,18) NOT NULL,
    credited_initial_asset DECIMAL(50,30) NOT NULL,
    unit_price DECIMAL(50,30) NOT NULL,
    financial_reference VARCHAR(64) NOT NULL,
    created_at_ms BIGINT UNSIGNED NOT NULL,
    UNIQUE KEY uq_deposit_credit_sequence(batch_id,credit_sequence),
    UNIQUE KEY uq_deposit_credit_reference(financial_reference),
    KEY idx_deposit_credit_user(username,created_at_ms,id)
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS users_usdt_transfer_events(
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    username VARCHAR(30) NOT NULL,
    batch_id BIGINT UNSIGNED NULL,
    treasury_address CHAR(42) NOT NULL,
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
    event_identity CHAR(64) NOT NULL,
    created_at_ms BIGINT UNSIGNED NOT NULL,
    UNIQUE KEY uq_usdt_transfer_event_identity(event_identity),
    KEY idx_usdt_transfer_event_tx_log(tx_hash,log_index),
    KEY idx_usdt_transfer_user_status(username,status,id),
    KEY idx_usdt_transfer_batch(batch_id,status,id),
    KEY idx_usdt_transfer_block(block_number)
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
    fee_amount DECIMAL(36,18) NOT NULL COMMENT 'tfees XTU value locked at the participant individual price at submission',
    fee_initial_asset DECIMAL(50,30) NOT NULL,
    tfees_rate_percent DECIMAL(20,10) NOT NULL DEFAULT 0,
    price_value DECIMAL(50,30) NOT NULL COMMENT 'Immutable individual price captured at user request submission',
    disbursement_mode VARCHAR(16) NOT NULL DEFAULT 'individual',
    global_run_id BIGINT UNSIGNED NULL,
    balance_after_reservation DECIMAL(50,30) NOT NULL DEFAULT 0,
    bsc_fee_recovered_usd DECIMAL(36,18) NOT NULL DEFAULT 0,
    bonus_amount DECIMAL(36,18) NOT NULL DEFAULT 0,
    bonus_initial_asset DECIMAL(50,30) NOT NULL DEFAULT 0,
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
    KEY idx_usdt_disbursement_reserve_availability(status,sold_initial_asset),
    KEY idx_usdt_disbursement_reservation(status,reservation_expires_at_ms)
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS global_disbursement_runs(
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    status VARCHAR(24) NOT NULL DEFAULT 'announced',
    trigger_reason TEXT NOT NULL,
    decision_reference VARCHAR(128) NOT NULL,
    notice_method VARCHAR(24) NOT NULL DEFAULT 'external',
    notice_reference VARCHAR(255) NOT NULL,
    request_window_days SMALLINT UNSIGNED NOT NULL,
    extension_days SMALLINT UNSIGNED NOT NULL DEFAULT 30,
    planned_activation_at_ms BIGINT UNSIGNED NOT NULL,
    request_deadline_at_ms BIGINT UNSIGNED NOT NULL DEFAULT 0,
    extension_deadline_at_ms BIGINT UNSIGNED NOT NULL DEFAULT 0,
    activated_at_ms BIGINT UNSIGNED NULL,
    closed_at_ms BIGINT UNSIGNED NULL,
    snapshot_unit_price DECIMAL(50,30) NOT NULL,
    snapshot_total_units_price DECIMAL(50,30) NOT NULL,
    planned_total_initial_asset DECIMAL(50,30) NOT NULL DEFAULT 0,
    last_user_stock_id BIGINT UNSIGNED NOT NULL DEFAULT 0,
    max_user_stock_id BIGINT UNSIGNED NOT NULL DEFAULT 0,
    total_users BIGINT UNSIGNED NOT NULL DEFAULT 0,
    processed_users BIGINT UNSIGNED NOT NULL DEFAULT 0,
    total_gross_initial_asset DECIMAL(50,30) NOT NULL DEFAULT 0,
    total_requested_initial_asset DECIMAL(50,30) NOT NULL DEFAULT 0,
    total_paid_bsc_usd DECIMAL(50,18) NOT NULL DEFAULT 0,
    bonus_rate_percent DECIMAL(20,10) NOT NULL DEFAULT 0,
    admin_bonus_reserved_initial_asset DECIMAL(50,30) NOT NULL DEFAULT 0,
    admin_bonus_committed_initial_asset DECIMAL(50,30) NOT NULL DEFAULT 0,
    total_bonus_paid_bsc_usd DECIMAL(50,18) NOT NULL DEFAULT 0,
    total_bonus_paid_initial_asset DECIMAL(50,30) NOT NULL DEFAULT 0,
    total_bsc_gas_actual_usd DECIMAL(50,18) NOT NULL DEFAULT 0,
    announced_at_ms BIGINT UNSIGNED NOT NULL,
    effective_at_ms BIGINT UNSIGNED NOT NULL,
    last_error TEXT NULL,
    created_at_ms BIGINT UNSIGNED NOT NULL,
    updated_at_ms BIGINT UNSIGNED NOT NULL,
    completed_at_ms BIGINT UNSIGNED NULL,
    UNIQUE KEY uq_global_disbursement_decision(decision_reference),
    KEY idx_global_disbursement_status(status,id)
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS global_disbursement_participants(
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    run_id BIGINT UNSIGNED NOT NULL,
    username VARCHAR(30) NOT NULL,
    snapshot_balance_initial DECIMAL(50,30) NOT NULL,
    snapshot_base_price DECIMAL(50,30) NOT NULL,
    snapshot_remuneration_rate DECIMAL(20,10) NOT NULL,
    snapshot_target_price DECIMAL(50,30) NOT NULL,
    snapshot_unit_price DECIMAL(50,30) NOT NULL,
    snapshot_price_status VARCHAR(16) NOT NULL,
    requested_initial_asset DECIMAL(50,30) NOT NULL DEFAULT 0,
    paid_initial_asset DECIMAL(50,30) NOT NULL DEFAULT 0,
    remaining_initial_asset DECIMAL(50,30) NOT NULL DEFAULT 0,
    request_count INT UNSIGNED NOT NULL DEFAULT 0,
    last_disbursement_id BIGINT UNSIGNED NULL,
    status VARCHAR(24) NOT NULL DEFAULT 'awaiting_request',
    resolution_action VARCHAR(40) NULL,
    resolution_reference VARCHAR(255) NULL,
    resolution_reason TEXT NULL,
    resolved_at_ms BIGINT UNSIGNED NULL,
    created_at_ms BIGINT UNSIGNED NOT NULL,
    updated_at_ms BIGINT UNSIGNED NOT NULL,
    UNIQUE KEY uq_global_participant_run_user(run_id,username),
    KEY idx_global_participant_run_status(run_id,status,id)
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS global_disbursement_email_outbox(
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    run_id BIGINT UNSIGNED NOT NULL,
    username VARCHAR(30) NOT NULL,
    recipient VARCHAR(254) NOT NULL,
    subject VARCHAR(191) NOT NULL,
    message_text TEXT NOT NULL,
    status VARCHAR(16) NOT NULL DEFAULT 'pending',
    attempts INT UNSIGNED NOT NULL DEFAULT 0,
    next_attempt_at_ms BIGINT UNSIGNED NOT NULL,
    claimed_at_ms BIGINT UNSIGNED NULL,
    last_error TEXT NULL,
    created_at_ms BIGINT UNSIGNED NOT NULL,
    sent_at_ms BIGINT UNSIGNED NULL,
    UNIQUE KEY uq_global_notice_email(run_id,username),
    KEY idx_global_notice_email_due(status,next_attempt_at_ms,id)
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS users_usdt_refunds(
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    username VARCHAR(30) NOT NULL,
    batch_id BIGINT UNSIGNED NULL,
    unknown_transfer_id BIGINT UNSIGNED NULL,
    user_request_id BIGINT UNSIGNED NULL,
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
    UNIQUE KEY uq_usdt_refund_unknown_transfer(unknown_transfer_id),
    UNIQUE KEY uq_usdt_refund_user_request(user_request_id),
    KEY idx_usdt_refund_batch(batch_id,status,id),
    KEY idx_usdt_refund_status(status,id)
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS user_usdt_refund_requests(
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    request_reference VARCHAR(64) NOT NULL,
    username VARCHAR(30) NOT NULL,
    batch_id BIGINT UNSIGNED NOT NULL,
    request_type ENUM('threshold','emergency') NOT NULL,
    user_reason TEXT NOT NULL,
    status VARCHAR(24) NOT NULL DEFAULT 'pending_admin',
    refund_id BIGINT UNSIGNED NULL,
    admin_username VARCHAR(64) NULL,
    admin_reason TEXT NULL,
    last_error TEXT NULL,
    created_at_ms BIGINT UNSIGNED NOT NULL,
    updated_at_ms BIGINT UNSIGNED NOT NULL,
    approved_at_ms BIGINT UNSIGNED NULL,
    resolved_at_ms BIGINT UNSIGNED NULL,
    completed_at_ms BIGINT UNSIGNED NULL,
    failed_at_ms BIGINT UNSIGNED NULL,
    UNIQUE KEY uq_user_usdt_refund_request_reference(request_reference),
    UNIQUE KEY uq_user_usdt_refund_request_refund(refund_id),
    KEY idx_user_usdt_refund_request_user(username,status,id),
    KEY idx_user_usdt_refund_request_batch(batch_id,status,id)
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS user_usdt_refund_request_events(
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    request_id BIGINT UNSIGNED NOT NULL,
    refund_id BIGINT UNSIGNED NULL,
    event_key VARCHAR(191) NOT NULL,
    event_type VARCHAR(32) NOT NULL,
    actor_type VARCHAR(16) NOT NULL DEFAULT 'system',
    actor_username VARCHAR(64) NULL,
    old_status VARCHAR(24) NULL,
    new_status VARCHAR(24) NULL,
    reason TEXT NULL,
    tx_hash CHAR(66) NULL,
    gross_amount DECIMAL(36,18) NOT NULL DEFAULT 0,
    fee_amount DECIMAL(36,18) NOT NULL DEFAULT 0,
    net_amount DECIMAL(36,18) NOT NULL DEFAULT 0,
    created_at_ms BIGINT UNSIGNED NOT NULL,
    UNIQUE KEY uq_user_refund_request_event_key(event_key),
    KEY idx_user_refund_request_event_request(request_id,id),
    KEY idx_user_refund_request_event_refund(refund_id,id)
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS admin_payment_resolutions(
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    admin_username VARCHAR(64) NOT NULL,
    username VARCHAR(30) NOT NULL,
    batch_id BIGINT UNSIGNED NULL,
    unknown_transfer_id BIGINT UNSIGNED NULL,
    user_refund_request_id BIGINT UNSIGNED NULL,
    refund_id BIGINT UNSIGNED NULL,
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
    KEY idx_admin_resolution_user(username,id),
    KEY idx_admin_resolution_refund(refund_id,id)
  ) ENGINE=InnoDB`,
];

async function assertLatestSchema() {
  // This pre-deployment project uses a fresh schema. Do not ALTER or backfill legacy tables;
  // fail fast unless the database was created from the current schema below.
  const requiredColumns = {
    auths: [
      "username", "registration_sequence", "password", "name", "email", "birthdate", "nationality", "residence_country", "identity_document_type", "identity_document_number", "address",
      "seed", "wallet_address", "account_active", "account_deactivation_reason", "account_deactivated_at_ms", "account_deactivated_by",
      "welcome_bonus_status", "welcome_bonus_amount_xtu", "welcome_bonus_initial_asset",
      "welcome_bonus_email_hash", "welcome_bonus_identity_hash", "welcome_bonus_unit_price",
      "welcome_bonus_decided_at_ms", "welcome_bonus_credited_at_ms",
      "created_at_ms", "last_login_at_ms", "consec_failed_auth", "password_temp_expires_at_ms",
      "tg_userId", "tg_chat_id", "record_date", "record_time",
    ],
    auth_devices: ["username", "device_id", "public_key_der", "public_key_fingerprint", "session_token_hash", "session_expires_at_ms", "registered_at_ms", "last_seen_at_ms"],
    auth_device_challenges: ["challenge_id", "username", "device_id", "public_key_der", "public_key_fingerprint", "challenge_value", "expires_at_ms", "used_at_ms", "created_at_ms"],
    auth_device_request_nonces: ["username", "device_id", "nonce", "expires_at_ms", "created_at_ms"],
    auth_device_events: ["username", "event_type", "old_device_id", "new_device_id", "old_key_fingerprint", "new_key_fingerprint", "ip_hash", "user_agent", "reason", "created_at_ms"],
    account_security_email_outbox: ["event_key", "username", "recipient", "subject", "message_text", "status", "attempts", "next_attempt_at_ms", "claimed_at_ms", "last_error", "created_at_ms", "sent_at_ms"],
    users_stock: [
      "username", "balance", "seller_status", "run_balance",
      "seller_activated_at_ms", "seller_expires_at_ms", "seller_last_p2p_at_ms", "record_date", "record_time",
    ],
    activities: [
      "sender", "receiver", "type", "amount", "unit_price", "fees", "fee_unit_price", "bsc_fee_cost_usd", "reference",
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
      "total_units_price", "unit_price", "xtu_wallets", "xtu_wallets_reserved", "backed_units", "inactive_init_asset", "sys_inactive_init_asset",
      "sellers_res", "total_run_balance", "total_tfees", "total_tfees_bsc_cost_usd", "total_tfees_bsc_uncovered_usd", "total_bnb_fee_actual", "total_bnb_fee_estimated",
      "total_bnb_fee_actual_value", "total_bnb_fee_estimated_value", "record_date", "record_time",
    ],
    common_price_events: ["old_price", "new_price", "status", "last_username", "processed_at_ms", "created_at_ms", "updated_at_ms"],
    user_price_state: ["username", "cycle_number", "base_price", "tfees_rate", "remuneration_rate", "target_price", "status", "start_price_event_id", "triggered_price", "triggered_at_ms", "frozen_price", "sale_group_base_initial_asset", "sale_group_volume_initial_asset", "sale_group_fee_weighted", "purchase_group_base_initial_asset", "purchase_group_volume_initial_asset", "purchase_group_fee_weighted", "updated_at_ms", "created_at_ms"],
    user_price_cycle_history: ["username", "cycle_number", "base_price", "tfees_rate", "remuneration_rate", "target_price", "start_price_event_id", "triggered_price", "triggered_at_ms", "principal_before_operation", "operation_direction", "operation_volume_initial_asset", "resumed_at_ms", "resume_reason", "created_at_ms", "updated_at_ms"],
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
    account_cleanup_holds: ["username", "reason_codes", "first_detected_at_ms", "last_checked_at_ms"],
    account_access_events: ["username", "action", "reason", "changed_by", "created_at_ms"],
    account_registration_counters: ["counter_name", "last_value"],
    welcome_bonus_claims: ["subject_type", "subject_hash", "username", "amount_xtu", "credited_at_ms"],
    account_security_events: ["username", "action", "outcome", "created_at_ms"],
    account_api_rate_limits: ["username", "action", "window_start_ms", "request_count", "updated_at_ms"],
    deposit_service_control: ["control_id", "is_suspended", "suspension_reason", "changed_by", "updated_at_ms"],
    deposit_service_control_events: ["action", "previous_suspended", "current_suspended", "reason", "changed_by", "created_at_ms"],
    individual_disbursement_control: ["control_id", "is_open", "opening_reason", "notice_reference", "changed_by", "opened_at_ms", "closed_at_ms", "updated_at_ms"],
    individual_disbursement_control_events: ["action", "previous_open", "current_open", "reason", "notice_reference", "changed_by", "created_at_ms"],
    xtu_withdrawal_control: ["control_id", "is_open", "reason", "changed_by", "started_at_ms", "stopped_at_ms", "updated_at_ms"],
    xtu_withdrawal_control_events: ["action", "previous_open", "current_open", "reason", "changed_by", "created_at_ms"],
    xtu_withdrawals: ["reference", "username", "payout_address", "gross_amount", "reserved_initial_asset", "effective_unit_price", "global_unit_price", "estimated_gas_fee_bnb", "estimated_gas_fee_usd", "estimated_gas_fee_xtu", "contract_transfer_amount", "contract_fee_amount", "net_amount", "reserved_xtu_value", "bnb_usd_price", "amount_raw", "gas_limit", "gas_price_wei", "token_contract_address", "raw_tx", "tx_hash", "nonce", "block_number", "actual_gas_fee_bnb", "actual_gas_fee_usd", "actual_contract_fee_amount", "actual_net_amount", "receipt_json", "status", "last_error", "next_attempt_at_ms", "created_at_ms", "updated_at_ms", "signed_at_ms", "submitted_at_ms", "confirmed_at_ms", "failed_at_ms"],
    xtu_withdrawal_events: ["event_key", "withdrawal_id", "event_type", "previous_status", "current_status", "actor", "tx_hash", "details", "created_at_ms"],
    xtu_deposit_scan_state: ["chain_id", "token_contract", "hot_wallet_address", "start_block", "last_scanned_block", "last_scanned_block_hash", "last_finalized_block", "finality_method", "health_status", "last_error", "updated_at_ms"],
    xtu_deposit_batches: ["username", "hot_wallet_address", "opened_at_ms", "expires_at_ms", "initial_group_deadline_ms", "gross_amount", "hot_wallet_received_amount", "commission_amount", "returned_amount", "credited_amount", "remaining_amount", "transfer_count", "credit_sequence", "pending_since_ms", "release_at_ms", "gas_allocated_usd", "gas_allocated_xtu", "deposit_fee_amount", "status", "reason_codes", "global_run_id", "tfees_rate_percent", "created_at_ms", "updated_at_ms"],
    xtu_deposit_transfer_events: ["username", "batch_id", "token_contract", "from_address", "hot_wallet_address", "gross_amount", "net_amount", "commission_amount", "gross_amount_raw", "net_amount_raw", "commission_amount_raw", "allocated_gas_fee_usd", "allocated_gas_fee_xtu", "tx_hash", "log_index", "block_number", "block_hash", "block_timestamp_ms", "event_identity", "status", "reason_codes", "created_at_ms"],
    xtu_deposit_consolidations: ["anchor_batch_id", "amount", "amount_raw", "hot_wallet_address", "distribution_address", "estimated_gas_fee_bnb", "estimated_gas_fee_usd", "actual_gas_fee_bnb", "actual_gas_fee_usd", "gas_bnb_usd_price", "gas_limit", "gas_price_wei", "gas_allocation_method", "raw_tx", "tx_hash", "nonce", "block_number", "receipt_json", "status", "last_error", "created_at_ms", "updated_at_ms", "confirmed_at_ms"],
    xtu_deposit_consolidation_items: ["consolidation_id", "batch_id", "username", "gross_returned_xtu", "hot_wallet_received_xtu", "contract_commission_xtu", "estimated_gas_fee_bnb", "estimated_gas_fee_usd", "allocated_gas_fee_bnb", "allocated_gas_fee_usd", "allocated_gas_fee_xtu", "status", "created_at_ms", "updated_at_ms"],
    xtu_deposit_credits: ["batch_id", "username", "credit_sequence", "gross_returned_xtu", "deposit_fee_xtu", "gas_fee_xtu", "creditable_xtu", "credited_initial_asset", "global_unit_price", "reference", "global_run_id", "source_event_hashes_json", "consolidation_tx_hash", "status", "created_at_ms"],
    xtu_global_settlement_ledger: ["global_run_id", "username", "deposit_batch_id", "credit_sequence", "tx_hash", "source_event_hashes_json", "consolidation_tx_hash", "gross_returned_xtu", "deposit_fee_xtu", "gas_fee_xtu", "global_unit_price", "credited_initial_asset", "reserved_xtu_amount", "remaining_xtu_amount", "settled_xtu_amount", "status", "created_at_ms", "updated_at_ms"],
    xtu_deposit_email_outbox: ["event_key", "username", "recipient", "subject", "message_text", "status", "attempts", "next_attempt_at_ms", "last_error", "created_at_ms", "sent_at_ms"],
    xtu_global_settlement_payouts: ["ledger_id", "global_run_id", "username", "payout_address", "net_amount", "gross_amount", "contract_fee_amount", "estimated_gas_fee_bnb", "estimated_gas_fee_usd", "actual_gas_fee_bnb", "actual_gas_fee_usd", "raw_tx", "tx_hash", "nonce", "gas_limit", "gas_price_wei", "block_number", "receipt_json", "status", "last_error", "created_at_ms", "updated_at_ms", "confirmed_at_ms"],
    system_locks: ["lock_name"],
    bsc_wallet_address_registry: ["wallet_address_lower", "wallet_address", "username", "registered_at_ms"],
    bsc_incoming_scan_state: ["chain_id", "token_contract", "treasury_address", "scan_start_block", "last_scanned_block", "last_scanned_block_hash", "last_finalized_block", "finality_method", "health_status", "manual_review_code", "manual_review_at_ms", "last_error", "updated_at_ms"],
    bsc_scan_checkpoints: ["block_number", "block_hash", "finality_method", "checkpoint_status", "created_at_ms"],
    bsc_scan_reconciliation_previews: ["status", "scanner_reason_code", "previous_block", "previous_block_hash", "candidate_resume_block", "candidate_resume_hash", "observed_finalized_block", "rpc_endpoints_count", "total_events", "canonical_events", "re_included_events", "orphaned_events", "unverifiable_events", "compensation_required_events", "summary_json", "created_by", "created_at_ms", "expires_at_ms", "committed_at_ms", "last_error"],
    bsc_scan_reconciliation_items: ["preview_id", "source_table", "source_id", "tx_hash", "log_index", "batch_id", "amount", "amount_raw", "old_block", "old_block_hash", "observed_block", "observed_block_hash", "observed_timestamp_ms", "observed_log_index", "classification", "financial_impact", "resolution_status", "compensation_reference", "resolution_reason", "resolved_by", "resolved_at_ms", "details_json", "created_at_ms"],
    bsc_scan_admin_events: ["admin_username", "action", "previous_block", "previous_block_hash", "resume_after_block", "resume_block_hash", "observed_finalized_block", "reason", "created_at_ms"],
    bsc_unknown_incoming_transfers: ["token_contract", "from_address", "to_address", "amount", "amount_raw", "tx_hash", "log_index", "block_number", "block_hash", "block_timestamp_ms", "previous_username", "status", "decision_action", "decision_username", "decision_reason", "decided_by", "decided_at_ms", "refund_id", "created_at_ms", "updated_at_ms", "event_identity"],
    users_usdt_deposit_batches: [
      "username", "treasury_address", "opened_at_ms", "expires_at_ms", "initial_group_deadline_ms",
      "total_amount", "total_amount_raw", "credited_amount", "remaining_amount", "refunded_amount", "reserved_refund_amount",
      "tfees_rate_percent", "transfer_count", "credit_sequence", "minimum_met_at_ms", "status",
      "pending_since_ms", "release_at_ms", "next_attempt_at_ms", "reason_codes",
      "last_credit_at_ms", "credited_at_ms", "created_at_ms", "updated_at_ms",
    ],
    users_usdt_deposit_credits: [
      "batch_id", "username", "credit_sequence", "gross_amount", "tfees_rate_percent",
      "fee_amount", "net_amount", "credited_initial_asset", "unit_price", "financial_reference", "created_at_ms",
    ],
    users_usdt_transfer_events: [
      "username", "batch_id", "treasury_address", "from_address", "amount",
      "amount_raw", "tx_hash", "log_index", "block_number", "block_hash", "block_timestamp_ms",
      "status", "reason_codes", "event_identity", "created_at_ms",
    ],
    users_usdt_disbursements: [
      "username", "payout_address", "requested_amount", "payout_amount", "amount_raw",
      "gross_initial_asset", "sold_initial_asset", "fee_amount", "fee_initial_asset", "tfees_rate_percent",
      "price_value", "disbursement_mode", "global_run_id", "balance_after_reservation", "bsc_fee_recovered_usd",
      "bonus_amount", "bonus_initial_asset",
      "estimated_fee_bnb", "estimated_fee_usd", "actual_fee_bnb", "actual_fee_usd",
      "reference", "status", "raw_tx", "tx_hash", "nonce", "block_number",
      "last_error", "created_at_ms", "reservation_expires_at_ms", "updated_at_ms", "confirmed_at_ms",
    ],
    global_disbursement_runs: ["status", "trigger_reason", "decision_reference", "notice_method", "notice_reference", "request_window_days", "extension_days", "planned_activation_at_ms", "request_deadline_at_ms", "extension_deadline_at_ms", "activated_at_ms", "closed_at_ms", "snapshot_unit_price", "snapshot_total_units_price", "planned_total_initial_asset", "last_user_stock_id", "max_user_stock_id", "total_users", "processed_users", "total_gross_initial_asset", "total_requested_initial_asset", "total_paid_bsc_usd", "bonus_rate_percent", "admin_bonus_reserved_initial_asset", "admin_bonus_committed_initial_asset", "total_bonus_paid_bsc_usd", "total_bonus_paid_initial_asset", "total_bsc_gas_actual_usd", "announced_at_ms", "effective_at_ms", "last_error", "created_at_ms", "updated_at_ms", "completed_at_ms"],
    global_disbursement_participants: ["run_id", "username", "snapshot_balance_initial", "snapshot_base_price", "snapshot_remuneration_rate", "snapshot_target_price", "snapshot_unit_price", "snapshot_price_status", "requested_initial_asset", "paid_initial_asset", "remaining_initial_asset", "request_count", "last_disbursement_id", "status", "resolution_action", "resolution_reference", "resolution_reason", "resolved_at_ms", "created_at_ms", "updated_at_ms"],
    global_disbursement_email_outbox: ["run_id", "username", "recipient", "subject", "message_text", "status", "attempts", "next_attempt_at_ms", "claimed_at_ms", "last_error", "created_at_ms", "sent_at_ms"],
    users_usdt_refunds: [
      "username", "batch_id", "unknown_transfer_id", "user_request_id", "payout_address", "amount", "gross_amount", "fee_amount", "amount_raw",
      "estimated_fee_bnb", "estimated_fee_usd", "actual_fee_bnb", "actual_fee_usd", "bnb_usd_price",
      "reference", "status", "raw_tx", "tx_hash", "nonce", "block_number", "last_error",
      "created_at_ms", "updated_at_ms", "confirmed_at_ms",
    ],
    user_usdt_refund_requests: [
      "request_reference", "username", "batch_id", "request_type", "user_reason", "status", "refund_id",
      "admin_username", "admin_reason", "last_error", "created_at_ms", "updated_at_ms", "approved_at_ms", "resolved_at_ms", "completed_at_ms", "failed_at_ms",
    ],
    user_usdt_refund_request_events: [
      "request_id", "refund_id", "event_key", "event_type", "actor_type", "actor_username", "old_status", "new_status",
      "reason", "tx_hash", "gross_amount", "fee_amount", "net_amount", "created_at_ms",
    ],
    admin_payment_resolutions: [
      "admin_username", "username", "batch_id", "unknown_transfer_id", "user_refund_request_id", "refund_id", "action", "initial_asset_amount", "gross_amount", "fee_amount",
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
    auths: ["uq_auths_email", "uq_auths_wallet_address", "uq_auths_registration_sequence", "idx_auths_first_login_cleanup"],
    auth_devices: ["idx_auth_devices_fingerprint", "idx_auth_devices_session_expiry"],
    auth_device_challenges: ["idx_auth_device_challenge_user", "idx_auth_device_challenge_expiry"],
    auth_device_request_nonces: ["idx_auth_device_nonce_expiry"],
    auth_device_events: ["idx_auth_device_events_user", "idx_auth_device_events_created"],
    account_security_email_outbox: ["uq_account_security_email_event", "idx_account_security_email_due"],
    bsc_unknown_incoming_transfers: ["uq_bsc_unknown_event_identity", "idx_bsc_unknown_tx_log", "idx_bsc_unknown_status"],
    bsc_scan_checkpoints: ["uq_bsc_scan_checkpoint_hash", "idx_bsc_scan_checkpoint_status_block"],
    bsc_scan_reconciliation_previews: ["idx_bsc_scan_preview_status", "idx_bsc_scan_preview_expiry"],
    bsc_scan_reconciliation_items: ["uq_bsc_scan_reconcile_item", "idx_bsc_scan_reconcile_preview_class", "idx_bsc_scan_reconcile_batch"],
    activities: [
      "idx_activities_sender_id",
      "idx_activities_receiver_id",
      "idx_activities_history_sender",
      "idx_activities_history_receiver",
    ],
    deposit_service_control_events: ["idx_deposit_control_events_created"],
    individual_disbursement_control_events: ["idx_individual_disbursement_control_events_created"],
    xtu_withdrawal_control_events: ["idx_xtu_withdrawal_control_events_created"],
    xtu_withdrawals: ["uq_xtu_withdrawals_reference", "uq_xtu_withdrawals_tx_hash", "idx_xtu_withdrawals_status_due", "idx_xtu_withdrawals_username_status"],
    xtu_withdrawal_events: ["uq_xtu_withdrawal_event_key", "idx_xtu_withdrawal_events_withdrawal"],
    xtu_deposit_batches: ["idx_xtu_deposit_batch_user_status", "idx_xtu_deposit_batch_due"],
    xtu_deposit_transfer_events: ["uq_xtu_deposit_event_identity", "uq_xtu_deposit_event_tx_log", "idx_xtu_deposit_event_user_status", "idx_xtu_deposit_event_batch"],
    xtu_deposit_consolidations: ["idx_xtu_deposit_consolidation_anchor_batch", "uq_xtu_deposit_consolidation_hash", "idx_xtu_deposit_consolidation_status"],
    xtu_deposit_consolidation_items: ["uq_xtu_consolidation_item_batch", "idx_xtu_consolidation_items_lot", "idx_xtu_consolidation_items_user"],
    xtu_deposit_credits: ["uq_xtu_deposit_credit_batch_seq", "uq_xtu_deposit_credit_reference"],
    xtu_global_settlement_ledger: ["uq_xtu_global_settlement_deposit_tranche", "idx_xtu_global_settlement_run_user"],
    xtu_global_settlement_payouts: ["uq_xtu_global_settlement_payout_ledger", "uq_xtu_global_settlement_payout_hash"],
    xtu_deposit_email_outbox: ["uq_xtu_deposit_email_event", "idx_xtu_deposit_email_due"],
    users_seller_reserve_lots: ["idx_seller_lot_availability"],
    users_usdt_disbursements: ["idx_usdt_disbursement_reserve_availability"],
    users_usdt_deposit_credits: ["uq_deposit_credit_sequence", "uq_deposit_credit_reference"],
    users_usdt_transfer_events: ["uq_usdt_transfer_event_identity", "idx_usdt_transfer_event_tx_log"],
    users_usdt_refunds: ["uq_usdt_refund_user_request"],
    user_usdt_refund_requests: ["uq_user_usdt_refund_request_reference", "uq_user_usdt_refund_request_refund"],
    user_usdt_refund_request_events: ["uq_user_refund_request_event_key", "idx_user_refund_request_event_request"],
    admin_payment_resolutions: ["idx_admin_resolution_refund"],
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
    `INSERT IGNORE INTO deposit_service_control
     (control_id,is_suspended,suspension_reason,changed_by,updated_at_ms)
     VALUES(1,0,NULL,'system',?)`,
    [String(Date.now())],
  );
  await db.queryAsync(
    `INSERT IGNORE INTO individual_disbursement_control
     (control_id,is_open,opening_reason,notice_reference,changed_by,opened_at_ms,closed_at_ms,updated_at_ms)
     VALUES(1,0,NULL,NULL,'system',NULL,NULL,?)`,
    [String(Date.now())],
  );
  await db.queryAsync(
    `INSERT IGNORE INTO xtu_withdrawal_control
     (control_id,is_open,reason,changed_by,started_at_ms,stopped_at_ms,updated_at_ms)
     VALUES(1,0,NULL,'system',NULL,NULL,?)`,
    [String(Date.now())],
  );
  await db.queryAsync(
    "INSERT IGNORE INTO system_locks(lock_name) VALUES(?),(?),(?),(?),(?),(?),(?),(?)",
    ["common_state", "onex_bsc_disbursement_worker", "onex_hot_wallet_spend", "onex_cold_wallet_sweep", "onex_xtu_wallet_spend", "onex_xtu_withdrawal_worker", "onex_xtu_deposit_worker", "onex_xtu_main_wallet_spend"],
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
      "INSERT INTO common(total_units_price,unit_price,xtu_wallets,xtu_wallets_reserved,backed_units,inactive_init_asset,sys_inactive_init_asset,sellers_res,total_run_balance,total_tfees,record_date,record_time) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
      [initialTotal.toFixed(), initialTotal.dividedBy(initialBacked).toFixed(30), "0", "0", initialBacked.toFixed(), "0", "0", "0", "0", "0", date, time],
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
  const minimumUnitPrice = currentTotalUnitsPrice.dividedBy(currentBackedInitialAssets);
  if (!storedUnitPrice.isFinite() || !storedUnitPrice.isGreaterThan(0) ||
      minimumUnitPrice.minus(storedUnitPrice).gt("0.000000000000000000000000000001")) {
    throw new Error("common.unit_price must be positive and not below common.total_units_price / common.backed_units");
  }

  console.log(`OneX database ready. UTC time: ${date} ${time}`);
}

async function cleanupNeverSignedInAccounts(nowMs = Date.now()) {
  const cutoff = nowMs - 7 * 24 * 60 * 60 * 1000;
  const candidates = await db.queryAsync(
    `SELECT username FROM auths
     WHERE last_login_at_ms IS NULL
       AND account_active=1
       AND created_at_ms<=?
     ORDER BY created_at_ms ASC LIMIT 100`,
    [String(cutoff)],
  );

  let deleted = 0;
  let held = 0;
  for (const candidate of candidates) {
    let connection;
    try {
      connection = await new Promise((resolve, reject) => {
        db.getConnection((error, conn) => error ? reject(error) : resolve(conn));
      });
      const tx = connection.promise();
      await tx.beginTransaction();

      const [authRows] = await tx.query(
        `SELECT username,created_at_ms,last_login_at_ms,account_active
         FROM auths WHERE username=? LIMIT 1 FOR UPDATE`,
        [candidate.username],
      );
      if (!authRows.length) {
        await tx.commit();
        continue;
      }
      const auth = authRows[0];
      if (
        auth.last_login_at_ms != null ||
        Number(auth.account_active) !== 1 ||
        Number(auth.created_at_ms) > cutoff
      ) {
        await tx.query("DELETE FROM account_cleanup_holds WHERE username=?", [candidate.username]);
        await tx.commit();
        continue;
      }

      const reasons = [];
      const [stockRows] = await tx.query(
        `SELECT balance,run_balance,seller_status FROM users_stock
         WHERE username=? LIMIT 1 FOR UPDATE`,
        [candidate.username],
      );
      if (!stockRows.length) {
        reasons.push("missing_stock_record");
      } else {
        const balance = new BigNumber(stockRows[0].balance);
        const runBalance = new BigNumber(stockRows[0].run_balance);
        if (!balance.isFinite() || !balance.isZero()) reasons.push("nonzero_or_invalid_balance");
        if (!runBalance.isFinite() || !runBalance.isZero()) reasons.push("seller_run_balance_present");
        if (Number(stockRows[0].seller_status || 0) !== 0) reasons.push("seller_status_active");
      }

      const financialChecks = [
        ["activities", "SELECT id FROM activities WHERE sender=? OR receiver=? LIMIT 1 FOR UPDATE", [candidate.username, candidate.username]],
        ["deposit_batches", "SELECT id FROM users_usdt_deposit_batches WHERE username=? LIMIT 1 FOR UPDATE", [candidate.username]],
        ["deposit_events", "SELECT id FROM users_usdt_transfer_events WHERE username=? LIMIT 1 FOR UPDATE", [candidate.username]],
        ["xtu_deposit_batches", "SELECT id FROM xtu_deposit_batches WHERE username=? LIMIT 1 FOR UPDATE", [candidate.username]],
        ["xtu_deposit_events", "SELECT id FROM xtu_deposit_transfer_events WHERE username=? LIMIT 1 FOR UPDATE", [candidate.username]],
        ["xtu_deposit_credits", "SELECT id FROM xtu_deposit_credits WHERE username=? LIMIT 1 FOR UPDATE", [candidate.username]],
        ["xtu_global_settlements", "SELECT id FROM xtu_global_settlement_ledger WHERE username=? LIMIT 1 FOR UPDATE", [candidate.username]],
        ["disbursements", "SELECT id FROM users_usdt_disbursements WHERE username=? LIMIT 1 FOR UPDATE", [candidate.username]],
        ["refunds", "SELECT id FROM users_usdt_refunds WHERE username=? LIMIT 1 FOR UPDATE", [candidate.username]],
        ["seller_campaigns", "SELECT id FROM users_seller_campaigns WHERE username=? LIMIT 1 FOR UPDATE", [candidate.username]],
        ["seller_reserve_lots", "SELECT id FROM users_seller_reserve_lots WHERE username=? LIMIT 1 FOR UPDATE", [candidate.username]],
        ["seller_payouts", "SELECT id FROM users_usdt_seller_payouts WHERE username=? LIMIT 1 FOR UPDATE", [candidate.username]],
        ["global_participation", "SELECT id FROM global_disbursement_participants WHERE username=? LIMIT 1 FOR UPDATE", [candidate.username]],
        ["admin_resolutions", "SELECT id FROM admin_payment_resolutions WHERE username=? LIMIT 1 FOR UPDATE", [candidate.username]],
        ["pending_global_email_notice", "SELECT id FROM global_disbursement_email_outbox WHERE username=? AND status IN ('pending','sending') LIMIT 1 FOR UPDATE", [candidate.username]],
        ["pending_global_telegram_notice", "SELECT id FROM telegram_outbox WHERE username=? AND event_key LIKE 'global-announcement:%' AND status NOT IN ('sent','skipped','failed') LIMIT 1 FOR UPDATE", [candidate.username]],
        ["price_cycle_state", "SELECT username FROM user_price_state WHERE username=? LIMIT 1 FOR UPDATE", [candidate.username]],
        ["price_cycle_history", "SELECT id FROM user_price_cycle_history WHERE username=? LIMIT 1 FOR UPDATE", [candidate.username]],
      ];
      for (const [reason, sql, params] of financialChecks) {
        const [rows] = await tx.query(sql, params);
        if (rows.length) reasons.push(`${reason}_present`);
      }

      if (reasons.length) {
        const timestamp = String(nowMs);
        await tx.query(
          `INSERT INTO account_cleanup_holds
           (username,reason_codes,first_detected_at_ms,last_checked_at_ms)
           VALUES(?,?,?,?)
           ON DUPLICATE KEY UPDATE reason_codes=VALUES(reason_codes),last_checked_at_ms=VALUES(last_checked_at_ms)`,
          [candidate.username, reasons.join(",").slice(0, 1000), timestamp, timestamp],
        );
        await tx.commit();
        held += 1;
        continue;
      }

      // Keep the wallet-address registry permanently so the same wallet cannot be reassigned.
      await tx.query("DELETE FROM user_price_state WHERE username=?", [candidate.username]);
      await tx.query("DELETE FROM account_security_action_locks WHERE username=?", [candidate.username]);
      await tx.query("DELETE FROM account_security_events WHERE username=?", [candidate.username]);
      await tx.query("DELETE FROM account_api_rate_limits WHERE username=?", [candidate.username]);
      await tx.query("DELETE FROM telegram_link_challenges WHERE username=?", [candidate.username]);
      await tx.query("DELETE FROM auth_device_challenges WHERE username=?", [candidate.username]);
      await tx.query("DELETE FROM auth_device_request_nonces WHERE username=?", [candidate.username]);
      await tx.query("DELETE FROM auth_devices WHERE username=?", [candidate.username]);
      await tx.query("DELETE FROM account_security_email_outbox WHERE username=?", [candidate.username]);
      await tx.query("DELETE FROM telegram_outbox WHERE username=?", [candidate.username]);
      await tx.query("DELETE FROM global_disbursement_email_outbox WHERE username=?", [candidate.username]);
      await tx.query("DELETE FROM xtu_deposit_email_outbox WHERE username=?", [candidate.username]);
      await tx.query("DELETE FROM users_stock WHERE username=?", [candidate.username]);
      await tx.query("DELETE FROM auths WHERE username=? AND last_login_at_ms IS NULL", [candidate.username]);
      await tx.query("DELETE FROM account_cleanup_holds WHERE username=?", [candidate.username]);
      await tx.commit();
      deleted += 1;
    } catch (error) {
      if (connection) {
        try { await connection.promise().rollback(); } catch (rollbackError) {
          console.error("Automatic account cleanup rollback failed:", rollbackError.message);
        }
      }
      console.error(`Automatic cleanup could not process ${candidate.username}:`, error.message);
    } finally {
      if (connection) connection.release();
    }
  }
  return { candidates: candidates.length, deleted, held };
}

async function cleanup() {
  try {
    const now = Date.now();
    await db.queryAsync(
      "DELETE FROM telegram_outbox WHERE status IN ('sent','skipped','failed') AND created_at_ms<?",
      [String(now - 14 * 24 * 60 * 60 * 1000)],
    );
    await db.queryAsync(
      "DELETE FROM telegram_link_challenges WHERE expires_at_ms<? OR used_at_ms IS NOT NULL",
      [String(now - 24 * 60 * 60 * 1000)],
    );
    await db.queryAsync(
      "DELETE FROM auth_device_challenges WHERE expires_at_ms<? OR used_at_ms IS NOT NULL",
      [String(now - 24 * 60 * 60 * 1000)],
    );
    await db.queryAsync(
      "DELETE FROM auth_device_request_nonces WHERE expires_at_ms<?",
      [String(now)],
    );
    await db.queryAsync(
      "DELETE FROM xtu_deposit_email_outbox WHERE status IN ('sent','failed') AND created_at_ms<?",
      [String(now - 365 * 24 * 60 * 60 * 1000)],
    );
    await db.queryAsync(
      "DELETE FROM account_security_email_outbox WHERE status IN ('sent','failed') AND created_at_ms<?",
      [String(now - 365 * 24 * 60 * 60 * 1000)],
    );
    await db.queryAsync(
      "DELETE FROM account_security_events WHERE created_at_ms<?",
      [String(now - 8 * 24 * 60 * 60 * 1000)],
    );
    await db.queryAsync(
      "DELETE FROM account_api_rate_limits WHERE window_start_ms<?",
      [String(now - 2 * 24 * 60 * 60 * 1000)],
    );
    await db.queryAsync(
      `DELETE action_lock FROM account_security_action_locks AS action_lock
       LEFT JOIN auths ON auths.username=action_lock.username
       WHERE auths.username IS NULL AND action_lock.updated_at_ms<?`,
      [String(now - 30 * 24 * 60 * 60 * 1000)],
    );

    const accountCleanup = await cleanupNeverSignedInAccounts(now);
    if (accountCleanup.deleted || accountCleanup.held) {
      console.log("Automatic account cleanup:", accountCleanup);
    }
    return accountCleanup;
  } catch (error) {
    console.error("Database cleanup failed:", error.message);
    return { error: error.message };
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
