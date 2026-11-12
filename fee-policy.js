"use strict";

const BigNumber = require("bignumber.js");

const COMMON_SHARE_RATIO = new BigNumber(process.env.COMMON_SHARE_RATIO || "0.50");
const BSC_FEE_RECHARGE_DEFAULT_USD = new BigNumber(
  process.env.RECHARGE_BSC_FEE_RECOVERY_USD || "0.1",
);

if (
  !COMMON_SHARE_RATIO.isFinite() || COMMON_SHARE_RATIO.isNegative() ||
  COMMON_SHARE_RATIO.isGreaterThan(1)
) {
  throw new Error("COMMON_SHARE_RATIO must be between 0 and 1.");
}
if (!BSC_FEE_RECHARGE_DEFAULT_USD.isFinite() || BSC_FEE_RECHARGE_DEFAULT_USD.isNegative()) {
  throw new Error("RECHARGE_BSC_FEE_RECOVERY_USD must be finite and non-negative.");
}

module.exports = {
  COMMON_SHARE_RATIO,
  BSC_FEE_RECHARGE_DEFAULT_USD,
};
