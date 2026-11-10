-- Allow wallet rotation (remove address immutability trigger) and support "tip" as a pending kind.

-- Drop immutability trigger if present (from older migrations).
DROP TRIGGER IF EXISTS trg_agent_wallet_address_immutable ON agent_wallets;
DROP FUNCTION IF EXISTS prevent_agent_wallet_address_update();

-- Expand kind enum to include 'tip' for pending tips (later reconciled to tip_mint or tip_reserve).
ALTER TABLE activities DROP CONSTRAINT IF EXISTS activities_kind_check;
ALTER TABLE activities
  ADD CONSTRAINT activities_kind_check
  CHECK (kind IN ('tip','tip_mint','tip_reserve','claim','transfer'));

