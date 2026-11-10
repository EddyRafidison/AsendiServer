process.env.TZ = "UTC";
"use strict";

require("dotenv").config();
const crypto = require("crypto");
const { db, initDbIfEmpty } = require("./db");

const BOT_TOKEN = String(process.env.TELEGRAM_BOT_TOKEN || "").trim();
const API_BASE = BOT_TOKEN ? `https://api.telegram.org/bot${BOT_TOKEN}` : "";
const POLL_TIMEOUT = Number(process.env.TELEGRAM_POLL_TIMEOUT || 25);
const RETRY_LIMIT = Number(process.env.TELEGRAM_OUTBOX_RETRY_LIMIT || 10);
let polling = false;
let sending = false;
let stopping = false;
let workerLockConnection = null;

process.once("SIGINT", () => { stopping = true; });
process.once("SIGTERM", () => { stopping = true; });

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function telegramRequest(method, payload, timeoutMs = 35_000) {
  const response = await fetch(`${API_BASE}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.ok !== true) {
    const error = new Error(body.description || `Telegram API ${method} failed (${response.status}).`);
    error.telegramStatus = response.status;
    error.telegramCode = body.error_code || response.status;
    error.retryAfter = Number(body.parameters?.retry_after || 0);
    throw error;
  }
  return body.result;
}

async function sendMessage(chatId, text) {
  return telegramRequest("sendMessage", {
    chat_id: String(chatId),
    text: String(text).slice(0, 4000),
    disable_web_page_preview: true,
  });
}

async function withDbTransaction(work) {
  const connection = await new Promise((resolve, reject) => {
    db.getConnection((error, conn) => error ? reject(error) : resolve(conn));
  });
  const tx = connection.promise();
  try {
    await tx.beginTransaction();
    const result = await work(tx);
    await tx.commit();
    return result;
  } catch (error) {
    await tx.rollback().catch(() => {});
    throw error;
  } finally {
    connection.release();
  }
}

async function replyToPrivateMessage(chatId, text) {
  try {
    await sendMessage(chatId, text);
  } catch (error) {
    console.error("Unable to send Telegram bot response:", error.message);
  }
}

async function handleStartMessage(message) {
  const chat = message.chat || {};
  const from = message.from || {};
  if (chat.type !== "private" || from.is_bot) return;

  const match = String(message.text || "").trim().match(/^\/start(?:@[A-Za-z0-9_]+)?(?:\s+([A-Za-z0-9_-]{20,64}))?\s*$/);
  const token = match?.[1] || "";
  if (!token) {
    await replyToPrivateMessage(
      chat.id,
      "Welcome to OneX. To link this Telegram account, sign in to your OneX account and open the Telegram link provided by the application.",
    );
    return;
  }

  const userId = String(from.id || "");
  const chatId = String(chat.id || "");
  if (!/^\d{1,32}$/.test(userId) || !/^\d{1,32}$/.test(chatId) || BigInt(chatId) <= 0n) {
    await replyToPrivateMessage(chat.id, "This Telegram chat cannot be linked to OneX.");
    return;
  }

  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
  let linkedUsername = null;
  let failureMessage = null;
  try {
    await withDbTransaction(async (tx) => {
      const [challengeRows] = await tx.query(
        `SELECT id,username,expires_at_ms,used_at_ms
         FROM telegram_link_challenges WHERE token_hash=? LIMIT 1 FOR UPDATE`,
        [tokenHash],
      );
      if (!challengeRows.length) {
        failureMessage = "This OneX Telegram link is invalid or expired. Sign in again to generate a new link.";
        return;
      }

      const challenge = challengeRows[0];
      const [accountRows] = await tx.query(
        "SELECT username,tg_userId,tg_chat_id FROM auths WHERE username=? LIMIT 1 FOR UPDATE",
        [challenge.username],
      );
      if (!accountRows.length) {
        failureMessage = "The OneX account associated with this link no longer exists.";
        return;
      }
      const account = accountRows[0];
      const existingUserId = account.tg_userId == null ? "" : String(account.tg_userId);
      const existingChatId = account.tg_chat_id == null ? "" : String(account.tg_chat_id);

      // A Telegram update may be redelivered if the process stops after the
      // SQL commit but before its update offset is persisted. Treat the same
      // already-completed link as success instead of showing a false failure.
      if (challenge.used_at_ms != null) {
        if (existingUserId === userId && existingChatId === chatId) {
          linkedUsername = challenge.username;
        } else {
          failureMessage = "This OneX Telegram link has already been used. Sign in again to generate a new link.";
        }
        return;
      }
      if (Number(challenge.expires_at_ms) <= Date.now()) {
        failureMessage = "This OneX Telegram link has expired. Sign in again to generate a new link.";
        return;
      }

      if ((existingUserId && existingUserId !== userId) || (existingChatId && existingChatId !== chatId)) {
        failureMessage = "A different Telegram account is already linked. Unlink it first or contact OneX support.";
        return;
      }

      const [conflictRows] = await tx.query(
        `SELECT username FROM auths
         WHERE (tg_userId=? OR tg_chat_id=?) AND username<>? LIMIT 1 FOR UPDATE`,
        [userId, chatId, challenge.username],
      );
      if (conflictRows.length) {
        failureMessage = "This Telegram account is already linked to another OneX account.";
        return;
      }

      await tx.query(
        `UPDATE auths SET tg_userId=?,tg_chat_id=? WHERE username=?`,
        [userId, chatId, challenge.username],
      );
      await tx.query(
        "UPDATE telegram_link_challenges SET used_at_ms=? WHERE id=? AND used_at_ms IS NULL",
        [String(Date.now()), challenge.id],
      );
      linkedUsername = challenge.username;
    });
  } catch (error) {
    if (error.code === "ER_DUP_ENTRY") {
      failureMessage = "This Telegram account is already linked to another OneX account.";
    } else {
      throw error;
    }
  }

  if (linkedUsername) {
    await replyToPrivateMessage(
      chat.id,
      `Your Telegram account has been successfully linked to OneX (${linkedUsername}). Transaction notifications are now enabled.`,
    );
  } else {
    await replyToPrivateMessage(chat.id, failureMessage || "Unable to link this Telegram account. Please try again from OneX.");
  }
}

async function handleChatMemberUpdate(update) {
  const chat = update.chat || {};
  if (chat.type !== "private") return;
  const from = update.from || {};
  const userId = String(from.id || "");
  const chatId = String(chat.id || "");
  const newStatus = String(update.new_chat_member?.status || "");
  if (!userId || !chatId || !["kicked", "left"].includes(newStatus)) return;

  await withDbTransaction(async (tx) => {
    await tx.query(
      `UPDATE auths SET tg_userId=NULL,tg_chat_id=NULL
       WHERE tg_userId=? AND tg_chat_id=?`,
      [userId, chatId],
    );
    await tx.query(
      `UPDATE telegram_outbox SET status='skipped',last_error='Telegram bot was blocked or removed by the user.'
       WHERE chat_id=? AND status IN ('pending','retry')`,
      [chatId],
    );
  });
}

async function processUpdate(update) {
  if (update.message?.text) {
    await handleStartMessage(update.message);
  } else if (update.my_chat_member) {
    await handleChatMemberUpdate(update.my_chat_member);
  }
}

async function getUpdateOffset() {
  const rows = await db.queryAsync(
    "SELECT state_value FROM telegram_bot_state WHERE state_key='update_offset' LIMIT 1",
  );
  return rows.length ? Number(rows[0].state_value) : 0;
}

async function storeUpdateOffset(updateId) {
  await db.queryAsync(
    "UPDATE telegram_bot_state SET state_value=?,updated_at_ms=? WHERE state_key='update_offset'",
    [String(Number(updateId) + 1), String(Date.now())],
  );
}

async function pollTelegramUpdates() {
  if (polling) return;
  polling = true;
  try {
    const offset = await getUpdateOffset();
    const updates = await telegramRequest("getUpdates", {
      offset,
      timeout: POLL_TIMEOUT,
      allowed_updates: ["message", "my_chat_member"],
    }, (POLL_TIMEOUT + 10) * 1000);

    for (const update of updates || []) {
      try {
        await processUpdate(update);
        await storeUpdateOffset(update.update_id);
      } catch (error) {
        console.error(`Telegram update ${update.update_id} failed:`, error.message);
        // Do not advance the offset when the update could not be persisted.
        break;
      }
    }
  } finally {
    polling = false;
  }
}

function retryDelayMs(attempts, retryAfter = 0) {
  if (retryAfter > 0) return Math.min(retryAfter * 1000, 60 * 60 * 1000);
  return Math.min(60_000, 1000 * (2 ** Math.min(attempts, 6)));
}

async function processOutbox() {
  if (sending) return;
  sending = true;
  try {
    const now = Date.now();
    const staleSendingBefore = now - 120_000;
    await db.queryAsync(
      `UPDATE telegram_outbox
       SET status='retry',claimed_at_ms=NULL,next_attempt_at_ms=?,
           last_error='Recovered an interrupted Telegram delivery attempt.'
       WHERE status='sending' AND claimed_at_ms IS NOT NULL AND claimed_at_ms<=?`,
      [String(now), String(staleSendingBefore)],
    );
    const rows = await db.queryAsync(
      `SELECT id,username,chat_id,message_text,attempts
       FROM telegram_outbox
       WHERE status IN ('pending','retry') AND next_attempt_at_ms<=?
       ORDER BY id ASC LIMIT 20`,
      [String(now)],
    );

    for (const row of rows) {
      const claim = await db.queryAsync(
        `UPDATE telegram_outbox SET status='sending',attempts=attempts+1,claimed_at_ms=?
         WHERE id=? AND status IN ('pending','retry') AND next_attempt_at_ms<=?`,
        [String(now), row.id, String(now)],
      );
      if (claim.affectedRows !== 1) continue;

      const accountRows = await db.queryAsync(
        "SELECT tg_chat_id FROM auths WHERE username=? LIMIT 1",
        [row.username],
      );
      const currentChatId = accountRows[0]?.tg_chat_id == null ? "" : String(accountRows[0].tg_chat_id);
      if (!currentChatId || currentChatId !== String(row.chat_id)) {
        await db.queryAsync(
          "UPDATE telegram_outbox SET status='skipped',claimed_at_ms=NULL,last_error='Telegram association is no longer active.' WHERE id=?",
          [row.id],
        );
        continue;
      }

      try {
        await sendMessage(row.chat_id, row.message_text);
        await db.queryAsync(
          "UPDATE telegram_outbox SET status='sent',sent_at_ms=?,claimed_at_ms=NULL,last_error=NULL WHERE id=? AND status='sending'",
          [String(Date.now()), row.id],
        );
      } catch (error) {
        if (error.telegramCode === 403) {
          await withDbTransaction(async (tx) => {
            await tx.query(
              "UPDATE auths SET tg_userId=NULL,tg_chat_id=NULL WHERE username=? AND tg_chat_id=?",
              [row.username, row.chat_id],
            );
            await tx.query(
              "UPDATE telegram_outbox SET status='failed',claimed_at_ms=NULL,last_error=? WHERE id=?",
              [String(error.message).slice(0, 1000), row.id],
            );
          });
          continue;
        }
        const attempts = Number(row.attempts) + 1;
        const status = attempts >= RETRY_LIMIT ? "failed" : "retry";
        const nextAttempt = Date.now() + retryDelayMs(attempts, error.retryAfter);
        await db.queryAsync(
          `UPDATE telegram_outbox SET status=?,next_attempt_at_ms=?,claimed_at_ms=NULL,last_error=? WHERE id=? AND status='sending'`,
          [status, String(nextAttempt), String(error.message).slice(0, 1000), row.id],
        );
      }
    }
  } catch (error) {
    console.error("Telegram outbox processing failed:", error.message);
  } finally {
    sending = false;
  }
}

async function acquireWorkerLock() {
  const connection = await new Promise((resolve, reject) => {
    db.getConnection((error, conn) => error ? reject(error) : resolve(conn));
  });
  try {
    const [rows] = await connection.promise().query(
      "SELECT GET_LOCK(?, 0) AS acquired",
      ["onex_telegram_long_poll_worker"],
    );
    if (Number(rows[0]?.acquired) !== 1) {
      throw new Error("Another OneX Telegram worker already holds the polling lock.");
    }
    workerLockConnection = connection;
  } catch (error) {
    connection.release();
    throw error;
  }
}

async function releaseWorkerLock() {
  if (!workerLockConnection) return;
  const connection = workerLockConnection;
  workerLockConnection = null;
  try {
    await connection.promise().query(
      "SELECT RELEASE_LOCK(?)",
      ["onex_telegram_long_poll_worker"],
    );
  } catch (error) {
    console.error("Unable to release Telegram worker lock:", error.message);
  } finally {
    connection.release();
  }
}

async function start() {
  if (!BOT_TOKEN) throw new Error("TELEGRAM_BOT_TOKEN is required to start telegram-worker.js.");
  if (!Number.isInteger(POLL_TIMEOUT) || POLL_TIMEOUT < 1 || POLL_TIMEOUT > 50) {
    throw new Error("TELEGRAM_POLL_TIMEOUT must be between 1 and 50 seconds.");
  }
  await initDbIfEmpty();
  await acquireWorkerLock();

  const outboxTimer = setInterval(() => void processOutbox(), 1000);
  try {
    await telegramRequest("getMe", {}, 10_000);
    console.log("OneX Telegram worker started.");
    while (!stopping) {
      try {
        await pollTelegramUpdates();
      } catch (error) {
        console.error("Telegram long polling failed:", error.message);
        await delay(3000);
      }
    }
  } finally {
    clearInterval(outboxTimer);
    await releaseWorkerLock();
  }
}

void start().catch((error) => {
  console.error("OneX Telegram worker startup failed:", error);
  process.exit(1);
});
