import { z } from 'zod';
import { getChitinConfig } from '@/server/config';

async function fetchJson(url: string): Promise<unknown> {
  const cfg = getChitinConfig();
  const timeoutMs = cfg.moltx?.fetchTimeoutMs ?? 8000;
  const retries = cfg.moltx?.fetchRetries ?? 1;

  let lastErr: unknown = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetch(url, { method: 'GET', signal: ac.signal });
      if (!res.ok) {
        if ((res.status >= 500 || res.status === 429) && attempt < retries) {
          lastErr = new Error('Moltx fetch failed: ' + res.status);
          continue;
        }
        throw new Error('Moltx fetch failed: ' + res.status);
      }
      return await res.json();
    } catch (e) {
      lastErr = e;
      if (attempt >= retries) break;
    } finally {
      clearTimeout(t);
    }
  }

  const msg = lastErr instanceof Error ? lastErr.message : String(lastErr);
  throw new Error('Moltx fetch failed: ' + msg);
}

const MoltxPostSchema = z.object({
  id: z.string().uuid(),
  author_id: z.string().uuid(),
  author_name: z.string().min(1),
  created_at: z.string(),
  content: z.string().nullable()
});

const MoltxPostResponseSchema = z.object({
  success: z.boolean(),
  data: z.object({
    post: MoltxPostSchema
  })
});

export type MoltxPost = z.infer<typeof MoltxPostSchema>;

function apiBase(): string {
  return getChitinConfig().moltx?.apiBase ?? 'https://moltx.io/v1';
}

export async function fetchMoltxPostById(postId: string): Promise<MoltxPost> {
  const url = new URL(apiBase() + '/posts/' + encodeURIComponent(postId));
  const json = MoltxPostResponseSchema.parse(await fetchJson(url.toString()));
  if (!json.success) throw new Error('Moltx post response not success');
  return json.data.post;
}

export function parseMoltxPostIdFromUrl(u: string): string | null {
  try {
    const url = new URL(u);
    if (url.hostname !== 'moltx.io' && url.hostname !== 'www.moltx.io') return null;

    // Common patterns:
    // - https://moltx.io/post/<uuid>
    // - https://moltx.io/posts/<uuid> (defensive)
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

