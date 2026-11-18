"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  validateSellerJoin,
  allocateSellerLotConsumption,
  sumActiveSellerReserveLots,
  calculateSellerPayoutGrossAtLockedPrice,
  calculateSellerPayoutNet,
  SELLER_STATUS_DURATION_MS,
  SELLER_PAYOUT_BATCH_LIMIT,
} = require("../seller-accounting");

const fixed = (value) => value.toFixed();

test("seller activation requires a reached individual threshold and at least 10 XTU", () => {
  const valid = validateSellerJoin("100", "2", true);
  assert.equal(valid.eligible, true);
  assert.equal(fixed(valid.runBalanceInitial), "100");
  assert.equal(fixed(valid.runBalanceXtu), "200");
  assert.equal(fixed(valid.reservedInitialAsset), "50");
  assert.equal(validateSellerJoin("100", "2", false).reason, "price_threshold_not_reached");
  assert.equal(validateSellerJoin("4", "2", true).reason, "balance_too_low");
});

test("only active seller lots contribute to the available seller reserve in initial assets", () => {
  const available = sumActiveSellerReserveLots([
    { remaining_initial_asset: "12.5" },
    { remaining_initial_asset: "7.5" },
  ]);
  assert.equal(fixed(available), "20");
});

test("seller reserve consumption allocates FIFO amounts directly in initial assets", () => {
  const result = allocateSellerLotConsumption([
    { id: 1, username: "SELLER_A", remaining_initial_asset: "5", unit_price: "1.2" },
    { id: 2, username: "SELLER_B", remaining_initial_asset: "8", unit_price: "1.5" },
  ], "7");
  assert.equal(result.available, true);
  assert.equal(fixed(result.consumedInitialAsset), "7");
  assert.equal(result.allocations.length, 2);
  assert.equal(fixed(result.allocations[0].initialAsset), "5");
  assert.equal(fixed(result.allocations[1].initialAsset), "2");
  assert.equal(fixed(result.allocations[0].unitPrice), "1.2");
  assert.equal(fixed(result.allocations[1].unitPrice), "1.5");
});

test("seller reserve allocation reports insufficiency without inventing initial assets", () => {
  const result = allocateSellerLotConsumption([
    { id: 1, username: "SELLER_A", remaining_initial_asset: "5", unit_price: "1.2" },
  ], "7");
  assert.equal(result.available, false);
  assert.equal(fixed(result.consumedInitialAsset), "5");
  assert.equal(fixed(result.remainingInitialAsset), "2");
});

test("seller payout gross is permanently valued at the price locked at campaign activation", () => {
  assert.equal(fixed(calculateSellerPayoutGrossAtLockedPrice("100", "1.25")), "125");
  assert.equal(fixed(calculateSellerPayoutGrossAtLockedPrice("100", "1.25")), "125");
  assert.notEqual(fixed(calculateSellerPayoutGrossAtLockedPrice("100", "1.8")), "125");
});

test("seller payout deducts only gas recovery and never tfees", () => {
  const result = calculateSellerPayoutNet("300", "0.1");
  assert.equal(fixed(result.grossAmount), "300");
  assert.equal(fixed(result.gasFee), "0.1");
  assert.equal(fixed(result.payoutAmount), "299.9");
  assert.throws(() => calculateSellerPayoutNet("0.1", "0.1"), /gas fee must be lower/);
});

test("seller lifecycle and payout batch limits follow the current policy", () => {
  assert.equal(SELLER_STATUS_DURATION_MS, 7 * 24 * 60 * 60 * 1000);
  assert.equal(fixed(SELLER_PAYOUT_BATCH_LIMIT), "300");
});
