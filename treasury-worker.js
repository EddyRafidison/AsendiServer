"use strict";

require("dotenv").config();
const path = require("path");
require("dotenv").config({
  path: path.resolve(process.cwd(), process.env.USDT_TREASURY_ENV_FILE || ".env.treasury"),
});

const {
  JsonRpcProvider,
  Wallet,
  Contract,
  Interface,
  getAddress,
  keccak256,
} = require("ethers");
const BigNumber = require("bignumber.js");
const { db, initDbIfEmpty } = require("./db");
const {
  getHotWalletReserveAmounts,
  calculateHotWalletLiquidity,
  CANONICAL_BSC_USD_CONTRACT,
} = require("./treasury-liquidity");
const { getBnbUsdPrice } = require("./bsc-price-oracle");
const { attachEthersRpcMetrics } = require("./bsc-rpc-ethers-metrics");
const { getConfiguredMaxBscTxFeeUsd } = require("./bsc-transaction-policy");

const CHAIN_ID = 56n;
const TOKEN_DECIMALS = 18;
const TOKEN_INTERFACE = new Interface([
  "function transfer(address to,uint256 value) returns (bool)",
  "event Transfer(address indexed from,address indexed to,uint256 value)",
]);
const WORKER_LOCK_NAME = "onex_cold_wallet_sweep_worker";
const HOT_WALLET_SPEND_LOCK = "onex_hot_wallet_spend";
const POLL_MS = Math.max(5000, Math.min(60000, Number(process.env.USDT_COLD_SWEEP_POLL_MS || 30000)));
let timer = null;
let running = false;

function requiredAddress(value, label) {
  try {
    return getAddress(String(value || "").trim());
  } catch {
    throw new Error(`${label} must be a valid BNB Smart Chain address.`);
  }
}

function asAmountRaw(value) {
  const amount = new BigNumber(value);
  if (!amount.isFinite() || !amount.isGreaterThan(0)) throw new Error("Cold Wallet sweep amount must be positive.");
  return BigInt(amount.shiftedBy(TOKEN_DECIMALS).integerValue(BigNumber.ROUND_DOWN).toFixed(0));
}

async function acquireNamedLock(dbPool, lockName) {
  const connection = await new Promise((resolve, reject) => {
    dbPool.getConnection((error, conn) => error ? reject(error) : resolve(conn));
  });
  const queryable = connection.promise();
  try {
    const [rows] = await queryable.query("SELECT GET_LOCK(?,0) AS acquired", [lockName]);
    if (Number(rows[0]?.acquired) !== 1) {
      connection.release();
      return null;
    }
    return async () => {
      try {
        await queryable.query("SELECT RELEASE_LOCK(?)", [lockName]);
      } finally {
        connection.release();
      }
    };
  } catch (error) {
    connection.release();
    throw error;
  }
}

async function withHotWalletSpendLock(dbPool, callback) {
  const release = await acquireNamedLock(dbPool, HOT_WALLET_SPEND_LOCK);
  if (!release) return { skipped: "hot_wallet_busy" };
  try {
    return await callback();
  } finally {
    await release();
  }
}

function verifyTransferReceipt(receipt, job) {
  const expectedFrom = String(job.source_address).toLowerCase();
  const expectedTo = String(job.destination_address).toLowerCase();
  const expectedAmount = BigInt(job.amount_raw);
  for (const log of receipt.logs || []) {
    if (String(log.address).toLowerCase() !== String(job.token_contract).toLowerCase()) continue;
    try {
      const parsed = TOKEN_INTERFACE.parseLog(log);
      if (
        parsed?.name === "Transfer" &&
        String(parsed.args.from).toLowerCase() === expectedFrom &&
        String(parsed.args.to).toLowerCase() === expectedTo &&
        BigInt(parsed.args.value) === expectedAmount
      ) return true;
    } catch {}
  }
  return false;
}

