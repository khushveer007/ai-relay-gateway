export type Format = 'anthropic' | 'openai-chat' | 'openai-responses';
export type Action = 'EXHAUSTED' | 'INVALID_KEY' | 'RATE_LIMITED' | 'UPSTREAM_ERROR' | 'CLIENT_ERROR';
export type KeyStatus = 'active' | 'exhausted' | 'rate_limited' | 'invalid' | 'disabled';

export interface ProviderKeyDTO {
  id: number;
  provider_id: number;
  alias: string;
  key_hint: string;
  priority: number;
  status: KeyStatus;
  status_reason: string | null;
  status_changed_at: number | null;
  cooldown_until: number | null;
  next_recheck_at: number | null;
  balance: number | null;
  balance_checked_at: number | null;
  created_at: number;
}

export interface ProviderDTO {
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
  keys: ProviderKeyDTO[];
  routes: string[];
}

export interface RouteDTO {
  id: number;
  name: string;
  model_patterns: string[];
  is_default: boolean;
  position: number;
  provider_ids: number[];
}

export interface ErrorRuleDTO {
  id: number;
  provider_id: number | null;
  priority: number;
  status_codes: string;
  body_regex: string | null;
  action: Action;
  cooldown_s: number | null;
  note: string | null;
  enabled: boolean;
}

export interface GatewayKeyDTO {
  id: number;
  name: string;
  key_prefix: string;
  route_id: number | null;
  enabled: boolean;
  created_at: number;
}

export interface SettingsDTO {
  log_retention_days: number;
  max_attempts: number;
  balance_refresh_hours: number;
  config_version: number;
}

export interface AttemptDTO {
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

export interface LogRowDTO {
  id: number;
  ts: number;
  gateway_key_id: number | null;
  route_id: number | null;
  format: string;
  path: string;
  model: string | null;
  upstream_model: string | null;
  provider_id: number | null;
  key_id: number | null;
  status: number;
  stream: boolean;
  latency_ms: number;
  ttfb_ms: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_tokens: number | null;
  failovers: number;
  attempts: AttemptDTO[];
  error: string | null;
}

export interface StatsDTO {
  hours: number;
  bucket_ms: number;
  since: number;
  totals: {
    requests: number;
    ok: number;
    failovered: number;
    input_tokens: number;
    output_tokens: number;
    cache_tokens: number;
    avg_latency: number | null;
    avg_ttfb: number | null;
  };
  by_provider: Array<{
    provider_id: number;
    requests: number;
    ok: number;
    input_tokens: number;
    output_tokens: number;
    avg_ttfb: number | null;
  }>;
  by_key: Array<{
    key_id: number;
    requests: number;
    input_tokens: number;
    output_tokens: number;
    last_used: number | null;
  }>;
  by_model: Array<{
    model: string;
    requests: number;
    input_tokens: number;
    output_tokens: number;
  }>;
  series: Array<{
    bucket: number;
    requests: number;
    errors: number;
    failovers: number;
    output_tokens: number;
  }>;
  actions: Array<{ action: string; count: number }>;
  key_failures: Array<{ key_id: number; action: string; count: number }>;
}

export class ApiError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

let onUnauthorized: (() => void) | null = null;
export function setUnauthorizedHandler(fn: () => void): void {
  onUnauthorized = fn;
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const init: RequestInit = {
    method,
    credentials: 'same-origin',
  };
  // The admin CSRF guard needs a JSON content-type on every non-GET and non-HEAD call.
  if (method !== 'GET' && method !== 'HEAD') {
    init.headers = { 'content-type': 'application/json' };
    init.body = JSON.stringify(body ?? {});
  }
  const res = await fetch(`/api/admin${path}`, init);
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (res.status === 401 && path !== '/login') {
    // The boot probe's 401 is normal (nobody is signed in yet), so it never fires the handler.
    if (path !== '/session') onUnauthorized?.();
    throw new ApiError(401, data.error || 'Session expired');
  }
  if (!res.ok) {
    throw new ApiError(res.status, data.error || `HTTP ${res.status}`);
  }
  return data as T;
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body),
  put: <T>(path: string, body?: unknown) => request<T>('PUT', path, body),
  del: <T>(path: string) => request<T>('DELETE', path, {}),
};
