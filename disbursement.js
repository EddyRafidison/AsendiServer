"use strict";

const {
  Contract,
  Interface,
  JsonRpcProvider,
  Wallet,
  getAddress,
  keccak256,
} = require("ethers");
const BigNumber = require("bignumber.js");
const crypto = require("crypto");
const {
  calculateDisbursementReserveSettlement,
  calculateGlobalDisbursement,
} = require("./disbursement-policy");
const { getDate } = require("./utils");
const { queueTelegramMessageTx } = require("./telegram");
const { recordUserOperationTx, triggerUserPriceThresholdTx } = require("./user-price-accounting");
const { recordRefundRequestEventTx } = require("./refund-request-audit");
const {
  getLatestCommonTx,
  insertCommonSnapshotTx,
} = require("./common-accounting");
const {
  getConfiguredBnbUsdPrice,
  estimateBscTokenTransfer,
  recordEstimatedBscFeeTx,
  recordActualBscFeeTx,
} = require("./bsc-fee-accounting");
const { getBnbUsdPrice, startBnbUsdPriceOracle } = require("./bsc-price-oracle");
const { attachEthersRpcMetrics } = require("./bsc-rpc-ethers-metrics");
const { createBscFeeLimitError, getConfiguredMaxBscTxFeeUsd } = require("./bsc-transaction-policy");
const { SYSTEM_ADMIN_RESERVE_RATIO } = require("./deposit-policy");
const { calculateRemainingAdministrativeBacking } = require("./stock-accounting");
const {
  calculateRequiredAdminBonusReserve,
} = require("./global-disbursement-policy");
const { markPendingDepositBatchesDueTx } = require("./deposit-retry");
const { MINIMUM_REFUND_NET_BSC_USD } = require("./refund-policy");
const { getMinimumOutgoingNetBscUsd } = require("./outgoing-payout-policy");
const { db: sharedDb } = require("./db");
const {
  getHotWalletReserveAmounts,
  getHotWalletFinalizedTokenBalance,
} = require("./treasury-liquidity");

const INITIAL_STOCK_LIMIT = process.env.STOCK_LIMIT || "18000000";

const CHAIN_ID = 56n;
const TOKEN_DECIMALS = 18n;
const CANONICAL_BSC_USD_CONTRACT =
  "0x55d398326f99059fF775485246999027B3197955";
const TRANSFER_INTERFACE = new Interface([
  "function transfer(address to,uint256 amount) returns (bool)",
]);
const TRANSFER_EVENT_INTERFACE = new Interface([
  "event Transfer(address indexed from,address indexed to,uint256 value)",
]);
const BALANCE_INTERFACE = new Interface([
  "function balanceOf(address account) view returns (uint256)",
]);
const WORKER_LOCK_NAME = "onex_bsc_disbursement_worker";

let runtime = null;
let timer = null;
let workerRunning = false;

function requiredAddress(value, label) {
  try {
    return getAddress(String(value || "").trim());
  } catch {
    throw new Error(`${label} is not a valid EVM address.`);
  }
}

async function estimateNetBscTokenTransfer({
  provider,
  fromAddress,
  tokenAddress,
  payoutAddress,
  grossAmount,
  tokenBalanceRaw,
  maximumGasLimit,
  bnbUsdPrice,
}) {
  const gross = new BigNumber(grossAmount);
  const availableRaw = BigInt(tokenBalanceRaw);
  if (!gross.isFinite() || !gross.isGreaterThan(0) || availableRaw <= 0n) {
    throw new Error("The BSC-USD payout amount and treasury balance must be positive.");
  }
  const grossRaw = BigInt(gross.shiftedBy(18).integerValue(BigNumber.ROUND_DOWN).toFixed(0));
  let candidateRaw = availableRaw < grossRaw ? availableRaw : grossRaw;
  if (candidateRaw <= 0n) {
    throw new Error("The BSC-USD payout amount rounds to zero.");
  }

  for (let attempt = 0; attempt < 6; attempt += 1) {
    const data = TRANSFER_INTERFACE.encodeFunctionData("transfer", [payoutAddress, candidateRaw]);
    const estimate = await estimateBscTokenTransfer({
      provider,
      fromAddress,
      tokenAddress,
      data,
      maximumGasLimit,
      bnbUsdPrice,
    });
    if (!estimate.allowed) {
      throw createBscFeeLimitError(estimate.feeUsd, estimate.maximumFeeUsd);
    }

    const payoutAmount = gross.minus(estimate.feeUsd).decimalPlaces(18, BigNumber.ROUND_DOWN);
    if (!payoutAmount.isFinite() || !payoutAmount.isGreaterThan(0)) {
      return { payoutAmount, amountRaw: 0n, data: null, estimate };
    }
    const nextRaw = BigInt(payoutAmount.shiftedBy(18).integerValue(BigNumber.ROUND_DOWN).toFixed(0));
    if (nextRaw <= 0n) {
      return { payoutAmount, amountRaw: 0n, data: null, estimate };
    }
    if (availableRaw < nextRaw) {
      throw new Error("The OneX treasury has insufficient BSC-USD for the net payout amount.");
    }

    const nextData = TRANSFER_INTERFACE.encodeFunctionData("transfer", [payoutAddress, nextRaw]);
    if (nextData === data) {
      return { payoutAmount, amountRaw: nextRaw, data, estimate };
    }
    candidateRaw = nextRaw;
  }

  throw new Error("The BSC-USD payout amount and gas estimate did not converge; the queued job will be re-evaluated.");
}

function makeRuntime({ needDisbursement = true, needTreasury = true } = {}) {
  if (runtime) return runtime;

  const rpcUrl = String(process.env.BSC_RPC_URL || "").trim();
  const tokenAddress = requiredAddress(
    process.env.USDT_BEP20_CONTRACT || CANONICAL_BSC_USD_CONTRACT,
    "BSC-USD token contract",
  );
  const treasuryAddressRaw = String(process.env.USDT_BEP20_TREASURY_ADDRESS || "").trim();
  const disbursementAddressRaw = String(process.env.USDT_BEP20_DISBURSEMENT_ADDRESS || "").trim();
  const treasuryAddress = (needTreasury || treasuryAddressRaw)
    ? requiredAddress(treasuryAddressRaw, "Hot Wallet address") : null;
  const disbursementAddress = (needDisbursement || disbursementAddressRaw)
    ? requiredAddress(disbursementAddressRaw, "Disbursement Wallet address") : null;
  const coldAddressRaw = String(process.env.USDT_BEP20_COLD_WALLET_ADDRESS || "").trim();
  const coldAddress = coldAddressRaw ? requiredAddress(coldAddressRaw, "Cold Wallet address") : null;
  const confirmations = Number(process.env.USDT_DISBURSEMENT_CONFIRMATIONS || 15);
  const pollIntervalMs = Number(process.env.USDT_DISBURSEMENT_POLL_MS || 3000);
  const gasLimit = BigInt(process.env.USDT_DISBURSEMENT_GAS_LIMIT || "100000");

  if (!rpcUrl) throw new Error("BSC_RPC_URL is required for outgoing BSC-USD transactions.");
  if (tokenAddress.toLowerCase() !== CANONICAL_BSC_USD_CONTRACT.toLowerCase()) {
    throw new Error("Disbursement token contract is not the approved Binance-Peg BSC-USD contract.");
  }
  if (!Number.isInteger(confirmations) || confirmations < 1 || confirmations > 200) {
    throw new Error("USDT_DISBURSEMENT_CONFIRMATIONS must be between 1 and 200.");
  }
  if (!Number.isInteger(pollIntervalMs) || pollIntervalMs < 1000 || pollIntervalMs > 60000) {
    throw new Error("USDT_DISBURSEMENT_POLL_MS must be between 1000 and 60000 milliseconds.");
  }
  if (gasLimit < 60000n || gasLimit > 200000n) {
    throw new Error("USDT_DISBURSEMENT_GAS_LIMIT must be between 60000 and 200000.");
  }

  const distinctAddresses = [treasuryAddress, disbursementAddress, coldAddress]
    .filter(Boolean).map((address) => address.toLowerCase());
  if (new Set(distinctAddresses).size !== distinctAddresses.length) {
    throw new Error("Hot, Cold and Disbursement Wallet addresses must be different.");
  }
  if (distinctAddresses.includes(tokenAddress.toLowerCase())) {
    throw new Error("A treasury wallet address cannot be the BSC-USD token contract.");
  }

  const provider = new JsonRpcProvider(rpcUrl, 56, { staticNetwork: true });
  attachEthersRpcMetrics(provider, rpcUrl, "disbursement-worker");
  const token = new Contract(tokenAddress, BALANCE_INTERFACE, provider);
  const createWalletRuntime = (privateKeyName, address, role) => {
    const privateKey = String(process.env[privateKeyName] || "").trim();
    if (!privateKey) throw new Error(`${privateKeyName} is required for the ${role}.`);
    const signer = new Wallet(privateKey, provider);
    if (signer.address.toLowerCase() !== address.toLowerCase()) {
      throw new Error(`${privateKeyName} does not match the configured ${role} address.`);
    }
    return { provider, signer, tokenAddress, treasuryAddress: address, confirmations, pollIntervalMs, gasLimit, token };
  };

  const disbursementRuntime = needDisbursement
    ? createWalletRuntime("BSC_DISBURSEMENT_PRIVATE_KEY", disbursementAddress, "Disbursement Wallet")
    : null;
  const treasuryRuntime = needTreasury
    ? createWalletRuntime("BSC_TREASURY_PRIVATE_KEY", treasuryAddress, "Hot Wallet")
    : null;

  runtime = {
    provider,
    tokenAddress,
    token,
    confirmations,
    pollIntervalMs,
    gasLimit,
    treasuryAddress,
    disbursementAddress,
    coldAddress,
    disbursementRuntime,
    treasuryRuntime,
  };
  return runtime;
}

async function validateRuntime(activeRuntime) {
  const network = await activeRuntime.provider.getNetwork();
  if (BigInt(network.chainId) !== CHAIN_ID) {
    throw new Error(`Disbursement RPC is on chain ${network.chainId}; expected chain 56.`);
  }

  const code = await activeRuntime.provider.getCode(activeRuntime.tokenAddress);
  if (!code || code === "0x") {
    throw new Error("The approved BSC-USD contract is not deployed on the disbursement RPC.");
  }

  const decimalsResult = await activeRuntime.provider.call({
    to: activeRuntime.tokenAddress,
    data: "0x313ce567",
  });
  if (BigInt(decimalsResult) !== TOKEN_DECIMALS) {
    throw new Error("The approved BSC-USD token must use 18 decimals.");
  }
}

function tokenAmountToRaw(value, label) {
  const amount = new BigNumber(value == null || value === "" ? 0 : value);
  if (!amount.isFinite() || amount.isNegative()) {
    throw new TypeError(`${label} must be a finite non-negative BSC-USD amount.`);
  }
  return BigInt(amount.shiftedBy(18).integerValue(BigNumber.ROUND_CEIL).toFixed(0));
}

async function queryRows(queryable, sql, params = []) {
  if (queryable && typeof queryable.queryAsync === "function") {
    return queryable.queryAsync(sql, params);
  }
  if (queryable && typeof queryable.query === "function") {
    const result = await queryable.query(sql, params);
    return Array.isArray(result) && Array.isArray(result[0]) ? result[0] : result;
  }
  throw new TypeError("A MySQL queryable is required for disbursement reserve checks.");
}

async function getDisbursementReservedRaw(queryable = sharedDb) {
  const rows = await queryRows(
    queryable,
    `SELECT COALESCE(SUM(payout_amount),0) AS reserved_amount
     FROM users_usdt_disbursements
     WHERE status IN ('queued','signed','submitted','manual_review')`,
  );
  return tokenAmountToRaw(rows[0]?.reserved_amount || "0", "Reserved disbursement amount");
}

async function getDisbursementSpendableTokenRaw(tokenBalanceRaw, reservationCreditRaw = 0n, queryable = sharedDb) {
  const balance = BigInt(tokenBalanceRaw);
  const reserved = await getDisbursementReservedRaw(queryable);
  const credit = BigInt(reservationCreditRaw);
  if (credit < 0n) throw new TypeError("Disbursement reservation credit cannot be negative.");
  const protectedReservations = reserved > credit ? reserved - credit : 0n;
  return balance > protectedReservations ? balance - protectedReservations : 0n;
}

async function getHotWalletSpendableTokenRaw(tokenBalanceRaw, reservationCredit = "0", queryable = sharedDb) {
  const reserves = await getHotWalletReserveAmounts(queryable);
  const reservedTotal = [
    reserves.pendingDepositAmount,
    reserves.reservedDepositRefundAmount,
    reserves.unresolvedUnknownIncomingAmount,
    reserves.pendingSellerPayoutAmount,
    reserves.otherPendingRefundAmount,
    reserves.pendingColdWalletSweepAmount,
  ].reduce((sum, value) => sum.plus(value || "0"), new BigNumber(0));
  const credit = new BigNumber(reservationCredit == null ? "0" : String(reservationCredit));
  if (!credit.isFinite() || credit.isNegative()) {
    throw new TypeError("Hot Wallet reservation credit must be a finite non-negative amount.");
  }
  const protectedReservations = BigNumber.maximum(0, reservedTotal.minus(credit));
  const minimumOperating = new BigNumber(
    String(process.env.USDT_TREASURY_MIN_OPERATING_BSC_USD || "0").trim() || "0",
  );
  if (!minimumOperating.isFinite() || minimumOperating.isNegative()) {
    throw new TypeError("USDT_TREASURY_MIN_OPERATING_BSC_USD must be non-negative.");
  }
  const protectedRaw = tokenAmountToRaw(
    protectedReservations.plus(minimumOperating),
    "Hot Wallet protected balance",
  );
  const totalRaw = BigInt(tokenBalanceRaw);
  return totalRaw > protectedRaw ? totalRaw - protectedRaw : 0n;
}