async function finalizeSweep(dbPool, job, receipt, provider) {
  const now = String(Date.now());
  const actualFeeWei = BigInt(receipt.gasUsed) * BigInt(receipt.gasPrice || receipt.effectiveGasPrice || 0);
  let bnbUsd = new BigNumber(0);
  try { bnbUsd = await getBnbUsdPrice(provider); } catch {}
  const actualFeeBnb = new BigNumber(actualFeeWei.toString()).shiftedBy(-18);
  const actualFeeUsd = actualFeeBnb.multipliedBy(bnbUsd);
  if (Number(receipt.status) !== 1 || !verifyTransferReceipt(receipt, job)) {
    await dbPool.queryAsync(
      `UPDATE bsc_treasury_sweeps SET status='manual_review',block_number=?,actual_fee_bnb=?,actual_fee_usd=?,
       last_error=?,updated_at_ms=? WHERE id=? AND status IN ('signed','submitted','manual_review')`,
      [String(receipt.blockNumber), actualFeeBnb.toFixed(30), actualFeeUsd.toFixed(18),
        Number(receipt.status) !== 1 ? "Cold Wallet sweep transaction reverted on-chain." : "Confirmed transaction did not contain the expected BSC-USD transfer event.", now, job.id],
    );
    return { manualReview: true };
  }
  const scanner = await ensureIncomingScannerCaughtUp(dbPool, provider, {
    token: job.token_contract,
    treasury: job.source_address,
  });
  if (!scanner.ready || BigInt(scanner.safe_block) < BigInt(receipt.blockNumber)) {
    return {
      waitingFinality: true,
      scanner_reason: scanner.ready ? "sweep_block_not_finalized" : scanner.reason,
    };
  }
  await dbPool.queryAsync(
    `UPDATE bsc_treasury_sweeps SET status='confirmed',block_number=?,actual_fee_bnb=?,actual_fee_usd=?,
     last_error=NULL,confirmed_at_ms=?,updated_at_ms=? WHERE id=? AND status IN ('signed','submitted')`,
    [String(receipt.blockNumber), actualFeeBnb.toFixed(30), actualFeeUsd.toFixed(18), now, now, job.id],
  );
  return { confirmed: true, tx_hash: job.tx_hash };
}

async function resumePendingSweep(dbPool, provider, signer, token) {
  const rows = await dbPool.queryAsync(
    `SELECT * FROM bsc_treasury_sweeps
     WHERE status IN ('queued','signed','submitted','manual_review')
     ORDER BY id ASC LIMIT 1`,
  );
  if (!rows.length) return { pending: false };
  const job = rows[0];
  if (job.status === "queued") {
    await dbPool.queryAsync(
      "UPDATE bsc_treasury_sweeps SET status='manual_review',last_error=?,updated_at_ms=? WHERE id=? AND status='queued'",
      ["A sweep was queued without a persisted signed transaction. Administrator review is required before creating a replacement.", String(Date.now()), job.id],
    );
    return { pending: true, manualReview: true, sweep_id: String(job.id) };
  }
  if (job.status === "manual_review") return { pending: true, manualReview: true, sweep_id: String(job.id) };

  let receipt = await provider.getTransactionReceipt(job.tx_hash);
  if (!receipt) {
    const known = await provider.getTransaction(job.tx_hash);
    if (!known && job.raw_tx) {
      try {
        await provider.broadcastTransaction(job.raw_tx);
      } catch (error) {
        if (!/already known|known transaction|already imported/i.test(String(error.message || ""))) {
          await dbPool.queryAsync(
            "UPDATE bsc_treasury_sweeps SET last_error=?,updated_at_ms=? WHERE id=? AND status IN ('signed','submitted')",
            [String(error.message || error).slice(0, 1000), String(Date.now()), job.id],
          );
        }
      }
    }
    if (job.status === "signed") {
      await dbPool.queryAsync(
        "UPDATE bsc_treasury_sweeps SET status='submitted',updated_at_ms=? WHERE id=? AND status='signed'",
        [String(Date.now()), job.id],
      );
    }
    return { pending: true, sweep_id: String(job.id) };
  }
  return { pending: true, ...(await finalizeSweep(dbPool, job, receipt, provider)), sweep_id: String(job.id) };
}

