'use client';

import { useEffect, useRef } from 'react';

function nextDelayMs(baseMs: number, jitterRatio: number): number {
  const base = Math.max(1000, Math.floor(baseMs));
  const ratio = Math.max(0, Math.min(0.5, jitterRatio));
  const jitter = 1 + (Math.random() - 0.5) * 2 * ratio;
  return Math.max(1000, Math.floor(base * jitter));
}

/**
 * Poll `fn` on an interval while the tab is visible.
 * Uses setTimeout (not setInterval) to avoid overlap and add small jitter.
 */
export function useVisibilityPolling(params: {
  intervalMs: number;
  fn: () => Promise<void> | void;
  enabled?: boolean;
  jitterRatio?: number;
  // When this changes, the poller resets and triggers an immediate tick.
  key?: unknown;
}) {
  const { intervalMs, fn, enabled = true, jitterRatio = 0.1, key } = params;

  const timer = useRef<number | null>(null);
  const inFlight = useRef(false);
  const fnRef = useRef(params.fn);
  fnRef.current = fn;

  useEffect(() => {
    if (!enabled) return;

    let cancelled = false;

    const clear = () => {
      if (timer.current !== null) {
        window.clearTimeout(timer.current);
        timer.current = null;
      }
    };

    const tick = async () => {
      if (cancelled) return;

      // Don't poll in the background.
      if (document.visibilityState !== 'visible') {
        schedule();
        return;
      }

      // Avoid overlap if a slow request runs longer than the interval.
      if (inFlight.current) {
        schedule();
        return;
      }

      inFlight.current = true;
      try {
        await fnRef.current();
      } finally {
        inFlight.current = false;
      }

      schedule();
    };

    const schedule = () => {
      clear();
      timer.current = window.setTimeout(tick, nextDelayMs(intervalMs, jitterRatio));
    };

    const onVis = () => {
      if (document.visibilityState === 'visible') {
        // Refresh immediately when coming back.
        void tick();
      }
    };

    document.addEventListener('visibilitychange', onVis);

    // Initial fetch.
    void tick();

    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVis);
      clear();
    };
  }, [enabled, intervalMs, jitterRatio, key]);
}
