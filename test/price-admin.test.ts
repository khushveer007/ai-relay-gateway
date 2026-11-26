import { afterAll, beforeAll, expect, it } from 'vitest';
import { getPlatformProxy, unstable_splitSqlQuery } from 'wrangler';
import initial from '../migrations/0001_init.sql?raw';
import keyDrop from '../migrations/0002_key_drop.sql?raw';
import costMigration from '../migrations/0003_cost_capture.sql?raw';
import { priceUsage, resolvePrice } from '../src/shared/pricing';
import { invalidateConfig } from '../src/worker/db/cache';
import { loadConfig } from '../src/worker/db/repo';
import type { Env } from '../src/worker/types';
import worker from '../src/worker/index';

const password = 'local-admin-test';
const context = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
const rates = { input: 300, output: 900, cache_read: null, cache_write: null };
let proxy: Awaited<ReturnType<typeof getPlatformProxy<Env>>>;
let env: Env;
let db: D1Database;
let cookie: string;

function send(path: string, method = 'GET', body?: BodyInit, auth = true, contentType = 'application/json') {
  const headers = new Headers({ 'content-type': contentType });
  if (auth) headers.set('cookie', cookie);
  return worker.fetch(new Request(`https://gateway.test/api/admin${path}`, { method, headers, body }), env, context);
}

function save(path: string, data: unknown) {
  return send('/prices/' + path, path === 'import' ? 'POST' : 'PUT', JSON.stringify(data));
}

function importPrices(...prices: Record<string, unknown>[]) {
  return save('import', { prices });
}

async function version() {
  const row = await db.prepare("SELECT value FROM settings WHERE key = 'config_version'").first<{ value: string }>();
  return Number(row?.value);
}

beforeAll(async () => {
  proxy = await getPlatformProxy<Env>({ persist: false });
  env = { ...proxy.env, ADMIN_PASSWORD: password, SESSION_SECRET: 'price-admin-local-session' };
  db = env.DB;
  for (const ddl of [initial, keyDrop, costMigration]) {
    await db.batch(unstable_splitSqlQuery(ddl).map((statement) => db.prepare(statement)));
  }
  const login = await send('/login', 'POST', JSON.stringify({ password }), false);
  expect(login.status).toBe(200);
  cookie = login.headers.get('set-cookie')!.split(';')[0];
  invalidateConfig();
}, 60_000);

afterAll(async () => {
  invalidateConfig();
  await proxy?.dispose();
});

it('imports prices through an authenticated Worker and preserves a field override', async () => {
  const start = await version();
  const model = 'claude-sonnet-local';
  const first = await importPrices({ model, base: rates });
  expect(first.status).toBe(200);
  expect(first.headers.get('cache-control')).toBe('no-store');
  expect(await version()).toBe(start + 1);
  expect((await save('override', { model, base: { input: 25, output: 5 } })).status).toBe(200);
  expect((await importPrices({ model, base: { ...rates, input: 990, output: 10 } })).status).toBe(200);
  const result = await send('/prices');
  expect(result.status).toBe(200);
  expect(await result.json()).toMatchObject({
    prices: [{ model, catalog_imported: true, catalog_base: { input: 990, output: 10 }, effective_base: { input: 25, output: 5 } }],
    next_after: null,
  });
  expect((await save('override', { model, base: { input: null } })).status).toBe(200);
  const reset = await send('/prices');
  expect(await reset.json()).toMatchObject({ prices: [{ model, effective_base: { input: 990, output: 5 } }] });
  expect((await save('alias', { upstream_model: 'relay-claude-exact', priced_model: model })).status).toBe(200);
  expect(await (await send('/prices/models')).json()).toMatchObject({
    models: expect.arrayContaining([{ upstream_model: 'relay-claude-exact', priced_model: model, match_type: 'pinned', candidates: [] }]),
  });
});