async function ensureIncomingScannerCaughtUp(dbPool, provider, addresses) {
  if (String(process.env.USDT_PAYMENTS_ENABLED || "false").toLowerCase() !== "true") {
    return { ready: false, reason: "incoming_payments_scanner_disabled" };
  }
  const rows = await dbPool.queryAsync(
    `SELECT chain_id,token_contract,treasury_address,last_scanned_block,last_finalized_block,health_status
     FROM bsc_incoming_scan_state WHERE singleton_id=1 LIMIT 1`,
  );
  if (!rows.length) return { ready: false, reason: "incoming_scanner_not_initialized" };
  const state = rows[0];
  if (
    Number(state.chain_id) !== Number(CHAIN_ID) ||
    String(state.token_contract || "").toLowerCase() !== addresses.token.toLowerCase() ||
    String(state.treasury_address || "").toLowerCase() !== addresses.treasury.toLowerCase() ||
    state.health_status !== "healthy" || state.last_scanned_block == null
  ) {
    return { ready: false, reason: "incoming_scanner_requires_reconciliation" };
  }

  let safeBlock;
  try {
    const finalized = await provider.getBlock("finalized");
    if (finalized?.number != null) safeBlock = BigInt(finalized.number);
  } catch {}
  if (safeBlock == null) {
    const latest = BigInt(await provider.getBlockNumber());
    const confirmations = BigInt(process.env.USDT_MIN_CONFIRMATIONS || "15");
    if (confirmations < 1n || confirmations > 200n) {
      throw new Error("USDT_MIN_CONFIRMATIONS must be between 1 and 200 before Cold Wallet sweeps can run.");
    }
    safeBlock = latest >= confirmations - 1n ? latest - (confirmations - 1n) : 0n;
  }
  const scannedBlock = BigInt(state.last_scanned_block);
  if (scannedBlock < safeBlock) {
    return {
      ready: false,
      reason: "incoming_scanner_behind_finalized_chain",
      last_scanned_block: scannedBlock.toString(),
      latest_finalized_block: safeBlock.toString(),
    };
  }
  return { ready: true, last_scanned_block: scannedBlock.toString(), latest_finalized_block: safeBlock.toString(), safe_block: safeBlock.toString() };
}

