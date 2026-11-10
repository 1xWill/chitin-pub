import { dbQuery } from '@/server/db';
import { fetchMoltxPostById, parseMoltxPostIdFromUrl } from '@/server/moltx';
import { ContextSourcePlugin, ResolveContextResult } from '@/server/sources/types';

export const moltxSource: ContextSourcePlugin = {
  id: 'moltx',

  match(url: URL): boolean {
    return url.hostname === 'moltx.io' || url.hostname === 'www.moltx.io';
  },

  async resolveRecipient(url: URL): Promise<ResolveContextResult> {
    const postId = parseMoltxPostIdFromUrl(url.toString());
    if (!postId) return { ok: false, error: 'unsupported_moltx_url' };

    const post = await fetchMoltxPostById(postId);

    // Map Moltx author -> canonical Moltbook agent id via alias proof.
    const rows = await dbQuery<{ moltbook_agent_id: string; moltbook_name: string | null }>(
      `
      SELECT a.moltbook_agent_id, a.moltbook_name
      FROM agent_aliases al
      JOIN agents a ON a.moltbook_agent_id=al.moltbook_agent_id
      WHERE al.source='moltx' AND al.source_agent_id=$1
      LIMIT 1
      `,
      [post.author_id]
    );

    const r = rows[0];
    if (!r) {
      return { ok: false, error: 'moltx_author_not_aliased' };
    }

    return {
      ok: true,
      recipient: {
        source: 'moltx',
        sourceAgentId: post.author_id,
        moltbookAgentId: r.moltbook_agent_id,
        moltbookName: r.moltbook_name ?? null
      }
    };
  }
};

