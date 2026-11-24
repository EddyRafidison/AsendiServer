"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { resolveDepositAvailability, getVisibleDepositAddress } = require("../deposit-service-control");

test("global disbursement hides deposit addresses before other availability reasons", () => {
  const availability = resolveDepositAvailability({
    globalDisbursementActive: true,
    manuallySuspended: true,
    capacityAllowed: false,
  });
  assert.deepEqual(availability, { allowed: false, reason: "global_disbursement_active" });
});

test("manual deposit suspension hides an existing deposit address without deleting it", () => {
  const availability = resolveDepositAvailability({ manuallySuspended: true });
  const previouslyAssignedAddress = "0x1111111111111111111111111111111111111111";
  assert.equal(getVisibleDepositAddress(availability, previouslyAssignedAddress), null);
  assert.equal(previouslyAssignedAddress, "0x1111111111111111111111111111111111111111");
});

test("a disabled BSC deposit provider hides the existing deposit address", () => {
  const availability = resolveDepositAvailability({ paymentServiceEnabled: false });
  assert.equal(availability.allowed, false);
  assert.equal(availability.reason, "payment_service_disabled");
  assert.equal(getVisibleDepositAddress(availability, "0x1111111111111111111111111111111111111111"), null);
});

test("maximum-stock capacity hides an existing deposit address", () => {
  const availability = resolveDepositAvailability({ capacityAllowed: false });
  assert.equal(availability.reason, "maximum_user_balance");
  assert.equal(getVisibleDepositAddress(availability, "0x1111111111111111111111111111111111111111"), null);
});

test("available deposit exposes the existing address", () => {
  const availability = resolveDepositAvailability({ capacityAllowed: true });
  const address = "0x1111111111111111111111111111111111111111";
  assert.equal(getVisibleDepositAddress(availability, address), address);
});

test("missing address remains hidden even when deposit is available", () => {
  const availability = resolveDepositAvailability({ capacityAllowed: true });
  assert.equal(getVisibleDepositAddress(availability, null), null);
});
