"use strict";

const BigNumber = require("bignumber.js");
const { attachEthersRpcMetrics } = require("./bsc-rpc-ethers-metrics");
const {
  JsonRpcProvider,
  Contract,
  getAddress,
} = require("ethers");

const CHAIN_ID = 56n;
const TOKEN_DECIMALS = 18;
const CANONICAL_BSC_USD_CONTRACT = "0x55d398326f99059fF775485246999027B3197955";
const BALANCE_ABI = ["function balanceOf(address account) view returns (uint256)"];

function finiteNonNegative(value, label) {
  const amount = new BigNumber(value == null || value === "" ? 0 : value);
  if (!amount.isFinite() || amount.isNegative()) {
    throw new TypeError(`${label} must be a finite non-negative amount.`);
  }
  return amount;
}

function configuredAmount(name, fallback) {
  const raw = String(process.env[name] ?? "").trim();
  return finiteNonNegative(raw === "" ? fallback : raw, name);
}

function configuredSweepPercent() {
  const raw = String(process.env.USDT_COLD_SWEEP_PERCENT ?? "90").trim();
  const value = new BigNumber(raw);
  if (!value.isFinite() || value.isLessThanOrEqualTo(0) || value.isGreaterThan(100)) {
    throw new RangeError("USDT_COLD_SWEEP_PERCENT must be greater than 0 and at most 100.");
  }
  return value;
}

function calculateHotWalletLiquidity({
  onchainBalance,
  pendingRechargeAmount = 0,
  reservedRechargeRefundAmount = 0,
  unresolvedUnknownIncomingAmount = 0,
  pendingSellerPayoutAmount = 0,
  otherPendingRefundAmount = 0,
  pendingColdWalletSweepAmount = 0,
  minimumOperatingAmount = 0,
  coldSweepThreshold = 500,
  coldSweepPercent = 90,
  coldWalletConfigured = false,
}) {
  const total = finiteNonNegative(onchainBalance, "Hot Wallet on-chain BSC-USD balance");
  const categories = {
    pending_recharges: finiteNonNegative(pendingRechargeAmount, "Pending recharge reserve"),
    recharge_refunds: finiteNonNegative(reservedRechargeRefundAmount, "Recharge refund reserve"),
    unknown_incoming_transfers: finiteNonNegative(unresolvedUnknownIncomingAmount, "Unknown incoming transfer reserve"),
    seller_payouts: finiteNonNegative(pendingSellerPayoutAmount, "Seller payout reserve"),
    other_refunds: finiteNonNegative(otherPendingRefundAmount, "Other refund reserve"),
    pending_cold_wallet_sweeps: finiteNonNegative(pendingColdWalletSweepAmount, "Pending Cold Wallet sweep reserve"),
  };
  const minimum = finiteNonNegative(minimumOperatingAmount, "Hot Wallet minimum operating balance");
  const threshold = finiteNonNegative(coldSweepThreshold, "Cold Wallet sweep threshold");
  const percent = finiteNonNegative(coldSweepPercent, "Cold Wallet sweep percentage");
  if (!percent.isGreaterThan(0) || percent.isGreaterThan(100)) {
    throw new RangeError("Cold Wallet sweep percentage must be greater than 0 and at most 100.");
  }

  const reservedTotal = Object.values(categories).reduce(
    (sum, value) => sum.plus(value), new BigNumber(0),
  );
  const obligationsAndFloor = reservedTotal.plus(minimum);
  const available = BigNumber.maximum(0, total.minus(obligationsAndFloor));
  const eligible = Boolean(coldWalletConfigured) && available.gte(threshold);
  const proposedSweep = eligible
    ? available.multipliedBy(percent).dividedBy(100).decimalPlaces(TOKEN_DECIMALS, BigNumber.ROUND_DOWN)
    : new BigNumber(0);

  return {
    onchain_balance: total.toFixed(TOKEN_DECIMALS),
    reserves: Object.fromEntries(Object.entries(categories).map(([key, value]) => [key, value.toFixed(TOKEN_DECIMALS)])),
    reserved_total: reservedTotal.toFixed(TOKEN_DECIMALS),
    minimum_operating_balance: minimum.toFixed(TOKEN_DECIMALS),
    available_for_cold_sweep: available.toFixed(TOKEN_DECIMALS),
    cold_sweep: {
      enabled: Boolean(coldWalletConfigured),
      threshold_bsc_usd: threshold.toFixed(TOKEN_DECIMALS),
      percent: percent.toFixed(4),
      eligible,
      proposed_amount_bsc_usd: proposedSweep.toFixed(TOKEN_DECIMALS),
      retained_free_balance_after_sweep: available.minus(proposedSweep).toFixed(TOKEN_DECIMALS),
    },
  };
}

