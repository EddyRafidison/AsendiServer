"use strict";

require("dotenv").config();

const path = require("path");
const BigNumber = require("bignumber.js");
const {
  JsonRpcProvider,
  Contract,
  Interface,
  Wallet,
  getAddress,
  keccak256,
  parseUnits,
  formatUnits,
} = require("ethers");
const { db, initDbIfEmpty } = require("./db");
const { getXtuRuntime, getXtuMainSigner } = require("./xtu-withdrawal-chain");
const {
  reserveAutomaticRefundPayoutTx,
  restoreAutomaticRefundPayoutTx,
  confirmAutomaticRefundPayoutTx,
  markAutomaticRefundManualReviewTx,
} = require("./automatic-refund-service");
const {
  estimateBscTokenTransfer,
  calculateActualGasFee,
  recordEstimatedBscFeeTx,
  recordActualBscFeeTx,
} = require("./bsc-fee-accounting");
const { getBnbUsdPrice } = require("./bsc-price-oracle");
const { getConfiguredMaxBscTxFeeUsd } = require("./bsc-transaction-policy");
const { MAXIMUM_REFUND_GAS_EQUIVALENT } = require("./automatic-refund-policy");

BigNumber.config({ DECIMAL_PLACES: 36, ROUNDING_MODE: BigNumber.ROUND_DOWN });

const CHAIN_ID = 56n;
const SCALE = 18;
const DEFAULT_BSC_USD_CONTRACT = "0x55d398326f99059fF775485246999027B3197955";
const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function transfer(address,uint256) returns (bool)",
  "event Transfer(address indexed from,address indexed to,uint256 value)",
];
const XTU_ABI = [
  ...ERC20_ABI,
  "function TRANSFER_FEE_BPS() view returns (uint256)",
  "event TransferWithFee(address indexed from,address indexed to,uint256 grossAmount,uint256 netAmount,uint256 feeAmount,bool feeExempt)",
];
const ERC20_INTERFACE = new Interface(ERC20_ABI);
const XTU_INTERFACE = new Interface(XTU_ABI);
const TRANSFER_TOPIC = ERC20_INTERFACE.getEvent("Transfer").topicHash.toLowerCase();
const XTU_TRANSFER_WITH_FEE_TOPIC = XTU_INTERFACE.getEvent("TransferWithFee").topicHash.toLowerCase();
const WORKER_LOCK = "onex_automatic_refund_worker";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function enabled() {
  return String(process.env.AUTOMATIC_REFUNDS_ENABLED || "false").toLowerCase() === "true";
}
function envInt(name, fallback, min, max) {
  const raw = String(process.env[name] ?? "").trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new RangeError(`${name} must be an integer between ${min} and ${max}.`);
  return value;
}
function address(value, name) {
  try {
    const normalized = getAddress(String(value || "").trim());
    if (/^0x0{40}$/i.test(normalized)) throw new Error("zero address");
    return normalized;
  } catch {
    throw new TypeError(`${name} must be a valid non-zero EVM address.`);
  }
}
function decimal(value, name, allowZero = true) {
  const number = new BigNumber(String(value ?? "0"));
  if (!number.isFinite() || (allowZero ? number.isNegative() : !number.isGreaterThan(0))) throw new RangeError(`${name} is invalid.`);
  return number.decimalPlaces(SCALE, BigNumber.ROUND_DOWN);
}
function rawAmount(value) {
  const raw = parseUnits(decimal(value, "Token amount", false).toFixed(SCALE), SCALE);
  if (raw <= 0n) throw new RangeError("Refund payout raw amount must be positive.");
  return raw;
}
function poolConnection(pool) {
  return new Promise((resolve, reject) => pool.getConnection((error, connection) => error ? reject(error) : resolve(connection)));
}
async function withTransaction(pool, work) {
  const connection = await poolConnection(pool);
  const tx = connection.promise();
  try {
    await tx.beginTransaction();
    const result = await work(tx);
    await tx.commit();
    return result;
  } catch (error) {
    try { await tx.rollback(); } catch (rollbackError) { console.error("Automatic refund SQL rollback failed:", rollbackError.message); }
    throw error;
  } finally {
    connection.release();
  }
}
async function acquireNamedLock(pool, name) {
  const connection = await poolConnection(pool);
  const queryable = connection.promise();
  try {
    const [rows] = await queryable.query("SELECT GET_LOCK(?,0) AS acquired", [name]);
    if (Number(rows[0]?.acquired) !== 1) {
      connection.release();
      return null;
    }
    let released = false;
    return async () => {
      if (released) return;
      released = true;
      try { await queryable.query("SELECT RELEASE_LOCK(?)", [name]); }
      finally { connection.release(); }
    };
  } catch (error) {
    connection.release();
    throw error;
  }
}