async function checkTreasuryLiquidity(amountRaw, payoutAddress, options = {}) {
  const rpcUrl = String(process.env.BSC_RPC_URL || "").trim();
  const tokenAddress = requiredAddress(
    process.env.USDT_BEP20_CONTRACT || CANONICAL_BSC_USD_CONTRACT,
    "BSC-USD token contract",
  );
  const treasuryAddress = requiredAddress(
    process.env.USDT_BEP20_TREASURY_ADDRESS || "",
    "OneX Hot Wallet address",
  );
  const gasLimitCeiling = BigInt(process.env.USDT_DISBURSEMENT_GAS_LIMIT || "100000");
  const amount = BigInt(amountRaw);
  const destination = requiredAddress(payoutAddress, "BSC-USD payout address");
  const reservationCredit = options.reservationCredit == null ? "0" : options.reservationCredit;
  if (!rpcUrl || amount <= 0n || tokenAddress.toLowerCase() !== CANONICAL_BSC_USD_CONTRACT.toLowerCase()) {
    throw new Error("Hot Wallet liquidity check is not correctly configured.");
  }
  if (gasLimitCeiling < 60000n || gasLimitCeiling > 200000n) {
    throw new Error("USDT_DISBURSEMENT_GAS_LIMIT is outside the permitted range.");
  }

  const provider = new JsonRpcProvider(rpcUrl, 56, { staticNetwork: true });
  attachEthersRpcMetrics(provider, rpcUrl, "disbursement-liquidity-check");
  try {
    const network = await provider.getNetwork();
    if (BigInt(network.chainId) !== CHAIN_ID) throw new Error("Hot Wallet RPC is not BNB Smart Chain mainnet.");
    const code = await provider.getCode(tokenAddress);
    if (!code || code === "0x") throw new Error("The approved BSC-USD contract is unavailable.");
    const token = new Contract(tokenAddress, ["function balanceOf(address account) view returns (uint256)"], provider);
    const { tokenBalanceRaw } = await getHotWalletFinalizedTokenBalance({
      queryable: options.queryable || sharedDb,
      provider,
      tokenContract: token,
      walletAddress: treasuryAddress,
    });
    const spendableTokenBalance = await getHotWalletSpendableTokenRaw(
      tokenBalanceRaw,
      reservationCredit,
      options.queryable || sharedDb,
    );
    const data = TRANSFER_INTERFACE.encodeFunctionData("transfer", [destination, amount]);
    const bnbUsdPrice = await getBnbUsdPrice(provider);
    const estimate = await estimateBscTokenTransfer({
      provider,
      fromAddress: treasuryAddress,
      tokenAddress,
      data,
      maximumGasLimit: gasLimitCeiling,
      bnbUsdPrice,
    });
    const bnbBalance = await provider.getBalance(treasuryAddress);
    const requiredGas = estimate.gasLimit * estimate.gasPrice;
    const tokenAvailable = spendableTokenBalance >= amount;
    const bnbAvailable = bnbBalance >= requiredGas;
    return {
      available: tokenAvailable && bnbAvailable && estimate.allowed,
      tokenAvailable,
      bnbAvailable,
      feeWithinLimit: estimate.allowed,
      maximumFeeUsd: estimate.maximumFeeUsd.toFixed(18),
      tokenBalanceRaw: tokenBalance.toString(),
      spendableTokenBalanceRaw: spendableTokenBalance.toString(),
      requiredTokenRaw: amount.toString(),
      bnbBalanceWei: bnbBalance.toString(),
      requiredBnbWei: requiredGas.toString(),
      gasLimit: estimate.gasLimit.toString(),
      gasPriceWei: estimate.gasPrice.toString(),
      estimatedFeeBnb: estimate.feeBnb.toFixed(30),
      estimatedFeeUsd: estimate.feeUsd.toFixed(18),
      bnbUsdPrice: estimate.bnbUsdPrice.toFixed(12),
    };
  } finally {
    await provider.destroy();
  }
}

async function checkDisbursementLiquidity(amountRaw, payoutAddress, options = {}) {
  const rpcUrl = String(process.env.BSC_RPC_URL || "").trim();
  const tokenAddress = requiredAddress(
    process.env.USDT_BEP20_CONTRACT || CANONICAL_BSC_USD_CONTRACT,
    "BSC-USD token contract",
  );
  const disbursementAddress = requiredAddress(
    process.env.USDT_BEP20_DISBURSEMENT_ADDRESS || "",
    "OneX Disbursement Wallet address",
  );
  const destination = requiredAddress(payoutAddress, "BSC-USD payout address");
  const amount = BigInt(amountRaw);
  if (!rpcUrl || amount <= 0n || tokenAddress.toLowerCase() !== CANONICAL_BSC_USD_CONTRACT.toLowerCase()) {
    throw new Error("Disbursement Wallet liquidity check is not correctly configured.");
  }
  const provider = new JsonRpcProvider(rpcUrl, 56, { staticNetwork: true });
  attachEthersRpcMetrics(provider, rpcUrl, "disbursement-liquidity-check");
  try {
    const network = await provider.getNetwork();
    if (BigInt(network.chainId) !== CHAIN_ID) throw new Error("Disbursement Wallet RPC is not BNB Smart Chain mainnet.");
    const code = await provider.getCode(tokenAddress);
    if (!code || code === "0x") throw new Error("The approved BSC-USD contract is unavailable.");
    const token = new Contract(tokenAddress, ["function balanceOf(address account) view returns (uint256)"], provider);
    const [tokenBalance, bnbBalance, reservedRaw] = await Promise.all([
      token.balanceOf(disbursementAddress),
      provider.getBalance(disbursementAddress),
      getDisbursementReservedRaw(options.queryable || sharedDb),
    ]);
    const creditRaw = options.reservationCreditRaw == null ? 0n : BigInt(options.reservationCreditRaw);
    const protectedRaw = reservedRaw > creditRaw ? reservedRaw - creditRaw : 0n;
    const spendableRaw = tokenBalance > protectedRaw ? tokenBalance - protectedRaw : 0n;
    const gasLimitCeiling = BigInt(process.env.USDT_DISBURSEMENT_GAS_LIMIT || "100000");
    const data = TRANSFER_INTERFACE.encodeFunctionData("transfer", [destination, amount]);
    const bnbUsdPrice = await getBnbUsdPrice(provider);
    const estimate = await estimateBscTokenTransfer({
      provider,
      fromAddress: disbursementAddress,
      tokenAddress,
      data,
      maximumGasLimit: gasLimitCeiling,
      bnbUsdPrice,
    });
    const requiredGas = estimate.gasLimit * estimate.gasPrice;
    return {
      available: spendableRaw >= amount && bnbBalance >= requiredGas && estimate.allowed,
      tokenAvailable: spendableRaw >= amount,
      bnbAvailable: bnbBalance >= requiredGas,
      feeWithinLimit: estimate.allowed,
      tokenBalanceRaw: tokenBalance.toString(),
      reservedTokenRaw: reservedRaw.toString(),
      spendableTokenBalanceRaw: spendableRaw.toString(),
      requiredTokenRaw: amount.toString(),
      bnbBalanceWei: bnbBalance.toString(),
      requiredBnbWei: requiredGas.toString(),
      estimatedFeeUsd: estimate.feeUsd.toFixed(18),
    };
  } finally {
    await provider.destroy();
  }
}

async function checkDisbursementReserveCapacity(requiredAmountBscUsd, options = {}) {
  const rpcUrl = String(process.env.BSC_RPC_URL || "").trim();
  const tokenAddress = requiredAddress(
    process.env.USDT_BEP20_CONTRACT || CANONICAL_BSC_USD_CONTRACT,
    "BSC-USD token contract",
  );
  const disbursementAddress = requiredAddress(
    process.env.USDT_BEP20_DISBURSEMENT_ADDRESS || "",
    "OneX Disbursement Wallet address",
  );
  const requiredRaw = tokenAmountToRaw(requiredAmountBscUsd, "Required global disbursement reserve");
  if (!rpcUrl || tokenAddress.toLowerCase() !== CANONICAL_BSC_USD_CONTRACT.toLowerCase()) {
    throw new Error("Disbursement Wallet reserve check is not correctly configured.");
  }
  const provider = new JsonRpcProvider(rpcUrl, 56, { staticNetwork: true });
  attachEthersRpcMetrics(provider, rpcUrl, "disbursement-reserve-check");
  try {
    const network = await provider.getNetwork();
    if (BigInt(network.chainId) !== CHAIN_ID) throw new Error("Disbursement Wallet RPC is not BNB Smart Chain mainnet.");
    const token = new Contract(tokenAddress, ["function balanceOf(address account) view returns (uint256)"], provider);
    const [balanceRaw, reservedRaw] = await Promise.all([
      token.balanceOf(disbursementAddress),
      getDisbursementReservedRaw(options.queryable || sharedDb),
    ]);
    const spendableRaw = balanceRaw > reservedRaw ? balanceRaw - reservedRaw : 0n;
    return {
      available: spendableRaw >= requiredRaw,
      token_balance_raw: balanceRaw.toString(),
      reserved_raw: reservedRaw.toString(),
      spendable_raw: spendableRaw.toString(),
      required_raw: requiredRaw.toString(),
      token_balance_bsc_usd: new BigNumber(balanceRaw.toString()).shiftedBy(-18).toFixed(18),
      reserved_bsc_usd: new BigNumber(reservedRaw.toString()).shiftedBy(-18).toFixed(18),
      spendable_bsc_usd: new BigNumber(spendableRaw.toString()).shiftedBy(-18).toFixed(18),
      required_bsc_usd: new BigNumber(requiredRaw.toString()).shiftedBy(-18).toFixed(18),
    };
  } finally {
    await provider.destroy();
  }
}

function connectionFromPool(db) {
  return new Promise((resolve, reject) => {
    db.getConnection((error, connection) => {
      if (error) return reject(error);
      resolve(connection);
    });
  });
}

async function withTransaction(db, work) {
  const connection = await connectionFromPool(db);
  const tx = connection.promise();
  let started = false;
  try {
    await tx.beginTransaction();
    started = true;
    const result = await work(tx);
    await tx.commit();
    started = false;
    return result;
  } catch (error) {
    if (started) {
      try {
        await tx.rollback();
      } catch (rollbackError) {
        console.error("Disbursement rollback failed:", rollbackError.message);
      }
    }
    throw error;
  } finally {
    connection.release();
  }
}

async function acquireWorkerLock(db) {
  const connection = await connectionFromPool(db);
  const queryable = connection.promise();
  try {
    const [rows] = await queryable.query(
      "SELECT GET_LOCK(?, 0) AS acquired",
      [WORKER_LOCK_NAME],
    );
    if (Number(rows[0]?.acquired) !== 1) {
      connection.release();
      return null;
    }

    let released = false;
    return async () => {
      if (released) return;
      released = true;
      try {
        await queryable.query("SELECT RELEASE_LOCK(?)", [WORKER_LOCK_NAME]);
      } finally {
        connection.release();
      }
    };
  } catch (error) {
    connection.release();
    throw error;
  }
}

async function updateJobError(db, jobId, error) {
  const message = String(error?.message || error || "Unknown disbursement error").slice(0, 2000);
  await db.queryAsync(
    "UPDATE users_usdt_disbursements SET last_error=?,updated_at_ms=? WHERE id=? AND status IN ('queued','signed','submitted')",
    [message, String(Date.now()), jobId],
  );
}

async function signQueuedJob(db, job, activeRuntime) {
  if (job.disbursement_mode !== "global" && Number(job.reservation_expires_at_ms) <= Date.now()) {
    await markManualReview(
      db,
      job.id,
      "Reservation expired before transaction submission; administrator review is required.",
    );
    return false;
  }
  const payoutAddress = requiredAddress(job.payout_address, "Disbursement payout address");
  if (payoutAddress.toLowerCase() === activeRuntime.treasuryAddress.toLowerCase()) {
    throw new Error("The payout address cannot be the OneX treasury address.");
  }

  let amountRaw;
  let payoutAmount = new BigNumber(job.payout_amount);
  let bscFeeRecovered = new BigNumber(job.bsc_fee_recovered_usd || "0");
  let estimate;
  let data;
  const tokenBalanceRaw = await activeRuntime.token.balanceOf(activeRuntime.treasuryAddress);
  const reservationCreditRaw = tokenAmountToRaw(job.payout_amount || "0", "Current disbursement reservation");
  const spendableTokenBalanceRaw = await getDisbursementSpendableTokenRaw(
    tokenBalanceRaw,
    reservationCreditRaw,
    db,
  );
  const grossBase = new BigNumber(job.sold_initial_asset)
    .multipliedBy(new BigNumber(job.price_value))
    .plus(new BigNumber(job.bonus_amount || "0"));
  const payoutBase = job.disbursement_mode === "global" ? grossBase : payoutAmount;
  if (!payoutBase.isFinite() || !payoutBase.isGreaterThan(0)) {
    throw new Error("The disbursement net amount after tfees must be positive.");
  }
  const payout = await estimateNetBscTokenTransfer({
    provider: activeRuntime.provider,
    fromAddress: activeRuntime.treasuryAddress,
    tokenAddress: activeRuntime.tokenAddress,
    payoutAddress,
    grossAmount: payoutBase,
    tokenBalanceRaw: spendableTokenBalanceRaw,
    maximumGasLimit: activeRuntime.gasLimit,
    bnbUsdPrice: getConfiguredBnbUsdPrice(),
  });
  if (!payout.payoutAmount.isGreaterThan(0) || payout.amountRaw <= 0n || !payout.data) {
    throw new Error("The disbursement amount is too small to cover the estimated BSC network fee.");
  }
  payoutAmount = payout.payoutAmount;
  amountRaw = payout.amountRaw;
  data = payout.data;
  estimate = payout.estimate;
  bscFeeRecovered = estimate.feeUsd;

  if (spendableTokenBalanceRaw < amountRaw) {
    throw new Error("The Disbursement Wallet does not have enough unreserved BSC-USD for this payment.");
  }
  const nativeBalance = await activeRuntime.provider.getBalance(activeRuntime.treasuryAddress);
  const requiredGasBalance = estimate.gasLimit * estimate.gasPrice;
  if (nativeBalance < requiredGasBalance) {
    throw new Error("The OneX treasury does not have enough BNB to pay the disbursement transaction fee.");
  }

  const nonce = await activeRuntime.provider.getTransactionCount(activeRuntime.treasuryAddress, "pending");
  const rawTransaction = await activeRuntime.signer.signTransaction({
    type: 0,
    chainId: Number(CHAIN_ID),
    nonce,
    to: activeRuntime.tokenAddress,
    value: 0n,
    data,
    gasLimit: estimate.gasLimit,
    gasPrice: estimate.gasPrice,
  });
  const transactionHash = keccak256(rawTransaction);
  const result = await db.queryAsync(
    `UPDATE users_usdt_disbursements
     SET raw_tx=?,tx_hash=?,nonce=?,status='signed',payout_amount=?,amount_raw=?,
         bsc_fee_recovered_usd=?,estimated_fee_bnb=?,estimated_fee_usd=?,last_error=NULL,updated_at_ms=?
     WHERE id=? AND status='queued' AND raw_tx IS NULL AND tx_hash IS NULL`,
    [
      rawTransaction, transactionHash, String(nonce), payoutAmount.toFixed(18), amountRaw.toString(),
      bscFeeRecovered.toFixed(18), estimate.feeBnb.toFixed(30), estimate.feeUsd.toFixed(18),
      String(Date.now()), job.id,
    ],
  );
  if (result.affectedRows !== 1) throw new Error("The disbursement job was claimed or updated concurrently.");

  await withTransaction(db, async (tx) => {
    await recordEstimatedBscFeeTx(tx, {
      txHash: transactionHash,
      operation: "system_disbursement",
      gasLimit: estimate.gasLimit.toString(),
      gasPriceWei: estimate.gasPrice.toString(),
      bnbUsdPrice: estimate.bnbUsdPrice,
    });
  });
  return true;
}