async function queryRows(queryable, sql, params = []) {
  if (queryable && typeof queryable.queryAsync === "function") {
    return queryable.queryAsync(sql, params);
  }
  if (queryable && typeof queryable.query === "function") {
    const result = await queryable.query(sql, params);
    return Array.isArray(result) && Array.isArray(result[0]) ? result[0] : result;
  }
  throw new TypeError("A MySQL queryable is required.");
}

async function getHotWalletReserveAmounts(queryable) {
  const [rechargeRows, unknownRows, sellerRows, otherRefundRows, sweepRows] = await Promise.all([
    queryRows(queryable,
      `SELECT COALESCE(SUM(remaining_amount),0) AS pending_amount,
              COALESCE(SUM(reserved_refund_amount),0) AS refund_reserved_amount
       FROM users_usdt_deposit_batches
       WHERE remaining_amount>0 OR reserved_refund_amount>0`),
    queryRows(queryable,
      `SELECT COALESCE(SUM(amount),0) AS amount
       FROM bsc_unknown_incoming_transfers
       WHERE status IN ('pending_admin','refund_queued','refund_failed','refund_manual_review','resolved_uncredited')`),
    queryRows(queryable,
      `SELECT payout_pending_initial_asset,unit_price
       FROM users_seller_reserve_lots WHERE payout_pending_initial_asset>0`),
    queryRows(queryable,
      `SELECT COALESCE(SUM(gross_amount),0) AS amount
       FROM users_usdt_refunds
       WHERE batch_id IS NULL AND unknown_transfer_id IS NULL
         AND status IN ('queued','signed','submitted','manual_review')`),
    queryRows(queryable,
      `SELECT COALESCE(SUM(amount),0) AS amount
       FROM bsc_treasury_sweeps
       WHERE status IN ('queued','signed','submitted','manual_review')`),
  ]);

  const sellerReserve = sellerRows.reduce((sum, row) => {
    const pendingInitial = finiteNonNegative(row.payout_pending_initial_asset, "Seller payout pending initial assets");
    const lockedPrice = finiteNonNegative(row.unit_price, "Seller payout locked individual price");
    return sum.plus(pendingInitial.multipliedBy(lockedPrice));
  }, new BigNumber(0));

  return {
    pendingRechargeAmount: rechargeRows[0]?.pending_amount || "0",
    reservedRechargeRefundAmount: rechargeRows[0]?.refund_reserved_amount || "0",
    unresolvedUnknownIncomingAmount: unknownRows[0]?.amount || "0",
    pendingSellerPayoutAmount: sellerReserve.toFixed(TOKEN_DECIMALS),
    otherPendingRefundAmount: otherRefundRows[0]?.amount || "0",
    pendingColdWalletSweepAmount: sweepRows[0]?.amount || "0",
  };
}

async function getFinalizedBlock(provider) {
  try {
    const finalized = await provider.getBlock("finalized");
    if (finalized?.number != null) {
      return { number: BigInt(finalized.number), method: "finalized" };
    }
  } catch {}

  const latest = BigInt(await provider.getBlockNumber());
  const confirmations = BigInt(process.env.USDT_MIN_CONFIRMATIONS || "15");
  if (confirmations < 1n || confirmations > 200n) {
    throw new Error("USDT_MIN_CONFIRMATIONS must be between 1 and 200.");
  }
  const number = latest >= confirmations - 1n ? latest - (confirmations - 1n) : 0n;
  return { number, method: "confirmations" };
}

