"use strict";

const path = require("node:path");
const dotenv = require("dotenv");
const { ContractFactory, JsonRpcProvider, Wallet, getAddress, isAddress } = require("ethers");
const { compileOneXToken } = require("./compile-xtu");

async function main() {
  dotenv.config();
  dotenv.config({ path: path.resolve(process.cwd(), ".env.xtu") });
  dotenv.config({ path: path.resolve(process.env.XTU_MAIN_ENV_FILE || ".env.xtu-main") });

  const rpcUrl = String(process.env.BSC_RPC_URL || "").trim();
  const privateKey = String(process.env.XTU_MAIN_PRIVATE_KEY || "").trim();
  const hotWalletAddress = String(process.env.XTU_MAIN_WALLET_ADDRESS || "").trim();
  const distributionAddress = String(process.env.XTU_DISTRIBUTION_ADDRESS || "").trim();
  if (
    !rpcUrl || !/^0x[0-9a-fA-F]{64}$/.test(privateKey) ||
    !isAddress(hotWalletAddress) || !isAddress(distributionAddress)
  ) {
    throw new Error("Set BSC_RPC_URL, XTU_MAIN_WALLET_ADDRESS and XTU_DISTRIBUTION_ADDRESS in .env.xtu, plus XTU_MAIN_PRIVATE_KEY in .env.xtu-main.");
  }

  const provider = new JsonRpcProvider(rpcUrl, 56n);
  const network = await provider.getNetwork();
  if (BigInt(network.chainId) !== 56n) throw new Error("Refusing to deploy: the RPC is not BNB Smart Chain mainnet (chain ID 56).");

  const signer = new Wallet(privateKey, provider);
  const normalizedHotWallet = getAddress(hotWalletAddress);
  const normalizedDistribution = getAddress(distributionAddress);
  if (signer.address !== normalizedHotWallet) {
    throw new Error("The deployment key must belong to XTU_MAIN_WALLET_ADDRESS. Do not reuse the XTU distribution or BSC-USD keys.");
  }
  if (normalizedHotWallet === normalizedDistribution) {
    throw new Error("The XTU Hot Wallet and Distribution Wallet must be different addresses.");
  }
  const balance = await provider.getBalance(signer.address);
  if (balance === 0n) throw new Error("The XTU Hot Wallet has no BNB for deployment gas.");

  const artifact = compileOneXToken();
  const factory = new ContractFactory(artifact.abi, artifact.bytecode, signer);
  const contract = await factory.deploy(normalizedHotWallet, normalizedDistribution);
  const deploymentTransaction = contract.deploymentTransaction();
  if (!deploymentTransaction) throw new Error("The deployment transaction was not created.");
  process.stdout.write(`XTU deployment submitted: ${deploymentTransaction.hash}\n`);
  await contract.waitForDeployment();
  const address = await contract.getAddress();
  process.stdout.write([
    "OneXToken deployed successfully.",
    `Contract address: ${address}`,
    `Initial supply recipient (Hot Wallet): ${normalizedHotWallet}`,
    `Commission recipient (Distribution Wallet): ${normalizedDistribution}`,
    `Deployment transaction: ${deploymentTransaction.hash}`,
    "Verify the constructor parameters and fixed supply on BscScan before enabling XTU deposits or withdrawals.",
  ].join("\n") + "\n");
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`XTU deployment failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { main };
