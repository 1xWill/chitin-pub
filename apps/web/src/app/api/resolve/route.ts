import { NextResponse } from 'next/server';
import { z } from 'zod';
import { resolveByName } from '@/server/link';

const QuerySchema = z.object({
  name: z.string().min(1).max(64)
});

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const q = QuerySchema.parse(Object.fromEntries(url.searchParams.entries()));

    const found = await resolveByName(q.name);
    if (!found) {
      return NextResponse.json({ success: false, error: 'not_found' }, { status: 404 });
    }

    return NextResponse.json(
      { success: true, agentId: found.agentId, address: found.address },
      { headers: { 'Cache-Control': 'public, s-maxage=30, stale-while-revalidate=300' } }
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const status = msg.includes(' 404') ? 404 : 400;
    const error = status === 404 ? 'not_found' : msg;
    return NextResponse.json({ success: false, error }, { status });
  }
}