async function getHotWalletOnchainBalances({ rpcUrl, tokenAddress, walletAddress }) {
  const rpc = String(rpcUrl || process.env.BSC_RPC_URL || "").trim();
  const configuredToken = String(tokenAddress || process.env.USDT_BEP20_CONTRACT || CANONICAL_BSC_USD_CONTRACT).trim();
  const configuredWallet = String(walletAddress || process.env.USDT_BEP20_TREASURY_ADDRESS || "").trim();
  if (!rpc || !configuredWallet) {
    return { status: "not_configured", token_balance: null, bnb_balance: null };
  }

  const token = getAddress(configuredToken);
  const wallet = getAddress(configuredWallet);
  if (token.toLowerCase() !== CANONICAL_BSC_USD_CONTRACT.toLowerCase()) {
    throw new Error("Only the approved Binance-Peg BSC-USD contract can be used for treasury accounting.");
  }
  const provider = new JsonRpcProvider(rpc, Number(CHAIN_ID), { staticNetwork: true });
  attachEthersRpcMetrics(provider, rpc, "hot-wallet-liquidity-check");
  try {
    const network = await provider.getNetwork();
    if (BigInt(network.chainId) !== CHAIN_ID) throw new Error("The Hot Wallet RPC is not BNB Smart Chain mainnet.");
    const contract = new Contract(token, BALANCE_ABI, provider);
    const [safeBlock, latestBlock] = await Promise.all([
      getFinalizedBlock(provider),
      provider.getBlockNumber(),
    ]);
    // Use the same finalized block that the incoming scanner must have fully indexed.
    // This prevents unscanned, non-finalized deposits from being swept to cold storage.
    const [tokenBalanceRaw, bnbBalanceWei] = await Promise.all([
      contract.balanceOf(wallet, { blockTag: safeBlock.number }),
      provider.getBalance(wallet),
    ]);
    return {
      status: "available",
      token_balance: new BigNumber(tokenBalanceRaw.toString()).shiftedBy(-TOKEN_DECIMALS).toFixed(TOKEN_DECIMALS),
      token_balance_raw: tokenBalanceRaw.toString(),
      bnb_balance: new BigNumber(bnbBalanceWei.toString()).shiftedBy(-18).toFixed(18),
      bnb_balance_wei: bnbBalanceWei.toString(),
      block_number: safeBlock.number.toString(),
      finality_method: safeBlock.method,
      latest_block_number: String(latestBlock),
    };
  } finally {
    await provider.destroy();
  }
}

async function getIncomingScannerReadiness(queryable, chain) {
  if (String(process.env.USDT_PAYMENTS_ENABLED || "false").toLowerCase() !== "true") {
    return { ready: false, reason: "incoming_payments_scanner_disabled" };
  }
  if (!chain || chain.status !== "available" || chain.block_number == null) {
    return { ready: false, reason: "hot_wallet_chain_balance_unavailable" };
  }
  const rows = await queryRows(
    queryable,
    `SELECT chain_id,token_contract,treasury_address,last_scanned_block,last_finalized_block,health_status,updated_at_ms
     FROM bsc_incoming_scan_state WHERE singleton_id=1 LIMIT 1`,
  );
  if (!rows.length) return { ready: false, reason: "incoming_scanner_not_initialized" };
  const state = rows[0];
  const tokenAddress = String(process.env.USDT_BEP20_CONTRACT || CANONICAL_BSC_USD_CONTRACT).trim().toLowerCase();
  const treasuryAddress = String(process.env.USDT_BEP20_TREASURY_ADDRESS || "").trim().toLowerCase();
  if (
    Number(state.chain_id) !== Number(CHAIN_ID) ||
    String(state.token_contract || "").toLowerCase() !== tokenAddress ||
    String(state.treasury_address || "").toLowerCase() !== treasuryAddress ||
    state.health_status !== "healthy" || state.last_scanned_block == null
  ) {
    return { ready: false, reason: "incoming_scanner_requires_reconciliation" };
  }
  const scannedBlock = BigInt(state.last_scanned_block);
  const balanceBlock = BigInt(chain.block_number);
  if (scannedBlock < balanceBlock) {
    return {
      ready: false,
      reason: "incoming_scanner_behind_finalized_chain",
      last_scanned_block: scannedBlock.toString(),
      balance_block_number: balanceBlock.toString(),
    };
  }
  return {
    ready: true,
    last_scanned_block: scannedBlock.toString(),
    balance_block_number: balanceBlock.toString(),
    last_finalized_block: state.last_finalized_block == null ? null : String(state.last_finalized_block),
    updated_at_ms: state.updated_at_ms == null ? null : Number(state.updated_at_ms),
  };
}

async function getHotWalletFinalizedTokenBalance({ queryable, provider, tokenContract, walletAddress }) {
  if (!provider || !tokenContract || !walletAddress) {
    throw new TypeError("A provider, BSC-USD contract and Hot Wallet address are required.");
  }
  const safeBlock = await getFinalizedBlock(provider);
  const scanner = await getIncomingScannerReadiness(queryable, {
    status: "available",
    block_number: safeBlock.number.toString(),
  });
  if (!scanner.ready) {
    throw new Error(`Hot Wallet incoming scanner is not reconciled to the finalized balance block: ${scanner.reason}.`);
  }
  const rawBalance = await tokenContract.balanceOf(getAddress(walletAddress), {
    blockTag: safeBlock.number,
  });
  return {
    tokenBalanceRaw: BigInt(rawBalance.toString()),
    block_number: safeBlock.number.toString(),
    finality_method: safeBlock.method,
    scanner,
  };
}

