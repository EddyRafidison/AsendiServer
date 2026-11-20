process.env.TZ = "UTC";

"use strict";

require("dotenv").config();

const path = require("path");
const { db, initDbIfEmpty } = require("./db");
const { startDisbursementWorker } = require("./disbursement");

const enabled = (name) => String(process.env[name] || "false").toLowerCase() === "true";

async function hasAcceptedTreasuryWork() {
  const [rows] = await db.promise().query(
    `SELECT
       (SELECT COUNT(*) FROM users_usdt_disbursements WHERE status IN ('queued','signed','submitted')) AS disbursements,
       (SELECT COUNT(*) FROM users_usdt_seller_payouts WHERE status IN ('queued','signed','submitted')) AS seller_payouts,
       (SELECT COUNT(*) FROM users_usdt_refunds WHERE status IN ('queued','signed','submitted')) AS refunds,
       (SELECT COUNT(*) FROM global_disbursement_runs WHERE status IN ('active','closed','manual_review')) AS global_runs`,
  );
  return Object.values(rows[0] || {}).some((value) => Number(value || 0) > 0);
}

async function start() {
  try {
    await initDbIfEmpty();

    const masterEnabled = enabled("USDT_DISBURSEMENTS_ENABLED");
    const individualEnabled = masterEnabled && enabled("USDT_INDIVIDUAL_DISBURSEMENT_ENABLED");
    const globalEnabled = masterEnabled && enabled("USDT_GLOBAL_DISBURSEMENT_ENABLED");
    const sellerEnabled = enabled("USDT_SELLER_PAYOUTS_ENABLED");
    const acceptedWork = await hasAcceptedTreasuryWork();

    if (!individualEnabled && !globalEnabled && !sellerEnabled && !acceptedWork) {
      console.log("OneX BSC treasury payouts are disabled; no accepted payouts are pending.");
      db.end();
      return;
    }

    const envFile = process.env.USDT_DISBURSEMENT_ENV_FILE || ".env.disbursement";
    const envResult = require("dotenv").config({
      path: path.resolve(process.cwd(), envFile),
      // Keep feature flags and Chainlink BNB/USD feed settings from the main environment.
    });
    if (envResult.error) {
      throw new Error(`Unable to load disbursement secrets from ${envFile}: ${envResult.error.message}`);
    }
    if (!process.env.BSC_DISBURSEMENT_PRIVATE_KEY) {
      throw new Error(`BSC_DISBURSEMENT_PRIVATE_KEY is missing from ${envFile}.`);
    }

    const result = await startDisbursementWorker(db);
    if (!result.enabled) {
      throw new Error("The OneX disbursement worker did not start.");
    }
  } catch (error) {
    console.error("OneX disbursement worker startup failed:", error);
    process.exitCode = 1;
    try { db.end(); } catch {}
  }
}

void start();
