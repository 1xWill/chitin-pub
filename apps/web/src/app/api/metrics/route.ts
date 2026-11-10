import { NextResponse } from 'next/server';
import { getMetrics } from '@/server/metrics';

export async function GET() {
  try {
    const m = await getMetrics();
    return NextResponse.json(
      { success: true, metrics: m },
      { headers: { 'Cache-Control': 'public, s-maxage=10, stale-while-revalidate=60' } }
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ success: false, error: msg }, { status: 400 });
  }
}
