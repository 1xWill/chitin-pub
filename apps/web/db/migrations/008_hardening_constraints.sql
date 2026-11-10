-- Hardening: basic length constraints to prevent DB bloat from untrusted inputs.

ALTER TABLE rate_limits DROP CONSTRAINT IF EXISTS rate_limits_key_len;
ALTER TABLE rate_limits
  ADD CONSTRAINT rate_limits_key_len
  CHECK (length(key) <= 200);

ALTER TABLE agents DROP CONSTRAINT IF EXISTS agents_moltbook_name_len;
ALTER TABLE agents
  ADD CONSTRAINT agents_moltbook_name_len
  CHECK (length(moltbook_name) <= 64);

ALTER TABLE agent_wallets DROP CONSTRAINT IF EXISTS agent_wallets_address_len;
ALTER TABLE agent_wallets
  ADD CONSTRAINT agent_wallets_address_len
  CHECK (length(address) <= 42);

ALTER TABLE activities DROP CONSTRAINT IF EXISTS activities_tx_hash_len;
ALTER TABLE activities
  ADD CONSTRAINT activities_tx_hash_len
  CHECK (length(tx_hash) <= 66);

ALTER TABLE activities DROP CONSTRAINT IF EXISTS activities_context_len;
ALTER TABLE activities
  ADD CONSTRAINT activities_context_len
  CHECK (context IS NULL OR length(context) <= 1024);

ALTER TABLE activities DROP CONSTRAINT IF EXISTS activities_recipient_name_len;
ALTER TABLE activities
  ADD CONSTRAINT activities_recipient_name_len
  CHECK (recipient_name IS NULL OR length(recipient_name) <= 64);

ALTER TABLE activities DROP CONSTRAINT IF EXISTS activities_claim_tx_hash_len;
ALTER TABLE activities
  ADD CONSTRAINT activities_claim_tx_hash_len
  CHECK (claim_tx_hash IS NULL OR length(claim_tx_hash) <= 66);

ALTER TABLE activities DROP CONSTRAINT IF EXISTS activities_recipient_id_hash_len;
ALTER TABLE activities
  ADD CONSTRAINT activities_recipient_id_hash_len
  CHECK (recipient_id_hash IS NULL OR length(recipient_id_hash) <= 66);

ALTER TABLE activities DROP CONSTRAINT IF EXISTS activities_addresses_len;
ALTER TABLE activities
  ADD CONSTRAINT activities_addresses_len
  CHECK (
    (tipper IS NULL OR length(tipper) <= 42) AND
    (recipient IS NULL OR length(recipient) <= 42) AND
    (from_addr IS NULL OR length(from_addr) <= 42) AND
    (to_addr IS NULL OR length(to_addr) <= 42)
  );

ALTER TABLE agent_wallet_events DROP CONSTRAINT IF EXISTS agent_wallet_events_addr_len;
ALTER TABLE agent_wallet_events
  ADD CONSTRAINT agent_wallet_events_addr_len
  CHECK (
    (old_address IS NULL OR length(old_address) <= 42) AND
    length(new_address) <= 42
  );

ALTER TABLE agent_wallet_events DROP CONSTRAINT IF EXISTS agent_wallet_events_nonce_len;
ALTER TABLE agent_wallet_events
  ADD CONSTRAINT agent_wallet_events_nonce_len
  CHECK (nonce IS NULL OR length(nonce) <= 128);

ALTER TABLE agent_wallet_events DROP CONSTRAINT IF EXISTS agent_wallet_events_sig_len;
ALTER TABLE agent_wallet_events
  ADD CONSTRAINT agent_wallet_events_sig_len
  CHECK (
    (old_signature IS NULL OR length(old_signature) <= 400) AND
    (new_signature IS NULL OR length(new_signature) <= 400)
  );

