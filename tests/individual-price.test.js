"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  MINIMUM_OPERATION_RATIO,
  calculateIndividualRemunerationRate,
  calculateIndividualTargetPrice,
  calculateEffectiveIndividualPrice,
  previewUserOperationCapacity,
} = require("../user-price-accounting");

const fixed = (value) => value.toFixed();

test("the 5% grouped-operation minimum is centralized", () => {
  assert.equal(fixed(MINIMUM_OPERATION_RATIO), "0.05");
});

test("individual remuneration scales with operation volume and is capped at 3 times tfees", () => {
  assert.equal(fixed(calculateIndividualRemunerationRate("50", "100", "3")), "9");
  assert.equal(fixed(calculateIndividualRemunerationRate("25", "100", "3")), "4.5");
  assert.equal(fixed(calculateIndividualRemunerationRate("10", "100", "3")), "1.8");
  assert.equal(fixed(calculateIndividualRemunerationRate("5", "100", "3")), "0.9");
  assert.equal(fixed(calculateIndividualRemunerationRate("80", "100", "3")), "9");
});

test("target B is calculated from A and the individually calculated remuneration rate C", () => {
  assert.equal(fixed(calculateIndividualTargetPrice("1.2", "9")), "1.308");
  assert.equal(fixed(calculateIndividualTargetPrice("1.4", "4.5")), "1.463");
  assert.equal(fixed(calculateIndividualTargetPrice("1", "0")), "1");
  assert.throws(() => calculateIndividualTargetPrice("0", "3"), /positive/);
  assert.throws(() => calculateIndividualTargetPrice("1", "-1"), /non-negative/);
  assert.throws(() => calculateIndividualRemunerationRate("0", "100", "3"), /positive/);
  assert.throws(() => calculateIndividualRemunerationRate("5", "0", "3"), /positive/);
});

test("a watching user's XTU valuation follows the global price until target B", () => {
  const state = { status: "watching", target_price: "1.308", frozen_price: null };
  const beforeTarget = calculateEffectiveIndividualPrice(state, "100", "1.25", "300");
  const atTarget = calculateEffectiveIndividualPrice(state, "100", "1.31", "300");
  assert.equal(fixed(beforeTarget.price), "1.25");
  assert.equal(beforeTarget.status, "watching");
  assert.equal(fixed(atTarget.price), "1.308");
  assert.equal(atTarget.status, "paused");
});

test("paused and capped prices remain frozen until a qualifying operation starts a new cycle", () => {
  const paused = calculateEffectiveIndividualPrice(
    { status: "paused", target_price: "1.308", frozen_price: "1.308" }, "90", "1.6", "300",
  );
  const capped = calculateEffectiveIndividualPrice(
    { status: "capped", target_price: "1.5", frozen_price: "1.2" }, "250", "1.7", "300",
  );
  assert.equal(fixed(paused.price), "1.308");
  assert.equal(paused.status, "paused");
  assert.equal(fixed(capped.price), "1.2");
  assert.equal(capped.status, "capped");
});

test("a grouped operation starts a cycle only when same-direction volume reaches 5%", () => {
  const state = {
    status: "paused",
    target_price: "1.308",
    frozen_price: "1.308",
    sale_group_base_initial_asset: "100",
    sale_group_volume_initial_asset: "4",
    purchase_group_base_initial_asset: null,
    purchase_group_volume_initial_asset: "0",
  };
  const short = previewUserOperationCapacity(state, "sale", "0.9", "96", "95.1", "1.4");
  const qualifying = previewUserOperationCapacity(state, "sale", "1", "96", "95", "1.4");
  assert.equal(short.startsCycle, false);
  assert.equal(qualifying.startsCycle, true);
  assert.equal(fixed(qualifying.price), "1.4");
});

test("watching purchases are rejected when the uncapped projected valuation exceeds 300 XTU", () => {
  const state = {
    status: "watching",
    base_price: "1.1",
    target_price: "1.5",
    sale_group_base_initial_asset: null,
    sale_group_volume_initial_asset: "0",
    purchase_group_base_initial_asset: null,
    purchase_group_volume_initial_asset: "0",
  };
  const preview = previewUserOperationCapacity(state, "purchase", "1", "299", "300", "1.1");
  assert.equal(preview.allowed, false);
  assert.equal(preview.projectedXtu.toFixed(), "330");
});

test("capped accounts must reduce principal through sales before purchases can restart a cycle", () => {
  const state = { status: "capped", target_price: "1.2", frozen_price: "1.2", sale_group_volume_initial_asset: "0" };
  const purchase = previewUserOperationCapacity(state, "purchase", "1", "200", "201", "1.5");
  assert.equal(purchase.allowed, false);
  assert.equal(purchase.reason, "account_capped_requires_sale");
});

test("sales remain possible above the 300 XTU cap so the account can return below the limit", () => {
  const state = { status: "capped", target_price: "1.2", frozen_price: "1.2", sale_group_volume_initial_asset: "0" };
  const sale = previewUserOperationCapacity(state, "sale", "10", "320", "310", "1.2");
  assert.equal(sale.allowed, true);
  assert.equal(sale.projectedXtu.toFixed(), "372");
  const purchase = previewUserOperationCapacity(state, "purchase", "10", "320", "330", "1.2");
  assert.equal(purchase.allowed, false);
});
