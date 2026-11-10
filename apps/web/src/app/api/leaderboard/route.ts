import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getLeaderboard, getTopTaxPayers, getTopTippedReceived } from '@/server/leaderboard';
import { getTopCredibility } from '@/server/credibility';

const QuerySchema = z.object({
  kind: z.enum(['holders', 'tipped', 'supporters', 'cred']).default('holders'),
  tf: z.enum(['24h', '7d', 'all']).default('24h'),
  order: z.enum(['asc', 'desc']).optional()
});

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const qs = QuerySchema.parse({
      kind: url.searchParams.get('kind') ?? undefined,
      tf: url.searchParams.get('tf') ?? undefined,
      order: url.searchParams.get('order') ?? undefined
    });

    const tf = (qs.kind === 'holders' || qs.kind === 'cred') ? 'all' : qs.tf;

    if (qs.kind === 'holders') {
      const rows = await getLeaderboard(50);
      return NextResponse.json({ success: true, kind: qs.kind, tf, rows }, { headers: { 'Cache-Control': 'no-store' } });
    }

    if (qs.kind === 'tipped') {
      const rows = await getTopTippedReceived(50, tf);
      return NextResponse.json({ success: true, kind: qs.kind, tf, rows }, { headers: { 'Cache-Control': 'no-store' } });
    }

    if (qs.kind === 'supporters') {
      const rows = await getTopTaxPayers(50, tf);
      return NextResponse.json({ success: true, kind: qs.kind, tf, rows }, { headers: { 'Cache-Control': 'no-store' } });
    }

    const rows = await getTopCredibility(50, qs.order === 'asc' ? 'asc' : 'desc');
    return NextResponse.json({ success: true, kind: qs.kind, tf, rows }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ success: false, error: msg }, { status: 400 });
  }
}
