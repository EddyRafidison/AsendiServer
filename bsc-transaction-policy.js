"use strict";

const BigNumber = require("bignumber.js");

const DEFAULT_MAX_BSC_TX_FEE_USD = "0.4";
const ABSOLUTE_MAX_BSC_TX_FEE_USD = new BigNumber("0.4");

function getConfiguredMaxBscTxFeeUsd(value = process.env.BSC_MAX_TX_FEE_BSC_USD) {
  const configured = value == null || String(value).trim() === ""
    ? DEFAULT_MAX_BSC_TX_FEE_USD
    : String(value).trim();
  const maximum = new BigNumber(configured);
  if (!maximum.isFinite() || maximum.isNegative() || maximum.isGreaterThan(ABSOLUTE_MAX_BSC_TX_FEE_USD)) {
    throw new RangeError("BSC_MAX_TX_FEE_BSC_USD must be between 0 and 0.4 BSC-USD.");
  }
  return maximum;
}

function evaluateBscTxFee(estimatedFeeUsd, maximumFeeUsd = getConfiguredMaxBscTxFeeUsd()) {
  const estimated = new BigNumber(estimatedFeeUsd);
  const maximum = new BigNumber(maximumFeeUsd);
  if (!estimated.isFinite() || estimated.isNegative()) {
    throw new RangeError("The estimated BSC transaction fee must be finite and non-negative.");
  }
  if (!maximum.isFinite() || maximum.isNegative() || maximum.isGreaterThan(ABSOLUTE_MAX_BSC_TX_FEE_USD)) {
    throw new RangeError("The maximum BSC transaction fee must be between 0 and 0.4 BSC-USD.");
  }
  return {
    allowed: estimated.isLessThanOrEqualTo(maximum),
    estimatedFeeUsd: estimated,
    maximumFeeUsd: maximum,
    excessFeeUsd: BigNumber.maximum(0, estimated.minus(maximum)),
  };
}

function createBscFeeLimitError(estimatedFeeUsd, maximumFeeUsd = getConfiguredMaxBscTxFeeUsd()) {
  const decision = evaluateBscTxFee(estimatedFeeUsd, maximumFeeUsd);
  const error = new Error(
    `Waiting for BSC gas: estimated fee ${decision.estimatedFeeUsd.toFixed(8)} BSC-USD exceeds the configured maximum ${decision.maximumFeeUsd.toFixed(8)} BSC-USD.`,
  );
  error.code = "BSC_GAS_FEE_LIMIT_EXCEEDED";
  error.estimatedFeeUsd = decision.estimatedFeeUsd.toFixed(18);
  error.maximumFeeUsd = decision.maximumFeeUsd.toFixed(18);
  return error;
}

module.exports = {
  DEFAULT_MAX_BSC_TX_FEE_USD,
  ABSOLUTE_MAX_BSC_TX_FEE_USD,
  getConfiguredMaxBscTxFeeUsd,
  evaluateBscTxFee,
  createBscFeeLimitError,
};