async function markSubmitted(db, jobId, transactionHash) {
  await db.queryAsync(
    `UPDATE users_usdt_disbursements
     SET status='submitted',tx_hash=?,last_error=NULL,updated_at_ms=?
     WHERE id=? AND status IN ('signed','submitted')`,
    [transactionHash, String(Date.now()), jobId],
  );
}

async function markManualReview(db, jobId, message, receipt = null) {
  return withTransaction(db, async (tx) => {
    const [rows] = await tx.query(
      "SELECT username,status,tx_hash,disbursement_mode,global_run_id FROM users_usdt_disbursements WHERE id=? LIMIT 1 FOR UPDATE",
      [jobId],
    );
    if (!rows.length || rows[0].status === "manual_review") return;
    const username = rows[0].username;
    if (receipt && rows[0].tx_hash) {
      const actualFee = await recordActualBscFeeTx(tx, {
        txHash: rows[0].tx_hash,
        operation: "system_disbursement",
        receipt,
      });
      await tx.query(
        "UPDATE users_usdt_disbursements SET actual_fee_bnb=?,actual_fee_usd=? WHERE id=?",
        [actualFee.feeBnb.toFixed(30), actualFee.feeUsd.toFixed(18), jobId],
      );
    }
    const now = String(Date.now());
    const [update] = await tx.query(
      `UPDATE users_usdt_disbursements
       SET status='manual_review',last_error=?,updated_at_ms=?
       WHERE id=? AND status IN ('queued','signed','submitted')`,
      [String(message).slice(0, 2000), now, jobId],
    );
    if (update.affectedRows === 1) {
      if (rows[0].disbursement_mode === "global" && rows[0].global_run_id != null) {
        await tx.query(
          `UPDATE global_disbursement_participants
           SET status='manual_review',updated_at_ms=?
           WHERE run_id=? AND username=? AND status<>'resolved'`,
          [now, String(rows[0].global_run_id), username],
        );
      }
      await queueTelegramMessageTx(
        tx,
        username,
        `disbursement:${jobId}:manual_review`,
        [
          "OneX Disbursement Update",
          "Your disbursement requires a review by OneX support.",
          `Disbursement ID: ${jobId}`,
          `Reason: ${String(message).slice(0, 500)}`,
          "Your reserved balance has not been released automatically.",
          "Status: MANUAL REVIEW",
        ].join("\n"),
      );
    }
  });
}

async function restoreUserBalanceAfterFailedPayout(db, jobId, message, receipt) {
  return withTransaction(db, async (tx) => {
    const [preRows] = await tx.query(
      "SELECT * FROM users_usdt_disbursements WHERE id=? LIMIT 1",
      [jobId],
    );
    if (preRows.length === 0) return;
    const payoutSnapshot = preRows[0];
    const username = payoutSnapshot.username;
    if (receipt && payoutSnapshot.tx_hash) {
      const actualFee = await recordActualBscFeeTx(tx, {
        txHash: payoutSnapshot.tx_hash,
        operation: "system_disbursement",
        receipt,
      });
      await tx.query(
        "UPDATE users_usdt_disbursements SET actual_fee_bnb=?,actual_fee_usd=? WHERE id=?",
        [actualFee.feeBnb.toFixed(30), actualFee.feeUsd.toFixed(18), jobId],
      );
    }

    const [authRows] = await tx.query(
      "SELECT username FROM auths WHERE username=? LIMIT 1 FOR UPDATE",
      [username],
    );
    const [stockRows] = await tx.query(
      "SELECT balance FROM users_stock WHERE username=? LIMIT 1 FOR UPDATE",
      [username],
    );
    const [jobRows] = await tx.query(
      "SELECT * FROM users_usdt_disbursements WHERE id=? LIMIT 1 FOR UPDATE",
      [jobId],
    );
    if (jobRows.length === 0) return;

    const job = jobRows[0];
    if (job.status === "failed") return;
    if (!authRows.length || !stockRows.length) {
      const reviewReason = `Cannot restore user stock after failed payout: account or stock row is missing. ${message}`;
      await tx.query(
        "UPDATE users_usdt_disbursements SET status='manual_review',last_error=?,updated_at_ms=? WHERE id=?",
        [reviewReason, String(Date.now()), jobId],
      );
      await queueTelegramMessageTx(tx, username, `disbursement:${jobId}:manual_review`, [
        "OneX Disbursement Update",
        "Your disbursement could not be restored automatically and requires support review.",
        `Disbursement ID: ${jobId}`,
        `Reason: ${reviewReason.slice(0, 500)}`,
        "Status: MANUAL REVIEW",
      ].join("\n"));
      return;
    }

    const currentBalanceInitial = new BigNumber(stockRows[0].balance);
    const expectedReservedBalance = new BigNumber(job.balance_after_reservation || "0");
    if (
      !currentBalanceInitial.isFinite() || currentBalanceInitial.isNegative() ||
      !expectedReservedBalance.isFinite() || expectedReservedBalance.isNegative() ||
      !currentBalanceInitial.eq(expectedReservedBalance)
    ) {
      const reviewReason = `Cannot safely restore reserved stock because the user balance changed. ${message}`;
      await tx.query(
        "UPDATE users_usdt_disbursements SET status='manual_review',last_error=?,updated_at_ms=? WHERE id=?",
        [reviewReason, String(Date.now()), jobId],
      );
      await queueTelegramMessageTx(tx, username, `disbursement:${jobId}:manual_review`, [
        "OneX Disbursement Update",
        "Your disbursement could not be restored automatically and requires support review.",
        `Disbursement ID: ${jobId}`,
        `Reason: ${reviewReason.slice(0, 500)}`,
        "Status: MANUAL REVIEW",
      ].join("\n"));
      return;
    }

    const [date, time] = getDate();
    await tx.query(
      "UPDATE users_stock SET balance=?,record_date=?,record_time=? WHERE username=?",
      [currentBalanceInitial.plus(job.gross_initial_asset).toFixed(30), date, time, username],
    );
    await markPendingDepositBatchesDueTx(tx, username);
    const failedAt = String(Date.now());
    await tx.query(
      `UPDATE users_usdt_disbursements
       SET status='failed',last_error=?,updated_at_ms=? WHERE id=?`,
      [String(message).slice(0, 2000), failedAt, jobId],
    );
    if (job.disbursement_mode === "global" && job.global_run_id != null) {
      const restoredBalance = currentBalanceInitial.plus(job.gross_initial_asset);
      const openRows = await tx.query(
        `SELECT status,request_deadline_at_ms,extension_deadline_at_ms FROM global_disbursement_runs WHERE id=? LIMIT 1 FOR UPDATE`,
        [job.global_run_id],
      );
      const run = openRows[0]?.[0] || null;
      const canRetry = run && run.status === "active" && Number(run.extension_deadline_at_ms || run.request_deadline_at_ms) > Date.now();
      await tx.query(
        `UPDATE global_disbursement_runs
         SET admin_bonus_committed_initial_asset=GREATEST(0,admin_bonus_committed_initial_asset-?),
             total_requested_initial_asset=GREATEST(0,total_requested_initial_asset-?),updated_at_ms=?
         WHERE id=?`,
        [String(job.bonus_initial_asset || "0"), String(job.gross_initial_asset), failedAt, job.global_run_id],
      );
      await tx.query(
        `UPDATE global_disbursement_participants
         SET requested_initial_asset=GREATEST(0,requested_initial_asset-?),
             remaining_initial_asset=?,status=?,updated_at_ms=?
         WHERE run_id=? AND username=?`,
        [String(job.gross_initial_asset), restoredBalance.toFixed(30), canRetry ? "awaiting_request" : "manual_review",
          failedAt, job.global_run_id, username],
      );
    }
    await queueTelegramMessageTx(tx, username, `disbursement:${jobId}:failed`, [
      "OneX Disbursement Update",
      "Your disbursement transaction failed after blockchain finality. Your reserved XTU balance has been restored.",
      `Disbursement ID: ${jobId}`,
      `Reason: ${String(message).slice(0, 500)}`,
      "Status: FAILED - BALANCE RESTORED",
    ].join("\n"));
  });
}

