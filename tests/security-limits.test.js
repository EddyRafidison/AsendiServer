"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  DAY_MS,
  countRecentEvents,
  evaluateAccountActionLimit,
  consumeAccountApiRateLimit,
} = require("../security-limits");
const { ROUTE_LIMITS, createHttpRateLimiter } = require("../http-rate-limiter");

test("password and seed changes allow three failed attempts and one success per rolling day", () => {
  for (const action of ["password_change", "seed_change"]) {
    assert.equal(evaluateAccountActionLimit(action, { failed: 0, successful: 0 }).allowed, true);
    assert.equal(evaluateAccountActionLimit(action, { failed: 2, successful: 0 }).allowed, true);
    assert.equal(evaluateAccountActionLimit(action, { failed: 3, successful: 0 }).allowed, true);
    assert.equal(evaluateAccountActionLimit(action, { failed: 3, successful: 0 }).canRecordFailure, false);
    assert.equal(evaluateAccountActionLimit(action, { failed: 0, successful: 1 }).allowed, false);
    assert.equal(evaluateAccountActionLimit(action, { failed: 2, successful: 1 }).allowed, false);
  }
});

test("account recovery permits two requests and blocks the third", () => {
  assert.equal(evaluateAccountActionLimit("account_recovery", { request: 0 }).allowed, true);
  assert.equal(evaluateAccountActionLimit("account_recovery", { request: 1 }).allowed, true);
  assert.equal(evaluateAccountActionLimit("account_recovery", { request: 2 }).allowed, false);
});

test("security event counters ignore events outside the 24-hour window and future timestamps", () => {
  const now = 50 * DAY_MS;
  const counts = countRecentEvents([
    { outcome: "failed", created_at_ms: now - DAY_MS - 1 },
    { outcome: "failed", created_at_ms: now - DAY_MS },
    { outcome: "successful", created_at_ms: now - 1000 },
    { outcome: "request", created_at_ms: now + 1 },
  ], now);
  assert.deepEqual(counts, { failed: 1, successful: 1, request: 0 });
});

test("account API limits are atomic at the storage boundary", async () => {
  const buckets = new Map();
  const fakeDb = {
    async executeAsync(sql, params) {
      if (sql.includes("INSERT IGNORE INTO account_api_rate_limits")) {
        const key = params.slice(0, 3).join("|");
        if (!buckets.has(key)) buckets.set(key, 0);
        return { affectedRows: 1 };
      }
      if (sql.includes("UPDATE account_api_rate_limits")) {
        const [, username, action, windowStart, limit] = params;
        const key = [username, action, windowStart].join("|");
        const current = buckets.get(key) || 0;
        if (current >= limit) return { affectedRows: 0 };
        buckets.set(key, current + 1);
        return { affectedRows: 1 };
      }
      throw new Error("Unexpected test SQL");
    },
  };
  const now = 1_800_000_000_000;
  assert.equal(await consumeAccountApiRateLimit(fakeDb, "USER-ABC", "transfer", 2, 60_000, now), true);
  assert.equal(await consumeAccountApiRateLimit(fakeDb, "USER-ABC", "transfer", 2, 60_000, now + 1), true);
  assert.equal(await consumeAccountApiRateLimit(fakeDb, "USER-ABC", "transfer", 2, 60_000, now + 2), false);
  assert.equal(await consumeAccountApiRateLimit(fakeDb, "USER-ABC", "transfer", 2, 60_000, now + 60_000), true);
});

test("sensitive routes have explicit IP-level limits", () => {
  assert.ok(ROUTE_LIMITS["POST /app/signin"].limit > 0);
  assert.ok(ROUTE_LIMITS["POST /app/signup"].limit > 0);
  assert.ok(ROUTE_LIMITS["POST /app/recover-account"].limit > 0);
  assert.ok(ROUTE_LIMITS["POST /app/xtu-transfer"].limit > 0);
  assert.ok(ROUTE_LIMITS["POST /app/transactions-history"].limit > 0);
  assert.ok(ROUTE_LIMITS["POST /admin/send-temp-pswd"].limit > 0);
  assert.ok(ROUTE_LIMITS["POST /admin/deactivate-account"].limit > 0);
  assert.ok(ROUTE_LIMITS["POST /admin/activate-account"].limit > 0);
  assert.equal(ROUTE_LIMITS["POST /admin/set-user-status"], undefined);
  assert.ok(ROUTE_LIMITS["POST /admin/unlock-system-seller"].limit > 0);
});

test("HTTP limiter returns 429 and Retry-After when a route bucket is exhausted", () => {
  const limiter = createHttpRateLimiter({ globalLimit: 100, globalWindowMs: 60_000 });
  const makeResponse = () => ({
    headers: {}, statusCode: 200, body: null,
    set(name, value) { this.headers[name] = value; return this; },
    status(code) { this.statusCode = code; return this; },
    send(body) { this.body = body; return this; },
  });
  const req = { method: "POST", path: "/app/signin", ip: "192.0.2.10", socket: {} };
  let nextCalled = false;
  for (let i = 0; i < ROUTE_LIMITS["POST /app/signin"].limit; i += 1) {
    limiter(req, makeResponse(), () => { nextCalled = true; });
  }
  const response = makeResponse();
  limiter(req, response, () => { nextCalled = true; });
  assert.equal(response.statusCode, 429);
  assert.deepEqual(response.body, { auth: "limit reached" });
  assert.ok(Number(response.headers["Retry-After"]) >= 1);
});

test("HTTP route limits cannot be bypassed with case changes or trailing slashes", () => {
  const limiter = createHttpRateLimiter({ globalLimit: 100, globalWindowMs: 60_000 });
  const makeResponse = () => ({
    headers: {}, statusCode: 200, body: null,
    set(name, value) { this.headers[name] = value; return this; },
    status(code) { this.statusCode = code; return this; },
    send(body) { this.body = body; return this; },
  });
  const req = { method: "POST", path: "/APP/SIGNIN/", ip: "192.0.2.11", socket: {} };
  for (let index = 0; index < ROUTE_LIMITS["POST /app/signin"].limit; index += 1) {
    limiter(req, makeResponse(), () => {});
  }
  const response = makeResponse();
  limiter(req, response, () => {});
  assert.equal(response.statusCode, 429);
  assert.deepEqual(response.body, { auth: "limit reached" });
});
