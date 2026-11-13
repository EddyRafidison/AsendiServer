"use strict";

const BigNumber = require("bignumber.js");

// Administrative rewards are accounted in BSC-USD, not in initial-asset units.
const ADMIN_FEES_THRESHOLD_USD = new BigNumber(
  process.env.ADMIN_FEES_THRESHOLD_USD || "100",
);
const ADMIN_FEES_RETAINED_BALANCE_USD = new BigNumber(
  process.env.ADMIN_FEES_RETAINED_BALANCE_USD || "10",
);
const TOKEN_DECIMALS = 18;

function getAdminFeesTransferConfig() {
  const payoutAddress = String(process.env.ADMIN_FEES_PAYOUT_ADDRESS || "").trim();
  const transfersEnabled = String(process.env.ADMIN_FEES_TRANSFERS_ENABLED || "false").toLowerCase() === "true";
  const validThreshold = ADMIN_FEES_THRESHOLD_USD.isFinite() && ADMIN_FEES_THRESHOLD_USD.isGreaterThan(0);
  const validRetainedBalance =
    ADMIN_FEES_RETAINED_BALANCE_USD.isFinite() &&
    ADMIN_FEES_RETAINED_BALANCE_USD.isGreaterThanOrEqualTo(0) &&
    ADMIN_FEES_RETAINED_BALANCE_USD.isLessThan(ADMIN_FEES_THRESHOLD_USD);
  const validAddress = /^0x[a-fA-F0-9]{40}$/.test(payoutAddress);

  return {
    enabled: transfersEnabled && validThreshold && validRetainedBalance && validAddress,
    threshold: ADMIN_FEES_THRESHOLD_USD,
    retainedBalance: ADMIN_FEES_RETAINED_BALANCE_USD,
    payoutAddress,
    reason: !transfersEnabled
      ? "ADMIN_FEES_TRANSFERS_ENABLED is false"
      : !validThreshold
        ? "ADMIN_FEES_THRESHOLD_USD must be greater than zero"
        : !validRetainedBalance
          ? "ADMIN_FEES_RETAINED_BALANCE_USD must be non-negative and lower than the threshold"
          : !validAddress
            ? "ADMIN_FEES_PAYOUT_ADDRESS must be a valid EVM address"
            : null,
  };
}

function calculateAdminFeesTransfer(remainingValue, thresholdValue, retainedValue) {
  const remaining = new BigNumber(remainingValue);
  const threshold = new BigNumber(thresholdValue);
  const retained = new BigNumber(retainedValue);

  if (
    !remaining.isFinite() || remaining.isNegative() ||
    !threshold.isFinite() || !threshold.isGreaterThan(0) ||
    !retained.isFinite() || retained.isNegative() ||
    !retained.isLessThan(threshold)
  ) {
    return null;
  }
  if (remaining.isLessThan(threshold)) return null;

  const amount = remaining
    .minus(retained)
    .decimalPlaces(TOKEN_DECIMALS, BigNumber.ROUND_DOWN);
  const amountRaw = amount.shiftedBy(TOKEN_DECIMALS).integerValue(BigNumber.ROUND_DOWN);
  if (!amount.isGreaterThan(0) || !amountRaw.isInteger() || !amountRaw.isGreaterThan(0)) {
    return null;
  }

  return {
    amount,
    amountRaw: amountRaw.toFixed(0),
    remainingAfterQueue: remaining.minus(amount),
  };
}

module.exports = {
  ADMIN_FEES_THRESHOLD_USD,
  ADMIN_FEES_RETAINED_BALANCE_USD,
  TOKEN_DECIMALS,
  getAdminFeesTransferConfig,
  calculateAdminFeesTransfer,
};
