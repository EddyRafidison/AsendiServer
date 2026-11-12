"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  validateSellerJoin,
  allocateSellerLotConsumption,
  sumActiveSellerReserveLots,
  calculateSellerPayoutNet,
  SELLER_STATUS_DURATION_MS,
  SELLER_PAYOUT_BATCH_LIMIT,
} = require("../seller-accounting");

const fixed = (value) => value.toFixed();

test("seller campaign requires a minimum balance, a half-balance lock and sufficient pending bonus", () => {
  const valid = validateSellerJoin("100", "50", "50", "5");
  assert.equal(valid.eligible, true);
  assert.equal(fixed(valid.reservedUnits), "25");
  assert.equal(fixed(valid.reservedInitAsset), "12.5");
  assert.equal(fixed(valid.requiredBonus), "5");

  assert.equal(validateSellerJoin("12", "6", "12", "2").eligible, false);
  assert.equal(validateSellerJoin("100", "50", "49", "5").reason, "run_balance_below_half_balance");
  assert.equal(validateSellerJoin("100", "50", "50", "4.99").reason, "pending_bonus_below_threshold");
});

test("only active seller lots contribute to the immediately available seller reserve", () => {
  const available = sumActiveSellerReserveLots([
    { remaining_units: "12.5" },
    { remaining_units: "7.5" },
  ]);
  assert.equal(fixed(available), "20");
});

test("seller reserve consumption allocates FIFO and prorates remaining initial-asset basis", () => {
  const result = allocateSellerLotConsumption([
    { id: 1, username: "SELLER_A", remaining_units: "10", remaining_init_asset: "5" },
    { id: 2, username: "SELLER_B", remaining_units: "20", remaining_init_asset: "8" },
  ], "15");

  assert.equal(result.available, true);
  assert.equal(fixed(result.consumedUnits), "15");
  assert.equal(fixed(result.consumedInitAsset), "7");
  assert.equal(result.allocations.length, 2);
  assert.equal(fixed(result.allocations[0].units), "10");
  assert.equal(fixed(result.allocations[0].initAsset), "5");
  assert.equal(fixed(result.allocations[1].units), "5");
  assert.equal(fixed(result.allocations[1].initAsset), "2");
});

test("seller reserve allocation reports insufficiency without inventing units", () => {
  const result = allocateSellerLotConsumption([
    { id: 1, username: "SELLER_A", remaining_units: "10", remaining_init_asset: "5" },
  ], "12");
  assert.equal(result.available, false);
  assert.equal(fixed(result.consumedUnits), "10");
  assert.equal(fixed(result.remainingUnits), "2");
});

test("seller payout deducts only gas recovery and has no transfer-fee component", () => {
  const result = calculateSellerPayoutNet("300", "0.1");
  assert.equal(fixed(result.grossAmount), "300");
  assert.equal(fixed(result.gasFee), "0.1");
  assert.equal(fixed(result.payoutAmount), "299.9");
  assert.throws(() => calculateSellerPayoutNet("0.1", "0.1"), /gas fee must be lower/);
});

test("seller lifecycle and payout batch limits are fixed by the approved policy", () => {
  assert.equal(SELLER_STATUS_DURATION_MS, 7 * 24 * 60 * 60 * 1000);
  assert.equal(fixed(SELLER_PAYOUT_BATCH_LIMIT), "300");
});
