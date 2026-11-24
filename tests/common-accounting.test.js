"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { commonSnapshotValues } = require("../common-accounting");

function commonRow(overrides = {}) {
  return {
    total_units_price: "100",
    unit_price: "2",
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
    ...overrides,
  };
}

test("common snapshots never lower the stored global XTU unit price", () => {
  const values = commonSnapshotValues(commonRow(), {
    total_units_price: "90",
    backed_units: "100",
  });
  assert.equal(values.unit_price, "2.000000000000000000000000000000");
});

test("common snapshots raise the global XTU unit price when the reserve ratio rises above its floor", () => {
  const values = commonSnapshotValues(commonRow(), {
    total_units_price: "250",
    backed_units: "100",
  });
  assert.equal(values.unit_price, "2.500000000000000000000000000000");
});

test("common.xtu_wallets is cumulative and remains unchanged unless explicitly increased", () => {
  const values = commonSnapshotValues(commonRow({ xtu_wallets: "12.5" }), {
    total_units_price: "100",
  });
  assert.equal(values.xtu_wallets, "12.5");
});
