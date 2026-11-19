"use strict";

function resolveRechargeAvailability({
  globalDisbursementActive = false,
  manuallySuspended = false,
  paymentServiceEnabled = true,
  capacityAllowed = true,
}) {
  if (globalDisbursementActive) {
    return { allowed: false, reason: "global_disbursement_active" };
  }
  if (manuallySuspended) {
    return { allowed: false, reason: "recharge_manually_suspended" };
  }
  if (!paymentServiceEnabled) {
    return { allowed: false, reason: "payment_service_disabled" };
  }
  if (!capacityAllowed) {
    return { allowed: false, reason: "maximum_user_balance" };
  }
  return { allowed: true, reason: null };
}

// Hiding an address never deletes or changes its persisted deposit wallet.
function getVisibleDepositAddress(availability, storedAddress) {
  if (!availability || availability.allowed !== true || !storedAddress) return null;
  return storedAddress;
}

module.exports = { resolveRechargeAvailability, getVisibleDepositAddress };
