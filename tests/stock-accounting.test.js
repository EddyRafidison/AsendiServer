"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  calculateGlobalUnitPrice,
  xtuToInitialAsset,
  initialAssetToXtu,
  calculateRemainingAdministrativeBacking,
  calculateAdministrativeReserveExpense,
  calculateAdministrativeReserveRecovery,
  calculateCommonReserveGift,
  calculateDistributableInitialAssets,
  calculateUnreservedDistributableInitialAssets,
  calculateTopUpReserveAllocation,
  isUserBalanceWithinMaxStock,
} = require("../stock-accounting");

const fixed = (value) => value.toFixed();

test("the global unit price is the reserve ratio, subject to a caller-supplied monotone floor", () => {
  assert.equal(fixed(calculateGlobalUnitPrice("10000000", "10000000")), "1");
  assert.equal(fixed(calculateGlobalUnitPrice("10000000", "8000000")), "1.25");
  assert.equal(fixed(calculateGlobalUnitPrice("90", "100", "1.2")), "1.2");
  assert.equal(fixed(calculateGlobalUnitPrice("150", "100", "1.2")), "1.5");
  assert.equal(fixed(xtuToInitialAsset("125000", "1.25")), "100000");
  assert.equal(fixed(initialAssetToXtu("100000", "1.25")), "125000");
  assert.throws(() => calculateGlobalUnitPrice("100", "0"), /backed_units/);
  assert.throws(() => xtuToInitialAsset("10", "0"), /unit_price/);
});

test("the administrative reserve is 10 percent and protects only unrecovered expenses", () => {
  const reserve = calculateRemainingAdministrativeBacking("18000000", "0.10", "100000");
  assert.equal(fixed(reserve.initialQuota), "1800000");
  assert.equal(fixed(reserve.remainingInitialAsset), "1700000");
  assert.throws(
    () => calculateRemainingAdministrativeBacking("18000000", "0.10", "1800001"),
    /exceeds the administrative expenditure cap/,
  );
});

test("administrative expenditure decreases BSC reserve and backing while preserving ordinary availability", () => {
  const result = calculateAdministrativeReserveExpense({
    amountBscUsdValue: "100000", totalUnitsPriceValue: "18000000", unitPriceValue: "1",
    backedUnitsValue: "18000000", adminExpensesValue: "0", initialStockValue: "18000000", ratioValue: "0.10",
  });
  assert.equal(result.available, true);
  assert.equal(fixed(result.initialAssetAmount), "100000");
  assert.equal(fixed(result.newTotalUnitsPrice), "17900000");
  assert.equal(fixed(result.newBackedUnits), "17900000");
  assert.equal(fixed(result.newAdminExpenses), "100000");
  assert.equal(fixed(result.newUnitPrice), "1");
  assert.equal(fixed(result.protectedAdminBackingAfter), "1700000");
  const before = calculateDistributableInitialAssets("18000000", "0", "1800000");
  const after = calculateDistributableInitialAssets(
    result.newBackedUnits, "0", result.protectedAdminBackingAfter,
  );
  assert.equal(fixed(before.distributableInitialAssets), fixed(after.distributableInitialAssets));
});

test("administrative expenditure cannot exceed the unused 1.8-million initial-asset cap", () => {
  const result = calculateAdministrativeReserveExpense({
    amountBscUsdValue: "1800001", totalUnitsPriceValue: "18000000", unitPriceValue: "1",
    backedUnitsValue: "18000000", adminExpensesValue: "0", initialStockValue: "18000000", ratioValue: "0.10",
  });
  assert.equal(result.available, false);
  assert.equal(fixed(result.availableValue), "1800000");
});

test("a recovery reverses the outstanding administrative expenditure proportionally", () => {
  const result = calculateAdministrativeReserveRecovery({
    amountBscUsdValue: "25000", totalUnitsPriceValue: "17900000", unitPriceValue: "1",
    backedUnitsValue: "17900000", adminExpensesValue: "100000", initialStockValue: "18000000", ratioValue: "0.10",
  });
  assert.equal(result.available, true);
  assert.equal(fixed(result.newTotalUnitsPrice), "17925000");
  assert.equal(fixed(result.newBackedUnits), "17925000");
  assert.equal(fixed(result.newAdminExpenses), "75000");
  assert.equal(fixed(result.newUnitPrice), "1");
});

