"use strict";

const path = require("path");
const dotenv = require("dotenv");
const BigNumber = require("bignumber.js");
const {
  Contract,
  JsonRpcProvider,
  Wallet,
  isAddress,
  getAddress,
  keccak256,
} = require("ethers");
const { estimateBscTokenTransfer, calculateEstimatedGasFee } = require("./bsc-fee-accounting");
const { getBnbUsdPrice } = require("./bsc-price-oracle");
const { getConfiguredMaxBscTxFeeUsd, evaluateBscTxFee } = require("./bsc-transaction-policy");
const { calculateXtuWithdrawalQuote, XTU_DECIMALS } = require("./xtu-withdrawal-policy");

const CHAIN_ID = 56n;
const XTU_ABI = Object.freeze([
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function feeCollector() view returns (address)",
  "function initialWallet() view returns (address)",
  "function TRANSFER_FEE_BPS() view returns (uint256)",
  "function transfer(address to,uint256 value) returns (bool)",
  "event Transfer(address indexed from,address indexed to,uint256 value)",
  "event FeeCollected(address indexed from,address indexed collector,uint256 amount)",
  "event TransferWithFee(address indexed from,address indexed to,uint256 grossAmount,uint256 netAmount,uint256 feeAmount,bool feeExempt)",
]);

let cachedRuntime = null;

function readBoundedInteger(name, fallback, min, max) {
  const raw = process.env[name];
  if (raw == null || String(raw).trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new RangeError(`${name} must be an integer between ${min} and ${max}.`);
  }
  return value;
}

function loadXtuEnvironment() {
  const envPath = path.resolve(process.env.XTU_ENV_FILE || ".env.xtu");
  dotenv.config({ path: envPath });
  return envPath;
}

function loadXtuSecretEnvironment(role) {
  const variable = role === "main" ? "XTU_MAIN_ENV_FILE" : "XTU_DISTRIBUTION_ENV_FILE";
  const fallback = role === "main" ? ".env.xtu-main" : ".env.xtu-distribution";
  dotenv.config({ path: path.resolve(process.env[variable] || fallback) });
}

function isXtuWorkerEnabled() {
  loadXtuEnvironment();
  return String(process.env.XTU_WITHDRAWAL_WORKER_ENABLED || "false").toLowerCase() === "true";
}

function isXtuDepositWorkerEnabled() {
  loadXtuEnvironment();
  return String(process.env.XTU_DEPOSIT_WORKER_ENABLED || "false").toLowerCase() === "true";
}

