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
    "async function initializeRechargePayments()",
  );

  assert.match(userRoute, /applyUserTopUp\(/);
  assert.match(userRoute, /enforceRechargeRange:\s*false/);
  assert.doesNotMatch(userRoute, /calculateAdminCommonStockUpdate\(/);
  assert.match(commonRoute, /calculateAdminCommonStockUpdate\(/);
  assert.doesNotMatch(commonRoute, /applyUserTopUp\(/);
  assert.doesNotMatch(routesSource, /user\.includes\(["']-["']\)/);
});

test("both administrative stock endpoints have independent HTTP rate-limit entries", () => {
  assert.match(limiterSource, /"POST \/admin\/update-user-stock": \{ limit: 20, windowMs: 5 \* 60_000/);
  assert.match(limiterSource, /"POST \/admin\/update-common-stock": \{ limit: 20, windowMs: 5 \* 60_000/);
});
