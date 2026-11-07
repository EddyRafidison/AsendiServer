require("dotenv").config();
const mysql = require("mysql2");
const BigNumber = require("bignumber.js");
const { deriveInitAsset } = require("./stock-accounting");
const { getDate, getDateBefore, decrypt, hashSecret, isArgon2Hash } = require("./utils");
const { MAX_DEFAULT_STOCK } = require("./recharge-policy");

// ---------------- CONSTANTS & ENV VARS ----------------
const OneX = "ONEX";
// Business rule: every user balance is capped at 300 One-Val.
const maxStockDefault = MAX_DEFAULT_STOCK;
const P2Pallowed = String(process.env.P2P_ALLOWED || "").toLowerCase() === "true";
const stock_limit = process.env.STOCK_LIMIT;
const first_welcome_clients = process.env.FIRST_WELCOME_CLIENTS;
const welcome_bonus = process.env.WELCOME_BONUS;
const tfees = Number(process.env.FEES);
const admin_pswd = process.env.ADMIN_PSWD;
const admin_pin = process.env.ADMIN_PIN;
const APP_VERSION = process.env.APP_VERSION;
const PORT_DB = process.env.DB_PORT || 3306;
const PORT_SERVER = process.env.SERVER_PORT;
const MAIL_PORT = process.env.MAIL_PORT;
const SERVER_MAIL = process.env.SERV_MAIL;
const SERVER_MAIL_PSWD = process.env.SERV_MAIL_PSWD;

const DB_CONFIG = {
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PSWD,
  database: process.env.DB_NAME,
  port: PORT_DB,
  waitForConnections: true,
  connectionLimit: 200,
  queueLimit: 200,
  multipleStatements: true,
  // The driver parses and formats temporal values using UTC.
  timezone: "Z",
};

// ---------------- DATABASE POOL --------------------
const db = mysql.createPool(DB_CONFIG);
// Set the MySQL session timezone for every pooled connection as well.
db.on("connection", (connection) => {
  connection.query("SET time_zone = '+00:00'", (error) => {
    if (error) {
      console.error("Unable to set MySQL session timezone to UTC:", error);
    }
  });
});
db.queryAsync = (sql, params = []) =>
  new Promise((res, rej) =>
    db.query(sql, params, (e, r) => (e ? rej(e) : res(r))),
  );

const USERNAME_TABLES = new Set(["auths", "users_stock"]);

async function ensureUniqueUsernameIndex(tableName) {
  if (!USERNAME_TABLES.has(tableName)) {
    throw new Error(`Unsupported table for username uniqueness: ${tableName}`);
  }

  // Check for legacy duplicates before changing the schema; do not delete user data automatically.
  const duplicates = await db.queryAsync(
    `SELECT username, COUNT(*) AS duplicate_count
     FROM \`${tableName}\`
     GROUP BY username
     HAVING COUNT(*) > 1
     LIMIT 5`,
  );

  if (duplicates.length > 0) {
    const details = duplicates
      .map(({ username, duplicate_count }) => `${username} (${duplicate_count} rows)`)
      .join(", ");

    throw new Error(
      `Cannot enforce unique usernames on ${tableName}: existing duplicates were found: ${details}. Resolve these records and restart the server.`,
    );
  }

  const indexRows = await db.queryAsync(`SHOW INDEX FROM \`${tableName}\``);
  const uniqueIndexes = new Map();

  for (const row of indexRows) {
    if (Number(row.Non_unique) !== 0) continue;

    if (!uniqueIndexes.has(row.Key_name)) uniqueIndexes.set(row.Key_name, []);
    uniqueIndexes.get(row.Key_name).push({
      position: Number(row.Seq_in_index),
      column: row.Column_name,
    });
  }

  const hasUniqueUsernameIndex = [...uniqueIndexes.values()].some((columns) => {
    const orderedColumns = columns
      .sort((a, b) => a.position - b.position)
      .map((item) => item.column);

    return orderedColumns.length === 1 && orderedColumns[0] === "username";
  });

  if (!hasUniqueUsernameIndex) {
    const indexName = `uq_${tableName}_username`;
    await db.queryAsync(
      `ALTER TABLE \`${tableName}\` ADD UNIQUE INDEX \`${indexName}\` (\`username\`)`,
    );
    console.log(`Unique username index created on ${tableName}`);
  }
}

