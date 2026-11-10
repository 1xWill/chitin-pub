import { ethers } from 'ethers';
import { dbQuery } from '@/server/db';
import { getBaseProvider, getChitinContractAddress, getRelayerSigner } from '@/server/chain';
import { chitinInterface } from '@/server/chitin-abi';
import { reconcileOnSubmitBestEffort } from '@/server/reconcile-on-submit';

export function recipientIdHashFromAgentId(agentId: string): string {
  return ethers.keccak256(ethers.toUtf8Bytes(agentId));
}

export async function claimIfAny(params: {
  agentId: string;
  recipientAddress: string;
}): Promise<{ claimed: boolean; claimTxHash?: string; claimableWei?: string }> {
  const provider = getBaseProvider();
  const contractAddress = getChitinContractAddress();

  // Fast-fail if paused (emergency stop). If paused() isn't available (older deployments), proceed.
  try {
    const paused: boolean = await new ethers.Contract(contractAddress, ['function paused() view returns (bool)'], provider).paused();
    if (paused) throw new Error('paused');
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg === 'paused') throw e;
  }

  const recipientIdHash = recipientIdHashFromAgentId(params.agentId);

  const readerAbi = ['function claimable(bytes32 recipientIdHash) view returns (uint256)'];
  const reader = new ethers.Contract(contractAddress, readerAbi, provider);
  const claimable: bigint = await reader.claimable(recipientIdHash);
  if (claimable === BigInt(0)) return { claimed: false, claimableWei: '0' };

  const signer = getRelayerSigner(provider);
  const token = new ethers.Contract(contractAddress, chitinInterface.fragments, signer);

  const tx = await token.claim(recipientIdHash);

  await dbQuery(
    `
    INSERT INTO activities (
      kind, status, tx_hash,
      recipient, recipient_agent_id, recipient_id_hash
    )
    VALUES ('claim', 'pending', $1, $2, $3, $4)
    ON CONFLICT (tx_hash) DO NOTHING
    `,
    [tx.hash, params.recipientAddress, params.agentId, recipientIdHash]
  );

  // Best-effort (throttled) reconcile so UI updates quickly without amplifying RPC cost during bursts.
  await reconcileOnSubmitBestEffort();

  return { claimed: true, claimTxHash: tx.hash, claimableWei: claimable.toString() };
}
