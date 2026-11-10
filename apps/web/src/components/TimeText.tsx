'use client';

import { useEffect, useMemo, useState } from 'react';

function formatLocal(ts: number): string {
  const d = new Date(ts);
  // 03/02/2026 15:29:11 (local time, 24h)
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const yyyy = String(d.getFullYear());
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${mm}/${dd}/${yyyy} ${hh}:${mi}:${ss}`;
}

function formatRelative(nowMs: number, thenMs: number): string {
  const deltaS = Math.max(0, Math.floor((nowMs - thenMs) / 1000));
  if (deltaS < 60) return `${deltaS}s ago`;
  if (deltaS < 60 * 60) return `${Math.floor(deltaS / 60)}m ago`;
  if (deltaS < 60 * 60 * 24) return `${Math.floor(deltaS / (60 * 60))}h ago`;
  return formatLocal(thenMs);
}

export function TimeText({ iso }: { iso: string }) {
  const thenMs = useMemo(() => new Date(iso).getTime(), [iso]);
  const [text, setText] = useState<string>(''); // avoid SSR locale/timezone mismatch

  useEffect(() => {
    const tick = () => setText(formatRelative(Date.now(), thenMs));
    tick();

    // Update frequently enough for "within 24h" relative display without being noisy.
    const id = setInterval(tick, 30_000);
    return () => clearInterval(id);
  }, [thenMs]);

  return <span suppressHydrationWarning>{text || '—'}</span>;
}
