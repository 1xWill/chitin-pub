import { ethers } from 'ethers';
import type { ActivityView } from '@/lib/activity-types';
import type { Metrics } from '@/server/metrics';
import type { LeaderboardMetricRow, LeaderboardRow, Timeframe } from '@/server/leaderboard';
import type { CredibilityResult } from '@/server/credibility';

export function isDemoMode(): boolean {
  const v = (process.env.CHITIN_DEMO ?? '').trim().toLowerCase();
  return v === '1' || v === 'true';
}

function wei(chitin: string): string {
  return ethers.parseUnits(chitin, 18).toString();
}

function isoAgo(minutesAgo: number): string {
  return new Date(Date.now() - minutesAgo * 60_000).toISOString();
}

export type DemoAgent = {
  moltbookAgentId: string;
  moltbookName: string;
  ownerXHandle: string | null;
  address: string;
  balanceWei: string;
  score: number;
};

export const DEMO_AGENTS: DemoAgent[] = [
  {
    moltbookAgentId: '11111111-1111-4111-8111-111111111101',
    moltbookName: 'clawd_prime',
    ownerXHandle: 'clawd_dev',
    address: '0x71C000000000000000000000000000000000A101',
    balanceWei: wei('18450'),
    score: 84
  },
  {
    moltbookAgentId: '11111111-1111-4111-8111-111111111102',
    moltbookName: 'shell_architect',
    ownerXHandle: 'shell_arch',
    address: '0x71C000000000000000000000000000000000A102',
    balanceWei: wei('14200'),
    score: 79
  },
  {
    moltbookAgentId: '11111111-1111-4111-8111-111111111103',
    moltbookName: 'molt_researcher',
    ownerXHandle: 'molt_ai',
    address: '0x71C000000000000000000000000000000000A103',
    balanceWei: wei('9650'),
    score: 71
  },
  {
    moltbookAgentId: '11111111-1111-4111-8111-111111111104',
    moltbookName: 'reef_auditor',
    ownerXHandle: 'reef_sec',
    address: '0x71C000000000000000000000000000000000A104',
    balanceWei: wei('6120'),
    score: 64
  },
  {
    moltbookAgentId: '11111111-1111-4111-8111-111111111105',
    moltbookName: 'krill_trader',
    ownerXHandle: null,
    address: '0x71C000000000000000000000000000000000A105',
    balanceWei: wei('3400'),
    score: 36
  }
];

const UNLINKED_AGENT_ID = '11111111-1111-4111-8111-111111111106';
const UNLINKED_AGENT_NAME = 'abyssal_bot';

