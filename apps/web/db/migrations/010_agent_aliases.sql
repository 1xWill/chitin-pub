CREATE TABLE IF NOT EXISTS agent_aliases (
  id bigserial PRIMARY KEY,
  source text NOT NULL,
  source_agent_id uuid NOT NULL,
  moltbook_agent_id uuid NOT NULL REFERENCES agents(moltbook_agent_id) ON DELETE CASCADE,

  -- Where the alias proof was posted (e.g. https://moltx.io/post/<id>)
  proof_url text NOT NULL,
  proof_post_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS agent_aliases_source_agent_idx
  ON agent_aliases (source, source_agent_id);

-- One Moltbook agent can link at most one account per source.
CREATE UNIQUE INDEX IF NOT EXISTS agent_aliases_source_moltbook_idx
  ON agent_aliases (source, moltbook_agent_id);

CREATE INDEX IF NOT EXISTS agent_aliases_moltbook_idx
  ON agent_aliases (moltbook_agent_id);
