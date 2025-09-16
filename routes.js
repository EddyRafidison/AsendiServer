const express = require("express");
const fs = require("fs");
const geoip = require("geoip-country");
const nodemailer = require("nodemailer");
const BigNumber = require("bignumber.js");

const {
  db,
  OneX,
  maxStockDefault,
  P2Pallowed,
  stock_limit,
  first_welcome_clients,
  welcome_bonus,
  tfees,
  admin_pswd,
  admin_pin,
  APP_VERSION,
  MAIL_PORT,
  SERVER_MAIL,
  SERVER_MAIL_PSWD,
  DB_CONFIG,
} = require("./db");

const {
  encrypt,
  decrypt,
  getDate,
  getDateBefore,
  createTxId,
  getUserPrefixName,
  createUserSuffixName,
} = require("./utils");

const router = express.Router();

// ----- MAILER -----
const transporter = nodemailer.createTransport({
  host: "smtp.gmail.com",
  port: MAIL_PORT,
  auth: { user: SERVER_MAIL, pass: SERVER_MAIL_PSWD },
});

// ----- PUBLIC GET -----
router.get("/", (_r, s) => s.redirect("/app/download-latest-apk"));

router.get("/app/privacy-terms-info", async (req, res) => {
  const file = `./${req.query.r === "terms" ? "terms" : "privacy"}_${
    req.query.l
  }.html`;
  try {
    res.send(await fs.promises.readFile(file, "utf8"));
  } catch {
    res.send("error");
  }
});

router.get("/app/download-latest-apk", (_r, res, n) =>
  res.download("./OneX.apk", "OneX.apk", n),
);

// ----- APP POSTS -----
// check version
router.post("/app/check-app-version", (_r, res) => {
  const size = fs.statSync("./OneX.apk").size / (1024 * 1024);
  res.send({ version: APP_VERSION, size });
});

// contact
router.post("/app/contact-onex", async (req, res) => {
  const { user, pswd, subj, msg, tkn } = req.body;
  const U = user.replaceAll(" ", "+"),
    P = pswd.replaceAll(" ", "+");
  if (req.headers["user-agent"] !== decrypt(tkn, P + U))
    return res.send({ status: "forbidden request" });

  try {
    const { password, email } = (
      await db.queryAsync("SELECT password,email FROM auths WHERE username=?", [
        U,
      ])
    )[0];

    if (decrypt(password, DB_CONFIG.password) === P) {
      await transporter.sendMail({
        from: SERVER_MAIL,
        to: SERVER_MAIL,
        subject: subj,
        html: `<b>De</b> ${email} (${U})<br>${msg}`,
      });
      res.send({ status: "sent" });
    } else {
      res.send({ status: "error" });
    }
  } catch {
    res.send({ status: "error" });
  }
});

