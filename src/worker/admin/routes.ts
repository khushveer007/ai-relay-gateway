import { Hono } from 'hono';
import { NOT_A_MODEL_LIST, checkBalance, fetchModels, testKey } from '../balance';
import { recheckKey } from '../cron';
import { invalidateConfig, plainKey } from '../db/cache';
import { decrypt, encrypt, keyHint, randomToken, sha256Hex } from '../db/crypto';
import { bumpVersionStmt, loadConfig, parseGatewayKey, parseKey, parseProvider, parseRule, parseSettings } from '../db/repo';
import { classify, validateRegex } from '../routing/error-rules';
import { dropListStmts, parseDropList } from '../routing/drop-list';
import { ACTIVE_PATCH, applyKeyPatch, patchForAction } from '../routing/key-state';
import { parseStatusCodes } from '../../dashboard/lib/status-codes';
import { ALL_ACTIONS, ALL_FORMATS, type Env, type Provider, type ProviderKey } from '../types';
import { checkPassword, clearSessionCookie, createSession, loginBlocked, recordLoginFailure, requireAdmin, setSessionCookie } from './auth';
import { getStats } from './stats';
import { pricesRoutes } from './prices';

type App = { Bindings: Env };

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

const bad = (msg: string) => new HttpError(400, msg);

async function body(c: { req: { json: () => Promise<unknown> } }): Promise<Record<string, any>> {
  try {
    const j = await c.req.json();
    if (j && typeof j === 'object' && !Array.isArray(j)) return j as Record<string, any>;
  } catch {
    /* fallthrough */
  }
  throw bad('invalid JSON body');
}

function idParam(v: string): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw bad('invalid id');
  return n;
}

/** Runs statements atomically, bumps the config version, and drops this isolate's cache. */
async function mutate(env: Env, stmts: D1PreparedStatement[]): Promise<D1Result[]> {
  const res = await env.DB.batch([...stmts, bumpVersionStmt(env.DB)]);
  invalidateConfig();
  return res;
}

function publicKey(k: ProviderKey) {
  const { key_enc: _omit, ...rest } = k;
  return rest;
}

async function getProvider(env: Env, id: number): Promise<Provider> {
  const row = await env.DB.prepare('SELECT * FROM providers WHERE id = ?').bind(id).first();
  if (!row) throw new HttpError(404, 'provider not found');
  return parseProvider(row);
}

async function getKey(env: Env, id: number): Promise<{ key: ProviderKey; provider: Provider }> {
  const row = await env.DB.prepare('SELECT * FROM provider_keys WHERE id = ?').bind(id).first();
  if (!row) throw new HttpError(404, 'key not found');
  const key = parseKey(row);
  return { key, provider: await getProvider(env, key.provider_id) };
}

// ------------------------------------------------------------------ validation

function str(v: unknown, field: string, { required = false, max = 500 } = {}): string | null {
  if (v === undefined || v === null || v === '') {
    if (required) throw bad(`${field} is required`);
    return null;
  }
  if (typeof v !== 'string') throw bad(`${field} must be a string`);
  const s = v.trim();
  if (s.length > max) throw bad(`${field} is too long`);
  if (required && !s) throw bad(`${field} is required`);
  return s || null;
}

function num(v: unknown, field: string, min: number, max: number, fallback: number): number {
  if (v === undefined || v === null || v === '') return fallback;
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) throw bad(`${field} must be between ${min} and ${max}`);
  return n;
}

const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

function strMap(v: unknown, field: string, headerNames = false): Record<string, string> {
  if (v === undefined || v === null) return {};
  if (typeof v !== 'object' || Array.isArray(v)) throw bad(`${field} must be an object`);
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (!k.trim()) continue;
    if (headerNames && !HEADER_NAME.test(k.trim())) throw bad(`${field}.${k} is not a valid header name`);
    if (typeof val !== 'string') throw bad(`${field}.${k} must be a string`);
    out[k.trim()] = val.trim();
  }
  return out;
}

/** Checks that a base URL is a valid http(s) URL and returns it with trailing slashes stripped. */
function validBaseUrl(raw: string): string {
  try {
    const u = new URL(raw);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error();
  } catch {
    throw bad('base_url must be a valid http(s) URL');
  }
  return raw.replace(/\/+$/, '');
}

