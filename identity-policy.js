"use strict";

const regionNames = new Intl.DisplayNames(["en"], { type: "region" });
const NON_COUNTRY_REGION_CODES = new Set(["EU", "EZ", "UN", "XA", "XB"]);
const IDENTITY_TYPES = new Set(["NATIONAL_ID", "PASSPORT"]);

function normalizeCountryCode(value) {
  if (typeof value !== "string") return null;
  const code = value.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(code) || NON_COUNTRY_REGION_CODES.has(code)) return null;

  let displayName;
  try {
    displayName = regionNames.of(code);
  } catch {
    return null;
  }

  if (!displayName || displayName === code || displayName === "Unknown Region") return null;
  return code;
}

function normalizeNationality(value) {
  return normalizeCountryCode(value);
}

function normalizeIdentityType(value) {
  if (typeof value !== "string") return null;
  const type = value.trim().toUpperCase();
  if (type === "CNI") return "NATIONAL_ID";
  return IDENTITY_TYPES.has(type) ? type : null;
}

function getRequiredIdentityType(nationality, residenceCountry) {
  const normalizedNationality = normalizeNationality(nationality);
  const normalizedResidenceCountry = normalizeCountryCode(residenceCountry);
  if (!normalizedNationality || !normalizedResidenceCountry) return null;

  // A person living outside their country of nationality must provide a passport.
  // A national resident may use a national identity card or a passport.
  return normalizedNationality !== normalizedResidenceCountry ? "PASSPORT" : null;
}

function validateSignupIdentity({ nationality, residenceCountry, identityType, identityNumber }) {
  const normalizedNationality = normalizeNationality(nationality);
  if (!normalizedNationality) {
    return { error: "invalid nationality" };
  }

  const normalizedResidenceCountry = normalizeCountryCode(residenceCountry);
  if (!normalizedResidenceCountry) {
    return { error: "invalid residence country" };
  }

  const requiredType = getRequiredIdentityType(normalizedNationality, normalizedResidenceCountry);
  const hasIdentityType = typeof identityType === "string" && identityType.trim().length > 0;
  const normalizedType = hasIdentityType
    ? normalizeIdentityType(identityType)
    : (requiredType || "NATIONAL_ID");

  if (!normalizedType) {
    return { error: "invalid identity document type" };
  }
  if (requiredType && normalizedType !== requiredType) {
    return { error: "passport required for foreign residents" };
  }

  if (typeof identityNumber !== "string") {
    return { error: "invalid identity document number" };
  }
  const normalizedNumber = identityNumber.trim();
  if (!normalizedNumber || Buffer.byteLength(normalizedNumber, "utf8") > 128) {
    return { error: "invalid identity document number" };
  }

  return {
    nationality: normalizedNationality,
    residenceCountry: normalizedResidenceCountry,
    identityType: normalizedType,
    identityNumber: normalizedNumber,
  };
}

module.exports = {
  normalizeCountryCode,
  normalizeNationality,
  normalizeIdentityType,
  getRequiredIdentityType,
  validateSignupIdentity,
};
