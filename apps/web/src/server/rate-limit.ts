import { dbQuery } from '@/server/db';
import crypto from 'node:crypto';

export type RateLimitResult = {
  ok: boolean;
  limit: number;
  remaining: number;
  resetAt: number; // unix seconds
};

export function getClientIp(req: Request): string {
  // In production on Vercel, only trust Vercel's header. Do NOT trust generic proxy headers because they
  // can be spoofed if the deployment isn't behind a trusted proxy that overwrites them.
  const vff = req.headers.get('x-vercel-forwarded-for');
  if (vff) {
    const first = vff.split(',')[0]?.trim();
    if (first) return first;
  }

  // Local dev / non-Vercel deployments: fall back to common proxy headers (best-effort).
  // NOTE: Do not rely on these for security in production.
  if (process.env.VERCEL) return 'unknown';

  // Prefer proxy-provided headers (typical in Vercel/Cloudflare/nginx).
  const xff = req.headers.get('x-forwarded-for');
  if (xff) {
    const first = xff.split(',')[0]?.trim();
    if (first) return first;
  }

  const realIp = req.headers.get('x-real-ip');
  if (realIp) return realIp.trim();

  const cf = req.headers.get('cf-connecting-ip');
  if (cf) return cf.trim();

  return 'unknown';
}

export function hashRateLimitId(v: string): string {
  // Avoid storing raw IPs / user-provided identifiers in DB keys.
  return crypto.createHash('sha256').update(v).digest('hex').slice(0, 32);
}

export async function consumeRateLimit(params: {
  key: string;
  windowSeconds: number;
  max: number;
}): Promise<RateLimitResult> {
  if (!params.key) throw new Error('rate_limit_key_required');
  if (params.key.length > 200) throw new Error('rate_limit_key_too_long');
  if (!Number.isInteger(params.windowSeconds) || params.windowSeconds <= 0) {
    throw new Error('rate_limit_window_invalid');
  }
  if (!Number.isInteger(params.max) || params.max <= 0) {
    throw new Error('rate_limit_max_invalid');
  }

  const now = Math.floor(Date.now() / 1000);
  const windowStart = Math.floor(now / params.windowSeconds) * params.windowSeconds;
  const resetAt = windowStart + params.windowSeconds;

  const rows = await dbQuery<{ count: number }>(
    `
    INSERT INTO rate_limits (key, window_start, count)
    VALUES ($1, $2, 1)
    ON CONFLICT (key)
    DO UPDATE SET
      window_start = CASE
        WHEN rate_limits.window_start = EXCLUDED.window_start THEN rate_limits.window_start
        ELSE EXCLUDED.window_start
      END,
      count = CASE
        WHEN rate_limits.window_start = EXCLUDED.window_start THEN rate_limits.count + 1
        ELSE 1
      END,
      updated_at=now()
    RETURNING count
    `,
    [params.key, windowStart]
  );

  const count = rows[0]?.count ?? 1;
  const remaining = Math.max(0, params.max - count);

  return {
    ok: count <= params.max,
    limit: params.max,
    remaining,
    resetAt
  };
}


export async function cleanupRateLimits(maxAgeSeconds: number): Promise<{ deleted: number }> {
  if (!Number.isInteger(maxAgeSeconds) || maxAgeSeconds <= 0) {
    throw new Error('rate_limit_cleanup_age_invalid');
  }

  const now = Math.floor(Date.now() / 1000);
  const cutoff = now - maxAgeSeconds;

  const rows = await dbQuery<{ deleted: number }>(
    `
    WITH deleted AS (
      DELETE FROM rate_limits
      WHERE window_start < $1
      RETURNING 1
    )
    SELECT COUNT(*)::int AS deleted FROM deleted
    `,
    [cutoff]
  );

  return { deleted: rows[0]?.deleted ?? 0 };
}
