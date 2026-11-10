import { dbQuery } from '@/server/db';

/**
 * Acquire a small DB-backed lock with TTL (serverless-safe).
 *
 * Returns true if acquired. If the existing lock is newer than TTL, returns false.
 */
export async function acquireLock(params: { key: string; ttlSeconds: number }): Promise<boolean> {
  const key = String(params.key ?? '').trim();
  if (!key) throw new Error('lock_key_required');
  if (key.length > 200) throw new Error('lock_key_too_long');
  const ttl = Number(params.ttlSeconds);
  if (!Number.isInteger(ttl) || ttl <= 0) throw new Error('lock_ttl_invalid');

  const rows = await dbQuery<{ acquired_at: string }>(
    `
    WITH upsert AS (
      INSERT INTO system_locks (key, acquired_at)
      VALUES ($1, now())
      ON CONFLICT (key) DO UPDATE
        SET acquired_at = now()
      WHERE system_locks.acquired_at < now() - ($2::int * interval '1 second')
      RETURNING acquired_at
    )
    SELECT acquired_at FROM upsert
    `,
    [key, ttl]
  );

  return rows.length > 0;
}

export async function cleanupLocks(maxAgeSeconds: number): Promise<{ deleted: number }> {
  const age = Number(maxAgeSeconds);
  if (!Number.isInteger(age) || age <= 0) throw new Error('lock_cleanup_age_invalid');

  const rows = await dbQuery<{ deleted: number }>(
    `
    WITH deleted AS (
      DELETE FROM system_locks
      WHERE acquired_at < now() - ($1::int * interval '1 second')
      RETURNING 1
    )
    SELECT COUNT(*)::int AS deleted FROM deleted
    `,
    [age]
  );

  return { deleted: rows[0]?.deleted ?? 0 };
}

