"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { recordUserOperationTx } = require("../user-price-accounting");

function createStateTx(overrides = {}) {
  const state = {
    username: "USER001",
    cycle_number: 3,
    base_price: "1.2",
    tfees_rate: "3",
    remuneration_rate: "9",
    target_price: "1.308",
    status: "paused",
    start_price_event_id: "40",
    triggered_price: "1.308",
    triggered_at_ms: "1000",
    frozen_price: "1.308",
    sale_group_base_initial_asset: null,
    sale_group_volume_initial_asset: "0",
    sale_group_fee_weighted: "0",
    purchase_group_base_initial_asset: null,
    purchase_group_volume_initial_asset: "0",
    purchase_group_fee_weighted: "0",
    ...overrides,
  };
  const calls = [];
  return {
    state,
    calls,
    async query(sql, params = []) {
      const normalized = String(sql).replace(/\s+/g, " ").trim();
      calls.push({ sql: normalized, params });
      if (normalized.startsWith("SELECT username FROM user_price_state")) {
        return [[{ username: state.username }], []];
      }
      if (normalized.startsWith("SELECT * FROM user_price_state")) return [[{ ...state }], []];
      if (normalized.startsWith("SELECT COALESCE(MAX(id),0) AS id FROM common_price_events")) {
        return [[{ id: "42" }], []];
      }
      if (normalized.startsWith("UPDATE user_price_state SET sale_group_base_initial_asset=?") ||
          normalized.startsWith("UPDATE user_price_state SET purchase_group_base_initial_asset=?")) {
        const prefix = normalized.includes("sale_group_base_initial_asset") ? "sale" : "purchase";
        state[`${prefix}_group_base_initial_asset`] = params[0];
        state[`${prefix}_group_volume_initial_asset`] = params[1];
        state[`${prefix}_group_fee_weighted`] = params[2];
        return [{ affectedRows: 1 }, []];
      }
      if (normalized.startsWith("UPDATE user_price_cycle_history SET principal_before_operation")) {
        return [{ affectedRows: 1 }, []];
      }
      if (normalized.startsWith("UPDATE user_price_cycle_history SET resumed_at_ms=?")) {
        return [{ affectedRows: 1 }, []];
      }
      if (normalized.startsWith("UPDATE user_price_state SET cycle_number=?")) {
        state.cycle_number = Number(params[0]);
        state.base_price = params[1];
        state.tfees_rate = params[2];
        state.remuneration_rate = params[3];
        state.target_price = params[4];
        state.status = "watching";
        state.start_price_event_id = params[5];
        state.triggered_price = null;
        state.triggered_at_ms = null;
        state.frozen_price = null;
        state.sale_group_base_initial_asset = null;
        state.sale_group_volume_initial_asset = "0";
        state.sale_group_fee_weighted = "0";
        state.purchase_group_base_initial_asset = null;
        state.purchase_group_volume_initial_asset = "0";
        state.purchase_group_fee_weighted = "0";
        return [{ affectedRows: 1 }, []];
      }
      if (normalized.startsWith("INSERT IGNORE INTO telegram_outbox")) return [{ affectedRows: 1 }, []];
      return [{ affectedRows: 1, insertId: 1 }, []];
    },
  };
}

test("separate sales are grouped against the principal before the first sale and a 5% group starts immediately", async () => {
  const tx = createStateTx();
  const first = await recordUserOperationTx(tx, "USER001", "sale", "4", "100", "96", "1.4", "3", "SALE-001");
  assert.equal(first.started, false);
  assert.equal(first.grouped, true);
  assert.equal(tx.state.sale_group_base_initial_asset, "100.000000000000000000000000000000");
  assert.equal(tx.state.sale_group_volume_initial_asset, "4.000000000000000000000000000000");
  assert.equal(tx.state.status, "paused");

  const second = await recordUserOperationTx(tx, "USER001", "sale", "1", "96", "95", "1.4", "3", "SALE-002");
  assert.equal(second.started, true);
  assert.equal(second.cycleNumber, 4);
  assert.equal(fixed(second.remunerationRate), "0.9");
  assert.equal(fixed(second.targetPrice), "1.4126");
  assert.equal(tx.state.status, "watching");
  assert.equal(tx.state.sale_group_volume_initial_asset, "0");
});

function fixed(value) { return value.toFixed(); }

test("purchase groups use net credited initial assets and preserve the pre-group principal", async () => {
  const tx = createStateTx();
  const first = await recordUserOperationTx(tx, "USER001", "purchase", "3", "100", "103", "1.4", "3", "BUY-001");
  assert.equal(first.started, false);
  const second = await recordUserOperationTx(tx, "USER001", "purchase", "2", "103", "105", "1.41", "3", "BUY-002");
  assert.equal(second.started, true);
  assert.equal(fixed(second.remunerationRate), "0.9");
  assert.equal(fixed(second.targetPrice), "1.42269");
  assert.equal(tx.state.status, "watching");
});

test("grouped tfees use the volume-weighted rates actually applied to each operation", async () => {
  const tx = createStateTx();
  await recordUserOperationTx(tx, "USER001", "sale", "4", "100", "96", "1.4", "3", "SALE-FEE-001");
  const result = await recordUserOperationTx(tx, "USER001", "sale", "1", "96", "95", "1.4", "6", "SALE-FEE-002");
  assert.equal(result.started, true);
  assert.equal(fixed(result.remunerationRate), "1.08");
  assert.equal(fixed(result.targetPrice), "1.41512");
});

test("the first credited acquisition initializes a first cycle without dividing by a zero principal", async () => {
  const tx = createStateTx({ cycle_number: 1, status: "watching", sale_group_base_initial_asset: null,
    sale_group_volume_initial_asset: "0", purchase_group_base_initial_asset: null,
    purchase_group_volume_initial_asset: "0", purchase_group_fee_weighted: "0" });
  const result = await recordUserOperationTx(tx, "USER001", "purchase", "8", "0", "8", "1.5", "3", "FIRST-BUY");
  assert.equal(result.started, true);
  assert.equal(fixed(result.remunerationRate), "9");
});

test("an eligible sale that still projects above 300 XTU preserves an already frozen individual price", async () => {
  const tx = createStateTx({
    status: "paused",
    base_price: "1.2",
    target_price: "1.308",
    frozen_price: "1.308",
    triggered_price: "1.308",
    sale_group_base_initial_asset: "100",
    sale_group_volume_initial_asset: "4",
    sale_group_fee_weighted: "12",
  });
  const result = await recordUserOperationTx(tx, "USER001", "sale", "1", "96", "95", "4", "3", "SALE-CAP");
  assert.equal(result.started, false);
  assert.equal(result.status, "capped");
  const capUpdate = tx.calls.find((call) => call.sql.startsWith("UPDATE user_price_state SET status='capped'"));
  assert.ok(capUpdate);
  assert.equal(capUpdate.params[0], "1.308000000000000000000000000000");
  assert.equal(capUpdate.params[2], "1.308000000000000000000000000000");
  assert.doesNotMatch(capUpdate.sql, /sale_group_base_initial_asset=NULL|sale_group_volume_initial_asset='0'/);
});
