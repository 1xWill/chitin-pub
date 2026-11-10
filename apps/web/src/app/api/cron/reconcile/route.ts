import { NextResponse } from 'next/server';
import { cleanupOldPendingActivities, reconcilePending } from '@/server/reconcile';
import { getChitinConfig } from '@/server/config';
import { cleanupRateLimits } from '@/server/rate-limit';
import { burnUnusedBudgetForPreviousEpochIfNeeded } from '@/server/burn';
import { cleanupLocks } from '@/server/locks';
import { CronLimitQuerySchema, requireCronAuth } from '@/server/cron-auth';

export async function GET(req: Request) {
  try {
    requireCronAuth(req);

    const url = new URL(req.url);
    const q = CronLimitQuerySchema.parse(Object.fromEntries(url.searchParams.entries()));

    const limit = Math.min(q.limit ?? 100, 500);

    // Best-effort housekeeping to prevent unbounded rate limiter growth.
    let rlDeleted = 0;
    try {
      rlDeleted = (await cleanupRateLimits(getChitinConfig().rateLimit.cleanupMaxAgeSeconds)).deleted;
    } catch {
      // ignore
    }

    // Best-effort housekeeping for lock rows.
    let locksDeleted = 0;
    try {
      const maxAge = getChitinConfig().locks?.cleanupMaxAgeSeconds ?? 60 * 60 * 24 * 7;
      locksDeleted = (await cleanupLocks(maxAge)).deleted;
    } catch {
      // ignore
    }

    // Best-effort cleanup of stale pending activities (e.g. junk transfer submits).
    let pendingDeleted = 0;
    try {
      const maxAge = getChitinConfig().reconcile.pendingMaxAgeSeconds ?? 60 * 60 * 24 * 7;
      pendingDeleted = (await cleanupOldPendingActivities(maxAge)).deleted;
    } catch {
      // ignore
    }
    const res = await reconcilePending(limit);

    // Best-effort burn of previous epoch's unused budget (weekly unused-budget burn), derived from onchain UTC day.
    // This keeps emissions accounting consistent even if no one tips right after an epoch boundary.
    let burn = null;
    try {
      burn = await burnUnusedBudgetForPreviousEpochIfNeeded();
    } catch {
      burn = null;
    }

    return NextResponse.json({
      success: true,
      ...res,
      rateLimitDeleted: rlDeleted,
      locksDeleted,
      pendingDeleted,
      burnUnusedCap: burn
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const status = msg === 'unauthorized' ? 401 : msg.startsWith('Missing env ') ? 500 : 400;
    return NextResponse.json({ success: false, error: msg }, { status });
  }
}
