"use strict";

const BigNumber = require("bignumber.js");

// MAJ6 fixes the automatic-refund minimum independently of the gas ceiling.
const MINIMUM_REFUND_NET_BSC_USD = new BigNumber("1");

function resolveMinimumRefundNetBscUsd() {
  return new BigNumber("1");
}

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
