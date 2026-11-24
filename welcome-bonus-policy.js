"use strict";

const BigNumber = require("bignumber.js");
const crypto = require("crypto");
const { MAX_DEFAULT_STOCK } = require("./deposit-policy");

const DEFAULT_WELCOME_BONUS_BENEFICIARIES = 1000;
const MAX_WELCOME_BONUS_BENEFICIARIES = 1_000_000;

function resolveWelcomeBonusBeneficiaries(value) {
  if (value == null || String(value).trim() === "") {
    return DEFAULT_WELCOME_BONUS_BENEFICIARIES;
  }
  const normalized = String(value).trim();
  if (!/^\d{1,7}$/.test(normalized)) {
    throw new RangeError("WELCOME_BONUS_BENEFICIARIES must be an integer between 0 and 1000000");
  }
  const count = Number(normalized);
  if (!Number.isSafeInteger(count) || count < 0 || count > MAX_WELCOME_BONUS_BENEFICIARIES) {
    throw new RangeError("WELCOME_BONUS_BENEFICIARIES must be an integer between 0 and 1000000");
  }
  return count;
}

function resolveWelcomeBonusAmount(value) {
  const normalized = value == null || String(value).trim() === ""
    ? "0"
    : String(value).trim();
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,18})?$/.test(normalized)) {
    throw new RangeError("WELCOME_BONUS_AMOUNT_XTU must be a non-negative decimal with at most 18 decimal places");
  }
  const amount = new BigNumber(normalized);
  if (!amount.isFinite() || amount.isNegative() || amount.gt(MAX_DEFAULT_STOCK)) {
    throw new RangeError(`WELCOME_BONUS_AMOUNT_XTU must be between 0 and ${MAX_DEFAULT_STOCK} XTU`);
  }
  return amount;
}


function createWelcomeBonusSubjectHashes({ email, identityType, nationality, identityNumber, secret }) {
  const normalizedEmail = String(email || "").trim().toLowerCase();
  const normalizedIdentity = String(identityNumber || "").trim().toUpperCase().replace(/\s+/g, "");
  const normalizedType = String(identityType || "").trim().toUpperCase();
  const normalizedNationality = String(nationality || "").trim().toUpperCase();
  const key = String(secret || "");
  if (!normalizedEmail || !normalizedIdentity || !normalizedType || !normalizedNationality || !key) {
    throw new TypeError("Welcome-bonus lifetime identifiers and a stable secret are required");
  }
  const emailHash = crypto.createHmac("sha256", key)
    .update(`email:${normalizedEmail}`, "utf8")
    .digest("hex");
  const identityHash = crypto.createHmac("sha256", key)
    .update(`identity:${normalizedNationality}:${normalizedType}:${normalizedIdentity}`, "utf8")
    .digest("hex");
  return { emailHash, identityHash };
}

function decideWelcomeBonus({
  registrationSequence,
  currentStatus = "pending",
  beneficiaryLimit = DEFAULT_WELCOME_BONUS_BENEFICIARIES,
  amountXtu = 0,
}) {
  if (currentStatus !== "pending") {
    return { status: currentStatus, shouldCredit: false, reason: "already_decided" };
  }

  const sequence = Number(registrationSequence);
  const limit = Number(beneficiaryLimit);
  const amount = new BigNumber(amountXtu);
  if (!Number.isSafeInteger(sequence) || sequence < 1) throw new RangeError("A valid registration sequence is required");
  if (!Number.isSafeInteger(limit) || limit < 0 || limit > MAX_WELCOME_BONUS_BENEFICIARIES) {
    throw new RangeError("The welcome-bonus beneficiary limit is invalid");
  }
  if (!amount.isFinite() || amount.isNegative()) throw new RangeError("The welcome-bonus amount is invalid");

  if (limit === 0 || amount.isZero()) {
    return { status: "disabled", shouldCredit: false, reason: "promotion_disabled" };
  }
  if (sequence > limit) {
    return { status: "not_eligible", shouldCredit: false, reason: "outside_first_beneficiaries" };
  }
  return { status: "pending", shouldCredit: true, reason: "eligible" };
}

module.exports = {
  DEFAULT_WELCOME_BONUS_BENEFICIARIES,
  MAX_WELCOME_BONUS_BENEFICIARIES,
  resolveWelcomeBonusBeneficiaries,
  resolveWelcomeBonusAmount,
  createWelcomeBonusSubjectHashes,
  decideWelcomeBonus,
};
