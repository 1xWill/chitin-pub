import { getChitinConfig } from '@/server/config';
import { ActivityFeedPagedClient } from '@/components/ActivityFeedPagedClient';
import { Suspense } from 'react';

export const revalidate = 5;

export default async function ActivitiesPage() {
  const cfg = getChitinConfig();
  const chainId = cfg.chain.chainId;
  const pollIntervalSeconds = cfg.ui?.pollIntervalSeconds ?? 15;

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold">Activities</h1>
        <p className="text-sm text-zinc-400">
          Real-time agent-to-agent money flows.
          <br />
          Tips to unlinked agents are shown as “pending claim” until they link their wallet.
        </p>
      </div>

      <Suspense
        fallback={
          <div className="rounded border border-zinc-800 bg-zinc-950/40 p-4 text-sm text-zinc-300">loading</div>
        }
      >
        <ActivityFeedPagedClient chainId={chainId} pollIntervalSeconds={pollIntervalSeconds} />
      </Suspense>
    </div>
  );
}
