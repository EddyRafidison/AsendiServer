"use strict";

const BigNumber = require("bignumber.js");

BigNumber.config({ DECIMAL_PLACES: 36, ROUNDING_MODE: BigNumber.ROUND_HALF_UP });
const { getLatestCommonTx, insertCommonSnapshotTx } = require("./common-accounting");

function getUtcRecordDateTime() {
  const now = new Date();
  const date = Number(
    `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, "0")}${String(now.getUTCDate()).padStart(2, "0")}`,
  );
  const time = `${String(now.getUTCHours()).padStart(2, "0")}${String(now.getUTCMinutes()).padStart(2, "0")}${String(now.getUTCSeconds()).padStart(2, "0")}`;
  return [date, time];
}

function getConfiguredBnbUsdPrice() {
  const value = new BigNumber(process.env.BNB_USD_PRICE || "0");
  return value.isFinite() && value.isGreaterThan(0) ? value : new BigNumber(0);
}

function calculateEstimatedGasFee(gasLimit, gasPriceWei, bnbUsdPrice = getConfiguredBnbUsdPrice()) {
  const limit = new BigNumber(String(gasLimit));
  const gasPrice = new BigNumber(String(gasPriceWei));
  const price = new BigNumber(bnbUsdPrice);
  if (!limit.isInteger() || !limit.isGreaterThan(0) || !gasPrice.isInteger() || !gasPrice.isGreaterThan(0)) {
    throw new RangeError("Gas limit and gas price must be positive integers");
  }
  if (!price.isFinite() || price.isNegative()) throw new RangeError("BNB/USD price is invalid");
  const feeBnb = limit.multipliedBy(gasPrice).shiftedBy(-18);
  return {
    feeBnb,
    feeUsd: feeBnb.multipliedBy(price),
    bnbUsdPrice: price,
  };
}

function calculateActualGasFee(receipt, bnbUsdPrice = getConfiguredBnbUsdPrice()) {
  const gasUsed = receipt?.gasUsed;
  const gasPriceWei = receipt?.gasPrice ?? receipt?.effectiveGasPrice;
  if (gasUsed == null || gasPriceWei == null) {
    throw new TypeError("The finalized transaction receipt does not contain gasUsed and effectiveGasPrice");
  }
  const fee = calculateEstimatedGasFee(gasUsed.toString(), gasPriceWei.toString(), bnbUsdPrice);
  return {
    gasUsed: String(gasUsed),
    effectiveGasPriceWei: String(gasPriceWei),
    feeBnb: fee.feeBnb,
    feeUsd: fee.feeUsd,
    bnbUsdPrice: fee.bnbUsdPrice,
  };
}

async function bumpCommonFeeTotalsTx(tx, fieldDeltas, dateTime = null) {
  const [lockRows] = await tx.query(
    "SELECT lock_name FROM system_locks WHERE lock_name=? FOR UPDATE",
    ["common_state"],
  );
  if (!lockRows.length) throw new Error("The common-state lock row has not been initialized");
  const current = await getLatestCommonTx(tx, true);
  const overrides = {};
  for (const [field, deltaValue] of Object.entries(fieldDeltas)) {
    const currentValue = new BigNumber(current[field] || "0");
    const delta = new BigNumber(deltaValue);
    if (!currentValue.isFinite() || !delta.isFinite() || delta.isNegative()) {
      throw new RangeError(`Invalid cumulative fee value for ${field}`);
    }
    overrides[field] = currentValue.plus(delta).toFixed();
  }
  const [date, time] = dateTime || getUtcRecordDateTime();
  return insertCommonSnapshotTx(tx, current, overrides, date, time);
}

async function recordEstimatedBscFeeTx(tx, {
  txHash,
  operation,
  gasLimit,
  gasPriceWei,
  bnbUsdPrice = getConfiguredBnbUsdPrice(),
}) {
  const hash = String(txHash || "").toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(hash)) throw new TypeError("Invalid transaction hash for gas accounting");
  const fee = calculateEstimatedGasFee(gasLimit, gasPriceWei, bnbUsdPrice);
  const [result] = await tx.query(
    `INSERT IGNORE INTO bsc_fee_ledger
     (tx_hash,operation,estimated_fee_bnb,estimated_fee_usd,bnb_usd_price,created_at_ms)
     VALUES(?,?,?,?,?,?)`,
    [hash, String(operation).slice(0, 32), fee.feeBnb.toFixed(30), fee.feeUsd.toFixed(30), fee.bnbUsdPrice.toFixed(12), String(Date.now())],
  );
  if (result.affectedRows === 1) {
    await bumpCommonFeeTotalsTx(tx, {
      total_bnb_fee_estimated: fee.feeBnb,
      total_bnb_fee_estimated_value: fee.feeUsd,
    });
  }
  return fee;
}

async function recordActualBscFeeTx(tx, {
  txHash,
  operation,
  receipt,
  bnbUsdPrice,
}) {
  const hash = String(txHash || "").toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(hash)) throw new TypeError("Invalid transaction hash for gas accounting");
  const [existingRows] = await tx.query(
    "SELECT estimated_fee_bnb,estimated_fee_usd,bnb_usd_price,actual_fee_bnb FROM bsc_fee_ledger WHERE tx_hash=? LIMIT 1 FOR UPDATE",
    [hash],
  );
  if (existingRows.length && existingRows[0].actual_fee_bnb != null) return { duplicate: true };
  const configuredPrice = bnbUsdPrice == null
    ? (existingRows[0]?.bnb_usd_price || getConfiguredBnbUsdPrice())
    : bnbUsdPrice;
  const fee = calculateActualGasFee(receipt, configuredPrice);
  await tx.query(
    `INSERT INTO bsc_fee_ledger
     (tx_hash,operation,estimated_fee_bnb,estimated_fee_usd,bnb_usd_price,gas_used,effective_gas_price_wei,
      actual_fee_bnb,actual_fee_usd,created_at_ms,confirmed_at_ms)
     VALUES(?,?,?,?,?,?,?,?,?,?,?)
     ON DUPLICATE KEY UPDATE gas_used=VALUES(gas_used),effective_gas_price_wei=VALUES(effective_gas_price_wei),
       actual_fee_bnb=VALUES(actual_fee_bnb),actual_fee_usd=VALUES(actual_fee_usd),confirmed_at_ms=VALUES(confirmed_at_ms)`,
    [
      hash,
      String(operation).slice(0, 32),
      existingRows[0]?.estimated_fee_bnb || "0",
      existingRows[0]?.estimated_fee_usd || "0",
      fee.bnbUsdPrice.toFixed(12),
      fee.gasUsed,
      fee.effectiveGasPriceWei,
      fee.feeBnb.toFixed(30),
      fee.feeUsd.toFixed(30),
      String(Date.now()),
      String(Date.now()),
    ],
  );
  await bumpCommonFeeTotalsTx(tx, {
    total_bnb_fee_actual: fee.feeBnb,
    total_bnb_fee_actual_value: fee.feeUsd,
  });
  return fee;
}

module.exports = {
  getConfiguredBnbUsdPrice,
  calculateEstimatedGasFee,
  calculateActualGasFee,
  recordEstimatedBscFeeTx,
  recordActualBscFeeTx,
  bumpCommonFeeTotalsTx,
};