async function finalizeSuccessfulPayout(db, jobId, receipt) {
  return withTransaction(db, async (tx) => {
    const [preRows] = await tx.query(
      "SELECT username FROM users_usdt_disbursements WHERE id=? LIMIT 1",
      [jobId],
    );
    if (preRows.length === 0) throw new Error(`Disbursement ${jobId} does not exist.`);
    const username = preRows[0].username;

    // Serialize global accounting first, then lock account and stock rows in request-path order.
    const [commonLockRows] = await tx.query(
      "SELECT lock_name FROM system_locks WHERE lock_name='common_state' FOR UPDATE",
    );
    if (!commonLockRows.length) throw new Error("The common-state lock row is missing.");
    const common = await getLatestCommonTx(tx, true);

    const [authRows] = await tx.query(
      "SELECT username FROM auths WHERE username=? LIMIT 1 FOR UPDATE",
      [username],
    );
    const [userStockRows] = await tx.query(
      "SELECT balance FROM users_stock WHERE username=? LIMIT 1 FOR UPDATE",
      [username],
    );
    const [jobRows] = await tx.query(
      "SELECT * FROM users_usdt_disbursements WHERE id=? LIMIT 1 FOR UPDATE",
      [jobId],
    );
    if (jobRows.length === 0) throw new Error(`Disbursement ${jobId} disappeared.`);
    const job = jobRows[0];
    if (job.status === "confirmed") return { confirmed: true };
    const actualFee = await recordActualBscFeeTx(tx, {
      txHash: job.tx_hash,
      operation: "system_disbursement",
      receipt,
    });
    await tx.query(
      "UPDATE users_usdt_disbursements SET actual_fee_bnb=?,actual_fee_usd=? WHERE id=?",
      [actualFee.feeBnb.toFixed(30), actualFee.feeUsd.toFixed(18), jobId],
    );

    if (!authRows.length || !userStockRows.length) {
      const reviewReason = "The payout was confirmed on-chain, but the OneX account or stock row is missing.";
      await tx.query(
        `UPDATE users_usdt_disbursements SET status='manual_review',last_error=?,updated_at_ms=? WHERE id=?`,
        [reviewReason, String(Date.now()), jobId],
      );
      await queueTelegramMessageTx(tx, username, `disbursement:${jobId}:manual_review`, [
        "OneX Disbursement Update",
        "Your BSC-USD payout was confirmed, but OneX accounting requires manual review.",
        `Disbursement ID: ${jobId}`,
        `Reason: ${reviewReason}`,
        "Status: MANUAL REVIEW",
      ].join("\n"));
      return { manualReview: true };
    }

    const userBalanceInitial = new BigNumber(userStockRows[0].balance);
    const expectedReservedBalance = new BigNumber(job.balance_after_reservation || "0");
    if (!userBalanceInitial.isFinite() || !userBalanceInitial.eq(expectedReservedBalance)) {
      const reviewReason = "The payout was confirmed on-chain, but the user's remaining balance changed before accounting finalization.";
      await tx.query(
        `UPDATE users_usdt_disbursements SET status='manual_review',last_error=?,updated_at_ms=? WHERE id=?`,
        [reviewReason, String(Date.now()), jobId],
      );
      await queueTelegramMessageTx(tx, username, `disbursement:${jobId}:manual_review`, [
        "OneX Disbursement Update",
        "Your BSC-USD payout was confirmed, but OneX accounting requires manual review.",
        `Disbursement ID: ${jobId}`,
        `Reason: ${reviewReason}`,
        "Status: MANUAL REVIEW",
      ].join("\n"));
      return { manualReview: true };
    }

    const [systemRows] = await tx.query(
      "SELECT balance FROM users_stock WHERE username='ONEX' LIMIT 1 FOR UPDATE",
    );
    if (systemRows.length === 0) throw new Error("The OneX system stock row is missing.");

    const total = new BigNumber(common.total_units_price);
    const unitPrice = new BigNumber(common.unit_price);
    const backed = new BigNumber(common.backed_units);
    const inactive = new BigNumber(common.inactive_init_asset);
    const payoutAmount = new BigNumber(job.payout_amount);
    // Every treasury transfer consumes both the BSC-USD sent to the recipient
    // and the actual BNB gas paid for the transaction. For individual and global
    // disbursements, the estimated BSC-USD gas cost is deducted from the payout
    // before signing; the confirmed receipt cost is reconciled in common reserves.
    const reserveExpenseAmount = payoutAmount.plus(actualFee.feeUsd);
    const soldInitialAssets = new BigNumber(job.sold_initial_asset);
    const grossInitialAsset = new BigNumber(job.gross_initial_asset);
    const priceValue = new BigNumber(job.price_value);
    const feeInitialAssets = new BigNumber(job.fee_initial_asset);
    const grossBalance = grossInitialAsset.multipliedBy(priceValue);
    const isGlobalDisbursement = job.disbursement_mode === "global";
    const bscFeeRecovered = new BigNumber(job.bsc_fee_recovered_usd || "0");
    const bonusAmount = new BigNumber(job.bonus_amount || "0");
    const bonusInitialAssets = new BigNumber(job.bonus_initial_asset || "0");
    const expectedPayoutAmount = soldInitialAssets.multipliedBy(priceValue)
      .plus(bonusAmount).minus(bscFeeRecovered)
      .decimalPlaces(18, BigNumber.ROUND_DOWN);
    const expectedFeeAmount = feeInitialAssets.multipliedBy(priceValue)
      .decimalPlaces(18, BigNumber.ROUND_DOWN);
    const actualBscFeeUsd = new BigNumber(actualFee.feeUsd);
    const tfeesCoveredBscUsd = new BigNumber(0);
    const tfeesUncoveredBscUsd = new BigNumber(0);
    const lockedAmountsTolerance = new BigNumber("0.000000000000000001");
    const grossInitialAssetMismatch = grossInitialAsset.minus(soldInitialAssets.plus(feeInitialAssets)).abs();
    const payoutAmountMismatch = payoutAmount.minus(expectedPayoutAmount).abs();
    const feeAmountMismatch = new BigNumber(job.fee_amount).minus(expectedFeeAmount).abs();

    if (
      !total.isFinite() || !total.isGreaterThanOrEqualTo(reserveExpenseAmount) ||
      !unitPrice.isFinite() || !unitPrice.isGreaterThan(0) ||
      !backed.isFinite() || backed.isNegative() ||
      !inactive.isFinite() || inactive.isNegative() ||
      !payoutAmount.isFinite() || !payoutAmount.isGreaterThan(0) ||
      !soldInitialAssets.isFinite() || !soldInitialAssets.isGreaterThan(0) ||
      !grossInitialAsset.isFinite() || !grossInitialAsset.isGreaterThan(0) ||
      !grossBalance.isFinite() || !grossBalance.isGreaterThan(0) ||
      !priceValue.isFinite() || !priceValue.isGreaterThan(0) ||
      !feeInitialAssets.isFinite() || feeInitialAssets.isNegative() ||
      !bscFeeRecovered.isFinite() || bscFeeRecovered.isNegative() ||
      !bonusAmount.isFinite() || bonusAmount.isNegative() ||
      !bonusInitialAssets.isFinite() || bonusInitialAssets.isNegative() ||
      !actualBscFeeUsd.isFinite() || actualBscFeeUsd.isNegative() ||
      (!isGlobalDisbursement && (!bonusAmount.isZero() || !bonusInitialAssets.isZero())) ||
      new BigNumber(job.bsc_fee_recovered_usd || "0").isNegative() ||
      !new BigNumber(job.fee_amount).isFinite() || new BigNumber(job.fee_amount).isNegative() ||
      grossInitialAssetMismatch.gt(lockedAmountsTolerance) ||
      payoutAmountMismatch.gt(lockedAmountsTolerance) ||
      feeAmountMismatch.gt(lockedAmountsTolerance)
    ) {
      await tx.query(
        `UPDATE users_usdt_disbursements SET status='manual_review',last_error=?,updated_at_ms=? WHERE id=?`,
        ["The payout was confirmed on-chain, but the common reserve values are inconsistent.", String(Date.now()), jobId],
      );
      return { manualReview: true };
    }

    const systemBalanceInitial = new BigNumber(systemRows[0].balance);
    const newSystemBalanceInitial = systemBalanceInitial.plus(grossInitialAsset);
    const reserveSettlement = calculateDisbursementReserveSettlement(
      total,
      backed,
      inactive,
      {
        payoutAmount,
        reserveExpenseAmount,
        soldInitialAsset: soldInitialAssets,
        feeInitialAsset: feeInitialAssets,
        feeValueXtu: feeInitialAssets.multipliedBy(unitPrice),
        bonusInitialAsset: isGlobalDisbursement ? bonusInitialAssets : new BigNumber(0),
      },
      common.admin_expens || "0",
      unitPrice,
    );
    if (isGlobalDisbursement) {
      const remainingAdminReserve = calculateRemainingAdministrativeBacking(
        INITIAL_STOCK_LIMIT,
        SYSTEM_ADMIN_RESERVE_RATIO,
        common.admin_expens || "0",
      ).remainingInitialAsset;
      if (bonusInitialAssets.gt(remainingAdminReserve)) {
        throw new Error("Global bonus exceeds the remaining protected administrative reserve");
      }
    }
    const newTotal = reserveSettlement.newTotalUnitsPrice;
    const newInactive = reserveSettlement.newInactiveInitAsset;
    const newBacked = reserveSettlement.newBackedUnits;
    if (
      !systemBalanceInitial.isFinite() || systemBalanceInitial.isNegative() ||
      !newSystemBalanceInitial.isFinite() || newSystemBalanceInitial.isNegative() ||
      !newTotal.isFinite() || newTotal.isNegative() ||
      !newInactive.isFinite() || newInactive.isNegative() ||
      !newBacked.isFinite() || newBacked.isNegative()
    ) {
      throw new Error("Invalid accounting values while finalizing a disbursement.");
    }

    const [date, time] = getDate();
    await tx.query(
      "UPDATE users_stock SET balance=?,record_date=?,record_time=? WHERE username='ONEX'",
      [newSystemBalanceInitial.toFixed(30), date, time],
    );
    const totalTfees = new BigNumber(common.total_tfees || "0").plus(feeInitialAssets);
    const totalTfeesBscCost = new BigNumber(common.total_tfees_bsc_cost_usd || "0").plus(tfeesCoveredBscUsd);
    const totalTfeesBscUncovered = new BigNumber(common.total_tfees_bsc_uncovered_usd || "0").plus(tfeesUncoveredBscUsd);
    await insertCommonSnapshotTx(tx, common, {
      total_units_price: newTotal.toFixed(),
      backed_units: newBacked.toFixed(),
      inactive_init_asset: newInactive.toFixed(),
      sys_inactive_init_asset: reserveSettlement.newSysInactiveInitAsset.toFixed(),
      total_tfees: totalTfees.toFixed(),
      total_tfees_bsc_cost_usd: totalTfeesBscCost.toFixed(),
      total_tfees_bsc_uncovered_usd: totalTfeesBscUncovered.toFixed(),
    }, date, time);

    const [existingActivityRows] = await tx.query(
      "SELECT id FROM activities WHERE reference=? LIMIT 1",
      [job.reference],
    );
    if (existingActivityRows.length === 0) {
      await tx.query(
        `INSERT INTO activities(sender,receiver,type,amount,unit_price,fees,fee_unit_price,bsc_fee_cost_usd,reference,record_date,record_time)
         VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
        [username, "ONEX", 3, soldInitialAssets.toFixed(), priceValue.toFixed(), feeInitialAssets.toFixed(), unitPrice.toFixed(), actualBscFeeUsd.toFixed(18), job.reference, date, time],
      );
    }

    const confirmedAt = String(Date.now());
    await tx.query(
      `UPDATE users_usdt_disbursements
       SET status='confirmed',block_number=?,last_error=NULL,confirmed_at_ms=?,updated_at_ms=?
       WHERE id=?`,
      [String(receipt.blockNumber), confirmedAt, confirmedAt, jobId],
    );
    if (job.disbursement_mode === "individual") {
      const principalBefore = new BigNumber(job.balance_after_reservation || "0").plus(grossInitialAsset);
      await recordUserOperationTx(
        tx, username, "sale", grossInitialAsset, principalBefore,
        new BigNumber(job.balance_after_reservation || "0"), reserveSettlement.newUnitPrice,
        job.tfees_rate_percent || (grossInitialAsset.isGreaterThan(0)
          ? feeInitialAssets.multipliedBy(100).dividedBy(grossInitialAsset)
          : 0), job.reference,
      );
      await triggerUserPriceThresholdTx(
        tx, username, reserveSettlement.newUnitPrice, null,
        new BigNumber(job.balance_after_reservation || "0"),
      );
    }

    if (job.disbursement_mode === "global" && job.global_run_id != null) {
      const [globalRows] = await tx.query(
        "SELECT status,request_deadline_at_ms,extension_deadline_at_ms FROM global_disbursement_runs WHERE id=? LIMIT 1 FOR UPDATE",
        [job.global_run_id],
      );
      const globalRun = globalRows[0] || null;
      if (!globalRun) throw new Error("The global disbursement run for this confirmed payment is missing.");
      const remainingInitial = new BigNumber(job.balance_after_reservation || "0");
      const participantStatus = remainingInitial.isZero()
        ? "paid"
        : (globalRun.status === "active" && Number(globalRun.extension_deadline_at_ms || globalRun.request_deadline_at_ms) > Date.now()
          ? "awaiting_request" : "manual_review");
      await tx.query(
        `UPDATE global_disbursement_participants
         SET paid_initial_asset=paid_initial_asset+?,remaining_initial_asset=?,status=?,updated_at_ms=?
         WHERE run_id=? AND username=? AND status<>'resolved'`,
        [String(job.gross_initial_asset), remainingInitial.toFixed(30), participantStatus,
          confirmedAt, job.global_run_id, username],
      );
      await tx.query(
        `UPDATE global_disbursement_runs
         SET total_paid_bsc_usd=total_paid_bsc_usd+?,
             total_bonus_paid_bsc_usd=total_bonus_paid_bsc_usd+?,
             total_bonus_paid_initial_asset=total_bonus_paid_initial_asset+?,
             total_bsc_gas_actual_usd=total_bsc_gas_actual_usd+?,
             updated_at_ms=?
         WHERE id=? AND status IN ('active','closed','manual_review')`,
        [payoutAmount.toFixed(18), bonusAmount.toFixed(18), bonusInitialAssets.toFixed(30), actualFee.feeUsd.toFixed(18), confirmedAt, job.global_run_id],
      );
    }
    await queueTelegramMessageTx(tx, username, `disbursement:${jobId}:confirmed`, [
      "OneX Disbursement Update",
      "Your sale to OneX has been completed and the BSC-USD payment is confirmed.",
      `Actual BSC gas cost: ${actualFee.feeBnb.toFixed(8)} BNB (${actualFee.feeUsd.toFixed(8)} BSC-USD).`,
      `Gross amount: ${grossBalance.toFixed(8)} XTU`,
      `System tfees deducted from the gross sale: ${feeInitialAssets.multipliedBy(priceValue).toFixed(8)} XTU`,
      `BSC network fee recovered from your payout: ${bscFeeRecovered.toFixed(8)} BSC-USD`,
      ...(isGlobalDisbursement ? [`Automatic global bonus: ${bonusAmount.toFixed(8)} BSC-USD`] : []),
      `Valuation price locked at request submission: ${priceValue.toFixed(12)} XTU per initial asset`,
      `Amount paid: ${payoutAmount.toFixed(8)} BSC-USD`,
      `Destination: ${job.payout_address}`,
      `Transaction: ${job.tx_hash}`,
      "Status: CONFIRMED",
    ].join("\n"));
    return { confirmed: true };
  });
}

function receiptConfirmsExpectedTransfer(receipt, job, activeRuntime) {
  const expectedAmount = BigInt(job.amount_raw);
  const expectedTo = String(job.payout_address).toLowerCase();
  const expectedFrom = activeRuntime.treasuryAddress.toLowerCase();
  const expectedContract = activeRuntime.tokenAddress.toLowerCase();

  for (const log of receipt.logs || []) {
    if (String(log.address || "").toLowerCase() !== expectedContract) continue;
    try {
      const parsed = TRANSFER_EVENT_INTERFACE.parseLog({
        topics: log.topics,
        data: log.data,
      });
      if (
        parsed &&
        String(parsed.args.from).toLowerCase() === expectedFrom &&
        String(parsed.args.to).toLowerCase() === expectedTo &&
        BigInt(parsed.args.value) === expectedAmount
      ) {
        return true;
      }
    } catch {
      // Ignore unrelated or malformed logs from the same transaction.
    }
  }
  return false;
}

async function processOneJob(db, job, activeRuntime) {
  if (job.status === "queued") {
    try {
      await signQueuedJob(db, job, activeRuntime);
    } catch (error) {
      const message = String(error?.message || error);
      if (job.disbursement_mode === "global" && /too small to cover the estimated BSC network fee|rounds to zero after BSC gas recovery/i.test(message)) {
        await markManualReview(db, job.id, `${message} The reserved request remains pending for administrative resolution.`);
      } else {
        await updateJobError(db, job.id, error);
      }
      return;
    }
    const freshRows = await db.queryAsync(
      "SELECT * FROM users_usdt_disbursements WHERE id=? LIMIT 1",
      [job.id],
    );
    if (freshRows.length === 0) {
      throw new Error(`Disbursement ${job.id} disappeared after signing.`);
    }
    job = freshRows[0];
  }

  if (!job.raw_tx || !job.tx_hash) {
    await updateJobError(db, job.id, new Error("The signed payout transaction is missing."));
    return;
  }

  let receipt = await activeRuntime.provider.getTransactionReceipt(job.tx_hash);
  if (receipt && job.status === "signed") {
    const submittedAt = String(Date.now());
    await db.queryAsync(
      "UPDATE users_usdt_refunds SET status='submitted',last_error=NULL,updated_at_ms=? WHERE id=? AND status='signed'",
      [submittedAt, job.id],
    );
    if (job.user_request_id != null) {
      await withTransaction(db, async (tx) => {
        const [refundRows] = await tx.query(
          "SELECT * FROM users_usdt_refunds WHERE id=? LIMIT 1 FOR UPDATE", [job.id],
        );
        if (!refundRows.length) return;
        await synchronizeUserRefundRequestTx(tx, refundRows[0], submittedAt);
      });
    }
    job = { ...job, status: "submitted" };
  }
  if (!receipt) {
    const knownTransaction = await activeRuntime.provider.getTransaction(job.tx_hash);
    if (!knownTransaction) {
      try {
        const broadcast = await activeRuntime.provider.broadcastTransaction(job.raw_tx);
        if (broadcast.hash.toLowerCase() !== job.tx_hash.toLowerCase()) {
          throw new Error("The broadcast transaction hash does not match the persisted signed transaction.");
        }
      } catch (error) {
        const afterError = await activeRuntime.provider.getTransaction(job.tx_hash);
        if (!afterError) {
          await updateJobError(db, job.id, error);
          return;
        }
      }
    }
    await markSubmitted(db, job.id, job.tx_hash);
    receipt = await activeRuntime.provider.getTransactionReceipt(job.tx_hash);
    if (!receipt) return;
  }

  if (Number(receipt.status) !== 1) {
    const failedCanonicalBlock = await activeRuntime.provider.getBlock(receipt.blockNumber);
    if (
      !failedCanonicalBlock ||
      String(failedCanonicalBlock.hash || "").toLowerCase() !== String(receipt.blockHash || "").toLowerCase()
    ) {
      await markSubmitted(db, job.id, job.tx_hash);
      return;
    }
    const failedLatestBlock = await activeRuntime.provider.getBlockNumber();
    const failedConfirmations = failedLatestBlock - Number(receipt.blockNumber) + 1;
    if (failedConfirmations < activeRuntime.confirmations) {
      await markSubmitted(db, job.id, job.tx_hash);
      return;
    }
    await restoreUserBalanceAfterFailedPayout(
      db,
      job.id,
      "The BSC-USD transfer transaction was mined, remained canonical and failed after the configured finality depth.",
      receipt,
    );
    return;
  }

  if (!receiptConfirmsExpectedTransfer(receipt, job, activeRuntime)) {
    await markManualReview(
      db,
      job.id,
      "The transaction succeeded on-chain but its receipt does not contain the expected BSC-USD Transfer event.",
      receipt,
    );
    return;
  }

  const canonicalBlock = await activeRuntime.provider.getBlock(receipt.blockNumber);
  if (
    !canonicalBlock ||
    String(canonicalBlock.hash || "").toLowerCase() !== String(receipt.blockHash || "").toLowerCase()
  ) {
    await markSubmitted(db, job.id, job.tx_hash);
    return;
  }

  const latestBlock = await activeRuntime.provider.getBlockNumber();
  const confirmations = latestBlock - Number(receipt.blockNumber) + 1;
  if (confirmations < activeRuntime.confirmations) {
    await markSubmitted(db, job.id, job.tx_hash);
    return;
  }

  await finalizeSuccessfulPayout(db, job.id, receipt);
}


async function signQueuedSellerPayout(db, job, activeRuntime) {
  const payoutAddress = requiredAddress(job.payout_address, "Seller payout address");
  if (payoutAddress.toLowerCase() === activeRuntime.treasuryAddress.toLowerCase()) {
    throw new Error("A seller payout cannot be sent to the OneX treasury address.");
  }
  const gross = new BigNumber(job.gross_amount);
  if (!gross.isFinite() || !gross.isGreaterThan(0)) throw new Error("Invalid seller payout gross amount.");

  const bnbUsdPrice = getConfiguredBnbUsdPrice();
  if (!bnbUsdPrice.isGreaterThan(0)) {
    throw new Error("A fresh Chainlink BNB/USD price is required to recover the seller's BSC gas cost.");
  }
  const { tokenBalanceRaw } = await getHotWalletFinalizedTokenBalance({
    queryable: db,
    provider: activeRuntime.provider,
    tokenContract: activeRuntime.token,
    walletAddress: activeRuntime.treasuryAddress,
  });
  const spendableTokenBalance = await getHotWalletSpendableTokenRaw(tokenBalanceRaw, job.gross_amount, db);
  const payout = await estimateNetBscTokenTransfer({
    provider: activeRuntime.provider,
    fromAddress: activeRuntime.treasuryAddress,
    tokenAddress: activeRuntime.tokenAddress,
    payoutAddress,
    grossAmount: gross,
    tokenBalanceRaw: spendableTokenBalance,
    maximumGasLimit: activeRuntime.gasLimit,
    bnbUsdPrice,
  });
  const { payoutAmount, amountRaw, data, estimate: finalEstimate } = payout;
  const minimumSellerNetPayout = getMinimumOutgoingNetBscUsd();
  if (!payoutAmount.isGreaterThanOrEqualTo(minimumSellerNetPayout) || amountRaw <= 0n || !data) {
    throw new Error(`Seller payout net amount must be at least ${minimumSellerNetPayout.toFixed(18)} BSC-USD after BSC gas recovery.`);
  }
  const nativeBalance = await activeRuntime.provider.getBalance(activeRuntime.treasuryAddress);
  if (nativeBalance < finalEstimate.gasLimit * finalEstimate.gasPrice) {
    throw new Error("The Hot Wallet has insufficient BNB for the seller payout gas.");
  }

  const nonce = await activeRuntime.provider.getTransactionCount(activeRuntime.treasuryAddress, "pending");
  const rawTransaction = await activeRuntime.signer.signTransaction({
    type: 0,
    chainId: Number(CHAIN_ID),
    nonce,
    to: activeRuntime.tokenAddress,
    value: 0n,
    data,
    gasLimit: finalEstimate.gasLimit,
    gasPrice: finalEstimate.gasPrice,
  });
  const transactionHash = keccak256(rawTransaction);
  const update = await db.queryAsync(
    `UPDATE users_usdt_seller_payouts
     SET raw_tx=?,tx_hash=?,nonce=?,gas_fee_estimated=?,payout_amount=?,amount_raw=?,bnb_usd_price=?,
         status='signed',last_error=NULL,updated_at_ms=?
     WHERE id=? AND status='queued' AND raw_tx IS NULL AND tx_hash IS NULL`,
    [
      rawTransaction,
      transactionHash,
      String(nonce),
      finalEstimate.feeUsd.toFixed(18),
      payoutAmount.toFixed(18),
      amountRaw.toString(),
      bnbUsdPrice.toFixed(12),
      String(Date.now()),
      job.id,
    ],
  );
  if (update.affectedRows !== 1) return false;

  await withTransaction(db, async (tx) => {
    await recordEstimatedBscFeeTx(tx, {
      txHash: transactionHash,
      operation: "seller_payout",
      gasLimit: finalEstimate.gasLimit.toString(),
      gasPriceWei: finalEstimate.gasPrice.toString(),
      bnbUsdPrice,
    });
  });
  return true;
}

async function finalizeSellerPayout(db, jobId, receipt, activeRuntime) {
  return withTransaction(db, async (tx) => {
    const [payoutRows] = await tx.query(
      "SELECT * FROM users_usdt_seller_payouts WHERE id=? LIMIT 1 FOR UPDATE",
      [jobId],
    );
    if (!payoutRows.length) throw new Error(`Seller payout ${jobId} does not exist.`);
    const payout = payoutRows[0];
    if (payout.status === "confirmed") return { confirmed: true };

    const actualFee = await recordActualBscFeeTx(tx, {
      txHash: payout.tx_hash,
      operation: "seller_payout",
      receipt,
    });

    if (Number(receipt.status) !== 1 || !receiptConfirmsExpectedTransfer(receipt, {
      amount_raw: payout.amount_raw,
      payout_address: payout.payout_address,
    }, activeRuntime)) {
      const reason = Number(receipt.status) !== 1
        ? "The seller payout transaction was finalized but reverted on BNB Smart Chain."
        : "The seller payout transaction succeeded but did not contain the expected BSC-USD Transfer event.";
      await tx.query(
        "UPDATE users_usdt_seller_payouts SET status='manual_review',last_error=?,block_number=?,updated_at_ms=? WHERE id=?",
        [reason, String(receipt.blockNumber), String(Date.now()), jobId],
      );
      await tx.query(
        "UPDATE users_usdt_seller_payout_batches SET status='manual_review',updated_at_ms=? WHERE id=?",
        [String(Date.now()), payout.batch_id],
      );
      await queueTelegramMessageTx(tx, payout.username, `seller-payout:${jobId}:manual_review`, [
        "OneX Seller Update",
        "Your seller payout requires a support review after the BSC transaction reached finality.",
        `Payout ID: ${jobId}`,
        `Actual BSC gas cost: ${actualFee.feeBnb.toFixed(8)} BNB (${actualFee.feeUsd.toFixed(8)} BSC-USD)`,
        `Reason: ${reason}`,
        "The reserved seller amount remains pending and has not been marked as paid.",
        "Status: MANUAL REVIEW",
      ].join("\n"));
      return { manualReview: true };
    }

    const [allocations] = await tx.query(
      `SELECT a.id,a.lot_id,a.initial_asset_amount,l.payout_pending_initial_asset,
              l.payout_reserved_initial_asset,l.paid_initial_asset
       FROM users_seller_payout_allocations a
       JOIN users_seller_reserve_lots l ON l.id=a.lot_id
       WHERE a.payout_id=? AND a.status='reserved'
       ORDER BY l.activated_at_ms ASC,l.id ASC
       FOR UPDATE`,
      [jobId],
    );
    if (!allocations.length) throw new Error(`Seller payout ${jobId} has no reserved lot allocations.`);
    for (const allocation of allocations) {
      const amount = new BigNumber(allocation.initial_asset_amount);
      const pending = new BigNumber(allocation.payout_pending_initial_asset);
      const reserved = new BigNumber(allocation.payout_reserved_initial_asset);
      const paid = new BigNumber(allocation.paid_initial_asset);
      if (
        !amount.isFinite() || !amount.isGreaterThan(0) ||
        pending.isLessThan(amount) || reserved.isLessThan(amount)
      ) {
        throw new Error(`Seller payout allocation ${allocation.id} exceeds its lot liability.`);
      }
      await tx.query(
        `UPDATE users_seller_reserve_lots
         SET payout_pending_initial_asset=?,payout_reserved_initial_asset=?,paid_initial_asset=?,updated_at_ms=? WHERE id=?`,
        [pending.minus(amount).toFixed(), reserved.minus(amount).toFixed(), paid.plus(amount).toFixed(), String(Date.now()), allocation.lot_id],
      );
      await tx.query(
        "UPDATE users_seller_payout_allocations SET status='paid' WHERE id=? AND status='reserved'",
        [allocation.id],
      );
    }

    const now = String(Date.now());
    await tx.query(
      `UPDATE users_usdt_seller_payouts
       SET status='confirmed',block_number=?,actual_fee_bnb=?,actual_fee_usd=?,last_error=NULL,confirmed_at_ms=?,updated_at_ms=?
       WHERE id=?`,
      [String(receipt.blockNumber), actualFee.feeBnb.toFixed(30), actualFee.feeUsd.toFixed(18), now, now, jobId],
    );
    const [openRows] = await tx.query(
      "SELECT id FROM users_usdt_seller_payouts WHERE batch_id=? AND status<>'confirmed' LIMIT 1 FOR UPDATE",
      [payout.batch_id],
    );
    if (!openRows.length) {
      await tx.query(
        "UPDATE users_usdt_seller_payout_batches SET status='completed',completed_at_ms=?,updated_at_ms=? WHERE id=?",
        [now, now, payout.batch_id],
      );
    } else {
      await tx.query(
        "UPDATE users_usdt_seller_payout_batches SET status='processing',updated_at_ms=? WHERE id=?",
        [now, payout.batch_id],
      );
    }
    await queueTelegramMessageTx(tx, payout.username, `seller-payout:${jobId}:confirmed`, [
      "OneX Seller Update",
      "Your seller reserve payout has been transferred successfully.",
      `Gross amount: ${new BigNumber(payout.gross_amount).toFixed(8)} BSC-USD`,
      `BSC gas recovery: ${new BigNumber(payout.gas_fee_estimated).toFixed(8)} BSC-USD`,
      `Net amount paid: ${new BigNumber(payout.payout_amount).toFixed(8)} BSC-USD`,
      `Actual gas cost: ${actualFee.feeBnb.toFixed(8)} BNB (${actualFee.feeUsd.toFixed(8)} BSC-USD)`,
      `Destination: ${payout.payout_address}`,
      `Transaction: ${payout.tx_hash}`,
      `Payout ID: ${jobId}`,
      "Status: CONFIRMED",
    ].join("\n"));
    return { confirmed: true };
  });
}

async function processOneSellerPayout(db, job, activeRuntime) {
  if (job.status === "queued") {
    try {
      await signQueuedSellerPayout(db, job, activeRuntime);
    } catch (error) {
      await db.queryAsync(
        "UPDATE users_usdt_seller_payouts SET last_error=?,updated_at_ms=? WHERE id=? AND status='queued'",
        [String(error.message || error).slice(0, 2000), String(Date.now()), job.id],
      );
      return;
    }
    const freshRows = await db.queryAsync("SELECT * FROM users_usdt_seller_payouts WHERE id=? LIMIT 1", [job.id]);
    if (!freshRows.length) return;
    job = freshRows[0];
  }
  if (!job.raw_tx || !job.tx_hash) return;

  let receipt = await activeRuntime.provider.getTransactionReceipt(job.tx_hash);
  if (!receipt) {
    const known = await activeRuntime.provider.getTransaction(job.tx_hash);
    if (!known) {
      try {
        const broadcast = await activeRuntime.provider.broadcastTransaction(job.raw_tx);
        if (broadcast.hash.toLowerCase() !== job.tx_hash.toLowerCase()) {
          throw new Error("Seller payout broadcast hash differs from the persisted transaction hash.");
        }
      } catch (error) {
        const afterError = await activeRuntime.provider.getTransaction(job.tx_hash);
        if (!afterError) {
          await db.queryAsync(
            "UPDATE users_usdt_seller_payouts SET last_error=?,updated_at_ms=? WHERE id=? AND status IN ('signed','submitted')",
            [String(error.message || error).slice(0, 2000), String(Date.now()), job.id],
          );
          return;
        }
      }
    }
    await db.queryAsync(
      "UPDATE users_usdt_seller_payouts SET status='submitted',last_error=NULL,updated_at_ms=? WHERE id=? AND status IN ('signed','submitted')",
      [String(Date.now()), job.id],
    );
    receipt = await activeRuntime.provider.getTransactionReceipt(job.tx_hash);
    if (!receipt) return;
  }
  const canonicalBlock = await activeRuntime.provider.getBlock(receipt.blockNumber);
  const latestBlock = await activeRuntime.provider.getBlockNumber();
  const confirmations = latestBlock - Number(receipt.blockNumber) + 1;
  if (!canonicalBlock || String(canonicalBlock.hash || "").toLowerCase() !== String(receipt.blockHash || "").toLowerCase() || confirmations < activeRuntime.confirmations) {
    return;
  }
  await finalizeSellerPayout(db, job.id, receipt, activeRuntime);
}

async function markRefundError(db, refundId, error) {
  const message = String(error?.message || error || "Unknown refund error").slice(0, 2000);
  const now = String(Date.now());
  await db.queryAsync(
    `UPDATE users_usdt_refunds
     SET last_error=?,updated_at_ms=?
     WHERE id=? AND status IN ('queued','signed','submitted')`,
    [message, now, refundId],
  );
  await db.queryAsync(
    `UPDATE user_usdt_refund_requests r
     JOIN users_usdt_refunds f ON f.user_request_id=r.id
     SET r.last_error=?,r.updated_at_ms=?
     WHERE f.id=? AND r.status IN ('approved_queued','signed','submitted')`,
    [message, now, refundId],
  );
}

async function transitionUserRefundRequestTx(tx, refund, {
  newStatus,
  eventType,
  reason = null,
  txHash = null,
  feeAmount = "0",
  netAmount = "0",
  createdAtMs = String(Date.now()),
}) {
  if (refund.user_request_id == null) return false;
  const [requestRows] = await tx.query(
    "SELECT id,status FROM user_usdt_refund_requests WHERE id=? LIMIT 1 FOR UPDATE",
    [refund.user_request_id],
  );
  if (!requestRows.length) throw new Error(`Refund request ${refund.user_request_id} is missing.`);
  const request = requestRows[0];
  const transitions = {
    signed: ["approved_queued", "signed"],
    submitted: ["approved_queued", "signed", "submitted"],
    completed: ["approved_queued", "signed", "submitted", "manual_review"],
    failed: ["approved_queued", "signed", "submitted", "manual_review"],
    manual_review: ["approved_queued", "signed", "submitted", "manual_review"],
  };
  if (String(request.status) === String(newStatus)) return false;
  if (!(transitions[newStatus] || []).includes(String(request.status))) return false;
  const terminal = ["completed", "failed"].includes(newStatus);
  await tx.query(
    `UPDATE user_usdt_refund_requests
     SET status=?,last_error=?,updated_at_ms=?,
         completed_at_ms=CASE WHEN ?='completed' THEN ? ELSE completed_at_ms END,
         failed_at_ms=CASE WHEN ?='failed' THEN ? ELSE failed_at_ms END,
         resolved_at_ms=CASE WHEN ? IN ('completed','failed') THEN ? ELSE resolved_at_ms END
     WHERE id=?`,
    [newStatus, newStatus === "failed" || newStatus === "manual_review" ? reason : null,
      createdAtMs, newStatus, createdAtMs, newStatus, createdAtMs, newStatus, createdAtMs, refund.user_request_id],
  );
  await recordRefundRequestEventTx(tx, {
    requestId: refund.user_request_id,
    refundId: refund.id,
    eventKey: `refund:${refund.id}:${newStatus}`,
    eventType: eventType || newStatus,
    actorType: "system",
    oldStatus: request.status,
    newStatus,
    reason,
    txHash,
    grossAmount: String(refund.gross_amount || refund.amount || "0"),
    feeAmount,
    netAmount,
    createdAtMs,
  });
  return true;
}

async function synchronizeUserRefundRequestTx(tx, refund, createdAtMs = String(Date.now())) {
  if (refund.user_request_id == null) return false;

  if (refund.status === "signed") {
    await transitionUserRefundRequestTx(tx, refund, {
      newStatus: "signed",
      eventType: "transaction_signed_recovered",
      reason: "The worker recovered the persisted signed refund transaction after an interruption.",
      txHash: refund.tx_hash,
      feeAmount: String(refund.fee_amount || "0"),
      netAmount: String(refund.amount || "0"),
      createdAtMs,
    });
    await tx.query(
      `UPDATE admin_payment_resolutions SET action='refund_signed',tx_hash=?,fee_amount=?,net_amount=?
       WHERE refund_id=? AND action IN ('refund_queued','refund_signed')`,
      [refund.tx_hash, String(refund.fee_amount || "0"), String(refund.amount || "0"), refund.id],
    );
    return true;
  }

  if (refund.status === "submitted") {
    // Recover a missing intermediate audit event if the process stopped
    // between persisting the signed transaction and persisting its submission.
    await transitionUserRefundRequestTx(tx, refund, {
      newStatus: "signed",
      eventType: "transaction_signed_recovered",
      reason: "The worker recovered the signed transaction record after an interruption.",
      txHash: refund.tx_hash,
      feeAmount: String(refund.fee_amount || "0"),
      netAmount: String(refund.amount || "0"),
      createdAtMs,
    });
    await transitionUserRefundRequestTx(tx, refund, {
      newStatus: "submitted",
      eventType: "transaction_submitted_recovered",
      reason: "The worker recovered the submitted refund transaction after an interruption.",
      txHash: refund.tx_hash,
      feeAmount: String(refund.fee_amount || "0"),
      netAmount: String(refund.amount || "0"),
      createdAtMs,
    });
    await tx.query(
      `UPDATE admin_payment_resolutions SET action='refund_submitted',tx_hash=?,fee_amount=?,net_amount=?
       WHERE refund_id=? AND action IN ('refund_queued','refund_signed','refund_submitted')`,
      [refund.tx_hash, String(refund.fee_amount || "0"), String(refund.amount || "0"), refund.id],
    );
    return true;
  }

  return false;
}

async function finalizeRefund(db, refundId, receipt) {
  return withTransaction(db, async (tx) => {
    const [preRows] = await tx.query(
      "SELECT id,batch_id,unknown_transfer_id,user_request_id FROM users_usdt_refunds WHERE id=? LIMIT 1",
      [refundId],
    );
    if (!preRows.length) throw new Error(`Refund ${refundId} does not exist.`);
    if (preRows[0].batch_id != null || preRows[0].unknown_transfer_id == null || preRows[0].user_request_id != null) {
      throw new Error("Only an approved official-token transfer from an unregistered sender address can be refunded.");
    }
    const batchId = preRows[0].batch_id;
    const unknownTransferId = preRows[0].unknown_transfer_id;
    const userRequestId = preRows[0].user_request_id;
    const [requestRows] = userRequestId == null ? [[]] : await tx.query(
      "SELECT id,status FROM user_usdt_refund_requests WHERE id=? LIMIT 1 FOR UPDATE", [userRequestId],
    );
    const [batchRows] = batchId == null ? [[]] : await tx.query(
      "SELECT id,status,reserved_refund_amount,remaining_amount,refunded_amount FROM users_usdt_deposit_batches WHERE id=? LIMIT 1 FOR UPDATE", [batchId],
    );
    const [unknownRows] = unknownTransferId == null ? [[]] : await tx.query(
      "SELECT id,status FROM bsc_unknown_incoming_transfers WHERE id=? LIMIT 1 FOR UPDATE", [unknownTransferId],
    );
    const [refundRows] = await tx.query(
      "SELECT * FROM users_usdt_refunds WHERE id=? LIMIT 1 FOR UPDATE", [refundId],
    );
    if (!refundRows.length) throw new Error(`Refund ${refundId} disappeared.`);
    const refund = refundRows[0];
    if (refund.status === "confirmed") return { confirmed: true };
    if (refund.status !== "submitted" && refund.status !== "signed") {
      return { skipped: true, status: refund.status };
    }
    const actualFee = await recordActualBscFeeTx(tx, {
      txHash: refund.tx_hash,
      operation: "refund",
      receipt,
    });
    await tx.query(
      "UPDATE users_usdt_refunds SET actual_fee_bnb=?,actual_fee_usd=? WHERE id=?",
      [actualFee.feeBnb.toFixed(30), actualFee.feeUsd.toFixed(18), refundId],
    );
    const sourceIsQueued = batchId != null
      ? batchRows.length > 0 && batchRows[0].status === "refund_queued"
      : unknownRows.length > 0 && unknownRows[0].status === "refund_queued";
    const grossAmount = new BigNumber(refund.gross_amount || refund.amount || "0");
    const reservedAmount = batchId == null ? null : new BigNumber(batchRows[0]?.reserved_refund_amount || "0");
    const reservationIsValid = batchId == null || (
      reservedAmount.isFinite() && grossAmount.isFinite() && reservedAmount.gte(grossAmount)
    );
    if (!sourceIsQueued || !reservationIsValid || (userRequestId != null && !requestRows.length)) {
      const reviewReason = "The refund was confirmed on-chain, but its linked deposit/request reservation is inconsistent and requires manual reconciliation.";
      await tx.query(
        "UPDATE users_usdt_refunds SET status='manual_review',last_error=?,updated_at_ms=? WHERE id=?",
        [reviewReason, String(Date.now()), refundId],
      );
      await tx.query(
        "UPDATE admin_payment_resolutions SET action='refund_manual_review',tx_hash=?,reason=? WHERE refund_id=? AND action IN ('refund_queued','refund_signed','refund_submitted')",
        [refund.tx_hash, reviewReason, refundId],
      );
      if (unknownTransferId != null) {
        await tx.query(
          `UPDATE bsc_unknown_refund_requests SET status='manual_review',admin_reason=?,updated_at_ms=?
           WHERE unknown_transfer_id=? AND status IN ('approved','refund_signed','submitted')`,
          [reviewReason, String(Date.now()), String(unknownTransferId)],
        );
      }
      await transitionUserRefundRequestTx(tx, refund, {
        newStatus: "manual_review", eventType: "source_reconciliation_required", reason: reviewReason,
        txHash: refund.tx_hash, feeAmount: String(refund.fee_amount || "0"), netAmount: String(refund.amount || "0"),
      });
      await queueTelegramMessageTx(tx, refund.username, `refund:${refundId}:manual_review`, [
        "OneX Refund Update",
        "Your refund transaction was confirmed on-chain, but the linked deposit/request reservation requires manual reconciliation.",
        `Refund ID: ${refundId}`,
        `Transaction: ${refund.tx_hash}`,
        `Reason: ${reviewReason}`,
        "Status: MANUAL REVIEW",
      ].join("\n"));
      return { manualReview: true };
    }

    const now = String(Date.now());
    await tx.query(
      `UPDATE users_usdt_refunds
       SET status='confirmed',block_number=?,last_error=NULL,confirmed_at_ms=?,updated_at_ms=?
       WHERE id=? AND status IN ('signed','submitted')`,
      [String(receipt.blockNumber), now, now, refundId],
    );
    if (batchId != null) {
      const [batchUpdate] = await tx.query(
        `UPDATE users_usdt_deposit_batches
         SET reserved_refund_amount=reserved_refund_amount-?,
             refunded_amount=refunded_amount+?,status='refunded',updated_at_ms=?
         WHERE id=? AND status='refund_queued' AND reserved_refund_amount>=?`,
        [grossAmount.toFixed(18), grossAmount.toFixed(18), now, batchId, grossAmount.toFixed(18)],
      );
      if (Number(batchUpdate.affectedRows || 0) !== 1) {
        throw new Error("Unable to settle the reserved deposit refund amount after confirmation.");
      }
      await tx.query(
        "UPDATE users_usdt_transfer_events SET status='refunded' WHERE batch_id=?",
        [batchId],
      );
      await tx.query(
        `UPDATE admin_payment_resolutions
         SET action='refund_confirmed',tx_hash=?
         WHERE refund_id=? AND action IN ('refund_queued','refund_signed','refund_submitted')`,
        [refund.tx_hash, refundId],
      );
    } else {
      await tx.query(
        `UPDATE bsc_unknown_incoming_transfers SET status='refunded',updated_at_ms=? WHERE id=? AND status='refund_queued'`,
        [now, unknownTransferId],
      );
      await tx.query(
        `UPDATE admin_payment_resolutions SET action='refund_confirmed',tx_hash=?
         WHERE unknown_transfer_id=? AND (refund_id=? OR refund_id IS NULL) AND action IN ('unknown_refund_queued','refund_queued')`,
        [refund.tx_hash, unknownTransferId, refundId],
      );
      await tx.query(
        `UPDATE bsc_unknown_refund_requests SET status='completed',refund_id=?,completed_at_ms=?,updated_at_ms=?
         WHERE unknown_transfer_id=? AND status IN ('approved','refund_signed','submitted')`,
        [String(refundId), now, now, String(unknownTransferId)],
      );
    }
    await transitionUserRefundRequestTx(tx, refund, {
      newStatus: "completed", eventType: "blockchain_confirmed", reason: "The BSC-USD refund transfer was confirmed on BNB Smart Chain.",
      txHash: refund.tx_hash, feeAmount: String(refund.fee_amount || "0"),
      netAmount: String(refund.amount || "0"), createdAtMs: now,
    });
    await queueTelegramMessageTx(tx, refund.username, `refund:${refundId}:confirmed`, [
      "OneX Refund Update",
      "Your BSC-USD refund has been transferred successfully.",
      `Gross amount: ${grossAmount.toFixed(8)} BSC-USD`,
      `BSC gas recovery: ${new BigNumber(refund.fee_amount || 0).toFixed(8)} BSC-USD`,
      `Net amount: ${new BigNumber(refund.amount).toFixed(8)} BSC-USD`,
      `Actual gas cost: ${actualFee.feeBnb.toFixed(8)} BNB (${actualFee.feeUsd.toFixed(8)} BSC-USD)`,
      `Destination: ${refund.payout_address}`,
      `Transaction: ${refund.tx_hash}`,
      `Refund ID: ${refundId}`,
      "Status: CONFIRMED",
    ].join("\n"));
    return { confirmed: true };
  });
}

async function markRefundManualReview(db, job, reason) {
  return withTransaction(db, async (tx) => {
    const [refundRows] = await tx.query(
      "SELECT id,username,batch_id,unknown_transfer_id,user_request_id,gross_amount,amount,fee_amount,status FROM users_usdt_refunds WHERE id=? LIMIT 1 FOR UPDATE",
      [job.id],
    );
    if (!refundRows.length || refundRows[0].status !== "queued") return;
    const refund = refundRows[0];
    const now = String(Date.now());
    await tx.query(
      "UPDATE users_usdt_refunds SET status='manual_review',last_error=?,updated_at_ms=? WHERE id=? AND status='queued'",
      [String(reason).slice(0, 2000), now, job.id],
    );
    if (refund.batch_id != null) {
      await tx.query(
        "UPDATE users_usdt_deposit_batches SET status='pending_support',updated_at_ms=? WHERE id=? AND status='refund_queued'",
        [now, refund.batch_id],
      );
      await tx.query(
        "UPDATE admin_payment_resolutions SET action='refund_manual_review',reason=? WHERE refund_id=? AND action='refund_queued'",
        [String(reason).slice(0, 1000), job.id],
      );
    } else if (refund.unknown_transfer_id != null) {
      await tx.query(
        `UPDATE bsc_unknown_incoming_transfers SET status='refund_manual_review',updated_at_ms=? WHERE id=?`,
        [now, refund.unknown_transfer_id],
      );
      await tx.query(
        `UPDATE admin_payment_resolutions SET action='refund_manual_review',reason=?
         WHERE unknown_transfer_id=? AND action='unknown_refund_queued'`,
        [String(reason).slice(0, 1000), refund.unknown_transfer_id],
      );
    }
    await transitionUserRefundRequestTx(tx, refund, {
      newStatus: "manual_review", eventType: "manual_review", reason: String(reason).slice(0, 2000), createdAtMs: now,
    });
    await queueTelegramMessageTx(tx, refund.username, `refund:${job.id}:manual_review`, [
      "OneX Refund Update",
      "The refund requires manual review because its net amount would be below the permitted minimum or the payment needs reconciliation.",
      `Refund ID: ${job.id}`,
      `Reason: ${String(reason).slice(0, 500)}`,
      "The reserved deposit remainder remains blocked and has not been counted as refunded.",
      "Status: MANUAL REVIEW",
    ].join("\n"));
  });
}

async function processOneRefundJob(db, job, activeRuntime) {
  if (job.batch_id != null || job.unknown_transfer_id == null || job.user_request_id != null) {
    throw new Error("Known-account deposit refunds are disabled; only registered-token transfers from unregistered sender addresses are eligible.");
  }
  if (job.user_request_id != null && ["signed", "submitted"].includes(String(job.status))) {
    await withTransaction(db, async (tx) => {
      const [refundRows] = await tx.query(
        "SELECT * FROM users_usdt_refunds WHERE id=? LIMIT 1 FOR UPDATE", [job.id],
      );
      if (!refundRows.length) return;
      await synchronizeUserRefundRequestTx(tx, refundRows[0]);
    });
  }

  if (job.status === "queued") {
    const payoutAddress = requiredAddress(job.payout_address, "Refund payout address");
    if (payoutAddress.toLowerCase() === activeRuntime.treasuryAddress.toLowerCase()) {
      throw new Error("Refund destination cannot be the OneX treasury address.");
    }
    const grossAmount = new BigNumber(job.gross_amount || job.amount);
    if (!grossAmount.isFinite() || !grossAmount.isGreaterThan(0)) {
      throw new Error("The refund gross amount must be positive.");
    }
    const { tokenBalanceRaw } = await getHotWalletFinalizedTokenBalance({
      queryable: db,
      provider: activeRuntime.provider,
      tokenContract: activeRuntime.token,
      walletAddress: activeRuntime.treasuryAddress,
    });
    const spendableTokenBalance = await getHotWalletSpendableTokenRaw(tokenBalanceRaw, grossAmount.toFixed(18), db);
    const payout = await estimateNetBscTokenTransfer({
      provider: activeRuntime.provider,
      fromAddress: activeRuntime.treasuryAddress,
      tokenAddress: activeRuntime.tokenAddress,
      payoutAddress,
      grossAmount,
      tokenBalanceRaw: spendableTokenBalance,
      maximumGasLimit: activeRuntime.gasLimit,
      bnbUsdPrice: getConfiguredBnbUsdPrice(),
    });
    const { payoutAmount: finalPayoutAmount, amountRaw: finalAmountRaw, data: signedData, estimate: finalEstimate } = payout;
    if (!finalPayoutAmount.isGreaterThanOrEqualTo(MINIMUM_REFUND_NET_BSC_USD) || finalAmountRaw <= 0n || !signedData) {
      await markRefundManualReview(
        db,
        job,
        `The estimated network-fee deduction would reduce the net refund below ${MINIMUM_REFUND_NET_BSC_USD.toFixed(8)} BSC-USD.`,
      );
      return;
    }
    if (spendableTokenBalance < finalAmountRaw) {
      throw new Error("The Hot Wallet has insufficient unreserved BSC-USD for this refund.");
    }
    const bnbBalance = await activeRuntime.provider.getBalance(activeRuntime.treasuryAddress);
    if (bnbBalance < finalEstimate.gasLimit * finalEstimate.gasPrice) {
      throw new Error("The Hot Wallet has insufficient BNB for the refund transaction gas.");
    }
    const nonce = await activeRuntime.provider.getTransactionCount(activeRuntime.treasuryAddress, "pending");
    const rawTransaction = await activeRuntime.signer.signTransaction({
      type: 0,
      chainId: Number(CHAIN_ID),
      nonce,
      to: activeRuntime.tokenAddress,
      value: 0n,
      data: signedData,
      gasLimit: finalEstimate.gasLimit,
      gasPrice: finalEstimate.gasPrice,
    });
    const transactionHash = keccak256(rawTransaction);
    const update = await db.queryAsync(
      `UPDATE users_usdt_refunds
       SET raw_tx=?,tx_hash=?,nonce=?,status='signed',amount=?,fee_amount=?,amount_raw=?,
           estimated_fee_bnb=?,estimated_fee_usd=?,bnb_usd_price=?,last_error=NULL,updated_at_ms=?
       WHERE id=? AND status='queued' AND raw_tx IS NULL AND tx_hash IS NULL`,
      [
        rawTransaction,
        transactionHash,
        String(nonce),
        finalPayoutAmount.toFixed(18),
        finalEstimate.feeUsd.toFixed(18),
        finalAmountRaw.toString(),
        finalEstimate.feeBnb.toFixed(30),
        finalEstimate.feeUsd.toFixed(18),
        finalEstimate.bnbUsdPrice.toFixed(12),
        String(Date.now()),
        job.id,
      ],
    );
    if (update.affectedRows !== 1) return;
    await withTransaction(db, async (tx) => {
      await recordEstimatedBscFeeTx(tx, {
        txHash: transactionHash,
        operation: "refund",
        gasLimit: finalEstimate.gasLimit.toString(),
        gasPriceWei: finalEstimate.gasPrice.toString(),
        bnbUsdPrice: finalEstimate.bnbUsdPrice,
      });
      if (job.user_request_id != null) {
        await tx.query(
          `UPDATE admin_payment_resolutions SET action='refund_signed',fee_amount=?,net_amount=?,tx_hash=?
           WHERE refund_id=? AND action IN ('refund_queued','refund_signed')`,
          [finalEstimate.feeUsd.toFixed(18), finalPayoutAmount.toFixed(18), transactionHash, job.id],
        );
        await transitionUserRefundRequestTx(tx, {
          id: job.id, user_request_id: job.user_request_id,
          gross_amount: grossAmount.toFixed(18), amount: finalPayoutAmount.toFixed(18),
        }, {
          newStatus: "signed", eventType: "transaction_signed",
          reason: "The refund transaction has been signed and persisted for broadcast.",
          txHash: transactionHash, feeAmount: finalEstimate.feeUsd.toFixed(18),
          netAmount: finalPayoutAmount.toFixed(18),
        });
      } else if (job.batch_id != null) {
        await tx.query(
          `UPDATE admin_payment_resolutions SET fee_amount=?,net_amount=?,tx_hash=?
           WHERE refund_id=? AND action='refund_queued'`,
          [finalEstimate.feeUsd.toFixed(18), finalPayoutAmount.toFixed(18), transactionHash, job.id],
        );
      } else {
        await tx.query(
          `UPDATE admin_payment_resolutions SET fee_amount=?,net_amount=?,tx_hash=?
           WHERE unknown_transfer_id=? AND action='unknown_refund_queued'`,
          [finalEstimate.feeUsd.toFixed(18), finalPayoutAmount.toFixed(18), transactionHash, job.unknown_transfer_id],
        );
      }
      if (job.unknown_transfer_id != null) {
        await tx.query(
          `UPDATE bsc_unknown_refund_requests SET status='refund_signed',refund_id=?,updated_at_ms=?
           WHERE unknown_transfer_id=? AND status='approved'`,
          [String(job.id), String(Date.now()), String(job.unknown_transfer_id)],
        );
      }
      await queueTelegramMessageTx(tx, job.username, `refund:${job.id}:gas_accepted`, [
        "OneX Refund Update",
        "The estimated BSC network fee is within the permitted limit. Your refund transaction has been signed and queued for blockchain submission.",
        `Gross amount: ${grossAmount.toFixed(8)} BSC-USD`,
        `Estimated gas recovery: ${finalEstimate.feeUsd.toFixed(8)} BSC-USD`,
        `Net refund: ${finalPayoutAmount.toFixed(8)} BSC-USD`,
        `Refund ID: ${job.id}`,
        "Status: PROCESSING",
      ].join("\n"));
    });
    job = { ...job, raw_tx: rawTransaction, tx_hash: transactionHash, status: "signed" };
  }

  if (!job.raw_tx || !job.tx_hash) {
    await markRefundError(db, job.id, new Error("Signed refund transaction is missing."));
    return;
  }

  let receipt = await activeRuntime.provider.getTransactionReceipt(job.tx_hash);
  if (!receipt) {
    const known = await activeRuntime.provider.getTransaction(job.tx_hash);
    if (!known) {
      try {
        const broadcast = await activeRuntime.provider.broadcastTransaction(job.raw_tx);
        if (broadcast.hash.toLowerCase() !== job.tx_hash.toLowerCase()) {
          throw new Error("The refund broadcast hash differs from the persisted transaction hash.");
        }
      } catch (error) {
        const afterError = await activeRuntime.provider.getTransaction(job.tx_hash);
        if (!afterError) {
          await markRefundError(db, job.id, error);
          return;
        }
      }
    }
    const submittedAt = String(Date.now());
    const submittedUpdate = await db.queryAsync(
      "UPDATE users_usdt_refunds SET status='submitted',last_error=NULL,updated_at_ms=? WHERE id=? AND status IN ('signed','submitted')",
      [submittedAt, job.id],
    );
    if (job.unknown_transfer_id != null) {
      await db.queryAsync(
        `UPDATE bsc_unknown_refund_requests SET status='submitted',updated_at_ms=?
         WHERE unknown_transfer_id=? AND status IN ('approved','refund_signed','submitted')`,
        [submittedAt, String(job.unknown_transfer_id)],
      );
    }
    if (Number(submittedUpdate.affectedRows || 0) > 0 && job.user_request_id != null) {
      await withTransaction(db, async (tx) => {
        await tx.query(
          `UPDATE admin_payment_resolutions SET action='refund_submitted'
           WHERE refund_id=? AND action IN ('refund_signed','refund_submitted')`,
          [job.id],
        );
        await transitionUserRefundRequestTx(tx, job, {
          newStatus: "submitted", eventType: "transaction_submitted",
          reason: "The signed refund transaction has been broadcast to BNB Smart Chain.",
          txHash: job.tx_hash, createdAtMs: submittedAt,
        });
      });
    }
    receipt = await activeRuntime.provider.getTransactionReceipt(job.tx_hash);
    if (!receipt) return;
  }

  const canonicalBlock = await activeRuntime.provider.getBlock(receipt.blockNumber);
  const latestBlock = await activeRuntime.provider.getBlockNumber();
  const confirmations = latestBlock - Number(receipt.blockNumber) + 1;
  const canonical = canonicalBlock &&
    String(canonicalBlock.hash || "").toLowerCase() === String(receipt.blockHash || "").toLowerCase();
  if (!canonical || confirmations < activeRuntime.confirmations) return;

  if (Number(receipt.status) !== 1) {
    await withTransaction(db, async (tx) => {
      const now = String(Date.now());
      const actualFee = await recordActualBscFeeTx(tx, {
        txHash: job.tx_hash,
        operation: "refund",
        receipt,
      });
      const [refundRows] = await tx.query(
        "SELECT * FROM users_usdt_refunds WHERE id=? LIMIT 1 FOR UPDATE", [job.id],
      );
      if (!refundRows.length) throw new Error(`Refund ${job.id} disappeared while restoring its reservation.`);
      const refund = refundRows[0];
      const grossAmount = new BigNumber(refund.gross_amount || refund.amount || "0");
      const [failedRefundUpdate] = await tx.query(
        "UPDATE users_usdt_refunds SET status='failed',actual_fee_bnb=?,actual_fee_usd=?,last_error=?,updated_at_ms=? WHERE id=? AND status IN ('signed','submitted')",
        [actualFee.feeBnb.toFixed(30), actualFee.feeUsd.toFixed(18), "The refund transaction was finalized but reverted on BNB Smart Chain. No BSC-USD refund transfer was completed.", now, job.id],
      );
      if (Number(failedRefundUpdate.affectedRows || 0) !== 1) {
        throw new Error("Refund state changed before failed-transfer reconciliation; reservation was not modified.");
      }
      if (refund.batch_id != null) {
        const [batchUpdate] = await tx.query(
          `UPDATE users_usdt_deposit_batches
           SET reserved_refund_amount=reserved_refund_amount-?,
               remaining_amount=remaining_amount+?,status='pending_support',
               reason_codes=?,next_attempt_at_ms=?,updated_at_ms=?
           WHERE id=? AND status='refund_queued' AND reserved_refund_amount>=?`,
          [grossAmount.toFixed(18), grossAmount.toFixed(18), JSON.stringify(["refund_failed"]), now, now,
            refund.batch_id, grossAmount.toFixed(18)],
        );
        if (Number(batchUpdate.affectedRows || 0) !== 1) {
          throw new Error("The failed refund reservation could not be restored to its deposit remainder.");
        }
        await tx.query(
          "UPDATE users_usdt_transfer_events SET status='pending_support',reason_codes=? WHERE batch_id=?",
          [JSON.stringify(["refund_failed"]), refund.batch_id],
        );
        await tx.query(
          "UPDATE admin_payment_resolutions SET action='refund_failed',tx_hash=?,reason=CONCAT(reason,' | Refund reverted on-chain; reserved amount restored to pending deposit.') WHERE refund_id=? AND action IN ('refund_queued','refund_signed','refund_submitted')",
          [job.tx_hash, job.id],
        );
      } else if (refund.unknown_transfer_id != null) {
        await tx.query(
          `UPDATE bsc_unknown_incoming_transfers SET status='refund_failed',updated_at_ms=? WHERE id=?`,
          [now, refund.unknown_transfer_id],
        );
        await tx.query(
          `UPDATE admin_payment_resolutions SET action='refund_failed',tx_hash=?
           WHERE unknown_transfer_id=? AND (refund_id=? OR refund_id IS NULL) AND action IN ('unknown_refund_queued','refund_queued')`,
          [job.tx_hash, refund.unknown_transfer_id, job.id],
        );
        await tx.query(
          `UPDATE bsc_unknown_refund_requests SET status='failed',admin_reason='The finalized refund transaction reverted; administrative reconciliation is required.',
             updated_at_ms=? WHERE unknown_transfer_id=? AND status IN ('approved','refund_signed','submitted')`,
          [now, String(refund.unknown_transfer_id)],
        );
      }
      await transitionUserRefundRequestTx(tx, refund, {
        newStatus: "failed", eventType: "blockchain_reverted",
        reason: "The refund transaction was finalized with a revert. The BSC-USD amount reserved for the refund has been restored to the deposit remainder; no token refund was completed.",
        txHash: job.tx_hash, feeAmount: String(refund.fee_amount || "0"),
        netAmount: String(refund.amount || "0"), createdAtMs: now,
      });
      await queueTelegramMessageTx(tx, refund.username, `refund:${job.id}:failed`, [
        "OneX Refund Update",
        "The refund transaction was finalized but reverted on BNB Smart Chain. No BSC-USD refund transfer was completed.",
        `Refund ID: ${job.id}`,
        `Transaction: ${job.tx_hash}`,
        `Reserved gross amount restored to pending deposit: ${grossAmount.toFixed(8)} BSC-USD`,
        `Actual gas paid by OneX: ${actualFee.feeBnb.toFixed(8)} BNB (${actualFee.feeUsd.toFixed(8)} BSC-USD)`,
        "The pending deposit will be evaluated again under the normal credit rules. A new exceptional refund request may be submitted if the applicable conditions are still met.",
        "Status: FAILED - AMOUNT RESTORED",
      ].join("\n"));
    });
    return;
  }

  if (!receiptConfirmsExpectedTransfer(receipt, job, activeRuntime)) {
    await withTransaction(db, async (tx) => {
      const now = String(Date.now());
      const actualFee = await recordActualBscFeeTx(tx, {
        txHash: job.tx_hash,
        operation: "refund",
        receipt,
      });
      const [refundRows] = await tx.query(
        "SELECT * FROM users_usdt_refunds WHERE id=? LIMIT 1 FOR UPDATE", [job.id],
      );
      const refund = refundRows[0];
      await tx.query(
        "UPDATE users_usdt_refunds SET status='manual_review',actual_fee_bnb=?,actual_fee_usd=?,last_error=?,updated_at_ms=? WHERE id=?",
        [actualFee.feeBnb.toFixed(30), actualFee.feeUsd.toFixed(18), "The refund transaction succeeded but did not contain the expected BSC-USD Transfer event.", now, job.id],
      );
      if (job.batch_id != null) {
        await tx.query(
          "UPDATE users_usdt_deposit_batches SET status='pending_support',updated_at_ms=? WHERE id=?",
          [now, job.batch_id],
        );
        await tx.query(
          "UPDATE admin_payment_resolutions SET action='refund_manual_review',tx_hash=? WHERE refund_id=? AND action IN ('refund_queued','refund_signed','refund_submitted')",
          [job.tx_hash, job.id],
        );
      } else if (job.unknown_transfer_id != null) {
        await tx.query(
          `UPDATE bsc_unknown_incoming_transfers SET status='refund_manual_review',updated_at_ms=? WHERE id=?`,
          [now, job.unknown_transfer_id],
        );
        await tx.query(
          `UPDATE admin_payment_resolutions SET action='refund_manual_review'
           WHERE unknown_transfer_id=? AND action='unknown_refund_queued'`,
          [job.unknown_transfer_id],
        );
        await tx.query(
          `UPDATE bsc_unknown_refund_requests SET status='manual_review',admin_reason='The refund receipt did not match the expected BSC-USD transfer.',
             updated_at_ms=? WHERE unknown_transfer_id=? AND status IN ('approved','refund_signed','submitted')`,
          [now, String(job.unknown_transfer_id)],
        );
      }
      await transitionUserRefundRequestTx(tx, refund || job, {
        newStatus: "manual_review", eventType: "unexpected_transfer_event",
        reason: "The refund transaction succeeded but its BSC-USD Transfer event did not match the expected payout. The reserved amount remains blocked pending reconciliation.",
        txHash: job.tx_hash, createdAtMs: now,
      });
      await queueTelegramMessageTx(tx, job.username, `refund:${job.id}:manual_review`, [
        "OneX Refund Update",
        "The refund transaction requires manual review because its receipt does not match the expected transfer. The reserved amount remains blocked pending reconciliation.",
        `Refund ID: ${job.id}`,
        "Status: MANUAL REVIEW",
      ].join("\n"));
    });
    return;
  }

  await finalizeRefund(db, job.id, receipt);
}

async function processRefundQueue(db, activeRuntime) {
  const jobs = await db.queryAsync(
    `SELECT * FROM users_usdt_refunds
     WHERE status IN ('queued','signed','submitted')
       AND batch_id IS NULL AND unknown_transfer_id IS NOT NULL AND user_request_id IS NULL
     ORDER BY id ASC LIMIT 10`,
  );
  for (const job of jobs) {
    try {
      await processOneRefundJob(db, job, activeRuntime);
    } catch (error) {
      console.error(`Refund ${job.id} processing failed:`, error.message);
      await markRefundError(db, job.id, error).catch(() => {});
    }
  }
}


async function closeExpiredGlobalDisbursement(db) {
  const now = Date.now();
  const runs = await db.queryAsync(
    `SELECT id FROM global_disbursement_runs
     WHERE status='active' AND CAST(CASE WHEN extension_deadline_at_ms>0 THEN extension_deadline_at_ms ELSE request_deadline_at_ms END AS UNSIGNED)<=?
     ORDER BY id ASC LIMIT 10`,
    [String(now)],
  );
  let closed = 0;
  for (const candidate of runs) {
    await withTransaction(db, async (tx) => {
      const [lockRows] = await tx.query(
        "SELECT lock_name FROM system_locks WHERE lock_name='common_state' FOR UPDATE",
      );
      if (!lockRows.length) throw new Error("The common-state lock row is missing during global closure.");
      await getLatestCommonTx(tx, true);
      const [runRows] = await tx.query(
        "SELECT id,status,request_deadline_at_ms,extension_deadline_at_ms FROM global_disbursement_runs WHERE id=? LIMIT 1 FOR UPDATE",
        [candidate.id],
      );
      if (!runRows.length || runRows[0].status !== "active" || Number(runRows[0].extension_deadline_at_ms || runRows[0].request_deadline_at_ms) > now) return;
      const timestamp = String(now);
      await tx.query(
        `UPDATE global_disbursement_runs
         SET status='closed',closed_at_ms=?,updated_at_ms=? WHERE id=? AND status='active'`,
        [timestamp, timestamp, candidate.id],
      );
      await tx.query(
        `UPDATE global_disbursement_participants
         SET status='manual_review',updated_at_ms=?
         WHERE run_id=? AND status='awaiting_request' AND remaining_initial_asset>0`,
        [timestamp, candidate.id],
      );
      closed += 1;
    });
  }
  return { closed };
}

async function settleGlobalDisbursementRun(db) {
  const runs = await db.queryAsync(
    `SELECT id,status FROM global_disbursement_runs
     WHERE status IN ('closed','manual_review') ORDER BY id ASC LIMIT 10`,
  );
  let settled = 0;
  for (const run of runs) {
    await withTransaction(db, async (tx) => {
      const [lockRows] = await tx.query(
        "SELECT lock_name FROM system_locks WHERE lock_name='common_state' FOR UPDATE",
      );
      if (!lockRows.length) throw new Error("The common-state lock row is missing during global settlement.");
      await getLatestCommonTx(tx, true);
      const [runRows] = await tx.query(
        "SELECT id,status FROM global_disbursement_runs WHERE id=? LIMIT 1 FOR UPDATE", [run.id],
      );
      if (!runRows.length || !["closed", "manual_review"].includes(runRows[0].status)) return;
      const [pendingRows] = await tx.query(
        `SELECT COUNT(*) AS count FROM users_usdt_disbursements
         WHERE global_run_id=? AND status IN ('queued','signed','submitted','manual_review')`, [run.id],
      );
      if (Number(pendingRows[0]?.count || 0) > 0) return;
      const [participantRows] = await tx.query(
        `SELECT COUNT(*) AS count FROM global_disbursement_participants
         WHERE run_id=? AND status IN ('awaiting_request','request_pending','manual_review')`, [run.id],
      );
      const unresolved = Number(participantRows[0]?.count || 0);
      const nextStatus = unresolved > 0 ? "manual_review" : "completed";
      const timestamp = String(Date.now());
      await tx.query(
        `UPDATE global_disbursement_runs
         SET status=?,admin_bonus_reserved_initial_asset=CASE WHEN ?='completed' THEN 0 ELSE admin_bonus_reserved_initial_asset END,
             completed_at_ms=CASE WHEN ?='completed' THEN ? ELSE completed_at_ms END,
             updated_at_ms=? WHERE id=?`,
        [nextStatus, nextStatus, nextStatus, timestamp, timestamp, run.id],
      );
      settled += 1;
    });
  }
  return { settled };
}

async function acquireHotWalletSpendLock(db) {
  const connection = await connectionFromPool(db);
  const queryable = connection.promise();
  try {
    const [rows] = await queryable.query("SELECT GET_LOCK(?,0) AS acquired", ["onex_hot_wallet_spend"]);
    if (Number(rows[0]?.acquired) !== 1) {
      connection.release();
      return null;
    }
    return async () => {
      try { await queryable.query("SELECT RELEASE_LOCK(?)", ["onex_hot_wallet_spend"]); }
      finally { connection.release(); }
    };
  } catch (error) {
    connection.release();
    throw error;
  }
}

async function runDisbursementCycle(db, activeRuntimes) {
  if (workerRunning) return;
  workerRunning = true;
  let releaseLock = null;
  let releaseHotWalletLock = null;
  try {
    releaseLock = await acquireWorkerLock(db);
    if (!releaseLock) return;

    const now = String(Date.now());
    const expiredReservations = await db.queryAsync(
      `SELECT id FROM users_usdt_disbursements
       WHERE status='queued' AND disbursement_mode='individual'
         AND raw_tx IS NULL AND tx_hash IS NULL
         AND CAST(reservation_expires_at_ms AS UNSIGNED)<=?
       ORDER BY id ASC LIMIT 50`,
      [now],
    );
    for (const expired of expiredReservations) {
      await markManualReview(
        db,
        expired.id,
        "Reservation expired before transaction submission; administrator review is required.",
      );
    }

    if (activeRuntimes.disbursementRuntime) {
      const jobs = await db.queryAsync(
        `SELECT * FROM users_usdt_disbursements
         WHERE status IN ('queued','signed','submitted')
         ORDER BY id ASC LIMIT 10`,
      );
      for (const job of jobs) {
        try {
          await processOneJob(db, job, activeRuntimes.disbursementRuntime);
        } catch (error) {
          console.error(`Disbursement ${job.id} processing failed:`, error.message);
          await updateJobError(db, job.id, error).catch(() => {});
        }
      }
    }

    if (activeRuntimes.treasuryRuntime) {
      releaseHotWalletLock = await acquireHotWalletSpendLock(db);
      if (releaseHotWalletLock) {
        await processRefundQueue(db, activeRuntimes.treasuryRuntime);
        const sellerPayouts = await db.queryAsync(
          `SELECT * FROM users_usdt_seller_payouts
           WHERE status IN ('queued','signed','submitted')
           ORDER BY id ASC LIMIT 20`,
        );
        for (const payout of sellerPayouts) {
          try {
            await processOneSellerPayout(db, payout, activeRuntimes.treasuryRuntime);
          } catch (error) {
            console.error(`Seller payout ${payout.id} processing failed:`, error.message);
          }
        }
      }
    }
    await closeExpiredGlobalDisbursement(db);
    await settleGlobalDisbursementRun(db);

  } catch (error) {
    console.error("OneX BSC disbursement worker failed:", error);
  } finally {
    if (releaseHotWalletLock) {
      try { await releaseHotWalletLock(); }
      catch (error) { console.error("Unable to release Hot Wallet spend lock:", error.message); }
    }
    if (releaseLock) {
      try {
        await releaseLock();
      } catch (error) {
        console.error("Unable to release the disbursement worker lock:", error.message);
      }
    }
    workerRunning = false;
  }
}

async function startDisbursementWorker(db) {
  if (timer) return { enabled: true };
  const masterEnabled = String(process.env.USDT_DISBURSEMENTS_ENABLED || "false").toLowerCase() === "true";
  const individualEnabled = masterEnabled && String(process.env.USDT_INDIVIDUAL_DISBURSEMENT_ENABLED || "false").toLowerCase() === "true";
  const globalEnabled = masterEnabled && String(process.env.USDT_GLOBAL_DISBURSEMENT_ENABLED || "false").toLowerCase() === "true";
  const sellerEnabled = String(process.env.USDT_SELLER_PAYOUTS_ENABLED || "false").toLowerCase() === "true";
  const [pendingRows] = await db.promise().query(
    `SELECT
       (SELECT COUNT(*) FROM users_usdt_disbursements WHERE status IN ('queued','signed','submitted')) AS disbursements,
       (SELECT COUNT(*) FROM users_usdt_seller_payouts WHERE status IN ('queued','signed','submitted')) AS seller_payouts,
       (SELECT COUNT(*) FROM users_usdt_refunds WHERE status IN ('queued','signed','submitted')) AS refunds,
       (SELECT COUNT(*) FROM global_disbursement_runs WHERE status IN ('active','closed','manual_review')) AS global_runs`,
  );
  const pendingDisbursements = Number(pendingRows[0]?.disbursements || 0);
  const pendingSellerPayouts = Number(pendingRows[0]?.seller_payouts || 0);
  const pendingRefunds = Number(pendingRows[0]?.refunds || 0);
  const pendingGlobalRuns = Number(pendingRows[0]?.global_runs || 0);
  const needDisbursement = individualEnabled || globalEnabled || pendingDisbursements > 0;
  const needTreasury = sellerEnabled || pendingSellerPayouts > 0 || pendingRefunds > 0;
  if (!needDisbursement && !needTreasury && pendingGlobalRuns === 0) {
    console.log("OneX BSC payouts are disabled; no accepted payout or refund work is pending.");
    return { enabled: false };
  }

  const activeRuntimes = makeRuntime({ needDisbursement, needTreasury });
  const priceSnapshot = await startBnbUsdPriceOracle(activeRuntimes.provider);
  await validateRuntime(activeRuntimes);
  const senderSummary = [
    activeRuntimes.disbursementRuntime ? `Disbursement Wallet: ${activeRuntimes.disbursementAddress}` : null,
    activeRuntimes.treasuryRuntime ? `Hot Wallet: ${activeRuntimes.treasuryAddress}` : null,
  ].filter(Boolean).join("; ");
  if (priceSnapshot) {
    console.log(
      `OneX BSC payout worker ready. ${senderSummary}. ` +
      `Chainlink BNB/USD: ${priceSnapshot.price} (updated ${new Date(priceSnapshot.updatedAt * 1000).toISOString()}).`,
    );
  } else {
    console.warn("OneX BSC payout worker is ready, but no fresh Chainlink BNB/USD quote is available. Outgoing jobs will remain queued.");
  }

  const run = async () => {
    await runDisbursementCycle(db, activeRuntimes);
    timer = setTimeout(run, activeRuntimes.pollIntervalMs);
  };
  void run();
  return { enabled: true };
}

module.exports = {
  startDisbursementWorker,
  checkTreasuryLiquidity,
  checkDisbursementLiquidity,
  checkDisbursementReserveCapacity,
  closeExpiredGlobalDisbursement,
  settleGlobalDisbursementRun,
};