// signup
router.post("/app/signup", async (req, res) => {
  const { email, birth, addr, name, cni, pswd, seed, cniimg1, cniimg2 } =
    req.body;
  const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress;
  const geo = geoip.lookup(ip);
  if (!geo) return res.send({ msg: "what country" });
  if (geo.country !== "MG" && !ip.includes("127.0.0.1"))
    return res.send({ msg: "unsupported country" });

  const Email = email.replaceAll(" ", "+");
  const Birth = birth.replaceAll(" ", "+");
  const Address = addr.replaceAll(" ", "+");
  const Name = name.replaceAll(" ", "+");
  const CNI = encrypt(cni.replaceAll(" ", "+"), DB_CONFIG.password);
  const PWD = encrypt(pswd.replaceAll(" ", "+"), DB_CONFIG.password);
  const SEED = encrypt(seed.replaceAll(" ", "+"), DB_CONFIG.password);
  const prefix = getUserPrefixName(Name);
  const suffix = createUserSuffixName(cni);
  const U = `${prefix}-${suffix}`.toUpperCase();
  const [date, time] = getDate();

  try {
    if (
      (await db.queryAsync("SELECT 1 FROM auths WHERE username=?", [U])).length
    )
      return res.send({ msg: "retry" });

    await new Promise((ok, ko) => {
      db.getConnection((e, conn) => {
        if (e) return ko(e);
        conn.beginTransaction(async (err) => {
          if (err) return ko(err);
          try {
            await conn
              .promise()
              .query(
                "INSERT INTO auths(username,password,name,email,birthdate,cni,address,seed,status,record_date,record_time) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                [U, PWD, Name, Email, Birth, CNI, Address, SEED, 0, date, time],
              );
            await conn
              .promise()
              .query(
                "INSERT INTO users_stock(username,balance,record_date,record_time) VALUES(?,?,?,?)",
                [U, "0", date, time],
              );
            conn.commit((err2) =>
              err2 ? conn.rollback(() => ko(err2)) : ok(),
            );
          } catch (e2) {
            conn.rollback(() => ko(e2));
          }
        });
      });
    });

    res.send({ msg: "ok" });

    // welcome email
    transporter.sendMail({
      from: SERVER_MAIL,
      to: Email,
      subject: "Nouvelle inscription",
      html: `<h2>Bienvenue,</h2>Votre identifiant: <b>${U}</b>`,
    });

    // send CNI pour vérification
    transporter.sendMail({
      from: SERVER_MAIL,
      to: "eddy.heriniaina.rafidison@gmail.com",
      subject: "Account Verification",
      html: `${U}<br>${Name}<br>${Birth}<br>${Address}<br>${cni}`,
      attachments: [
        { filename: "cni_1.png", content: cniimg1, encoding: "base64" },
        { filename: "cni_2.png", content: cniimg2, encoding: "base64" },
      ],
    });
  } catch (e) {
    console.error(e);
    res.send({ msg: "failed" });
  }
});

// signin
router.post("/app/signin", async (req, res) => {
  const { user, pswd, tkn, recon, seed } = req.body;
  const U = user.replaceAll(" ", "+"),
    P = pswd.replaceAll(" ", "+");
  const ua = req.headers["user-agent"];
  const validUA = ua === decrypt(tkn, P + U);
  if (!validUA && recon === "0")
    return res.send({ msg: "forbidden request", ua: "" });

  try {
    const row = (
      await db.queryAsync("SELECT password,seed FROM auths WHERE username=?", [
        U,
      ])
    )[0];
    const passOK = decrypt(row.password, DB_CONFIG.password) === P;
    const seedOK = decrypt(row.seed, DB_CONFIG.password) === seed;
    if (!passOK) return res.send({ msg: "incorrect password", ua: "" });
    if (recon === "0" && !seedOK)
      return res.send({ msg: "incorrect seed", ua: "" });

    const encUA = encrypt(ua, P + U);
    let status = (
      await db.queryAsync("SELECT status FROM auths WHERE username=?", [U])
    )[0].status;
    if (status === 0) {
      await db.queryAsync("UPDATE auths SET status=1 WHERE username=?", [U]);
      status = 1;

      if (
        (await db.queryAsync("SELECT id FROM auths WHERE username=?", [U]))[0]
          .id <= first_welcome_clients
      ) {
        const reference = createTxId(OneX);
        const [d, t] = getDate();
        await db.queryAsync(
          "UPDATE users_stock SET balance=? WHERE username=?",
          [welcome_bonus, U],
        );
        await db.queryAsync(
          "INSERT INTO activities(sender,receiver,type,amount,unit_price,fees,reference,record_date,record_time) VALUES(?,?,?,?,?,?,?,?,?)",
          [OneX, U, 2, welcome_bonus, 1, 0, reference, d, t],
        );
      }
    }

    res.send({ msg: status, ua: encUA });
  } catch {
    res.send({ msg: "error", ua: "" });
  }
});