async function getHotWalletTreasurySnapshot(queryable) {
  const [reserveAmounts, chain] = await Promise.all([
    getHotWalletReserveAmounts(queryable),
    getHotWalletOnchainBalances({}).catch((error) => ({
      status: "rpc_unavailable",
      token_balance: null,
      bnb_balance: null,
      error: String(error?.message || error).slice(0, 300),
    })),
  ]);
  const scanner = await getIncomingScannerReadiness(queryable, chain).catch((error) => ({
    ready: false,
    reason: "incoming_scanner_status_unavailable",
    error: String(error?.message || error).slice(0, 300),
  }));
  const minimum = configuredAmount("USDT_TREASURY_MIN_OPERATING_BSC_USD", "0");
  const threshold = configuredAmount("USDT_COLD_SWEEP_THRESHOLD_BSC_USD", "500");
  const percent = configuredSweepPercent();
  const coldAddress = String(process.env.USDT_BEP20_COLD_WALLET_ADDRESS || "").trim();
  const treasuryAddress = String(process.env.USDT_BEP20_TREASURY_ADDRESS || "").trim();
  const reserveValues = {
    pending_recharges: new BigNumber(reserveAmounts.pendingRechargeAmount).toFixed(18),
    recharge_refunds: new BigNumber(reserveAmounts.reservedRechargeRefundAmount).toFixed(18),
    unknown_incoming_transfers: new BigNumber(reserveAmounts.unresolvedUnknownIncomingAmount).toFixed(18),
    seller_payouts: new BigNumber(reserveAmounts.pendingSellerPayoutAmount).toFixed(18),
    other_refunds: new BigNumber(reserveAmounts.otherPendingRefundAmount).toFixed(18),
    pending_cold_wallet_sweeps: new BigNumber(reserveAmounts.pendingColdWalletSweepAmount).toFixed(18),
  };
  const totalReserved = Object.values(reserveAmounts).reduce((sum, value) => sum.plus(value), new BigNumber(0));
  const base = {
    address: treasuryAddress || null,
    cold_wallet_address: coldAddress || null,
    disbursement_wallet_address: String(process.env.USDT_BEP20_DISBURSEMENT_ADDRESS || "").trim() || null,
    chain,
    reserves: reserveValues,
    reserved_total: totalReserved.toFixed(18),
    minimum_operating_balance: minimum.toFixed(18),
    scanner_readiness: scanner,
    as_of_ms: String(Date.now()),
  };
  if (chain.status !== "available") {
    return {
      ...base,
      available_for_cold_sweep: null,
      cold_sweep: {
        enabled: Boolean(coldAddress),
        threshold_bsc_usd: threshold.toFixed(18),
        percent: percent.toFixed(4),
        eligible: false,
        proposed_amount_bsc_usd: null,
        blocked_reason: "hot_wallet_chain_balance_unavailable",
      },
    };
  }

  const calculation = calculateHotWalletLiquidity({
    onchainBalance: chain.token_balance,
    pendingRechargeAmount: reserveAmounts.pendingRechargeAmount,
    reservedRechargeRefundAmount: reserveAmounts.reservedRechargeRefundAmount,
    unresolvedUnknownIncomingAmount: reserveAmounts.unresolvedUnknownIncomingAmount,
    pendingSellerPayoutAmount: reserveAmounts.pendingSellerPayoutAmount,
    otherPendingRefundAmount: reserveAmounts.otherPendingRefundAmount,
    pendingColdWalletSweepAmount: reserveAmounts.pendingColdWalletSweepAmount,
    minimumOperatingAmount: minimum,
    coldSweepThreshold: threshold,
    coldSweepPercent: percent,
    coldWalletConfigured: Boolean(coldAddress),
  });
  if (!scanner.ready) {
    return {
      ...base,
      ...calculation,
      available_for_cold_sweep: null,
      provisional_available_before_scanner_reconciliation: calculation.available_for_cold_sweep,
      cold_sweep: {
        ...calculation.cold_sweep,
        eligible: false,
        proposed_amount_bsc_usd: "0.000000000000000000",
        blocked_reason: scanner.reason,
      },
    };
  }
  return { ...base, ...calculation };
}

module.exports = {
  CANONICAL_BSC_USD_CONTRACT,
  calculateHotWalletLiquidity,
  getHotWalletReserveAmounts,
  getHotWalletOnchainBalances,
  getIncomingScannerReadiness,
  getHotWalletFinalizedTokenBalance,
  getHotWalletTreasurySnapshot,
};
