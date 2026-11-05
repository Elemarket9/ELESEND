-- New riders get the approved GH₵150 cash commission limit.
-- Existing riders keep their limit: moving them is an operations decision, not a migration.
ALTER TABLE commission_accounts ALTER COLUMN max_outstanding_minor SET DEFAULT 15000;
