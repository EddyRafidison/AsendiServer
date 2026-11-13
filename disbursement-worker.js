process.env.TZ = "UTC";

"use strict";

require("dotenv").config();

const disbursementsEnabled = String(process.env.USDT_DISBURSEMENTS_ENABLED || "false").toLowerCase() === "true";
const sellerPayoutsEnabled = String(process.env.USDT_SELLER_PAYOUTS_ENABLED || "false").toLowerCase() === "true";
const adminFeesRequested = String(process.env.ADMIN_FEES_TRANSFERS_ENABLED || "false").toLowerCase() === "true";
const { getAdminFeesTransferConfig } = require("./admin-fees-policy");
const adminFeesConfig = getAdminFeesTransferConfig();
const adminFeesTransfersEnabled = adminFeesConfig.enabled;
if (adminFeesRequested && !adminFeesTransfersEnabled) {
  console.error(`Admin-fees transfers remain disabled: ${adminFeesConfig.reason}.`);
}
if (!disbursementsEnabled && !sellerPayoutsEnabled && !adminFeesTransfersEnabled) {
  console.log("OneX BSC treasury payouts are disabled or have invalid admin-fees configuration.");
  process.exit(0);
}

const path = require("path");
const envFile = process.env.USDT_DISBURSEMENT_ENV_FILE || ".env.disbursement";
const envResult = require("dotenv").config({
  path: path.resolve(process.cwd(), envFile),
  // Keep policy flags and BNB_USD_PRICE from the main environment; this file contains signing secrets.
});

if (envResult.error) {
  console.error(`Unable to load disbursement secrets from ${envFile}:`, envResult.error.message);
  process.exit(1);
}
if (!process.env.BSC_DISBURSEMENT_PRIVATE_KEY) {
  console.error(`BSC_DISBURSEMENT_PRIVATE_KEY is missing from ${envFile}.`);
  process.exit(1);
}

const { db, initDbIfEmpty } = require("./db");
const { startDisbursementWorker } = require("./disbursement");

async function start() {
  try {
    await initDbIfEmpty();
    const result = await startDisbursementWorker(db);
    if (!result.enabled) {
      console.error("The OneX disbursement worker did not start.");
      process.exitCode = 1;
    }
  } catch (error) {
    console.error("OneX disbursement worker startup failed:", error);
    process.exit(1);
  }
}

void start();
