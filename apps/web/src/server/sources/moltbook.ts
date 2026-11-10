import { fetchPostById } from '@/server/moltbook';
import { ContextSourcePlugin, ResolveContextResult } from '@/server/sources/types';

function parseMoltbookPostIdFromUrl(u: string): string | null {
  try {
    const url = new URL(u);
    if (!url.hostname.endsWith('moltbook.com')) return null;

    // Common patterns:
    // - https://www.moltbook.com/post/<uuid>
    // - https://www.moltbook.com/posts/<uuid> (defensive)
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts.length !== 2) return null;
    const [kind, id] = parts;
    if (kind !== 'post' && kind !== 'posts') return null;
    if (!/^[0-9a-fA-F-]{36}$/.test(id)) return null;
    return id;
  } catch {
    return null;
  }
}

export const moltbookSource: ContextSourcePlugin = {
  id: 'moltbook',

  match(url: URL): boolean {
    return url.hostname.endsWith('moltbook.com');
  },

  async resolveRecipient(url: URL): Promise<ResolveContextResult> {
    const postId = parseMoltbookPostIdFromUrl(url.toString());
    if (!postId) return { ok: false, error: 'unsupported_moltbook_url' };

    const post = await fetchPostById(postId);
    return {
      ok: true,
      recipient: {
        source: 'moltbook',
        sourceAgentId: post.author.id,
        moltbookAgentId: post.author.id,
        moltbookName: post.author.name
      }
    };
  }
};

