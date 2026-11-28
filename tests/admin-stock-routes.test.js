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

test("administrative reserve expenditure, recovery and gift routes are separate", () => {
  const minusStart = routesSource.indexOf('path: "/admin/res/minus"');
  const plusStart = routesSource.indexOf('path: "/admin/res/plus"');
  const giftStart = routesSource.indexOf('// A gift is a physical BSC-USD contribution');
  const minus = routesSource.slice(minusStart, plusStart);
  const plus = routesSource.slice(plusStart, giftStart);
  const gift = getRouteBlock(routesSource, "/admin/res/give", "async function initializeDepositPayments()");

  assert.match(minus, /calculateAdministrativeReserveExpense|calculator\(/);
  assert.match(minus, /sender: "ONEX"/);
  assert.match(minus, /receiver: "XADMIN"/);
  assert.match(plus, /calculateAdministrativeReserveRecovery|calculator\(/);
  assert.match(plus, /sender: "XADMIN"/);
  assert.match(plus, /receiver: "ONEX"/);
  assert.match(gift, /calculateCommonReserveGift\(/);
  assert.match(gift, /INSERT INTO gifts/);
  assert.match(routesSource, /admin_external_settlements/);
  assert.match(routesSource, /external_reference_idempotency_conflict/);
  assert.match(routesSource, /lockCommonStateTx\(tx\)/);
  assert.doesNotMatch(routesSource, /router\.post\("\/admin\/update-common-stock"/);
  assert.doesNotMatch(routesSource, /calculateAdminCommonStockUpdate/);
});

test("each administrative reserve route has an independent rate limit", () => {
  for (const route of ["minus", "plus", "give"]) {
    assert.ok(limiterSource.includes(`"POST /admin/res/${route}": { limit: 10, windowMs: 5 * 60_000, authResponse: true }`));
  }
  assert.doesNotMatch(limiterSource, /POST \/admin\/update-common-stock/);
});

test("common history exposes the administrative expense and gift counters", () => {
  const historyRoute = getRouteBlock(
    routesSource,
    "/admin/common-history",
    'router.post("/admin/resolve-global-disbursement-review"',
  );
  assert.match(historyRoute, /"admin_expens"/);
  assert.match(historyRoute, /"total_gifts"/);
  assert.match(historyRoute, /LIMIT 50/);
  assert.match(historyRoute, /getHotWalletTreasurySnapshot\(db\)/);
});
