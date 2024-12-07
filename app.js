var mysql = require('mysql2');
require('dotenv').config()
var crypto = require('crypto-js');
const express = require('express');
const fs = require('fs');
const moment = require('moment');
const geoip = require("geoip-country");
//update db geoip regularly run "node scripts/updatedb.js"
const BigNumber = require('bignumber.js');
const fetch = require('axios');
const nodemailer = require('nodemailer');
const app = express();
app.use(express.json({
    limit: '50mb'
}));
app.use(express.urlencoded({
    limit: '50mb',
    extended: true
}));
const authsTbl = `CREATE TABLE IF NOT EXISTS auths (
id INT AUTO_INCREMENT PRIMARY KEY,
username VARCHAR(30) NOT NULL,
password VARCHAR(255) NOT NULL,
name VARCHAR(50) NOT NULL, email VARCHAR(50) NOT NULL,
birthdate VARCHAR(20) NOT NULL, cin VARCHAR(255) NOT NULL, address VARCHAR(50) NOT NULL, sk TEXT NOT NULL, category INT, ddate INT, dtime VARCHAR(10)
);`;
const stocksTbl = `CREATE TABLE IF NOT EXISTS stocks (
id INT AUTO_INCREMENT PRIMARY KEY,
username VARCHAR(30) NOT NULL, balance VARCHAR(255), ddate INT, dtime VARCHAR (10)
);`;
const adminStock = `INSERT INTO stocks (username, balance, ddate, dtime) VALUES (?,?,?,?);`;
const activitiesTbl = `CREATE TABLE IF NOT EXISTS activities (
id INT AUTO_INCREMENT PRIMARY KEY,
sender VARCHAR(30) NOT NULL, receiver VARCHAR(30) NOT NULL,
type INT,
amount VARCHAR(30) NOT NULL, kprice VARCHAR(255) NOT NULL, fees VARCHAR(30), reference VARCHAR(20), ddate INT, dtime VARCHAR(10)
);`;
const notifsTbl = `CREATE TABLE IF NOT EXISTS notifs (id INT AUTO_INCREMENT PRIMARY KEY, content TEXT, ddate INT, dtime VARCHAR(10));`;
const commonTbl = `CREATE TABLE IF NOT EXISTS common (id INT AUTO_INCREMENT PRIMARY KEY, stock VARCHAR(255) NOT NULL, kprice VARCHAR(255) NOT NULL, ddate INT, dtime VARCHAR(10));`;
var hostname = process.env.DB_HOST;
var database = process.env.DB_NAME;
var username = "";
var Username = process.env.DB_USER;
var password = process.env.DB_PSWD;
var user_mail = 'wave';
const server_mail = process.env.SERV_MAIL;
const server_mail_pswd = process.env.SERV_MAIL_PSWD;
const PORT = process.env.DB_PORT || 0;
const MAIL_PORT = process.env.MAIL_PORT;
const SERV_PORT = process.env.SERVER_PORT;
const admin_pswd = process.env.ADMIN_PSWD;
const admin_pin = process.env.ADMIN_PIN;
const stock_div = 2000000;
const app_version = process.env.APP_VERSION;
const tfees = process.env.FEES;
const first_welcome_clients = 2000;
var status = "not connected";
//create transporter object with smtp server details
const transporter = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: MAIL_PORT,
    auth: {
        user: server_mail,
        pass: server_mail_pswd
    }
});

const server = app.listen(SERV_PORT, function() {
    console.log('server running on ' + server.address().port);
    
});
server.setTimeout(120000);
function initiateDbIfEmpty() {
    //check if ADMIN exists
    const date = getDate();
    con.promise("SELECT id FROM stocks WHERE username = ?;", ['ADMIN'])
    .then((result) => result[0].id)
    .then((data) => {
        if (typeof(Number(data)) != 'number') {
            console.log('id is not a number');
        }
    }).catch((_error) => {
        console.log('ADMIN not ready, create db data now');
        let tables = [authsTbl,
            activitiesTbl,
            commonTbl,
            notifsTbl,
            stocksTbl];
        for (let i = 0; i < tables.length; i++) {
            let table = tables[i];
            con.query(table, function(err, _result) {
                if (err) console.log(table + ' NOT CREATED');
                if (table == stocksTbl) {
                    con.query(adminStock, ['ADMIN', '0', date[0], date[1]], function(err, _result) {
                        if (err) console.log('cannot add user ADMIN');
                        console.log('ADMIN is ready');
                        con.query(`INSERT INTO common (stock,kprice,ddate,dtime) values(?,?,?,?);`, [''+stock_div, '1', date[0], date[1]], function(error, _results, _fields) {
                            //stock is set to stock_div. That means 1 SU = 1 Ar.
                            if (error) {
                                console.log('set first price failed');
                            } else {
                                console.log('1SU set to 1Ar');
                            }});
                    });
                }
            });
        }
    })
}

function testUrl(link, data) {
    fetch.post(link,
        data)
    .then((response) => response.data)
    .then((data) => {
        console.log(data);
    })
    .catch(error => {
        console.log(error);
    });
}

function readFileAsync(filePath) {
    return new Promise((resolve, reject) => {
        // Read file asynchronously
        fs.readFile(filePath, 'utf8', (err,
            data) => {
            if (err) {
                reject(err);
            } else {
                resolve(data);
            }
        });
    });
}

function readFileSync(filePath) {
    return new Promise((resolve,
        reject) => {
        // Read file asynchronously
        fs.readFile(filePath,
            'base64',
            (err,
                data) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(data);
                }
            });
    });
}


app.get("/app/info", function(req, res) {
    const r = req.query.r;
    const l = req.query.l;
    var filepath = "privacy_"+l+".html";
    if (r == 'terms') {
        filepath = "terms_"+l+".html";
    }
    readFileAsync(filepath)
    .then((result) => result)
    .then((data) => {
        res.send(data);
    })
    .catch((_error) => {
        res.send('error');
    });

});

