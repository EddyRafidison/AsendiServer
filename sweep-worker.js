"use strict";

process.env.TZ = "UTC";

const dotenv = require("dotenv");

dotenv.config();

const sweepEnvFile = String(process.env.USDT_SWEEP_ENV_FILE || ".env.sweeper").trim();
const sweepEnvResult = dotenv.config({ path: sweepEnvFile, override: true });
if (sweepEnvResult.error) {
  throw new Error(`Unable to load the dedicated sweep secrets file: ${sweepEnvFile}`);
}

const { db } = require("./db");
const { startDepositSweeper } = require("./sweep");

async function main() {
  if (String(process.env.USDT_SWEEP_ENABLED || "false").toLowerCase() !== "true") {
    throw new Error("USDT_SWEEP_ENABLED=true is required in the dedicated sweep environment file.");
  }

  // The main HTTP service must initialize the schema before this worker starts.
  await db.queryAsync("SELECT 1");
  await db.queryAsync("SELECT id FROM users_usdt_deposit_wallets LIMIT 1");

  const result = startDepositSweeper(db);
  if (!result || !result.enabled) {
    throw new Error("The automatic BSC deposit sweeper did not start.");
  }
  console.log("OneX BSC deposit sweeper started in a dedicated process.");
}

main().catch((error) => {
  console.error("OneX BSC deposit sweeper startup failed:", error);
  process.exitCode = 1;
});