// feed
router.post("/app/feed", async (req, res) => {
  const { user, pswd, tkn } = req.body;
  const U = user.replaceAll(" ", "+"),
    P = pswd.replaceAll(" ", "+");
  const ua = req.headers["user-agent"];
  if (ua !== decrypt(tkn, P + U))
    return res.send({ feed: "forbidden request" });

  try {
    const passOK =
      decrypt(
        (
          await db.queryAsync("SELECT password FROM auths WHERE username=?", [
            U,
          ])
        )[0].password,
        DB_CONFIG.password,
      ) === P;
    if (!passOK) return res.send({ feed: "incorrect auth" });

    const [date] = getDate();
    const notifs = await db.queryAsync(
      "SELECT * FROM notifs WHERE record_date=? ORDER BY id DESC",
      [date],
    );
    res.send({ feed: notifs });
  } catch {
    res.send({ feed: "error" });
  }
});

// user-last-stock
router.post("/app/user-last-stock", async (req, res) => {
  const { user, pswd, tkn } = req.body;
  const U = user.replaceAll(" ", "+"),
    P = pswd.replaceAll(" ", "+");
  const ua = req.headers["user-agent"];
  if (ua !== decrypt(tkn, P + U)) return res.send({ msg: "forbidden request" });

  try {
    const passOK =
      decrypt(
        (
          await db.queryAsync("SELECT password FROM auths WHERE username=?", [
            U,
          ])
        )[0].password,
        DB_CONFIG.password,
      ) === P;
    if (!passOK) return res.send({ msg: "error" });

    const price = (
      await db.queryAsync("SELECT MAX(unit_price+0) AS p FROM common", [])
    )[0].p;
    const bal = (
      await db.queryAsync("SELECT balance FROM users_stock WHERE username=?", [
        U,
      ])
    )[0].balance;
    res.send({ msg: Number(bal) * price, fees: tfees });
  } catch {
    res.send({ msg: "error" });
  }
});

// transactions-history
router.post("/app/transactions-history", async (req, res) => {
  const { user, pswd, days, tkn } = req.body;
  const U = user.replaceAll(" ", "+"),
    P = pswd.replaceAll(" ", "+");
  const ua = req.headers["user-agent"];
  if (ua !== decrypt(tkn, P + U))
    return res.send({ trans: "forbidden request" });

  try {
    const passOK =
      decrypt(
        (
          await db.queryAsync("SELECT password FROM auths WHERE username=?", [
            U,
          ])
        )[0].password,
        DB_CONFIG.password,
      ) === P;
    if (!passOK) return res.send({ trans: "error" });

    const before = getDateBefore(Number(days))[0];
    const trans = await db.queryAsync(
      "SELECT * FROM activities WHERE record_date>=? AND (sender=? OR receiver=?) ORDER BY id DESC",
      [before, U, U],
    );
    res.send({ trans });
  } catch {
    res.send({ trans: "error" });
  }
});