async function loadBscRuntime() {
  const secretFile = String(process.env.USDT_TREASURY_ENV_FILE || ".env.treasury").trim();
  const result = require("dotenv").config({ path: path.resolve(process.cwd(), secretFile) });
  if (result.error) throw new Error(`Unable to load BSC treasury secrets from ${secretFile}: ${result.error.message}`);
  const rpcUrl = String(process.env.BSC_RPC_URL || "").trim();
  const tokenAddress = address(process.env.USDT_BEP20_CONTRACT || DEFAULT_BSC_USD_CONTRACT, "USDT_BEP20_CONTRACT");
  const treasuryAddress = address(process.env.USDT_BEP20_TREASURY_ADDRESS, "USDT_BEP20_TREASURY_ADDRESS");
  const privateKey = String(process.env.BSC_TREASURY_PRIVATE_KEY || "").trim();
  if (!rpcUrl || !/^0x[0-9a-fA-F]{64}$/.test(privateKey)) throw new Error("BSC_RPC_URL and a valid BSC_TREASURY_PRIVATE_KEY are required for BSC-USD refunds.");
  if (tokenAddress.toLowerCase() !== DEFAULT_BSC_USD_CONTRACT.toLowerCase()) throw new Error("Automatic BSC-USD refunds require the exact approved BSC-USD contract.");
  const provider = new JsonRpcProvider(rpcUrl, Number(CHAIN_ID), { staticNetwork: true });
  const network = await provider.getNetwork();
  if (BigInt(network.chainId) !== CHAIN_ID) throw new Error("Automatic refund RPC is not on BNB Smart Chain Mainnet (56).");
  const code = await provider.getCode(tokenAddress);
  if (!code || code === "0x") throw new Error("The official BSC-USD token contract has no bytecode on the configured RPC.");
  const signer = new Wallet(privateKey, provider);
  if (signer.address.toLowerCase() !== treasuryAddress.toLowerCase()) throw new Error("BSC_TREASURY_PRIVATE_KEY does not match USDT_BEP20_TREASURY_ADDRESS.");
  const token = new Contract(tokenAddress, ERC20_ABI, provider);
  const decimals = Number(await token.decimals());
  if (decimals !== SCALE) throw new Error(`BSC-USD token decimals must be ${SCALE}, received ${decimals}.`);
  return { assetCode: "BSC-USD", provider, signer, token, tokenAddress, walletAddress: treasuryAddress, confirmations: envInt("AUTOMATIC_REFUNDS_CONFIRMATIONS", 15, 1, 200) };
}

async function loadXtuRuntime() {
  const runtime = await getXtuRuntime({ requireSigner: true });
  const mainSigner = await getXtuMainSigner(runtime);
  if (BigInt(await runtime.contract.TRANSFER_FEE_BPS()) !== 0n) throw new Error("The deployed XTU contract still applies a non-zero transfer commission; automatic refunds are paused.");
  const decimals = Number(await runtime.contract.decimals());
  if (decimals !== SCALE) throw new Error(`XTU token decimals must be ${SCALE}, received ${decimals}.`);
  return {
    assetCode: "XTU",
    provider: runtime.provider,
    token: runtime.contract,
    tokenAddress: runtime.settings.tokenAddress,
    confirmations: envInt("AUTOMATIC_REFUNDS_CONFIRMATIONS", 15, 1, 200),
    signers: [
      { signer: mainSigner, walletAddress: runtime.settings.mainWalletAddress },
      { signer: runtime.signer, walletAddress: runtime.settings.distributionAddress },
    ],
  };
}

