require("dotenv").config();
const mysql = require("mysql2");
const { getDate, getDateBefore } = require("./utils");

// -------------- CONSTANTS & ENV VARS ---------------
const OneX = "ONEX";
const maxStockDefault = process.env.MAX_STOCK_DEFAULT;
const P2Pallowed = process.env.P2P_ALLOWED;
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
};

// ---------------- DATABASE POOL --------------------
const db = mysql.createPool(DB_CONFIG);
db.queryAsync = (sql, params = []) =>
  new Promise((res, rej) =>
    db.query(sql, params, (e, r) => (e ? rej(e) : res(r))),
  );

async function initDbIfEmpty() {
  const [date, time] = getDate();
  try {
    await db.queryAsync("SELECT id FROM users_stock WHERE username=?", [OneX]);
  } catch {
    const tables = [
      `CREATE TABLE IF NOT EXISTS auths(
         id INT AUTO_INCREMENT PRIMARY KEY,
         username VARCHAR(30) NOT NULL, password VARCHAR(255) NOT NULL,
         name VARCHAR(50) NOT NULL, email VARCHAR(50) NOT NULL,
         birthdate VARCHAR(20) NOT NULL, cni VARCHAR(255) NOT NULL,
         address VARCHAR(50) NOT NULL, seed TEXT NOT NULL,
         status INT, record_date INT, record_time VARCHAR(10)
       );`,
      `CREATE TABLE IF NOT EXISTS users_stock(
         id INT AUTO_INCREMENT PRIMARY KEY,
         username VARCHAR(30) NOT NULL, balance VARCHAR(255) DEFAULT '0',
         record_date INT, record_time VARCHAR(10)
       );`,
      `CREATE TABLE IF NOT EXISTS activities(
         id INT AUTO_INCREMENT PRIMARY KEY,
         sender VARCHAR(30) NOT NULL, receiver VARCHAR(30) NOT NULL,
         type INT, amount VARCHAR(30) NOT NULL,
         unit_price VARCHAR(255) DEFAULT '0',
         fees VARCHAR(30) DEFAULT '0', reference VARCHAR(20),
         record_date INT, record_time VARCHAR(10)
       );`,
      `CREATE TABLE IF NOT EXISTS notifs(
         id INT AUTO_INCREMENT PRIMARY KEY,
         content TEXT, record_date INT, record_time VARCHAR(10)
       );`,
      `CREATE TABLE IF NOT EXISTS common(
         id INT AUTO_INCREMENT PRIMARY KEY,
         total_units_price  VARCHAR(255) DEFAULT '0',
         unit_price VARCHAR(255) DEFAULT '0',
         backed_units VARCHAR(255) DEFAULT '0',
         record_date INT, record_time VARCHAR(10)
       );`,
    ];
    let tables_count = tables.length;
    for (let s of tables) await db.queryAsync(s);
    console.log("Each table of " + tables_count + " ready");
    await db.queryAsync(
      "INSERT INTO users_stock(username,balance,record_date,record_time) VALUES(?,?,?,?)",
      [OneX, "0", date, time],
    );
    console.log("OneX ready");
    await db.queryAsync(
      "INSERT INTO common(total_units_price,unit_price,backed_units,record_date,record_time) VALUES(?,?,?,?,?)",
      [stock_limit, "1", "0", date, time],
    );
    console.log("Unit price initialized");
  }
}

async function cleanup() {
  const [date7] = getDateBefore(7);
  try {
    const rows = await db.queryAsync(
      "SELECT username FROM auths WHERE status=0 AND record_date=?",
      [date7],
    );
    for (let { username: u } of rows) {
      await db.queryAsync(
        "DELETE FROM users_stock WHERE username=?;DELETE FROM auths WHERE username=?;",
        [u, u],
      );
    }
  } catch (e) {
    console.error(e);
  }
}

async function lastUnitPrice(user) {
  let price = 1;

  try {
    if (isActive(user)) {
      const [[{ unit_price } = {}]] = await db.queryAsync(
        "SELECT MAX(unit_price) AS unit_price FROM common",
      );
      if (unit_price != null) price = unit_price;
    } else {
      const [[{ unit_price } = {}]] = await db.queryAsync(
        "SELECT unit_price FROM activities WHERE username = ? ORDER BY id DESC LIMIT 1",
        [user],
      );
      if (unit_price != null) price = unit_price;
    }
  } catch (error) {
    console.error("Error retrieving appropriate unit price :", error);
  }

  return price;
}

async function isActive(user) {}

module.exports = {
  db,
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
  lastUnitPrice,
  isActive,
};
