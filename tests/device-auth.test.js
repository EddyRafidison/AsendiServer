"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const {
  createDeviceChallenge,
  buildDeviceChallengeMessage,
  verifyDeviceSignature,
  createSessionToken,
  hashSessionToken,
  timingSafeHexEqual,
  hashRequestBody,
  buildDeviceRequestMessage,
  normalizeDeviceId,
} = require("../device-auth");

function createKeyPair() {
  return crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
}

function sign(privateKey, message) {
  return crypto.sign("sha256", Buffer.from(message, "utf8"), privateKey).toString("base64");
}

test("ECDSA P-256 device challenge is verifiable and bound to the account and installation", () => {
  const pair = createKeyPair();
  const publicKeyBase64 = pair.publicKey.export({ format: "der", type: "spki" }).toString("base64");
  const deviceId = crypto.randomBytes(32).toString("base64url");
  const challenge = createDeviceChallenge({
    username: "USER-ABC123",
    deviceId,
    publicKeyBase64,
    nowMs: 1_700_000_000_000,
  });
  assert.equal(challenge.deviceId, deviceId);
  assert.equal(challenge.publicKeyDerBase64, publicKeyBase64);
  assert.equal(
    challenge.message,
    buildDeviceChallengeMessage({
      username: "USER-ABC123",
      deviceId,
      publicKeyFingerprint: challenge.publicKeyFingerprint,
      challengeId: challenge.challengeId,
      challenge: challenge.challenge,
      expiresAtMs: challenge.expiresAtMs,
    }),
  );
  const signature = sign(pair.privateKey, challenge.message);
  assert.equal(verifyDeviceSignature(publicKeyBase64, challenge.message, signature), true);
  assert.equal(verifyDeviceSignature(publicKeyBase64, `${challenge.message}\nchanged`, signature), false);
});

test("device key validation rejects non-P-256 and malformed public keys", () => {
  const rsa = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const rsaKey = rsa.publicKey.export({ format: "der", type: "spki" }).toString("base64");
  assert.throws(() => createDeviceChallenge({
    username: "USER-ABC123",
    deviceId: crypto.randomBytes(32).toString("base64url"),
    publicKeyBase64: rsaKey,
  }));
  assert.throws(() => createDeviceChallenge({
    username: "USER-ABC123",
    deviceId: crypto.randomBytes(32).toString("base64url"),
    publicKeyBase64: "not-base64",
  }));
});

test("opaque session tokens are random, hashed and compared without timing-sensitive string equality", () => {
  const token = createSessionToken();
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  const digest = hashSessionToken(token);
  assert.match(digest, /^[a-f0-9]{64}$/);
  assert.equal(timingSafeHexEqual(digest, hashSessionToken(token)), true);
  assert.equal(timingSafeHexEqual(digest, hashSessionToken(createSessionToken())), false);
  assert.throws(() => hashSessionToken("old-aes-token"));
});

test("protected request signature message is deterministic and includes token, path, timestamp, nonce and exact body hash", () => {
  const values = {
    method: "POST",
    originalUrl: "/app/user-last-stock",
    timestamp: "1700000000000",
    nonce: crypto.randomBytes(32).toString("base64url"),
    token: createSessionToken(),
    bodyHash: hashRequestBody(Buffer.from('{"user":"USER-ABC123"}', "utf8")),
  };
  const message = buildDeviceRequestMessage(values);
  assert.equal(message, [
    "ONEX-API-DEVICE-V1", "POST", values.originalUrl,
    values.timestamp, values.nonce, values.token, values.bodyHash,
  ].join("\n"));
  assert.equal(normalizeDeviceId(values.nonce), values.nonce);
  const pair = createKeyPair();
  const publicKeyBase64 = pair.publicKey.export({ format: "der", type: "spki" }).toString("base64");
  const requestSignature = sign(pair.privateKey, message);
  assert.equal(verifyDeviceSignature(publicKeyBase64, message, requestSignature), true);
  const changedBodyMessage = buildDeviceRequestMessage({
    ...values,
    bodyHash: hashRequestBody(Buffer.from('{"user":"OTHER-USER"}', "utf8")),
  });
  assert.equal(verifyDeviceSignature(publicKeyBase64, changedBodyMessage, requestSignature), false);
  assert.throws(() => buildDeviceRequestMessage({ ...values, timestamp: "1" }));
  assert.throws(() => buildDeviceRequestMessage({ ...values, bodyHash: "invalid" }));
  assert.throws(() => hashRequestBody("not the captured body"));
  assert.notEqual(hashRequestBody(Buffer.from("a")), hashRequestBody(Buffer.from("b")));
});
