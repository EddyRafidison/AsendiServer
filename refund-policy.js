"use strict";

const BigNumber = require("bignumber.js");
const { getMinimumOutgoingNetBscUsd } = require("./outgoing-payout-policy");

function resolveMinimumRefundNetBscUsd(maximumFeeValue) {
  return getMinimumOutgoingNetBscUsd(maximumFeeValue);
}

const MINIMUM_REFUND_NET_BSC_USD = resolveMinimumRefundNetBscUsd();

function isRefundNetAmountAllowed(value) {
  if (value == null || value === "") return false;
  const amount = new BigNumber(value);
  return amount.isFinite() && amount.isGreaterThanOrEqualTo(MINIMUM_REFUND_NET_BSC_USD);
}

module.exports = {
  MINIMUM_REFUND_NET_BSC_USD,
  resolveMinimumRefundNetBscUsd,
  isRefundNetAmountAllowed,
};
