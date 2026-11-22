process.env.TZ = "UTC";

"use strict";

require("dotenv").config();

const path = require("path");
const { db, initDbIfEmpty } = require("./db");
const { startDisbursementWorker } = require("./disbursement");

const enabled = (name) => String(process.env[name] || "false").toLowerCase() === "true";

async function getPendingWork() {
  const [rows] = await db.promise().query(
    `SELECT
       (SELECT COUNT(*) FROM users_usdt_disbursements WHERE status IN ('queued','signed','submitted')) AS disbursements,
       (SELECT COUNT(*) FROM users_usdt_seller_payouts WHERE status IN ('queued','signed','submitted')) AS seller_payouts,
       (SELECT COUNT(*) FROM users_usdt_refunds WHERE status IN ('queued','signed','submitted')) AS refunds,
       (SELECT COUNT(*) FROM global_disbursement_runs WHERE status IN ('active','closed','manual_review')) AS global_runs`,
  );
  return rows[0] || {};
}

async function start() {
  try {
    await initDbIfEmpty();

    const masterEnabled = enabled("USDT_DISBURSEMENTS_ENABLED");
    const individualEnabled = masterEnabled && enabled("USDT_INDIVIDUAL_DISBURSEMENT_ENABLED");
    const globalEnabled = masterEnabled && enabled("USDT_GLOBAL_DISBURSEMENT_ENABLED");
    const sellerEnabled = enabled("USDT_SELLER_PAYOUTS_ENABLED");
    const pending = await getPendingWork();
    const pendingDisbursements = Number(pending.disbursements || 0);
    const pendingSellerPayouts = Number(pending.seller_payouts || 0);
    const pendingRefunds = Number(pending.refunds || 0);
    const pendingGlobalRuns = Number(pending.global_runs || 0);
    const needDisbursement = individualEnabled || globalEnabled || pendingDisbursements > 0;
    const needTreasury = sellerEnabled || pendingSellerPayouts > 0 || pendingRefunds > 0;

    if (!needDisbursement && !needTreasury && pendingGlobalRuns === 0) {
      console.log("OneX BSC treasury payouts are disabled; no accepted payouts are pending.");
      db.end();
      return;
    }

    if (needTreasury) {
      const treasuryEnvFile = process.env.USDT_TREASURY_ENV_FILE || ".env.treasury";
      const treasuryEnvResult = require("dotenv").config({
        path: path.resolve(process.cwd(), treasuryEnvFile),
      });
      if (treasuryEnvResult.error) {
        throw new Error(`Unable to load Hot Wallet secrets from ${treasuryEnvFile}: ${treasuryEnvResult.error.message}`);
      }
      if (!process.env.BSC_TREASURY_PRIVATE_KEY) {
        throw new Error(`BSC_TREASURY_PRIVATE_KEY is missing from ${treasuryEnvFile}.`);
      }
    }
    if (needDisbursement) {
      const disbursementEnvFile = process.env.USDT_DISBURSEMENT_ENV_FILE || ".env.disbursement";
      const disbursementEnvResult = require("dotenv").config({
        path: path.resolve(process.cwd(), disbursementEnvFile),
      });
      if (disbursementEnvResult.error) {
        throw new Error(`Unable to load Disbursement Wallet secrets from ${disbursementEnvFile}: ${disbursementEnvResult.error.message}`);
      }
      if (!process.env.BSC_DISBURSEMENT_PRIVATE_KEY) {
        throw new Error(`BSC_DISBURSEMENT_PRIVATE_KEY is missing from ${disbursementEnvFile}.`);
      }
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