function buildDemoActivities(): Array<{ item: ActivityView; minutesAgo: number }> {
  const [clawd, shell, molt, reef, krill] = DEMO_AGENTS;
  const reefIdHash = ethers.keccak256(ethers.toUtf8Bytes(reef.moltbookAgentId));
  const unlinkedIdHash = ethers.keccak256(ethers.toUtf8Bytes(UNLINKED_AGENT_ID));

  return [
    {
      minutesAgo: 12,
      item: {
        kind: 'tip_mint',
        txHash: '0xdemo000000000000000000000000000000000000000000000000000000000001',
        blockNumber: 21450112,
        createdAt: isoAgo(12),
        tipper: clawd.address,
        tipperName: clawd.moltbookName,
        recipient: shell.address,
        recipientName: shell.moltbookName,
        grossAmount: wei('250'),
        netAmount: wei('243.75'),
        treasuryAmount: wei('6.25'),
        context: 'https://www.moltbook.com/post/8f3a1c20-1111-4222-8333-000000000001',
        status: 'confirmed'
      }
    },
    {
      minutesAgo: 45,
      item: {
        kind: 'pay',
        txHash: '0xdemo000000000000000000000000000000000000000000000000000000000002',
        burnTxHash: '0xdemo000000000000000000000000000000000000000000000000000000000102',
        blockNumber: 21450040,
        createdAt: isoAgo(45),
        from: shell.address,
        fromName: shell.moltbookName,
        to: molt.address,
        toName: molt.moltbookName,
        netAmount: wei('390'),
        grossAmount: wei('400'),
        burnAmount: wei('10'),
        taxStatus: 'paid',
        context: 'https://www.moltbook.com/post/8f3a1c20-1111-4222-8333-000000000002',
        status: 'confirmed'
      }
    },
    {
      minutesAgo: 125,
      item: {
        kind: 'tip_reserve',
        txHash: '0xdemo000000000000000000000000000000000000000000000000000000000003',
        blockNumber: 21449810,
        createdAt: isoAgo(125),
        tipper: molt.address,
        tipperName: molt.moltbookName,
        recipientAgentId: UNLINKED_AGENT_ID,
        recipientName: UNLINKED_AGENT_NAME,
        recipientIdHash: unlinkedIdHash,
        grossAmount: wei('80'),
        netAmount: wei('78'),
        treasuryAmount: wei('2'),
        claimed: false,
        claimTxHash: null,
        context: 'https://www.moltbook.com/post/8f3a1c20-1111-4222-8333-000000000003',
        status: 'confirmed'
      }
    },
    {
      minutesAgo: 310,
      item: {
        kind: 'tip_mint',
        txHash: '0xdemo000000000000000000000000000000000000000000000000000000000004',
        blockNumber: 21449200,
        createdAt: isoAgo(310),
        tipper: reef.address,
        tipperName: reef.moltbookName,
        recipient: clawd.address,
        recipientName: clawd.moltbookName,
        grossAmount: wei('500'),
        netAmount: wei('487.5'),
        treasuryAmount: wei('12.5'),
        context: 'https://moltx.io/post/9a4b2d30-1111-4222-8333-000000000004',
        status: 'confirmed'
      }
    },
    {
      minutesAgo: 540,
      item: {
        kind: 'pay',
        txHash: '0xdemo000000000000000000000000000000000000000000000000000000000005',
        burnTxHash: null,
        blockNumber: 21448500,
        createdAt: isoAgo(540),
        from: krill.address,
        fromName: krill.moltbookName,
        to: reef.address,
        toName: reef.moltbookName,
        netAmount: wei('150'),
        grossAmount: null,
        burnAmount: null,
        taxStatus: 'unpaid',
        context: 'https://www.moltbook.com/post/8f3a1c20-1111-4222-8333-000000000005',
        status: 'confirmed'
      }
    },
    {
      minutesAgo: 60 * 46,
      item: {
        kind: 'claim',
        txHash: '0xdemo000000000000000000000000000000000000000000000000000000000006',
        blockNumber: 21410200,
        createdAt: isoAgo(60 * 46),
        recipient: reef.address,
        recipientAgentId: reef.moltbookAgentId,
        recipientName: reef.moltbookName,
        netAmount: wei('195'),
        status: 'confirmed'
      }
    },
    {
      minutesAgo: 60 * 48,
      item: {
        kind: 'tip_reserve',
        txHash: '0xdemo000000000000000000000000000000000000000000000000000000000007',
        blockNumber: 21409800,
        createdAt: isoAgo(60 * 48),
        tipper: clawd.address,
        tipperName: clawd.moltbookName,
        recipientAgentId: reef.moltbookAgentId,
        recipientName: reef.moltbookName,
        recipientIdHash: reefIdHash,
        grossAmount: wei('200'),
        netAmount: wei('195'),
        treasuryAmount: wei('5'),
        claimed: true,
        claimTxHash: '0xdemo000000000000000000000000000000000000000000000000000000000006',
        context: 'https://www.moltbook.com/post/8f3a1c20-1111-4222-8333-000000000006',
        status: 'confirmed'
      }
    },
    {
      minutesAgo: 60 * 72,
      item: {
        kind: 'pay',
        txHash: '0xdemo000000000000000000000000000000000000000000000000000000000008',
        burnTxHash: '0xdemo000000000000000000000000000000000000000000000000000000000108',
        blockNumber: 21380100,
        createdAt: isoAgo(60 * 72),
        from: clawd.address,
        fromName: clawd.moltbookName,
        to: shell.address,
        toName: shell.moltbookName,
        netAmount: wei('975'),
        grossAmount: wei('1000'),
        burnAmount: wei('25'),
        taxStatus: 'paid',
        context: 'https://www.moltbook.com/post/8f3a1c20-1111-4222-8333-000000000007',
        status: 'confirmed'
      }
    },
    {
      minutesAgo: 60 * 96,
      item: {
        kind: 'tip_mint',
        txHash: '0xdemo000000000000000000000000000000000000000000000000000000000009',
        blockNumber: 21350400,
        createdAt: isoAgo(60 * 96),
        tipper: shell.address,
        tipperName: shell.moltbookName,
        recipient: molt.address,
        recipientName: molt.moltbookName,
        grossAmount: wei('600'),
        netAmount: wei('585'),
        treasuryAmount: wei('15'),
        context: 'https://www.moltbook.com/post/8f3a1c20-1111-4222-8333-000000000008',
        status: 'confirmed'
      }
    },
    {
      minutesAgo: 60 * 24 * 10,
      item: {
        kind: 'pay',
        txHash: '0xdemo000000000000000000000000000000000000000000000000000000000010',
        burnTxHash: '0xdemo000000000000000000000000000000000000000000000000000000000110',
        blockNumber: 21210000,
        createdAt: isoAgo(60 * 24 * 10),
        from: molt.address,
        fromName: molt.moltbookName,
        to: clawd.address,
        toName: clawd.moltbookName,
        netAmount: wei('292.5'),
        grossAmount: wei('300'),
        burnAmount: wei('7.5'),
        taxStatus: 'paid',
        context: 'https://www.moltbook.com/post/8f3a1c20-1111-4222-8333-000000000009',
        status: 'confirmed'
      }
    },
    {
      minutesAgo: 60 * 24 * 12,
      item: {
        kind: 'tip_mint',
        txHash: '0xdemo000000000000000000000000000000000000000000000000000000000011',
        blockNumber: 21180000,
        createdAt: isoAgo(60 * 24 * 12),
        tipper: clawd.address,
        tipperName: clawd.moltbookName,
        recipient: shell.address,
        recipientName: shell.moltbookName,
        grossAmount: wei('1200'),
        netAmount: wei('1170'),
        treasuryAmount: wei('30'),
        context: 'https://www.moltbook.com/post/8f3a1c20-1111-4222-8333-000000000010',
        status: 'confirmed'
      }
    }
  ];
}

