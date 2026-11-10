'use client';

import { useCallback, useMemo, useState } from 'react';
import type { ActivityView } from '@/lib/activity-types';
import { AsciiSpinner } from '@/components/AsciiSpinner';
import { ActivityRow } from '@/components/ActivityRow';
import { useVisibilityPolling } from '@/lib/useVisibilityPolling';

type ApiOk = { success: true; activities: ActivityView[] };
type ApiErr = { success: false; error: string };

export function ActivityFeedClient({
  chainId,
  limit,
  pollIntervalSeconds
}: {
  chainId: number;
  limit: number;
  pollIntervalSeconds: number;
}) {
  const endpoint = useMemo(() => `/api/activities?limit=${limit}`, [limit]);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activities, setActivities] = useState<ActivityView[]>([]);

  const fetchOnce = useCallback(async () => {
    try {
      const res = await fetch(endpoint, { cache: 'no-store' });
      const json = (await res.json().catch(() => ({ success: false, error: 'invalid_json' }))) as ApiOk | ApiErr;

      if (!res.ok) {
        const errMsg = !json.success && json.error ? json.error : `http_${res.status}`;
        setError(errMsg);
        setLoading(false);
        return;
      }

      if (!json.success) {
        setError(json.error);
        setLoading(false);
        return;
      }

      setError(null);
      setActivities(json.activities);
      setLoading(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setLoading(false);
    }
  }, [endpoint]);

  useVisibilityPolling({
    intervalMs: pollIntervalSeconds * 1000,
    fn: fetchOnce,
    key: endpoint
  });

  if (loading) {
    return (
      <div className="rounded border border-zinc-800 bg-zinc-950/40 p-4">
        <AsciiSpinner label="loading" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded border border-amber-900/60 bg-amber-950/30 p-4 text-sm text-amber-200">
        Not configured: set DATABASE_URL (and run migrations) to enable activities.
        {process.env.NODE_ENV !== 'production' ? (
          <div className="mt-2 text-xs text-amber-200/80">Error: {error}</div>
        ) : null}
      </div>
    );
  }

  if (activities.length === 0) {
    return <div className="rounded border border-zinc-800 bg-zinc-950/40 p-4 text-sm text-zinc-300">No activity yet.</div>;
  }

  return (
    <div className="divide-y divide-zinc-800 rounded border border-zinc-800 bg-zinc-950/40">
      {activities.map((a) => (
        <ActivityRow key={a.txHash} activity={a} chainId={chainId} />
      ))}
    </div>
  );
}
