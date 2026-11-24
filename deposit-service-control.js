"use strict";

function resolveDepositAvailability({
  globalDisbursementActive = false,
  manuallySuspended = false,
  paymentServiceEnabled = true,
  capacityAllowed = true,
}) {
  if (globalDisbursementActive) {
    return { allowed: false, reason: "global_disbursement_active" };
  }
  if (manuallySuspended) {
    return { allowed: false, reason: "deposit_manually_suspended" };
  }
  if (!paymentServiceEnabled) {
    return { allowed: false, reason: "payment_service_disabled" };
  }
  if (!capacityAllowed) {
    return { allowed: false, reason: "maximum_user_balance" };
  }
  return { allowed: true, reason: null };
}

// Hiding deposit availability never changes the shared treasury address configured by the server.
function getVisibleDepositAddress(availability, storedAddress) {
  if (!availability || availability.allowed !== true || !storedAddress) return null;
  return storedAddress;
}

module.exports = { resolveDepositAvailability, getVisibleDepositAddress };
