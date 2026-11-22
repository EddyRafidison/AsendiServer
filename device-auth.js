"use strict";

const crypto = require("crypto");

const DEVICE_CHALLENGE_TTL_MS = 5 * 60 * 1000;
const DEVICE_REQUEST_CLOCK_SKEW_MS = 90 * 1000;
const DEVICE_REQUEST_NONCE_TTL_MS = 10 * 60 * 1000;

function normalizeDeviceId(value) {
  if (typeof value !== "string") return "";
  const deviceId = value.trim();
  return /^[A-Za-z0-9_-]{22,80}$/.test(deviceId) ? deviceId : "";
}

function decodePublicKey(publicKeyBase64) {
  if (typeof publicKeyBase64 !== "string" || publicKeyBase64.length > 4096) {
    throw new TypeError("A valid device public key is required.");
  }
  const value = publicKeyBase64.trim();
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new TypeError("Device public key must be base64-encoded DER.");
  }
  const der = Buffer.from(value, "base64");
  if (!der.length || der.length > 2048 || der.toString("base64") !== value) {
    throw new TypeError("Device public key encoding is invalid.");
  }
  const key = crypto.createPublicKey({ key: der, format: "der", type: "spki" });
  if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1") {
    throw new TypeError("Only ECDSA P-256 device keys are accepted.");
  }
  return { der, key, canonicalBase64: der.toString("base64") };
}

function fingerprintPublicKey(publicKeyBase64) {
  const { der } = decodePublicKey(publicKeyBase64);
  return crypto.createHash("sha256").update(der).digest("hex");
}

function buildDeviceChallengeMessage({ username, deviceId, publicKeyFingerprint, challengeId, challenge, expiresAtMs }) {
  return [
    "ONEX-DEVICE-REGISTER-V1",
    username,
    deviceId,
    publicKeyFingerprint,
    challengeId,
    challenge,
    String(expiresAtMs),
  ].join("\n");
}

function createDeviceChallenge({ username, deviceId, publicKeyBase64, nowMs = Date.now(), ttlMs = DEVICE_CHALLENGE_TTL_MS }) {
  const normalizedDeviceId = normalizeDeviceId(deviceId);
  if (!normalizedDeviceId) throw new TypeError("Invalid device identifier.");
  if (typeof username !== "string" || username.length < 1 || username.length > 30 || /[\r\n]/.test(username)) {
    throw new TypeError("Invalid username.");
  }
  if (!Number.isSafeInteger(nowMs) || !Number.isInteger(ttlMs) || ttlMs < 30_000 || ttlMs > 10 * 60_000) {
    throw new RangeError("Invalid device challenge timing.");
  }

  const publicKey = decodePublicKey(publicKeyBase64);
  const challengeId = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto.randomBytes(32).toString("base64url");
  const expiresAtMs = nowMs + ttlMs;
  const fingerprint = crypto.createHash("sha256").update(publicKey.der).digest("hex");
  const message = buildDeviceChallengeMessage({
    username,
    deviceId: normalizedDeviceId,
    publicKeyFingerprint: fingerprint,
    challengeId,
    challenge,
    expiresAtMs,
  });

  return {
    challengeId,
    challenge,
    challengeHash: crypto.createHash("sha256").update(challenge).digest("hex"),
    expiresAtMs,
    deviceId: normalizedDeviceId,
    publicKeyDerBase64: publicKey.canonicalBase64,
    publicKeyFingerprint: fingerprint,
    message,
  };
}

function verifyDeviceSignature(publicKeyBase64, message, signatureBase64) {
  if (typeof message !== "string" || Buffer.byteLength(message, "utf8") > 4096) return false;
  if (typeof signatureBase64 !== "string" || signatureBase64.length > 512) return false;
  try {
    const { key } = decodePublicKey(publicKeyBase64);
    const signature = Buffer.from(signatureBase64, "base64");
    if (!signature.length || signature.length > 128 || signature.toString("base64") !== signatureBase64) return false;
    return crypto.verify("sha256", Buffer.from(message, "utf8"), key, signature);
  } catch {
    return false;
  }
}

function createSessionToken() {
  return crypto.randomBytes(32).toString("base64url");
}

function hashSessionToken(token) {
  if (typeof token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(token)) {
    throw new TypeError("Invalid device session token.");
  }
  return crypto.createHash("sha256").update(token, "utf8").digest("hex");
}

function timingSafeHexEqual(left, right) {
  if (typeof left !== "string" || typeof right !== "string" || !/^[a-f0-9]{64}$/i.test(left) || !/^[a-f0-9]{64}$/i.test(right)) {
    return false;
  }
  return crypto.timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

function hashRequestBody(body) {
  if (!Buffer.isBuffer(body) || body.length > 256 * 1024) {
    throw new TypeError("A captured HTTP request body is required.");
  }
  return crypto.createHash("sha256").update(body).digest("hex");
}

function buildDeviceRequestMessage({ method, originalUrl, timestamp, nonce, token, bodyHash }) {
  if (
    typeof method !== "string" || typeof originalUrl !== "string" || originalUrl.length > 2048 ||
    !/^\d{13}$/.test(String(timestamp)) || typeof nonce !== "string" ||
    !/^[A-Za-z0-9_-]{22,80}$/.test(nonce) || typeof token !== "string" || token.length > 128 ||
    typeof bodyHash !== "string" || !/^[a-f0-9]{64}$/.test(bodyHash)
  ) throw new TypeError("Invalid device request signature fields.");
  return [
    "ONEX-API-DEVICE-V1",
    method.toUpperCase(),
    originalUrl,
    String(timestamp),
    nonce,
    token,
    bodyHash,
  ].join("\n");
}

module.exports = {
  DEVICE_CHALLENGE_TTL_MS,
  DEVICE_REQUEST_CLOCK_SKEW_MS,
  DEVICE_REQUEST_NONCE_TTL_MS,
  normalizeDeviceId,
  decodePublicKey,
  fingerprintPublicKey,
  createDeviceChallenge,
  buildDeviceChallengeMessage,
  verifyDeviceSignature,
  createSessionToken,
  hashSessionToken,
  timingSafeHexEqual,
  hashRequestBody,
  buildDeviceRequestMessage,
};
