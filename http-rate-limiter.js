"use strict";

const DEFAULT_GLOBAL_WINDOW_MS = 60_000;
const DEFAULT_GLOBAL_LIMIT = 180;
const MAX_RATE_LIMIT_KEYS = 50_000;

const ROUTE_LIMITS = Object.freeze({
  "GET /app/download-latest-apk": { limit: 10, windowMs: 60_000 },
  "GET /app/privacy-terms-info": { limit: 60, windowMs: 60_000 },
  "POST /app/check-app-version": { limit: 30, windowMs: 60_000 },
  "POST /app/signin": { limit: 10, windowMs: 15 * 60_000, authResponse: true },
  "POST /app/device/challenge": { limit: 10, windowMs: 15 * 60_000, authResponse: true },
  "POST /app/signup": { limit: 5, windowMs: 60 * 60_000 },
  "POST /app/contact-onex": { limit: 5, windowMs: 60 * 60_000, authResponse: true },
  "POST /app/user-last-stock": { limit: 30, windowMs: 60_000, authResponse: true },
  "POST /app/deposit": { limit: 10, windowMs: 60_000, authResponse: true },
  "POST /app/deposit/availability": { limit: 70, windowMs: 60_000, authResponse: true },
  "POST /app/deposit/status": { limit: 30, windowMs: 60_000, authResponse: true },
  "POST /app/deposit/refund-request": { limit: 3, windowMs: 24 * 60 * 60_000, authResponse: true },
  "POST /app/set-payout-address": { limit: 5, windowMs: 15 * 60_000, authResponse: true },
  "POST /app/join-system-sellers": { limit: 5, windowMs: 15 * 60_000, authResponse: true },
  "POST /app/cancel-system-sellers": { limit: 5, windowMs: 15 * 60_000, authResponse: true },
  "POST /app/transactions-history": { limit: 30, windowMs: 60_000, authResponse: true },
  "POST /app/xtu-transfer": { limit: 10, windowMs: 60_000, authResponse: true },
  "POST /app/disbursement/status": { limit: 30, windowMs: 60_000, authResponse: true },
  "POST /app/modify-pin-or-password": { limit: 8, windowMs: 15 * 60_000, authResponse: true },
  "POST /app/modify-seed": { limit: 8, windowMs: 15 * 60_000, authResponse: true },
  "POST /app/recover-account": { limit: 4, windowMs: 15 * 60_000, authResponse: true },
  "POST /app/delete-user": { limit: 3, windowMs: 24 * 60 * 60_000, authResponse: true },
  "POST /admin/send-temp-pswd": { limit: 5, windowMs: 60 * 60_000, authResponse: true },
  "POST /admin/deposit/control": { limit: 10, windowMs: 5 * 60_000, authResponse: true },
  "POST /admin/bsc/incoming-scanner/status": { limit: 10, windowMs: 5 * 60_000, authResponse: true },
  "POST /admin/bsc/incoming-scanner/reconcile/preview": { limit: 3, windowMs: 15 * 60_000, authResponse: true },
  "POST /admin/bsc/incoming-scanner/reconcile/resolve-event": { limit: 10, windowMs: 15 * 60_000, authResponse: true },
  "POST /admin/bsc/incoming-scanner/reconcile/commit": { limit: 3, windowMs: 15 * 60_000, authResponse: true },
  "POST /admin/bsc/incoming-scanner/reconcile": { limit: 3, windowMs: 15 * 60_000, authResponse: true },
  "POST /public/bsc/unknown-transfers/refund-challenge": { limit: 4, windowMs: 60 * 60_000 },
  "POST /public/bsc/unknown-transfers/refund-request": { limit: 3, windowMs: 24 * 60 * 60_000 },
  "POST /public/xtu/unknown-transfers/refund-challenge": { limit: 4, windowMs: 60 * 60_000 },
  "POST /public/xtu/unknown-transfers/refund-request": { limit: 3, windowMs: 24 * 60 * 60_000 },
  "POST /admin/xtu/unknown-transfers/list": { limit: 10, windowMs: 5 * 60_000, authResponse: true },
  "POST /admin/xtu/unknown-transfers/resolve": { limit: 10, windowMs: 5 * 60_000, authResponse: true },
  "POST /admin/xtu/unknown-refunds/list": { limit: 10, windowMs: 5 * 60_000, authResponse: true },
  "POST /admin/bsc/unknown-transfers/list": { limit: 10, windowMs: 5 * 60_000, authResponse: true },
  "POST /admin/bsc/unknown-transfers/resolve": { limit: 10, windowMs: 5 * 60_000, authResponse: true },
  "POST /admin/deposit/credit": { limit: 20, windowMs: 5 * 60_000, authResponse: true },
  "POST /admin/deposit/refund": { limit: 10, windowMs: 5 * 60_000, authResponse: true },
  "POST /admin/user-info": { limit: 20, windowMs: 5 * 60_000, authResponse: true },
  "POST /admin/unlock-disbursement": { limit: 10, windowMs: 5 * 60_000, authResponse: true },
  "POST /admin/deactivate-account": { limit: 10, windowMs: 5 * 60_000, authResponse: true },
  "POST /admin/activate-account": { limit: 10, windowMs: 5 * 60_000, authResponse: true },
  "POST /admin/unlock-system-seller": { limit: 10, windowMs: 5 * 60_000, authResponse: true },
  "POST /admin/update-user-stock": { limit: 20, windowMs: 5 * 60_000, authResponse: true },
  "POST /admin/res/minus": { limit: 10, windowMs: 5 * 60_000, authResponse: true },
  "POST /admin/res/plus": { limit: 10, windowMs: 5 * 60_000, authResponse: true },
  "POST /admin/res/give": { limit: 10, windowMs: 5 * 60_000, authResponse: true },
  "POST /admin/individual-disbursement/control": { limit: 10, windowMs: 5 * 60_000, authResponse: true },
  "POST /admin/common-history": { limit: 10, windowMs: 5 * 60_000, authResponse: true },
});

