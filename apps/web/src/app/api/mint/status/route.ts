import { NextResponse } from 'next/server';
import { z } from 'zod';
import { ethers } from 'ethers';
import { getBaseProvider, getChitinContractAddress } from '@/server/chain';

const QuerySchema = z.object({
  tipper: z.string().regex(/^0x[0-9a-fA-F]{40}$/)
});

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const q = QuerySchema.parse(Object.fromEntries(url.searchParams.entries()));

    const provider = getBaseProvider();
    const contractAddress = getChitinContractAddress();

    const abi = [
      'function mintStatus(address tipperWallet) view returns (uint256 day,uint256 epoch,uint256 dayInEpoch,uint256 epochBudget,uint256 epochUnlocked,uint256 epochUsed,uint256 dailyTranche,uint256 effectivePerAgentCap,uint256 globalUsedToday,uint256 tipperUsed,uint256 nextNonce)'
    ];

    const token = new ethers.Contract(contractAddress, abi, provider);
    const status = await token.mintStatus(q.tipper);

    const epochUnlocked = BigInt(status.epochUnlocked);
    const epochUsed = BigInt(status.epochUsed);
    const perAgentCap = BigInt(status.effectivePerAgentCap);
    const tipperUsed = BigInt(status.tipperUsed);

    const epochUnlockedRemaining = epochUnlocked > epochUsed ? epochUnlocked - epochUsed : BigInt(0);
    const tipperRemaining = perAgentCap > tipperUsed ? perAgentCap - tipperUsed : BigInt(0);
    const tipperMaxTipNow = epochUnlockedRemaining < tipperRemaining ? epochUnlockedRemaining : tipperRemaining;

    return NextResponse.json({
      success: true,
      day: status.day.toString(),
      epoch: status.epoch.toString(),
      dayInEpoch: status.dayInEpoch.toString(),
      epochBudget: status.epochBudget.toString(),
      epochUnlocked: status.epochUnlocked.toString(),
      epochUsed: status.epochUsed.toString(),
      epochUnlockedRemaining: epochUnlockedRemaining.toString(),
      dailyTranche: status.dailyTranche.toString(),
      perAgentCap: status.effectivePerAgentCap.toString(),
      globalUsedToday: status.globalUsedToday.toString(),
      tipperUsed: status.tipperUsed.toString(),
      tipperRemaining: tipperRemaining.toString(),
      tipperMaxTipNow: tipperMaxTipNow.toString(),
      nextNonce: status.nextNonce.toString()
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ success: false, error: msg }, { status: 400 });
  }
}
