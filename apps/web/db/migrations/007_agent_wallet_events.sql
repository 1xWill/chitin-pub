-- Audit trail for wallet links/rotations (the canonical proof is the Moltbook post; this is an index).

CREATE TABLE IF NOT EXISTS agent_wallet_events (
  id bigserial PRIMARY KEY,
  moltbook_agent_id uuid NOT NULL REFERENCES agents(moltbook_agent_id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('link','rotate')),
  old_address text,
  new_address text NOT NULL,
  moltbook_post_id uuid,
  nonce text,
  issued_at timestamptz,
  old_signature text,
  new_signature text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS agent_wallet_events_agent_idx ON agent_wallet_events (moltbook_agent_id, created_at DESC);

