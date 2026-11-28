"use strict";

const BigNumber = require("bignumber.js");
const { calculateXtuFreeBalanceTransition } = require("./xtu-free-accounting");

const ENTRY_TYPES = new Set(["credit", "reserve", "settle", "release", "adjustment"]);

function decimal18(value, fieldName, allowNegative = false) {
  const parsed = new BigNumber(String(value ?? "0"));
  if (!parsed.isFinite() || (!allowNegative && parsed.isNegative()) || parsed.decimalPlaces() > 18) {
    throw new RangeError(`${fieldName} must be a valid decimal with at most 18 fractional digits.`);
  }
  return parsed;
}

function sameDecimal(a, b) {
  return new BigNumber(String(a ?? "0")).eq(String(b ?? "0"));
}

/**
 * Append one immutable XTU-free ledger entry and update its aggregate balance.
 * The caller MUST invoke this helper inside an existing SQL transaction.
 */
async function postXtuFreeLedgerEntryTx(tx, input) {
  const username = String(input?.username ?? "").trim();
  const reference = String(input?.reference ?? "").trim();
  const entryType = String(input?.entryType ?? "").trim().toLowerCase();
  if (!username || username.length > 30 || !reference || reference.length > 64 || !ENTRY_TYPES.has(entryType)) {
    throw new TypeError("A valid username, reference and XTU-free ledger entry type are required.");
  }

  const availableDelta = decimal18(input.availableDelta ?? "0", "availableDelta", true);
  const reservedDelta = decimal18(input.reservedDelta ?? "0", "reservedDelta", true);
  const consumedDelta = decimal18(input.consumedDelta ?? "0", "consumedDelta", true);
  const grossAmount = decimal18(input.grossAmount ?? "0", "grossAmount");
  const tfeesRatePercent = decimal18(input.tfeesRatePercent ?? "0", "tfeesRatePercent");
  const tfeesAmount = decimal18(input.tfeesAmount ?? "0", "tfeesAmount");
  const netAmount = decimal18(input.netAmount ?? "0", "netAmount");
  const sourceEventIdentity = input.sourceEventIdentity == null ? null : String(input.sourceEventIdentity).trim().toLowerCase();
  if (sourceEventIdentity !== null && !/^[0-9a-f]{64}$/.test(sourceEventIdentity)) {
    throw new TypeError("sourceEventIdentity must be a 32-byte lowercase hex digest.");
  }
  if (tfeesRatePercent.gt("100")) throw new RangeError("XTU-free receive tfees cannot exceed 100 percent.");
  if (entryType === "adjustment" && !String(input.reason ?? "").trim()) {
    throw new TypeError("An XTU-free ledger adjustment requires an audit reason.");
  }
  if (entryType === "credit") {
    const attemptId = Number(input.attemptId);
    const attemptEventId = Number(input.attemptEventId);
    if (!sourceEventIdentity || !Number.isSafeInteger(attemptId) || attemptId <= 0 ||
        !Number.isSafeInteger(attemptEventId) || attemptEventId <= 0) {
      throw new TypeError("An XTU-free credit must identify its unique source event, deposit attempt and attempt event.");
    }
    const expectedFee = grossAmount.multipliedBy(tfeesRatePercent).dividedBy(100)
      .decimalPlaces(18, BigNumber.ROUND_DOWN);
    if (!grossAmount.isGreaterThan(0) || !expectedFee.eq(tfeesAmount) ||
        !netAmount.eq(grossAmount.minus(tfeesAmount)) || !netAmount.eq(availableDelta)) {
      throw new RangeError("XTU-free credit gross, frozen tfees rate, fee, net and available delta must reconcile exactly.");
    }
  }
  if (["reserve", "settle", "release"].includes(entryType)) {
    const reservationReference = String(input.reservationReference ?? "").trim();
    if (!reservationReference || reservationReference.length > 64) {
      throw new TypeError(`An XTU-free ${entryType} entry must reference its reservation.`);
    }
    if (!netAmount.isGreaterThan(0)) throw new RangeError(`XTU-free ${entryType} entries require a positive netAmount.`);
    if (entryType === "reserve" && !netAmount.eq(reservedDelta)) {
      throw new RangeError("XTU-free reserve netAmount must equal reservedDelta.");
    }
    if (entryType === "settle" && !netAmount.eq(consumedDelta)) {
      throw new RangeError("XTU-free settle netAmount must equal consumedDelta.");
    }
    if (entryType === "release" && !netAmount.eq(reservedDelta.negated())) {
      throw new RangeError("XTU-free release netAmount must equal the amount released from reserved balance.");
    }
  }

  const now = String(input.nowMs ?? Date.now());
  await tx.query(
    `INSERT IGNORE INTO users_xtu_free_balances
       (username,available_amount,reserved_amount,consumed_amount,lifetime_credited_amount,created_at_ms,updated_at_ms)
     VALUES(?,0,0,0,0,?,?)`,
    [username, now, now],
  );
  const [balanceRows] = await tx.query(
    `SELECT available_amount,reserved_amount,consumed_amount,lifetime_credited_amount
     FROM users_xtu_free_balances WHERE username=? LIMIT 1 FOR UPDATE`,
    [username],
  );
  if (!balanceRows.length) throw new Error("XTU-free balance row could not be locked.");

  const [existingRows] = await tx.query(
    `SELECT id,username,entry_type,source_kind,source_id,source_event_identity,attempt_id,attempt_event_id,
            reservation_reference,asset_code,source_address,token_contract,tx_hash,log_index,status,reason,
            available_delta,reserved_delta,consumed_delta,gross_amount,tfees_rate_percent,tfees_amount,net_amount
     FROM users_xtu_free_ledger WHERE reference=? LIMIT 1 FOR UPDATE`,
    [reference],
  );
  if (existingRows.length) {
    const old = existingRows[0];
    const sameNullable = (left, right) => left == null && right == null || String(left) === String(right);
    const exact = old.username === username && old.entry_type === entryType &&
      sameNullable(old.source_kind, input.sourceKind || null) &&
      sameNullable(old.source_id, input.sourceId ?? null) &&
      sameNullable(old.source_event_identity, sourceEventIdentity) &&
      sameNullable(old.attempt_id, input.attemptId ?? null) &&
      sameNullable(old.attempt_event_id, input.attemptEventId ?? null) &&
      sameNullable(old.reservation_reference, input.reservationReference || null) &&
      old.asset_code === "XTU" &&
      sameNullable(old.source_address, input.sourceAddress || null) &&
      sameNullable(old.token_contract, input.tokenContract || null) &&
      sameNullable(old.tx_hash, input.txHash || null) &&
      sameNullable(old.log_index, input.logIndex ?? null) &&
      old.status === (input.status || "confirmed") &&
      sameNullable(old.reason, input.reason || null) &&
      sameDecimal(old.available_delta, availableDelta) &&
      sameDecimal(old.reserved_delta, reservedDelta) &&
      sameDecimal(old.consumed_delta, consumedDelta) &&
      sameDecimal(old.gross_amount, grossAmount) &&
      sameDecimal(old.tfees_rate_percent, tfeesRatePercent) &&
      sameDecimal(old.tfees_amount, tfeesAmount) &&
      sameDecimal(old.net_amount, netAmount);
    if (!exact) throw Object.assign(new Error("XTU-free ledger reference was reused with different values."), { code: "XTU_FREE_IDEMPOTENCY_CONFLICT" });
    return { id: String(old.id), idempotent: true, balance: balanceRows[0] };
  }

  if (sourceEventIdentity) {
    const [sourceRows] = await tx.query(
      "SELECT id,reference FROM users_xtu_free_ledger WHERE source_event_identity=? LIMIT 1 FOR UPDATE",
      [sourceEventIdentity],
    );
    if (sourceRows.length) {
      throw Object.assign(new Error("The XTU-free source event has already been journaled."), { code: "XTU_FREE_SOURCE_ALREADY_USED" });
    }
  }

  let transition;
  if (entryType === "adjustment") {
    const current = balanceRows[0];
    const next = {
      available: new BigNumber(current.available_amount).plus(availableDelta),
      reserved: new BigNumber(current.reserved_amount).plus(reservedDelta),
      consumed: new BigNumber(current.consumed_amount).plus(consumedDelta),
    };
    for (const [field, value] of Object.entries(next)) {
      if (!value.isFinite() || value.isNegative()) throw new RangeError(`XTU-free ${field} balance cannot become negative.`);
    }
    transition = { ...next, availableDelta, reservedDelta, consumedDelta };
  } else {
    const operation = entryType === "credit" ? "credit" : entryType;
    const amountToMove = netAmount;
    transition = calculateXtuFreeBalanceTransition({
      available: balanceRows[0].available_amount,
      reserved: balanceRows[0].reserved_amount,
      consumed: balanceRows[0].consumed_amount,
    }, operation, amountToMove);
    if (!transition.availableDelta.eq(availableDelta) || !transition.reservedDelta.eq(reservedDelta) || !transition.consumedDelta.eq(consumedDelta)) {
      throw new RangeError(`XTU-free ${entryType} ledger deltas do not match the canonical balance transition.`);
    }
  }

  const lifetimeCreditedDelta = entryType === "credit" ? transition.availableDelta : new BigNumber(0);
  const nextLifetimeCredited = new BigNumber(balanceRows[0].lifetime_credited_amount).plus(lifetimeCreditedDelta);
  if (nextLifetimeCredited.isNegative()) throw new RangeError("XTU-free lifetime credited amount cannot become negative.");

  const [insertResult] = await tx.query(
    `INSERT INTO users_xtu_free_ledger(
       reference,username,entry_type,source_kind,source_id,source_event_identity,attempt_id,attempt_event_id,
       reservation_reference,asset_code,source_address,token_contract,tx_hash,log_index,
       gross_amount,tfees_rate_percent,tfees_amount,net_amount,available_delta,reserved_delta,consumed_delta,
       status,reason,created_at_ms
     ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [reference, username, entryType, input.sourceKind || null, input.sourceId ?? null, sourceEventIdentity,
      input.attemptId ?? null, input.attemptEventId ?? null, input.reservationReference || null, "XTU",
      input.sourceAddress || null, input.tokenContract || null, input.txHash || null, input.logIndex ?? null,
      grossAmount.toFixed(18), tfeesRatePercent.toFixed(6), tfeesAmount.toFixed(18), netAmount.toFixed(18),
      transition.availableDelta.toFixed(18), transition.reservedDelta.toFixed(18), transition.consumedDelta.toFixed(18),
      input.status || "confirmed", input.reason || null, now],
  );

  await tx.query(
    `UPDATE users_xtu_free_balances
     SET available_amount=?,reserved_amount=?,consumed_amount=?,lifetime_credited_amount=?,updated_at_ms=?
     WHERE username=?`,
    [transition.available.toFixed(18), transition.reserved.toFixed(18), transition.consumed.toFixed(18),
      nextLifetimeCredited.toFixed(18), now, username],
  );

  return {
    id: String(insertResult.insertId),
    idempotent: false,
    balance: {
      available_amount: transition.available.toFixed(18),
      reserved_amount: transition.reserved.toFixed(18),
      consumed_amount: transition.consumed.toFixed(18),
      lifetime_credited_amount: nextLifetimeCredited.toFixed(18),
    },
  };
}

module.exports = { postXtuFreeLedgerEntryTx };