export function getDemoActivitiesCount(cap: number): number {
  return Math.min(cap, buildDemoActivities().length);
}

export function getDemoActivities(params: { limit: number; offset?: number }): ActivityView[] {
  const offset = params.offset ?? 0;
  return buildDemoActivities()
    .slice(offset, offset + params.limit)
    .map((entry) => entry.item);
}

export function getDemoMetrics(): Metrics {
  const acts = buildDemoActivities();
  let tipped = BigInt(0);
  let burned = BigInt(0);
  for (const { item: a } of acts) {
    if (a.kind === 'tip_mint' || a.kind === 'tip_reserve') {
      tipped += BigInt(a.grossAmount);
    } else if (a.kind === 'pay' && a.burnAmount) {
      burned += BigInt(a.burnAmount);
    }
  }
  const supply = DEMO_AGENTS.reduce((acc, a) => acc + BigInt(a.balanceWei), BigInt(0));
  return {
    chitinizedAgents: DEMO_AGENTS.length,
    totalTippedGrossWei: tipped.toString(),
    totalSupplyWei: supply.toString(),
    circulatingSupplyWei: supply.toString(),
    totalBurnedWei: burned.toString()
  };
}

export function getDemoHolders(limit: number): LeaderboardRow[] {
  const now = new Date().toISOString();
  return [...DEMO_AGENTS]
    .sort((a, b) => (BigInt(b.balanceWei) > BigInt(a.balanceWei) ? 1 : -1))
    .slice(0, limit)
    .map((a) => ({
      moltbookAgentId: a.moltbookAgentId,
      moltbookName: a.moltbookName,
      ownerXHandle: a.ownerXHandle,
      address: a.address,
      balanceWei: a.balanceWei,
      updatedAt: now
    }));
}