async function loadRuntimes() {
  const [bscGroups, xtuGroups] = await Promise.all([
    db.promise().query("SELECT COUNT(*) AS n FROM automatic_refund_groups WHERE asset_code='BSC-USD' AND status IN ('collecting','queued','signed','submitted')"),
    db.promise().query("SELECT COUNT(*) AS n FROM automatic_refund_groups WHERE asset_code='XTU' AND status IN ('collecting','queued','signed','submitted')"),
  ]);
  const result = {};
  if (Number(bscGroups[0][0]?.n || 0) > 0) result["BSC-USD"] = await loadBscRuntime();
  if (Number(xtuGroups[0][0]?.n || 0) > 0) result.XTU = await loadXtuRuntime();
  return result;
}

async function getPendingPayouts() {
  return db.promise().query(
    `SELECT p.*,g.sender_address,g.asset_code AS group_asset_code
     FROM automatic_refund_payouts p JOIN automatic_refund_groups g ON g.id=p.group_id
     WHERE p.status IN ('queued','signed','submitted') ORDER BY p.id ASC LIMIT 50`,
  ).then(([rows]) => rows);
}

async function getEligibleGroups() {
  return db.promise().query(
    `SELECT g.* FROM automatic_refund_groups g
     WHERE g.status IN ('collecting','completed') AND EXISTS(
       SELECT 1 FROM automatic_refund_group_events e
       WHERE e.group_id=g.id AND e.status IN ('collecting','eligible')
         AND e.refund_eligible_at_ms<=?
     ) ORDER BY g.next_eligible_at_ms,g.id LIMIT 50`, [String(Date.now())],
  ).then(([rows]) => rows);
}

async function readMaturedEventTotals(groupId) {
  const [rows] = await db.promise().query(
    `SELECT gross_amount,refund_fee_amount FROM automatic_refund_group_events
     WHERE group_id=? AND status IN ('collecting','eligible') AND refund_eligible_at_ms<=?
       AND refunded_amount=0 AND reserved_amount=0 ORDER BY finalized_at_ms,tx_hash,log_index,id`,
    [String(groupId), String(Date.now())],
  );
  const gross = rows.reduce((sum, row) => sum.plus(decimal(row.gross_amount, "gross source amount")), new BigNumber(0));
  const fee = rows.reduce((sum, row) => sum.plus(decimal(row.refund_fee_amount, "source retention")), new BigNumber(0));
  return { rows, gross, fee };
}