it('validates the full request, exact identifiers, and limits before mutation', async () => {
  const start = await version();
  const valid = { model: 'must-not-write', base: rates };
  expect((await send('/prices', 'GET', undefined, false)).status).toBe(401);
  expect((await send('/prices/import', 'POST', '{}', true, 'text/plain')).status).toBe(415);
  expect((await send('/prices/import', 'POST', '{')).status).toBe(400);
  expect((await send('/prices/import', 'POST', new Uint8Array([0xff]))).status).toBe(400);
  for (const invalid of [null, {}, { prices: null }, { prices: [], extra: true }, { prices: [null] }, { prices: [valid, valid] },
    ...[null, ' a', 'a\u0000b', 'é'.repeat(257), '\ud800'].map((model) => ({ prices: [valid, { model, base: rates }] })),
    ...[-1, 1e9 + 1, '1', 0.5].map((input) => ({ prices: [valid, { model: 'invalid-rate', base: { ...rates, input } }] })),
    { prices: [{ model: 'missing-rate', base: { input: 1 } }] },
    { prices: [{ model: 'unknown-rate', base: { ...rates, unknown: 1 } }] },
    { prices: [{ ...valid, tier: { state: 'supported', threshold_tokens: 0, rates } }] },
    { prices: [{ ...valid, tier: { state: 'supported', threshold_tokens: 1, rates: { ...rates, output: null } } }] },
  ]) {
    expect((await save('import', invalid)).status).toBe(400);
  }
  expect((await importPrices()).status).toBe(200);
  const exactBytes = '{"prices":[]}'.padEnd(128 * 1024, ' ');
  expect((await send('/prices/import', 'POST', exactBytes)).status).toBe(200);
  expect((await send('/prices/import', 'POST', exactBytes + ' ')).status).toBe(413);
  const rows = Array.from({ length: 513 }, (_, i) => ({ model: `batch-${i}`, base: rates }));
  expect((await importPrices(...rows)).status).toBe(413);
  expect(await version()).toBe(start);
  expect(await db.prepare("SELECT model FROM model_prices WHERE model = 'must-not-write'").first()).toBeNull();

  const before = performance.now();
  expect((await importPrices(...rows.slice(0, 512))).status).toBe(200);
  console.info(`512-row local D1 import took ${Math.round(performance.now() - before)}ms`);
  expect(await version()).toBe(start + 1);
  expect((await importPrices({ model: 'é'.repeat(256), base: rates }, { model: 'É', base: rates }, { model: 'E\u0301', base: rates })).status).toBe(200);
});

it('resolves complete model pages, replacing catalog tiers and recovering an ineligible pin', async () => {
  const model = 'candidate-1';
  const name = 'relay-candidate';
  const longName = 'x'.repeat(513);
  await db.batch([
    db.prepare('INSERT INTO request_logs (ts, model, upstream_model) VALUES (1, ?, ?), (2, ?, NULL)').bind('client', longName, 'client-only'),
    db.prepare('INSERT INTO providers (name, base_url, models, model_map) VALUES (?, ?, ?, ?)').bind(
      'price-models', 'https://relay.example', JSON.stringify([model, 'A', 'a', ...Array.from({ length: 53 }, (_, i) => `seen-${i}`)]),
      JSON.stringify({ 'mapped-*': 'actual-upstream', alias: model }),
    ),
  ]);
  invalidateConfig();
  const zeros = { input: null, output: null, cache_read: null, cache_write: null };
  const tier = { state: 'supported', threshold_tokens: 100, rates: { ...rates, cache_write: 250 } };
  expect((await importPrices({ model, base: rates, tier })).status).toBe(200);
  expect((await save('override', { model, tier: { output: 400 } })).status).toBe(200);
  expect((await save('alias', { upstream_model: name, priced_model: model })).status).toBe(200);
  expect((await save('alias', { upstream_model: name, priced_model: model })).status).toBe(200);

  expect((await importPrices({ model, base: zeros, tier: { ...tier, rates } })).status).toBe(200);
  expect(await (await send('/prices/models')).json()).toMatchObject({
    models: expect.arrayContaining([{ upstream_model: name, priced_model: null, match_type: 'none', candidates: [] }]),
  });
  const ineligibleVersion = await version();
  expect((await save('alias', { upstream_model: 'other', priced_model: model })).status).toBe(409);
  expect(await version()).toBe(ineligibleVersion);

  expect((await importPrices({ model, base: { ...zeros, input: 0 }, tier: { ...tier, rates } })).status).toBe(200);
  const config = await loadConfig(db);
  expect(resolvePrice(config.prices, name)).toMatchObject({ priced_model: model, match_type: 'pinned' });
  const record = config.prices.exact.get(model);
  expect(record?.tier.rates).toMatchObject({ cache_write: null, output: 400 });
  expect(priceUsage(config.prices, resolvePrice(config.prices, name), 'anthropic', { input: 101, output: 0, cache: 0, cacheWrite: 1 }))
    .toMatchObject({ cost_reason: 'unpriced' });
  expect((await importPrices({ model, base: { ...zeros, input: 0 } })).status).toBe(200);
  const baseConfig = await loadConfig(db);
  expect(baseConfig.prices.exact.get(model)?.tier).toMatchObject({ state: 'base', rates: zeros });

  const first = await (await send('/prices/models')).json() as { models: { upstream_model: string }[]; next_after: string; version: number };
  expect(first.models).toHaveLength(50);
  expect(first.models.slice(0, 2).map((entry) => entry.upstream_model)).toEqual(['A', 'a']);
  expect(first.next_after).toBe(first.models.at(-1)?.upstream_model);
  const second = await (await send(`/prices/models?after=${encodeURIComponent(first.next_after)}`)).json() as typeof first;
  expect(second.version).toBe(first.version);
  expect(second.next_after).toBeNull();
  const names = [...first.models, ...second.models].map((entry) => entry.upstream_model);
  expect(new Set(names).size).toBe(names.length);
  expect(names).toEqual(expect.arrayContaining(['actual-upstream', model, name, longName]));
  expect(names).not.toContain('client-only');
  expect((await save('override', { model: longName, base: { input: 1 } })).status).toBe(400);
  expect((await send(`/prices/models?after=${longName}`)).status).toBe(200);
});

