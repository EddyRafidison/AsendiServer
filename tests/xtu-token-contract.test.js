"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const ganache = require("ganache");
const { BrowserProvider, ContractFactory, parseUnits } = require("ethers");
const { compileOneXToken } = require("../scripts/compile-xtu");

test("OneXToken has fixed supply and charges the fee for transfer and transferFrom", async () => {
  const chain = ganache.provider({
    chain: { chainId: 56, hardfork: "shanghai" },
    wallet: { totalAccounts: 4, defaultBalance: 1000 },
    logging: { quiet: true },
  });
  try {
    const provider = new BrowserProvider(chain);
    const distribution = await provider.getSigner(0);
    const alice = await provider.getSigner(1);
    const bob = await provider.getSigner(2);
    const spender = await provider.getSigner(3);
    const distributionAddress = await distribution.getAddress();
    const aliceAddress = await alice.getAddress();
    const bobAddress = await bob.getAddress();

    const artifact = compileOneXToken();
    const factory = new ContractFactory(artifact.abi, artifact.bytecode, distribution);
    const token = await factory.deploy(distributionAddress);
    await token.waitForDeployment();

    const fixedSupply = parseUnits("100000000000", 18);
    assert.equal(await token.totalSupply(), fixedSupply);
    assert.equal(await token.balanceOf(distributionAddress), fixedSupply);
    assert.equal(await token.feeCollector(), distributionAddress);
    assert.equal(await token.TRANSFER_FEE_BPS(), 10n);
    assert.equal(artifact.abi.some((item) => item.type === "function" && item.name === "mint"), false);

    const beforeDistribution = await token.balanceOf(distributionAddress);
    const distributorTx = await token.transfer(aliceAddress, parseUnits("10", 18));
    const distributorReceipt = await distributorTx.wait();
    assert.equal(await token.balanceOf(aliceAddress), parseUnits("9.99", 18));
    assert.equal(await token.balanceOf(distributionAddress), beforeDistribution - parseUnits("9.99", 18));
    const distributionFee = distributorReceipt.logs
      .map((log) => { try { return token.interface.parseLog(log); } catch { return null; } })
      .find((event) => event?.name === "FeeCollected");
    assert.equal(distributionFee.args.amount, parseUnits("0.01", 18));
    assert.equal(distributionFee.args.collector, distributionAddress);

    const beforeCollectorOnUserTransfer = await token.balanceOf(distributionAddress);
    const userTx = await token.connect(alice).transfer(bobAddress, parseUnits("1", 18));
    const userReceipt = await userTx.wait();
    assert.equal(await token.balanceOf(bobAddress), parseUnits("0.999", 18));
    assert.equal(await token.balanceOf(distributionAddress), beforeCollectorOnUserTransfer + parseUnits("0.001", 18));
    const userFee = userReceipt.logs
      .map((log) => { try { return token.interface.parseLog(log); } catch { return null; } })
      .find((event) => event?.name === "FeeCollected");
    assert.equal(userFee.args.amount, parseUnits("0.001", 18));

    await (await token.connect(alice).approve(await spender.getAddress(), parseUnits("2", 18))).wait();
    const beforeCollectorOnTransferFrom = await token.balanceOf(distributionAddress);
    await (await token.connect(spender).transferFrom(aliceAddress, bobAddress, parseUnits("2", 18))).wait();
    assert.equal(await token.balanceOf(bobAddress), parseUnits("2.997", 18));
    assert.equal(await token.balanceOf(distributionAddress), beforeCollectorOnTransferFrom + parseUnits("0.002", 18));
    assert.equal(await token.allowance(aliceAddress, await spender.getAddress()), 0n);
  } finally {
    await chain.disconnect();
  }
});
