-- Support unlinked-recipient tips via onchain reservation + later claim.

-- Expand kind enum.
ALTER TABLE activities DROP CONSTRAINT IF EXISTS activities_kind_check;
ALTER TABLE activities
  ADD CONSTRAINT activities_kind_check
  CHECK (kind IN ('tip_mint','tip_reserve','claim','transfer'));

-- Extra fields for reserved tips + claims.
ALTER TABLE activities
  ADD COLUMN IF NOT EXISTS recipient_agent_id uuid,
  ADD COLUMN IF NOT EXISTS recipient_id_hash text,
  ADD COLUMN IF NOT EXISTS recipient_name text,
  ADD COLUMN IF NOT EXISTS claim_tx_hash text,
  ADD COLUMN IF NOT EXISTS claimed_at timestamptz;

CREATE INDEX IF NOT EXISTS activities_recipient_id_hash_idx ON activities (recipient_id_hash);
CREATE INDEX IF NOT EXISTS activities_claim_tx_hash_idx ON activities (claim_tx_hash);

