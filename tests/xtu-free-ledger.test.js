"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { postXtuFreeLedgerEntryTx } = require("../xtu-free-ledger");

class FakeTx {
  constructor() {
    this.balances = new Map();
    this.ledger = [];
    this.nextId = 1;
  }
  async query(sql, params = []) {
    const q = sql.replace(/\s+/g, " ").trim().toLowerCase();
    if (q.startsWith("insert ignore into users_xtu_free_balances")) {
      const [username, created, updated] = params;
      if (!this.balances.has(username)) this.balances.set(username, {
        available_amount: "0", reserved_amount: "0", consumed_amount: "0",
        lifetime_credited_amount: "0", created_at_ms: created, updated_at_ms: updated,
      });
      return [{ affectedRows: 1 }];
    }
    if (q.startsWith("select available_amount,reserved_amount,consumed_amount,lifetime_credited_amount")) {
      const row = this.balances.get(params[0]);
      return [[...(row ? [{ ...row }] : [])]];
    }
    if (q.startsWith("select id,username,entry_type,source_kind,source_id,source_event_identity,attempt_id,attempt_event_id")) {
      const row = this.ledger.find((item) => item.reference === params[0]);
      return [[...(row ? [{ ...row }] : [])]];
    }
    if (q.startsWith("select id,reference from users_xtu_free_ledger where source_event_identity")) {
      const row = this.ledger.find((item) => item.source_event_identity === params[0]);
      return [[...(row ? [{ id: row.id, reference: row.reference }] : [])]];
    }
    if (q.startsWith("insert into users_xtu_free_ledger")) {
      const [reference, username, entry_type, source_kind, source_id, source_event_identity,
        attempt_id, attempt_event_id, reservation_reference, asset_code, source_address,
        token_contract, tx_hash, log_index, gross_amount, tfees_rate_percent, tfees_amount,
        net_amount, available_delta, reserved_delta, consumed_delta, status, reason, created_at_ms] = params;
      const row = { id: this.nextId++, reference, username, entry_type, source_kind, source_id,
        source_event_identity, attempt_id, attempt_event_id, reservation_reference, asset_code,
        source_address, token_contract, tx_hash, log_index, status, reason,
        gross_amount, tfees_rate_percent, tfees_amount, net_amount,
        available_delta, reserved_delta, consumed_delta };
      this.ledger.push(row);
      return [{ insertId: row.id }];
    }
    if (q.startsWith("update users_xtu_free_balances")) {
      const [available, reserved, consumed, lifetime, updatedAt, username] = params;
      const row = this.balances.get(username);
      Object.assign(row, {
        available_amount: available, reserved_amount: reserved, consumed_amount: consumed,
        lifetime_credited_amount: lifetime, updated_at_ms: updatedAt,
      });
      return [{ affectedRows: 1 }];
    }
    throw new Error(`Unexpected fake SQL: ${q}`);
  }
}

test("XTU free ledger credits, reserves, settles and releases atomically", async () => {
  const tx = new FakeTx();
  const credit = await postXtuFreeLedgerEntryTx(tx, {
    username: "alice", reference: "credit-1", entryType: "credit",
    availableDelta: "10", grossAmount: "10", tfeesRatePercent: "0", tfeesAmount: "0", netAmount: "10",
    sourceEventIdentity: "a".repeat(64), attemptId: 1, attemptEventId: 1, nowMs: 100,
  });
  assert.equal(credit.balance.available_amount, "10.000000000000000000");
  assert.equal(credit.balance.lifetime_credited_amount, "10.000000000000000000");

  const reserve = await postXtuFreeLedgerEntryTx(tx, {
    username: "alice", reference: "reserve-1", entryType: "reserve",
    availableDelta: "-4", reservedDelta: "4", netAmount: "4", reservationReference: "reserve-1", nowMs: 101,
  });
  assert.equal(reserve.balance.available_amount, "6.000000000000000000");
  assert.equal(reserve.balance.reserved_amount, "4.000000000000000000");

  const settle = await postXtuFreeLedgerEntryTx(tx, {
    username: "alice", reference: "settle-1", entryType: "settle",
    reservedDelta: "-3", consumedDelta: "3", netAmount: "3", reservationReference: "reserve-1", nowMs: 102,
  });
  assert.equal(settle.balance.reserved_amount, "1.000000000000000000");
  assert.equal(settle.balance.consumed_amount, "3.000000000000000000");

  const release = await postXtuFreeLedgerEntryTx(tx, {
    username: "alice", reference: "release-1", entryType: "release",
    availableDelta: "1", reservedDelta: "-1", netAmount: "1", reservationReference: "reserve-1", nowMs: 103,
  });
  assert.equal(release.balance.available_amount, "7.000000000000000000");
  assert.equal(release.balance.reserved_amount, "0.000000000000000000");
  assert.equal(tx.ledger.length, 4);
});