async function selectXtuSigner(runtime, tokenAmount, groupId) {
  const required = rawAmount(tokenAmount);
  const candidates = [];
  for (const item of runtime.signers) {
    const [balance, native] = await Promise.all([
      runtime.token.balanceOf(item.walletAddress),
      runtime.provider.getBalance(item.walletAddress),
    ]);
    let reserved = 0n;
    const candidateAddress = String(item.walletAddress).toLowerCase();
    const mainAddress = String(runtime.signers[0].walletAddress).toLowerCase();
    if (candidateAddress === mainAddress) {
      const [lotRows] = await db.promise().query(
        `SELECT COALESCE(SUM(l.protected_hot_wallet_amount),0) AS amount
         FROM xtu_hot_wallet_lots l
         WHERE l.status IN ('protected','consolidation_reserved','common_reserve_owned','refund_queued')
           AND NOT EXISTS (
             SELECT 1 FROM automatic_refund_group_events e
             JOIN xtu_deposit_transfer_events s ON s.id=e.source_id
             WHERE e.group_id=? AND e.source_table='xtu_deposit_transfer_events'
               AND s.event_identity=l.event_identity
           )`, [String(groupId)],
      );
      const [unknownRows] = await db.promise().query(
        `SELECT COALESCE(SUM(CASE WHEN u.status='refunded' THEN u.refund_residual_amount ELSE u.hot_wallet_received_amount END),0) AS amount
         FROM xtu_unknown_incoming_transfers u
         WHERE u.status IN ('pending_admin','refund_approved','refund_queued','refund_signed','refund_submitted',
           'refund_manual_review','refund_failed','retained_uncredited','refunded','automatic_refund_pending')
           AND NOT EXISTS (
             SELECT 1 FROM automatic_refund_group_events e
             WHERE e.group_id=? AND e.source_table='xtu_unknown_incoming_transfers' AND e.source_id=u.id
           )`, [String(groupId)],
      );
      const [unbackedRows] = await db.promise().query(
        `SELECT COALESCE(SUM(e.gross_amount-e.refunded_amount),0) AS amount
         FROM automatic_refund_group_events e
         JOIN automatic_refund_groups g ON g.id=e.group_id
         JOIN xtu_deposit_transfer_events s ON s.id=e.source_id
         WHERE g.asset_code='XTU' AND e.source_table='xtu_deposit_transfer_events'
           AND e.group_id<>? AND e.status NOT IN ('refunded','resolved','cancelled')
           AND e.gross_amount>e.refunded_amount
           AND NOT EXISTS (SELECT 1 FROM xtu_hot_wallet_lots l WHERE l.event_identity=s.event_identity)`,
        [String(groupId)],
      );
      const protectedAmount = new BigNumber(lotRows[0]?.amount || "0")
        .plus(unknownRows[0]?.amount || "0")
        .plus(unbackedRows[0]?.amount || "0");
      if (!protectedAmount.isFinite() || protectedAmount.isNegative()) continue;
      reserved = rawAmount(protectedAmount.toFixed(SCALE));
    } else {
      const [withdrawalRows, settlementRows, refundRows] = await Promise.all([
        db.promise().query(
          `SELECT COALESCE(SUM(net_amount),0) AS amount FROM xtu_withdrawals
           WHERE status IN ('queued','signed','submitted','manual_review')`,
        ),
        db.promise().query(
          `SELECT COALESCE(SUM(remaining_xtu_amount),0) AS amount FROM xtu_global_settlement_ledger
           WHERE status IN ('reserved','partially_settled')`,
        ),
        db.promise().query(
          `SELECT COALESCE(SUM(net_amount),0) AS amount FROM automatic_refund_payouts
           WHERE from_wallet_address=? AND token_contract=?
             AND status IN ('queued','signed','submitted','manual_review')`,
          [candidateAddress, runtime.tokenAddress.toLowerCase()],
        ),
      ]);
      const protectedAmount = new BigNumber(withdrawalRows[0][0]?.amount || "0")
        .plus(settlementRows[0][0]?.amount || "0")
        .plus(refundRows[0][0]?.amount || "0");
      if (!protectedAmount.isFinite() || protectedAmount.isNegative()) continue;
      reserved = rawAmount(protectedAmount.toFixed(SCALE));
    }
    candidates.push({ ...item, balance: BigInt(balance), native: BigInt(native), reserved });
  }
  return candidates.filter((item) => item.balance >= required + item.reserved)
    .sort((a, b) => (a.balance - a.reserved > b.balance - b.reserved ? -1 : a.balance - a.reserved < b.balance - b.reserved ? 1 : 0))[0] || null;
}

async function buildQuote(runtime, group, totals, walletAddress) {
  const sender = runtime.signer?.address || walletAddress;
  const sourceWallet = address(walletAddress, "refund source wallet");
  const payoutAddress = address(group.payout_address, "refund destination");
  if (payoutAddress.toLowerCase() !== String(group.sender_address).toLowerCase()) throw new Error("Refund destination does not match the registered source sender.");
  const maxGas = getConfiguredMaxBscTxFeeUsd();
  const estimatedPayout = totals.gross.minus(totals.fee).minus("0.2");
  if (estimatedPayout.lte(0)) return { skipped: true, reason: "no_positive_estimate" };
  const estimateRaw = rawAmount(estimatedPayout.toFixed(SCALE));
  const data = runtime.token.interface.encodeFunctionData("transfer", [payoutAddress, estimateRaw]);
  const bnbUsdPrice = await getBnbUsdPrice(runtime.provider, { forceRefresh: true });
  const estimate = await estimateBscTokenTransfer({
    provider: runtime.provider,
    fromAddress: sourceWallet,
    tokenAddress: runtime.tokenAddress,
    data,
    maximumGasLimit: envInt("AUTOMATIC_REFUNDS_GAS_LIMIT", 250000, 50000, 1000000),
    bnbUsdPrice,
  });
  if (!estimate.allowed || estimate.feeUsd.gt(maxGas)) return { skipped: true, reason: "gas_above_ceiling" };
  const gasEquivalent = estimate.feeUsd.decimalPlaces(SCALE, BigNumber.ROUND_DOWN);
  if (gasEquivalent.gt(MAXIMUM_REFUND_GAS_EQUIVALENT)) return { skipped: true, reason: "gas_above_refund_ceiling" };
  const net = totals.gross.minus(totals.fee).minus(gasEquivalent).decimalPlaces(SCALE, BigNumber.ROUND_DOWN);
  if (net.lt(1)) return { skipped: true, reason: "below_minimum", netAmount: net.toFixed(SCALE) };
  return {
    gasEstimatedAmount: gasEquivalent.toFixed(SCALE),
    estimatedGasFeeBnb: estimate.feeBnb.toFixed(30),
    bnbUsdPrice: estimate.bnbUsdPrice.toFixed(18),
    gasLimit: estimate.gasLimit.toString(),
    gasPriceWei: estimate.gasPrice.toString(),
    fromWalletAddress: sourceWallet,
    netAmount: net.toFixed(SCALE),
  };
}