// near-transfer
router.post("/app/near-transfer", async (req, res) => {
  const { sender, pswd, dest, amount, tkn } = req.body;
  const S = sender.replaceAll(" ", "+"),
    P = pswd.replaceAll(" ", "+");
  const D = dest.replaceAll(" ", "+");
  const ua = req.headers["user-agent"];
  if (ua !== decrypt(tkn, P + S))
    return res.send({ transf: "forbidden request" });
  if (!P2Pallowed) return res.send({ transf: "not yet allowed" });

  const am = Number(amount.replaceAll(" ", "+"));
  if (am < 10000) return res.send({ warning: "abusive operation" });
  if (S === D) return res.send({ transf: "failed" });

  try {
    const statusS = (
      await db.queryAsync("SELECT status FROM auths WHERE username=?", [S])
    )[0].status;
    if (statusS <= 0) return res.send({ transf: "failed" });

    const p = (
      await db.queryAsync("SELECT MAX(unit_price+0) AS p FROM common", [])
    )[0].p;
    const Amount = am / p;
    const fees = (Amount * tfees) / 100;
    const minReq = Amount + fees;
    const passOK =
      decrypt(
        (
          await db.queryAsync("SELECT password FROM auths WHERE username=?", [
            S,
          ])
        )[0].password,
        DB_CONFIG.password,
      ) === P;
    if (!passOK) return res.send({ transf: "failed" });

    let senderBal = Number(
      (
        await db.queryAsync(
          "SELECT balance FROM users_stock WHERE username=?",
          [S],
        )
      )[0].balance,
    );
    if (senderBal < minReq) return res.send({ transf: "insufficient balance" });

    let destBal = Number(
      (
        await db.queryAsync(
          "SELECT balance FROM users_stock WHERE username=?",
          [D],
        )
      )[0].balance,
    );
    const futDest = destBal + Amount;
    const sharedFees = (fees * 3) / 4;
    const adminFees = fees - sharedFees;

    if (D !== OneX) {
      const statusD = (
        await db.queryAsync("SELECT status FROM auths WHERE username=?", [D])
      )[0].status;
      if (statusD <= 0) return res.send({ transf: "failed" });
      if (futDest * p > maxStockDefault)
        return res.send({ transf: "unsupported" });
    }

    await new Promise((ok, ko) => {
      db.getConnection((e, conn) => {
        if (e) return ko(e);
        conn.beginTransaction(async (err) => {
          if (err) return ko(err);
          try {
            const [d, t] = getDate(),
              ref = createTxId(S);

            await conn
              .promise()
              .query(
                "INSERT INTO activities(sender,receiver,type,amount,unit_price,fees,reference,record_date,record_time) VALUES(?,?,?,?,?,?,?,?,?)",
                [S, D, 1, Amount, p, fees, ref, d, t],
              );
            await conn
              .promise()
              .query(
                "UPDATE users_stock SET balance=?,record_date=?,record_time=? WHERE username=?",
                [senderBal - minReq, d, t, S],
              );
            await conn
              .promise()
              .query(
                "UPDATE users_stock SET balance=?,record_date=?,record_time=? WHERE username=?",
                [D === OneX ? destBal + adminFees : futDest, d, t, D],
              );

            const [[com]] = await conn
              .promise()
              .query(
                "SELECT total_units_price,unit_price,backed_units FROM common ORDER BY id DESC LIMIT 1",
              );
            const lastStock = new BigNumber(com.total_units_price);
            const lastPrice = Number(com.unit_price);
            const newStock = lastStock.plus(sharedFees);
            const newPrice = newStock
              .dividedBy(lastStock)
              .multipliedBy(lastPrice);
            const totalBacked =
              com.backed_units + (D === OneX ? Amount + fees : fees);

            await conn
              .promise()
              .query(
                "INSERT INTO common(total_units_price,unit_price,backed_units,record_date,record_time) VALUES(?,?,?,?,?)",
                [newStock.toFixed(), newPrice.toFixed(), totalBacked, d, t],
              );
            conn.commit((err2) =>
              err2 ? conn.rollback(() => ko(err2)) : ok(),
            );
          } catch (e2) {
            conn.rollback(() => ko(e2));
          }
        });
      });
    });

    res.send({ transf: "sent" });
  } catch (e) {
    console.error(e);
    res.send({ transf: "failed" });
  }
});

// modify-pin-or-password
router.post("/app/modify-pin-or-password", async (req, res) => {
  const { user, pswd1, pswd2, tkn } = req.body;
  const U = user.replaceAll(" ", "+");
  const P1 = pswd1.replaceAll(" ", "+");
  const P2 = pswd2.replaceAll(" ", "+");
  const ua = req.headers["user-agent"];
  if (ua !== decrypt(tkn, P1 + U))
    return res.send({ auth: "forbidden request" });

  try {
    const passOK =
      decrypt(
        (
          await db.queryAsync("SELECT password FROM auths WHERE username=?", [
            U,
          ])
        )[0].password,
        DB_CONFIG.password,
      ) === P1;
    if (!passOK) return res.send({ auth: "incorrect" });

    await db.queryAsync("UPDATE auths SET password=? WHERE username=?", [
      encrypt(P2, DB_CONFIG.password),
      U,
    ]);
    res.send({ auth: "updated" });
  } catch {
    res.send({ auth: "error" });
  }
});

