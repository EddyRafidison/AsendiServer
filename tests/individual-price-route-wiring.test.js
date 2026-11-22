"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const routes = fs.readFileSync(path.join(root, "routes.js"), "utf8");
const schema = fs.readFileSync(path.join(root, "db.js"), "utf8");
const accounting = fs.readFileSync(path.join(root, "user-price-accounting.js"), "utf8");
const disbursement = fs.readFileSync(path.join(root, "disbursement.js"), "utf8");

test("fresh schema uses grouped 5% operation fields and has no legacy 50% resume columns", () => {
  assert.match(schema, /sale_group_base_initial_asset DECIMAL/);
  assert.match(schema, /sale_group_volume_initial_asset DECIMAL/);
  assert.match(schema, /purchase_group_base_initial_asset DECIMAL/);
  assert.match(schema, /purchase_group_volume_initial_asset DECIMAL/);
  assert.doesNotMatch(schema, /required_sale_initial_asset|sold_since_trigger_initial_asset|required_purchase_xtu|purchased_since_trigger_xtu/);
});

test("the accounting module calculates proportional C and groups purchases and sales independently", () => {
  assert.match(accounting, /MINIMUM_OPERATION_RATIO = new BigNumber\("0\.05"\)/);
  assert.match(accounting, /calculateIndividualRemunerationRate/);
  assert.match(accounting, /sale_group_volume_initial_asset/);
  assert.match(accounting, /purchase_group_volume_initial_asset/);
  assert.match(accounting, /status='capped'/);
});

test("P2P conversion uses sender individual price and common fee reserves use the pre-operation global price", () => {
  assert.match(routes, /const requestedInitialAsset = xtuToInitialAsset\(requestedAmount, senderIndividualPrice\)/);
  assert.match(routes, /const feesXtu = feesInitialAsset\.multipliedBy\(unitPrice\)/);
  assert.match(routes, /total_units_price: newTotalUnitsPrice\.toFixed\(30\)/);
  assert.match(routes, /fee_unit_price/);
});

test("user-last-stock returns individual valuation and remuneration details", () => {
  assert.match(routes, /router\.post\("\/app\/user-last-stock"/);
  for (const field of ["global_unit_price", "unit_price", "base_price", "remuneration_rate", "target_price", "remuneration_status", "maximum_user_stock", "stock_limit_reached", "stock_purchases_allowed", "stock_capacity_remaining"]) {
    assert.match(routes, new RegExp(`${field}:`));
  }
});

test("user-last-stock uses the immutable participant price snapshot during an effective global disbursement", () => {
  assert.match(routes, /if \(!rechargeAvailability\.globalEffective\) \{\s*await triggerUserPriceThresholdTx/);
  assert.match(routes, /FROM global_disbursement_participants\s+WHERE run_id=\? AND username=\? LIMIT 1/);
  assert.match(routes, /individualPrice = new BigNumber\(globalParticipantSnapshot\.snapshot_unit_price\)/);
  assert.match(routes, /price_snapshot_mode: globalParticipantSnapshot \? "global_disbursement" : "live_individual"/);
  assert.match(routes, /stock_purchases_allowed: !globalEffective/);
});

test("global disbursement snapshots participant-specific prices and individual payout cycles use the settled global price", () => {
  assert.match(schema, /snapshot_base_price DECIMAL/);
  assert.match(schema, /snapshot_remuneration_rate DECIMAL/);
  assert.match(schema, /snapshot_target_price DECIMAL/);
  assert.match(schema, /snapshot_unit_price DECIMAL/);
  assert.match(routes, /participantPriceState, participantBalance, snapshotPrice, maxStockDefault/);
  assert.match(routes, /requestPrice = new BigNumber\(globalParticipant\.snapshot_unit_price\)/);
  assert.match(disbursement, /reserveSettlement\.newUnitPrice/);
});

test("pool queryAsync callers consume the direct mysql2 result rather than destructuring its first row", () => {
  const database = fs.readFileSync(path.join(root, "db.js"), "utf8");
  assert.match(database, /db\.queryAsync = \(sql, params = \[\]\) => new Promise\(\(resolve, reject\) => \{\s*db\.query\(sql, params, \(error, result\) => error \? reject\(error\) : resolve\(result\)\);/);
  for (const file of ["routes.js", "pay.js", "disbursement.js"]) {
    const source = fs.readFileSync(path.join(root, file), "utf8");
    assert.doesNotMatch(source, /(?:const|let)\s+\[[^\]]+\]\s*=\s*await db\.queryAsync\(/, `${file} must not destructure the direct queryAsync result`);
  }
});
