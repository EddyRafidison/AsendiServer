"use strict";

const DEFAULT_MAX_PENDING = 50;
const DEFAULT_MAX_PER_HOUR = 30;
const DEFAULT_CONCURRENCY = 2;
const DEFAULT_MAX_ATTEMPTS = 2;
const HOUR_MS = 60 * 60 * 1000;

function positiveInteger(value, fallback, maximum) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, maximum) : fallback;
}

function createEmailQueue(transporter, options = {}) {
  if (!transporter || typeof transporter.sendMail !== "function") {
    throw new TypeError("A valid mail transporter is required");
  }

  const maxPending = positiveInteger(options.maxPending ?? process.env.MAIL_OUTBOX_MAX_PENDING, DEFAULT_MAX_PENDING, 500);
  const maxPerHour = positiveInteger(options.maxPerHour ?? process.env.MAIL_OUTBOX_MAX_PER_HOUR, DEFAULT_MAX_PER_HOUR, 500);
  const concurrency = positiveInteger(options.concurrency ?? process.env.MAIL_OUTBOX_CONCURRENCY, DEFAULT_CONCURRENCY, 5);
  const maxAttempts = positiveInteger(options.maxAttempts ?? process.env.MAIL_OUTBOX_MAX_ATTEMPTS, DEFAULT_MAX_ATTEMPTS, 5);
  const queue = [];
  const sentAt = [];
  let active = 0;

  function prune(now) {
    while (sentAt.length && sentAt[0] <= now - HOUR_MS) sentAt.shift();
  }

  async function deliver(job) {
    let lastError;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const now = Date.now();
      prune(now);
      if (sentAt.length >= maxPerHour) {
        const error = new Error("Global hourly email limit reached while retrying");
        error.code = "EMAIL_RATE_LIMIT";
        throw error;
      }
      sentAt.push(now);
      try {
        await transporter.sendMail(job.message);
        job.resolve();
        return;
      } catch (error) {
        lastError = error;
        if (attempt < maxAttempts) {
          await new Promise((resolve) => setTimeout(resolve, Math.min(1000 * (2 ** (attempt - 1)), 5000)));
        }
      }
    }
    throw lastError || new Error("Email delivery failed");
  }

  function pump() {
    while (active < concurrency && queue.length) {
      const job = queue.shift();
      active += 1;
      deliver(job)
        .catch((error) => job.reject(error))
        .finally(() => {
          active -= 1;
          pump();
        });
    }
  }

  function sendMail(message) {
    const now = Date.now();
    prune(now);
    if (sentAt.length + queue.length >= maxPerHour) {
      const error = new Error("Global hourly email limit reached");
      error.code = "EMAIL_RATE_LIMIT";
      return Promise.reject(error);
    }
    if (queue.length >= maxPending) {
      const error = new Error("Email delivery queue is full");
      error.code = "EMAIL_QUEUE_FULL";
      return Promise.reject(error);
    }

    return new Promise((resolve, reject) => {
      queue.push({ message, resolve, reject });
      pump();
    });
  }

  return {
    sendMail,
    getQueueState: () => ({ queued: queue.length, active, sentLastHour: sentAt.length }),
  };
}

module.exports = { createEmailQueue };
