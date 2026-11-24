"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const ganache = require("ganache");
const { BrowserProvider, ContractFactory, parseUnits } = require("ethers");
const { compileOneXToken } = require("../scripts/compile-xtu");

test("OneXToken assigns fixed supply to the Hot Wallet and exempts only Hot Wallet -> Distribution Wallet", async () => {
  const chain = ganache.provider({
    chain: { chainId: 56, hardfork: "shanghai" },
    wallet: { totalAccounts: 5, defaultBalance: 1000 },
    logging: { quiet: true },
  });
  try {
    const provider = new BrowserProvider(chain);
    const hot = await provider.getSigner(0);
    const distribution = await provider.getSigner(1);
    const alice = await provider.getSigner(2);
    const bob = await provider.getSigner(3);
    const spender = await provider.getSigner(4);
    const hotAddress = await hot.getAddress();
    const distributionAddress = await distribution.getAddress();
    const aliceAddress = await alice.getAddress();
    const bobAddress = await bob.getAddress();

    const artifact = compileOneXToken();
    const factory = new ContractFactory(artifact.abi, artifact.bytecode, hot);
    const token = await factory.deploy(hotAddress, distributionAddress);
    await token.waitForDeployment();

    const fixedSupply = parseUnits("100000000000", 18);
    assert.equal(await token.totalSupply(), fixedSupply);
    assert.equal(await token.balanceOf(hotAddress), fixedSupply);
    assert.equal(await token.balanceOf(distributionAddress), 0n);
    assert.equal(await token.initialWallet(), hotAddress);
    assert.equal(await token.feeCollector(), distributionAddress);
    assert.equal(await token.TRANSFER_FEE_BPS(), 10n);
    assert.equal(artifact.abi.some((item) => item.type === "function" && item.name === "mint"), false);

    // Exact internal consolidation pair is exempt and transfers the full amount.
    const hotToDistribution = await token.transfer(distributionAddress, parseUnits("10", 18));
    const hotToDistributionReceipt = await hotToDistribution.wait();
    assert.equal(await token.balanceOf(distributionAddress), parseUnits("10", 18));
    const exemptEvent = hotToDistributionReceipt.logs
      .map((log) => { try { return token.interface.parseLog(log); } catch { return null; } })
      .find((event) => event?.name === "TransferWithFee");
    assert.equal(exemptEvent.args.grossAmount, parseUnits("10", 18));
    assert.equal(exemptEvent.args.netAmount, parseUnits("10", 18));
    assert.equal(exemptEvent.args.feeAmount, 0n);
    assert.equal(exemptEvent.args.feeExempt, true);

    // Hot Wallet -> a personal wallet is not exempt.
    const hotToAlice = await token.transfer(aliceAddress, parseUnits("10", 18));
    const hotToAliceReceipt = await hotToAlice.wait();
    assert.equal(await token.balanceOf(aliceAddress), parseUnits("9.99", 18));
    assert.equal(await token.balanceOf(distributionAddress), parseUnits("10.01", 18));
    const hotFee = hotToAliceReceipt.logs
      .map((log) => { try { return token.interface.parseLog(log); } catch { return null; } })
      .find((event) => event?.name === "FeeCollected");
    assert.equal(hotFee.args.amount, parseUnits("0.01", 18));

    // User -> user is charged through transfer.
    const beforeUserTransfer = await token.balanceOf(distributionAddress);
    const userTx = await token.connect(alice).transfer(bobAddress, parseUnits("1", 18));
    const userReceipt = await userTx.wait();
    assert.equal(await token.balanceOf(bobAddress), parseUnits("0.999", 18));
    assert.equal(await token.balanceOf(distributionAddress), beforeUserTransfer + parseUnits("0.001", 18));
    const userFee = userReceipt.logs
      .map((log) => { try { return token.interface.parseLog(log); } catch { return null; } })
      .find((event) => event?.name === "FeeCollected");
    assert.equal(userFee.args.amount, parseUnits("0.001", 18));

    // transferFrom has the same fee behavior.
    await (await token.connect(alice).approve(await spender.getAddress(), parseUnits("2", 18))).wait();
    const beforeTransferFrom = await token.balanceOf(distributionAddress);
    await (await token.connect(spender).transferFrom(aliceAddress, bobAddress, parseUnits("2", 18))).wait();
    assert.equal(await token.balanceOf(bobAddress), parseUnits("2.997", 18));
    assert.equal(await token.balanceOf(distributionAddress), beforeTransferFrom + parseUnits("0.002", 18));
    assert.equal(await token.allowance(aliceAddress, await spender.getAddress()), 0n);

    // Distribution Wallet retains its fee in-place; there is no self Transfer.
    const distributionBefore = await token.balanceOf(distributionAddress);
    const aliceBefore = await token.balanceOf(aliceAddress);
    const distributionTx = await token.connect(distribution).transfer(aliceAddress, parseUnits("1", 18));
    const distributionReceipt = await distributionTx.wait();
    assert.equal(await token.balanceOf(aliceAddress), aliceBefore + parseUnits("0.999", 18));
    assert.equal(await token.balanceOf(distributionAddress), distributionBefore - parseUnits("0.999", 18));
    const distributionFeeEvent = distributionReceipt.logs
      .map((log) => { try { return token.interface.parseLog(log); } catch { return null; } })
      .find((event) => event?.name === "TransferWithFee");
    assert.equal(distributionFeeEvent.args.feeAmount, parseUnits("0.001", 18));
    assert.equal(distributionFeeEvent.args.feeExempt, false);
    assert.equal(distributionReceipt.logs.filter((log) => {
      try { return token.interface.parseLog(log)?.name === "FeeCollected"; } catch { return false; }
    }).length, 0);

    // Reverse direction and other senders to the Distribution Wallet are not exempt.
    const beforeReverse = await token.balanceOf(distributionAddress);
    await (await token.connect(alice).transfer(distributionAddress, parseUnits("1", 18))).wait();
    assert.equal(await token.balanceOf(distributionAddress), beforeReverse + parseUnits("1", 18));
  } finally {
    await chain.disconnect();
  }
});
