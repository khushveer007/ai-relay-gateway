import { afterAll, beforeAll, expect, it } from 'vitest';
import { getPlatformProxy, unstable_splitSqlQuery } from 'wrangler';
import initial from '../migrations/0001_init.sql?raw';
import keyDrop from '../migrations/0002_key_drop.sql?raw';
import costMigration from '../migrations/0003_cost_capture.sql?raw';
import { invalidateConfig } from '../src/worker/db/cache';
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
