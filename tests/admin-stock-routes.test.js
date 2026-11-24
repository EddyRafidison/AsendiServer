"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const routesSource = fs.readFileSync(path.join(__dirname, "..", "routes.js"), "utf8");
const limiterSource = fs.readFileSync(path.join(__dirname, "..", "http-rate-limiter.js"), "utf8");

function getRouteBlock(source, routePath, endMarker) {
  const startMarker = `router.post("${routePath}"`;
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `Missing route ${routePath}`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(end, -1, `Missing end marker for ${routePath}`);
  return source.slice(start, end);
}

test("administrative user-stock credit and common-stock expenditure use separate routes", () => {
  const userRoute = getRouteBlock(
    routesSource,
    "/admin/update-user-stock",
    'router.post("/admin/update-common-stock"',
  );
  const commonRoute = getRouteBlock(
    routesSource,
    "/admin/update-common-stock",
    "async function initializeDepositPayments()",
  );

  assert.match(userRoute, /applyUserTopUp\(/);
  assert.match(userRoute, /enforceDepositRange:\s*false/);
  assert.doesNotMatch(userRoute, /calculateAdminCommonStockUpdate\(/);
  assert.match(commonRoute, /calculateAdminCommonStockUpdate\(/);
  assert.doesNotMatch(commonRoute, /applyUserTopUp\(/);
  assert.doesNotMatch(routesSource, /user\.includes\(["']-["']\)/);
});

test("both administrative stock endpoints have independent HTTP rate-limit entries", () => {
  assert.match(limiterSource, /"POST \/admin\/update-user-stock": \{ limit: 20, windowMs: 5 \* 60_000/);
  assert.match(limiterSource, /"POST \/admin\/update-common-stock": \{ limit: 20, windowMs: 5 \* 60_000/);
});


test("administrative common history has a dedicated rate-limit entry", () => {
  assert.ok(limiterSource.includes('"POST /admin/common-history": { limit: 10, windowMs: 5 * 60_000, authResponse: true }'));
  const historyRoute = getRouteBlock(
    routesSource,
    "/admin/common-history",
    'router.post("/admin/resolve-global-disbursement-review"',
  );
  assert.match(historyRoute, /LIMIT 50/);
  assert.match(historyRoute, /columns\.join/);
  assert.doesNotMatch(historyRoute, /req\.body\.(table|column)/);
});


test("individual disbursement control is rate limited and common history exposes protected Hot Wallet liquidity", () => {
  assert.ok(limiterSource.includes('"POST /admin/individual-disbursement/control": { limit: 10, windowMs: 5 * 60_000, authResponse: true }'));
  const controlRoute = getRouteBlock(
    routesSource,
    "/admin/individual-disbursement/control",
    'router.post("/admin/global-disbursement-participants"',
  );
  assert.match(controlRoute, /individual_disbursement_control/);
  assert.match(controlRoute, /individual_disbursement_control_events/);

  const historyRoute = getRouteBlock(
    routesSource,
    "/admin/common-history",
    'router.post("/admin/resolve-global-disbursement-review"',
  );
  assert.match(historyRoute, /getHotWalletTreasurySnapshot\(db\)/);
  assert.match(historyRoute, /hot_wallet:\s*hotWallet/);
});

test("Hot Wallet reserve allocation excludes duplicate liabilities and waits for scanner finality", () => {
  const liquiditySource = fs.readFileSync(path.join(__dirname, "..", "treasury-liquidity.js"), "utf8");
  assert.match(liquiditySource, /remaining_amount/);
  assert.match(liquiditySource, /reserved_refund_amount/);
  assert.match(liquiditySource, /'resolved_uncredited'/);
  assert.match(liquiditySource, /bsc_treasury_sweeps/);
  assert.match(liquiditySource, /pending_cold_wallet_sweeps/);
  assert.match(liquiditySource, /payout_pending_initial_asset,unit_price/);
  assert.match(liquiditySource, /batch_id IS NULL AND unknown_transfer_id IS NULL/);
  assert.doesNotMatch(liquiditySource, /FROM users_usdt_seller_payouts/);
  assert.match(liquiditySource, /contract\.balanceOf\(wallet, \{ blockTag: safeBlock\.number \}\)/);
  assert.match(liquiditySource, /last_scanned_block/);
  assert.match(liquiditySource, /provisional_available_before_scanner_reconciliation/);
});
