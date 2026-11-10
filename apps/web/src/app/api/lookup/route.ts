import { NextResponse } from 'next/server';
import { z } from 'zod';
import { dbQuery } from '@/server/db';
import { fetchProfileByName } from '@/server/moltbook';
import { resolveRecipientFromContextUrl } from '@/server/sources';
import { getCredibilityByAgentId } from '@/server/credibility';

const QuerySchema = z.object({
  name: z.string().min(1).max(64).optional(),
  contextUrl: z.string().url().optional()
});

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const q = QuerySchema.parse(Object.fromEntries(url.searchParams.entries()));

    if (!q.name && !q.contextUrl) throw new Error('missing_name_or_contextUrl');
    if (q.name && q.contextUrl) throw new Error('provide_only_one_of_name_or_contextUrl');

    let agentId: string;
    let name: string;
    let isClaimed: boolean | null = null;
    let ownerXHandle: string | null = null;

    if (q.name) {
      const prof = await fetchProfileByName(q.name);
      agentId = prof.id;
      name = prof.name;
      isClaimed = prof.is_claimed;
      ownerXHandle = prof.owner?.x_handle ?? null;
    } else {
      const rr = await resolveRecipientFromContextUrl(q.contextUrl!);
      if (!rr.ok) throw new Error(rr.error);
      agentId = rr.recipient.moltbookAgentId;
      name = rr.recipient.moltbookName ?? rr.recipient.moltbookAgentId;
    }

    const rows = await dbQuery<{ address: string }>(`SELECT address FROM agent_wallets WHERE moltbook_agent_id=$1 LIMIT 1`, [
      agentId
    ]);

    const address = rows[0]?.address ?? null;
    const credibility = address ? await getCredibilityByAgentId(agentId) : null;

    return NextResponse.json(
      {
        success: true,
        agentId,
        name,
        linked: Boolean(address),
        ...(address ? { address } : {}),
        ...(credibility ? { credibility } : {}),
        ...(isClaimed !== null ? { isClaimed } : {}),
        ...(ownerXHandle !== null ? { ownerXHandle } : {})
      },
      { headers: { 'Cache-Control': 'public, s-maxage=30, stale-while-revalidate=300' } }
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ success: false, error: msg }, { status: 400 });
  }
}
