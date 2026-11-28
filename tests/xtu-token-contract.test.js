"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const ganache = require("ganache");
const { BrowserProvider, ContractFactory, parseUnits } = require("ethers");
const { compileOneXToken } = require("../scripts/compile-xtu");

test("OneXToken preserves fixed supply and transfers the full amount without contract commission", async () => {
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
    assert.equal(await token.TRANSFER_FEE_BPS(), 0n);
    assert.equal(artifact.abi.some((item) => item.type === "function" && item.name === "mint"), false);

    const assertZeroFeeAudit = (receipt, from, to, amount) => {
      const events = receipt.logs.map((log) => { try { return token.interface.parseLog(log); } catch { return null; } }).filter(Boolean);
      const audit = events.find((event) => event.name === "TransferWithFee");
      assert.ok(audit, "TransferWithFee audit event is present");
      assert.equal(audit.args.from, from);
      assert.equal(audit.args.to, to);
      assert.equal(audit.args.grossAmount, amount);
      assert.equal(audit.args.netAmount, amount);
      assert.equal(audit.args.feeAmount, 0n);
      assert.equal(audit.args.feeExempt, false);
      assert.equal(events.some((event) => event.name === "FeeCollected"), false);
    };

    const hotToDistributionAmount = parseUnits("10", 18);
    const hotToDistribution = await token.transfer(distributionAddress, hotToDistributionAmount);
    assertZeroFeeAudit(await hotToDistribution.wait(), hotAddress, distributionAddress, hotToDistributionAmount);
    assert.equal(await token.balanceOf(distributionAddress), hotToDistributionAmount);

    const hotToAliceAmount = parseUnits("10", 18);
    const hotToAlice = await token.transfer(aliceAddress, hotToAliceAmount);
    assertZeroFeeAudit(await hotToAlice.wait(), hotAddress, aliceAddress, hotToAliceAmount);
    assert.equal(await token.balanceOf(aliceAddress), hotToAliceAmount);
    assert.equal(await token.balanceOf(distributionAddress), hotToDistributionAmount);

    const userTransferAmount = parseUnits("1", 18);
    const userTx = await token.connect(alice).transfer(bobAddress, userTransferAmount);
    assertZeroFeeAudit(await userTx.wait(), aliceAddress, bobAddress, userTransferAmount);
    assert.equal(await token.balanceOf(bobAddress), userTransferAmount);

    const transferFromAmount = parseUnits("2", 18);
    await (await token.connect(alice).approve(await spender.getAddress(), transferFromAmount)).wait();
    const transferFrom = await token.connect(spender).transferFrom(aliceAddress, bobAddress, transferFromAmount);
    assertZeroFeeAudit(await transferFrom.wait(), aliceAddress, bobAddress, transferFromAmount);
    assert.equal(await token.balanceOf(bobAddress), userTransferAmount + transferFromAmount);
    assert.equal(await token.allowance(aliceAddress, await spender.getAddress()), 0n);

    const distributionToAliceAmount = parseUnits("1", 18);
    const distributionTx = await token.connect(distribution).transfer(aliceAddress, distributionToAliceAmount);
    assertZeroFeeAudit(await distributionTx.wait(), distributionAddress, aliceAddress, distributionToAliceAmount);
    assert.equal(await token.balanceOf(aliceAddress), hotToAliceAmount + distributionToAliceAmount);
    assert.equal(await token.balanceOf(distributionAddress), hotToDistributionAmount - distributionToAliceAmount);

    const aliceToDistributionAmount = parseUnits("1", 18);
    const reverseTx = await token.connect(alice).transfer(distributionAddress, aliceToDistributionAmount);
    assertZeroFeeAudit(await reverseTx.wait(), aliceAddress, distributionAddress, aliceToDistributionAmount);
    assert.equal(await token.balanceOf(distributionAddress), hotToDistributionAmount);
  } finally {
    await chain.disconnect();
  }
});