// delete-user
router.post("/app/delete-user", async (req, res) => {
  const { user, pswd, tkn } = req.body;
  const U = user.replaceAll(" ", "+");
  const P = pswd.replaceAll(" ", "+");
  const ua = req.headers["user-agent"];
  if (ua !== decrypt(tkn, P + U))
    return res.send({ auth: "forbidden request" });

  try {
    const passOK =
      decrypt(
        (
          await db.queryAsync("SELECT password FROM auths WHERE username=?", [
            U,
          ])
        )[0].password,
        DB_CONFIG.password,
      ) === P;
    if (!passOK) return res.send({ auth: "incorrect" });

    const ppu = (
      await db.queryAsync(
        "SELECT unit_price FROM common ORDER BY id DESC LIMIT 1",
        [],
      )
    )[0].unit_price;
    const bal = (
      await db.queryAsync("SELECT balance FROM users_stock WHERE username=?", [
        U,
      ])
    )[0].balance;

    if (Number(bal) * Number(ppu) > 5000)
      return res.send({ auth: "failed, balance > 5000" });

    await db.queryAsync("DELETE FROM auths WHERE username=?", [U]);
    res.send({ auth: "deleted" });
  } catch {
    res.send({ auth: "error" });
  }
});

// recover-account
router.post("/app/recover-account", async (req, res) => {
  const { user, seed } = req.body;
  const U = user.replaceAll(" ", "+");
  const S = seed.replaceAll(" ", "+");

  try {
    const seedOK =
      decrypt(
        (await db.queryAsync("SELECT seed FROM auths WHERE username=?", [U]))[0]
          .seed,
        DB_CONFIG.password,
      ) === S;
    if (!seedOK) return res.send({ auth: "incorrect" });

    const newPC = encrypt("123456", DB_CONFIG.password);
    await db.queryAsync("UPDATE auths SET password=? WHERE username=?", [
      newPC,
      U,
    ]);
    res.send({ auth: "updated" });
  } catch {
    res.send({ auth: "error" });
  }
});

// modify-seed
router.post("/app/modify-seed", async (req, res) => {
  const { user, pswd, seed, tkn } = req.body;
  const U = user.replaceAll(" ", "+");
  const P = pswd.replaceAll(" ", "+");
  const S = seed.replaceAll(" ", "+");
  const ua = req.headers["user-agent"];
  if (ua !== decrypt(tkn, P + U))
    return res.send({ auth: "forbidden request" });

  try {
    const passOK =
      decrypt(
        (
          await db.queryAsync("SELECT password FROM auths WHERE username=?", [
            U,
          ])
        )[0].password,
        DB_CONFIG.password,
      ) === P;
    if (!passOK) return res.send({ auth: "incorrect" });

    await db.queryAsync("UPDATE auths SET seed=? WHERE username=?", [
      encrypt(S, DB_CONFIG.password),
      U,
    ]);
    res.send({ auth: "updated" });
  } catch {
    res.send({ auth: "not exists" });
  }
});

// ----- ADMIN POSTS -----
// set-user-status
router.post("/admin/set-user-status", async (req, res) => {
  const { pswd, pin, user, status } = req.body;
  if (
    pswd !== decrypt(admin_pswd, DB_CONFIG.password) ||
    pin !== decrypt(admin_pin, DB_CONFIG.password)
  )
    return res.send({ auth: "incorrect" });

  const stat = Number(status);
  if (isNaN(stat)) return res.send({ error: "invalid status" });

  try {
    await db.queryAsync("UPDATE auths SET status=? WHERE username=?", [
      stat,
      user,
    ]);
    res.send({ account: "updated" });
  } catch {
    res.send({ error: "error" });
  }
});

