"use strict";

require("dotenv").config();
const BigNumber = require("bignumber.js");

const DEPOSIT_MIN_AMOUNT = String(process.env.DEPOSIT_MIN_AMOUNT || "20").trim();
const DEPOSIT_MAX_AMOUNT = String(process.env.DEPOSIT_MAX_AMOUNT || "100").trim();
const minimum = new BigNumber(DEPOSIT_MIN_AMOUNT);
const maximum = new BigNumber(DEPOSIT_MAX_AMOUNT);

if (
  !minimum.isFinite() || !minimum.isGreaterThan(0) ||
  !maximum.isFinite() || !maximum.isGreaterThanOrEqualTo(minimum) ||
  minimum.decimalPlaces() > 18 || maximum.decimalPlaces() > 18
) {
  throw new RangeError("DEPOSIT_MIN_AMOUNT and DEPOSIT_MAX_AMOUNT must be finite positive amounts with at most 18 decimal places and maximum >= minimum.");
}

module.exports = Object.freeze({
  DEPOSIT_MIN_AMOUNT,
  DEPOSIT_MAX_AMOUNT,
});
