"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createEmailQueue } = require("../email-queue");

test("email queue caps the number of messages initiated per hour", async () => {
  const sent = [];
  const queue = createEmailQueue({
    async sendMail(message) { sent.push(message.subject); },
  }, { maxPerHour: 1, maxPending: 2, concurrency: 1, maxAttempts: 1 });

  await queue.sendMail({ subject: "first" });
  await assert.rejects(
    queue.sendMail({ subject: "second" }),
    (error) => error.code === "EMAIL_RATE_LIMIT",
  );
  assert.deepEqual(sent, ["first"]);
});

test("email queue retries a failed delivery no more than the configured attempts", async () => {
  let attempts = 0;
  const queue = createEmailQueue({
    async sendMail() {
      attempts += 1;
      if (attempts < 2) throw new Error("temporary SMTP failure");
      return { accepted: ["user@example.com"] };
    },
  }, { maxPerHour: 5, maxPending: 2, concurrency: 1, maxAttempts: 2 });

  await queue.sendMail({ subject: "retry" });
  assert.equal(attempts, 2);
});

test("email queue rejects work when the pending queue is full", async () => {
  let releaseFirst;
  let sendCount = 0;
  const queue = createEmailQueue({
    sendMail: () => {
      sendCount += 1;
      if (sendCount === 1) return new Promise((resolve) => { releaseFirst = resolve; });
      return Promise.resolve({ accepted: ["user@example.com"] });
    },
  }, { maxPerHour: 5, maxPending: 1, concurrency: 1, maxAttempts: 1 });

  const first = queue.sendMail({ subject: "active" });
  await new Promise((resolve) => setImmediate(resolve));
  const second = queue.sendMail({ subject: "queued" });
  await assert.rejects(
    queue.sendMail({ subject: "overflow" }),
    (error) => error.code === "EMAIL_QUEUE_FULL" || error.code === "EMAIL_RATE_LIMIT",
  );
  releaseFirst();
  await Promise.all([first, second]);
});