function getXtuSettings() {
  const envPath = loadXtuEnvironment();
  const chainId = String(process.env.XTU_CHAIN_ID || "56");
  if (chainId !== "56") throw new Error("XTU_CHAIN_ID must be 56 (BNB Smart Chain mainnet).");
  const tokenAddress = String(process.env.XTU_TOKEN_CONTRACT_ADDRESS || "").trim();
  const mainWalletAddress = String(process.env.XTU_MAIN_WALLET_ADDRESS || "").trim();
  const distributionAddress = String(process.env.XTU_DISTRIBUTION_ADDRESS || "").trim();
  const rpcUrl = String(process.env.BSC_RPC_URL || "").trim();
  if (!isAddress(tokenAddress) || /^0x0{40}$/i.test(tokenAddress)) {
    throw new Error("XTU_TOKEN_CONTRACT_ADDRESS must be a deployed contract address.");
  }
  if (!isAddress(mainWalletAddress) || /^0x0{40}$/i.test(mainWalletAddress)) {
    throw new Error("XTU_MAIN_WALLET_ADDRESS must be a valid non-zero BSC address.");
  }
  if (!isAddress(distributionAddress) || /^0x0{40}$/i.test(distributionAddress)) {
    throw new Error("XTU_DISTRIBUTION_ADDRESS must be a valid non-zero address.");
  }
  if (getAddress(mainWalletAddress) === getAddress(distributionAddress)) {
    throw new Error("The XTU Hot Wallet and Distribution Wallet must be different addresses.");
  }
  if (!rpcUrl) throw new Error("BSC_RPC_URL (outgoing BSC RPC) is required for XTU operations.");
  const depositMinAmount = String(process.env.XTU_DEPOSIT_MIN_AMOUNT || "70").trim();
  const depositMaxAmount = String(process.env.XTU_DEPOSIT_MAX_AMOUNT || "140").trim();
  if (depositMinAmount !== "70" || depositMaxAmount !== "140") {
    throw new RangeError("XTU deposit intake limits are fixed at 70 minimum and 140 maximum per user per rolling seven-day period.");
  }
  const depositInitialCreditCap = new BigNumber(process.env.XTU_DEPOSIT_MAX_INITIAL_CREDIT_XTU || "100");
  if (!depositInitialCreditCap.isFinite() || !depositInitialCreditCap.isGreaterThan(0) || depositInitialCreditCap.gt("140")) {
    throw new RangeError("XTU_DEPOSIT_MAX_INITIAL_CREDIT_XTU must be positive and cannot exceed the 140 XTU rolling-week intake maximum.");
  }
  return {
    envPath,
    rpcUrl,
    tokenAddress: getAddress(tokenAddress),
    mainWalletAddress: getAddress(mainWalletAddress),
    distributionAddress: getAddress(distributionAddress),
    minConfirmations: readBoundedInteger("XTU_MIN_CONFIRMATIONS", 15, 1, 200),
    pollMs: readBoundedInteger("XTU_WITHDRAWAL_POLL_MS", 15000, 5000, 300000),
    gasLimitCeiling: BigInt(readBoundedInteger("XTU_WITHDRAWAL_GAS_LIMIT", 250000, 50000, 1000000)),
    retryMs: readBoundedInteger("XTU_WITHDRAWAL_RETRY_MS", 60000, 10000, 3600000),
    maxPendingPerUser: readBoundedInteger("XTU_MAX_PENDING_PER_USER", 1, 1, 5),
    workerEnabled: String(process.env.XTU_WITHDRAWAL_WORKER_ENABLED || "false").toLowerCase() === "true",
    depositPollMs: readBoundedInteger("XTU_DEPOSIT_POLL_MS", 15000, 5000, 300000),
    depositMaxLogBlockRange: readBoundedInteger("XTU_DEPOSIT_MAX_LOG_BLOCK_RANGE", 1000, 1, 5000),
    depositMinAmount,
    depositMaxAmount,
    depositInitialCreditCap: depositInitialCreditCap.toFixed(18),
    depositGasLimitCeiling: BigInt(readBoundedInteger("XTU_DEPOSIT_GAS_LIMIT", 250000, 50000, 1000000)),
    depositBatchWindowMs: readBoundedInteger("XTU_DEPOSIT_BATCH_WINDOW_MS", 3600000, 3600000, 3600000),
    depositInitialGroupingTimeoutMs: readBoundedInteger("XTU_DEPOSIT_INITIAL_GROUPING_TIMEOUT_DAYS", 30, 1, 30) * 24 * 60 * 60 * 1000,
    depositPendingRetryMs: readBoundedInteger("XTU_DEPOSIT_PENDING_RETRY_DAYS", 7, 7, 7) * 24 * 60 * 60 * 1000,
    depositWorkerEnabled: String(process.env.XTU_DEPOSIT_WORKER_ENABLED || "false").toLowerCase() === "true",
    incomingStartBlock: String(process.env.XTU_INCOMING_START_BLOCK || "").trim(),
    incomingRpcUrl: String(process.env.XTU_INCOMING_RPC_URL || process.env.BSC_INCOMING_RPC_URL || process.env.BSC_RPC_URL || "").trim(),
  };
}

async function getXtuRuntime({ requireSigner = true } = {}) {
  const settings = getXtuSettings();
  const cacheKey = `${settings.rpcUrl}|${settings.tokenAddress.toLowerCase()}|${settings.mainWalletAddress.toLowerCase()}|${settings.distributionAddress.toLowerCase()}|${requireSigner}`;
  if (cachedRuntime?.cacheKey === cacheKey && (!requireSigner || cachedRuntime.signer)) return cachedRuntime;

  const provider = new JsonRpcProvider(settings.rpcUrl, CHAIN_ID);
  const network = await provider.getNetwork();
  if (BigInt(network.chainId) !== CHAIN_ID) throw new Error("The outgoing RPC is not connected to BNB Smart Chain mainnet (chain ID 56).");
  const code = await provider.getCode(settings.tokenAddress);
  if (!code || code === "0x") throw new Error("The configured XTU contract address has no deployed bytecode.");

  const contract = new Contract(settings.tokenAddress, XTU_ABI, provider);
  const [name, symbol, decimals, supply, collector, initialWallet] = await Promise.all([
    contract.name(), contract.symbol(), contract.decimals(), contract.totalSupply(), contract.feeCollector(), contract.initialWallet(),
  ]);
  const feeBps = await contract.TRANSFER_FEE_BPS();
  if (String(name) !== "OneX Token" || String(symbol) !== "XTU" || Number(decimals) !== XTU_DECIMALS) {
    throw new Error("The configured token contract is not the expected OneX Token (XTU, 18 decimals).");
  }
  const expectedSupply = 100_000_000_000n * (10n ** 18n);
  if (BigInt(supply) !== expectedSupply) throw new Error("The XTU contract total supply does not match the fixed 100-billion XTU supply.");
  if (getAddress(String(collector)) !== settings.distributionAddress ||
      getAddress(String(initialWallet)) !== settings.mainWalletAddress || BigInt(feeBps) !== 10n) {
    throw new Error("The XTU contract Hot Wallet, fee collector or mandatory 0.1% fee does not match the configured wallet roles.");
  }

  let signer = null;
  if (requireSigner) {
    loadXtuSecretEnvironment("distribution");
    const privateKey = String(process.env.XTU_DISTRIBUTION_PRIVATE_KEY || "").trim();
    if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey)) {
      throw new Error("XTU_DISTRIBUTION_PRIVATE_KEY must be configured in .env.xtu-distribution.");
    }
    signer = new Wallet(privateKey, provider);
    if (signer.address !== settings.distributionAddress) {
      throw new Error("XTU distribution private key does not match XTU_DISTRIBUTION_ADDRESS.");
    }
  }
  cachedRuntime = { cacheKey, settings, provider, contract, signer };
  return cachedRuntime;
}

