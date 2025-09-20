const express = require("express");
const routes = require("./routes");
const { initDbIfEmpty, cleanup, PORT_SERVER } = require("./db");
const { httpsRedirect } = require("./utils");

const app = express();

app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ limit: "50mb", extended: true }));
app.use(httpsRedirect);

app.use("/", routes);

app.listen(PORT_SERVER, () => {
  console.log(`Server on port ${PORT_SERVER}`);
  initDbIfEmpty();
  setInterval(cleanup, 10_800_000);
});
