CREATE TABLE IF NOT EXISTS agent_balances (
  moltbook_agent_id uuid PRIMARY KEY REFERENCES agents(moltbook_agent_id) ON DELETE CASCADE,
  address text NOT NULL,
  balance_wei text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS agent_balances_address_idx ON agent_balances ((lower(address)));
