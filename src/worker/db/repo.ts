import type {
  Config,
  ErrorRule,
  Format,
  GatewayKey,
  KeyStatus,
  Provider,
  ProviderKey,
  Route,
  Settings,
} from '../types';

type Row = Record<string, unknown>;

function json<T>(v: unknown, fallback: T): T {
  if (typeof v !== 'string' || v === '') return fallback;
  try {
    return JSON.parse(v) as T;
  } catch {
    return fallback;
  }
}

const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const str = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

export function parseProvider(r: Row): Provider {
  return {
    id: Number(r.id),
    name: String(r.name),
    base_url: String(r.base_url),
    formats: json<Format[]>(r.formats, []),
    key_strategy: r.key_strategy === 'round_robin' ? 'round_robin' : 'sequential',
    model_map: json<Record<string, string>>(r.model_map, {}),
    models: json<string[]>(r.models, []),
    models_fetched_at: num(r.models_fetched_at),
    model_allowlist: Number(r.model_allowlist) === 1,
    balance_mode: (r.balance_mode as Provider['balance_mode']) ?? 'standard',
    balance_path: str(r.balance_path),
    balance_field: str(r.balance_field),
    balance_divisor: Number(r.balance_divisor ?? 1) || 1,
    recheck_mode: r.recheck_mode === 'manual' || r.recheck_mode === 'balance' ? r.recheck_mode : 'auto',
    recheck_hours: Number(r.recheck_hours ?? 6),
    test_model: str(r.test_model),
    parse_usage: Number(r.parse_usage) === 1,
    timeout_ms: Number(r.timeout_ms ?? 60000),
    extra_headers: json<Record<string, string>>(r.extra_headers, {}),
    enabled: Number(r.enabled) === 1,
    created_at: Number(r.created_at),
  };
}

export function parseKey(r: Row): ProviderKey {
  return {
    id: Number(r.id),
    provider_id: Number(r.provider_id),
    alias: String(r.alias ?? ''),
    key_enc: String(r.key_enc),
    key_hint: String(r.key_hint ?? ''),
    priority: Number(r.priority ?? 0),
    status: (r.status as KeyStatus) ?? 'active',
    status_reason: str(r.status_reason),
    status_changed_at: num(r.status_changed_at),
    cooldown_until: num(r.cooldown_until),
    next_recheck_at: num(r.next_recheck_at),
    balance: num(r.balance),
    balance_checked_at: num(r.balance_checked_at),
    created_at: Number(r.created_at),
  };
}

export function parseRule(r: Row): ErrorRule {
  return {
    id: Number(r.id),
    provider_id: num(r.provider_id),
    priority: Number(r.priority ?? 100),
    status_codes: String(r.status_codes ?? ''),
    body_regex: str(r.body_regex),
    action: r.action as ErrorRule['action'],
    cooldown_s: num(r.cooldown_s),
    note: str(r.note),
    enabled: Number(r.enabled) === 1,
  };
}

export function parseGatewayKey(r: Row): GatewayKey {
  return {
    id: Number(r.id),
    name: String(r.name),
    key_hash: String(r.key_hash),
    key_prefix: String(r.key_prefix),
    route_id: num(r.route_id),
    enabled: Number(r.enabled) === 1,
    created_at: Number(r.created_at),
  };
}

export function parseSettings(rows: Row[]): Settings {
  const m = new Map(rows.map((r) => [String(r.key), String(r.value)]));
  return {
    log_retention_days: Number(m.get('log_retention_days') ?? 7),
    max_attempts: Number(m.get('max_attempts') ?? 10),
    balance_refresh_hours: Number(m.get('balance_refresh_hours') ?? 6),
    config_version: Number(m.get('config_version') ?? 1),
  };
}

/** Loads the full routing configuration in a single D1 round-trip (batch). */
export async function loadConfig(db: D1Database): Promise<Config> {
  const [p, k, r, rp, er, gk, s] = await db.batch([
    db.prepare('SELECT * FROM providers ORDER BY id'),
    db.prepare('SELECT * FROM provider_keys ORDER BY provider_id, priority, id'),
    db.prepare('SELECT * FROM routes ORDER BY position, id'),
    db.prepare('SELECT * FROM route_providers ORDER BY route_id, position'),
    db.prepare('SELECT * FROM error_rules WHERE enabled = 1 ORDER BY (provider_id IS NULL), priority, id'),
    db.prepare('SELECT * FROM gateway_keys'),
    db.prepare('SELECT key, value FROM settings'),
  ]);

  const providers = new Map<number, Provider>();
  for (const row of p.results as Row[]) {
    const prov = parseProvider(row);
    providers.set(prov.id, prov);
  }

  const keysByProvider = new Map<number, ProviderKey[]>();
  for (const row of k.results as Row[]) {
    const key = parseKey(row);
    const list = keysByProvider.get(key.provider_id) ?? [];
    list.push(key);
    keysByProvider.set(key.provider_id, list);
  }

  const chain = new Map<number, number[]>();
  for (const row of rp.results as Row[]) {
    const list = chain.get(Number(row.route_id)) ?? [];
    list.push(Number(row.provider_id));
    chain.set(Number(row.route_id), list);
  }
  const routes: Route[] = (r.results as Row[]).map((row) => ({
    id: Number(row.id),
    name: String(row.name),
    model_patterns: json<string[]>(row.model_patterns, []),
    is_default: Number(row.is_default) === 1,
    position: Number(row.position ?? 0),
    provider_ids: chain.get(Number(row.id)) ?? [],
  }));

  const gatewayKeysByHash = new Map<string, GatewayKey>();
  for (const row of gk.results as Row[]) {
    const g = parseGatewayKey(row);
    gatewayKeysByHash.set(g.key_hash, g);
  }

  const settings = parseSettings(s.results as Row[]);
  return {
    version: settings.config_version,
    providers,
    keysByProvider,
    routes,
    rules: (er.results as Row[]).map(parseRule),
    gatewayKeysByHash,
    settings,
  };
}

export async function getConfigVersion(db: D1Database): Promise<number> {
  const row = await db.prepare("SELECT value FROM settings WHERE key = 'config_version'").first<{ value: string }>();
  return Number(row?.value ?? 0);
}

export function bumpVersionStmt(db: D1Database): D1PreparedStatement {
  return db.prepare(
    "UPDATE settings SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT) WHERE key = 'config_version'",
  );
}

export interface KeyStatePatch {
  status: KeyStatus;
  status_reason: string | null;
  cooldown_until: number | null;
  next_recheck_at: number | null;
}

export function keyStateStmt(db: D1Database, keyId: number, patch: KeyStatePatch, now: number): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE provider_keys
         SET status = ?, status_reason = ?, cooldown_until = ?, next_recheck_at = ?, status_changed_at = ?
       WHERE id = ?`,
    )
    .bind(patch.status, patch.status_reason, patch.cooldown_until, patch.next_recheck_at, now, keyId);
}
