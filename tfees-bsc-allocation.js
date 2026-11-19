"use strict";

const BigNumber = require("bignumber.js");

/**
 * Allocate confirmed BSC network costs against the gross transaction-fee
 * amount. Any cost above the available tfees is absorbed by OneX and must not
 * be charged as an additional user deduction.
 */
function allocateBscCostFromTfees(grossTfeesBscUsdValue, actualBscCostUsdValue) {
  const grossTfees = new BigNumber(grossTfeesBscUsdValue);
  const actualBscCost = new BigNumber(actualBscCostUsdValue);
  if (!grossTfees.isFinite() || grossTfees.isNegative()) {
    throw new RangeError("Gross tfees must be finite and non-negative");
  }
  if (!actualBscCost.isFinite() || actualBscCost.isNegative()) {
    throw new RangeError("Actual BSC cost must be finite and non-negative");
  }
  const coveredBscCost = BigNumber.minimum(grossTfees, actualBscCost);
  const uncoveredBscCost = BigNumber.maximum(0, actualBscCost.minus(coveredBscCost));
  const retainedTfees = grossTfees.minus(coveredBscCost);
  return { grossTfees, actualBscCost, coveredBscCost, uncoveredBscCost, retainedTfees };
}

module.exports = { allocateBscCostFromTfees };
