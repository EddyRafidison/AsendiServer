"use strict";

const METRICS_LOG_INTERVAL_MS = 60 * 60 * 1000;
const STALE_REQUEST_AFTER_MS = 120000;
const attachedProviders = new WeakMap();
let currentWindow = createWindow();
let processWindow = createWindow();
let previousWindow = null;
let metricsTimer = null;

function createWindow() {
  return {
    startedAtMs: Date.now(),
    requests: 0,
    errors: 0,
    rateLimited: 0,
    transportErrors: 0,
    transportRateLimited: 0,
    methods: new Map(),
  };
}

function getHostLabel(rpcUrl) {
  try {
    return new URL(rpcUrl).host.toLowerCase();
  } catch {
    return "unknown-provider";
  }
}

function ensureMetricsTimer() {
  if (metricsTimer) return;
  metricsTimer = setInterval(() => {
    const snapshot = getCurrentSnapshot();
    if (snapshot.requests > 0 || snapshot.transport_errors_unattributed > 0) {
      previousWindow = snapshot;
      console.info(`ONEX_BSC_ETHERS_RPC_METRICS ${JSON.stringify(snapshot)}`);
    }
    currentWindow = createWindow();
  }, METRICS_LOG_INTERVAL_MS);
  if (typeof metricsTimer.unref === "function") metricsTimer.unref();
}

function getMethodMetricsKey(service, provider, method) {
  return `${service}|${provider}|${method}`;
}

function updateWindow(window, request, outcome) {
  const key = getMethodMetricsKey(request.service, request.provider, request.method);
  let metrics = window.methods.get(key);
  if (!metrics) {
    metrics = {
      service: request.service,
      provider: request.provider,
      method: request.method,
      requests: 0,
      errors: 0,
      rateLimited: 0,
      timeouts: 0,
      totalDurationMs: 0,
      maxDurationMs: 0,
      requestBytes: 0,
      responseBytes: 0,
    };
    window.methods.set(key, metrics);
  }

  metrics.requests += 1;
  metrics.totalDurationMs += outcome.durationMs;
  metrics.maxDurationMs = Math.max(metrics.maxDurationMs, outcome.durationMs);
  metrics.requestBytes += request.requestBytes;
  metrics.responseBytes += outcome.responseBytes;
  window.requests += 1;

  if (outcome.error) {
    metrics.errors += 1;
    window.errors += 1;
    const message = String(outcome.error.message || outcome.error).toLowerCase();
    if (/rate.?limit|too many requests|http 429|quota exceeded/.test(message)) {
      metrics.rateLimited += 1;
      window.rateLimited += 1;
    }
    if (/timeout|timed out/.test(message)) metrics.timeouts += 1;
  }
}

function recordUnattributedTransportError(error) {
  const message = String(error?.message || error || "Ethers JSON-RPC transport error.").toLowerCase();
  for (const window of [currentWindow, processWindow]) {
    window.transportErrors += 1;
    if (/rate.?limit|too many requests|http 429|quota exceeded/.test(message)) {
      window.transportRateLimited += 1;
    }
  }
}

function finishRequest(request, error, responseBytes) {
  const outcome = {
    error: error || null,
    responseBytes: Number(responseBytes || 0),
    durationMs: Math.max(0, Date.now() - request.startedAtMs),
  };
  updateWindow(currentWindow, request, outcome);
  updateWindow(processWindow, request, outcome);
}

function jsonByteLength(value) {
  try {
    return Buffer.byteLength(JSON.stringify(value));
  } catch {
    return 0;
  }
}

function asPayloadArray(payload) {
  if (Array.isArray(payload)) return payload;
  return payload && typeof payload === "object" ? [payload] : [];
}

function attachEthersRpcMetrics(provider, rpcUrl, serviceName) {
  if (!provider || typeof provider.on !== "function") return false;
  if (attachedProviders.has(provider)) return true;

  const session = {
    service: String(serviceName || "bsc-worker").slice(0, 40),
    provider: getHostLabel(rpcUrl),
    pending: new Map(),
  };

  const onDebug = (event) => {
    if (!event || typeof event !== "object") return;
    const now = Date.now();

    for (const [id, pending] of session.pending.entries()) {
      if (now - pending.startedAtMs > STALE_REQUEST_AFTER_MS) {
        finishRequest(pending, new Error("Ethers JSON-RPC request timed out before a response event."), 0);
        session.pending.delete(id);
      }
    }

    if (event.action === "sendRpcPayload") {
      for (const payload of asPayloadArray(event.payload)) {
        if (!payload || payload.id == null || typeof payload.method !== "string") continue;
        session.pending.set(String(payload.id), {
          service: session.service,
          provider: session.provider,
          method: payload.method,
          startedAtMs: now,
          requestBytes: jsonByteLength(payload),
        });
      }
      return;
    }

    if (event.action === "receiveRpcResult") {
      const results = asPayloadArray(event.result);
      for (const result of results) {
        if (!result || result.id == null) continue;
        const id = String(result.id);
        const request = session.pending.get(id);
        if (!request) continue;
        const rpcError = result.error
          ? new Error(String(result.error.message || "Ethers JSON-RPC returned an error."))
          : null;
        finishRequest(request, rpcError, jsonByteLength(result));
        session.pending.delete(id);
      }
      return;
    }

    if (event.action === "receiveRpcError") {
      // Ethers v6 does not expose request IDs in receiveRpcError. Do not mark
      // every in-flight request as failed: other batches may still be pending.
      // Count this transport event separately; unresolved requests are marked
      // as timed out only if they remain unanswered beyond the timeout window.
      recordUnattributedTransportError(event.error);
    }
  };

  try {
    const registration = provider.on("debug", onDebug);
    if (registration && typeof registration.catch === "function") {
      registration.catch((error) => console.warn("Unable to attach BSC RPC metrics listener:", error.message));
    }
    attachedProviders.set(provider, { session, onDebug });
    ensureMetricsTimer();
    return true;
  } catch (error) {
    console.warn("Unable to attach BSC RPC metrics listener:", error.message);
    return false;
  }
}

function snapshotWindow(window) {
  const methods = {};
  for (const [key, value] of window.methods.entries()) {
    methods[key] = {
      ...value,
      averageDurationMs: value.requests
        ? Number((value.totalDurationMs / value.requests).toFixed(2))
        : 0,
    };
  }
  return {
    window_started_at_ms: String(window.startedAtMs),
    captured_at_ms: String(Date.now()),
    requests: window.requests,
    errors: window.errors,
    rate_limited: window.rateLimited,
    transport_errors_unattributed: window.transportErrors,
    transport_rate_limited_unattributed: window.transportRateLimited,
    methods,
  };
}

function getCurrentSnapshot() {
  return snapshotWindow(currentWindow);
}

function getBscEthersRpcMetricsAdminSnapshot() {
  return {
    since_process_start: snapshotWindow(processWindow),
    current_window: getCurrentSnapshot(),
    previous_window: previousWindow,
  };
}

module.exports = {
  attachEthersRpcMetrics,
  getBscEthersRpcMetricsAdminSnapshot,
};
