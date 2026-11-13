"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  calculateAdminFeesTransfer,
} = require("../admin-fees-policy");

function values(result) {
  return result && {
    amount: result.amount.toFixed(18),
    amountRaw: result.amountRaw,
    remaining: result.remainingAfterQueue.toFixed(18),
  };
}

test("admin-fees payout leaves exactly 10 BSC-USD when the threshold is reached", () => {
  assert.deepEqual(values(calculateAdminFeesTransfer("100", "100", "10")), {
    amount: "90.000000000000000000",
    amountRaw: "90000000000000000000",
    remaining: "10.000000000000000000",
  });
});

test("admin-fees payout sends the full excess above the retained 10 BSC-USD", () => {
  assert.deepEqual(values(calculateAdminFeesTransfer("157.25", "100", "10")), {
    amount: "147.250000000000000000",
    amountRaw: "147250000000000000000",
    remaining: "10.000000000000000000",
  });
});

test("admin-fees payout does not start below threshold", () => {
  assert.equal(calculateAdminFeesTransfer("99.999999999", "100", "10"), null);
});

test("invalid threshold or retained balance never creates a transfer", () => {
  assert.equal(calculateAdminFeesTransfer("200", "0", "10"), null);
  assert.equal(calculateAdminFeesTransfer("200", "-1", "10"), null);
  assert.equal(calculateAdminFeesTransfer("200", "100", "100"), null);
  assert.equal(calculateAdminFeesTransfer("200", "100", "-1"), null);
});

test("sub-token-unit precision is rounded down without crossing the retained balance", () => {
  const result = calculateAdminFeesTransfer("100.0000000000000000009", "100", "10");
  assert.equal(result.amount.toFixed(18), "90.000000000000000000");
  assert.equal(result.remainingAfterQueue.toFixed(18), "10.0000000000000000009");
});
