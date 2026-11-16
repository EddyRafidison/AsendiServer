"use strict";

const BigNumber = require("bignumber.js");

// This is an estimate for OneX-paid BSC operations; it is not a transaction-fee split.
const BSC_FEE_RECHARGE_DEFAULT_USD = new BigNumber(
  process.env.RECHARGE_BSC_FEE_RECOVERY_USD || "0.1",
);

if (!BSC_FEE_RECHARGE_DEFAULT_USD.isFinite() || BSC_FEE_RECHARGE_DEFAULT_USD.isNegative()) {
  throw new Error("RECHARGE_BSC_FEE_RECOVERY_USD must be finite and non-negative.");
}

module.exports = {
  BSC_FEE_RECHARGE_DEFAULT_USD,
};
