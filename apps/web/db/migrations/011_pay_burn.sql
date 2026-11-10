-- Support PAY as a transfer + verified burn tx (social deflation rule enforced by backend verification).

-- Add kind 'pay' (represents a transfer accompanied by a burn()).
ALTER TABLE activities DROP CONSTRAINT IF EXISTS activities_kind_check;
ALTER TABLE activities
  ADD CONSTRAINT activities_kind_check
  CHECK (kind IN ('tip','tip_mint','tip_reserve','claim','transfer','pay'));

-- Store optional burn tx hash + burn amount (wei).
ALTER TABLE activities
  ADD COLUMN IF NOT EXISTS burn_tx_hash text,
  ADD COLUMN IF NOT EXISTS burn_amount text;

CREATE INDEX IF NOT EXISTS activities_burn_tx_hash_idx ON activities (burn_tx_hash);

-- Hardening constraints for new columns.
ALTER TABLE activities DROP CONSTRAINT IF EXISTS activities_burn_tx_hash_len;
ALTER TABLE activities
  ADD CONSTRAINT activities_burn_tx_hash_len
  CHECK (burn_tx_hash IS NULL OR length(burn_tx_hash) <= 66);

ALTER TABLE activities DROP CONSTRAINT IF EXISTS activities_burn_amount_len;
ALTER TABLE activities
  ADD CONSTRAINT activities_burn_amount_len
  CHECK (burn_amount IS NULL OR length(burn_amount) <= 100);