it('continues a model page through a cursor too long for a request URL', async () => {
  const longName = 'é'.repeat(3000);
  await db.batch([
    db.prepare('INSERT INTO request_logs (ts, upstream_model) VALUES (1, ?), (1, ?)').bind(longName, 'Ω-final'),
  ]);
  const response = await send('/prices/models', 'POST', JSON.stringify({ after: longName }));
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(await response.json()).toMatchObject({
    models: [{ upstream_model: 'Ω-final', priced_model: null }],
    next_after: null,
  });
});

it('rolls the import and version back together and preserves concurrent writes', async () => {
  const model = 'concurrent';
  const replies = await Promise.all([importPrices({ model, base: rates }), save('override', { model, base: { input: 0 } })]);
  expect(replies.map((reply) => reply.status)).toEqual([200, 200]);
  expect((await loadConfig(db)).prices.exact.get(model)?.base).toMatchObject({ input: 0, output: 900 });

  const start = await version();
  await db.prepare(`CREATE TRIGGER refuse_price_version BEFORE UPDATE ON settings WHEN NEW.key = 'config_version'
    BEGIN SELECT RAISE(ABORT, 'test rollback'); END`).run();
  try {
    expect((await importPrices({ model, base: { ...rates, output: 3 } }, { model: 'must-roll-back', base: rates })).status).toBe(500);
  } finally {
    await db.prepare('DROP TRIGGER refuse_price_version').run();
  }
  expect(await version()).toBe(start);
  expect((await loadConfig(db)).prices.exact.get(model)?.base).toMatchObject({ input: 0, output: 900 });
  expect(await db.prepare("SELECT model FROM model_prices WHERE model = 'must-roll-back'").first()).toBeNull();
});

it('enforces both durable capacities atomically under concurrent last-slot mutations', async () => {
  const count = (await db.prepare('SELECT COUNT(*) AS total FROM model_prices').first<{ total: number }>())!.total;
  await db.prepare(`WITH RECURSIVE fill(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM fill WHERE i < ?)
    INSERT INTO model_prices (model) SELECT 'capacity-' || i FROM fill`).bind(599 - count).run();
  const start = await version();
  const round = await Promise.all([importPrices({ model: 'last-import', base: rates }), save('override', { model: 'last-manual', base: { input: 0 } })]);
  expect(round.map((response) => response.status).sort()).toEqual([200, 409]);
  expect(await version()).toBe(start + 1);
  expect((await importPrices({ model: 'batch-0', base: { ...rates, input: 99 } }, { model: 'overflow', base: rates })).status).toBe(409);
  expect(await version()).toBe(start + 1);
  expect((await loadConfig(db)).prices.exact.get('batch-0')?.base.input).toBe(rates.input);
  expect((await importPrices({ model: 'batch-0', base: rates })).status).toBe(200);

  const aliases = (await db.prepare('SELECT COUNT(*) AS total FROM model_price_aliases').first<{ total: number }>())!.total;
  await db.prepare(`WITH RECURSIVE fill(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM fill WHERE i < ?)
    INSERT INTO model_price_aliases SELECT 'alias-capacity-' || i, 'batch-0' FROM fill`).bind(1023 - aliases).run();
  const aliasStart = await version();
  const pins = await Promise.all(['last-a', 'last-b'].map((upstream_model) => save('alias', { upstream_model, priced_model: 'batch-0' })));
  expect(pins.map((response) => response.status).sort()).toEqual([200, 409]);
  expect(await version()).toBe(aliasStart + 1);
  expect((await save('alias', { upstream_model: 'alias-capacity-1', priced_model: 'batch-0' })).status).toBe(200);
});