async function createAndSubmitSweep(dbPool, provider, signer, token, addresses) {
  const activeRows = await dbPool.queryAsync(
    "SELECT id FROM bsc_treasury_sweeps WHERE status IN ('queued','signed','submitted','manual_review') LIMIT 1",
  );
  if (activeRows.length) return { skipped: "existing_sweep_pending" };

  const scanner = await ensureIncomingScannerCaughtUp(dbPool, provider, addresses);
  if (!scanner.ready) return { skipped: scanner.reason, scanner };
  const balanceBlock = BigInt(scanner.safe_block);
  // Sweep only the finalized balance already covered by the incoming scanner cursor.
  const [reserveAmounts, tokenBalanceRaw, bnbBalanceWei] = await Promise.all([
    getHotWalletReserveAmounts(dbPool),
    token.balanceOf(addresses.treasury, { blockTag: balanceBlock }),
    provider.getBalance(addresses.treasury),
  ]);
  const tokenBalance = new BigNumber(tokenBalanceRaw.toString()).shiftedBy(-TOKEN_DECIMALS);
  const minimum = String(process.env.USDT_TREASURY_MIN_OPERATING_BSC_USD || "0").trim() || "0";
  const threshold = String(process.env.USDT_COLD_SWEEP_THRESHOLD_BSC_USD || "500").trim() || "500";
  const percent = String(process.env.USDT_COLD_SWEEP_PERCENT || "90").trim() || "90";
  const liquidity = calculateHotWalletLiquidity({
    onchainBalance: tokenBalance,
    pendingRechargeAmount: reserveAmounts.pendingRechargeAmount,
    reservedRechargeRefundAmount: reserveAmounts.reservedRechargeRefundAmount,
    unresolvedUnknownIncomingAmount: reserveAmounts.unresolvedUnknownIncomingAmount,
    pendingSellerPayoutAmount: reserveAmounts.pendingSellerPayoutAmount,
    otherPendingRefundAmount: reserveAmounts.otherPendingRefundAmount,
    pendingColdWalletSweepAmount: reserveAmounts.pendingColdWalletSweepAmount,
    minimumOperatingAmount: minimum,
    coldSweepThreshold: threshold,
    coldSweepPercent: percent,
    coldWalletConfigured: true,
  });
  if (!liquidity.cold_sweep.eligible) {
    return { skipped: "below_sweep_threshold", available: liquidity.available_for_cold_sweep };
  }

  const amountRaw = asAmountRaw(liquidity.cold_sweep.proposed_amount_bsc_usd);
  if (tokenBalanceRaw < amountRaw) return { skipped: "token_balance_changed" };
  const transferData = TOKEN_INTERFACE.encodeFunctionData("transfer", [addresses.cold, amountRaw]);
  const gasLimit = await provider.estimateGas({
    from: addresses.treasury,
    to: addresses.token,
    data: transferData,
    value: 0n,
  });
  const feeData = await provider.getFeeData();
  const gasPrice = feeData.gasPrice;
  if (!gasPrice || gasPrice <= 0n) throw new Error("BSC gas price is unavailable for the Cold Wallet sweep.");
  const cappedGasLimit = (gasLimit * 120n + 99n) / 100n;
  const requiredGasWei = cappedGasLimit * gasPrice;
  if (bnbBalanceWei < requiredGasWei) return { skipped: "insufficient_hot_wallet_bnb" };

  const bnbUsdPrice = await getBnbUsdPrice(provider, { forceRefresh: true });
  const estimatedFeeBnb = new BigNumber(requiredGasWei.toString()).shiftedBy(-18);
  const estimatedFeeUsd = estimatedFeeBnb.multipliedBy(bnbUsdPrice);
  const maximumFeeUsd = getConfiguredMaxBscTxFeeUsd();
  if (estimatedFeeUsd.gt(maximumFeeUsd)) {
    return {
      skipped: "gas_fee_above_limit",
      estimated_fee_usd: estimatedFeeUsd.toFixed(18),
      maximum_fee_usd: maximumFeeUsd.toFixed(18),
    };
  }

  const reserveTotal = new BigNumber(liquidity.reserved_total);
  const now = String(Date.now());
  const nonce = await provider.getTransactionCount(addresses.treasury, "pending");
  const rawTx = await signer.signTransaction({
    type: 0,
    chainId: Number(CHAIN_ID),
    nonce,
    to: addresses.token,
    value: 0n,
    data: transferData,
    gasLimit: cappedGasLimit,
    gasPrice,
  });
  const txHash = keccak256(rawTx);
  const [insert] = await dbPool.executeAsync(
    `INSERT INTO bsc_treasury_sweeps
     (token_contract,source_address,destination_address,amount,amount_raw,balance_before,reserves_snapshot,
      minimum_operating_snapshot,available_snapshot,sweep_percent,gas_fee_estimated_bnb,gas_fee_estimated_usd,
      bnb_usd_price,raw_tx,tx_hash,nonce,status,created_at_ms,updated_at_ms)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'signed',?,?)`,
    [addresses.token, addresses.treasury, addresses.cold, new BigNumber(amountRaw.toString()).shiftedBy(-18).toFixed(18),
      amountRaw.toString(), tokenBalance.toFixed(18), reserveTotal.toFixed(18), new BigNumber(minimum).toFixed(18),
      liquidity.available_for_cold_sweep, new BigNumber(percent).toFixed(4), estimatedFeeBnb.toFixed(30),
      estimatedFeeUsd.toFixed(18), bnbUsdPrice.toFixed(18), rawTx, txHash, String(nonce), now, now],
  );
  const sweepId = insert.insertId;
  try {
    await provider.broadcastTransaction(rawTx);
    await dbPool.queryAsync(
      "UPDATE bsc_treasury_sweeps SET status='submitted',last_error=NULL,updated_at_ms=? WHERE id=? AND status='signed'",
      [String(Date.now()), sweepId],
    );
  } catch (error) {
    if (/already known|known transaction|already imported/i.test(String(error.message || ""))) {
      await dbPool.queryAsync(
        "UPDATE bsc_treasury_sweeps SET status='submitted',last_error=NULL,updated_at_ms=? WHERE id=? AND status='signed'",
        [String(Date.now()), sweepId],
      );
    } else {
      await dbPool.queryAsync(
        "UPDATE bsc_treasury_sweeps SET last_error=?,updated_at_ms=? WHERE id=? AND status='signed'",
        [String(error.message || error).slice(0, 1000), String(Date.now()), sweepId],
      );
      throw error;
    }
  }
  return { submitted: true, sweep_id: String(sweepId), tx_hash: txHash, amount: liquidity.cold_sweep.proposed_amount_bsc_usd };
}