async function reserveEligibleGroup(runtime, group) {
  const totals = await readMaturedEventTotals(group.id);
  if (!totals.rows.length) return;
  const tokenAmountBeforeGas = totals.gross.minus(totals.fee).minus("0.2");
  if (tokenAmountBeforeGas.lte(0)) return;
  const signerChoice = runtime.assetCode === "XTU"
    ? await selectXtuSigner(runtime, tokenAmountBeforeGas.toFixed(SCALE), group.id)
    : { signer: runtime.signer, walletAddress: runtime.walletAddress };
  if (!signerChoice) return;
  const quote = await buildQuote(runtime, group, totals, signerChoice.walletAddress);
  if (quote.skipped) return;

  const raw = rawAmount(quote.netAmount);
  const [tokenBalance, nativeBalance, pendingRows] = await Promise.all([
    runtime.token.balanceOf(signerChoice.walletAddress),
    runtime.provider.getBalance(signerChoice.walletAddress),
    db.promise().query(
      `SELECT COALESCE(SUM(net_amount),0) AS reserved_token,COALESCE(SUM(estimated_gas_fee_bnb),0) AS reserved_bnb
       FROM automatic_refund_payouts
       WHERE from_wallet_address=? AND token_contract=? AND status IN ('queued','signed','submitted','manual_review')`,
      [String(signerChoice.walletAddress).toLowerCase(), runtime.tokenAddress.toLowerCase()],
    ),
  ]);
  const reserve = pendingRows[0][0] || {};
  const pendingToken = rawAmount(decimal(reserve.reserved_token || "0", "reserved token", true).toFixed(SCALE));
  const pendingBnb = BigInt(parseUnits(decimal(reserve.reserved_bnb || "0", "reserved gas", true).toFixed(30), 30));
  const requiredGas = BigInt(quote.gasLimit) * BigInt(quote.gasPriceWei);
  if (BigInt(tokenBalance) < raw + pendingToken || BigInt(nativeBalance) < requiredGas + pendingBnb) return;

  await withTransaction(db, async (tx) => {
    if (runtime.assetCode === "XTU") {
      for (const lockName of ["common_state", "onex_xtu_wallet_spend", "onex_xtu_main_wallet_spend"]) {
        const [lockRows] = await tx.query("SELECT lock_name FROM system_locks WHERE lock_name=? FOR UPDATE", [lockName]);
        if (!lockRows.length) throw new Error(`The ${lockName} lock row is missing.`);
      }
    }
    const [groupRows] = await tx.query("SELECT id,status FROM automatic_refund_groups WHERE id=? FOR UPDATE", [String(group.id)]);
    if (!groupRows.length || !["collecting", "completed"].includes(String(groupRows[0].status))) return;
    const result = await reserveAutomaticRefundPayoutTx(tx, group.id, quote, Date.now());
  });
}

async function markPayoutError(payoutId, error) {
  await db.queryAsync(
    `UPDATE automatic_refund_payouts SET last_error=?,updated_at_ms=?
     WHERE id=? AND status IN ('queued','signed','submitted')`,
    [String(error?.message || error || "Automatic refund processing error").slice(0, 2000), String(Date.now()), String(payoutId)],
  );
}

