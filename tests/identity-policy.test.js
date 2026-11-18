"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  normalizeCountryCode,
  normalizeNationality,
  normalizeIdentityType,
  getRequiredIdentityType,
  validateSignupIdentity,
} = require("../identity-policy");

test("nationality and residence country are normalized as supported ISO alpha-2 codes", () => {
  assert.equal(normalizeCountryCode(" mg "), "MG");
  assert.equal(normalizeNationality("fr"), "FR");
  assert.equal(normalizeCountryCode("XX"), null);
  assert.equal(normalizeCountryCode("EU"), null);
  assert.equal(normalizeCountryCode("Madagascar"), null);
});

test("national identity cards are accepted for residents of their country of nationality", () => {
  assert.equal(getRequiredIdentityType("MG", "MG"), null);
  assert.equal(getRequiredIdentityType("FR", "FR"), null);
  assert.deepEqual(
    validateSignupIdentity({
      nationality: "FR",
      residenceCountry: "FR",
      identityType: "NATIONAL_ID",
      identityNumber: "FR-ID-12345",
    }),
    {
      nationality: "FR",
      residenceCountry: "FR",
      identityType: "NATIONAL_ID",
      identityNumber: "FR-ID-12345",
    },
  );
  assert.deepEqual(
    validateSignupIdentity({
      nationality: "MG",
      residenceCountry: "MG",
      identityType: "CNI",
      identityNumber: "123456789012",
    }),
    {
      nationality: "MG",
      residenceCountry: "MG",
      identityType: "NATIONAL_ID",
      identityNumber: "123456789012",
    },
  );
});

test("a national resident may use a passport when that is the available identity document", () => {
  assert.deepEqual(
    validateSignupIdentity({
      nationality: "NG",
      residenceCountry: "NG",
      identityType: "PASSPORT",
      identityNumber: "A12345678",
    }),
    {
      nationality: "NG",
      residenceCountry: "NG",
      identityType: "PASSPORT",
      identityNumber: "A12345678",
    },
  );
});

test("a foreign resident must submit a passport, regardless of IP geolocation", () => {
  assert.equal(getRequiredIdentityType("FR", "MG"), "PASSPORT");
  assert.deepEqual(
    validateSignupIdentity({
      nationality: "FR",
      residenceCountry: "MG",
      identityType: "PASSPORT",
      identityNumber: "12AB34567",
      ipCountry: "FR",
    }),
    {
      nationality: "FR",
      residenceCountry: "MG",
      identityType: "PASSPORT",
      identityNumber: "12AB34567",
    },
  );
  assert.deepEqual(
    validateSignupIdentity({
      nationality: "US",
      residenceCountry: "MG",
      identityType: "NATIONAL_ID",
      identityNumber: "12345",
    }),
    { error: "passport required for foreign residents" },
  );
  assert.deepEqual(
    validateSignupIdentity({
      nationality: "MG",
      residenceCountry: "FR",
      identityType: "CNI",
      identityNumber: "123456789012",
      ipCountry: "MG",
    }),
    { error: "passport required for foreign residents" },
  );
});

test("identity type aliases and invalid document types are handled explicitly", () => {
  assert.equal(normalizeIdentityType("cni"), "NATIONAL_ID");
  assert.equal(normalizeIdentityType("national_id"), "NATIONAL_ID");
  assert.equal(normalizeIdentityType("passport"), "PASSPORT");
  assert.equal(normalizeIdentityType("driver_license"), null);
});

test("nationality, residence country and identity document number are mandatory and bounded", () => {
  assert.deepEqual(
    validateSignupIdentity({ nationality: "", residenceCountry: "MG", identityType: "PASSPORT", identityNumber: "123" }),
    { error: "invalid nationality" },
  );
  assert.deepEqual(
    validateSignupIdentity({ nationality: "MG", residenceCountry: "", identityType: "NATIONAL_ID", identityNumber: "123" }),
    { error: "invalid residence country" },
  );
  assert.deepEqual(
    validateSignupIdentity({ nationality: "MG", residenceCountry: "MG", identityType: "NATIONAL_ID", identityNumber: " " }),
    { error: "invalid identity document number" },
  );
  assert.deepEqual(
    validateSignupIdentity({ nationality: "MG", residenceCountry: "MG", identityType: "NATIONAL_ID", identityNumber: "x".repeat(129) }),
    { error: "invalid identity document number" },
  );
});
