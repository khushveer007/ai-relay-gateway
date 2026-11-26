ALTER TABLE request_logs ADD COLUMN cache_write_tokens INTEGER;
ALTER TABLE request_logs ADD COLUMN cost_nano_usd INTEGER;
ALTER TABLE request_logs ADD COLUMN cost_reason TEXT CHECK (cost_reason IN ('unpriced', 'no_usage'));
ALTER TABLE request_logs ADD COLUMN priced_model TEXT;
ALTER TABLE request_logs ADD COLUMN price_match_type TEXT CHECK (price_match_type IN ('pinned', 'exact', 'normalized', 'ambiguous', 'none'));
ALTER TABLE request_logs ADD COLUMN price_tier_threshold_tokens INTEGER;
ALTER TABLE request_logs ADD COLUMN cache_read_savings_nano_usd INTEGER;

CREATE INDEX idx_request_logs_upstream_model ON request_logs(upstream_model COLLATE BINARY)
  WHERE upstream_model IS NOT NULL AND upstream_model <> '';

CREATE TABLE model_prices (
  model TEXT NOT NULL COLLATE BINARY PRIMARY KEY,
  catalog_base TEXT NOT NULL DEFAULT '{}',
  override_base TEXT NOT NULL DEFAULT '{}',
  catalog_tier TEXT NOT NULL DEFAULT '{"state":"base","threshold_tokens":null,"rates":{}}',
  override_tier TEXT NOT NULL DEFAULT '{}',
  catalog_imported INTEGER NOT NULL DEFAULT 0 CHECK (catalog_imported IN (0, 1))
) STRICT;

CREATE TABLE model_price_aliases (
  upstream_model TEXT NOT NULL COLLATE BINARY PRIMARY KEY,
  priced_model TEXT NOT NULL COLLATE BINARY REFERENCES model_prices(model)
) STRICT;

CREATE TRIGGER model_price_capacity BEFORE INSERT ON model_prices
WHEN NOT EXISTS (SELECT 1 FROM model_prices WHERE model = NEW.model) AND (SELECT COUNT(*) FROM model_prices) >= 600
BEGIN
  SELECT RAISE(ABORT, 'model_price_capacity');
END;

CREATE TRIGGER model_alias_capacity BEFORE INSERT ON model_price_aliases
WHEN NOT EXISTS (SELECT 1 FROM model_price_aliases WHERE upstream_model = NEW.upstream_model) AND (SELECT COUNT(*) FROM model_price_aliases) >= 1024
BEGIN
  SELECT RAISE(ABORT, 'model_alias_capacity');
END;

INSERT INTO settings (key, value) VALUES ('cost_capture_since_ms', CAST(unixepoch('subsec') * 1000 AS INTEGER));

CREATE TABLE daily_cost_rollup (
  day_start_ms INTEGER NOT NULL CHECK (day_start_ms >= 0 AND day_start_ms % 86400000 = 0),
  upstream_model TEXT NOT NULL COLLATE BINARY,
  provider_id INTEGER NOT NULL CHECK (provider_id >= 0),
  gateway_key_id INTEGER NOT NULL CHECK (gateway_key_id >= 0),
  request_count INTEGER NOT NULL CHECK (request_count >= 0),
  priced_count INTEGER NOT NULL CHECK (priced_count >= 0),
  unpriced_count INTEGER NOT NULL CHECK (unpriced_count >= 0),
  no_usage_count INTEGER NOT NULL CHECK (no_usage_count >= 0),
  legacy_count INTEGER NOT NULL CHECK (legacy_count >= 0),
  cost_nano_usd INTEGER NOT NULL CHECK (cost_nano_usd >= 0),
  cache_read_tokens INTEGER NOT NULL CHECK (cache_read_tokens >= 0),
  cache_write_tokens INTEGER NOT NULL CHECK (cache_write_tokens >= 0),
  cache_read_savings_nano_usd INTEGER NOT NULL,
  cache_savings_known_count INTEGER NOT NULL CHECK (cache_savings_known_count >= 0),
  PRIMARY KEY (day_start_ms, upstream_model, provider_id, gateway_key_id)
) STRICT;

CREATE TABLE cost_rollup_progress (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  before_day_ms INTEGER NOT NULL CHECK (before_day_ms >= 0 AND before_day_ms % 86400000 = 0),
  through_request_id INTEGER NOT NULL CHECK (through_request_id >= 0)
) STRICT;

INSERT INTO cost_rollup_progress (id, before_day_ms, through_request_id) VALUES (1, 0, 0);

CREATE TRIGGER request_logs_require_cost_rollup BEFORE DELETE ON request_logs
WHEN NOT EXISTS (
  SELECT 1 FROM cost_rollup_progress
  WHERE id = 1 AND OLD.ts < before_day_ms AND OLD.id <= through_request_id
)
BEGIN
  SELECT RAISE(ABORT, 'cost_rollup_required');
END;
