'use client';

import type { ReactNode } from 'react';
import { useCallback, useMemo, useState } from 'react';
import { AsciiSpinner } from '@/components/AsciiSpinner';
import { useVisibilityPolling } from '@/lib/useVisibilityPolling';
import { formatChitinWeiUi } from '@/lib/chitin-format';

type Metrics = {
  chitinizedAgents: number;
  totalTippedGrossWei: string;
  totalSupplyWei: string;
  circulatingSupplyWei: string;
  totalBurnedWei: string;
};

type ApiOk = { success: true; metrics: Metrics };
type ApiErr = { success: false; error: string };

function MetricCard({ label, value }: { label: ReactNode; value: ReactNode }) {
  return (
    <div className="rounded border border-zinc-800 bg-zinc-950/40 p-4">
      <div className="text-xs tracking-wide text-zinc-500">{label}</div>
      <div className="mt-1 text-2xl font-semibold text-zinc-100">{value}</div>
    </div>
  );
}

export function MetricsGridClient({ pollIntervalSeconds }: { pollIntervalSeconds: number }) {
  const endpoint = useMemo(() => `/api/metrics`, []);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [metrics, setMetrics] = useState<Metrics | null>(null);

  const fetchOnce = useCallback(async () => {
    try {
      const res = await fetch(endpoint, { cache: 'no-store' });
      const json = (await res.json()) as ApiOk | ApiErr;

      if (!res.ok) {
        setError(`http_${res.status}`);
        setLoading(false);
        return;
      }

      if (!json.success) {
        setError(json.error);
        setLoading(false);
        return;
      }

      setError(null);
      setMetrics(json.metrics);
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
      <div className="rounded border border-zinc-800 bg-zinc-950/40 p-4 sm:col-span-2 lg:col-span-4">
        <AsciiSpinner label="loading" />
      </div>
    );
  }

  if (error || !metrics) {
    return (
      <div className="rounded border border-zinc-800 bg-zinc-950/40 p-4 text-sm text-zinc-400 sm:col-span-2 lg:col-span-4">
        Metrics unavailable (configure chain + DB to enable).
      </div>
    );
  }

  return (
    <>
      <MetricCard
        label={
          <>
            <span className="text-zinc-300">CHITIN&apos;d</span> <span className="text-zinc-500">AGENTS</span>
          </>
        }
        value={metrics.chitinizedAgents}
      />
      <MetricCard label="Total tipped $CHITIN" value={formatChitinWeiUi(metrics.totalTippedGrossWei)} />
      <MetricCard label="Circulating $CHITIN" value={formatChitinWeiUi(metrics.circulatingSupplyWei)} />
      <MetricCard label="Total burned $CHITIN" value={formatChitinWeiUi(metrics.totalBurnedWei)} />
    </>
  );
}