async function runTreasuryCycle() {
  if (running) return;
  running = true;
  let releaseWorkerLock = null;
  let releaseSpendLock = null;
  let provider = null;
  try {
    releaseWorkerLock = await acquireNamedLock(db, WORKER_LOCK_NAME);
    if (!releaseWorkerLock) return;
    releaseSpendLock = await acquireNamedLock(db, HOT_WALLET_SPEND_LOCK);
    if (!releaseSpendLock) return;

    const tokenAddress = requiredAddress(process.env.USDT_BEP20_CONTRACT || CANONICAL_BSC_USD_CONTRACT, "BSC-USD contract");
    const treasuryAddress = requiredAddress(process.env.USDT_BEP20_TREASURY_ADDRESS, "Hot Wallet address");
    const coldAddress = requiredAddress(process.env.USDT_BEP20_COLD_WALLET_ADDRESS, "Cold Wallet address");
    const disbursementAddress = String(process.env.USDT_BEP20_DISBURSEMENT_ADDRESS || "").trim();
    if (tokenAddress.toLowerCase() !== CANONICAL_BSC_USD_CONTRACT.toLowerCase()) throw new Error("Only the approved Binance-Peg BSC-USD contract is supported.");
    const configuredWallets = [treasuryAddress, coldAddress, disbursementAddress].filter(Boolean);
    if (configuredWallets.some((address) => address.toLowerCase() === "0x0000000000000000000000000000000000000000" || address.toLowerCase() === tokenAddress.toLowerCase())) {
      throw new Error("Hot, Cold and Disbursement wallet addresses must be non-zero and different from the token contract.");
    }
    if (new Set(configuredWallets.map((address) => address.toLowerCase())).size !== configuredWallets.length) {
      throw new Error("Hot, Cold and Disbursement wallet addresses must be different.");
    }
    const privateKey = String(process.env.BSC_TREASURY_PRIVATE_KEY || "").trim();
    if (!privateKey) throw new Error("BSC_TREASURY_PRIVATE_KEY is missing from the treasury secrets file.");
    const rpcUrl = String(process.env.BSC_RPC_URL || "").trim();
    provider = new JsonRpcProvider(rpcUrl, Number(CHAIN_ID), { staticNetwork: true });
    attachEthersRpcMetrics(provider, rpcUrl, "cold-wallet-treasury-worker");
    const network = await provider.getNetwork();
    if (BigInt(network.chainId) !== CHAIN_ID) throw new Error("The Treasury RPC must connect to BNB Smart Chain mainnet.");
    const signer = new Wallet(privateKey, provider);
    if (signer.address.toLowerCase() !== treasuryAddress.toLowerCase()) throw new Error("BSC_TREASURY_PRIVATE_KEY does not match USDT_BEP20_TREASURY_ADDRESS.");
    const token = new Contract(tokenAddress, [
      "function balanceOf(address account) view returns (uint256)",
    ], provider);
    const activeJob = await resumePendingSweep(db, provider, signer, token);
    if (!activeJob.pending) {
      await createAndSubmitSweep(db, provider, signer, token, {
        token: tokenAddress,
        treasury: treasuryAddress,
        cold: coldAddress,
      });
    }
  } catch (error) {
    console.error("OneX Cold Wallet sweep cycle failed:", error.message);
  } finally {
    if (provider) await provider.destroy().catch(() => {});
    if (releaseSpendLock) await releaseSpendLock().catch((error) => console.error("Unable to release Hot Wallet spend lock:", error.message));
    if (releaseWorkerLock) await releaseWorkerLock().catch((error) => console.error("Unable to release Cold Wallet worker lock:", error.message));
    running = false;
  }
}

async function start() {
  try {
    await initDbIfEmpty();
    const coldAddress = String(process.env.USDT_BEP20_COLD_WALLET_ADDRESS || "").trim();
    if (!coldAddress) {
      console.log("OneX Cold Wallet sweep is disabled: USDT_BEP20_COLD_WALLET_ADDRESS is empty.");
      await db.end();
      return;
    }
    const run = async () => {
      await runTreasuryCycle();
      timer = setTimeout(run, POLL_MS);
    };
    void run();
  } catch (error) {
    console.error("OneX Treasury worker startup failed:", error);
    process.exitCode = 1;
    await db.end().catch(() => {});
  }
}

if (require.main === module) void start();

module.exports = {
  calculateHotWalletLiquidity,
  runTreasuryCycle,
  withHotWalletSpendLock,
};