test("XTU free ledger retries are idempotent and reference conflicts are rejected", async () => {
  const tx = new FakeTx();
  const input = {
    username: "alice", reference: "credit-once", entryType: "credit",
    availableDelta: "1", grossAmount: "1", tfeesRatePercent: "0", tfeesAmount: "0", netAmount: "1",
    sourceEventIdentity: "b".repeat(64), attemptId: 2, attemptEventId: 2, nowMs: 200,
  };
  const first = await postXtuFreeLedgerEntryTx(tx, input);
  const retry = await postXtuFreeLedgerEntryTx(tx, input);
  assert.equal(first.idempotent, false);
  assert.equal(retry.idempotent, true);
  assert.equal(tx.ledger.length, 1);
  await assert.rejects(
    () => postXtuFreeLedgerEntryTx(tx, { ...input, netAmount: "2" }),
    (error) => error.code === "XTU_FREE_IDEMPOTENCY_CONFLICT",
  );
  assert.equal(tx.balances.get("alice").available_amount, "1.000000000000000000");
});

test("an XTU free source event cannot be credited twice under different ledger references", async () => {
  const tx = new FakeTx();
  const sourceEventIdentity = "a".repeat(64);
  await postXtuFreeLedgerEntryTx(tx, {
    username: "alice", reference: "event-credit-1", entryType: "credit",
    sourceEventIdentity, attemptId: 3, attemptEventId: 3, availableDelta: "1", grossAmount: "1",
    tfeesRatePercent: "0", tfeesAmount: "0", netAmount: "1", nowMs: 300,
  });
  await assert.rejects(
    () => postXtuFreeLedgerEntryTx(tx, {
      username: "alice", reference: "event-credit-2", entryType: "credit",
      sourceEventIdentity, attemptId: 3, attemptEventId: 4, availableDelta: "1", grossAmount: "1",
      tfeesRatePercent: "0", tfeesAmount: "0", netAmount: "1", nowMs: 301,
    }),
    (error) => error.code === "XTU_FREE_SOURCE_ALREADY_USED",
  );
  assert.equal(tx.ledger.length, 1);
});

test("the XTU free ledger rejects a reservation beyond the available balance", async () => {
  const tx = new FakeTx();
  await postXtuFreeLedgerEntryTx(tx, {
    username: "alice", reference: "credit-2", entryType: "credit",
    availableDelta: "2", grossAmount: "2", tfeesRatePercent: "0", tfeesAmount: "0", netAmount: "2",
    sourceEventIdentity: "c".repeat(64), attemptId: 4, attemptEventId: 5, nowMs: 400,
  });
  await assert.rejects(
    () => postXtuFreeLedgerEntryTx(tx, {
      username: "alice", reference: "reserve-too-much", entryType: "reserve",
      availableDelta: "-3", reservedDelta: "3", netAmount: "3", reservationReference: "reserve-too-much", nowMs: 401,
    }),
    /cannot become negative/,
  );
  assert.equal(tx.ledger.length, 1);
  assert.equal(tx.balances.get("alice").available_amount, "2.000000000000000000");
});


test("XTU free ledger credits reject a fee that does not match the frozen event rate", async () => {
  const tx = new FakeTx();
  await assert.rejects(
    () => postXtuFreeLedgerEntryTx(tx, {
      username: "alice", reference: "bad-fee-credit", entryType: "credit",
      sourceEventIdentity: "d".repeat(64), attemptId: 5, attemptEventId: 6,
      availableDelta: "0.9", grossAmount: "1", tfeesRatePercent: "5",
      tfeesAmount: "0.01", netAmount: "0.99", nowMs: 500,
    }),
    /must reconcile exactly/,
  );
  assert.equal(tx.ledger.length, 0);
});
