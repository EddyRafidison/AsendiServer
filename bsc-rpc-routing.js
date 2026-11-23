"use strict";

function clean(value) {
  return String(value || "").trim();
}

function resolveIncomingRpcConfiguration(env = process.env) {
  const explicitIncomingUrl = clean(env.BSC_INCOMING_RPC_URL);
  const outgoingPrimaryUrl = clean(env.BSC_RPC_URL);
  const legacyFallbackUrl = clean(env.BSC_RPC_FALLBACK_URL);
  const explicitIncomingFallbackUrl = clean(env.BSC_INCOMING_RPC_FALLBACK_URL);

  // Backward compatibility: without the new incoming setting, BSC_RPC_URL
  // remains the scanner's primary endpoint as it was in previous releases.
  const primaryUrl = explicitIncomingUrl || outgoingPrimaryUrl || legacyFallbackUrl;
  const fallbackUrl = explicitIncomingFallbackUrl || legacyFallbackUrl ||
    (explicitIncomingUrl ? outgoingPrimaryUrl : "");
  const urls = [...new Set([primaryUrl, fallbackUrl].filter(Boolean))];
  const websocketUrl = clean(env.BSC_INCOMING_WS_RPC_URL || env.BSC_WS_RPC_URL);

  return {
    primaryUrl: urls[0] || "",
    fallbackUrl: urls[1] || "",
    urls,
    websocketUrl,
    usesExplicitIncomingPrimary: Boolean(explicitIncomingUrl),
  };
}

function validateHttpsRpcUrls(urls) {
  if (!Array.isArray(urls) || urls.length === 0) {
    throw new Error("At least one incoming BSC HTTPS RPC endpoint is required.");
  }
  for (const [index, value] of urls.entries()) {
    let parsed;
    try {
      parsed = new URL(value);
    } catch {
      throw new Error(`Incoming BSC RPC endpoint ${index + 1} is not a valid URL.`);
    }
    if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
      throw new Error(`Incoming BSC RPC endpoint ${index + 1} must be an HTTPS URL without embedded credentials.`);
    }
  }
}

function validateWssRpcUrl(value) {
  if (!value) return;
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("BSC_INCOMING_WS_RPC_URL is not a valid URL.");
  }
  if (parsed.protocol !== "wss:" || parsed.username || parsed.password) {
    throw new Error("BSC_INCOMING_WS_RPC_URL must use secure WebSocket (wss) without embedded credentials.");
  }
}

function createRpcFailoverState(urls, cooldownMs = 30000) {
  if (!Array.isArray(urls) || !urls.length) throw new TypeError("At least one RPC URL is required.");
  if (!Number.isInteger(cooldownMs) || cooldownMs < 5000 || cooldownMs > 300000) {
    throw new RangeError("RPC failover cooldown must be between 5000 and 300000 milliseconds.");
  }
  return {
    cooldownMs,
    endpoints: urls.map((url) => ({
      url,
      consecutiveFailures: 0,
      openUntilMs: 0,
      disabled: false,
      lastError: null,
      lastSuccessAtMs: 0,
    })),
  };
}

function isTransientRpcError(error) {
  const status = Number(error?.httpStatus || 0);
  if ([408, 425, 429].includes(status) || status >= 500) return true;

  const code = Number(error?.rpcCode ?? error?.code);
  if (code === -32005 || code === -32016) return true;

  const message = String(error?.message || error || "").toLowerCase();
  return /rate.?limit|too many requests|quota exceeded|timed? ?out|timeout|econnreset|econnrefused|ehostunreach|enotfound|socket hang up|network error|service unavailable|gateway timeout|bad gateway|temporarily unavailable|invalid json|query returned more|too many results|limit exceeded|response exceeded the size limit/.test(message);
}

function isPermanentRpcConfigurationError(error) {
  const status = Number(error?.httpStatus || 0);
  if ([401, 403, 404].includes(status)) return true;
  const message = String(error?.message || error || "").toLowerCase();
  return /not on chain|not bnb smart chain|contract is not deployed|must use 18 decimals|invalid api key|unauthorized|authentication failed/.test(message);
}

function shouldTryRpcFallback(error) {
  return isTransientRpcError(error) || isPermanentRpcConfigurationError(error);
}

function getRpcCandidates(state, nowMs = Date.now()) {
  const available = state.endpoints.filter((endpoint) =>
    !endpoint.disabled && endpoint.openUntilMs <= nowMs,
  );
  return available.map((endpoint) => endpoint.url);
}

function recordRpcSuccess(state, url, nowMs = Date.now()) {
  const endpoint = state.endpoints.find((item) => item.url === url);
  if (!endpoint) return;
  endpoint.consecutiveFailures = 0;
  endpoint.openUntilMs = 0;
  endpoint.lastError = null;
  endpoint.lastSuccessAtMs = nowMs;
}

function recordRpcFailure(state, url, error, nowMs = Date.now()) {
  const endpoint = state.endpoints.find((item) => item.url === url);
  if (!endpoint) return { opened: false, disabled: false };
  endpoint.lastError = String(error?.message || error || "RPC request failed.").slice(0, 300);

  if (isPermanentRpcConfigurationError(error)) {
    endpoint.disabled = true;
    endpoint.openUntilMs = Number.MAX_SAFE_INTEGER;
    return { opened: true, disabled: true };
  }
  if (!isTransientRpcError(error)) return { opened: false, disabled: false };

  endpoint.consecutiveFailures += 1;
  endpoint.openUntilMs = nowMs + state.cooldownMs;
  return { opened: true, disabled: false };
}

function getRpcFailoverStatus(state, nowMs = Date.now()) {
  return state.endpoints.map((endpoint) => ({
    host: (() => {
      try { return new URL(endpoint.url).host.toLowerCase(); } catch { return "unknown-provider"; }
    })(),
    disabled: endpoint.disabled,
    circuit_open: !endpoint.disabled && endpoint.openUntilMs > nowMs,
    retry_at_ms: endpoint.openUntilMs > 0 && endpoint.openUntilMs < Number.MAX_SAFE_INTEGER
      ? endpoint.openUntilMs
      : null,
    consecutive_failures: endpoint.consecutiveFailures,
    last_success_at_ms: endpoint.lastSuccessAtMs || null,
    last_error: endpoint.lastError,
  }));
}

module.exports = {
  resolveIncomingRpcConfiguration,
  validateHttpsRpcUrls,
  validateWssRpcUrl,
  createRpcFailoverState,
  isTransientRpcError,
  isPermanentRpcConfigurationError,
  shouldTryRpcFallback,
  getRpcCandidates,
  recordRpcSuccess,
  recordRpcFailure,
  getRpcFailoverStatus,
};
