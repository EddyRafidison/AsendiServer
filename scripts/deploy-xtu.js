"use strict";

const path = require("node:path");
const dotenv = require("dotenv");
const { ContractFactory, JsonRpcProvider, Wallet, getAddress, isAddress } = require("ethers");
const { compileOneXToken } = require("./compile-xtu");

async function main() {
  dotenv.config();
  dotenv.config({ path: path.resolve(process.cwd(), ".env.xtu") });
  const rpcUrl = String(process.env.BSC_RPC_URL || "").trim();
  const privateKey = String(process.env.XTU_DISTRIBUTION_PRIVATE_KEY || "").trim();
  const distributionAddress = String(process.env.XTU_DISTRIBUTION_ADDRESS || "").trim();
  if (!rpcUrl || !/^0x[0-9a-fA-F]{64}$/.test(privateKey) || !isAddress(distributionAddress)) {
    throw new Error("Set BSC_RPC_URL in .env and XTU_DISTRIBUTION_ADDRESS / XTU_DISTRIBUTION_PRIVATE_KEY in .env.xtu first.");
  }

  const provider = new JsonRpcProvider(rpcUrl, 56n);
  const network = await provider.getNetwork();
  if (BigInt(network.chainId) !== 56n) throw new Error("Refusing to deploy: the RPC is not BNB Smart Chain mainnet (chain ID 56).");

  const signer = new Wallet(privateKey, provider);
  const normalizedDistribution = getAddress(distributionAddress);
  if (signer.address !== normalizedDistribution) {
    throw new Error("The deployment key must belong to XTU_DISTRIBUTION_ADDRESS; do not reuse a treasury or disbursement key.");
  }
  const balance = await provider.getBalance(signer.address);
  if (balance === 0n) throw new Error("The dedicated XTU distribution wallet has no BNB for deployment gas.");

  const artifact = compileOneXToken();
  const factory = new ContractFactory(artifact.abi, artifact.bytecode, signer);
  const contract = await factory.deploy(normalizedDistribution);
  const deploymentTransaction = contract.deploymentTransaction();
  if (!deploymentTransaction) throw new Error("The XTU deployment transaction was not created.");
  process.stdout.write(`XTU deployment submitted: ${deploymentTransaction.hash}\n`);
  await contract.waitForDeployment();
  const address = await contract.getAddress();
  process.stdout.write([
    "OneXToken deployed successfully.",
    `Contract address: ${address}`,
    `Distribution wallet: ${normalizedDistribution}`,
    `Deployment transaction: ${deploymentTransaction.hash}`,
    "Copy the contract address into XTU_TOKEN_CONTRACT_ADDRESS in .env.xtu, then verify the contract on BscScan.",
  ].join("\n") + "\n");
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`XTU deployment failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { main };
