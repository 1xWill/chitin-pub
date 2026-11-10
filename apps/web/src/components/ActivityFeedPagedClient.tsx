'use client';

import { useCallback, useMemo, useState } from 'react';
import type { ActivityView } from '@/lib/activity-types';
import { AsciiSpinner } from '@/components/AsciiSpinner';
import { ActivityRow } from '@/components/ActivityRow';
import { useVisibilityPolling } from '@/lib/useVisibilityPolling';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';

type ApiOk = {
  success: true;
  page: number;
  pageSize: number;
  maxPages: number;
  totalPages: number;
  hasMore: boolean;
  activities: ActivityView[];
};
type ApiErr = { success: false; error: string };

function cx(parts: Array<string | false | null | undefined>) {
  return parts.filter(Boolean).join(' ');
}

export function ActivityFeedPagedClient({
  chainId,
  pollIntervalSeconds
}: {
  chainId: number;
  pollIntervalSeconds: number;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();

  const page = useMemo(() => {
    const raw = sp?.get('page') ?? '1';
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 1) return 1;
    return Math.floor(n);
  }, [sp]);

  const endpoint = useMemo(() => `/api/activities?page=${page}`, [page]);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activities, setActivities] = useState<ActivityView[]>([]);
  const [totalPages, setTotalPages] = useState<number>(1);

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
      setTotalPages(json.totalPages ?? 1);
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

  const go = useCallback(
    (p: number) => {
      const next = new URLSearchParams(sp?.toString() ?? '');
      next.set('page', String(p));
      router.push(`${pathname}?${next.toString()}`);
      setLoading(true);
    },
    [router, pathname, sp]
  );

  const canPrev = page > 1;
  const canNext = page < totalPages;

  return (
    <div className="space-y-3">
      {loading ? (
        <div className="rounded border border-zinc-800 bg-zinc-950/40 p-4">
          <AsciiSpinner label="loading" />
        </div>
      ) : error ? (
        <div className="rounded border border-amber-900/60 bg-amber-950/30 p-4 text-sm text-amber-200">
          Not configured: set DATABASE_URL (and run migrations) to enable activities.
          {process.env.NODE_ENV !== 'production' ? <div className="mt-2 text-xs text-amber-200/80">Error: {error}</div> : null}
        </div>
      ) : activities.length === 0 ? (
        <div className="rounded border border-zinc-800 bg-zinc-950/40 p-4 text-sm text-zinc-300">No activity yet.</div>
      ) : (
        <div className="divide-y divide-zinc-800 rounded border border-zinc-800 bg-zinc-950/40">
          {activities.map((a) => (
            <ActivityRow key={`${a.kind}:${a.txHash}`} activity={a} chainId={chainId} />
          ))}
        </div>
      )}

      <div className="flex items-center gap-3 text-sm text-zinc-400">
        <button
          type="button"
          onClick={() => go(Math.max(1, page - 1))}
          disabled={!canPrev}
          className={cx([
            'px-1',
            !canPrev
              ? 'text-zinc-600 cursor-not-allowed'
              : 'hover:text-accent cursor-pointer'
          ])}
          aria-label="Previous page"
        >
          &lt;
        </button>

        <div className="tabular-nums text-xs text-zinc-500 select-none">
          Page {page} / {totalPages}
        </div>

        <button
          type="button"
          onClick={() => go(Math.min(totalPages, page + 1))}
          disabled={!canNext}
          className={cx([
            'px-1',
            !canNext
              ? 'text-zinc-600 cursor-not-allowed'
              : 'hover:text-accent cursor-pointer'
          ])}
          aria-label="Next page"
        >
          &gt;
        </button>
      </div>
    </div>
  );
}
