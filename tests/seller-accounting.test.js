"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const BigNumber = require("bignumber.js");
const {
  validateSellerJoin,
  allocateSellerLotConsumption,
  sumActiveSellerReserveLots,
  calculateSellerPayoutGrossAtLockedPrice,
  calculateSellerPayoutNet,
  buildSellerPayoutBatchGroups,
  SELLER_STATUS_DURATION_MS,
  SELLER_PAYOUT_BATCH_LIMIT,
} = require("../seller-accounting");

const fixed = (value) => value.toFixed();

test("seller activation requires a reached individual threshold and at least 20 XTU", () => {
  const valid = validateSellerJoin("10", "2", true);
  assert.equal(valid.eligible, true);
  assert.equal(fixed(valid.runBalanceInitial), "10");
  assert.equal(fixed(valid.runBalanceXtu), "20");
  assert.equal(fixed(valid.reservedInitialAsset), "5");
  assert.equal(validateSellerJoin("10", "2", false).reason, "price_threshold_not_reached");
  assert.equal(validateSellerJoin("9.99", "2", true).reason, "balance_too_low");
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
  assert.throws(() => calculateSellerPayoutNet("1.19", "0.4", "0.4"), /at least 0.800000000000000000 BSC-USD/);
  assert.equal(fixed(calculateSellerPayoutNet("1.2", "0.4", "0.4").payoutAmount), "0.8");
});

test("seller lifecycle and payout batch limits follow the current policy", () => {
  assert.equal(SELLER_STATUS_DURATION_MS, 7 * 24 * 60 * 60 * 1000);
  assert.equal(fixed(SELLER_PAYOUT_BATCH_LIMIT), "300");
});


test("seller payout batches exclude individual payouts below two times the configured maximum gas fee", () => {
  const rows = [
    { id: 1, username: "SELLER_A", payout_address: "0xaaa", price: "1", availableInitialAsset: new BigNumber("0.6"), grossAvailable: new BigNumber("0.6") },
    { id: 2, username: "SELLER_A", payout_address: "0xaaa", price: "1", availableInitialAsset: new BigNumber("0.6"), grossAvailable: new BigNumber("0.6") },
    { id: 3, username: "SELLER_B", payout_address: "0xbbb", price: "1", availableInitialAsset: new BigNumber("0.5"), grossAvailable: new BigNumber("0.5") },
  ];
  const plan = buildSellerPayoutBatchGroups(rows, "1.2", "1.2");
  assert.equal(plan.ready, true);
  assert.equal(plan.groups.length, 1);
  assert.equal(plan.groups[0].username, "SELLER_A");
  assert.equal(fixed(plan.groups[0].grossAmount), "1.2");
  assert.equal(plan.groups[0].allocations.length, 2);
});

test("seller payout planner leaves liabilities pending when no seller reaches the minimum gross amount", () => {
  const rows = [
    { id: 1, username: "SELLER_A", payout_address: "0xaaa", price: "1", availableInitialAsset: new BigNumber("1.19"), grossAvailable: new BigNumber("1.19") },
    { id: 2, username: "SELLER_B", payout_address: "0xbbb", price: "1", availableInitialAsset: new BigNumber("1.19"), grossAvailable: new BigNumber("1.19") },
  ];
  const plan = buildSellerPayoutBatchGroups(rows, "1.2", "1.2");
  assert.equal(plan.ready, false);
  assert.equal(plan.groups.length, 0);
});


test("a qualified seller is queued below the 300 BSC-USD batch ceiling", () => {
  const rows = [
    { id: 1, username: "SELLER_A", payout_address: "0xaaa", price: "1", availableInitialAsset: new BigNumber("1.2"), grossAvailable: new BigNumber("1.2") },
  ];
  const plan = buildSellerPayoutBatchGroups(rows, "300", "1.2");
  assert.equal(plan.ready, true);
  assert.equal(plan.groups.length, 1);
  assert.equal(fixed(plan.groups[0].grossAmount), "1.2");
  assert.equal(fixed(plan.remainingBatchGross), "298.8");
});