test("a recovery cannot exceed the BSC-USD value of outstanding administrative expenses", () => {
  const result = calculateAdministrativeReserveRecovery({
    amountBscUsdValue: "100001", totalUnitsPriceValue: "17900000", unitPriceValue: "1",
    backedUnitsValue: "17900000", adminExpensesValue: "100000", initialStockValue: "18000000", ratioValue: "0.10",
  });
  assert.equal(result.available, false);
  assert.equal(fixed(result.maximumRecoverableValue), "100000");
});

test("a gift increases common valuation and cumulative gifts without issuing initial assets", () => {
  const result = calculateCommonReserveGift({
    amountBscUsdValue: "100000", totalUnitsPriceValue: "18000000", unitPriceValue: "1", backedUnitsValue: "18000000",
  });
  assert.equal(fixed(result.newTotalUnitsPrice), "18100000");
  assert.equal(fixed(result.newUnitPrice), "1.005555555555555555555555555556");
});

test("pending disbursements reserve their initial-asset capacity against later system top-ups", () => {
  const result = calculateUnreservedDistributableInitialAssets("100", "50", "10", "35");
  assert.equal(fixed(result.distributableInitialAssets), "140");
  assert.equal(fixed(result.pendingDisbursementInitialAssets), "35");
  assert.equal(fixed(result.availableAfterPending), "105");
  const overReserved = calculateUnreservedDistributableInitialAssets("100", "50", "10", "145");
  assert.equal(fixed(overReserved.availableAfterPending), "-5");
});

test("top-up consumes inactive initial assets first and recomputes the global price", () => {
  const result = calculateTopUpReserveAllocation("50", "2", "100", "100", "200", "10");
  assert.equal(result.available, true);
  assert.equal(fixed(result.activityAmount), "25");
  assert.equal(fixed(result.consumedInactive), "25");
  assert.equal(fixed(result.consumedBacked), "0");
  assert.equal(fixed(result.newInactive), "75");
  assert.equal(fixed(result.newBacked), "100");
  assert.equal(fixed(result.newTotalUnitsPrice), "250");
  assert.equal(fixed(result.newUnitPrice), "2.5");
});

test("top-up consumes backed assets only after inactive reserve and protects the admin floor", () => {
  const result = calculateTopUpReserveAllocation("50", "2", "100", "20", "200", "10");
  assert.equal(result.available, true);
  assert.equal(fixed(result.activityAmount), "25");
  assert.equal(fixed(result.consumedInactive), "20");
  assert.equal(fixed(result.consumedBacked), "5");
  assert.equal(fixed(result.newInactive), "0");
  assert.equal(fixed(result.newBacked), "95");
  assert.equal(fixed(result.newTotalUnitsPrice), "250");
  assert.equal(fixed(result.newUnitPrice), fixed(calculateGlobalUnitPrice("250", "95")));
  assert.equal(result.newBacked.gte("10"), true);
});

test("top-up reports insufficiency without changing reserve values", () => {
  const result = calculateTopUpReserveAllocation("221", "2", "100", "20", "200", "10");
  assert.equal(result.available, false);
  assert.equal(fixed(result.availableValue), "220");
  assert.equal(fixed(result.newInactive), "20");
  assert.equal(fixed(result.newBacked), "100");
  assert.equal(fixed(result.newTotalUnitsPrice), "200");
});

test("top-up rejects invalid reserve quantities, inconsistent prices and invalid backing", () => {
  assert.throws(() => calculateTopUpReserveAllocation("10", "0", "2", "3", "10"), /unit_price/);
  assert.throws(() => calculateTopUpReserveAllocation("10", "1", "-1", "3", "10"), /negative/);
  assert.throws(() => calculateTopUpReserveAllocation("10", "2", "3", "3", "100"), /inconsistent/);
});

test("projected user stock accepts exactly 300 XTU and rejects any value above it", () => {
  const atLimit = isUserBalanceWithinMaxStock("290", "10", "1", "300");
  assert.equal(atLimit.allowed, true);
  assert.equal(fixed(atLimit.projectedXtu), "300");

  const aboveLimit = isUserBalanceWithinMaxStock("290", "10.000000000000000001", "1", "300");
  assert.equal(aboveLimit.allowed, false);
  assert.equal(aboveLimit.projectedXtu.gt("300"), true);

  const P2PNetCredit = isUserBalanceWithinMaxStock("290", "9.7", "1", "300");
  assert.equal(P2PNetCredit.allowed, true);
  assert.equal(fixed(P2PNetCredit.projectedXtu), "299.7");

  const adjustedPrice = isUserBalanceWithinMaxStock("100", "0", "3", "300");
  assert.equal(adjustedPrice.allowed, true);
  assert.equal(fixed(adjustedPrice.projectedXtu), "300");
});
