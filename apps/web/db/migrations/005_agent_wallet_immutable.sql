-- Enforce that an agent's linked wallet address cannot be changed after first link.

CREATE OR REPLACE FUNCTION prevent_agent_wallet_address_update() RETURNS trigger AS $$
BEGIN
  IF NEW.address IS DISTINCT FROM OLD.address THEN
    RAISE EXCEPTION 'wallet_address_immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_agent_wallet_address_immutable ON agent_wallets;
CREATE TRIGGER trg_agent_wallet_address_immutable
BEFORE UPDATE ON agent_wallets
FOR EACH ROW
EXECUTE FUNCTION prevent_agent_wallet_address_update();