async function persistSignedPayout(payout, runtime, signer) {
  const releaseWalletLock = payout.asset_code === "BSC-USD"
    ? await acquireNamedLock(db, "onex_hot_wallet_spend")
    : null;
  if (payout.asset_code === "BSC-USD" && !releaseWalletLock) return false;
  try {
    return await withTransaction(db, async (queryable) => {
      if (payout.asset_code === "XTU") {
        for (const lockName of ["common_state", "onex_xtu_wallet_spend", "onex_xtu_main_wallet_spend"]) {
          const [lockRows] = await queryable.query("SELECT lock_name FROM system_locks WHERE lock_name=? FOR UPDATE", [lockName]);
          if (!lockRows.length) throw new Error(`The ${lockName} lock row is missing.`);
        }
      }
      const [rows] = await queryable.query("SELECT status,raw_tx,tx_hash,from_wallet_address,net_amount,gas_limit,gas_price_wei FROM automatic_refund_payouts WHERE id=? LIMIT 1 FOR UPDATE", [String(payout.id)]);
      if (!rows.length || rows[0].status !== "queued" || rows[0].raw_tx || rows[0].tx_hash) return false;
      const current = rows[0];
      const from = address(current.from_wallet_address, "payout signing wallet");
      const signerAddress = address(
        typeof signer?.getAddress === "function" ? await signer.getAddress() : signer?.address,
        "configured payout signer",
      );
      if (signerAddress !== from) {
        throw new Error("The selected signer does not match the wallet reserved for this automatic refund payout.");
      }
      const destination = address(payout.payout_address, "payout destination");
      const amount = rawAmount(current.net_amount);
      const data = runtime.token.interface.encodeFunctionData("transfer", [destination, amount]);
      const nonce = await runtime.provider.getTransactionCount(from, "pending");
      const rawTx = await signer.signTransaction({
        type: 0,
        chainId: Number(CHAIN_ID),
        nonce,
        to: runtime.tokenAddress,
        value: 0n,
        data,
        gasLimit: BigInt(current.gas_limit),
        gasPrice: BigInt(current.gas_price_wei),
      });
      const hash = keccak256(rawTx);
      const [result] = await queryable.query(
        `UPDATE automatic_refund_payouts SET raw_tx=?,tx_hash=?,nonce=?,status='signed',last_error=NULL,updated_at_ms=?
         WHERE id=? AND status='queued' AND raw_tx IS NULL AND tx_hash IS NULL`,
        [rawTx, hash, String(nonce), String(Date.now()), String(payout.id)],
      );
      if (Number(result.affectedRows) !== 1) return false;
      await recordEstimatedBscFeeTx(queryable, {
        txHash: hash,
        operation: "automatic_refund",
        gasLimit: String(current.gas_limit),
        gasPriceWei: String(current.gas_price_wei),
        bnbUsdPrice: payout.bnb_usd_price,
      });
      return true;
    });
  } finally {
    if (releaseWalletLock) await releaseWalletLock();
  }
}

function verifyPayoutTransfer(runtime, receipt, payout, fromAddress) {
  const from = address(fromAddress, "payout sender").toLowerCase();
  const to = address(payout.payout_address, "payout receiver").toLowerCase();
  const expected = rawAmount(payout.net_amount);
  let foundTransfer = false;
  let foundXtuAudit = runtime.assetCode !== "XTU";
  for (const log of receipt.logs || []) {
    if (String(log.address).toLowerCase() !== runtime.tokenAddress.toLowerCase()) continue;
    const topic0 = String(log.topics?.[0] || "").toLowerCase();
    if (topic0 === TRANSFER_TOPIC) {
      let parsed;
      try { parsed = ERC20_INTERFACE.parseLog(log); } catch { continue; }
      if (String(parsed.args.from).toLowerCase() === from && String(parsed.args.to).toLowerCase() === to && BigInt(parsed.args.value) === expected) foundTransfer = true;
    }
    if (topic0 === XTU_TRANSFER_WITH_FEE_TOPIC) {
      let parsed;
      try { parsed = XTU_INTERFACE.parseLog(log); } catch { continue; }
      if (String(parsed.args.from).toLowerCase() === from && String(parsed.args.to).toLowerCase() === to &&
          BigInt(parsed.args.grossAmount) === expected && BigInt(parsed.args.netAmount) === expected &&
          BigInt(parsed.args.feeAmount) === 0n && parsed.args.feeExempt === false) foundXtuAudit = true;
    }
  }
  return foundTransfer && foundXtuAudit;
}

