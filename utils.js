const cryptoJS = require("crypto-js");

// --------- CIPHER / DECIPHER ----------
function encrypt(text, key) {
  return cryptoJS.AES.encrypt(text, key).toString();
}
function decrypt(cipher, key) {
  return cryptoJS.AES.decrypt(cipher, key).toString(cryptoJS.enc.Utf8);
}

// --------- DATES & TIMES -------------
function parseDateTime(iso) {
  const d = iso.slice(0, 10).replace(/-/g, "");
  const t = iso.slice(11, 19).replace(/:/g, "");
  return [parseInt(d), t];
}
function getDate() {
  return parseDateTime(require("moment")().utcOffset(3).toISOString(true));
}
function getDateBefore(days) {
  return parseDateTime(
    require("moment")().utcOffset(3).subtract(days, "days").toISOString(true),
  );
}

// --------- TRANS ID & USERNAME GEN --------
function createTxId(sender) {
  const [d, t] = getDate();
  return require("crypto")
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
function createUserSuffixName(cni) {
  try {
    const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ9876543210".split("");
    const ts = Date.now(),
      dt = new Date(ts);
    const fD = new Intl.DateTimeFormat("fr-FR", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
    }).format(dt);
    const fT = new Intl.DateTimeFormat("fr-FR", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      fractionalSecondDigits: 2,
    }).format(dt);
    const nums = [...fD.replace(/\D/g, ""), ...fT.replace(/\D/g, "")].map(
      Number,
    );
    const cnid = [7, 8, 9, 10].map((i) => parseInt(cni.charAt(i)));
    const g = [
      nums[0] + nums[1] + nums[2] + nums[3] + cnid[1],
      nums[4] + nums[5] + nums[6] + nums[7] + cnid[3],
      nums[8] + nums[9] + nums[10] + nums[11] + cnid[0],
      nums[12] + nums[13] + nums[14] + nums[15] + cnid[2],
    ];
    for (let i = 0; i < 4; i++) {
      if (g[i] > 36) g[i] -= cnid[[1, 3, 0, 2][i]];
      if (g[i] < 1) g[i] = 1;
    }
    return (
      letters[g[2] - 1] +
      letters[g[1] - 1] +
      letters[g[3] - 1] +
      letters[g[0] - 1]
    );
  } catch (e) {
    console.error("cni error");
  }
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
  parseDateTime,
  getDate,
  getDateBefore,
  createTxId,
  getUserPrefixName,
  createUserSuffixName,
  httpsRedirect,
};
