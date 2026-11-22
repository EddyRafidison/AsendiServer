"use strict";

const BigNumber = require("bignumber.js");
const { getConfiguredMaxBscTxFeeUsd } = require("./bsc-transaction-policy");

const MINIMUM_NET_PAYOUT_MULTIPLIER = new BigNumber("2");

function resolveMaximumFee(value) {
  const maximumFee = value === undefined
    ? getConfiguredMaxBscTxFeeUsd()
    : new BigNumber(value);
  if (!maximumFee.isFinite() || maximumFee.isNegative() || maximumFee.isGreaterThan("0.4")) {
    throw new RangeError("Maximum BSC transaction fee must be between 0 and 0.4 BSC-USD.");
  }
  return maximumFee;
}

function getMinimumOutgoingNetBscUsd(maximumFeeValue) {
  return resolveMaximumFee(maximumFeeValue).multipliedBy(MINIMUM_NET_PAYOUT_MULTIPLIER);
}

function getMinimumOutgoingGrossBscUsd(maximumFeeValue) {
  const maximumFee = resolveMaximumFee(maximumFeeValue);
  return getMinimumOutgoingNetBscUsd(maximumFee).plus(maximumFee);
}

module.exports = {
  MINIMUM_NET_PAYOUT_MULTIPLIER,
  getMinimumOutgoingNetBscUsd,
  getMinimumOutgoingGrossBscUsd,
};
