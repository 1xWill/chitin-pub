import { NextResponse } from 'next/server';
import { z } from 'zod';
import { ethers } from 'ethers';
import { getBaseProvider, getChitinContractAddress } from '@/server/chain';

const QuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(60).optional()
});

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const q = QuerySchema.parse(Object.fromEntries(url.searchParams.entries()));
    const days = q.days ?? 7;

    const provider = getBaseProvider();
    const latest = await provider.getBlock('latest');
    if (!latest) throw new Error('no_latest_block');

    const today = Math.floor(Number(latest.timestamp) / 86400);

    const abi = [
      'function globalMintedByDay(uint256 day) view returns (uint256)',
      'function startDay() view returns (uint256)',
      'function unusedBudgetBurnedByEpoch(uint256 epoch) view returns (uint256)'
    ];
    const token = new ethers.Contract(getChitinContractAddress(), abi, provider);

    const startDay: number = Number(await token.startDay());

    const items: Array<{
      day: number;
      epoch: number;
      dayInEpoch: number;
      grossMintedWei: string;
      unusedBudgetBurnedWei: string;
    }> = [];
    for (let i = 0; i < days; i++) {
      const day = today - i;
      if (day < 0) break;

      const v: bigint = await token.globalMintedByDay(day);

      let epoch = 0;
      let dayInEpoch = 0;
      if (day > startDay) {
        const offset = day - startDay;
        epoch = Math.floor(offset / 7);
        dayInEpoch = offset % 7;
      }

      // Weekly unused-budget burn is attributed to the final day of the epoch.
      // If it hasn't been burned yet onchain, this will read as 0.
      let burnedWei = '0';
      if (dayInEpoch === 6 && day >= startDay) {
        const burned: bigint = await token.unusedBudgetBurnedByEpoch(epoch);
        burnedWei = burned.toString();
      }

      items.push({ day, epoch, dayInEpoch, grossMintedWei: v.toString(), unusedBudgetBurnedWei: burnedWei });
    }

    // oldest -> newest
    items.reverse();

    return NextResponse.json(
      { success: true, today, days: items.length, emissions: items },
      { headers: { 'Cache-Control': 'public, s-maxage=30, stale-while-revalidate=300' } }
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ success: false, error: msg }, { status: 400 });
  }
}
