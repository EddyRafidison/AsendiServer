"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const routesSource = fs.readFileSync(path.join(root, "routes.js"), "utf8");
const limiterSource = fs.readFileSync(path.join(root, "http-rate-limiter.js"), "utf8");
const dbSource = fs.readFileSync(path.join(root, "db.js"), "utf8");
const rechargePolicySource = fs.readFileSync(path.join(root, "recharge-policy.js"), "utf8");
const feePolicySource = fs.readFileSync(path.join(root, "bsc-transaction-policy.js"), "utf8");
const feeAccountingSource = fs.readFileSync(path.join(root, "bsc-fee-accounting.js"), "utf8");
const disbursementSource = fs.readFileSync(path.join(root, "disbursement.js"), "utf8");
const envExample = fs.readFileSync(path.join(root, ".env.example"), "utf8");

function getRouteBlock(routePath, nextRoutePath) {
  const startMarker = `router.post("${routePath}"`;
  const start = routesSource.indexOf(startMarker);
  assert.notEqual(start, -1, `Missing route ${routePath}`);
  const end = routesSource.indexOf(`router.post("${nextRoutePath}"`, start + startMarker.length);
  assert.notEqual(end, -1, `Missing next route ${nextRoutePath}`);
  return routesSource.slice(start, end);
}

test("user-last-stock is the only app endpoint that returns the shared treasury deposit address", () => {
  const stockRoute = getRouteBlock("/app/user-last-stock", "/app/recharge");
  const rechargeRoute = getRouteBlock("/app/recharge", "/app/recharge/status");
  assert.match(stockRoute, /paymentConfig\.treasuryAddress/);
  assert.doesNotMatch(stockRoute, /getOrCreateUserDepositAddress/);
  assert.match(stockRoute, /deposit_addr:\s*depositAddress/);
  assert.match(stockRoute, /has_pending_recharge:\s*hasPendingRecharge/);
  assert.match(stockRoute, /SELECT 1 AS pending[\s\S]*remaining_amount>0/);
  assert.match(stockRoute, /getVisibleDepositAddress/);
  assert.doesNotMatch(rechargeRoute, /getOrCreateUserDepositAddress/);
  assert.doesNotMatch(rechargeRoute, /deposit_addr/);
});

test("manual recharge control is admin-authenticated, serialized and audited", () => {
  const controlRoute = getRouteBlock("/admin/recharge/control", "/admin/recharge/credit");
  assert.match(controlRoute, /decrypt\(admin_pswd/);
  assert.match(controlRoute, /decrypt\(admin_pin/);
  assert.match(controlRoute, /\[\"suspend\", \"resume\", \"status\"\]/);
  assert.match(controlRoute, /lock_name='common_state' FOR UPDATE/);
  assert.match(controlRoute, /UPDATE recharge_service_control/);
  assert.match(controlRoute, /INSERT INTO recharge_service_control_events/);
  assert.match(dbSource, /CREATE TABLE IF NOT EXISTS recharge_service_control/);
  assert.match(dbSource, /CREATE TABLE IF NOT EXISTS recharge_service_control_events/);
  assert.match(limiterSource, /POST \/admin\/recharge\/control/);
});

test("manual suspension holds automated credit while reviewed admin resolution has an explicit override", () => {
  assert.match(routesSource, /const reviewedAdminCredit = options\.allowReviewedAdminCredit === true/);
  assert.match(routesSource, /allowReviewedAdminCredit: true/);
  assert.match(routesSource, /manual_recharge_suspended/);
  assert.match(routesSource, /status='pending_support'/);
});


test("public reserve availability endpoint is authenticated, cached and separate from user-specific deposit disclosure", () => {
  const availabilityRoute = getRouteBlock("/app/recharge/availability", "/app/recharge/status");
  assert.match(availabilityRoute, /requestTokenIsValid/);
  assert.match(availabilityRoute, /getPublicRechargeAvailability/);
  assert.match(availabilityRoute, /available_reserve_xtu/);
  assert.match(availabilityRoute, /minimum_recharge_amount_bsc_usd/);
  assert.match(availabilityRoute, /maximum_recharge_amount_bsc_usd/);
  assert.doesNotMatch(availabilityRoute, /unit_price|recharge_available|availability_reason|updated_at_ms|refresh_after_ms/);
  assert.doesNotMatch(availabilityRoute, /getOrCreateUserDepositAddress/);
  assert.match(limiterSource, /POST \/app\/recharge\/availability/);
});


test("minimum automatic recharge is 20 BSC-USD across validation and API metadata", () => {
  assert.match(rechargePolicySource, /const MIN_RECHARGE_AMOUNT = new BigNumber\("20"\)/);
  assert.match(routesSource, /minimum_not_reached: "The 60-minute session total has not reached the 20 BSC-USD minimum\."/);
  assert.match(routesSource, /minimum_recharge_amount_bsc_usd: MIN_RECHARGE_AMOUNT\.toFixed\(0\)/);
  assert.match(envExample, /^BSC_MAX_TX_FEE_BSC_USD=0\.4$/m);
});

test("HTTP startup rejects an invalid BSC gas cap and workers use a positive BNB/USD quote", () => {
  assert.match(routesSource, /getConfiguredMaxBscTxFeeUsd\(\);/);
  assert.match(feePolicySource, /ABSOLUTE_MAX_BSC_TX_FEE_USD = new BigNumber\("0\.4"\)/);
  assert.match(feeAccountingSource, /!price\.isGreaterThan\(0\)/);
  assert.match(disbursementSource, /estimateNetBscTokenTransfer/);
  assert.match(disbursementSource, /BSC_GAS_FEE_LIMIT_EXCEEDED|createBscFeeLimitError/);
});
