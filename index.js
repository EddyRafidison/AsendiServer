"use strict";

process.env.TZ = "UTC";

require("dotenv").config();
const express = require("express");
const routes = require("./routes");
const { initDbIfEmpty, cleanup, PORT_SERVER } = require("./db");
const { createHttpRateLimiter } = require("./http-rate-limiter");
const { startSellerLifecycleWorker } = require("./seller-worker");
const { startPriceWorker } = require("./price-worker");
const { recalculateWatchingPriceTargets } = require("./user-price-accounting");

function boundedIntegerEnv(name, fallback, minimum, maximum) {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) return fallback;
  return Math.max(minimum, Math.min(value, maximum));
}

function parseBodySizeLimit(raw, fallbackBytes, maximumBytes) {
  if (raw == null || raw === "") return `${fallbackBytes}b`;
  const match = String(raw).trim().match(/^(\d+)\s*(b|kb|mb)?$/i);
  if (!match) return `${fallbackBytes}b`;
  const units = { b: 1, kb: 1024, mb: 1024 * 1024 };
  const multiplier = units[(match[2] || "b").toLowerCase()];
  const parsed = Number(match[1]) * multiplier;
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return `${fallbackBytes}b`;
  return `${Math.min(parsed, maximumBytes)}b`;
}

const app = express();
const configuredTrustProxyHops = Number(process.env.TRUST_PROXY_HOPS || 0);
if (!Number.isInteger(configuredTrustProxyHops) || configuredTrustProxyHops < 0 || configuredTrustProxyHops > 5) {
  throw new Error("TRUST_PROXY_HOPS must be an integer between 0 and 5");
}
app.set("trust proxy", configuredTrustProxyHops);

// Apply request limits before parsing potentially large request bodies.
app.use(createHttpRateLimiter());

const forceHttps = String(process.env.FORCE_HTTPS || "false").toLowerCase() === "true";
const publicHttpsOrigin = String(process.env.PUBLIC_HTTPS_ORIGIN || "").trim();
if (forceHttps) {
  let parsedHttpsOrigin;
  try { parsedHttpsOrigin = new URL(publicHttpsOrigin); } catch {}
  if (
    !parsedHttpsOrigin || parsedHttpsOrigin.protocol !== "https:" ||
    parsedHttpsOrigin.pathname !== "/" || parsedHttpsOrigin.search || parsedHttpsOrigin.hash ||
    parsedHttpsOrigin.username || parsedHttpsOrigin.password
  ) {
    throw new Error("FORCE_HTTPS requires PUBLIC_HTTPS_ORIGIN to be a valid HTTPS origin");
  }
  app.use((req, res, next) => {
    if (req.secure) return next();
    return res.redirect(308, `${publicHttpsOrigin.replace(/\/$/, "")}${req.originalUrl}`);
  });
}

const signupBodyLimit = parseBodySizeLimit(
  process.env.SIGNUP_BODY_LIMIT,
  10 * 1024 * 1024,
  10 * 1024 * 1024,
);
const signupJsonParser = express.json({ limit: signupBodyLimit, strict: true });
const signupFormParser = express.urlencoded({ limit: signupBodyLimit, extended: false, parameterLimit: 200 });
app.use((req, res, next) => {
  const normalizedPath = String(req.path || "/").toLowerCase().replace(/\/+$/, "") || "/";
  if (req.method !== "POST" || normalizedPath !== "/app/signup") return next();
  signupJsonParser(req, res, (jsonError) => {
    if (jsonError) return next(jsonError);
    signupFormParser(req, res, next);
  });
});

function captureRawRequestBody(req, _res, buffer) {
  req.rawBody = Buffer.from(buffer);
}

app.use(express.json({ limit: "256kb", strict: true, verify: captureRawRequestBody }));
app.use(express.urlencoded({
  limit: "256kb",
  extended: false,
  parameterLimit: 100,
  verify: captureRawRequestBody,
}));
app.use("/", routes);

// Handle body-parser errors and unexpected route errors without exposing stack traces.
app.use((error, _req, res, next) => {
  if (res.headersSent) return next(error);
  if (error?.type === "entity.too.large") {
    return res.status(413).send({ error: "request body too large" });
  }
  if (error instanceof SyntaxError && Object.prototype.hasOwnProperty.call(error, "body")) {
    return res.status(400).send({ error: "invalid request body" });
  }
  console.error("Unhandled HTTP request error:", error?.message || "unknown error");
  return res.status(500).send({ error: "internal server error" });
});

async function startServer() {
  try {
    await initDbIfEmpty();
    startSellerLifecycleWorker();
    const database = require("./db").db;
    const recalculatedPriceTargets = await recalculateWatchingPriceTargets(database);
    console.log(`Recalculated ${recalculatedPriceTargets.updated} active individual price target(s) using the current 3x fee rule.`);
    startPriceWorker(database);
    await routes.initializeRechargePayments();
  } catch (error) {
    console.error("Server initialization failed. Server startup aborted:", error);
    process.exit(1);
  }

  const server = app.listen(PORT_SERVER, () => {
    console.log(`Server on port ${PORT_SERVER}`);
    void cleanup();
    setInterval(() => { void cleanup(); }, 3_600_000);
  });
  const requestTimeoutMs = boundedIntegerEnv("HTTP_REQUEST_TIMEOUT_MS", 60_000, 5_000, 120_000);
  const headersTimeoutMs = boundedIntegerEnv("HTTP_HEADERS_TIMEOUT_MS", 15_000, 5_000, 60_000);
  server.requestTimeout = requestTimeoutMs;
  server.headersTimeout = Math.min(requestTimeoutMs, headersTimeoutMs);
  server.keepAliveTimeout = boundedIntegerEnv("HTTP_KEEP_ALIVE_TIMEOUT_MS", 5_000, 1_000, 30_000);
}

startServer();
