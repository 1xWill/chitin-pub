import { ethers } from 'ethers';
import { dbQuery } from '@/server/db';
import { getBaseProvider, getChitinContractAddress } from '@/server/chain';
import { getDemoMetrics, isDemoMode } from '@/server/demo-data';

export type Metrics = {
  chitinizedAgents: number;
  totalTippedGrossWei: string;
  totalSupplyWei: string;
  circulatingSupplyWei: string;
  totalBurnedWei: string;
};

export async function getMetrics(): Promise<Metrics> {
  if (isDemoMode()) return getDemoMetrics();

  const linked = await dbQuery<{ cnt: number }>(`SELECT COUNT(*)::int AS cnt FROM agent_wallets`);
  const chitinizedAgents = linked[0]?.cnt ?? 0;

  const tipped = await dbQuery<{ sum: string }>(
    `
    SELECT COALESCE(SUM(gross_amount::numeric), 0)::text AS sum
    FROM activities
    WHERE status='confirmed'
      AND kind IN ('tip_mint','tip_reserve')
      AND gross_amount IS NOT NULL
    `
  );

  const totalTippedGrossWei = String(tipped[0]?.sum ?? '0');

  const burnedRows = await dbQuery<{ sum: string }>(
    `
    SELECT COALESCE(SUM(burn_amount::numeric), 0)::text AS sum
    FROM activities
    WHERE status='confirmed'
      AND kind='pay'
      AND burn_amount IS NOT NULL
    `
  );
  const dbBurned = BigInt(String(burnedRows[0]?.sum ?? '0'));

  let totalSupply = BigInt(0);
  let totalBurned = dbBurned;

  try {
    const provider = getBaseProvider();
    const abi = [
      'function totalSupply() view returns (uint256)',
      'function totalBurned() view returns (uint256)'
    ];
    const token = new ethers.Contract(getChitinContractAddress(), abi, provider);
    totalSupply = BigInt((await token.totalSupply()).toString());
    try {
      totalBurned = BigInt((await token.totalBurned()).toString());
    } catch {
      totalBurned = dbBurned;
    }
  } catch {
    // Fallback when contractAddress is not configured yet (e.g. local DB-seeded demo).
    const balRows = await dbQuery<{ sum: string }>(
      `SELECT COALESCE(SUM(balance_wei::numeric), 0)::text AS sum FROM agent_balances`
    );
    totalSupply = BigInt(String(balRows[0]?.sum ?? '0'));
  }

  return {
    chitinizedAgents,
    totalTippedGrossWei,
    totalSupplyWei: totalSupply.toString(),
    // For UI consistency with BaseScan, "circulating" matches the onchain ERC-20 totalSupply.
    // (total supply already reflects burns because burn() reduces supply.)
    circulatingSupplyWei: totalSupply.toString(),
    totalBurnedWei: totalBurned.toString()
  };
}