function normalizeIp(value) {
  if (typeof value !== "string" || !value.trim()) return "unknown";
  let ip = value.trim().toLowerCase();
  if (ip.startsWith("::ffff:")) ip = ip.slice(7);
  return ip.slice(0, 128);
}

function createHttpRateLimiter(options = {}) {
  const configuredGlobalLimit = Number(process.env.HTTP_RATE_LIMIT_GLOBAL || DEFAULT_GLOBAL_LIMIT);
  const configuredGlobalWindowMs = Number(process.env.HTTP_RATE_WINDOW_MS || DEFAULT_GLOBAL_WINDOW_MS);
  const globalLimit = Number.isInteger(options.globalLimit) && options.globalLimit > 0
    ? options.globalLimit
    : (Number.isInteger(configuredGlobalLimit) && configuredGlobalLimit > 0 ? configuredGlobalLimit : DEFAULT_GLOBAL_LIMIT);
  const globalWindowMs = Number.isInteger(options.globalWindowMs) && options.globalWindowMs > 0
    ? options.globalWindowMs
    : (Number.isInteger(configuredGlobalWindowMs) && configuredGlobalWindowMs > 0 ? configuredGlobalWindowMs : DEFAULT_GLOBAL_WINDOW_MS);
  const store = new Map();
  let lastCleanupAt = 0;

  function prune(now) {
    if (now - lastCleanupAt < 30_000 && store.size < MAX_RATE_LIMIT_KEYS) return;
    lastCleanupAt = now;
    for (const [key, bucket] of store) {
      if (bucket.windowStartMs + bucket.windowMs <= now) store.delete(key);
    }
    if (store.size > MAX_RATE_LIMIT_KEYS) {
      const excess = store.size - MAX_RATE_LIMIT_KEYS;
      let removed = 0;
      for (const key of store.keys()) {
        store.delete(key);
        removed += 1;
        if (removed >= excess) break;
      }
    }
  }

  function consume(key, limit, windowMs, now) {
    const windowStartMs = Math.floor(now / windowMs) * windowMs;
    let bucket = store.get(key);
    if (!bucket || bucket.windowStartMs !== windowStartMs) {
      if (!bucket && store.size >= MAX_RATE_LIMIT_KEYS) prune(now);
      if (!bucket && store.size >= MAX_RATE_LIMIT_KEYS) return { allowed: false, retryAfterSeconds: Math.ceil(windowMs / 1000) };
      bucket = { windowStartMs, windowMs, count: 0 };
      store.set(key, bucket);
    }

    if (bucket.count >= limit) {
      return {
        allowed: false,
        retryAfterSeconds: Math.max(1, Math.ceil((windowStartMs + windowMs - now) / 1000)),
      };
    }
    bucket.count += 1;
    return { allowed: true };
  }

  return function httpRateLimiter(req, res, next) {
    const now = Date.now();
    prune(now);
    const ip = normalizeIp(req.ip || req.socket?.remoteAddress);
    const globalResult = consume(`global:${ip}`, globalLimit, globalWindowMs, now);
    if (!globalResult.allowed) {
      res.set("Retry-After", String(globalResult.retryAfterSeconds));
      return res.status(429).send({ error: "rate limit exceeded" });
    }

    const normalizedPath = String(req.path || "/").toLowerCase().replace(/\/+$/, "") || "/";
    const normalizedMethod = req.method === "HEAD" ? "GET" : req.method;
    const rule = ROUTE_LIMITS[`${normalizedMethod} ${normalizedPath}`];
    if (rule) {
      const routeResult = consume(`route:${normalizedMethod}:${normalizedPath}:${ip}`, rule.limit, rule.windowMs, now);
      if (!routeResult.allowed) {
        res.set("Retry-After", String(routeResult.retryAfterSeconds));
        return res.status(429).send(rule.authResponse
          ? { auth: "limit reached" }
          : { error: "rate limit exceeded" });
      }
    }

    return next();
  };
}

module.exports = {
  createHttpRateLimiter,
  DEFAULT_GLOBAL_LIMIT,
  DEFAULT_GLOBAL_WINDOW_MS,
  ROUTE_LIMITS,
};