function providerColumns(b: Record<string, any>, existing?: Provider) {
  const pick = <K extends keyof Provider>(k: K): unknown => (b[k] !== undefined ? b[k] : existing?.[k]);

  const name = str(pick('name'), 'name', { required: true, max: 80 })!;
  const base_url = validBaseUrl(str(pick('base_url'), 'base_url', { required: true, max: 300 })!);
  const formats = (pick('formats') as unknown[] | undefined) ?? ALL_FORMATS;
  if (!Array.isArray(formats) || formats.length === 0 || !formats.every((f) => ALL_FORMATS.includes(f as any))) {
    throw bad(`formats must be a non-empty subset of ${ALL_FORMATS.join(', ')}`);
  }
  const key_strategy = pick('key_strategy') ?? 'sequential';
  if (key_strategy !== 'sequential' && key_strategy !== 'round_robin') throw bad('invalid key_strategy');
  const balance_mode = pick('balance_mode') ?? 'standard';
  if (!['standard', 'custom', 'none'].includes(balance_mode as string)) throw bad('invalid balance_mode');
  const recheck_mode = pick('recheck_mode') ?? 'auto';
  if (!['auto', 'balance', 'manual'].includes(recheck_mode as string)) throw bad('invalid recheck_mode');

  return {
    name,
    base_url,
    formats: JSON.stringify([...new Set(formats)]),
    key_strategy,
    model_map: JSON.stringify(strMap(pick('model_map'), 'model_map')),
    model_allowlist: pick('model_allowlist') ? 1 : 0,
    balance_mode,
    balance_path: str(pick('balance_path'), 'balance_path', { max: 300 }),
    balance_field: str(pick('balance_field'), 'balance_field', { max: 100 }),
    balance_divisor: num(pick('balance_divisor'), 'balance_divisor', 1e-9, 1e12, 1),
    recheck_mode,
    recheck_hours: num(pick('recheck_hours'), 'recheck_hours', 0.25, 720, 6),
    test_model: str(pick('test_model'), 'test_model', { max: 120 }),
    parse_usage: pick('parse_usage') === false ? 0 : 1,
    timeout_ms: Math.round(num(pick('timeout_ms'), 'timeout_ms', 1000, 300_000, 60_000)),
    extra_headers: JSON.stringify(strMap(pick('extra_headers'), 'extra_headers', true)),
    enabled: pick('enabled') === false ? 0 : 1,
  };
}

function splitKeys(text: unknown): string[] {
  if (Array.isArray(text)) return text.map(String).map((s) => s.trim()).filter(Boolean);
  if (typeof text !== 'string') return [];
  return text.split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean);
}

/**
 * The encrypted key INSERT statements for a provider. The provider is a numeric id for an existing provider, or its
 * unique name for a create, where a bound subquery finds the id inside the same batch. Fresh keys only: the caller
 * removes duplicates first. Priorities start after `startPriority`, so a create starts at 0.
 */
async function keyInsertStmts(
  env: Env,
  providerRef: number | string,
  fresh: string[],
  startPriority: number,
  aliasPrefix?: string | null,
): Promise<D1PreparedStatement[]> {
  const providerSql = typeof providerRef === 'string' ? '(SELECT id FROM providers WHERE name = ?)' : '?';
  const stmts: D1PreparedStatement[] = [];
  let i = 0;
  for (const k of fresh) {
    i++;
    const alias = aliasPrefix ? `${aliasPrefix} ${startPriority + 1 + i}` : '';
    stmts.push(
      env.DB.prepare(`INSERT INTO provider_keys (provider_id, alias, key_enc, key_hint, priority) VALUES (${providerSql}, ?, ?, ?, ?)`).bind(
        providerRef,
        alias,
        await encrypt(k, env.ENCRYPTION_KEY),
        keyHint(k),
        startPriority + i,
      ),
    );
  }
  return stmts;
}

