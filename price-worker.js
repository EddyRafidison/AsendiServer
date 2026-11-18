"use strict";

const { processPriceEventBatch } = require("./user-price-accounting");

let timer = null;
let running = false;

function integerEnv(name, fallback, minimum, maximum) {
  const parsed = Number(process.env[name] || fallback);
  return Number.isSafeInteger(parsed) ? Math.max(minimum, Math.min(maximum, parsed)) : fallback;
}

async function runPriceWorkerCycle(db) {
  if (running) return;
  running = true;
  try {
    for (let index = 0; index < 10; index += 1) {
      const result = await processPriceEventBatch(db, integerEnv("PRICE_EVENT_BATCH_SIZE", 500, 50, 1000));
      if (!result.processed) break;
    }
  } catch (error) {
    console.error("OneX individual-price worker failed:", error.message);
  } finally {
    running = false;
  }
}

function startPriceWorker(db) {
  if (timer) return { enabled: true };
  const intervalMs = integerEnv("PRICE_EVENT_POLL_MS", 3000, 1000, 60000);
  const run = async () => {
    await runPriceWorkerCycle(db);
    timer = setTimeout(run, intervalMs);
  };
  void run();
  return { enabled: true };
}

module.exports = { startPriceWorker, runPriceWorkerCycle };
