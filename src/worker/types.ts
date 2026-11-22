export type Format = 'anthropic' | 'openai-chat' | 'openai-responses';
export const ALL_FORMATS: Format[] = ['anthropic', 'openai-chat', 'openai-responses'];

export type Action = 'EXHAUSTED' | 'INVALID_KEY' | 'RATE_LIMITED' | 'UPSTREAM_ERROR' | 'CLIENT_ERROR';
export const ALL_ACTIONS: Action[] = ['EXHAUSTED', 'INVALID_KEY', 'RATE_LIMITED', 'UPSTREAM_ERROR', 'CLIENT_ERROR'];

export type KeyStatus = 'active' | 'exhausted' | 'rate_limited' | 'invalid' | 'disabled';

/** 'rule' is an ordinary error rule. 'drop_list' marks the per-provider drop-list row written by the dashboard. */
export type RuleOrigin = 'rule' | 'drop_list';

export interface Env {
  DB: D1Database;
  ASSETS?: Fetcher;
  ADMIN_PASSWORD: string;
  ENCRYPTION_KEY: string;
  SESSION_SECRET: string;
}

export interface Provider {
  id: number;
  name: string;
  base_url: string;
  formats: Format[];
  key_strategy: 'sequential' | 'round_robin';
  model_map: Record<string, string>;
  models: string[];
  models_fetched_at: number | null;
  model_allowlist: boolean;
  balance_mode: 'standard' | 'custom' | 'none';
  balance_path: string | null;
  balance_field: string | null;
  balance_divisor: number;
  recheck_mode: 'auto' | 'balance' | 'manual';
  recheck_hours: number;
  test_model: string | null;
  parse_usage: boolean;
  timeout_ms: number;
  extra_headers: Record<string, string>;
  enabled: boolean;
  created_at: number;
}

export interface ProviderKey {
  id: number;
  provider_id: number;
  alias: string;
  key_enc: string;
  key_hint: string;
  priority: number;
  status: KeyStatus;
  status_reason: string | null;
  /** HTTP status the relay answered when the key was dropped; NULL for keys dropped before migration 0002. */
  status_code: number | null;
  status_changed_at: number | null;
  cooldown_until: number | null;
  next_recheck_at: number | null;
  balance: number | null;
  balance_checked_at: number | null;
  created_at: number;
}

export interface Route {
  id: number;
  name: string;
  model_patterns: string[];
  is_default: boolean;
  position: number;
  provider_ids: number[];
}

export interface ErrorRule {
  id: number;
  provider_id: number | null;
  priority: number;
  status_codes: string;
  body_regex: string | null;
  action: Action;
  cooldown_s: number | null;
  note: string | null;
  enabled: boolean;
  origin: RuleOrigin;
}

export interface GatewayKey {
  id: number;
  name: string;
  key_hash: string;
  key_prefix: string;
  route_id: number | null;
  enabled: boolean;
  created_at: number;
}

export interface Settings {
  log_retention_days: number;
  max_attempts: number;
  balance_refresh_hours: number;
  config_version: number;
}

export interface Config {
  version: number;
  providers: Map<number, Provider>;
  keysByProvider: Map<number, ProviderKey[]>;
  routes: Route[];
  rules: ErrorRule[];
  gatewayKeysByHash: Map<string, GatewayKey>;
  settings: Settings;
}

export interface Attempt {
  provider_id: number;
  provider: string;
  key_id: number;
  key: string;
  model: string;
  status: number;
  action: Action | 'OK';
  reason?: string;
  ms: number;
}
