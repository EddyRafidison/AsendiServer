"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  DEFAULT_WELCOME_BONUS_BENEFICIARIES,
  resolveWelcomeBonusBeneficiaries,
  resolveWelcomeBonusAmount,
  createWelcomeBonusSubjectHashes,
  decideWelcomeBonus,
} = require("../welcome-bonus-policy");

test("welcome beneficiary count defaults to 1000 and zero disables the group", () => {
  assert.equal(DEFAULT_WELCOME_BONUS_BENEFICIARIES, 1000);
  assert.equal(resolveWelcomeBonusBeneficiaries(undefined), 1000);
  assert.equal(resolveWelcomeBonusBeneficiaries("0"), 0);
  assert.equal(resolveWelcomeBonusBeneficiaries("1250"), 1250);
  assert.throws(() => resolveWelcomeBonusBeneficiaries("1.5"), /integer/);
});

test("welcome amount defaults to zero and validates the configured XTU amount", () => {
  assert.equal(resolveWelcomeBonusAmount(undefined).toFixed(), "0");
  assert.equal(resolveWelcomeBonusAmount("2.5").toFixed(), "2.5");
  assert.throws(() => resolveWelcomeBonusAmount("-1"), /decimal/);
  assert.throws(() => resolveWelcomeBonusAmount("301"), /between/);
});

test("only the first configured accounts can receive a one-time welcome credit", () => {
  assert.equal(decideWelcomeBonus({ registrationSequence: 1, beneficiaryLimit: 1000, amountXtu: 2 }).shouldCredit, true);
  assert.equal(decideWelcomeBonus({ registrationSequence: 1000, beneficiaryLimit: 1000, amountXtu: 2 }).shouldCredit, true);
  assert.equal(decideWelcomeBonus({ registrationSequence: 1001, beneficiaryLimit: 1000, amountXtu: 2 }).status, "not_eligible");
  assert.equal(decideWelcomeBonus({ registrationSequence: 1, beneficiaryLimit: 0, amountXtu: 2 }).status, "disabled");
  assert.equal(decideWelcomeBonus({ registrationSequence: 1, beneficiaryLimit: 1000, amountXtu: 0 }).status, "disabled");
  assert.equal(decideWelcomeBonus({ registrationSequence: 1, currentStatus: "credited", beneficiaryLimit: 1000, amountXtu: 2 }).reason, "already_decided");
});

test("pseudonymous claim hashes normalize the same email and identity input", () => {
  const first = createWelcomeBonusSubjectHashes({
    email: " Person@Example.com ",
    identityType: "NATIONAL_ID",
    nationality: "MG",
    identityNumber: "AB 123 456",
    secret: "a-stable-test-secret-that-is-long-enough-for-hmac",
  });
  const second = createWelcomeBonusSubjectHashes({
    email: "person@example.com",
    identityType: "national_id",
    nationality: "mg",
    identityNumber: "ab123456",
    secret: "a-stable-test-secret-that-is-long-enough-for-hmac",
  });
  assert.deepEqual(first, second);
  assert.match(first.emailHash, /^[0-9a-f]{64}$/);
  assert.match(first.identityHash, /^[0-9a-f]{64}$/);
});