app.get("/latest/apk", function(_req, res, next) {
    res.download("./Asendi.apk", "Asendi.apk", function(err) {
        if (err) {
            next(err);
        } else {
            res.end();
        }
    });
});

app.post("/checkapp", function(_req, res) {
    const fileS = getAppFileSize();
    res.send({
        version: app_version,
        size: fileS
    });
});

function getAppFileSize() {
    const stats = fs.statSync("./Asendi.apk")
    const fileSizeInBytes = stats.size;
    const fileSizeInMegabytes = fileSizeInBytes / (1024*1024);
    return ''+fileSizeInMegabytes;
}

app.post("/app/contact", function(req, res) {
    const {
        user,
        pswd,
        subj,
        msg,
        tkn
    } = req.body;   
    const User = ('' + user).replaceAll(' ',
        '+');
    const Pswd = ('' + pswd).replaceAll(' ',
        '+');
    const userAgent = req.headers['user-agent'];
    if(userAgent != DecryptText(tkn, Pswd+User)){
        res.send({status: 'forbidden request'});
    }else{
    con.promise("SELECT password, email FROM auths WHERE username = ?",
        [User])
    .then((result) => [DecryptText(result[0].password, password),
        result[0].email])
    .then((data) => {
        if (data[0] == Pswd) {
            transporter.sendMail({
                from: server_mail,
                to: server_mail,
                subject: subj,
                html: '<b>De</b> '+data[1]+' ('+User+')'+'<br>'+msg
            },
                function(err, _info) {
                    if (err) throw err;

                });
            res.send({
                status: 'sent'
            });
        } else {
            res.send({
                status: 'error'
            });
        }
    }).catch((_error) => {
        res.send({
            status: 'error'
        });
    });
    }
});

var con = mysql.createPool({
    connectionLimit: 200,
    connectTimeout: 120000,
    host: hostname,
    user: Username,
    password: password,
    database: database,
    port: PORT,
    multipleStatements: true,
    waitForConnections: true,
    maxIdle: 100,
    idleTimeout: 120000,
    queueLimit: 200,
    enableKeepAlive: true,
    keepAliveInitialDelay: 0
});

con.getConnection((err, connection) => {
    if (err) throw err;
    console.log('Database connected');
    initiateDbIfEmpty();
    setInterval(()=> {
        let date = getDateBefore(7)[0];
        con.promise("SELECT username FROM auths WHERE (category = ? AND ddate = ?);", [0, date])
        .then((result) => result)
        .then((data) => {
            for (let i = 0; i < data.length; i++) {
                let client = data[i].username;
                con.query("DELETE FROM stocks WHERE username = ?; DELETE FROM auths WHERE username = ?;", [client, client], function(err, _result) {
                    if (err) console.log(client + ' not deleted');
                    console.log(client + ' deleted');
                });
            }
        }).catch((error)=> {
            console.log(error);
        });
    }, 10800000);
    connection.release();
});

con.promise = (sql, param) => {
    return new Promise((resolve,
        reject) => {
        con.query(sql,
            param,
            (err, result) => {
                if (err) {
                    reject(new Error());
                } else {
                    resolve(result);
                }
            });
    });
};

app.post("/admin/setcat", function(req, res) {
    const {
        pswd, pin, user, catg
    } = req.body;
    const User = (''+user).replaceAll(' ',
        '+');
    const Catg = (''+catg).replaceAll(' ',
        '+');
    if (pswd == DecryptText(admin_pswd, password)) {
        if (pin == DecryptText(admin_pin, password)) {
            if (typeof(Number(Catg)) == 'number') {
                const cat = Number(Catg);
                con.query('UPDATE auths SET category = ? WHERE username = ?', [cat, User], function(err, _result) {
                    if (err) {
                        res.send({
                            error: 'error'
                        });
                    } else {
                        res.send({
                            account: 'updated'
                        });
                    }

                });
            }}}
});

app.post("/admin/addfeed", function(req, res) {
    //optional, as wished by admin
    const {
        pswd, pin, content
    } = req.body;
    const Content = (''+ content).replaceAll(' ',
        '&nbsp;');
    const date = getDate();
    if (pswd == DecryptText(admin_pswd, password)) {
        if (pin == DecryptText(admin_pin, password)) {
            con.query('INSERT INTO notifs (content, ddate, dtime) VALUES (?,?,?);', [Content, date[0], date[1]], function(err, _result) {
                if (err) {
                    res.send({
                        error: 'error'
                    });
                } else {
                    res.send({
                        notif: 'added'
                    });
                }

            });
        }}
});

app.post("/app/feed", function(req, res) {
    //optional, as wished by admin
    const {
        user,
        pswd,
        tkn
    } = req.body;
    const User = ('' + user).replaceAll(' ',
        '+');
    const Pswd = ('' + pswd).replaceAll(' ',
        '+');
    const date = getDate()[0];
    const userAgent = req.headers['user-agent'];
    if(userAgent != DecryptText(tkn, Pswd+User)){
        res.send({feed: 'forbidden request'});
    }else{
    con.promise("SELECT password FROM auths WHERE username = ?",
        [User])
    .then((result) => DecryptText(result[0].password, password))
    .then((data) => {
        if (data == Pswd) {
            con.promise("SELECT * FROM notifs WHERE ddate = ? ORDER BY id DESC;", [date])
            .then((result) => result)
            .then((data) => {
                res.send({
                    feed: data
                });
            }).catch((_error) => {
                res.send({
                    data: 'empty'
                });
            });
        } else {
            res.send({
                data: "incorrect auth"
            });
        }
    }).catch((_error) => {
        res.send({
            data: 'error'
        });
    });
    }
});

