import { dbQuery } from '@/server/db';
import { getChitinConfig } from '@/server/config';
import { reconcilePending } from '@/server/reconcile';

/**
 * Best-effort reconcile used by public "submit" endpoints (tip/link/transfer).
 *
 * In serverless, calling reconcile on every request can amplify upstream RPC cost.
 * We throttle via a DB row so bursts are handled in a small batch within a short window.
 */
export async function reconcileOnSubmitBestEffort(): Promise<void> {
  const cfg = getChitinConfig();
  const batchSize = cfg.reconcile.onSubmitBatchSize;
  if (!Number.isInteger(batchSize) || batchSize <= 0) return;

  const cooldown = cfg.reconcile.onSubmitCooldownSeconds ?? 15;
  if (cooldown <= 0) {
    await reconcilePending(batchSize);
    return;
  }

  // Acquire a simple "cooldown lock": only one reconcile runs per cooldown window across all instances.
  const rows = await dbQuery<{ acquired_at: string }>(
    `
    WITH upsert AS (
      INSERT INTO system_locks (key, acquired_at)
      VALUES ('reconcile_on_submit', now())
      ON CONFLICT (key) DO UPDATE
        SET acquired_at = now()
      WHERE system_locks.acquired_at < now() - ($1::int * interval '1 second')
      RETURNING acquired_at
    )
    SELECT acquired_at FROM upsert
    `,
    [cooldown]
  );

  if (rows.length === 0) return;

  await reconcilePending(batchSize);
}

