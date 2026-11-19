"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  calculateAvailableRechargeReserveXtu,
  createRechargeAvailabilityCache,
} = require("../recharge-availability");

function baseInput(overrides = {}) {
  return {
    totalUnitsPrice: "17700000",
    unitPrice: "1",
    backedUnits: "17700000",
    inactiveInitialAsset: "100",
    sysInactiveInitialAsset: "300000",
    totalSellerReserve: "25",
    activeSellerInitialAsset: "20",
    pendingDisbursementInitialAsset: "200",
    stockLimit: "18000000",
    adminReserveRatio: "0.10",
    ...overrides,
  };
}

test("available recharge reserve excludes the remaining administrative quota and pending disbursements", () => {
  const result = calculateAvailableRechargeReserveXtu(baseInput());
  // 17.7m backed - 1.5m remaining admin reserve + 100 inactive - 200 pending + 20 seller.
  assert.equal(result.availableReserveXtu.toFixed(18), "16199920.000000000000000000");
  assert.equal(result.remainingAdministrativeInitialAsset.toFixed(0), "1500000");
  assert.equal(result.availableSellerInitialAsset.toFixed(0), "20");
});

test("administrative expenditure is not subtracted twice from the public reserve", () => {
  const spent = calculateAvailableRechargeReserveXtu(baseInput({
    totalUnitsPrice: "17700000",
    backedUnits: "17700000",
    unitPrice: "1",
    sysInactiveInitialAsset: "300000",
    inactiveInitialAsset: "0",
    activeSellerInitialAsset: "0",
    totalSellerReserve: "0",
    pendingDisbursementInitialAsset: "0",
  }));
  const unspent = calculateAvailableRechargeReserveXtu(baseInput({
    totalUnitsPrice: "18000000",
    backedUnits: "18000000",
    unitPrice: "1",
    sysInactiveInitialAsset: "0",
    inactiveInitialAsset: "0",
    activeSellerInitialAsset: "0",
    totalSellerReserve: "0",
    pendingDisbursementInitialAsset: "0",
  }));
  assert.equal(spent.availableReserveXtu.toFixed(0), "16200000");
  assert.equal(unspent.availableReserveXtu.toFixed(0), "16200000");
});

test("seller reserve remains available when pending system disbursements exceed system reserves", () => {
  const result = calculateAvailableRechargeReserveXtu(baseInput({
    backedUnits: "1800000",
    totalUnitsPrice: "1800000",
    unitPrice: "1",
    sysInactiveInitialAsset: "0",
    inactiveInitialAsset: "100",
    totalSellerReserve: "40",
    activeSellerInitialAsset: "40",
    pendingDisbursementInitialAsset: "2000000",
  }));
  assert.equal(result.availableReserveXtu.toFixed(0), "40");
});

test("rejects active seller lots exceeding the seller-reserve ledger", () => {
  assert.throws(() => calculateAvailableRechargeReserveXtu(baseInput({
    totalSellerReserve: "10",
    activeSellerInitialAsset: "11",
  })), /exceed common\.sellers_res/);
});

test("rejects inconsistent global price and invalid reserve values", () => {
  assert.throws(() => calculateAvailableRechargeReserveXtu(baseInput({ unitPrice: "2" })), /inconsistent/);
  assert.throws(() => calculateAvailableRechargeReserveXtu(baseInput({ inactiveInitialAsset: "-1" })), /non-negative/);
});

test("availability cache coalesces concurrent reads and reuses a one-second snapshot", async () => {
  let now = 1000;
  let queryCount = 0;
  const cache = createRechargeAvailabilityCache({ ttlMs: 1000, now: () => now });
  const db = {
    async queryAsync() {
      queryCount += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return [{
        total_units_price: "18000000",
        unit_price: "1",
        backed_units: "18000000",
        inactive_init_asset: "0",
        sys_inactive_init_asset: "0",
        sellers_res: "10",
        active_seller_initial_asset: "10",
        pending_disbursement_initial_asset: "0",
      }];
    },
  };
  const options = { stockLimit: "18000000", adminReserveRatio: "0.10" };

  const [first, simultaneous] = await Promise.all([
    cache.get(db, options),
    cache.get(db, options),
  ]);
  assert.equal(queryCount, 1);
  assert.equal(first.availableReserveXtu, "16200010.000000000000000000");
  assert.deepEqual(Object.keys(first), ["availableReserveXtu"]);
  assert.equal(first, simultaneous);

  now = 1500;
  const cached = await cache.get(db, options);
  assert.equal(queryCount, 1);
  assert.equal(cached, first);

  now = 2100;
  const refreshed = await cache.get(db, options);
  assert.equal(queryCount, 2);
  assert.notEqual(refreshed, first);
});

test("public reserve calculation does not depend on recharge suspension, provider status or tfees", async () => {
  const cache = createRechargeAvailabilityCache({ ttlMs: 1000 });
  let queryCount = 0;
  const db = {
    async queryAsync(sql) {
      queryCount += 1;
      assert.doesNotMatch(sql, /global_disbursement_runs|recharge_service_control/);
      return [{
        total_units_price: "18000000",
        unit_price: "1",
        backed_units: "18000000",
        inactive_init_asset: "0",
        sys_inactive_init_asset: "0",
        sellers_res: "0",
        active_seller_initial_asset: "0",
        pending_disbursement_initial_asset: "0",
      }];
    },
  };
  const result = await cache.get(db, {
    stockLimit: "18000000",
    adminReserveRatio: "0.10",
  });
  assert.equal(result.availableReserveXtu, "16200000.000000000000000000");
  assert.deepEqual(Object.keys(result), ["availableReserveXtu"]);
  assert.equal(queryCount, 1);
});