app.post("/admin/update", function(req, res) {
    const {
        pswd, pin, amount, create
    } = req.body;
    const date = getDate();
    var new_price = 1;
    //amount must be in ariary and MAYBE A NEGATIVE NUMBER if burn type transfer
    if (pswd == DecryptText(admin_pswd, password)) {
        if (pin == DecryptText(admin_pin, password)) {
            con.promise("SELECT stock,kprice FROM common ORDER BY id DESC LIMIT 1;",
                [])
            .then((result) => [result[0].stock, result[0].kprice])
            .then((data) => {
                if (typeof(Number(data[0])) == 'number') {
                    var lastStock = BigNumber(data[0]);
                    lastPrice = Number(data[1]);
                    var new_stock = lastStock.plus(Number(amount)/lastPrice); //into SU
                    if (create == '0') {
                        //do not create new SU packet
                        new_price = lastPrice;
                    } else {
                        //create new SU packet
                        new_price = (new_stock.dividedBy(lastStock)).multipliedBy(lastPrice);
                    }
                    con.query(`INSERT INTO common (stock,kprice,ddate,dtime) values(?,?,?,?);`, [(''+new_stock.toFixed()), (''+ new_price), date[0], date[1]], function(error, _results, _fields) {
                        if (error) {
                            throw error;
                        } else {
                            res.send({
                                stock: 'updated'
                            });
                        }});
                } else {
                    res.send({
                        error: 'type error'
                    })
                }
            }).catch((_error) => {
                res.send({
                    error: 'error'
                })
            });
        } else {
            res.send({
                auth: 'incorrect'
            });
        }
    } else {
        res.send({
            auth: 'incorrect'
        });
    }
});

app.post("/app/balance", function(req, res) {
    const {
        user,
        pswd, tkn
    } = req.body;
    const User = (''+user).replaceAll(' ',
        '+');
    const Pswd = (''+pswd).replaceAll(' ',
        '+');
    const userAgent = req.headers['user-agent'];
    if(userAgent != DecryptText(tkn, Pswd+User)){
        res.send({msg: 'forbidden request'});
    }else{  
    var price = 0;
    con.promise("SELECT password FROM auths WHERE username = ?;",
        [User])
    .then((result) => DecryptText(result[0].password, password))
    .then((data) => {
        if (data == Pswd) {
            con.promise("SELECT MAX(kprice+0) AS kprice FROM common;",
                [])
            .then((result) => result[0].kprice)
            .then((data) => {
                if (typeof(Number(data)) == 'number') {
                    price = Number(data);
                    con.promise("SELECT balance FROM stocks WHERE username = ?;", [User])
                    .then((result) => result[0].balance)
                    .then((data) => {
                        var bal = Number(data) * price;
                        res.send({
                            msg: ''+bal, fees: tfees
                        });
                    }).catch((_error) => {
                        res.send({
                            msg: 'error'
                        });
                    });
                } else {
                    res.send({
                        msg: 'error'
                    })
                }
            }).catch((_error) => {
                res.send({
                    msg: 'error'
                })
            });
        } else {
            res.send({
                msg: 'error'
            });
        }
    }).catch((_error) => {
        res.send({
            msg: 'error'
        });
    });
}
});

