"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  calculateXtuWithdrawalReservation,
  calculateXtuWithdrawalInactiveReserve,
  calculateXtuWithdrawalReversal,
} = require("../xtu-withdrawal-accounting");
const { commonSnapshotValues } = require("../common-accounting");

function fixed(value) {
  return value.toFixed(30);
}

test("XTU withdrawal removes gross principal value at the user's individual price", () => {
  const result = calculateXtuWithdrawalReservation({
    grossAmount: "80",
    individualPrice: "8",
    totalUnitsPrice: "1000",
    backedUnits: "100",
    protectedBackedFloor: "10",
  });
  assert.equal(fixed(result.reservedInitialAsset), fixed("10"));
  assert.equal(fixed(result.reservedXtuValue), fixed("80"));
  assert.equal(fixed(result.newTotalUnitsPrice), fixed("920"));
  assert.equal(fixed(result.newBackedUnits), fixed("90"));
});

test("reserved initial assets become inactive only after successful confirmation", () => {
  const result = calculateXtuWithdrawalReservation({
    grossAmount: "50",
    individualPrice: "5",
    totalUnitsPrice: "1000",
    backedUnits: "100",
    protectedBackedFloor: "10",
  });
  assert.equal(fixed(result.newBackedUnits), fixed("90"));
  assert.equal(fixed(calculateXtuWithdrawalInactiveReserve("12", result.reservedInitialAsset)), fixed("22"));
});

test("a reverted withdrawal restores backing and principal value while charging actual BNB gas", () => {
  const result = calculateXtuWithdrawalReversal({
    totalUnitsPrice: "920",
    backedUnits: "90",
    reservedXtuValue: "80",
    reservedInitialAsset: "10",
    actualGasFeeUsd: "0.15",
  });
  assert.equal(fixed(result.restoredTotalUnitsPrice), fixed("999.85"));
  assert.equal(fixed(result.restoredBackedUnits), fixed("100"));
});

test("reserve updates never lower the absolute global XTU price floor", () => {
  const snapshot = commonSnapshotValues({
    total_units_price: "1000",
    unit_price: "12",
    xtu_wallets: "0",
    backed_units: "100",
    inactive_init_asset: "0",
    sys_inactive_init_asset: "0",
    sellers_res: "0",
    total_run_balance: "0",
    total_tfees: "0",
    total_tfees_bsc_cost_usd: "0",
    total_tfees_bsc_uncovered_usd: "0",
    total_bnb_fee_actual: "0",
    total_bnb_fee_estimated: "0",
    total_bnb_fee_actual_value: "0",
    total_bnb_fee_estimated_value: "0",
  }, {
    total_units_price: "920",
    backed_units: "90",
  });
  assert.equal(snapshot.unit_price, "12.000000000000000000000000000000");
});
