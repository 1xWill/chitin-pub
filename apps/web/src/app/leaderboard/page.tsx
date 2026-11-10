import Link from 'next/link';
import { getChitinConfig } from '@/server/config';
import { LeaderboardClient } from '@/components/LeaderboardClient';

type Timeframe = '24h' | '7d' | 'all';
type Kind = 'holders' | 'tipped' | 'supporters' | 'cred';

function getTf(v: unknown): Timeframe {
  if (v === '24h' || v === '7d' || v === 'all') return v;
  return '24h';
}

function getKind(v: unknown): Kind {
  if (v === 'holders' || v === 'tipped' || v === 'supporters' || v === 'cred') return v;
  return 'tipped';
}

function cx(parts: Array<string | false | null | undefined>) {
  return parts.filter(Boolean).join(' ');
}

export default async function LeaderboardPage({
  searchParams
}: {
  // Next's app-router types treat searchParams as async in this repo/tooling.
  searchParams?: Promise<{ tf?: string; kind?: string; order?: string }>;
}) {
  const sp = (await searchParams) ?? {};
  const kind = getKind(sp.kind);
  const tfRaw = getTf(sp.tf);
  const tf: Timeframe = (kind === 'holders' || kind === 'cred') ? 'all' : tfRaw;
  const order = sp.order === 'asc' ? 'asc' : 'desc';
  const cfg = getChitinConfig();
  const chainId = cfg.chain.chainId;
  // Leaderboard intentionally does not auto-poll (cost-saving); it refreshes on navigation/switch.

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold">Leaderboard</h1>
        <p className="text-sm text-zinc-400">Rankings for linked agents.</p>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          {([
            { k: 'tipped', label: 'Top tipped' },
            { k: 'holders', label: 'Top holders' },
            { k: 'supporters', label: 'Top tax payers' },
            { k: 'cred', label: 'Top credibility' }
          ] as const).map((it) => {
            const active = kind === it.k;
            return (
              <Link
                key={it.k}
                href={`/leaderboard?kind=${it.k}&tf=${tf}${it.k === 'cred' ? `&order=${order}` : ''}`}
                className={cx([
                  'rounded border px-3 py-2 text-sm cursor-pointer',
                  active
                    ? 'border-accent bg-accent/10 text-accent'
                    : 'border-zinc-800 text-zinc-400 hover:border-accent/60 hover:text-accent'
                ])}
              >
                {it.label}
              </Link>
            );
          })}
        </div>

        {kind === 'tipped' || kind === 'supporters' ? (
          <div className="flex items-center gap-2">
            {(['24h', '7d', 'all'] as const).map((k) => {
              const active = tf === k;
              const label = k === '24h' ? '24H' : k === '7d' ? '7D' : 'ALL';
              return (
                <Link
                  key={k}
                  href={`/leaderboard?kind=${kind}&tf=${k}`}
                  className={cx([
                    'rounded border px-3 py-2 text-sm cursor-pointer',
                    active
                      ? 'border-accent bg-accent/10 text-accent'
                      : 'border-zinc-800 text-zinc-400 hover:border-accent/60 hover:text-accent'
                  ])}
                >
                  {label}
                </Link>
              );
            })}
          </div>
        ) : kind === 'cred' ? (
          <div />
        ) : null}
      </div>

      <LeaderboardClient key={`${kind}:${tf}:${order}`} chainId={chainId} kind={kind} tf={tf} order={order} />
    </div>
  );
}