app.post("/app/transfer", function(req, res) {
    const {
        sender,
        pswd,
        dest,
        amount,
        tkn
    } = req.body;
    //amount must be in SU
    var p = 1;
    var type = 1; //transfer between customers only
    const Sender = ('' + sender).replaceAll(' ',
        '+');
    const Pswd = ('' + pswd).replaceAll(' ',
        '+');
    const Dest = ('' + dest).replaceAll(' ',
        '+');
    const userAgent = req.headers['user-agent'];
    if(userAgent != DecryptText(tkn, Pswd+Sender)){
        res.send({transf: 'forbidden request'});
    }else{
    var am = Number((amount).replaceAll(' ', '+'));
    if(am >= 100){
    if (Sender == Dest) {
        res.send({
            transf: 'failed'
        });
    } else {
        con.promise("SELECT category FROM auths WHERE username = ?;",
            [Sender]).then((result)=> result[0].category)
        .then((data) => {
            const category = Number(data);
            if (category > 0) {
                if (category == 2 && Dest == 'ADMIN') {
                    //ADMIN is the server account name
                    //category 2 for distributor
                    type = 2; //for burning type transfer (from distributor to admin)
                }
                if (category == 1 && Dest == 'ADMIN') {
                    res.send({
                        transf: 'unsupported'
                    });
                } else {
                    con.promise("SELECT MAX(kprice+0) AS kprice FROM common;",
                        [])
                    .then((result) => result[0].kprice)
                    .then((data) => {
                        if (typeof(Number(data)) == 'number') {
                            p = Number(data);
                            var Amount = (am / p);
                            var senderBal;
                            var destBal;
                            var date = getDate();
                            var maxStockDefault = 2000000;
                            var maxStockDistr = 5000000;
                            var reference = createTransactionId(Sender);
                            var fees = (Amount*tfees)/100; //fees
                            var minRequiredSenderBal = Amount + fees;
                            var halfFees = fees/2; //this is back to the whole user as interest
                            con.promise("SELECT password FROM auths WHERE username = ?;",
                                [Sender])
                            .then((result) => DecryptText(result[0].password, password))
                            .then((data) => {
                                if (data == Pswd) {
                                    con.promise("SELECT balance FROM stocks WHERE username = ?;", [Sender])
                                    .then((result) => result[0].balance)
                                    .then((data) => {
                                        senderBal = Number(data);
                                        if (typeof(senderBal) == 'number') {
                                            if (senderBal >= minRequiredSenderBal) {
                                                con.promise("SELECT balance FROM stocks WHERE username = ?;", [Dest])
                                                .then((result) => result[0].balance)
                                                .then((data) => {
                                                    destBal = Number(data);
                                                    if (typeof(destBal) == 'number') {
                                                        const futurDestBal = (destBal + Amount);
                                                        if (Dest != 'ADMIN') {
                                                            con.promise("SELECT category FROM auths WHERE username = ?;",
                                                                [Dest]).then((result)=> result[0].category)
                                                            .then((data) => {
                                                                const categDest = Number(data);
                                                                if (categDest > 0) {

                                                                    if (categDest == 1 && (futurDestBal*p) > maxStockDefault) {
                                                                        res.send({
                                                                            transf: 'unsupported'
                                                                        });
                                                                    } else if (categDest == 2 && (futurDestBal*p) > maxStockDistr) {
                                                                        res.send({
                                                                            transf: 'unsupported'
                                                                        });
                                                                    } else {
                                                                        con.getConnection((err, connection) => {
                                                                            if (err) res.send({
                                                                                transf: 'failed'
                                                                            });
                                                                            connection.beginTransaction(function(err) {
                                                                                if (err) connection.release();
                                                                                connection.query(`INSERT INTO activities (sender,receiver,type,amount,kprice,fees,reference,ddate,dtime) values(?,?,?,?,?,?,?,?,?);`, [Sender, Dest, type, '' + Amount, ''+p, fees, reference, date[0], date[1]], function(error, _results, _fields) {
                                                                                    if (error) {
                                                                                        return connection.rollback(function(err) {
                                                                                            if (err) throw err;
                                                                                            res.send({
                                                                                                transf: 'failed'
                                                                                            });
                                                                                            connection.release();
                                                                                        });
                                                                                    }

                                                                                    const lastbs = (senderBal - minRequiredSenderBal);
                                                                                    connection.query('UPDATE stocks SET balance = ?, ddate = ?, dtime = ? WHERE username = ?;',
                                                                                        [('' + lastbs),
                                                                                            date[0],
                                                                                            date[1],
                                                                                            Sender],
                                                                                        function(error, _results, _fields) {
                                                                                            if (error) {
                                                                                                return connection.rollback(function(err) {
                                                                                                    if (err) throw err;
                                                                                                    res.send({
                                                                                                        transf: 'failed'
                                                                                                    });
                                                                                                    connection.release();
                                                                                                });
                                                                                            }

                                                                                            connection.query('UPDATE stocks SET balance = ?, ddate = ?, dtime = ? WHERE username = ?;',
                                                                                                [('' + futurDestBal),
                                                                                                    date[0],
                                                                                                    date[1],
                                                                                                    Dest],
                                                                                                function(error, _results, _fields) {
                                                                                                    if (error) {
                                                                                                        return connection.rollback(function(err) {
                                                                                                            if (err) throw err;
                                                                                                            res.send({
                                                                                                                transf: 'failed'
                                                                                                            });
                                                                                                            connection.release();
                                                                                                        });
                                                                                                    }
                                                                                                    connection.query("SELECT stock,kprice FROM common ORDER BY id DESC LIMIT 1;",
                                                                                                        function(err, result) {
                                                                                                            if (err) {

                                                                                                                return connection.rollback(function(err) {
                                                                                                                    if (err) throw err;
                                                                                                                    res.send({
                                                                                                                        transf: 'failed'
                                                                                                                    });
                                                                                                                    connection.release();
                                                                                                                });
                                                                                                            }
                                                                                                            const data = [result[0].stock, result[0].kprice];
                                                                                                            if (typeof(Number(data[0])) == 'number') {
                                                                                                                var lastStock = BigNumber(data[0]);
                                                                                                                var lastPrice = Number(data[1]);
                                                                                                                var new_stock = lastStock.plus(halfFees);
                                                                                                                var new_price = (new_stock.dividedBy(lastStock)).multipliedBy(lastPrice);
                                                                                                                connection.query(`INSERT INTO common (stock,kprice,ddate,dtime) values(?,?,?,?);`, [(''+new_stock.toFixed()), (''+ new_price), date[0], date[1]], function(error, _results, _fields) {
                                                                                                                    if (error) {
                                                                                                                        return connection.rollback(function(err) {
                                                                                                                            if (err) throw err;
                                                                                                                            res.send({
                                                                                                                                transf: 'failed'
                                                                                                                            });
                                                                                                                            connection.release();
                                                                                                                        });
                                                                                                                    }
                                                                                                                    connection.commit(function(err) {
                                                                                                                        if (err) {
                                                                                                                            return connection.rollback(function(err) {
                                                                                                                                if (err) throw err;
                                                                                                                                res.send({
                                                                                                                                    transf: 'failed'
                                                                                                                                });
                                                                                                                                connection.release();
                                                                                                                            });
                                                                                                                        }
                                                                                                                        res.send({
                                                                                                                            transf: 'sent'
                                                                                                                        });

                                                                                                                    });


                                                                                                                });
                                                                                                            } else {
                                                                                                                return connection.rollback(function(err) {
                                                                                                                    if (err) throw err;
                                                                                                                    res.send({
                                                                                                                        transf: 'failed'
                                                                                                                    });
                                                                                                                    connection.release();
                                                                                                                });
                                                                                                            }
                                                                                                        });

                                                                                                });
                                                                                        });
                                                                                });
                                                                            });

                                                                        });
                                                                    }} else {
                                                                    res.send({
                                                                        transf: 'failed'
                                                                    });
                                                                }
                                                            }).catch((_error) => {
                                                                res.send({
                                                                    transf: 'failed'
                                                                });
                                                            });
                                                        } else {
                                                            con.getConnection((err, connection) => {
                                                                if (err) res.send({
                                                                    transf: 'failed'
                                                                });
                                                                connection.beginTransaction(function(err) {
                                                                    if (err) connection.release();
                                                                    connection.query(`INSERT INTO activities (sender,receiver,type,amount,kprice,fees,reference,ddate,dtime) values(?,?,?,?,?,?,?,?,?);`, [Sender, Dest, type, '' + Amount, ''+p, fees, reference, date[0], date[1]], function(error, _results, _fields) {
                                                                        if (error) {
                                                                            return connection.rollback(function(err) {
                                                                                if (err) throw err;
                                                                                res.send({
                                                                                    transf: 'failed'
                                                                                });
                                                                                connection.release();
                                                                            });
                                                                        }

                                                                        const lastbs = (senderBal - minRequiredSenderBal);
                                                                        connection.query('UPDATE stocks SET balance = ?, ddate = ?, dtime = ? WHERE username = ?;',
                                                                            [('' + lastbs),
                                                                                date[0],
                                                                                date[1],
                                                                                Sender],
                                                                            function(error, _results, _fields) {
                                                                                if (error) {
                                                                                    return connection.rollback(function(err) {
                                                                                        if (err) throw err;
                                                                                        res.send({
                                                                                            transf: 'failed'
                                                                                        });
                                                                                        connection.release();
                                                                                    });
                                                                                }

                                                                                connection.query('UPDATE stocks SET balance = ?, ddate = ?, dtime = ? WHERE username = ?;',
                                                                                    [('' + futurDestBal),
                                                                                        date[0],
                                                                                        date[1],
                                                                                        Dest],
                                                                                    function(error, _results, _fields) {
                                                                                        if (error) {
                                                                                            return connection.rollback(function(err) {
                                                                                                if (err) throw err;
                                                                                                res.send({
                                                                                                    transf: 'failed'
                                                                                                });
                                                                                                connection.release();
                                                                                            });
                                                                                        }
                                                                                        connection.query("SELECT stock,kprice FROM common ORDER BY id DESC LIMIT 1;",
                                                                                            function(err, result) {
                                                                                                if (err) {

                                                                                                    return connection.rollback(function(err) {
                                                                                                        if (err) throw err;
                                                                                                        res.send({
                                                                                                            transf: 'failed'
                                                                                                        });
                                                                                                        connection.release();
                                                                                                    });
                                                                                                }
                                                                                                const data = [result[0].stock, result[0].kprice];
                                                                                                if (typeof(Number(data[0])) == 'number') {
                                                                                                    var lastStock = BigNumber(data[0]);
                                                                                                    var lastPrice = Number(data[1]);
                                                                                                    var new_stock = lastStock.plus(halfFees);
                                                                                                    var new_price = (new_stock.dividedBy(lastStock)).multipliedBy(lastPrice);
                                                                                                    connection.query(`INSERT INTO common (stock,kprice,ddate,dtime) values(?,?,?,?);`, [(''+new_stock.toFixed()), (''+ new_price), date[0], date[1]], function(error, _results, _fields) {
                                                                                                        if (error) {
                                                                                                            return connection.rollback(function(err) {
                                                                                                                if (err) throw err;
                                                                                                                res.send({
                                                                                                                    transf: 'failed'
                                                                                                                });
                                                                                                                connection.release();
                                                                                                            });
                                                                                                        }
                                                                                                        connection.commit(function(err) {
                                                                                                            if (err) {
                                                                                                                return connection.rollback(function(err) {
                                                                                                                    if (err) throw err;
                                                                                                                    res.send({
                                                                                                                        transf: 'failed'
                                                                                                                    });
                                                                                                                    connection.release();
                                                                                                                });
                                                                                                            }
                                                                                                            res.send({
                                                                                                                transf: 'sent'
                                                                                                            });

                                                                                                        });


                                                                                                    });
                                                                                                } else {
                                                                                                    return connection.rollback(function(err) {
                                                                                                        if (err) throw err;
                                                                                                        res.send({
                                                                                                            transf: 'failed'
                                                                                                        });
                                                                                                        connection.release();
                                                                                                    });
                                                                                                }
                                                                                            });

                                                                                    });
                                                                            });
                                                                    });
                                                                });

                                                            });
                                                        }
                                                    } else {
                                                        res.send({
                                                            transf: 'failed'
                                                        });

                                                    }
                                                }).catch((_error) => {
                                                    res.send({
                                                        transf: 'no dest'
                                                    });
                                                });
                                            } else {
                                                res.send({
                                                    transf: 'insufficient balance'
                                                });
                                            }
                                        } else {
                                            res.send({
                                                transf: 'failed'
                                            });

                                        }
                                    }).catch((_error) => {
                                        res.send({
                                            transf: 'failed'
                                        });
                                    });
                                } else {
                                    res.send({
                                        transf: "failed"
                                    });
                                }
                            }).catch((_error) => {
                                res.send({
                                    transf: 'no exp'
                                });
                            });

                        } else {
                            res.send({
                                transf: 'failed'
                            });
                        }


                    }).catch((_error) => {
                        res.send({
                            transf: 'failed'
                        });
                    });
                }
            } else {
                res.send({
                    transf: 'failed'
                });
            }

        }).catch((_error) => {
            res.send({
                transf: 'failed'
            });
        });
    }
}else{
    res.send({warning: 'abusive operation'});
}}
});