async function getXtuMainSigner(runtime = null) {
  const activeRuntime = runtime || await getXtuRuntime({ requireSigner: false });
  loadXtuSecretEnvironment("main");
  const privateKey = String(process.env.XTU_MAIN_PRIVATE_KEY || "").trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey)) {
    throw new Error("XTU_MAIN_PRIVATE_KEY must be configured in .env.xtu-main.");
  }
  const signer = new Wallet(privateKey, activeRuntime.provider);
  if (signer.address !== activeRuntime.settings.mainWalletAddress) {
    throw new Error("XTU main private key does not match XTU_MAIN_WALLET_ADDRESS.");
  }
  return signer;
}

async function estimateXtuWithdrawal({ destination, grossAmount }) {
  const runtime = await getXtuRuntime({ requireSigner: true });
  const to = getAddress(String(destination));
  if (to === runtime.settings.distributionAddress) throw new Error("The registered wallet cannot be the XTU distribution wallet.");
  const bnbUsdPrice = await getBnbUsdPrice(runtime.provider, { forceRefresh: true });
  const grossRaw = BigInt(new BigNumber(grossAmount).multipliedBy("1e18").integerValue(BigNumber.ROUND_DOWN).toFixed(0));
  if (grossRaw <= 0n) throw new Error("Gross XTU amount must be positive.");

  // Estimate the gas using an amount close to the requested gross withdrawal.
  const data = runtime.contract.interface.encodeFunctionData("transfer", [to, grossRaw]);
  const estimate = await estimateBscTokenTransfer({
    provider: runtime.provider,
    fromAddress: runtime.settings.distributionAddress,
    tokenAddress: runtime.settings.tokenAddress,
    data,
    maximumGasLimit: runtime.settings.gasLimitCeiling,
    bnbUsdPrice,
  });
  const bufferedGasLimit = (estimate.gasLimit * 120n + 99n) / 100n;
  if (bufferedGasLimit > runtime.settings.gasLimitCeiling) {
    throw new RangeError("The buffered XTU withdrawal gas limit exceeds XTU_WITHDRAWAL_GAS_LIMIT.");
  }
  const gas = calculateEstimatedGasFee(bufferedGasLimit.toString(), estimate.gasPrice.toString(), bnbUsdPrice);
  const decision = evaluateBscTxFee(gas.feeUsd, getConfiguredMaxBscTxFeeUsd());
  if (!decision.allowed) {
    const error = new Error(`Estimated BSC gas fee ${gas.feeUsd.toFixed(8)} exceeds the configured 0.4 BSC-USD ceiling.`);
    error.code = "BSC_GAS_FEE_LIMIT_EXCEEDED";
    throw error;
  }

  const quote = calculateXtuWithdrawalQuote(grossAmount, gas.feeUsd);
  const [tokenBalance, nativeBalance] = await Promise.all([
    runtime.contract.balanceOf(runtime.settings.distributionAddress),
    runtime.provider.getBalance(runtime.settings.distributionAddress),
  ]);
  if (BigInt(tokenBalance) < BigInt(quote.netRaw)) throw new Error("The XTU distribution wallet does not have enough transferable XTU.");
  if (BigInt(nativeBalance) < BigInt(gas.feeBnb.multipliedBy("1e18").integerValue(BigNumber.ROUND_CEIL).toFixed(0))) {
    throw new Error("The XTU distribution wallet does not have enough BNB to pay the estimated network fee.");
  }

  return {
    ...quote,
    gasLimit: bufferedGasLimit.toString(),
    gasPriceWei: estimate.gasPrice.toString(),
    estimatedGasFeeBnb: gas.feeBnb.toFixed(30),
    estimatedGasFeeUsd: gas.feeUsd.toFixed(30),
    bnbUsdPrice: bnbUsdPrice.toFixed(18),
    destination: to,
    tokenContract: runtime.settings.tokenAddress,
    distributionAddress: runtime.settings.distributionAddress,
    distributionTokenBalance: BigInt(tokenBalance).toString(),
  };
}

function transactionHashFromRaw(rawTx) {
  return keccak256(rawTx).toLowerCase();
}

module.exports = {
  XTU_ABI,
  getXtuSettings,
  isXtuWorkerEnabled,
  isXtuDepositWorkerEnabled,
  getXtuRuntime,
  getXtuMainSigner,
  estimateXtuWithdrawal,
  transactionHashFromRaw,
};
