import { z } from 'zod';
import { getChitinConfig } from '@/server/config';

async function fetchJson(url: string): Promise<unknown> {
  const cfg = getChitinConfig();
  const timeoutMs = cfg.moltbook.fetchTimeoutMs ?? 8000;
  const retries = cfg.moltbook.fetchRetries ?? 1;

  let lastErr: unknown = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetch(url, { method: 'GET', signal: ac.signal });
      if (!res.ok) {
        // Retry on transient upstream issues.
        if ((res.status >= 500 || res.status === 429) && attempt < retries) {
          lastErr = new Error('Moltbook fetch failed: ' + res.status);
          continue;
        }
        throw new Error('Moltbook fetch failed: ' + res.status);
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
  throw new Error('Moltbook fetch failed: ' + msg);
}

const MoltbookPostSchema = z.object({
  id: z.string(),
  title: z.string().nullable(),
  content: z.string(),
  created_at: z.string(),
  submolt: z.object({ name: z.string() }),
  author: z.object({ id: z.string(), name: z.string() })
});

const MoltbookPostsResponseSchema = z.object({
  success: z.boolean(),
  posts: z.array(MoltbookPostSchema).optional(),
  has_more: z.boolean().optional(),
  next_offset: z.number().int().optional()
});

const MoltbookPostResponseSchema = z.object({
  success: z.boolean(),
  post: MoltbookPostSchema.optional()
});

export type MoltbookPost = z.infer<typeof MoltbookPostSchema>;

export type MoltbookProfile = {
  id: string;
  name: string;
  description: string | null;
  is_claimed: boolean;
  owner: {
    x_handle: string | null;
    x_name: string | null;
    x_avatar: string | null;
    x_bio: string | null;
    x_follower_count: number | null;
    x_following_count: number | null;
    x_verified: boolean | null;
  } | null;
};

const MoltbookProfileSchema = z.object({
  success: z.boolean(),
  agent: z
    .object({
      id: z.string(),
      name: z.string(),
      description: z.string().nullable().optional(),
      is_claimed: z.boolean().optional(),
      owner: z
        .object({
          x_handle: z.string().nullable().optional(),
          x_name: z.string().nullable().optional(),
          x_avatar: z.string().nullable().optional(),
          x_bio: z.string().nullable().optional(),
          x_follower_count: z.number().int().nullable().optional(),
          x_following_count: z.number().int().nullable().optional(),
          x_verified: z.boolean().nullable().optional()
        })
        .nullable()
        .optional()
    })
    .optional()
});

function apiBase(): string {
  return getChitinConfig().moltbook.apiBase;
}

export async function fetchPostsPage(params: {
  submolt: string;
  sort?: 'new' | 'top';
  limit?: number;
  offset?: number;
}): Promise<{ posts: MoltbookPost[]; nextOffset: number | null }> {
  const url = new URL(apiBase() + '/posts');
  url.searchParams.set('submolt', params.submolt);
  url.searchParams.set('sort', params.sort ?? 'new');
  url.searchParams.set('limit', String(params.limit ?? 25));
  if (typeof params.offset === 'number') url.searchParams.set('offset', String(params.offset));
  const json = MoltbookPostsResponseSchema.parse(await fetchJson(url.toString()));
  if (!json.success) {
    throw new Error('Moltbook posts response not success');
  }

  const posts = json.posts ?? [];
  const nextOffset = json.has_more ? json.next_offset ?? null : null;
  return { posts, nextOffset };
}

export async function fetchPostById(postId: string): Promise<MoltbookPost> {
  const url = new URL(apiBase() + '/posts/' + encodeURIComponent(postId));
  const json = MoltbookPostResponseSchema.parse(await fetchJson(url.toString()));
  if (!json.success || !json.post) {
    throw new Error('Moltbook post response not success');
  }

  return json.post;
}

export async function findRecentPost(params: {
  submolt: string;
  maxPages?: number;
  match: (post: MoltbookPost) => boolean;
}): Promise<MoltbookPost | null> {
  let offset: number | null = 0;
  const maxPages = params.maxPages ?? 10;

  for (let i = 0; i < maxPages; i++) {
    if (offset === null) return null;

    const page = await fetchPostsPage({ submolt: params.submolt, offset, limit: getChitinConfig().moltbook.postsPageSize, sort: 'new' });
    const found = page.posts.find(params.match);
    if (found) return found;

    offset = page.nextOffset;
  }

  return null;
}

export async function fetchProfileByName(name: string): Promise<MoltbookProfile> {
  const url = new URL(apiBase() + '/agents/profile');
  url.searchParams.set('name', name);
  const parsed = MoltbookProfileSchema.parse(await fetchJson(url.toString()));
  if (!parsed.success || !parsed.agent) {
    throw new Error('Moltbook profile missing agent');
  }

  return {
    id: parsed.agent.id,
    name: parsed.agent.name,
    description: parsed.agent.description ?? null,
    is_claimed: parsed.agent.is_claimed ?? false,
    owner: parsed.agent.owner
      ? {
          x_handle: parsed.agent.owner.x_handle ?? null,
          x_name: parsed.agent.owner.x_name ?? null,
          x_avatar: parsed.agent.owner.x_avatar ?? null,
          x_bio: parsed.agent.owner.x_bio ?? null,
          x_follower_count: parsed.agent.owner.x_follower_count ?? null,
          x_following_count: parsed.agent.owner.x_following_count ?? null,
          x_verified: parsed.agent.owner.x_verified ?? null
        }
      : null
  };
}