app.post("/app/signin", function(req,
    res) {

    const {
        user,
        pswd,
        tkn,
        recon,
        sk
    } = req.body;
    const User = ('' + user).replaceAll(' ',
        '+');
    const Pswd = ('' + pswd).replaceAll(' ',
        '+');
    const userAgent = req.headers['user-agent'];
    if(userAgent != DecryptText(tkn, Pswd+User)){
        if(recon == '0'){
        res.send({msg: 'forbidden request', ua:''});
        }else{
            con.promise("SELECT password,sk FROM auths WHERE username = ?",
                [User])
            .then((result) => [DecryptText(result[0].password, password), DecryptText(result[0].sk, password)])
            .then((data) => {
                if (data[0] == Pswd) {
                    if(data[1] == sk){
                    const encUA = EncryptText(userAgent, Pswd+User);
                    con.promise("SELECT category FROM auths WHERE username = ?",
                        [User])
                    .then((result) => result[0].category)
                    .then((data) => {
                        if (data == 0) {
                            con.query('UPDATE auths SET category = ? WHERE username = ?', [1, User], function(err, _result) {
                                if (err) throw err;
                                status = "1";
                                res.send({
                                    msg: status, ua: encUA
                                });
                                con.promise("SELECT id FROM auths WHERE username = ?",
                                    [User])
                                .then((result) => result[0].id)
                                .then((data) => {
                                    if (data <= first_welcome_clients) {
                                        con.query('UPDATE stocks SET balance = ? WHERE username = ?', ['2000', User], function(err, _result) {
                                            if (err) throw err;
                                            console.log('bonus shared')
                                        });
                                    }
                                }).catch((error) => {
                                    throw error;
                                });
        
                            });
                        } else {
                            res.send({
                                msg: data, ua: encUA
                            });
                        }
                    }).catch((error) => {
                        throw error;
                    });
                }else{
                    res.send({
                        msg: "incorrect secret word", ua:''
                    });   
                }
                } else {
                    res.send({
                        msg: "incorrect password", ua:''
                    });
                }
            }).catch((_error) => {
                res.send({
                    msg: 'error', ua:''
                });
            });  
        }
    }else{
    con.promise("SELECT password FROM auths WHERE username = ?",
        [User])
    .then((result) => DecryptText(result[0].password, password))
    .then((data) => {
        if (data == Pswd) {
            const encUA = EncryptText(userAgent, Pswd+User);
            con.promise("SELECT category FROM auths WHERE username = ?",
                [User])
            .then((result) => result[0].category)
            .then((data) => {
                if (data == 0) {
                    con.query('UPDATE auths SET category = ? WHERE username = ?', [1, User], function(err, _result) {
                        if (err) throw err;
                        status = "1";
                        res.send({
                            msg: status, ua: encUA
                        });
                        con.promise("SELECT id FROM auths WHERE username = ?",
                            [User])
                        .then((result) => result[0].id)
                        .then((data) => {
                            if (data <= first_welcome_clients) {
                                con.query('UPDATE stocks SET balance = ? WHERE username = ?', ['2000', User], function(err, _result) {
                                    if (err) throw err;
                                    console.log('bonus shared')
                                });
                            }
                        }).catch((error) => {
                            throw error;
                        });

                    });
                } else {
                    res.send({
                        msg: data, ua: encUA
                    });
                }
            }).catch((error) => {
                throw error;
            });

        } else {
            res.send({
                msg: "incorrect auth"
            });
        }
    }).catch((_error) => {
        res.send({
            msg: 'error'
        });
    });
    }
});