async function insertKeys(env: Env, providerId: number, raw: string[], aliasPrefix?: string | null) {
  const existingRows = await env.DB.prepare('SELECT key_enc, priority FROM provider_keys WHERE provider_id = ?').bind(providerId).all();
  const existing = new Set<string>();
  let maxPriority = -1;
  for (const r of existingRows.results as Array<{ key_enc: string; priority: number }>) {
    maxPriority = Math.max(maxPriority, Number(r.priority));
    try {
      existing.add(await decrypt(r.key_enc, env.ENCRYPTION_KEY));
    } catch {
      /* undecryptable legacy key */
    }
  }
  const fresh = [...new Set(raw)].filter((k) => !existing.has(k));
  const stmts = await keyInsertStmts(env, providerId, fresh, maxPriority, aliasPrefix);
  if (stmts.length) await mutate(env, stmts);
  return { added: fresh.length, duplicates: raw.length - fresh.length };
}

async function refreshModels(env: Env, provider: Provider, explicitKey?: string | null) {
  let apiKey = explicitKey ?? null;
  if (!apiKey) {
    const rows = await env.DB.prepare(
      "SELECT * FROM provider_keys WHERE provider_id = ? ORDER BY (status = 'active') DESC, priority LIMIT 1",
    )
      .bind(provider.id)
      .all();
    const row = rows.results[0];
    if (!row) throw bad('add at least one API key before fetching models');
    apiKey = await plainKey(env, parseKey(row));
  }
  const models = await fetchModels(provider, apiKey);
  await mutate(env, [
    env.DB.prepare('UPDATE providers SET models = ?, models_fetched_at = ? WHERE id = ?').bind(JSON.stringify(models), Date.now(), provider.id),
  ]);
  return models;
}

// ------------------------------------------------------------------ app

export const admin = new Hono<App>();

admin.onError((err, c) => {
  if (err instanceof HttpError) return c.json({ error: err.message }, err.status as 400);
  const msg = String((err as Error).message ?? err);
  if (msg.includes('UNIQUE constraint failed')) return c.json({ error: 'name already exists' }, 409);
  console.error(err);
  return c.json({ error: msg }, 500);
});

admin.post('/login', async (c) => {
  const ip = c.req.header('cf-connecting-ip') ?? 'local';
  if (loginBlocked(ip)) return c.json({ error: 'too many attempts, try again later' }, 429);
  const b = await body(c);
  if (!c.env.SESSION_SECRET) return c.json({ error: 'SESSION_SECRET is not configured' }, 500);
  if (!(await checkPassword(c.env, String(b.password ?? '')))) {
    recordLoginFailure(ip);
    return c.json({ error: 'wrong password' }, 401);
  }
  setSessionCookie(c, await createSession(c.env.SESSION_SECRET));
  return c.json({ ok: true });
});

admin.post('/logout', (c) => {
  clearSessionCookie(c);
  return c.json({ ok: true });
});

const s = new Hono<App>();
s.use('*', requireAdmin);

s.get('/session', (c) => c.json({ ok: true }));
s.route('/prices', pricesRoutes(mutate, HttpError));

// ---------------- providers & keys

s.get('/providers', async (c) => {
  const cfg = await loadConfig(c.env.DB);
  // A provider's drop list is its one drop-list rule (origin drop_list). The list shows it as codes and message text.
  const dropByProvider = new Map<number, { codes: string; message: string }>();
  for (const r of cfg.rules) {
    if (r.origin === 'drop_list' && r.provider_id !== null) {
      dropByProvider.set(r.provider_id, { codes: r.status_codes, message: r.note ?? '' });
    }
  }
  const providers = [...cfg.providers.values()].map((p) => ({
    ...p,
    keys: (cfg.keysByProvider.get(p.id) ?? []).map(publicKey),
    routes: cfg.routes.filter((r) => r.provider_ids.includes(p.id)).map((r) => r.name),
    drop_codes: dropByProvider.get(p.id)?.codes ?? '',
    drop_message: dropByProvider.get(p.id)?.message ?? '',
  }));
  return c.json({ providers });
});