async function markManualReview(payoutId, reason) {
  return withTransaction(db, (tx) => markAutomaticRefundManualReviewTx(tx, payoutId, reason, Date.now()));
}
async function restorePayout(payoutId, reason) {
  return withTransaction(db, (tx) => restoreAutomaticRefundPayoutTx(tx, payoutId, reason, Date.now()));
}

async function reconcilePayout(payout, runtime, signer) {
  let releaseWalletLock = null;
  if (payout.asset_code === "BSC-USD") {
    releaseWalletLock = await acquireNamedLock(db, "onex_hot_wallet_spend");
    if (!releaseWalletLock) return;
  }
  try {
    if (!payout.raw_tx || !payout.tx_hash || payout.nonce == null || !payout.from_wallet_address) {
      await markManualReview(payout.id, "Active automatic refund payout lacks its persisted signed raw transaction, hash, nonce or sending wallet.");
      return;
    }
    const expectedHash = String(payout.tx_hash).toLowerCase();
    const [receipt, knownTransaction] = await Promise.all([
      runtime.provider.getTransactionReceipt(expectedHash),
      runtime.provider.getTransaction(expectedHash),
    ]);
    if (!receipt && !knownTransaction) {
      const pendingNonce = await runtime.provider.getTransactionCount(payout.from_wallet_address, "pending");
      const latestNonce = await runtime.provider.getTransactionCount(payout.from_wallet_address, "latest");
      if (latestNonce > Number(payout.nonce) || pendingNonce > Number(payout.nonce)) {
        await markManualReview(payout.id, "The persisted transaction hash is not visible, but the sender nonce has advanced. The payout is uncertain and must not be recreated.");
        return;
      }
      try {
        const broadcast = await runtime.provider.broadcastTransaction(payout.raw_tx);
        if (String(broadcast.hash).toLowerCase() !== expectedHash) throw new Error("Broadcast hash differs from the persisted signed transaction hash.");
      } catch (error) {
        const [afterReceipt, afterTransaction] = await Promise.all([
          runtime.provider.getTransactionReceipt(expectedHash),
          runtime.provider.getTransaction(expectedHash),
        ]);
        if (!afterReceipt && !afterTransaction) {
          await markPayoutError(payout.id, error);
          return;
        }
      }
      await db.queryAsync("UPDATE automatic_refund_payouts SET status='submitted',last_error=NULL,updated_at_ms=? WHERE id=? AND status IN ('signed','submitted')", [String(Date.now()), String(payout.id)]);
      return;
    }
    if (!receipt) {
      await db.queryAsync("UPDATE automatic_refund_payouts SET status='submitted',last_error=NULL,updated_at_ms=? WHERE id=? AND status IN ('signed','submitted')", [String(Date.now()), String(payout.id)]);
      return;
    }
    const canonicalBlock = await runtime.provider.getBlock(receipt.blockNumber);
    if (!canonicalBlock || String(canonicalBlock.hash).toLowerCase() !== String(receipt.blockHash).toLowerCase()) return;
    const latestBlock = await runtime.provider.getBlockNumber();
    if (latestBlock - Number(receipt.blockNumber) + 1 < runtime.confirmations) return;

    const actual = calculateActualGasFee(receipt, payout.bnb_usd_price);
    if (Number(receipt.status) !== 1) {
      await withTransaction(db, async (tx) => {
        await recordActualBscFeeTx(tx, { txHash: expectedHash, operation: "automatic_refund_failed", receipt, bnbUsdPrice: payout.bnb_usd_price });
        await restoreAutomaticRefundPayoutTx(tx, payout.id, "The signed automatic refund transaction failed on-chain after finality.", Date.now());
      });
      return;
    }
    if (!verifyPayoutTransfer(runtime, receipt, payout, payout.from_wallet_address)) {
      await markManualReview(payout.id, "Finalized payout receipt does not contain the exact same-token transfer from the configured OneX wallet to the original sender, or the XTU zero-fee audit event does not reconcile.");
      return;
    }
    const receiptData = {
      txHash: expectedHash,
      blockNumber: String(receipt.blockNumber),
      blockHash: String(receipt.blockHash).toLowerCase(),
      receiptJson: JSON.stringify({
        transactionHash: receipt.hash,
        blockNumber: receipt.blockNumber,
        blockHash: receipt.blockHash,
        status: receipt.status,
        gasUsed: receipt.gasUsed?.toString(),
        effectiveGasPrice: (receipt.gasPrice ?? receipt.effectiveGasPrice)?.toString(),
        logs: (receipt.logs || []).map((log) => ({ address: log.address, topics: log.topics, data: log.data, logIndex: log.index })),
      }),
      actualGasFeeBnb: actual.feeBnb.toFixed(30),
      actualGasFeeToken: actual.feeUsd.toFixed(SCALE),
    };
    await withTransaction(db, async (tx) => {
      await recordActualBscFeeTx(tx, { txHash: expectedHash, operation: "automatic_refund", receipt, bnbUsdPrice: payout.bnb_usd_price });
      await confirmAutomaticRefundPayoutTx(tx, payout.id, receiptData, Date.now());
    });
  } finally {
    if (releaseWalletLock) await releaseWalletLock();
  }
}