async function migrateLegacyUserSecrets() {
  let lastId = 0;
  let migratedPasswords = 0;
  let migratedSeeds = 0;
  const batchSize = 100;

  while (true) {
    const rows = await db.queryAsync(
      `SELECT id, password, seed FROM auths WHERE id > ? ORDER BY id ASC LIMIT ${batchSize}`,
      [lastId],
    );
    if (rows.length === 0) break;

    for (const row of rows) {
      let password = row.password;
      let seed = row.seed;
      let changed = false;

      if (!isArgon2Hash(password)) {
        let legacyPassword;
        try {
          legacyPassword = decrypt(String(password ?? ""), DB_CONFIG.password);
        } catch {
          throw new Error(
            `Cannot migrate the legacy password for auths.id=${row.id}. Check the old encryption key and stored data.`,
          );
        }
        if (typeof legacyPassword !== "string" || legacyPassword.length === 0) {
          throw new Error(
            `Cannot migrate the empty or unreadable legacy password for auths.id=${row.id}. Resolve this record before starting the server.`,
          );
        }
        password = await hashSecret(legacyPassword);
        migratedPasswords += 1;
        changed = true;
      }

      if (!isArgon2Hash(seed)) {
        let legacySeed;
        try {
          legacySeed = decrypt(String(seed ?? ""), DB_CONFIG.password);
        } catch {
          throw new Error(
            `Cannot migrate the legacy seed for auths.id=${row.id}. Check the old encryption key and stored data.`,
          );
        }
        if (typeof legacySeed !== "string" || legacySeed.length === 0) {
          throw new Error(
            `Cannot migrate the empty or unreadable legacy seed for auths.id=${row.id}. Resolve this record before starting the server.`,
          );
        }
        seed = await hashSecret(legacySeed);
        migratedSeeds += 1;
        changed = true;
      }

      if (changed) {
        await db.queryAsync(
          "UPDATE auths SET password=?, seed=? WHERE id=?",
          [password, seed, row.id],
        );
      }
      lastId = row.id;
    }
  }

  if (migratedPasswords || migratedSeeds) {
    console.log(
      `Argon2id migration completed: ${migratedPasswords} password(s), ${migratedSeeds} seed(s) migrated.`,
    );
  } else {
    console.log("User password and seed hashes are already using Argon2id.");
  }
}

async function ensureDisbursementSoldInitAssetColumn() {
  const columns = await db.queryAsync(
    "SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='users_usdt_disbursements' AND COLUMN_NAME='sold_init_asset' LIMIT 1",
  );
  if (columns.length === 0) {
    await db.queryAsync(
      "ALTER TABLE users_usdt_disbursements ADD COLUMN sold_init_asset VARCHAR(255) NOT NULL DEFAULT '0' AFTER gross_init_asset",
    );
    console.log("Added users_usdt_disbursements.sold_init_asset");
  }
}

async function ensureInnoDBTable(tableName) {
  const allowedTables = new Set([
    "auths",
    "users_stock",
    "activities",
    "common",
    "system_locks",
    "users_usdt_tx",
    "users_usdt_recharge_status",
    "users_usdt_deposit_wallets",
    "users_usdt_transfer_events",
    "users_usdt_sweeps",
    "users_usdt_disbursements",
  ]);
  if (!allowedTables.has(tableName)) {
    throw new Error(`Unsupported table for InnoDB check: ${tableName}`);
  }

  const rows = await db.queryAsync(
    "SELECT ENGINE FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? LIMIT 1",
    [tableName],
  );
  if (rows.length && String(rows[0].ENGINE).toUpperCase() !== "INNODB") {
    await db.queryAsync(`ALTER TABLE \`${tableName}\` ENGINE=InnoDB`);
    console.log(`Storage engine changed to InnoDB for ${tableName}`);
  }
}

async function removeLegacyUserStockUnitPriceColumn() {
  const columns = await db.queryAsync(
    "SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='users_stock' AND COLUMN_NAME='unit_price' LIMIT 1",
  );

  if (columns.length === 0) return;

  // Remove indexes that depend on the legacy column before dropping it.
  const indexRows = await db.queryAsync("SHOW INDEX FROM `users_stock`");
  const dependentIndexes = [
    ...new Set(
      indexRows
        .filter((row) => row.Column_name === "unit_price")
        .map((row) => row.Key_name),
    ),
  ];

  if (dependentIndexes.includes("PRIMARY")) {
    throw new Error(
      "Cannot remove users_stock.unit_price because it belongs to the PRIMARY KEY. Review the legacy schema manually.",
    );
  }

  for (const indexName of dependentIndexes) {
    const escapedIndexName = String(indexName).replace(/`/g, "``");
    await db.queryAsync(
      `ALTER TABLE \`users_stock\` DROP INDEX \`${escapedIndexName}\``,
    );
  }

  await db.queryAsync("ALTER TABLE `users_stock` DROP COLUMN `unit_price`");
  console.log("Removed legacy users_stock.unit_price column");
}