s.post('/providers', async (c) => {
  const b = await body(c);
  const cols = providerColumns(b);
  const dl = parseDropList(b.drop_codes, b.drop_message);
  if (dl.error) throw bad(dl.error);
  const names = Object.keys(cols);
  const keys = splitKeys(b.keys);
  const aliasPrefix = str(b.alias_prefix, 'alias_prefix', { max: 40 });
  const defaultRoute = b.add_to_default !== false ? await c.env.DB.prepare('SELECT id FROM routes WHERE is_default = 1 LIMIT 1').first<{ id: number }>() : null;

  // One batch: provider, submitted keys, default-route link and drop rule, then the version bump (D-04). The child
  // statements find the new provider by its unique name inside the batch, so a failed rule INSERT rolls back all of it.
  const freshKeys = [...new Set(keys)];
  const stmts: D1PreparedStatement[] = [
    c.env.DB.prepare(`INSERT INTO providers (${names.join(', ')}) VALUES (${names.map(() => '?').join(', ')}) RETURNING id`).bind(
      ...Object.values(cols),
    ),
  ];
  stmts.push(...(await keyInsertStmts(c.env, cols.name, freshKeys, -1, aliasPrefix)));
  if (defaultRoute) {
    stmts.push(
      c.env.DB.prepare(
        'INSERT OR IGNORE INTO route_providers (route_id, provider_id, position) VALUES (?, (SELECT id FROM providers WHERE name = ?), (SELECT COALESCE(MAX(position), -1) + 1 FROM route_providers WHERE route_id = ?))',
      ).bind(defaultRoute.id, cols.name, defaultRoute.id),
    );
  }
  stmts.push(...dropListStmts(c.env.DB, cols.name, dl));
  const [res] = await mutate(c.env, stmts);
  const id = Number((res.results[0] as { id: number }).id);

  const keyResult = { added: freshKeys.length, duplicates: keys.length - freshKeys.length };
  let models: string[] | null = null;
  let modelsError: string | null = null;
  if (keys.length) {
    try {
      models = await refreshModels(c.env, await getProvider(c.env, id), keys[0]);
    } catch (e) {
      modelsError = (e as Error).message;
    }
  }
  return c.json({ id, keys: keyResult, models, models_error: modelsError }, 201);
});

// Advice only (D-17, D-18): asks the relay for its model list and reports the outcome. It writes
// nothing, leaves every key status alone, and answers with a count, never a key or the model list.
s.post('/providers/test-connection', async (c) => {
  const b = await body(c);
  const base_url = validBaseUrl(str(b.base_url, 'base_url', { required: true, max: 300 })!);
  const extra_headers = strMap(b.extra_headers, 'extra_headers', true);
  let apiKey = splitKeys(b.keys)[0] ?? null;
  if (!apiKey && b.provider_id !== undefined && b.provider_id !== null && b.provider_id !== '') {
    const rows = await c.env.DB.prepare(
      "SELECT * FROM provider_keys WHERE provider_id = ? ORDER BY (status = 'active') DESC, priority LIMIT 1",
    )
      .bind(idParam(String(b.provider_id)))
      .all();
    const row = rows.results[0];
    // D-19: a stored key is decrypted here and never travels to the browser.
    if (row) apiKey = await plainKey(c.env, parseKey(row));
  }
  if (!apiKey) throw bad('no key to test with');
  const t0 = Date.now();
  try {
    const models = await fetchModels({ base_url, extra_headers }, apiKey, { strict: true });
    return c.json({ ok: true, count: models.length, ms: Date.now() - t0 });
  } catch (e) {
    // The admin call itself worked, so answer 200 and let the client show the relay's verdict.
    const msg = String((e as Error).message ?? e).split(apiKey).join('***').slice(0, 300);
    // A 200 whose body is not JSON (usually the relay's web page) did reach the host: report it as a 200, not as unreachable.
    if (msg.startsWith('not JSON:')) {
      return c.json({ ok: false, status: 200, message: `${NOT_A_MODEL_LIST}. The base URL may point at a web page`, ms: Date.now() - t0 });
    }
    const m = /^HTTP (\d{3}): ([\s\S]*)$/.exec(msg);
    return c.json({ ok: false, status: m ? Number(m[1]) : 0, message: m ? m[2] : msg, ms: Date.now() - t0 });
  }
});