app.post("/app/mpc", function(req,
    res) {
    const {
        user,
        pswd1,
        pswd2,
        tkn
    } = req.body;
    const User = ('' + user).replaceAll(' ',
        '+');
    const Pswd1 = ('' + pswd1).replaceAll(' ',
        '+');
    const Pswd2 = ('' + pswd2).replaceAll(' ',
        '+');
    const userAgent = req.headers['user-agent'];
    if(userAgent != DecryptText(tkn, Pswd1+User)){
        res.send({auth: 'forbidden request'});
    }else{
    con.promise("SELECT password FROM auths WHERE username = ?",
        [User])
    .then((result) => DecryptText(result[0].password, password))
    .then((data) => {
        if (data == Pswd1) {
            con.query('UPDATE auths SET password = ? WHERE username = ?', [EncryptText(Pswd2, password), User], function(err, _result) {
                if (err) throw err;
                res.send({
                    auth: 'updated'
                });
            });
        } else {
            res.send({
                auth: "incorrect"
            });
        }
    }).catch((_error) => {
        res.send({
            auth: 'error'
        });
    });
}
});

app.post("/app/dltacc", function(req,
    res) {
    const {
        user,
        pswd,
        tkn
    } = req.body;
    const User = (''+user).replaceAll(' ',
        '+');
    const Pswd = (''+pswd).replaceAll(' ',
        '+');
    var price = 0;
    const userAgent = req.headers['user-agent'];
    if(userAgent != DecryptText(tkn, Pswd+User)){
        res.send({auth: 'forbidden request'});
    }else{
    con.promise("SELECT password FROM auths WHERE username = ?",
        [User])
    .then((result) => DecryptText(result[0].password, password))
    .then((data) => {
        if (data == Pswd) {
            con.promise("SELECT ppu FROM common ORDER BY id DESC LIMIT 1;",
                [])
            .then((result) => result[0].ppu)
            .then((data) => {
                if (typeof(Number(data)) == 'number') {
                    price = Number(data);
                    con.promise("SELECT balance FROM stocks WHERE username = ?;", [User])
                    .then((result) => result[0].balance)
                    .then((data) => {
                        var bal = Number(data) * price;
                        if (bal <= 1000) {
                            //accept the delete request
                            con.query('DELETE FROM auths WHERE username = ?', [User], function(err, _result) {
                                if (err) throw err;
                                res.send({
                                    auth: "deleted"
                                });
                            });

                        } else {
                            res.send({
                                auth: 'failed, balance > 1000'
                            });
                        }
                    }).catch((_error) => {
                        res.send({
                            auth: 'error'
                        });
                    });
                } else {
                    res.send({
                        auth: 'error'
                    })
                }
            }).catch((_error) => {
                res.send({
                    auth: 'error'
                })
            });
        } else {
            res.send({
                auth: "incorrect"
            });
        }
    }).catch((_error) => {
        res.send({
            auth: 'error'
        });
    });
}
});

app.post("/app/reacc", function(req,
    res) {
    const {
        user,
        sk
    } = req.body;
    const User = ('' + user).replaceAll(' ',
        '+');
    const Sk = ('' + sk).replaceAll(' ',
        '+');
    con.promise("SELECT sk FROM auths WHERE username = ?",
        [User])
    .then((result) => DecryptText(result[0].sk, password))
    .then((data) => {
        if (data == Sk) {
            let newPC = EncryptText('123456', password);
            con.query('UPDATE auths SET password = ? WHERE username = ?', [newPC, User], function(err, _result) {
                if (err) throw err;
                res.send({
                    auth: 'updated'
                });
            });
        } else {
            res.send({
                auth: "incorrect"
            });
        }
    }).catch((_error) => {
        res.send({
            auth: 'error'
        });
    });
});

