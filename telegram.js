"use strict";

const crypto = require("crypto");

function getBotUsername() {
  const username = String(process.env.TELEGRAM_BOT_USERNAME || "")
    .trim()
    .replace(/^@/, "");
  return /^[A-Za-z0-9_]{5,32}$/.test(username) ? username : "";
}

function getTelegramBotBaseLink() {
  const username = getBotUsername();
  return username ? `https://t.me/${username}` : null;
}

async function createTelegramBotLinkTx(tx, username, authRow) {
  const baseLink = getTelegramBotBaseLink();
  if (!baseLink) return null;

  const tgUserId = authRow?.tg_userId == null ? "" : String(authRow.tg_userId);
  const tgChatId = authRow?.tg_chat_id == null ? "" : String(authRow.tg_chat_id);
  if (tgUserId && tgChatId) return baseLink;

  // A partial association is invalid and must be repaired by a fresh link.
  if (tgUserId || tgChatId) {
    await tx.query(
      "UPDATE auths SET tg_userId=NULL,tg_chat_id=NULL WHERE username=?",
      [username],
    );
  }

  await tx.query(
    "DELETE FROM telegram_link_challenges WHERE username=? AND used_at_ms IS NULL",
    [username],
  );

  const token = crypto.randomBytes(32).toString("base64url");
  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
  const now = Date.now();
  const ttlMinutes = Number(process.env.TELEGRAM_LINK_TTL_MINUTES || 10);
  if (!Number.isInteger(ttlMinutes) || ttlMinutes < 1 || ttlMinutes > 30) {
    throw new Error("TELEGRAM_LINK_TTL_MINUTES must be between 1 and 30.");
  }

  await tx.query(
    `INSERT INTO telegram_link_challenges
     (username,token_hash,created_at_ms,expires_at_ms,used_at_ms)
     VALUES(?,?,?,?,NULL)`,
    [username, tokenHash, String(now), String(now + ttlMinutes * 60_000)],
  );

  return `${baseLink}?start=${token}`;
}

async function queueTelegramMessageTx(tx, username, eventKey, messageText) {
  const safeUsername = String(username || "").trim();
  const safeEventKey = String(eventKey || "").trim();
  const safeText = String(messageText || "").trim();
  if (!safeUsername || !safeEventKey || !safeText) return 0;
  if (safeEventKey.length > 191) throw new RangeError("Telegram event key is too long.");
  if (safeText.length > 4000) throw new RangeError("Telegram message exceeds the supported length.");

  const now = String(Date.now());
  const [result] = await tx.query(
    `INSERT IGNORE INTO telegram_outbox
     (event_key,username,chat_id,message_text,status,attempts,next_attempt_at_ms,claimed_at_ms,last_error,created_at_ms,sent_at_ms)
     SELECT ?,a.username,a.tg_chat_id,?,'pending',0,?,NULL,NULL,?,NULL
     FROM auths a
     WHERE a.username=? AND a.tg_userId IS NOT NULL AND a.tg_chat_id IS NOT NULL`,
    [safeEventKey, safeText, now, now, safeUsername],
  );
  return Number(result.affectedRows || 0);
}

module.exports = {
  createTelegramBotLinkTx,
  getTelegramBotBaseLink,
  getBotUsername,
  queueTelegramMessageTx,
};