// add-to-feed
router.post("/admin/add-to-feed", async (req, res) => {
  const { pswd, pin, content } = req.body;
  if (
    pswd !== decrypt(admin_pswd, DB_CONFIG.password) ||
    pin !== decrypt(admin_pin, DB_CONFIG.password)
  )
    return res.send({ auth: "incorrect" });

  const [date, time] = getDate();
  try {
    await db.queryAsync(
      "INSERT INTO notifs(content,record_date,record_time) VALUES(?,?,?)",
      [content.replaceAll(" ", "&nbsp;"), date, time],
    );
    res.send({ notif: "added" });
  } catch {
    res.send({ error: "error" });
  }
});

// update-user-or-common-stock
router.post("/admin/update-user-or-common-stock", async (req, res) => {
  const { pswd, pin, amount, user } = req.body;
  if (
    pswd !== decrypt(admin_pswd, DB_CONFIG.password) ||
    pin !== decrypt(admin_pin, DB_CONFIG.password)
  )
    return res.send({ auth: "incorrect" });

  const [date, time] = getDate();
  const amt = Number(amount);

  try {
    const com = (
      await db.queryAsync(
        "SELECT total_units_price,unit_price,backed_units FROM common ORDER BY id DESC LIMIT 1",
        [],
      )
    )[0];
    const lastTotal = new BigNumber(com.total_units_price);
    const lastPrice = Number(com.unit_price);
    const backed = Number(com.backed_units);

    if (amt > backed * lastPrice)
      return res.send({ limit: `AR ${backed * lastPrice}` });

    const newTotal = lastTotal.plus(amt);
    const remained = backed - amt / lastPrice;

    if (user.includes("-")) {
      // top-up client
      const U = user.toUpperCase().replaceAll(" ", "+");
      const balR = (
        await db.queryAsync(
          "SELECT balance FROM users_stock WHERE username=?",
          [U],
        )
      )[0].balance;
      const reference = createTxId(OneX);

      await new Promise((ok, ko) => {
        db.getConnection((e, conn) => {
          if (e) return ko(e);
          conn.beginTransaction(async (err) => {
            if (err) return ko(err);
            try {
              await conn
                .promise()
                .query(
                  "INSERT INTO activities(sender,receiver,type,amount,unit_price,fees,reference,record_date,record_time) VALUES(?,?,?,?,?,?,?,?,?)",
                  [OneX, U, 2, amt, lastPrice, 0, reference, date, time],
                );
              const newBal = Number(balR) + amt / lastPrice;
              await conn
                .promise()
                .query(
                  "UPDATE users_stock SET balance=?,record_date=?,record_time=? WHERE username=?",
                  [newBal, date, time, U],
                );
              await conn
                .promise()
                .query(
                  "INSERT INTO common(total_units_price,unit_price,backed_units,record_date,record_time) VALUES(?,?,?,?,?)",
                  [newTotal.toFixed(), 1, remained, date, time],
                );
              conn.commit((err2) =>
                err2 ? conn.rollback(() => ko(err2)) : ok(),
              );
            } catch (e2) {
              conn.rollback(() => ko(e2));
            }
          });
        });
      });

      res.send({ transf: "sent" });
    } else {
      // top-up common
      const newPrice = newTotal.dividedBy(lastTotal).multipliedBy(lastPrice);
      await db.queryAsync(
        "INSERT INTO common(total_units_price,unit_price,backed_units,record_date,record_time) VALUES(?,?,?,?,?)",
        [newTotal.toFixed(), newPrice.toFixed(), remained, date, time],
      );
      res.send({ total_units_price: "updated" });
    }
  } catch {
    res.send({ error: "error" });
  }
});

module.exports = router;