app.post("/app/msk", function(req,
    res) {
    const {
        user,
        pswd,
        sk,
        tkn
    } = req.body;
    const User = ('' + user).replaceAll(' ',
        '+');
    const Pswd = ('' + pswd).replaceAll(' ',
        '+');
    const Sk = ('' + sk).replaceAll(' ',
        '+');
    const userAgent = req.headers['user-agent'];
    if(userAgent != DecryptText(tkn, Pswd+User)){
        res.send({auth: 'forbidden request'});
    }else{
    con.promise("SELECT password FROM auths WHERE username = ?",
        [User])
    .then((result) => DecryptText(result[0].password, password))
    .then((data) => {
        if (data == Pswd) {
            let ek = "" + EncryptText(Sk, password);
            con.query('UPDATE auths SET sk = ? WHERE username = ?', [ek, User], function(err, _result) {
                if (err) throw err;
                res.send({
                    auth: 'updated'
                });
            });
        } else {
            res.send({
                auth: "incorrect"
            });
        }
    }).catch((_error) => {
        res.send({
            auth: 'not exists'
        });
    });
}
});


app.post("/app/signup",
    function(req,
        res) {
        //prevent sql injection by replacing or modifying vulnerable data.
        const {
            email,
            birth,
            addr,
            name,
            cin,
            pswd,
            sk,
            cinimg1,
            cinimg2
        } = req.body;
        const userIp  = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
        const geo = geoip.lookup(userIp);
        if (geo) {
        var country = geo.country;
        if(country == 'MG'){
        const Email = ('' + (email)).replaceAll(' ',
            '+');
        const Birth = ('' + (birth)).replaceAll(' ',
            '+');
        const Address = ('' + (addr)).replaceAll(' ',
            '+');
        const Name = ('' + (name)).replaceAll(' ',
            '+');
        const Cin = EncryptText(('' + cin).replaceAll(' ',
            '+'), password);
        const Pswd = EncryptText(('' + pswd).replaceAll(' ',
            '+'), password);
        const Secretkey = EncryptText(('' + (sk)).replaceAll(' ',
            '+'), password);
        var user_suffix_name = '' + createUserSuffixName(cin);
        var user_prefix_name = '' + getUserPrefixName(Name);
        username = '' + (user_prefix_name + "-" + user_suffix_name).toUpperCase();
        const cin_img1 = '' + cinimg1;
        const cin_img2 = '' + cinimg2;
        const date = getDate();
        //Check if user_prefix_name + user_suffix_name already exists.
        //If exists, recreate again.
        con.query("SELECT * FROM auths WHERE username = ?;",
            [username],
            function(error,
                result,
                _field) {
                if (error) throw error;
                if (result.length > 0) {
                    res.send({
                        msg: 'retry'
                    });
                } else {
                    var data = [username,
                        Pswd,
                        Name,
                        Email,
                        Birth,
                        Cin,
                        Address,
                        Secretkey,
                        0,
                        date[0],
                        date[1]];
                    con.getConnection((err, connection) => {
                        if (err) res.send({
                            msg: 'failed'
                        });
                        connection.beginTransaction(function(err) {
                            if (err) connection.release();
                            connection.query('INSERT INTO auths (username, password, name, email, birthdate, cin, address, sk, category, ddate, dtime) VALUES (?,?,?,?,?,?,?,?,?,?,?);', data, function(error, _results, _fields) {
                                if (error) {
                                    return connection.rollback(function(err) {
                                        if (err) throw err;
                                        res.send({
                                            msg: 'failed'
                                        });
                                        connection.release();
                                    });
                                }
                                connection.query('INSERT INTO stocks (username,balance,ddate,dtime) values(?,?,?,?);',
                                    [username,
                                        '0',
                                        date[0],
                                        date[1]],
                                    function(error, _results, _fields) {
                                        if (error) {
                                            return connection.rollback(function(err) {
                                                if (err) throw err;
                                                res.send({
                                                    msg: 'failed'
                                                });
                                                connection.release();
                                            });
                                        }
                                        connection.commit(function(err) {
                                            if (err) {
                                                return connection.rollback(function(err) {
                                                    if (err) throw err;
                                                    res.send({
                                                        msg: 'failed'
                                                    });
                                                    connection.release();
                                                });
                                            }
                                            transporter.sendMail({
                                                from: server_mail,
                                                to: Email,
                                                subject: 'Nouvelle inscription',
                                                html: '<h2>Bienvenue cher(e) client(e),</h2><br>Vous venez de vous inscrire sur notre plateforme. Votre identifiant est :<br><b>' + username + '</b><br>Pour activer une fois votre compte, connectez-vous avec l&apos;identifiant ci-dessus dans le d&eacute;lai de 7 jours.<br><br><br>L&apos;&eacute;quipe Asendi,'
                                            },
                                                function(err, _info) {
                                                    if (err) throw err;
                                                });
                                            sendCinImagesForVerification('' + username + '<br>' + Name + '<br>' + Birth + '<br>' + Address + '<br>' + cin,
                                                cin_img1,
                                                cin_img2);
                                            res.send({
                                                msg: 'ok'
                                            });
                                            connection.release();
                                        });
                                    });
                            });
                        });
                    });

                }


            }); }else{
                res.send({
                    msg: 'unsupported country'
                });
            }}else{
                res.send({
                    msg: 'what country'
                });
            }
    });

app.post("/app/transrec", function(req, res) {
    const {
        user, pswd, days, tkn
    } = req.body;
    const daybefore = getDateBefore(Number(days))[0];
    //restoreCurrentDate(Number(days));
    const User = ('' + user).replaceAll(' ',
        '+');
    const Pswd = ('' + pswd).replaceAll(' ',
        '+');
    const userAgent = req.headers['user-agent'];
    if(userAgent != DecryptText(tkn, Pswd+User)){
        res.send({trans: 'forbidden request'});
    }else{
    con.promise("SELECT password FROM auths WHERE username = ?",
        [User])
    .then((result) => DecryptText(result[0].password, password))
    .then((data) => {
        if (data == Pswd) {
            con.promise("SELECT * FROM activities WHERE (ddate >= ? AND (sender = ? OR receiver = ?)) ORDER BY id DESC;", [daybefore, User, User])
            .then((result) => result)
            .then((data) => {
                const d = {
                    trans: data
                };
                res.send(d);
            }).catch((_error) => {
                res.send({
                    trans: 'error'
                });
            });
        } else {
            res.send({
                trans: 'error'
            });
        }}).catch((_error)=> {
        res.send({
            trans: 'error'
        });
    });
}
});

