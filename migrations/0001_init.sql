-- AI Relay Gateway: initial schema
-- All timestamps are Unix epoch milliseconds.

CREATE TABLE providers (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  name              TEXT    NOT NULL UNIQUE,
  base_url          TEXT    NOT NULL,
  -- JSON array of supported wire formats: "anthropic" | "openai-chat" | "openai-responses"
  formats           TEXT    NOT NULL DEFAULT '["anthropic","openai-chat","openai-responses"]',
  key_strategy      TEXT    NOT NULL DEFAULT 'sequential',      -- sequential | round_robin
  model_map         TEXT    NOT NULL DEFAULT '{}',              -- JSON {"client-model or glob": "upstream-model"}
  models            TEXT    NOT NULL DEFAULT '[]',              -- JSON array, fetched from /v1/models
  models_fetched_at INTEGER,
  model_allowlist   INTEGER NOT NULL DEFAULT 0,                 -- 1 = only serve models in `models` / model_map
  balance_mode      TEXT    NOT NULL DEFAULT 'standard',        -- standard | custom | none
  balance_path      TEXT,                                       -- custom mode: e.g. /api/user/self
  balance_field     TEXT,                                       -- custom mode: e.g. data.quota
  balance_divisor   REAL    NOT NULL DEFAULT 1,                 -- custom mode: e.g. 500000 for new-api quota units
  recheck_mode      TEXT    NOT NULL DEFAULT 'auto',            -- auto (balance → test request) | balance | manual
  recheck_hours     REAL    NOT NULL DEFAULT 6,
  test_model        TEXT,                                       -- model used for 1-token test requests
  parse_usage       INTEGER NOT NULL DEFAULT 1,
  timeout_ms        INTEGER NOT NULL DEFAULT 60000,             -- max wait for response headers
  extra_headers     TEXT    NOT NULL DEFAULT '{}',              -- JSON, sent with every upstream request
  enabled           INTEGER NOT NULL DEFAULT 1,
  created_at        INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

CREATE TABLE provider_keys (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  provider_id        INTEGER NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  alias              TEXT    NOT NULL DEFAULT '',
  key_enc            TEXT    NOT NULL,                          -- AES-GCM encrypted, base64(iv || ciphertext)
  key_hint           TEXT    NOT NULL DEFAULT '',               -- e.g. sk-a…9f3c
  priority           INTEGER NOT NULL DEFAULT 0,                -- lower = used first
  status             TEXT    NOT NULL DEFAULT 'active',         -- active | exhausted | rate_limited | invalid | disabled
  status_reason      TEXT,
  status_changed_at  INTEGER,
  cooldown_until     INTEGER,
  next_recheck_at    INTEGER,
  balance            REAL,
  balance_checked_at INTEGER,
  created_at         INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
CREATE INDEX idx_provider_keys_provider ON provider_keys(provider_id, priority);

CREATE TABLE routes (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  name           TEXT    NOT NULL UNIQUE,
  model_patterns TEXT    NOT NULL DEFAULT '[]',                 -- JSON array of globs, e.g. ["claude-*"]
  is_default     INTEGER NOT NULL DEFAULT 0,
  position       INTEGER NOT NULL DEFAULT 0,
  created_at     INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

CREATE TABLE route_providers (
  route_id    INTEGER NOT NULL REFERENCES routes(id) ON DELETE CASCADE,
  provider_id INTEGER NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  position    INTEGER NOT NULL,
  PRIMARY KEY (route_id, provider_id)
);

CREATE TABLE error_rules (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  provider_id  INTEGER REFERENCES providers(id) ON DELETE CASCADE,  -- NULL = global rule
  priority     INTEGER NOT NULL DEFAULT 100,                         -- lower = evaluated first
  status_codes TEXT    NOT NULL DEFAULT '',                          -- e.g. "402" or "500-599,408"; empty = any
  body_regex   TEXT,                                                 -- case-insensitive; NULL = any body
  action       TEXT    NOT NULL,                                     -- EXHAUSTED | INVALID_KEY | RATE_LIMITED | UPSTREAM_ERROR | CLIENT_ERROR
  cooldown_s   INTEGER,                                              -- RATE_LIMITED only
  note         TEXT,
  enabled      INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE gateway_keys (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT    NOT NULL,
  key_hash   TEXT    NOT NULL UNIQUE,                                -- SHA-256 hex
  key_prefix TEXT    NOT NULL,                                       -- first chars, for display
  route_id   INTEGER REFERENCES routes(id) ON DELETE SET NULL,       -- NULL = match route by model pattern
  enabled    INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

CREATE TABLE request_logs (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  ts             INTEGER NOT NULL,
  gateway_key_id INTEGER,
  route_id       INTEGER,
  format         TEXT,
  path           TEXT,
  model          TEXT,
  upstream_model TEXT,
  provider_id    INTEGER,
  key_id         INTEGER,
  status         INTEGER,
  stream         INTEGER NOT NULL DEFAULT 0,
  latency_ms     INTEGER,
  ttfb_ms        INTEGER,
  input_tokens   INTEGER,
  output_tokens  INTEGER,
  cache_tokens   INTEGER,
  failovers      INTEGER NOT NULL DEFAULT 0,
  attempts       TEXT,                                               -- JSON trail of attempts
  error          TEXT
);
CREATE INDEX idx_request_logs_ts ON request_logs(ts);

CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- ---------------------------------------------------------------- seeds

INSERT INTO settings (key, value) VALUES
  ('log_retention_days', '7'),
  ('max_attempts', '10'),
  ('balance_refresh_hours', '6'),
  ('config_version', '1');

INSERT INTO routes (name, model_patterns, is_default, position) VALUES ('default', '[]', 1, 1000);

-- Default global error rules (evaluated in priority order; provider-specific rules always run first).
INSERT INTO error_rules (provider_id, priority, status_codes, body_regex, action, cooldown_s, note) VALUES
  (NULL, 10, '',
   'insufficient[_ ]?(quota|balance|credit|funds)|余额不足|额度不足|额度已用尽|预扣费|quota[^"]{0,40}(exceeded|exhausted|insufficient|used up)|credit balance is too low|out of credits|balance[^"]{0,30}(insufficient|not enough|too low|exhausted)|billing[_ ]?(hard[_ ]?limit|not[_ ]?active)|exceeded your current quota|payment required',
   'EXHAUSTED', NULL, 'Out-of-balance messages (OpenAI, Anthropic, new-api / one-api, Chinese relays)'),
  (NULL, 20, '402', NULL, 'EXHAUSTED', NULL, 'HTTP 402 Payment Required'),
  (NULL, 30, '',
   'invalid[_ ]?(api[_ ]?key|token|x-api-key|authentication)|incorrect api key|api key not valid|无效的令牌|令牌已过期|令牌已被禁用|令牌状态不可用|token[^"]{0,30}(expired|disabled|not found|invalid)|authentication[_ ]?error',
   'INVALID_KEY', NULL, 'Invalid / expired / disabled key messages'),
  (NULL, 35, '',
   'model_not_found|no available channel|无可用渠道|not supported model|model[^"]{0,60}(not found|not available|does not exist|not supported)',
   'UPSTREAM_ERROR', NULL, 'Model not available on this relay → try next provider'),
  (NULL, 40, '401', NULL, 'INVALID_KEY', NULL, 'HTTP 401 Unauthorized'),
  (NULL, 50, '403', NULL, 'RATE_LIMITED', 600, 'HTTP 403 without a known message → skip key for 10 min'),
  (NULL, 60, '429', NULL, 'RATE_LIMITED', 60, 'HTTP 429 without quota text → cooldown (Retry-After honored)'),
  (NULL, 70, '408,500-599', NULL, 'UPSTREAM_ERROR', NULL, 'Server errors / overloaded (529) → next provider'),
  (NULL, 80, '400-499', NULL, 'CLIENT_ERROR', NULL, 'Other 4xx → return to client, no retry');
