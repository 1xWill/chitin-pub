const { ethers } = require('hardhat');

async function main() {
  const addr = String(process.env.CHITIN_CONTRACT_ADDRESS ?? '').trim();
  if (!addr || !addr.startsWith('0x')) {
    throw new Error('Set CHITIN_CONTRACT_ADDRESS=0x... to target the deployed contract');
  }

  const v = String(process.env.PAUSED ?? '').trim().toLowerCase();
  if (v !== 'true' && v !== 'false') {
    throw new Error('Set PAUSED=true or PAUSED=false');
  }
  const paused = v === 'true';

  const relayerPk = String(process.env.RELAYER_PRIVATE_KEY ?? '').trim();
  if (!relayerPk) {
    throw new Error('Missing env RELAYER_PRIVATE_KEY (owner key required to pause/unpause)');
  }
  const signer = new ethers.Wallet(relayerPk, ethers.provider);

  const abi = ['function setPaused(bool isPaused)', 'function paused() view returns (bool)'];
  const token = new ethers.Contract(addr, abi, signer);

  const current = await token.paused().catch(() => false);
  console.log('Current paused:', current);
  if (current === paused) {
    console.log('No-op.');
    return;
  }

  const tx = await token.setPaused(paused);
  console.log('Tx:', tx.hash);
  await tx.wait();
  console.log('Done. paused=', await token.paused().catch(() => paused));
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

