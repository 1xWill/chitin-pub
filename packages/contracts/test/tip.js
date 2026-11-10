const { expect } = require('chai');
const { ethers } = require('hardhat');

const TIP_TYPES = {
  Tip: [
    { name: 'tipper', type: 'address' },
    { name: 'recipientIdHash', type: 'bytes32' },
    { name: 'grossAmount', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
    { name: 'contextHash', type: 'bytes32' }
  ]
};

const WALLET_LINK_TYPES = {
  WalletLink: [
    { name: 'agentIdHash', type: 'bytes32' },
    { name: 'oldWallet', type: 'address' },
    { name: 'newWallet', type: 'address' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' }
  ]
};

async function signTip({ token, tipperWallet, recipientIdHash, grossAmount, nonce, deadline, contextHash }) {
  const domain = {
    name: 'CHITIN',
    version: '1',
    chainId: (await ethers.provider.getNetwork()).chainId,
    verifyingContract: await token.getAddress()
  };

  return tipperWallet.signTypedData(domain, TIP_TYPES, {
    tipper: tipperWallet.address,
    recipientIdHash,
    grossAmount,
    nonce,
    deadline,
    contextHash
  });
}

async function signWalletLink({ token, signerWallet, agentIdHash, oldWallet, newWallet, nonce, deadline }) {
  const domain = {
    name: 'CHITIN',
    version: '1',
    chainId: (await ethers.provider.getNetwork()).chainId,
    verifyingContract: await token.getAddress()
  };

  return signerWallet.signTypedData(domain, WALLET_LINK_TYPES, {
    agentIdHash,
    oldWallet,
    newWallet,
    nonce,
    deadline
  });
}

async function linkAgent({ token, claimerSigner, agentIdHash, wallet }) {
  const deadline = BigInt((await ethers.provider.getBlock('latest')).timestamp + 3600);
  const nonce = 0n;
  const sig = await signWalletLink({
    token,
    signerWallet: wallet,
    agentIdHash,
    oldWallet: ethers.ZeroAddress,
    newWallet: wallet.address,
    nonce,
    deadline
  });
  await token.connect(claimerSigner).linkAgentWallet(agentIdHash, wallet.address, nonce, deadline, sig);
}

describe('Chitin wallet linking (gasless, wallet-authorized)', function () {
  it('rejects linking if signature is not from the wallet being linked', async function () {
    const [owner, treasury] = await ethers.getSigners();
    const realWallet = ethers.Wallet.createRandom().connect(ethers.provider);
    const attacker = ethers.Wallet.createRandom().connect(ethers.provider);

    const Chitin = await ethers.getContractFactory('Chitin');
    const token = await Chitin.deploy(
      owner.address,
      treasury.address,
      0n,
      ethers.parseUnits('100', 18),
      10_000n
    );

    const agent = ethers.id('agent:link');
    const deadline = BigInt((await ethers.provider.getBlock('latest')).timestamp + 3600);
    const nonce = 0n;

    // Attacker signs, but tries to link realWallet -> should fail.
    const sig = await signWalletLink({
      token,
      signerWallet: attacker,
      agentIdHash: agent,
      oldWallet: ethers.ZeroAddress,
      newWallet: realWallet.address,
      nonce,
      deadline
    });

    await expect(token.connect(owner).linkAgentWallet(agent, realWallet.address, nonce, deadline, sig)).to.be.reverted;
  });

  it('requires both old + new wallet signatures to rotate (relayer-submitted)', async function () {
    const [owner, treasury] = await ethers.getSigners();
    const w1 = ethers.Wallet.createRandom().connect(ethers.provider);
    const w2 = ethers.Wallet.createRandom().connect(ethers.provider);
    const attacker = ethers.Wallet.createRandom().connect(ethers.provider);

    const Chitin = await ethers.getContractFactory('Chitin');
    const token = await Chitin.deploy(
      owner.address,
      treasury.address,
      0n,
      ethers.parseUnits('100', 18),
      10_000n
    );

    const agent = ethers.id('agent:rotate');
    await linkAgent({ token, claimerSigner: owner, agentIdHash: agent, wallet: w1 });
    expect(await token.linkNoncesByAgentIdHash(agent)).to.equal(1n);

    const deadline = BigInt((await ethers.provider.getBlock('latest')).timestamp + 3600);
    const nonce = 1n;

    const goodOld = await signWalletLink({
      token,
      signerWallet: w1,
      agentIdHash: agent,
      oldWallet: w1.address,
      newWallet: w2.address,
      nonce,
      deadline
    });
    const goodNew = await signWalletLink({
      token,
      signerWallet: w2,
      agentIdHash: agent,
      oldWallet: w1.address,
      newWallet: w2.address,
      nonce,
      deadline
    });

    const badNew = await signWalletLink({
      token,
      signerWallet: attacker,
      agentIdHash: agent,
      oldWallet: w1.address,
      newWallet: w2.address,
      nonce,
      deadline
    });

    await expect(token.connect(owner).rotateAgentWallet(agent, w1.address, w2.address, nonce, deadline, goodOld, badNew)).to.be
      .reverted;
    await expect(token.connect(owner).rotateAgentWallet(agent, w1.address, w2.address, nonce, deadline, badNew, goodNew)).to.be
      .reverted;

    await token.connect(owner).rotateAgentWallet(agent, w1.address, w2.address, nonce, deadline, goodOld, goodNew);
    expect(await token.walletByAgentIdHash(agent)).to.equal(w2.address);
    expect(await token.linkNoncesByAgentIdHash(agent)).to.equal(2n);
  });
});

describe('Chitin.tip (mint vs reserve)', function () {
  it('mints to linked recipient wallet, charges 2.5% treasury fee, increments agent nonce', async function () {
    const [owner, treasury, relayer] = await ethers.getSigners();
    const tipper = ethers.Wallet.createRandom().connect(ethers.provider);
    const recipient = ethers.Wallet.createRandom().connect(ethers.provider);

    const Chitin = await ethers.getContractFactory('Chitin');
    const token = await Chitin.deploy(
      owner.address,
      treasury.address,
      0n,
      ethers.parseUnits('1000000', 18), // baseDailyTranche
      20n // per-agent cap bps of daily tranche (0.2% => 2,000 when tranche is 1,000,000)
    );

    const tipperAgent = ethers.id('agent:tipper');
    const recipientAgent = ethers.id('agent:recipient');
    await linkAgent({ token, claimerSigner: owner, agentIdHash: tipperAgent, wallet: tipper });
    await linkAgent({ token, claimerSigner: owner, agentIdHash: recipientAgent, wallet: recipient });

    const gross = ethers.parseUnits('10', 18);
    const nonce = 0n;
    const deadline = BigInt((await ethers.provider.getBlock('latest')).timestamp + 3600);
    const contextHash = ethers.id('ctx');

    const sig = await signTip({
      token,
      tipperWallet: tipper,
      recipientIdHash: recipientAgent,
      grossAmount: gross,
      nonce,
      deadline,
      contextHash
    });

    await token.connect(relayer).tip(tipper.address, recipientAgent, gross, nonce, deadline, contextHash, sig);

    const fee = (gross * 250n) / 10000n;
    const net = gross - fee;

    expect(await token.balanceOf(recipient.address)).to.equal(net);
    expect(await token.balanceOf(treasury.address)).to.equal(fee);
    expect(await token.totalSupply()).to.equal(net + fee);

    expect(await token.noncesByAgent(tipperAgent)).to.equal(1n);
  });

  it('reserves when recipient wallet is not linked; claim mints later to newly linked wallet', async function () {
    const [owner, treasury, relayer] = await ethers.getSigners();
    const tipper = ethers.Wallet.createRandom().connect(ethers.provider);
    const recipient = ethers.Wallet.createRandom().connect(ethers.provider);

    const Chitin = await ethers.getContractFactory('Chitin');
    const token = await Chitin.deploy(
      owner.address,
      treasury.address,
      0n,
      ethers.parseUnits('1000000', 18),
      20n
    );

    const tipperAgent = ethers.id('agent:tipper');
    const recipientAgent = ethers.id('agent:recipient');
    await linkAgent({ token, claimerSigner: owner, agentIdHash: tipperAgent, wallet: tipper });

    // Allow relayer to claim.
    await token.connect(owner).setClaimer(relayer.address);

    const gross = ethers.parseUnits('10', 18);
    const nonce = 0n;
    const deadline = BigInt((await ethers.provider.getBlock('latest')).timestamp + 3600);
    const contextHash = ethers.id('ctx');

    const sig = await signTip({
      token,
      tipperWallet: tipper,
      recipientIdHash: recipientAgent,
      grossAmount: gross,
      nonce,
      deadline,
      contextHash
    });

    await token.connect(relayer).tip(tipper.address, recipientAgent, gross, nonce, deadline, contextHash, sig);

    const fee = (gross * 250n) / 10000n;
    const net = gross - fee;
    expect(await token.balanceOf(treasury.address)).to.equal(fee);
    expect(await token.balanceOf(recipient.address)).to.equal(0n);
    expect(await token.reservedNetByRecipientIdHash(recipientAgent)).to.equal(net);

    // Link recipient, then claim.
    await linkAgent({ token, claimerSigner: owner, agentIdHash: recipientAgent, wallet: recipient });
    await token.connect(relayer).claim(recipientAgent);

    expect(await token.reservedNetByRecipientIdHash(recipientAgent)).to.equal(0n);
    expect(await token.balanceOf(recipient.address)).to.equal(net);
  });

  it('enforces per-agent cap (ratio-based)', async function () {
    const [owner, treasury, relayer] = await ethers.getSigners();
    const tipper = ethers.Wallet.createRandom().connect(ethers.provider);
    const recipient = ethers.Wallet.createRandom().connect(ethers.provider);

    // Daily tranche 10/day, per-agent cap bps 5000 => 5/day.
    const Chitin = await ethers.getContractFactory('Chitin');
    const token = await Chitin.deploy(owner.address, treasury.address, 0n, ethers.parseUnits('10', 18), 5000n);

    const tipperAgent = ethers.id('agent:tipper');
    const recipientAgent = ethers.id('agent:recipient');
    await linkAgent({ token, claimerSigner: owner, agentIdHash: tipperAgent, wallet: tipper });
    await linkAgent({ token, claimerSigner: owner, agentIdHash: recipientAgent, wallet: recipient });

    const contextHash = ethers.id('ctx');

    const makeSigned = async (grossAmount, nonce) => {
      const deadline = BigInt((await ethers.provider.getBlock('latest')).timestamp + 3600);
      const signature = await signTip({
        token,
        tipperWallet: tipper,
        recipientIdHash: recipientAgent,
        grossAmount,
        nonce,
        deadline,
        contextHash
      });
      return { deadline, signature };
    };

    const gross1 = ethers.parseUnits('5', 18);
    const t1 = await makeSigned(gross1, 0n);
    await token.connect(relayer).tip(tipper.address, recipientAgent, gross1, 0n, t1.deadline, contextHash, t1.signature);

    const gross2 = ethers.parseUnits('1', 18);
    const t2 = await makeSigned(gross2, 1n);
    await expect(
      token.connect(relayer).tip(tipper.address, recipientAgent, gross2, 1n, t2.deadline, contextHash, t2.signature)
    ).to.be.reverted;
  });

  it('enforces daily unlock (cannot drain full weekly budget on day 1)', async function () {
    const [owner, treasury, relayer] = await ethers.getSigners();
    const tipper1 = ethers.Wallet.createRandom().connect(ethers.provider);
    const tipper2 = ethers.Wallet.createRandom().connect(ethers.provider);
    const recipient = ethers.Wallet.createRandom().connect(ethers.provider);

    // baseDailyTranche=10 => epoch0 weekly budget 70, but day-0 unlock is only 10.
    // per-agent cap 100% of daily tranche so it won't be the limiting factor here.
    const Chitin = await ethers.getContractFactory('Chitin');
    const token = await Chitin.deploy(owner.address, treasury.address, 0n, ethers.parseUnits('10', 18), 10_000n);

    const tipperAgent1 = ethers.id('agent:tipper1');
    const tipperAgent2 = ethers.id('agent:tipper2');
    const recipientAgent = ethers.id('agent:recipient');
    await linkAgent({ token, claimerSigner: owner, agentIdHash: tipperAgent1, wallet: tipper1 });
    await linkAgent({ token, claimerSigner: owner, agentIdHash: tipperAgent2, wallet: tipper2 });
    await linkAgent({ token, claimerSigner: owner, agentIdHash: recipientAgent, wallet: recipient });

    const contextHash = ethers.id('ctx');

    const deadline = BigInt((await ethers.provider.getBlock('latest')).timestamp + 3600);

    // Tip 10 (gross) from tipper1 - should fill day-0 unlock.
    {
      const gross = ethers.parseUnits('10', 18);
      const sig = await signTip({
        token,
        tipperWallet: tipper1,
        recipientIdHash: recipientAgent,
        grossAmount: gross,
        nonce: 0n,
        deadline,
        contextHash
      });
      await token.connect(relayer).tip(tipper1.address, recipientAgent, gross, 0n, deadline, contextHash, sig);
    }

    // Another tip on the same day should fail because epoch unlocked is exhausted (even though weekly budget remains).
    {
      const gross = ethers.parseUnits('1', 18);
      const sig = await signTip({
        token,
        tipperWallet: tipper2,
        recipientIdHash: recipientAgent,
        grossAmount: gross,
        nonce: 0n,
        deadline,
        contextHash
      });
      await expect(token.connect(relayer).tip(tipper2.address, recipientAgent, gross, 0n, deadline, contextHash, sig)).to.be
        .reverted;
    }
  });

  it('rejects self-tips by agent id hash', async function () {
    const [owner, treasury, relayer] = await ethers.getSigners();
    const tipper = ethers.Wallet.createRandom().connect(ethers.provider);

    const Chitin = await ethers.getContractFactory('Chitin');
    const token = await Chitin.deploy(
      owner.address,
      treasury.address,
      0n,
      ethers.parseUnits('1000000', 18),
      20n
    );

    const tipperAgent = ethers.id('agent:tipper');
    await linkAgent({ token, claimerSigner: owner, agentIdHash: tipperAgent, wallet: tipper });

    const gross = ethers.parseUnits('10', 18);
    const nonce = 0n;
    const deadline = BigInt((await ethers.provider.getBlock('latest')).timestamp + 3600);
    const contextHash = ethers.id('ctx');

    const sig = await signTip({
      token,
      tipperWallet: tipper,
      recipientIdHash: tipperAgent,
      grossAmount: gross,
      nonce,
      deadline,
      contextHash
    });

    await expect(token.connect(relayer).tip(tipper.address, tipperAgent, gross, nonce, deadline, contextHash, sig)).to.be
      .reverted;
  });

  it('supports wallet rotation without resetting nonce/cap usage', async function () {
    const [owner, treasury, relayer] = await ethers.getSigners();
    const tipper1 = ethers.Wallet.createRandom().connect(ethers.provider);
    const tipper2 = ethers.Wallet.createRandom().connect(ethers.provider);
    const recipient = ethers.Wallet.createRandom().connect(ethers.provider);

    const Chitin = await ethers.getContractFactory('Chitin');
    const token = await Chitin.deploy(owner.address, treasury.address, 0n, ethers.parseUnits('1000000', 18), 20n);

    const tipperAgent = ethers.id('agent:tipper');
    const recipientAgent = ethers.id('agent:recipient');
    await linkAgent({ token, claimerSigner: owner, agentIdHash: tipperAgent, wallet: tipper1 });
    await linkAgent({ token, claimerSigner: owner, agentIdHash: recipientAgent, wallet: recipient });

    const gross = ethers.parseUnits('1', 18);
    const contextHash = ethers.id('ctx');

    // tip once with wallet 1 (nonce 0)
    {
      const nonce = 0n;
      const deadline = BigInt((await ethers.provider.getBlock('latest')).timestamp + 3600);
      const sig = await signTip({
        token,
        tipperWallet: tipper1,
        recipientIdHash: recipientAgent,
        grossAmount: gross,
        nonce,
        deadline,
        contextHash
      });
      await token.connect(relayer).tip(tipper1.address, recipientAgent, gross, nonce, deadline, contextHash, sig);
    }

    expect(await token.noncesByAgent(tipperAgent)).to.equal(1n);

    // rotate to wallet 2
    {
      const nonce = 1n;
      const deadline = BigInt((await ethers.provider.getBlock('latest')).timestamp + 3600);
      const sigOld = await signWalletLink({
        token,
        signerWallet: tipper1,
        agentIdHash: tipperAgent,
        oldWallet: tipper1.address,
        newWallet: tipper2.address,
        nonce,
        deadline
      });
      const sigNew = await signWalletLink({
        token,
        signerWallet: tipper2,
        agentIdHash: tipperAgent,
        oldWallet: tipper1.address,
        newWallet: tipper2.address,
        nonce,
        deadline
      });
      await token.connect(owner).rotateAgentWallet(tipperAgent, tipper1.address, tipper2.address, nonce, deadline, sigOld, sigNew);
    }

    // tip again with wallet 2 (nonce 1)
    {
      const nonce = 1n;
      const deadline = BigInt((await ethers.provider.getBlock('latest')).timestamp + 3600);
      const sig = await signTip({
        token,
        tipperWallet: tipper2,
        recipientIdHash: recipientAgent,
        grossAmount: gross,
        nonce,
        deadline,
        contextHash
      });
      await token.connect(relayer).tip(tipper2.address, recipientAgent, gross, nonce, deadline, contextHash, sig);
    }

    expect(await token.noncesByAgent(tipperAgent)).to.equal(2n);
  });

  it('pause switch stops tips (emergency stop)', async function () {
    const [owner, treasury, relayer] = await ethers.getSigners();
    const tipper = ethers.Wallet.createRandom().connect(ethers.provider);
    const recipient = ethers.Wallet.createRandom().connect(ethers.provider);

    const Chitin = await ethers.getContractFactory('Chitin');
    const token = await Chitin.deploy(
      owner.address,
      treasury.address,
      0n,
      ethers.parseUnits('1000000', 18),
      20n
    );

    const tipperAgent = ethers.id('agent:tipper');
    const recipientAgent = ethers.id('agent:recipient');
    await linkAgent({ token, claimerSigner: owner, agentIdHash: tipperAgent, wallet: tipper });
    await linkAgent({ token, claimerSigner: owner, agentIdHash: recipientAgent, wallet: recipient });

    await token.connect(owner).setPaused(true);

    const gross = ethers.parseUnits('10', 18);
    const nonce = 0n;
    const deadline = BigInt((await ethers.provider.getBlock('latest')).timestamp + 3600);
    const contextHash = ethers.id('ctx');

    const sig = await signTip({
      token,
      tipperWallet: tipper,
      recipientIdHash: recipientAgent,
      grossAmount: gross,
      nonce,
      deadline,
      contextHash
    });

    await expect(token.connect(relayer).tip(tipper.address, recipientAgent, gross, nonce, deadline, contextHash, sig)).to.be.reverted;
  });

  it('wallet lock blocks operator relinking; locked wallet can self-rotate', async function () {
    const [owner, treasury] = await ethers.getSigners();
    const wallet1 = ethers.Wallet.createRandom().connect(ethers.provider);
    const wallet2 = ethers.Wallet.createRandom().connect(ethers.provider);

    // Fund wallet1 so it can call lock/rotate (needs gas).
    await owner.sendTransaction({ to: wallet1.address, value: ethers.parseEther('0.1') });

    const Chitin = await ethers.getContractFactory('Chitin');
    const token = await Chitin.deploy(
      owner.address,
      treasury.address,
      0n,
      ethers.parseUnits('1000000', 18),
      20n
    );

    const agent = ethers.id('agent:self');
    await linkAgent({ token, claimerSigner: owner, agentIdHash: agent, wallet: wallet1 });

    await token.connect(wallet1).lockAgentWallet(agent);

    // Operator can no longer change this mapping.
    const deadline = BigInt((await ethers.provider.getBlock('latest')).timestamp + 3600);
    const nonce = 1n; // linkAgent used nonce=0 and incremented; any value should revert on lock before nonce check.
    const sigOld = await signWalletLink({
      token,
      signerWallet: wallet1,
      agentIdHash: agent,
      oldWallet: wallet1.address,
      newWallet: wallet2.address,
      nonce,
      deadline
    });
    const sigNew = await signWalletLink({
      token,
      signerWallet: wallet2,
      agentIdHash: agent,
      oldWallet: wallet1.address,
      newWallet: wallet2.address,
      nonce,
      deadline
    });
    await expect(
      token.connect(owner).rotateAgentWallet(agent, wallet1.address, wallet2.address, nonce, deadline, sigOld, sigNew)
    ).to.be.reverted;

    // Self-rotation is allowed (wallet1 -> wallet2).
    await token.connect(wallet1).rotateLockedAgentWallet(wallet2.address);
    expect(await token.walletByAgentIdHash(agent)).to.equal(wallet2.address);
  });
});

describe('Chitin.burnUnusedBudgetForEpoch', function () {
  it('burns unused budget for a past epoch (weekly unused-budget burn)', async function () {
    const [owner, treasury] = await ethers.getSigners();
    const Chitin = await ethers.getContractFactory('Chitin');
    const token = await Chitin.deploy(owner.address, treasury.address, 0n, ethers.parseUnits('10', 18), 5000n);

    // Advance by >7 days so epoch 0 is in the past.
    await ethers.provider.send('evm_increaseTime', [8 * 86400]);
    await ethers.provider.send('evm_mine');

    await token.burnUnusedBudgetForEpoch(0);
    expect(await token.unusedBudgetBurned(0)).to.equal(true);
  });
});

describe('Chitin.burn', function () {
  it('burns caller balance and reduces total supply', async function () {
    const [owner, treasury] = await ethers.getSigners();
    const Chitin = await ethers.getContractFactory('Chitin');

    // Mint some genesis supply to treasury so we can transfer to a user and burn.
    const token = await Chitin.deploy(
      owner.address,
      treasury.address,
      ethers.parseUnits('1000', 18),
      ethers.parseUnits('100', 18),
      500n
    );

    const alice = ethers.Wallet.createRandom().connect(ethers.provider);
    await owner.sendTransaction({ to: alice.address, value: ethers.parseEther('0.01') });

    const send = ethers.parseUnits('10', 18);
    await token.connect(treasury).transfer(alice.address, send);

    const burnAmt = ethers.parseUnits('2.5', 18);
    const beforeSupply = await token.totalSupply();
    await token.connect(alice).burn(burnAmt);

    expect(await token.balanceOf(alice.address)).to.equal(send - burnAmt);
    expect(await token.totalSupply()).to.equal(beforeSupply - burnAmt);
  });
});
