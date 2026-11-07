const cryptoJS = require("crypto-js");
const crypto = require("crypto");
const argon2 = require("argon2");
const { transliterate } = require("transliteration");

const ARGON2_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
};

const configuredArgonConcurrency = Number(process.env.ARGON2_MAX_PARALLEL || 4);
const ARGON2_MAX_PARALLEL = Number.isInteger(configuredArgonConcurrency)
  ? Math.max(1, Math.min(configuredArgonConcurrency, 16))
  : 4;
const configuredArgonQueue = Number(process.env.ARGON2_MAX_QUEUE || 100);
const ARGON2_MAX_QUEUE = Number.isInteger(configuredArgonQueue)
  ? Math.max(1, Math.min(configuredArgonQueue, 1000))
  : 100;

let activeArgonOperations = 0;
const argonWaitQueue = [];

async function withArgonSlot(operation) {
  if (activeArgonOperations < ARGON2_MAX_PARALLEL && argonWaitQueue.length === 0) {
    activeArgonOperations += 1;
  } else {
    if (argonWaitQueue.length >= ARGON2_MAX_QUEUE) {
      throw new Error("Argon2 operation queue is full");
    }
    await new Promise((resolve) => argonWaitQueue.push(resolve));
  }

  try {
    return await operation();
  } finally {
    const next = argonWaitQueue.shift();
    if (next) {
      // Transfer the occupied slot directly to the next waiter.
      next();
    } else {
      activeArgonOperations -= 1;
    }
  }
}

function assertSecretInput(secret) {
  if (typeof secret !== "string" || secret.length === 0) {
    throw new TypeError("Secret must be a non-empty string");
  }
  if (Buffer.byteLength(secret, "utf8") > 4096) {
    throw new RangeError("Secret exceeds the maximum supported size");
  }
}

function isArgon2Hash(value) {
  return typeof value === "string" && value.startsWith("$argon2id$");
}

async function hashSecret(secret) {
  assertSecretInput(secret);
  return withArgonSlot(() => argon2.hash(secret, ARGON2_OPTIONS));
}

async function verifySecret(storedHash, candidate) {
  if (!isArgon2Hash(storedHash) || typeof candidate !== "string") {
    return false;
  }
  if (Buffer.byteLength(candidate, "utf8") > 4096) return false;

  return withArgonSlot(() => argon2.verify(storedHash, candidate));
}

// --------- CIPHER / DECIPHER ----------
function encrypt(text, key) {
  return cryptoJS.AES.encrypt(text, key).toString();
}
function decrypt(cipher, key) {
  return cryptoJS.AES.decrypt(cipher, key).toString(cryptoJS.enc.Utf8);
}

// --------- DATES & TIMES (UTC / GMT+0) -------------
function formatUtcDateTime(date) {
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) {
    throw new TypeError("A valid Date is required");
  }

  const yyyy = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(date.getUTCDate()).padStart(2, "0");
  const hh = String(date.getUTCHours()).padStart(2, "0");
  const mi = String(date.getUTCMinutes()).padStart(2, "0");
  const ss = String(date.getUTCSeconds()).padStart(2, "0");

  return [Number(`${yyyy}${mm}${dd}`), `${hh}${mi}${ss}`];
}

function parseDateTime(iso) {
  if (typeof iso !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(iso)) {
    throw new TypeError("Invalid ISO date-time");
  }
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) throw new TypeError("Invalid ISO date-time");
  return formatUtcDateTime(date);
}

function getDate() {
  return formatUtcDateTime(new Date());
}

function getDateBefore(days) {
  const numberOfDays = Number(days);
  if (!Number.isInteger(numberOfDays) || numberOfDays < 0) {
    throw new RangeError("days must be a non-negative integer");
  }
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - numberOfDays);
  return formatUtcDateTime(date);
}

// --------- TRANS ID & USERNAME GEN --------
function createTxId(sender) {
  const [d, t] = getDate();
  return crypto
    .createHash("shake256", { outputLength: 7 })
    .update(d + sender + t)
    .digest("hex");
}
function getUserPrefixName(fullname) {
  return fullname.includes("+")
    ? fullname.split("+").pop()
    : fullname.includes("%20")
      ? fullname.split("%20").pop()
      : fullname;
}
function transliterateUserText(value) {
  if (typeof value !== "string") {
    throw new TypeError("User text must be a string");
  }

  const source = value.normalize("NFC");
  const result = transliterate(source, {
    trim: true,
    unknown: "",
    fixChineseSpacing: true,
  })
    .replace(/\s+([,.;:!?])/g, "$1")
    .replace(/\s+/g, " ")
    .trim();

  if (source.trim() && !result) {
    throw new Error("Input contains no characters supported by transliteration");
  }

  return result;
}
function createUserSuffixName() {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ9876543210";

  return Array.from({ length: 6 }, () =>
    alphabet[crypto.randomInt(alphabet.length)],
  ).join("");
}

// --------- MIDDLEWARE HTTPS ----------
function httpsRedirect(req, res, next) {
  const { SERVER_MAIL } = process.env;
  if (req.protocol !== "https" && !SERVER_MAIL.includes("@gmail")) {
    return res.redirect(`https://${req.headers.host}${req.url}`);
  }
  next();
}

module.exports = {
  encrypt,
  decrypt,
  hashSecret,
  verifySecret,
  isArgon2Hash,
  parseDateTime,
  getDate,
  getDateBefore,
  createTxId,
  getUserPrefixName,
  transliterateUserText,
  createUserSuffixName,
  httpsRedirect,
};
