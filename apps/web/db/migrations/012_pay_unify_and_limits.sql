-- Unify TRANSFER and PAY into a single activity kind: 'pay'.
-- 'pay' may be "tax paid" (verified burn tx) or "tax unpaid" (no verified burn tx).
--
-- Also add length constraints to prevent out-of-memory / slow numeric casts from untrusted input.

-- Migrate existing rows first (while the old constraint still allows 'transfer').
UPDATE activities
SET kind='pay'
WHERE kind='transfer';

-- Replace kind enum: remove 'transfer', keep 'pay'.
ALTER TABLE activities DROP CONSTRAINT IF EXISTS activities_kind_check;
ALTER TABLE activities
  ADD CONSTRAINT activities_kind_check
  CHECK (kind IN ('tip','tip_mint','tip_reserve','claim','pay'));

-- Numeric-ish fields should always be uint256-sized (<=78 digits). Enforce in DB to avoid bloat/DoS.
ALTER TABLE activities DROP CONSTRAINT IF EXISTS activities_amounts_len;
ALTER TABLE activities
  ADD CONSTRAINT activities_amounts_len
  CHECK (
    (gross_amount IS NULL OR length(gross_amount) <= 78) AND
    (net_amount IS NULL OR length(net_amount) <= 78) AND
    (treasury_amount IS NULL OR length(treasury_amount) <= 78) AND
    (value IS NULL OR length(value) <= 78) AND
    (burn_amount IS NULL OR length(burn_amount) <= 78)
  );
