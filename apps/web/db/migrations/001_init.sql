CREATE TABLE IF NOT EXISTS agents (
  moltbook_agent_id uuid PRIMARY KEY,
  moltbook_name text NOT NULL,
  description text,
  is_claimed boolean NOT NULL DEFAULT false,
  owner_x_handle text,
  owner_x_name text,
  owner_x_avatar text,
  owner_x_bio text,
  owner_x_follower_count integer,
  owner_x_following_count integer,
  owner_x_verified boolean,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS agent_wallets (
  moltbook_agent_id uuid PRIMARY KEY REFERENCES agents(moltbook_agent_id) ON DELETE CASCADE,
  address text NOT NULL,
  linked_post_id uuid,
  link_nonce text,
  issued_at timestamptz,
  signature text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS agent_wallets_address_idx ON agent_wallets ((lower(address)));

CREATE TABLE IF NOT EXISTS activities (
  id bigserial PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('tip_mint','transfer')),
  status text NOT NULL CHECK (status IN ('pending','confirmed','failed')),
  tx_hash text NOT NULL UNIQUE,
  chain_id bigint,
  block_number bigint,
  log_index integer,

  -- tip_mint fields
  tipper text,
  recipient text,
  gross_amount text,
  net_amount text,
  treasury_amount text,
  context text,
  context_hash text,

  -- transfer fields
  from_addr text,
  to_addr text,
  value text,

  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  confirmed_at timestamptz
);

CREATE INDEX IF NOT EXISTS activities_kind_status_created_idx ON activities (kind, status, created_at DESC);
CREATE INDEX IF NOT EXISTS activities_block_idx ON activities (block_number DESC, log_index DESC);
