"use strict";

const BigNumber = require("bignumber.js");

BigNumber.config({ DECIMAL_PLACES: 36, ROUNDING_MODE: BigNumber.ROUND_HALF_UP });

const XTU_DECIMALS = 18;
const XTU_SCALE = 10n ** BigInt(XTU_DECIMALS);
const MIN_XTU_WITHDRAWAL = new BigNumber("5");
const XTU_TRANSFER_FEE_BPS = 10n;
const BPS_DENOMINATOR = 10000n;

function positiveAmount(value, fieldName) {
  const amount = new BigNumber(String(value));
  if (!amount.isFinite() || !amount.isGreaterThan(0)) {
    throw new RangeError(`${fieldName} must be a finite positive amount.`);
  }
  return amount;
}

function tokenRawFromDecimal(value, roundingMode = BigNumber.ROUND_DOWN) {
  const amount = positiveAmount(value, "XTU amount");
  const raw = amount.multipliedBy(new BigNumber(XTU_SCALE.toString())).integerValue(roundingMode);
  if (!raw.isInteger() || !raw.isGreaterThan(0)) throw new RangeError("XTU amount is below the token's smallest unit.");
  return BigInt(raw.toFixed(0));
}

function formatTokenRaw(rawValue) {
  const raw = BigInt(rawValue);
  const whole = raw / XTU_SCALE;
  const remainder = raw % XTU_SCALE;
  if (remainder === 0n) return whole.toString();
  return `${whole.toString()}.${remainder.toString().padStart(XTU_DECIMALS, "0").replace(/0+$/, "")}`;
}

function calculateXtuWithdrawalQuote(grossAmountValue, estimatedGasFeeUsdValue) {
  const gross = positiveAmount(grossAmountValue, "Gross XTU withdrawal");
  const gasUsd = new BigNumber(String(estimatedGasFeeUsdValue));
  if (!gasUsd.isFinite() || gasUsd.isNegative()) throw new RangeError("Estimated BSC gas fee must be non-negative.");
  if (gross.lt(MIN_XTU_WITHDRAWAL)) throw new RangeError("The minimum gross XTU withdrawal is 5 XTU.");

  const grossRaw = tokenRawFromDecimal(gross.toFixed(XTU_DECIMALS), BigNumber.ROUND_DOWN);
  const gasRaw = gasUsd.multipliedBy(new BigNumber(XTU_SCALE.toString()))
    .integerValue(BigNumber.ROUND_CEIL);
  if (!gasRaw.isInteger() || gasRaw.isNegative()) throw new RangeError("Invalid gas-equivalent XTU amount.");
  const gasRawInteger = BigInt(gasRaw.toFixed(0));
  if (gasRawInteger >= grossRaw) throw new RangeError("The estimated gas fee consumes the requested withdrawal amount.");

  const contractTransferRaw = grossRaw - gasRawInteger;
  const contractFeeRaw = (contractTransferRaw * XTU_TRANSFER_FEE_BPS) / BPS_DENOMINATOR;
  const netRaw = contractTransferRaw - contractFeeRaw;
  if (netRaw <= 0n) throw new RangeError("The net XTU withdrawal must be positive.");

  const gasXtu = new BigNumber(gasRawInteger.toString()).dividedBy(XTU_SCALE.toString());
  const contractFee = new BigNumber(contractFeeRaw.toString()).dividedBy(XTU_SCALE.toString());
  const net = new BigNumber(netRaw.toString()).dividedBy(XTU_SCALE.toString());
  return {
    grossAmount: new BigNumber(grossRaw.toString()).dividedBy(XTU_SCALE.toString()),
    grossRaw: grossRaw.toString(),
    estimatedGasFeeXtu: gasXtu,
    estimatedGasFeeUsd: gasUsd,
    contractTransferAmount: new BigNumber(contractTransferRaw.toString()).dividedBy(XTU_SCALE.toString()),
    contractTransferRaw: contractTransferRaw.toString(),
    contractFeeAmount: contractFee,
    contractFeeRaw: contractFeeRaw.toString(),
    netAmount: net,
    netRaw: netRaw.toString(),
    estimatedCombinedFees: gasXtu.plus(contractFee),
  };
}

function validateWithdrawalRequestAmount(value) {
  if (typeof value !== "string" && typeof value !== "number") {
    throw new TypeError("amount must be provided as a decimal string.");
  }
  const text = String(value).trim();
  if (!/^\d{1,30}(?:\.\d{1,18})?$/.test(text)) {
    throw new TypeError("amount must be a positive decimal with no more than 18 decimal places.");
  }
  const amount = positiveAmount(text, "XTU withdrawal amount");
  if (amount.lt(MIN_XTU_WITHDRAWAL)) throw new RangeError("The minimum gross XTU withdrawal is 5 XTU.");
  return amount;
}

module.exports = {
  XTU_DECIMALS,
  MIN_XTU_WITHDRAWAL,
  XTU_TRANSFER_FEE_BPS,
  calculateXtuWithdrawalQuote,
  validateWithdrawalRequestAmount,
  formatTokenRaw,
};