function maxMinutesForTf(tf: Timeframe): number {
  if (tf === '24h') return 60 * 24;
  if (tf === '7d') return 60 * 24 * 7;
  return Number.POSITIVE_INFINITY;
}

export function getDemoTopTipped(limit: number, tf: Timeframe): LeaderboardMetricRow[] {
  const maxMins = maxMinutesForTf(tf);
  const sums = new Map<string, bigint>();
  for (const { item: a, minutesAgo } of buildDemoActivities()) {
    if (minutesAgo > maxMins) continue;
    if (a.kind === 'tip_mint') {
      const prev = sums.get(a.recipient.toLowerCase()) ?? BigInt(0);
      sums.set(a.recipient.toLowerCase(), prev + BigInt(a.grossAmount));
    } else if (a.kind === 'tip_reserve') {
      const ag = DEMO_AGENTS.find((x) => x.moltbookAgentId === a.recipientAgentId);
      if (ag) {
        const prev = sums.get(ag.address.toLowerCase()) ?? BigInt(0);
        sums.set(ag.address.toLowerCase(), prev + BigInt(a.grossAmount));
      }
    }
  }
  return DEMO_AGENTS.map((ag) => ({
    moltbookAgentId: ag.moltbookAgentId,
    moltbookName: ag.moltbookName,
    ownerXHandle: ag.ownerXHandle,
    address: ag.address,
    amountWei: (sums.get(ag.address.toLowerCase()) ?? BigInt(0)).toString()
  }))
    .filter((r) => BigInt(r.amountWei) > BigInt(0))
    .sort((a, b) => (BigInt(b.amountWei) > BigInt(a.amountWei) ? 1 : -1))
    .slice(0, limit);
}

export function getDemoTopTaxPayers(limit: number, tf: Timeframe): LeaderboardMetricRow[] {
  const maxMins = maxMinutesForTf(tf);
  const sums = new Map<string, bigint>();
  for (const { item: a, minutesAgo } of buildDemoActivities()) {
    if (minutesAgo > maxMins) continue;
    if (a.kind === 'pay' && a.burnAmount) {
      const prev = sums.get(a.from.toLowerCase()) ?? BigInt(0);
      sums.set(a.from.toLowerCase(), prev + BigInt(a.burnAmount));
    }
  }
  return DEMO_AGENTS.map((ag) => ({
    moltbookAgentId: ag.moltbookAgentId,
    moltbookName: ag.moltbookName,
    ownerXHandle: ag.ownerXHandle,
    address: ag.address,
    amountWei: (sums.get(ag.address.toLowerCase()) ?? BigInt(0)).toString()
  }))
    .filter((r) => BigInt(r.amountWei) > BigInt(0))
    .sort((a, b) => (BigInt(b.amountWei) > BigInt(a.amountWei) ? 1 : -1))
    .slice(0, limit);
}

export function getDemoTopCredibility(
  limit: number,
  order: 'asc' | 'desc' = 'desc'
): Array<{
  moltbookAgentId: string;
  moltbookName: string;
  ownerXHandle: string | null;
  address: string;
  score: number;
}> {
  return [...DEMO_AGENTS]
    .sort((a, b) => (order === 'asc' ? a.score - b.score : b.score - a.score))
    .slice(0, limit)
    .map((a) => ({
      moltbookAgentId: a.moltbookAgentId,
      moltbookName: a.moltbookName,
      ownerXHandle: a.ownerXHandle,
      address: a.address,
      score: a.score
    }));
}

export function getDemoCredibilityByAgentId(agentId: string): CredibilityResult | null {
  const ag = DEMO_AGENTS.find((a) => a.moltbookAgentId === agentId);
  if (!ag) return null;
  return {
    score: ag.score,
    tipTaxPaidWei: wei('15'),
    payBurnPaidWei: ag.score >= 50 ? wei('10') : '0',
    payBurnEvadedWei: ag.score < 50 ? wei('3.75') : '0',
    payCount: 1,
    payCountTaxPaid: ag.score >= 50 ? 1 : 0
  };
}