async function ensureCommonInactiveInitAssetColumn() {
  const columns = await db.queryAsync(
    "SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='common' AND COLUMN_NAME='inactive_init_asset' LIMIT 1",
  );

  if (columns.length === 0) {
    await db.queryAsync(
      "ALTER TABLE common ADD COLUMN inactive_init_asset VARCHAR(255) NOT NULL DEFAULT '0' AFTER backed_units",
    );
    console.log("Added common.inactive_init_asset with a default value of 0");
  } else {
    await db.queryAsync(
      "ALTER TABLE common MODIFY COLUMN inactive_init_asset VARCHAR(255) NOT NULL DEFAULT '0'",
    );
  }
}

async function ensureDepositPayoutAddressColumn() {
  const columns = await db.queryAsync(
    "SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='users_usdt_deposit_wallets' AND COLUMN_NAME='payout_address' LIMIT 1",
  );
  if (columns.length === 0) {
    await db.queryAsync(
      "ALTER TABLE users_usdt_deposit_wallets ADD COLUMN payout_address CHAR(42) NULL AFTER wallet_address",
    );
    console.log("Added users_usdt_deposit_wallets.payout_address");
  }
}

async function ensureUsersStockInitAssetColumn() {
  const columns = await db.queryAsync(
    "SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='users_stock' AND COLUMN_NAME='init_asset' LIMIT 1",
  );

  if (columns.length === 0) {
    await db.queryAsync(
      "ALTER TABLE users_stock ADD COLUMN init_asset VARCHAR(255) NOT NULL DEFAULT '0' AFTER balance",
    );
    console.log("Added users_stock.init_asset with a default value of 0");
  } else {
    await db.queryAsync(
      "ALTER TABLE users_stock MODIFY COLUMN init_asset VARCHAR(255) NOT NULL DEFAULT '0'",
    );
  }
}

async function backfillUsersStockInitAssets() {
  const [commonRows] = await db.queryAsync(
    "SELECT unit_price FROM common ORDER BY id DESC LIMIT 1",
  );
  const migrationPrice = commonRows
    ? new BigNumber(commonRows.unit_price)
    : new BigNumber(0);

  if (!migrationPrice.isFinite() || !migrationPrice.isGreaterThan(0)) {
    const positiveBalanceRows = await db.queryAsync(
      "SELECT COUNT(*) AS count FROM users_stock WHERE CAST(balance AS DECIMAL(65,30)) > 0 AND (init_asset IS NULL OR CAST(init_asset AS DECIMAL(65,30)) <= 0)",
    );
    if (Number(positiveBalanceRows[0]?.count || 0) > 0) {
      throw new Error(
        "Cannot initialize existing users_stock.init_asset values: latest common.unit_price must be greater than zero.",
      );
    }
    return;
  }

  const rows = await db.queryAsync(
    `SELECT id,username,balance
     FROM users_stock
     WHERE CAST(balance AS DECIMAL(65,30)) > 0
       AND (init_asset IS NULL OR CAST(init_asset AS DECIMAL(65,30)) <= 0)
     ORDER BY id ASC`,
  );

  let migrated = 0;
  for (const row of rows) {
    const balance = new BigNumber(row.balance);
    if (!balance.isFinite() || !balance.isGreaterThan(0)) {
      throw new Error(`Invalid positive users_stock.balance for ${row.username}`);
    }

    // Legacy per-activity prices may be stale or inconsistent. Give all
    // pre-migration positive balances one consistent starting basis using
    // the latest common price; future P2P pricing is account-derived only.
    const initAsset = deriveInitAsset(balance, migrationPrice);
    await db.queryAsync(
      "UPDATE users_stock SET init_asset=? WHERE id=?",
      [initAsset.toFixed(), row.id],
    );
    migrated += 1;
  }

  if (migrated > 0) {
    console.log(
      `Initialized users_stock.init_asset for ${migrated} existing account(s) using latest common.unit_price.`,
    );
  }
}

