-- AI Relay Gateway: key drop. Additive only: two new columns and no data statements.
-- Rows that exist before this migration keep every value. Their new columns read as NULL, or 'rule' for origin.

ALTER TABLE provider_keys ADD COLUMN status_code INTEGER;                       -- HTTP status that dropped the key; NULL for older keys
ALTER TABLE error_rules ADD COLUMN origin TEXT NOT NULL DEFAULT 'rule';         -- 'rule' for every existing rule; 'drop_list' marks a provider drop-list row
