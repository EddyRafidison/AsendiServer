"use strict";

require("dotenv").config();
const { db } = require("./db");
const {
  closeExpiredSellerCampaignsTx,
  queueSellerPayoutBatchesTx,
} = require("./seller-accounting");

const WORKER_LOCK_NAME = "onex_seller_lifecycle_worker";
const POLL_INTERVAL_MS = Number(process.env.SELLER_LIFECYCLE_POLL_MS || 60000);
let timer = null;
let running = false;

function getConnection(pool) {
  return new Promise((resolve, reject) => {
    pool.getConnection((error, connection) => {
      if (error) return reject(error);
      resolve(connection);
    });
  });
}

async function runSellerLifecycle(pool = db) {
  if (running) return;
  running = true;
  const connection = await getConnection(pool).catch((error) => {
    running = false;
    throw error;
  });
  const tx = connection.promise();
  let started = false;
  let lockAcquired = false;
  try {
    const [lockRows] = await tx.query("SELECT GET_LOCK(?,0) AS acquired", [WORKER_LOCK_NAME]);
    lockAcquired = Number(lockRows[0]?.acquired) === 1;
    if (!lockAcquired) return;
    await tx.beginTransaction();
    started = true;
    await closeExpiredSellerCampaignsTx(tx, Date.now());
    await queueSellerPayoutBatchesTx(tx);
    await tx.commit();
    started = false;
  } catch (error) {
    if (started) {
      try { await tx.rollback(); } catch (rollbackError) {
        console.error("Seller lifecycle rollback failed:", rollbackError.message);
      }
    }
    throw error;
  } finally {
    if (lockAcquired) {
      try { await tx.query("SELECT RELEASE_LOCK(?)", [WORKER_LOCK_NAME]); } catch (error) {
        console.error("Seller lifecycle lock release failed:", error.message);
      }
    }
    connection.release();
    running = false;
  }
}

function startSellerLifecycleWorker(pool = db) {
  if (timer) return;
  if (!Number.isInteger(POLL_INTERVAL_MS) || POLL_INTERVAL_MS < 10000 || POLL_INTERVAL_MS > 3600000) {
    throw new Error("SELLER_LIFECYCLE_POLL_MS must be between 10000 and 3600000 milliseconds.");
  }
  const run = async () => {
    try {
      await runSellerLifecycle(pool);
    } catch (error) {
      console.error("Seller lifecycle worker failed:", error.message);
    } finally {
      timer = setTimeout(run, POLL_INTERVAL_MS);
    }
  };
  void run();
}

module.exports = { runSellerLifecycle, startSellerLifecycleWorker };
