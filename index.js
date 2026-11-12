process.env.TZ = "UTC";

const express = require("express");
const routes = require("./routes");
const { initDbIfEmpty, cleanup, PORT_SERVER } = require("./db");
const { httpsRedirect } = require("./utils");
const { startSellerLifecycleWorker } = require("./seller-worker");

const app = express();

app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ limit: "50mb", extended: true }));

app.use("/", routes);

async function startServer() {
  try {
    await initDbIfEmpty();
    startSellerLifecycleWorker();
    await routes.initializeRechargePayments();
  } catch (error) {
    console.error("Server initialization failed. Server startup aborted:", error);
    process.exit(1);
  }

  app.listen(PORT_SERVER, () => {
    console.log(`Server on port ${PORT_SERVER}`);
    setInterval(cleanup, 10_800_000);
  });
}

startServer();
