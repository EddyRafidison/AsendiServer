"use strict";

const BigNumber = require("bignumber.js");

const XTU_DECIMALS = 18;
const XTU_TRANSFER_FEE_BPS = 0;
const XTU_SCALE = new BigNumber(10).pow(XTU_DECIMALS);

function amount(value, name, allowZero = false) {
  const result = new BigNumber(String(value));
  if (!result.isFinite() || (allowZero ? result.isNegative() : !result.isGreaterThan(0))) {
    throw new RangeError(`${name} must be ${allowZero ? "finite and non-negative" : "finite and positive"}.`);
  }
  return result;
}

function toRaw(value) {
  const raw = amount(value, "XTU refund transfer amount")
    .multipliedBy(XTU_SCALE)
    .integerValue(BigNumber.ROUND_DOWN);
  if (!raw.isInteger() || !raw.isGreaterThan(0)) {
    throw new RangeError("XTU refund transfer amount is below token precision.");
  }
  return BigInt(raw.toFixed(0));
}

/**
 * The refundable base is the exact net XTU amount initially received by the
 * Hot Wallet. The estimated BNB gas cost is deducted at the internal 1:1
 * accounting parity. The XTU token contract has no outbound transfer fee.
 * Actual BNB gas is reconciled from the receipt after confirmation.
 */
function calculateXtuUnknownRefundQuote({
  hotWalletReceivedAmount,
  estimatedGasFeeBscUsd,
  minimumRefundNet = "1",
}) {
  const baseAmount = amount(hotWalletReceivedAmount, "Hot Wallet received XTU amount");
  const gasEquivalentXtu = amount(estimatedGasFeeBscUsd, "Estimated BNB gas equivalent", true);
  const minimumNet = amount(minimumRefundNet, "Minimum refundable net XTU", true);
  if (gasEquivalentXtu.gte(baseAmount)) {
    throw new RangeError("Estimated gas consumes the complete refundable XTU base.");
  }

  const grossTransferAmount = baseAmount.minus(gasEquivalentXtu).decimalPlaces(XTU_DECIMALS, BigNumber.ROUND_DOWN);
  const grossRaw = toRaw(grossTransferAmount);
  const feeRaw = (grossRaw * BigInt(XTU_TRANSFER_FEE_BPS)) / 10_000n;
  const netRaw = grossRaw - feeRaw;
  if (netRaw <= 0n) throw new RangeError("The XTU refund contract fee consumes the transfer amount.");

  const normalizedGross = new BigNumber(grossRaw.toString()).dividedBy(XTU_SCALE);
  const contractFeeAmount = new BigNumber(feeRaw.toString()).dividedBy(XTU_SCALE);
  const netAmount = new BigNumber(netRaw.toString()).dividedBy(XTU_SCALE);
  if (netAmount.lt(minimumNet)) {
    const error = new RangeError(`The estimated XTU refund net ${netAmount.toFixed(18)} is below the configured minimum ${minimumNet.toFixed(18)}.`);
    error.code = "XTU_REFUND_BELOW_MINIMUM";
    throw error;
  }

  return {
    baseReceivedAmount: baseAmount,
    gasEquivalentXtu,
    grossTransferAmount: normalizedGross,
    contractFeeAmount,
    netAmount,
    amountRaw: grossRaw.toString(),
    feeRaw: feeRaw.toString(),
    netRaw: netRaw.toString(),
    minimumRefundNet: minimumNet,
    transferFeeBps: XTU_TRANSFER_FEE_BPS,
  };
}

module.exports = {
  XTU_DECIMALS,
  XTU_TRANSFER_FEE_BPS,
  calculateXtuUnknownRefundQuote,
};