function sendCinImagesForVerification(detailUser, cin1, cin2) {
    //This is used only by inside the data center.
    transporter.sendMail({
        from: server_mail,
        to: 'eddy.heriniaina.rafidison@gmail.com',
        subject: 'Account Verification',
        html: detailUser,
        attachments: [{
            filename: "cin_1.png", //cin1
            content: cin1,
            encoding: "base64",
        },
            {
                filename: "cin_2.png", //cin2
                content: cin2,
                encoding: "base64",
            }]
    }, function(err,
        _info) {
        if (err) throw err;
    });
}

function EncryptText(toEncrypt, ps) {
    var toEnc = crypto.AES.encrypt(toEncrypt,
        ps).toString();
    return toEnc;
}

function DecryptText(encrypted, ps) {
    var decr = crypto.AES.decrypt(encrypted,
        ps).toString(crypto.enc.Utf8);
    return decr;
}

function getDate() {
    //get Madagascar time zone
    const moment_ = moment();
    moment_.utcOffset(3);
    return parseDateTime(moment_.toISOString(true));
}

function getDateBefore(days) {
    const moment_ = moment();
    moment_.utcOffset(3);
    return parseDateTime((moment_.subtract(days, 'days')).toISOString(true));
}

function restoreCurrentDate(days) {
    const moment_ = moment();
    moment_.utcOffset(3);
    return moment_.add(days,
        'days');
}

function parseDateTime(date) {
    var yyyy = date.substring(0,
        4);
    var mm = date.substring(5,
        7);
    var dd = date.substring(8,
        10);
    var hh = date.substring(11,
        13);
    var MM = date.substring(14,
        16);
    var ss = date.substring(17,
        19);
    return [parseInt(yyyy + mm + dd), (hh + MM + ss)];
}

function createUserSuffixName(cin) {
    try {
        let ts = Date.now();
        var cinp1 = parseInt(cin.charAt(7));
        var cinp2 = parseInt(cin.charAt(8));
        var cinp3 = parseInt(cin.charAt(9));
        var cinp4 = parseInt(cin.charAt(10));
        var letters = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M', 'N', 'O', 'P', 'Q', 'R', 'S', 'T', 'U', 'V', 'W', 'X', 'Y', 'Z', '9', '8', '7', '6', '5', '4', '3', '2', '1', '0']
        var date_time = new Date(ts);
        var date = date_time.getDate();
        var df = {
            day: '2-digit',
            month: '2-digit',
            year: 'numeric'
        };
        var tf = {
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            fractionalSecondDigits: 2
        };
        var formatter = new Intl.DateTimeFormat('fr-FR',
            df);
        var formattedDate = formatter.format(date_time);
        formatter = new Intl.DateTimeFormat('fr-FR',
            tf);
        var formattedTime = formatter.format(date_time);
        var day = formattedDate.substring(0,
            2);
        var mon = formattedDate.substring(3,
            5);
        var ye = formattedDate.substring(6,
            10);
        var h = formattedTime.substring(0,
            2);
        var mn = formattedTime.substring(3,
            5);
        var s = formattedTime.substring(6,
            8);
        var ms = formattedTime.substring(9,
            11);
        var dp1 = day.substring(0,
            1);
        var dp2 = day.substring(1,
            2);
        var mp1 = mon.substring(0,
            1);
        var mp2 = mon.substring(1,
            2);
        var yp1 = ye.substring(0,
            1);
        var yp2 = ye.substring(1,
            2);
        var yp3 = ye.substring(2,
            3);
        var yp4 = ye.substring(3,
            4);
        var hp1 = h.substring(0,
            1);
        var hp2 = h.substring(1,
            2);
        var mnp1 = mn.substring(0,
            1);
        var mnp2 = mn.substring(1,
            2);
        var sp1 = s.substring(0,
            1);
        var sp2 = s.substring(1,
            2);
        var msp1 = ms.substring(0,
            1);
        var msp2 = ms.substring(1,
            2);
        var g1 = parseInt(dp1) + parseInt(dp2) + parseInt(mp1) + parseInt(mp2) + cinp2;
        var g2 = parseInt(yp1) + parseInt(yp2) + parseInt(yp3) + parseInt(yp4) + cinp4;
        var g3 = parseInt(hp1) + parseInt(hp2) + parseInt(mnp1) + parseInt(mnp2) + cinp1;
        var g4 = parseInt(sp1) + parseInt(sp2) + parseInt(msp1) + parseInt(msp2) + cinp3;
        if (g1 > 36) {
            g1 = g1 - cinp2;
        }
        if (g2 > 36) {
            g2 = g2 - cinp4;
        }
        if (g3 > 36) {
            g3 = g3 - cinp1;
        } else if (g3 < 1) {
            g3 = 1;
        }
        if (g4 > 36) {
            g4 = g4 - cinp3;
        } else if (g4 < 1) {
            g4 = 1;
        }
        return (letters[g3 - 1] + letters[g2 - 1] + "" + letters[g4 - 1] + "" + letters[g1 - 1]);
    } catch (error) {
        console.log("error cin")
    }
}

function createTransactionId(sender) {
    const date = getDate();
    const crypto = require("crypto");
    return crypto.createHash("shake256", {
        outputLength: 7
    })
    .update(('' + (date[0] + sender + date[1])))
    .digest("hex");
}

function getUserPrefixName(fullname) {
    var arr = [fullname];
    if (fullname.includes("+")) {
        arr = fullname.split("+");
    }
    if (fullname.includes("%20")) {
        arr = fullname.split("%20");
    }
    return arr[arr.length - 1];
}