"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const routes = fs.readFileSync(path.join(root, "routes.js"), "utf8");
const schema = fs.readFileSync(path.join(root, "db.js"), "utf8");
const limiter = fs.readFileSync(path.join(root, "http-rate-limiter.js"), "utf8");
const envExample = fs.readFileSync(path.join(root, ".env.example"), "utf8");
const termsFr = fs.readFileSync(path.join(root, "terms_fr.html"), "utf8");
const termsEn = fs.readFileSync(path.join(root, "terms_en.html"), "utf8");
const privacyFr = fs.readFileSync(path.join(root, "privacy_fr.html"), "utf8");
const privacyEn = fs.readFileSync(path.join(root, "privacy_en.html"), "utf8");

function blockBetween(source, startText, endText) {
  const start = source.indexOf(startText);
  assert.notEqual(start, -1, `Missing source marker: ${startText}`);
  const end = source.indexOf(endText, start + startText.length);
  assert.notEqual(end, -1, `Missing end marker: ${endText}`);
  return source.slice(start, end);
}

test("account deactivation requires a reason and stores an audited administrative event", () => {
  const adminBlock = blockBetween(
    routes,
    "async function changeAccountAccess(req, res, action)",
    'router.post("/admin/unlock-system-seller"',
  );
  assert.match(adminBlock, /action === "deactivated" && \(normalizedReason\.length < 5 \|\| normalizedReason\.length > 1000\)/);
  assert.match(adminBlock, /account_active=0,account_deactivation_reason=\?,account_deactivated_at_ms=\?/);
  assert.match(adminBlock, /INSERT INTO account_access_events/);
  assert.match(adminBlock, /router\.post\("\/admin\/deactivate-account"/);
  assert.match(adminBlock, /router\.post\("\/admin\/activate-account"/);
  assert.doesNotMatch(routes, /router\.post\("\/admin\/set-user-status"/);
});

test("deactivated accounts return the explicit auths response after password verification", () => {
  const passwordState = blockBetween(
    routes,
    "async function getUserActivityPasswordState(username, submittedPassword)",
    "async function applyWelcomeBonusAtFirstLoginTx",
  );
  assert.ok(passwordState.indexOf("verifySecret(row.password, submittedPassword)") < passwordState.indexOf('return "deactivated"'));
  assert.match(routes, /if \(passwordMatches && Number\(row\.account_active\) !== 1\)\s*\{\s*return \{ response: \{ auths: "deactivated" \} \};/);
  assert.match(limiter, /"POST \/admin\/deactivate-account"/);
  assert.match(limiter, /"POST \/admin\/activate-account"/);
});

test("password and seed management do not reveal deactivation without valid credentials", () => {
  const passwordChange = blockBetween(
    routes,
    'router.post("/app/modify-pin-or-password"',
    'router.post("/app/delete-user"',
  );
  const passwordSeedChange = blockBetween(
    routes,
    'router.post("/app/modify-seed"',
    'router.post("/admin/start-global-disbursement"',
  );
  const recovery = blockBetween(
    routes,
    'router.post("/app/recover-account"',
    'router.post("/app/modify-seed"',
  );
  assert.ok(passwordChange.indexOf("await verifySecret(snapshot.password, P1)") < passwordChange.indexOf("Number(snapshot.account_active) !== 1"));
  assert.ok(passwordSeedChange.indexOf("await verifySecret(snapshot.password, P)") < passwordSeedChange.indexOf("Number(snapshot.account_active) !== 1"));
  assert.ok(recovery.indexOf("await verifySecret(rows[0].seed, S)") < recovery.indexOf("Number(rows[0].account_active) !== 1"));
  assert.match(passwordChange, /return \{ auths: "deactivated" \}/);
  assert.match(passwordSeedChange, /return \{ auths: "deactivated" \}/);
});

test("obsolete admin-fees files are absent from the project", () => {
  const findMatches = (directory) => fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    return entry.isDirectory()
      ? findMatches(entryPath)
      : (/^admin-fees-policy(?:\.test)?\.js$/.test(entry.name) ? [entryPath] : []);
  });
  assert.deepEqual(findMatches(root), []);
});

test("fresh schema persists account access audit and lifetime welcome-credit claims", () => {
  assert.match(schema, /account_deactivation_reason VARCHAR\(1000\) NULL/);
  assert.match(schema, /CREATE TABLE IF NOT EXISTS account_access_events/);
  assert.match(schema, /CREATE TABLE IF NOT EXISTS welcome_bonus_claims/);
  assert.match(schema, /UNIQUE KEY uq_welcome_bonus_subject\(subject_type,subject_hash\)/);
  assert.match(schema, /welcome_bonus_email_hash CHAR\(64\) NOT NULL/);
  assert.match(schema, /welcome_bonus_identity_hash CHAR\(64\) NOT NULL/);
  assert.match(schema, /registration_sequence BIGINT UNSIGNED NOT NULL/);
  assert.match(schema, /UNIQUE KEY uq_auths_registration_sequence\(registration_sequence\)/);
  assert.match(schema, /CREATE TABLE IF NOT EXISTS account_registration_counters/);
  assert.match(schema, /uq_auths_registration_sequence/);
});


test("welcome promotion defaults and public global-disbursement deadlines are documented", () => {
  assert.match(envExample, /^WELCOME_BONUS_BENEFICIARIES=1000$/m);
  assert.match(envExample, /^WELCOME_BONUS_AMOUNT_XTU=0$/m);
  assert.match(termsFr, /au minimum 90 jours/);
  assert.match(termsFr, /extension d'au moins 30 jours/);
  assert.match(termsFr, /aucune nouvelle demande.*ne bénéficie du bonus global/);
  assert.match(termsEn, /at least 90 days/);
  assert.match(termsEn, /extension of at least 30 days/);
  assert.match(termsEn, /do not qualify for the global bonus/);
  assert.match(privacyFr, /motifs et dates de désactivation ou de réactivation/);
  assert.match(privacyEn, /deactivation and reactivation reasons and timestamps/);
});