async function ensureRechargeSchema() {
  let columns = await db.queryAsync(
    "SELECT COLUMN_NAME,EXTRA FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='users_usdt_tx'",
  );
  const columnMap = new Map(columns.map((column) => [column.COLUMN_NAME, column]));
  const requiredLegacyColumns = [
    "username",
    "tx_addr",
    "amount",
    "tx_hash",
    "record_date",
    "record_time",
  ];
  const missingLegacyColumns = requiredLegacyColumns.filter(
    (columnName) => !columnMap.has(columnName),
  );
  if (missingLegacyColumns.length > 0) {
    throw new Error(
      `Cannot migrate users_usdt_tx: required legacy columns are missing (${missingLegacyColumns.join(", ")}). Review the table schema before restarting OneX.`,
    );
  }

  // Older installations may have used username as the primary key. The recharge
  // ledger now needs multiple historical rows per account, so add a stable row ID.
  if (!columnMap.has("id")) {
    await db.queryAsync(
      "ALTER TABLE users_usdt_tx ADD COLUMN id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT UNIQUE FIRST",
    );
    console.log("Added users_usdt_tx.id for recharge request tracking");
  } else if (!String(columnMap.get("id").EXTRA || "").includes("auto_increment")) {
    const indexRows = await db.queryAsync("SHOW INDEX FROM users_usdt_tx");
    const idIndexes = new Map();
    for (const row of indexRows) {
      if (!idIndexes.has(row.Key_name)) idIndexes.set(row.Key_name, []);
      idIndexes.get(row.Key_name).push(row);
    }
    const hasUniqueId = [...idIndexes.values()].some((rows) =>
      rows.length === 1 &&
      rows[0].Column_name === "id" &&
      Number(rows[0].Seq_in_index) === 1 &&
      Number(rows[0].Non_unique) === 0,
    );
    if (!hasUniqueId) {
      await db.queryAsync(
        "ALTER TABLE users_usdt_tx ADD UNIQUE INDEX uq_users_usdt_tx_id_migration (id)",
      );
    }
    await db.queryAsync(
      "ALTER TABLE users_usdt_tx MODIFY COLUMN id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT",
    );
    console.log("Upgraded users_usdt_tx.id to AUTO_INCREMENT");
  }

  const addColumnIfMissing = async (columnName, definition) => {
    if (columnMap.has(columnName)) return;
    await db.queryAsync(
      `ALTER TABLE users_usdt_tx ADD COLUMN \`${columnName}\` ${definition}`,
    );
    columnMap.set(columnName, { COLUMN_NAME: columnName });
    console.log(`Added users_usdt_tx.${columnName}`);
  };

  // Existing rows are historical records, not active requests. Mark them as
  // legacy so the payment watcher never interprets them as unpaid requests.
  await addColumnIfMissing(
    "status",
    "VARCHAR(32) NOT NULL DEFAULT 'legacy_untracked'",
  );
  await addColumnIfMissing(
    "requested_amount",
    "DECIMAL(36,18) NOT NULL DEFAULT 0",
  );
  await addColumnIfMissing("pending_username", "VARCHAR(30) NULL");
  await addColumnIfMissing("pending_tx_addr", "CHAR(42) NULL");
  await addColumnIfMissing("created_at_ms", "BIGINT UNSIGNED NOT NULL DEFAULT 0");
  await addColumnIfMissing("expires_at_ms", "BIGINT UNSIGNED NOT NULL DEFAULT 0");
  await addColumnIfMissing("start_block", "BIGINT UNSIGNED NOT NULL DEFAULT 0");
  await addColumnIfMissing("last_scanned_block", "BIGINT UNSIGNED NOT NULL DEFAULT 0");

  // Remove a legacy single-column username primary/unique key. The row ID is
  // now unique, while username is indexed but intentionally not unique.
  let indexRows = await db.queryAsync("SHOW INDEX FROM users_usdt_tx");
  const indexes = new Map();
  for (const row of indexRows) {
    if (!indexes.has(row.Key_name)) indexes.set(row.Key_name, []);
    indexes.get(row.Key_name).push({
      sequence: Number(row.Seq_in_index),
      column: row.Column_name,
      nonUnique: Number(row.Non_unique),
    });
  }
  for (const [indexName, entries] of indexes) {
    const orderedColumns = entries
      .sort((a, b) => a.sequence - b.sequence)
      .map((entry) => entry.column);
    const isSingleUsernameUnique =
      orderedColumns.length === 1 &&
      orderedColumns[0] === "username" &&
      entries[0].nonUnique === 0;
    if (!isSingleUsernameUnique) continue;

    if (indexName === "PRIMARY") {
      await db.queryAsync("ALTER TABLE users_usdt_tx DROP PRIMARY KEY");
    } else {
      const escapedIndexName = String(indexName).replace(/`/g, "``");
      await db.queryAsync(`ALTER TABLE users_usdt_tx DROP INDEX \`${escapedIndexName}\``);
    }
    console.log(`Removed legacy unique username index ${indexName} from users_usdt_tx`);
  }

  const ensureIndex = async (indexName, expectedColumns, unique = false) => {
    const currentRows = await db.queryAsync("SHOW INDEX FROM users_usdt_tx");
    const matchingRows = currentRows.filter((row) => row.Key_name === indexName);
    if (matchingRows.length > 0) {
      const currentColumns = matchingRows
        .sort((a, b) => Number(a.Seq_in_index) - Number(b.Seq_in_index))
        .map((row) => row.Column_name);
      const currentUnique = Number(matchingRows[0].Non_unique) === 0;
      if (
        currentColumns.length === expectedColumns.length &&
        currentColumns.every((column, index) => column === expectedColumns[index]) &&
        currentUnique === unique
      ) {
        return;
      }
      await db.queryAsync(`ALTER TABLE users_usdt_tx DROP INDEX \`${indexName}\``);
    }

    if (unique) {
      const duplicateRows = await db.queryAsync(
        `SELECT ${expectedColumns.map((column) => `\`${column}\``).join(",")},COUNT(*) AS duplicate_count
         FROM users_usdt_tx
         WHERE ${expectedColumns.map((column) => `\`${column}\` IS NOT NULL`).join(" AND ")}
         GROUP BY ${expectedColumns.map((column) => `\`${column}\``).join(",")}
         HAVING COUNT(*) > 1
         LIMIT 5`,
      );
      if (duplicateRows.length > 0) {
        throw new Error(
          `Cannot create unique index ${indexName} on users_usdt_tx because duplicate records exist. Resolve them manually before restarting OneX.`,
        );
      }
    }

    const columnsSql = expectedColumns.map((column) => `\`${column}\``).join(",");
    await db.queryAsync(
      `CREATE ${unique ? "UNIQUE " : ""}INDEX \`${indexName}\` ON users_usdt_tx(${columnsSql})`,
    );
    console.log(`Created ${unique ? "unique " : ""}index ${indexName} on users_usdt_tx`);
  };

  await ensureIndex("uq_users_usdt_pending_username", ["pending_username"], true);
  await ensureIndex("uq_users_usdt_pending_tx_addr", ["pending_tx_addr"], true);
  await ensureIndex("uq_users_usdt_tx_hash", ["tx_hash"], true);
  await ensureIndex("idx_users_usdt_status_expiry", ["status", "expires_at_ms"]);
  await ensureIndex("idx_users_usdt_username", ["username"]);

  const activityIndexRows = await db.queryAsync("SHOW INDEX FROM activities");
  const currentRechargeIndex = activityIndexRows.filter(
    (row) => row.Key_name === "idx_activities_recharge_user",
  );
  const expectedActivityColumns = [
    "sender",
    "receiver",
    "type",
    "record_date",
    "record_time",
    "id",
  ];
  const activityIndexColumns = currentRechargeIndex
    .sort((a, b) => Number(a.Seq_in_index) - Number(b.Seq_in_index))
    .map((row) => row.Column_name);
  if (
    activityIndexColumns.length !== expectedActivityColumns.length ||
    !activityIndexColumns.every(
      (column, index) => column === expectedActivityColumns[index],
    )
  ) {
    if (currentRechargeIndex.length > 0) {
      await db.queryAsync(
        "DROP INDEX idx_activities_recharge_user ON activities",
      );
    }
    await db.queryAsync(
      "CREATE INDEX idx_activities_recharge_user ON activities(sender,receiver,type,record_date,record_time,id)",
    );
    console.log("Created activities recharge-date lookup index");
  }
}

