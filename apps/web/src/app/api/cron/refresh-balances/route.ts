import { NextResponse } from 'next/server';
import { refreshBalances } from '@/server/leaderboard';
import { CronLimitQuerySchema, requireCronAuth } from '@/server/cron-auth';

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    requireCronAuth(req);
    const q = CronLimitQuerySchema.parse(Object.fromEntries(url.searchParams.entries()));

    const limit = q.limit ?? 500;
    await refreshBalances(limit);

    return NextResponse.json({ success: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const status = msg === 'unauthorized' ? 401 : msg.startsWith('Missing env ') ? 500 : 400;
    return NextResponse.json({ success: false, error: msg }, { status });
  }
}
