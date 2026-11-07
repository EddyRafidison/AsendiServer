"use strict";

require("dotenv").config();

if (
  String(process.env.USDT_DISBURSEMENTS_ENABLED || "false").toLowerCase() !== "true"
) {
  console.log("OneX BSC disbursements are disabled. Set USDT_DISBURSEMENTS_ENABLED=true to start the worker.");
  process.exit(0);
}

const path = require("path");
const envFile = process.env.USDT_DISBURSEMENT_ENV_FILE || ".env.disbursement";
const envResult = require("dotenv").config({
  path: path.resolve(process.cwd(), envFile),
  override: false,
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
