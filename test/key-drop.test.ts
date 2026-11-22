import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getPlatformProxy } from 'wrangler';
import migration from '../migrations/0001_init.sql?raw';
import { getConfig, invalidateConfig } from '../src/worker/db/cache';
import { keyStateStmt, parseKey, parseProvider, type KeyStatePatch } from '../src/worker/db/repo';
import { ACTIVE_PATCH, applyKeyPatch, patchForAction } from '../src/worker/routing/key-state';
import type { Env, Provider, ProviderKey } from '../src/worker/types';

type Row = Record<string, unknown>;
type TestProxy = Awaited<ReturnType<typeof getPlatformProxy<Env>>>;

// Fixed instants, so every drop, cooldown and re-enable in this file is written against the same clock.
const NOW = Date.UTC(2026, 10, 22, 9, 0, 0);
const T_FIRST = NOW - 60_000;
const T_SECOND = NOW;

// Real local D1 (workerd via wrangler). The SQL guard in keyStateStmt is only proven by a real engine that
// evaluates WHERE, which a hand-written fake D1 cannot do.
describe('DROP-01 request-path guard (real local D1)', () => {
  let proxy: TestProxy;
  let env: Env;
  let db: D1Database;
  let provider: Provider;
  let aliasSeq = 0;

  beforeAll(async () => {
    proxy = await getPlatformProxy<Env>({ persist: false });
    env = proxy.env;
    db = env.DB;
    const ddls = migration.match(/CREATE TABLE [\s\S]*?\n\);/g) ?? [];
    if (ddls.length === 0) throw new Error('CREATE TABLE statements not found in migrations/0001_init.sql');
    // D1 takes one statement per prepare().run(), so each table is created on its own.
    for (const ddl of ddls) await db.prepare(ddl.replace(/--.*$/gm, '')).run();
    await db.prepare("INSERT INTO settings (key, value) VALUES ('config_version', '1')").run();
    // balance_mode none and recheck_mode manual: a cron run never makes a network call against this provider.
    await db
      .prepare(
        "INSERT INTO providers (name, base_url, balance_mode, recheck_mode) VALUES ('guard-provider', 'https://relay.example', 'none', 'manual')",
      )
      .run();
    provider = parseProvider((await db.prepare("SELECT * FROM providers WHERE name = 'guard-provider'").first<Row>())!);
  }, 60_000);

  afterAll(async () => {
    invalidateConfig();
    await proxy?.dispose();
  });

  async function seedKey(seed: Partial<Row> = {}): Promise<number> {
    const r = { status: 'active', status_reason: null, status_changed_at: null, cooldown_until: null, next_recheck_at: null, ...seed };
    const res = await db
      .prepare(
        'INSERT INTO provider_keys (provider_id, alias, key_enc, key_hint, status, status_reason, status_changed_at, cooldown_until, next_recheck_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .bind(
        provider.id,
        `alias-${++aliasSeq}`,
        'enc-test',
        'sk-test...0000',
        r.status,
        r.status_reason,
        r.status_changed_at,
        r.cooldown_until,
        r.next_recheck_at,
      )
      .run();
    return Number(res.meta.last_row_id);
  }

  async function rowOf(id: number): Promise<Row> {
    const row = await db.prepare('SELECT * FROM provider_keys WHERE id = ?').bind(id).first<Row>();
    if (!row) throw new Error(`key ${id} not found`);
    return row;
  }

  /** A ProviderKey as an isolate holds it: parsed from the stored row, with optional overrides for a stale copy. */
  async function keyOf(id: number, overrides: Partial<Row> = {}): Promise<ProviderKey> {
    return parseKey({ ...(await rowOf(id)), ...overrides });
  }

  const invalidPatch = (reason: string): KeyStatePatch => patchForAction(provider, 'INVALID_KEY', reason, null, NOW)!;
  const rateLimitedPatch = (): KeyStatePatch => patchForAction(provider, 'RATE_LIMITED', 'HTTP 429: slow down', 60, NOW)!;

  it('an unforced write leaves an invalid or disabled row alone and a forced write changes it', async () => {
    const invalidId = await seedKey({ status: 'invalid', status_reason: 'HTTP 401: bad key', status_changed_at: T_FIRST });
    const disabledId = await seedKey({ status: 'disabled', status_reason: 'disabled manually', status_changed_at: T_FIRST });
    const activeId = await seedKey({ status: 'active' });
    const invalidBefore = await rowOf(invalidId);
    const disabledBefore = await rowOf(disabledId);

    for (const id of [invalidId, disabledId]) {
      const res = await keyStateStmt(db, id, rateLimitedPatch(), NOW).run();
      expect(res.meta.changes).toBe(0);
    }
    expect(await rowOf(invalidId)).toEqual(invalidBefore);
    expect(await rowOf(disabledId)).toEqual(disabledBefore);

    const activeRes = await keyStateStmt(db, activeId, rateLimitedPatch(), NOW).run();
    expect(activeRes.meta.changes).toBe(1);
    expect((await rowOf(activeId)).status).toBe('rate_limited');

    const forced = await keyStateStmt(db, invalidId, ACTIVE_PATCH, NOW, true).run();
    expect(forced.meta.changes).toBe(1);
    expect((await rowOf(invalidId)).status).toBe('active');
  });

  it('a failure seen by a stale isolate leaves the drop alone', async () => {
    const id = await seedKey({ status: 'active' });
    // This isolate caches the key as active.
    invalidateConfig();
    await getConfig(env);
    const stale = await keyOf(id);

    // Another isolate drops the key in D1. That write does not bump config_version, so this cache is not told.
    await db
      .prepare("UPDATE provider_keys SET status = 'invalid', status_reason = ?, status_changed_at = ? WHERE id = ?")
      .bind('HTTP 401: bad key', T_FIRST, id)
      .run();
    const dropped = await rowOf(id);

    await applyKeyPatch(env, stale, rateLimitedPatch(), NOW);

    expect(await rowOf(id)).toEqual(dropped);
    const cfg = await getConfig(env);
    const seen = cfg.keysByProvider.get(provider.id)!.find((k) => k.id === id);
    expect(seen).toMatchObject({ status: 'invalid', status_reason: 'HTTP 401: bad key', status_changed_at: T_FIRST });
  });

  it('first drop wins: a later drop leaves the stored reason and time', async () => {
    const id = await seedKey({ status: 'active' });
    const stale = await keyOf(id); // read before the first drop, so it still says active

    await applyKeyPatch(env, await keyOf(id), invalidPatch('HTTP 401: first reason'), T_FIRST);
    const afterFirst = await rowOf(id);
    expect(afterFirst).toMatchObject({ status: 'invalid', status_reason: 'HTTP 401: first reason', status_changed_at: T_FIRST });

    await applyKeyPatch(env, stale, invalidPatch('HTTP 403: second reason'), T_SECOND);
    expect(await rowOf(id)).toEqual(afterFirst);
  });
});
