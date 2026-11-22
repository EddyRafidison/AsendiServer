"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const routes = fs.readFileSync(path.join(root, "routes.js"), "utf8");
const schema = fs.readFileSync(path.join(root, "db.js"), "utf8");
const limiter = fs.readFileSync(path.join(root, "http-rate-limiter.js"), "utf8");
const securityLimits = fs.readFileSync(path.join(root, "security-limits.js"), "utf8");
const readme = fs.readFileSync(path.join(root, "README.md"), "utf8");
const javaClient = fs.readFileSync(path.join(root, "android-integration", "OneXDeviceAuth.java"), "utf8");

test("device challenge route requires a public key and returns a seed-required decision", () => {
  assert.match(routes, /router\.post\("\/app\/device\/challenge"/);
  assert.match(routes, /device_public_key/);
  assert.match(routes, /seed_required: !registeredDevice/);
  assert.match(limiter, /POST \/app\/device\/challenge/);
});

test("sign-in requires device challenge proof and seed to register or replace a device", () => {
  const signIn = routes.slice(routes.indexOf('router.post("/app/signin"'), routes.indexOf("// user-last-stock"));
  assert.match(signIn, /device_challenge_id/);
  assert.match(signIn, /device_signature/);
  assert.match(signIn, /const requiresSeed = !sameDevice/);
  assert.match(signIn, /verifySecret\(row\.seed, submittedSeed\)/);
  assert.match(signIn, /ON DUPLICATE KEY UPDATE/);
  assert.match(signIn, /session_token_hash=VALUES\(session_token_hash\)/);
  assert.match(signIn, /device_replaced: Boolean\(previousDevice && !sameDevice\)/);
  assert.doesNotMatch(signIn, /String\(recon\)/);
  assert.doesNotMatch(signIn, /encrypt\(ua, P \+ U\)/);
});

test("all protected application routes await the server-side device-bound token validator", () => {
  assert.match(routes, /async function requestTokenIsValid\(/);
  assert.match(routes, /FROM auth_devices WHERE username=\? LIMIT 1 FOR UPDATE/);
  assert.match(routes, /INSERT INTO auth_device_request_nonces/);
  assert.match(routes, /hashRequestBody\(req\.rawBody\)/);
  assert.match(routes, /verifyDeviceSignature\(device\.public_key_der, message, signature\)/);
  assert.doesNotMatch(routes, /if \(!requestTokenIsValid\(/);
});

test("fresh database schema stores one active device, one-time challenges, replay nonces and audit events", () => {
  assert.match(schema, /CREATE TABLE IF NOT EXISTS auth_devices\([\s\S]*?username VARCHAR\(30\) PRIMARY KEY/);
  assert.match(schema, /CREATE TABLE IF NOT EXISTS auth_device_challenges/);
  assert.match(schema, /CREATE TABLE IF NOT EXISTS auth_device_request_nonces/);
  assert.match(schema, /PRIMARY KEY\(username,device_id,nonce\)/);
  assert.match(schema, /CREATE TABLE IF NOT EXISTS auth_device_events/);
  assert.match(schema, /CREATE TABLE IF NOT EXISTS account_security_email_outbox/);
});

test("device replacement queues email and Telegram notifications transactionally", () => {
  const signIn = routes.slice(routes.indexOf('router.post("/app/signin"'), routes.indexOf("// user-last-stock"));
  assert.match(signIn, /INSERT IGNORE INTO account_security_email_outbox/);
  assert.match(signIn, /queueTelegramMessageTx\(tx, U, eventKey, notificationText\)/);
  assert.match(routes, /function startAccountSecurityEmailOutbox\(/);
  assert.match(routes, /startAccountSecurityEmailOutbox\(\)/);
});

test("Java Android helper uses Android Keystore P-256 and signs the documented API protocol", () => {
  assert.match(javaClient, /AndroidKeyStore/);
  assert.match(javaClient, /secp256r1/);
  assert.match(javaClient, /SHA256withECDSA/);
  assert.match(javaClient, /ONEX-API-DEVICE-V1/);
  assert.match(javaClient, /sha256Hex\(exactRequestBody\)/);
  assert.match(javaClient, /X-OneX-Device-Signature/);
  assert.match(javaClient, /AES\/GCM\/NoPadding/);
  assert.match(javaClient, /saveSessionToken/);
  assert.match(javaClient, /loadSessionToken/);
  assert.match(javaClient, /clearSessionToken/);
  assert.doesNotMatch(javaClient, /accountSeed|privateKey.*Base64/);
});

test("security limits include bounded device registration attempts", () => {
  assert.match(securityLimits, /device_registration: Object\.freeze\(\{ maxFailed: 5, maxSuccessful: 5 \}\)/);
});

test("README explains device replacement and client signing contract", () => {
  assert.match(readme, /Single registered Android device and device-bound sessions/);
  assert.match(readme, /POST \/app\/device\/challenge/);
  assert.match(readme, /X-OneX-Device-Nonce/);
  assert.match(readme, /SHA256_HEX_OF_THE_EXACT_HTTP_BODY_BYTES/);
  assert.match(readme, /send those exact bytes without reserializing or changing them/);
  assert.match(readme, /Anyone who knows both the account password and seed/);
});


test("account deletion removes live device credentials while retaining the device audit trail", () => {
  const deletion = routes.slice(routes.indexOf('router.post("/app/delete-user"'), routes.indexOf("// Account recovery"));
  assert.match(deletion, /device_removed_account_deleted/);
  assert.match(deletion, /DELETE FROM auth_device_challenges/);
  assert.match(deletion, /DELETE FROM auth_device_request_nonces/);
  assert.match(deletion, /DELETE FROM auth_devices/);
  assert.doesNotMatch(deletion, /DELETE FROM auth_device_events/);
});