async function signQueuedPayout(payout, runtime, signer) {
  if (payout.raw_tx || payout.tx_hash) return;
  try {
    const signed = await persistSignedPayout(payout, runtime, signer);
    if (!signed) return;
    const [freshRows] = await db.promise().query("SELECT * FROM automatic_refund_payouts WHERE id=? LIMIT 1", [String(payout.id)]);
    if (freshRows.length) await reconcilePayout(freshRows[0], runtime, signer);
  } catch (error) {
    await markPayoutError(payout.id, error);
  }
}

async function runCycle(runtimes) {
  const pending = await getPendingPayouts();
  for (const payout of pending) {
    const runtime = runtimes[payout.asset_code];
    if (!runtime) continue;
    const signer = payout.asset_code === "XTU"
      ? runtime.signers.find((item) => item.walletAddress.toLowerCase() === String(payout.from_wallet_address || "").toLowerCase())?.signer
      : runtime.signer;
    if (!signer) {
      await markManualReview(payout.id, "The signed payout sender wallet cannot be matched to a configured OneX signer.");
      continue;
    }
    if (payout.status === "queued" && !payout.raw_tx) await signQueuedPayout(payout, runtime, signer);
    else await reconcilePayout(payout, runtime, signer);
  }

  const groups = await getEligibleGroups();
  for (const group of groups) {
    const runtime = runtimes[group.asset_code];
    if (!runtime) continue;
    try { await reserveEligibleGroup(runtime, group); }
    catch (error) { console.error(`Automatic refund group ${group.id} could not be reserved:`, error.message); }
  }
}

async function start() {
  if (!enabled()) {
    console.log("Automatic refunds are disabled. Set AUTOMATIC_REFUNDS_ENABLED=true only after database, RPC, wallet and EVM validations.");
    await initDbIfEmpty();
    await db.end();
    return;
  }
  await initDbIfEmpty();
  const releaseWorkerLock = await acquireNamedLock(db, WORKER_LOCK);
  if (!releaseWorkerLock) throw new Error("Another automatic refund worker already owns the global worker lock.");
  let runtimes;
  try {
    runtimes = await loadRuntimes();
    const pollMs = envInt("AUTOMATIC_REFUNDS_POLL_MS", 15000, 5000, 300000);
    let stopping = false;
    const stop = async () => {
      stopping = true;
      for (const runtime of Object.values(runtimes)) {
        try { await runtime.provider.destroy(); } catch {}
      }
      await releaseWorkerLock();
      await db.end();
    };
    process.once("SIGINT", () => void stop());
    process.once("SIGTERM", () => void stop());
    while (!stopping) {
      try { await runCycle(runtimes); }
      catch (error) { console.error("Automatic refund worker cycle failed:", error.stack || error.message); }
      await sleep(pollMs);
    }
  } catch (error) {
    await releaseWorkerLock();
    throw error;
  }
}

if (require.main === module) {
  start().catch(async (error) => {
    console.error("Automatic refund worker startup failed:", error.stack || error.message);
    process.exitCode = 1;
    try { await db.end(); } catch {}
  });
}

module.exports = {
  start,
  runCycle,
  verifyPayoutTransfer,
  decimal,
};
