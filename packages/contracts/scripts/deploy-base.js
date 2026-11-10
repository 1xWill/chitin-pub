const { ethers } = require('hardhat');
const fs = require('node:fs');
const path = require('node:path');

function loadDeployConfig() {
  const override = String(process.env.DEPLOY_CONFIG_PATH ?? '').trim();
  const p = override ? path.resolve(override) : path.join(__dirname, '..', 'deploy.config.json');
  if (!fs.existsSync(p)) {
    throw new Error('Missing deploy config file: ' + p);
  }

  const raw = JSON.parse(fs.readFileSync(p, 'utf8'));

  const treasury = String(process.env.TREASURY_ADDRESS ?? raw.treasuryAddress ?? '').trim();
  const isZeroAddr = /^0x0{40}$/i.test(treasury);
  if ((!treasury || !treasury.startsWith('0x') || isZeroAddr) && process.env.ALLOW_DEPLOYER_TREASURY !== '1') {
    throw new Error(
      'deploy.config.json: set treasuryAddress to a non-zero wallet address (or set TREASURY_ADDRESS env)'
    );
  }

  const genesisMint = String(raw.genesisMintChitin ?? '').trim();
  const baseDailyTranche = String(raw.baseDailyTrancheChitin ?? '').trim();
  const perCapBps = String(raw.perAgentDailyMintCapBps ?? '').trim();

  if (!genesisMint) throw new Error('deploy.config.json: genesisMintChitin is required');
  if (!baseDailyTranche) throw new Error('deploy.config.json: baseDailyTrancheChitin is required');
  if (!perCapBps) throw new Error('deploy.config.json: perAgentDailyMintCapBps is required');

  return { treasury: isZeroAddr ? '' : treasury, genesisMint, baseDailyTranche, perCapBps };
}

async function main() {
  const cfg = loadDeployConfig();

  const [deployer] = await ethers.getSigners();
  const treasuryAddr = cfg.treasury || deployer.address;

  // Keep ops simple: one hot ops key is both the contract owner and the onchain claimer,
  // and is also used by the backend relayer to pay gas for tips/linking/claims/burns.
  const relayerPk = String(process.env.RELAYER_PRIVATE_KEY ?? '').trim();
  if (!relayerPk) {
    throw new Error('Missing env RELAYER_PRIVATE_KEY (required: owner/claimer/relayer use this address)');
  }
  const relayerAddr = new ethers.Wallet(relayerPk).address;

  const Chitin = await ethers.getContractFactory('Chitin');
  const token = await Chitin.deploy(
    relayerAddr,
    treasuryAddr,
    ethers.parseUnits(cfg.genesisMint, 18),
    ethers.parseUnits(cfg.baseDailyTranche, 18),
    BigInt(cfg.perCapBps)
  );

  await token.waitForDeployment();

  const addr = await token.getAddress();
  console.log('Deployer:', deployer.address);
  console.log('CHITIN:', addr);
  console.log('Owner/Claimer/Relayer:', relayerAddr);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
