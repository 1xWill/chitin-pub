-- Small DB-based locks/cooldowns for serverless batch/throttle behavior.
-- This avoids per-request reconcile amplification (RPC + DB load) during bursts.

CREATE TABLE IF NOT EXISTS system_locks (
  key text PRIMARY KEY,
  acquired_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS system_locks_acquired_at_idx ON system_locks (acquired_at);