async function ensureSecretColumnCapacity() {
  const columns = await db.queryAsync(
    "SELECT COLUMN_NAME,DATA_TYPE,CHARACTER_MAXIMUM_LENGTH FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='auths' AND COLUMN_NAME IN ('password','seed')",
  );
  const byName = new Map(columns.map((column) => [column.COLUMN_NAME, column]));
  const passwordColumn = byName.get("password");
  const seedColumn = byName.get("seed");

  if (!passwordColumn || !seedColumn) {
    throw new Error("The auths table must contain password and seed columns before secret migration.");
  }

  if (Number(passwordColumn.CHARACTER_MAXIMUM_LENGTH || 0) < 255) {
    await db.queryAsync("ALTER TABLE auths MODIFY password VARCHAR(255) NOT NULL");
    console.log("Expanded auths.password to hold Argon2id hashes");
  }

  if (Number(seedColumn.CHARACTER_MAXIMUM_LENGTH || 0) < 255) {
    await db.queryAsync("ALTER TABLE auths MODIFY seed TEXT NOT NULL");
    console.log("Expanded auths.seed to hold Argon2id hashes");
  }
}

async function initDbIfEmpty() {
  const [date, time] = getDate();
  const tables = [
    `CREATE TABLE IF NOT EXISTS auths(
       id INT AUTO_INCREMENT PRIMARY KEY,
       username VARCHAR(30) NOT NULL,
       password VARCHAR(255) NOT NULL,
       name VARCHAR(50) NOT NULL,
       email VARCHAR(50) NOT NULL,
       birthdate VARCHAR(20) NOT NULL,
       cni VARCHAR(255) NOT NULL,
       address VARCHAR(50) NOT NULL,
       seed TEXT NOT NULL,
       status INT,
       record_date INT,
       record_time VARCHAR(10),
       UNIQUE KEY uq_auths_username (username)
     ) ENGINE=InnoDB;`,
    `CREATE TABLE IF NOT EXISTS users_stock(
       id INT AUTO_INCREMENT PRIMARY KEY,
       username VARCHAR(30) NOT NULL,
       balance VARCHAR(255) DEFAULT '0',
       init_asset VARCHAR(255) NOT NULL DEFAULT '0',
       record_date INT,
       record_time VARCHAR(10),
       UNIQUE KEY uq_users_stock_username (username)
     ) ENGINE=InnoDB;`,
    `CREATE TABLE IF NOT EXISTS activities(
       id INT AUTO_INCREMENT PRIMARY KEY,
       sender VARCHAR(30) NOT NULL,
       receiver VARCHAR(30) NOT NULL,
       type INT,
       amount VARCHAR(30) NOT NULL,
       unit_price VARCHAR(255) DEFAULT '0',
       fees VARCHAR(30) DEFAULT '0',
       reference VARCHAR(20),
       record_date INT,
       record_time VARCHAR(10)
     ) ENGINE=InnoDB;`,
    `CREATE TABLE IF NOT EXISTS notifs(
       id INT AUTO_INCREMENT PRIMARY KEY,
       content TEXT,
       record_date INT,
       record_time VARCHAR(10)
     ) ENGINE=InnoDB;`,
    `CREATE TABLE IF NOT EXISTS common(
       id INT AUTO_INCREMENT PRIMARY KEY,
       total_units_price VARCHAR(255) DEFAULT '0',
       unit_price VARCHAR(255) DEFAULT '0',
       backed_units VARCHAR(255) DEFAULT '0',
       inactive_init_asset VARCHAR(255) NOT NULL DEFAULT '0',
       record_date INT,
       record_time VARCHAR(10)
     ) ENGINE=InnoDB;`,
    `CREATE TABLE IF NOT EXISTS system_locks(
       lock_name VARCHAR(64) PRIMARY KEY
     ) ENGINE=InnoDB;`,
    `CREATE TABLE IF NOT EXISTS users_usdt_tx(
       id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
       username VARCHAR(30) NOT NULL,
       tx_addr CHAR(42) NOT NULL,
       amount DECIMAL(36,18) NOT NULL DEFAULT 0,
       requested_amount DECIMAL(36,18) NOT NULL DEFAULT 0,
       tx_hash CHAR(66) NULL,
       record_date INT,
       record_time VARCHAR(10),
       status VARCHAR(32) NOT NULL DEFAULT 'pending',
       pending_username VARCHAR(30) NULL,
       pending_tx_addr CHAR(42) NULL,
       created_at_ms BIGINT UNSIGNED NOT NULL,
       expires_at_ms BIGINT UNSIGNED NOT NULL,
       start_block BIGINT UNSIGNED NOT NULL,
       last_scanned_block BIGINT UNSIGNED NOT NULL,
       UNIQUE KEY uq_users_usdt_pending_username (pending_username),
       UNIQUE KEY uq_users_usdt_pending_tx_addr (pending_tx_addr),
       UNIQUE KEY uq_users_usdt_tx_hash (tx_hash),
       KEY idx_users_usdt_status_expiry (status,expires_at_ms),
       KEY idx_users_usdt_username (username)
     ) ENGINE=InnoDB;`,
    `CREATE TABLE IF NOT EXISTS users_usdt_recharge_status(
       request_id BIGINT UNSIGNED PRIMARY KEY,
       username VARCHAR(30) NOT NULL,
       status VARCHAR(32) NOT NULL,
       response_json LONGTEXT NOT NULL,
       expires_at_ms BIGINT UNSIGNED NOT NULL,
       updated_at_ms BIGINT UNSIGNED NOT NULL,
       KEY idx_usdt_recharge_status_user (username,updated_at_ms)
     ) ENGINE=InnoDB;`,
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
       UNIQUE KEY uq_usdt_deposit_username (username),
       UNIQUE KEY uq_usdt_deposit_address (wallet_address),
       UNIQUE KEY uq_usdt_deposit_derivation_index (derivation_index),
       KEY idx_usdt_deposit_scan (id,last_scanned_block)
     ) ENGINE=InnoDB;`,
    `CREATE TABLE IF NOT EXISTS users_usdt_transfer_events(
       id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
       username VARCHAR(30) NOT NULL,
       deposit_wallet_id BIGINT UNSIGNED NOT NULL,
       deposit_address CHAR(42) NOT NULL,
       from_address CHAR(42) NOT NULL,
       amount DECIMAL(36,18) NOT NULL,
       amount_raw VARCHAR(78) NOT NULL,
       tx_hash CHAR(66) NOT NULL,
       log_index INT UNSIGNED NOT NULL,
       block_number BIGINT UNSIGNED NOT NULL,
       block_hash CHAR(66) NOT NULL,
       block_timestamp_ms BIGINT UNSIGNED NOT NULL,
       request_id BIGINT UNSIGNED NULL,
       status VARCHAR(32) NOT NULL,
       reason_codes TEXT NULL,
       email_status VARCHAR(16) NOT NULL DEFAULT 'pending',
       email_attempts INT UNSIGNED NOT NULL DEFAULT 0,
       email_last_attempt_ms BIGINT UNSIGNED NULL,
       email_last_error TEXT NULL,
       email_sent_at_ms BIGINT UNSIGNED NULL,
       swept_at_ms BIGINT UNSIGNED NULL,
       created_at_ms BIGINT UNSIGNED NOT NULL,
       UNIQUE KEY uq_usdt_transfer_event (tx_hash,log_index),
       KEY idx_usdt_transfer_user_status (username,status,id),
       KEY idx_usdt_transfer_email_queue (status,email_status,email_attempts,id),
       KEY idx_usdt_transfer_deposit_sweep (deposit_address,swept_at_ms,status),
       KEY idx_usdt_transfer_block (block_number)
     ) ENGINE=InnoDB;`,
    `CREATE TABLE IF NOT EXISTS users_usdt_sweeps(
       id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
       deposit_wallet_id BIGINT UNSIGNED NOT NULL,
       deposit_address CHAR(42) NOT NULL,
       snapshot_block BIGINT UNSIGNED NOT NULL,
       amount_raw VARCHAR(78) NOT NULL,
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
       UNIQUE KEY uq_usdt_sweep_token_hash (token_tx_hash),
       KEY idx_usdt_sweeps_wallet_status (deposit_wallet_id,status,id)
     ) ENGINE=InnoDB;`,
    `CREATE TABLE IF NOT EXISTS users_usdt_disbursements(
       id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
       username VARCHAR(30) NOT NULL,
       payout_address CHAR(42) NOT NULL,
       requested_amount DECIMAL(36,18) NOT NULL,
       payout_amount DECIMAL(36,18) NOT NULL,
       amount_raw VARCHAR(78) NOT NULL,
       gross_balance VARCHAR(255) NOT NULL,
       gross_init_asset VARCHAR(255) NOT NULL,
       sold_init_asset VARCHAR(255) NOT NULL DEFAULT '0',
       fee_amount VARCHAR(255) NOT NULL,
       fee_init_asset VARCHAR(255) NOT NULL,
       price_value VARCHAR(255) NOT NULL,
       reference VARCHAR(32) NOT NULL,
       status VARCHAR(24) NOT NULL DEFAULT 'queued',
       raw_tx LONGTEXT NULL,
       tx_hash CHAR(66) NULL,
       nonce BIGINT UNSIGNED NULL,
       block_number BIGINT UNSIGNED NULL,
       last_error TEXT NULL,
       created_at_ms BIGINT UNSIGNED NOT NULL,
       updated_at_ms BIGINT UNSIGNED NOT NULL,
       confirmed_at_ms BIGINT UNSIGNED NULL,
       UNIQUE KEY uq_usdt_disbursement_reference (reference),
       UNIQUE KEY uq_usdt_disbursement_tx_hash (tx_hash),
       KEY idx_usdt_disbursement_user_time (username,created_at_ms),
       KEY idx_usdt_disbursement_status (status,id)
     ) ENGINE=InnoDB;`,
  ];

  for (const statement of tables) await db.queryAsync(statement);
  console.log(`Database tables ready (${tables.length})`);

  // Apply the same constraints to existing databases that predate these indexes.
  await ensureInnoDBTable("auths");
  await ensureInnoDBTable("users_stock");
  await removeLegacyUserStockUnitPriceColumn();
  await ensureUsersStockInitAssetColumn();
  await ensureInnoDBTable("activities");
  await ensureInnoDBTable("common");
  await ensureCommonInactiveInitAssetColumn();
  await ensureInnoDBTable("system_locks");
  await ensureInnoDBTable("users_usdt_tx");
  await ensureInnoDBTable("users_usdt_recharge_status");
  await ensureInnoDBTable("users_usdt_deposit_wallets");
  await ensureDepositPayoutAddressColumn();
  await ensureInnoDBTable("users_usdt_transfer_events");
  await ensureInnoDBTable("users_usdt_sweeps");
  await ensureInnoDBTable("users_usdt_disbursements");
  await ensureDisbursementSoldInitAssetColumn();
  await ensureRechargeSchema();
  await db.queryAsync(
    "INSERT IGNORE INTO system_locks(lock_name) VALUES(?),(?),(?)",
    ["common_state", "deposit_wallet_index", "onex_bsc_disbursement_worker"],
  );
  // Pending rows from the old single-receiver model cannot be reused as deposit-wallet requests.
  await db.queryAsync(
    `UPDATE users_usdt_tx
     SET status='legacy_untracked',pending_username=NULL,pending_tx_addr=NULL
     WHERE status='pending' AND tx_addr NOT IN
       (SELECT wallet_address FROM users_usdt_deposit_wallets)`,
  );
  await ensureSecretColumnCapacity();
  await ensureUniqueUsernameIndex("auths");
  await ensureUniqueUsernameIndex("users_stock");

  // Upgrade legacy reversible user secrets before the HTTP server starts.
  await migrateLegacyUserSecrets();

  const stockRows = await db.queryAsync(
    "SELECT id FROM users_stock WHERE username=? LIMIT 1",
    [OneX],
  );
  if (stockRows.length === 0) {
    await db.queryAsync(
      "INSERT INTO users_stock(username,balance,init_asset,record_date,record_time) VALUES(?,?,?,?,?)",
      [OneX, "0", "0", date, time],
    );
    console.log("OneX stock account initialized");
  }

  const commonRows = await db.queryAsync("SELECT id FROM common LIMIT 1");
  if (commonRows.length === 0) {
    await db.queryAsync(
      "INSERT INTO common(total_units_price,unit_price,backed_units,inactive_init_asset,record_date,record_time) VALUES(?,?,?,?,?,?)",
      [stock_limit, "1", "0", "0", date, time],
    );
    console.log("Unit price initialized");
  }

  // Existing accounts with positive balances need an initial-asset basis before
  // near-transfer can derive their own unit price from balance / init_asset.
  await backfillUsersStockInitAssets();
}

async function cleanup() {
  const [date7] = getDateBefore(7);
  try {
    const rows = await db.queryAsync(
      "SELECT username FROM auths WHERE status=0 AND record_date=?",
      [date7],
    );
    for (const { username: username } of rows) {
      await db.queryAsync(
        "DELETE FROM users_stock WHERE username=?;DELETE FROM auths WHERE username=?;",
        [username, username],
      );
    }
    await db.queryAsync(
      "DELETE FROM users_usdt_recharge_status WHERE updated_at_ms < ?",
      [String(Date.now() - 30 * 24 * 60 * 60 * 1000)],
    );
  } catch (e) {
    console.error(e);
  }
}

module.exports = {
  db,
  DB_CONFIG,
  OneX,
  maxStockDefault,
  P2Pallowed,
  stock_limit,
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
