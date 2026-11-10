-- Rate limiting counters for public endpoints (anti-abuse).
-- We keep this DB-backed so it works on serverless and across multiple instances.

CREATE TABLE IF NOT EXISTS rate_limits (
  key text PRIMARY KEY,
  window_start bigint NOT NULL,
  count integer NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS rate_limits_window_start_idx ON rate_limits (window_start);
