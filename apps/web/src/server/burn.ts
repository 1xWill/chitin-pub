import { ethers } from 'ethers';
import { getBaseProvider, getChitinContractAddress, getRelayerSigner } from '@/server/chain';
import { chitinInterface } from '@/server/chitin-abi';

export type BurnResult =
  | { ok: true; skipped: true; reason: 'no_prev_epoch' | 'already_burned' }
  | { ok: true; skipped: false; epoch: number; txHash: string; unusedBurnedWei: string }
  | { ok: false; error: string };

export async function burnUnusedBudgetForPreviousEpochIfNeeded(): Promise<BurnResult> {
  try {
    const provider = getBaseProvider();
    const latest = await provider.getBlock('latest');
    if (!latest) return { ok: false, error: 'no_latest_block' };

    const contractAddress = getChitinContractAddress();
    const reader = new ethers.Contract(contractAddress, chitinInterface.fragments, provider);

    const startDay: number = Number(await reader.startDay());
    const currentDay = Math.floor(Number(latest.timestamp) / 86400);
    if (currentDay < startDay) return { ok: true, skipped: true, reason: 'no_prev_epoch' };

    const epoch = Math.floor((currentDay - startDay) / 7);
    if (epoch <= 0) return { ok: true, skipped: true, reason: 'no_prev_epoch' };
    const prevEpoch = epoch - 1;

    const alreadyBurned: boolean = await reader.unusedBudgetBurned(prevEpoch);
    if (alreadyBurned) return { ok: true, skipped: true, reason: 'already_burned' };

    const signer = getRelayerSigner(provider);
    const token = new ethers.Contract(contractAddress, chitinInterface.fragments, signer);

    const tx = await token.burnUnusedBudgetForEpoch(prevEpoch);
    const receipt = await tx.wait();
    if (!receipt) return { ok: false, error: 'burn_tx_no_receipt' };

    // Read the burned amount after the tx is mined (0 is a valid value).
    const unused: bigint = await reader.unusedBudgetBurnedByEpoch(prevEpoch);

    return { ok: true, skipped: false, epoch: prevEpoch, txHash: String(receipt.hash), unusedBurnedWei: unused.toString() };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: msg };
  }
}