s.put('/providers/:id', async (c) => {
  const id = idParam(c.req.param('id'));
  const existing = await getProvider(c.env, id);
  const b = await body(c);
  const cols = providerColumns(b, existing);
  const dl = parseDropList(b.drop_codes, b.drop_message);
  if (dl.error) throw bad(dl.error);
  await mutate(c.env, [
    c.env.DB.prepare(`UPDATE providers SET ${Object.keys(cols).map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).bind(...Object.values(cols), id),
    ...dropListStmts(c.env.DB, id, dl),
  ]);
  return c.json({ ok: true });
});

s.delete('/providers/:id', async (c) => {
  const id = idParam(c.req.param('id'));
  await mutate(c.env, [
    c.env.DB.prepare('DELETE FROM provider_keys WHERE provider_id = ?').bind(id),
    c.env.DB.prepare('DELETE FROM route_providers WHERE provider_id = ?').bind(id),
    c.env.DB.prepare('DELETE FROM error_rules WHERE provider_id = ?').bind(id),
    c.env.DB.prepare('DELETE FROM providers WHERE id = ?').bind(id),
  ]);
  return c.json({ ok: true });
});

s.post('/providers/:id/fetch-models', async (c) => {
  const provider = await getProvider(c.env, idParam(c.req.param('id')));
  try {
    const models = await refreshModels(c.env, provider);
    return c.json({ models });
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(502, `could not fetch models: ${(e as Error).message}`);
  }
});

s.post('/providers/:id/keys', async (c) => {
  const id = idParam(c.req.param('id'));
  const provider = await getProvider(c.env, id);
  const b = await body(c);
  const keys = splitKeys(b.keys);
  if (!keys.length) throw bad('no keys provided');
  const result = await insertKeys(c.env, id, keys, str(b.alias_prefix, 'alias_prefix', { max: 40 }));
  let models: string[] | null = null;
  if (provider.models.length === 0 && result.added > 0) {
    models = await refreshModels(c.env, provider, keys[0]).catch(() => null);
  }
  return c.json({ ...result, models });
});

s.post('/providers/:id/keys/reorder', async (c) => {
  const id = idParam(c.req.param('id'));
  const ids = (await body(c)).ids;
  if (!Array.isArray(ids)) throw bad('ids must be an array');
  await mutate(
    c.env,
    ids.map((kid, i) => c.env.DB.prepare('UPDATE provider_keys SET priority = ? WHERE id = ? AND provider_id = ?').bind(i, Number(kid), id)),
  );
  return c.json({ ok: true });
});

s.post('/providers/:id/check-balances', async (c) => {
  const provider = await getProvider(c.env, idParam(c.req.param('id')));
  const rows = await c.env.DB.prepare('SELECT * FROM provider_keys WHERE provider_id = ? ORDER BY priority LIMIT 20').bind(provider.id).all();
  const now = Date.now();
  const results = [];
  for (const row of rows.results) {
    const key = parseKey(row);
    // A dropped key is not balance-checked; the answer reports why instead of making a request (DROP-02).
    if (key.status === 'invalid') {
      results.push({ key_id: key.id, supported: false, balance: null, error: 'Key is dropped.' });
      continue;
    }
    const r = await checkBalance(c.env, provider, key);
    await c.env.DB.prepare("UPDATE provider_keys SET balance = COALESCE(?, balance), balance_checked_at = ? WHERE id = ? AND status != 'invalid'")
      .bind(r.balance, now, key.id)
      .run();
    results.push({ key_id: key.id, ...r });
  }
  return c.json({ results });
});

s.put('/keys/:id', async (c) => {
  const { key, provider } = await getKey(c.env, idParam(c.req.param('id')));
  const b = await body(c);
  if (b.alias !== undefined) {
    await mutate(c.env, [c.env.DB.prepare('UPDATE provider_keys SET alias = ? WHERE id = ?').bind(str(b.alias, 'alias', { max: 60 }) ?? '', key.id)]);
  }
  // Only an explicit Re-enable forces a dropped key back to active (DROP-03). Disable uses the default guard,
  // so it leaves an existing or concurrently recorded drop intact.
  if (b.status === 'active') {
    const applied = await applyKeyPatch(c.env, key, ACTIVE_PATCH, Date.now(), true);
    if (!applied) throw new HttpError(404, 'key not found');
  } else if (b.status === 'disabled') {
    await applyKeyPatch(c.env, key, { status: 'disabled', status_reason: 'disabled manually', status_code: null, cooldown_until: null, next_recheck_at: null });
  } else if (b.status !== undefined) throw bad('status must be "active" or "disabled"');
  invalidateConfig();
  void provider;
  return c.json({ ok: true });
});

s.delete('/keys/:id', async (c) => {
  const id = idParam(c.req.param('id'));
  await mutate(c.env, [c.env.DB.prepare('DELETE FROM provider_keys WHERE id = ?').bind(id)]);
  return c.json({ ok: true });
});

s.post('/keys/:id/check-balance', async (c) => {
  const { key, provider } = await getKey(c.env, idParam(c.req.param('id')));
  // A dropped key is not balance-checked (DROP-02). Same response shape as a balance-unsupported answer.
  if (key.status === 'invalid') return c.json({ supported: false, balance: null, error: 'Key is dropped.' });
  const r = await checkBalance(c.env, provider, key);
  await c.env.DB.prepare("UPDATE provider_keys SET balance = COALESCE(?, balance), balance_checked_at = ? WHERE id = ? AND status != 'invalid'")
    .bind(r.balance, Date.now(), key.id)
    .run();
  return c.json(r);
});

s.post('/keys/:id/test', async (c) => {
  const { key, provider } = await getKey(c.env, idParam(c.req.param('id')));
  // Read the status before any patch: applyKeyPatch mutates the key object in place (DROP-10).
  const statusBefore = key.status;
  const cfg = await loadConfig(c.env.DB);
  const r = await testKey(c.env, provider, key, cfg.rules);
  // A dropped or disabled key is report-only: the test result is returned, and no key write happens.
  if (statusBefore !== 'invalid' && statusBefore !== 'disabled') {
    if (r.ok && statusBefore !== 'active') await applyKeyPatch(c.env, key, ACTIVE_PATCH);
    else if (!r.ok && r.cls) {
      const patch = patchForAction(provider, r.cls.action, r.cls.reason, r.cls.cooldownS, r.status, Date.now());
      if (patch) await applyKeyPatch(c.env, key, patch);
    }
  }
  invalidateConfig();
  return c.json({ ...r, key_status: statusBefore });
});

s.post('/keys/:id/recheck', async (c) => {
  const { key, provider } = await getKey(c.env, idParam(c.req.param('id')));
  const r = await recheckKey(c.env, await loadConfig(c.env.DB), provider, key);
  invalidateConfig();
  return c.json(r);
});

// ---------------- routes

s.get('/routes', async (c) => {
  const cfg = await loadConfig(c.env.DB);
  return c.json({ routes: cfg.routes });
});

function routeInput(b: Record<string, any>) {
  const name = str(b.name, 'name', { required: true, max: 60 })!;
  const patterns = b.model_patterns ?? [];
  if (!Array.isArray(patterns) || !patterns.every((p) => typeof p === 'string')) throw bad('model_patterns must be an array of strings');
  const providerIds = b.provider_ids ?? [];
  if (!Array.isArray(providerIds)) throw bad('provider_ids must be an array');
  return {
    name,
    patterns: JSON.stringify(patterns.map((p: string) => p.trim()).filter(Boolean)),
    providerIds: [...new Set(providerIds.map(Number))].filter((n) => Number.isInteger(n) && n > 0),
    position: num(b.position, 'position', 0, 100000, 0),
  };
}

s.post('/routes', async (c) => {
  const r = routeInput(await body(c));
  const [res] = await mutate(c.env, [
    c.env.DB.prepare('INSERT INTO routes (name, model_patterns, position) VALUES (?, ?, ?) RETURNING id').bind(r.name, r.patterns, r.position),
  ]);
  const id = Number((res.results[0] as { id: number }).id);
  if (r.providerIds.length) {
    await mutate(
      c.env,
      r.providerIds.map((pid, i) => c.env.DB.prepare('INSERT INTO route_providers (route_id, provider_id, position) VALUES (?, ?, ?)').bind(id, pid, i)),
    );
  }
  return c.json({ id }, 201);
});

s.put('/routes/:id', async (c) => {
  const id = idParam(c.req.param('id'));
  const r = routeInput(await body(c));
  await mutate(c.env, [
    c.env.DB.prepare('UPDATE routes SET name = ?, model_patterns = ?, position = ? WHERE id = ?').bind(r.name, r.patterns, r.position, id),
    c.env.DB.prepare('DELETE FROM route_providers WHERE route_id = ?').bind(id),
    ...r.providerIds.map((pid, i) =>
      c.env.DB.prepare('INSERT INTO route_providers (route_id, provider_id, position) VALUES (?, ?, ?)').bind(id, pid, i),
    ),
  ]);
  return c.json({ ok: true });
});

s.delete('/routes/:id', async (c) => {
  const id = idParam(c.req.param('id'));
  const row = await c.env.DB.prepare('SELECT is_default FROM routes WHERE id = ?').bind(id).first<{ is_default: number }>();
  if (!row) throw new HttpError(404, 'route not found');
  if (row.is_default) throw bad('the default route cannot be deleted');
  await mutate(c.env, [
    c.env.DB.prepare('UPDATE gateway_keys SET route_id = NULL WHERE route_id = ?').bind(id),
    c.env.DB.prepare('DELETE FROM route_providers WHERE route_id = ?').bind(id),
    c.env.DB.prepare('DELETE FROM routes WHERE id = ?').bind(id),
  ]);
  return c.json({ ok: true });
});

// ---------------- error rules

s.get('/rules', async (c) => {
  const rows = await c.env.DB.prepare('SELECT * FROM error_rules ORDER BY (provider_id IS NULL), provider_id, priority, id').all();
  return c.json({ rules: rows.results.map(parseRule), actions: ALL_ACTIONS });
});

function ruleInput(b: Record<string, any>) {
  if (!ALL_ACTIONS.includes(b.action)) throw bad(`action must be one of ${ALL_ACTIONS.join(', ')}`);
  // Codes typed with spaces or commas are normalized to commas by the shared parser (DROP-06). Range 100 to 999
  // keeps the rule form broad, since an operator rule is not limited to the drop-list range.
  const typed = str(b.status_codes, 'status_codes', { max: 100 }) ?? '';
  const parsed = parseStatusCodes(typed, { min: 100, max: 999 });
  if (parsed.error) throw bad('status_codes must look like "402" or "401,403" or "500-599"');
  const status_codes = parsed.codes;
  const body_regex = str(b.body_regex, 'body_regex', { max: 2000 });
  if (body_regex) {
    const err = validateRegex(body_regex);
    if (err) throw bad(`invalid regex: ${err}`);
  }
  if (!status_codes && !body_regex) throw bad('a rule needs a status code filter, a body regex, or both');
  return {
    provider_id: b.provider_id ? Number(b.provider_id) : null,
    priority: Math.round(num(b.priority, 'priority', 0, 100000, 100)),
    status_codes,
    body_regex,
    action: b.action as string,
    cooldown_s: b.action === 'RATE_LIMITED' ? Math.round(num(b.cooldown_s, 'cooldown_s', 1, 86400 * 7, 60)) : null,
    note: str(b.note, 'note', { max: 200 }),
    enabled: b.enabled === false ? 0 : 1,
  };
}

s.post('/rules', async (c) => {
  const r = ruleInput(await body(c));
  const cols = Object.keys(r);
  await mutate(c.env, [c.env.DB.prepare(`INSERT INTO error_rules (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).bind(...Object.values(r))]);
  return c.json({ ok: true }, 201);
});

/** A drop-list row belongs to its provider page. Rules can't edit or delete it, so a rule edit cannot wipe a drop list (T-03-13). */
async function refuseDropListRule(env: Env, id: number): Promise<void> {
  const row = await env.DB.prepare('SELECT origin FROM error_rules WHERE id = ?').bind(id).first<{ origin: string }>();
  if (row?.origin === 'drop_list') {
    throw new HttpError(409, "This rule comes from a provider's drop list. Edit it in the provider.");
  }
}

s.put('/rules/:id', async (c) => {
  const id = idParam(c.req.param('id'));
  await refuseDropListRule(c.env, id);
  const r = ruleInput(await body(c));
  await mutate(c.env, [
    c.env.DB.prepare(`UPDATE error_rules SET ${Object.keys(r).map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).bind(...Object.values(r), id),
  ]);
  return c.json({ ok: true });
});

s.delete('/rules/:id', async (c) => {
  const id = idParam(c.req.param('id'));
  await refuseDropListRule(c.env, id);
  await mutate(c.env, [c.env.DB.prepare('DELETE FROM error_rules WHERE id = ?').bind(id)]);
  return c.json({ ok: true });
});

/** Dry-runs the classifier against a sample error so users can verify their rules. */
s.post('/rules/test', async (c) => {
  const b = await body(c);
  const rows = await c.env.DB.prepare('SELECT * FROM error_rules WHERE enabled = 1 ORDER BY (provider_id IS NULL), priority, id').all();
  const result = classify(rows.results.map(parseRule), Number(b.provider_id ?? 0), Number(b.status ?? 200), String(b.body ?? ''), b.retry_after ?? null);
  return c.json(result);
});

// ---------------- gateway keys

s.get('/gateway-keys', async (c) => {
  const rows = await c.env.DB.prepare('SELECT * FROM gateway_keys ORDER BY id').all();
  return c.json({ keys: rows.results.map(parseGatewayKey).map(({ key_hash: _h, ...k }) => k) });
});

s.post('/gateway-keys', async (c) => {
  const b = await body(c);
  const name = str(b.name, 'name', { required: true, max: 60 })!;
  const routeId = b.route_id ? Number(b.route_id) : null;
  const key = `sk-gw-${randomToken(40)}`;
  await mutate(c.env, [
    c.env.DB.prepare('INSERT INTO gateway_keys (name, key_hash, key_prefix, route_id) VALUES (?, ?, ?, ?)').bind(
      name,
      await sha256Hex(key),
      key.slice(0, 12),
      routeId,
    ),
  ]);
  return c.json({ key }, 201);
});

s.put('/gateway-keys/:id', async (c) => {
  const id = idParam(c.req.param('id'));
  const b = await body(c);
  await mutate(c.env, [
    c.env.DB.prepare('UPDATE gateway_keys SET name = ?, route_id = ?, enabled = ? WHERE id = ?').bind(
      str(b.name, 'name', { required: true, max: 60 }),
      b.route_id ? Number(b.route_id) : null,
      b.enabled === false ? 0 : 1,
      id,
    ),
  ]);
  return c.json({ ok: true });
});

s.delete('/gateway-keys/:id', async (c) => {
  await mutate(c.env, [c.env.DB.prepare('DELETE FROM gateway_keys WHERE id = ?').bind(idParam(c.req.param('id')))]);
  return c.json({ ok: true });
});

// ---------------- settings, logs, stats

s.get('/settings', async (c) => {
  const rows = await c.env.DB.prepare('SELECT key, value FROM settings').all();
  return c.json(parseSettings(rows.results as Record<string, unknown>[]));
});

s.put('/settings', async (c) => {
  const b = await body(c);
  const values: Record<string, number> = {
    log_retention_days: Math.round(num(b.log_retention_days, 'log_retention_days', 1, 90, 7)),
    max_attempts: Math.round(num(b.max_attempts, 'max_attempts', 1, 40, 10)),
    balance_refresh_hours: num(b.balance_refresh_hours, 'balance_refresh_hours', 0.5, 168, 6),
  };
  await mutate(
    c.env,
    Object.entries(values).map(([k, v]) =>
      c.env.DB.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').bind(k, String(v)),
    ),
  );
  return c.json({ ok: true });
});

s.get('/logs', async (c) => {
  const q = c.req.query();
  const limit = Math.min(200, Math.max(1, Number(q.limit ?? 50)));
  const where: string[] = [];
  const args: unknown[] = [];
  if (q.before) {
    where.push('id < ?');
    args.push(Number(q.before));
  }
  if (q.provider_id) {
    where.push('provider_id = ?');
    args.push(Number(q.provider_id));
  }
  if (q.gateway_key_id) {
    where.push('gateway_key_id = ?');
    args.push(Number(q.gateway_key_id));
  }
  if (q.status === 'ok') where.push('status >= 200 AND status < 300');
  if (q.status === 'error') where.push('(status < 200 OR status >= 300)');
  if (q.status === 'failover') where.push('failovers > 0');
  if (q.model) {
    where.push('instr(lower(model), lower(?)) > 0');
    args.push(q.model);
  }
  const sql = `SELECT * FROM request_logs ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`;
  const rows = await c.env.DB.prepare(sql).bind(...args, limit).all();
  const logs = rows.results.map((r: any) => ({ ...r, stream: r.stream === 1, attempts: r.attempts ? JSON.parse(r.attempts) : [] }));
  return c.json({ logs, next_before: logs.length === limit ? logs[logs.length - 1].id : null });
});

s.get('/stats', async (c) => {
  const range = c.req.query('range') === '7d' ? 168 : c.req.query('range') === '1h' ? 1 : 24;
  return c.json(await getStats(c.env, range));
});

admin.route('/', s);
