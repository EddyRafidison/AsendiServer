"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { resolveRechargeAvailability, getVisibleDepositAddress } = require("../recharge-service-control");

test("global disbursement hides deposit addresses before other availability reasons", () => {
  const availability = resolveRechargeAvailability({
    globalDisbursementActive: true,
    manuallySuspended: true,
    capacityAllowed: false,
  });
  assert.deepEqual(availability, { allowed: false, reason: "global_disbursement_active" });
});

test("manual recharge suspension hides an existing deposit address without deleting it", () => {
  const availability = resolveRechargeAvailability({ manuallySuspended: true });
  const previouslyAssignedAddress = "0x1111111111111111111111111111111111111111";
  assert.equal(getVisibleDepositAddress(availability, previouslyAssignedAddress), null);
  assert.equal(previouslyAssignedAddress, "0x1111111111111111111111111111111111111111");
});

test("a disabled BSC recharge provider hides the existing deposit address", () => {
  const availability = resolveRechargeAvailability({ paymentServiceEnabled: false });
  assert.equal(availability.allowed, false);
  assert.equal(availability.reason, "payment_service_disabled");
  assert.equal(getVisibleDepositAddress(availability, "0x1111111111111111111111111111111111111111"), null);
});

test("maximum-stock capacity hides an existing deposit address", () => {
  const availability = resolveRechargeAvailability({ capacityAllowed: false });
  assert.equal(availability.reason, "maximum_user_balance");
  assert.equal(getVisibleDepositAddress(availability, "0x1111111111111111111111111111111111111111"), null);
});

test("available recharge exposes the existing address", () => {
  const availability = resolveRechargeAvailability({ capacityAllowed: true });
  const address = "0x1111111111111111111111111111111111111111";
  assert.equal(getVisibleDepositAddress(availability, address), address);
});

test("missing address remains hidden even when recharge is available", () => {
  const availability = resolveRechargeAvailability({ capacityAllowed: true });
  assert.equal(getVisibleDepositAddress(availability, null), null);
});
