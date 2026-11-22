import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { getPlatformProxy } from 'wrangler';
import migration from '../migrations/0001_init.sql?raw';
import { encrypt } from '../src/worker/db/crypto';
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
    return seedKeyFor(provider, seed);
  }

  /** A custom-balance provider whose balance endpoint the test controls through a fetch spy. */
  async function seedBalanceProvider(): Promise<Provider> {
    const res = await db
      .prepare(
        "INSERT INTO providers (name, base_url, balance_mode, balance_path, balance_field, balance_divisor, recheck_mode, recheck_hours) VALUES (?, 'https://balance.example', 'custom', '/api/usage', 'data.total_available', 1000000, 'balance', 6)",
      )
      .bind(`balance-provider-${++aliasSeq}`)
      .run();
    const row = await db.prepare('SELECT * FROM providers WHERE id = ?').bind(res.meta.last_row_id).first<Row>();
    return parseProvider(row!);
  }

  async function seedKeyFor(p: Provider, seed: Partial<Row> = {}): Promise<number> {
    const r = {
      status: 'active',
      status_reason: null,
      status_changed_at: null,
      cooldown_until: null,
      next_recheck_at: null,
      balance: null,
      balance_checked_at: null,
      ...seed,
    };
    const enc_ = await encrypt('sk-synthetic-key', env.ENCRYPTION_KEY);
    const res = await db
      .prepare(
        'INSERT INTO provider_keys (provider_id, alias, key_enc, key_hint, status, status_reason, status_changed_at, cooldown_until, next_recheck_at, balance, balance_checked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .bind(
        p.id,
        `alias-${++aliasSeq}`,
        enc_,
        'sk-syn...0000',
        r.status,
        r.status_reason,
        r.status_changed_at,
        r.cooldown_until,
        r.next_recheck_at,
        r.balance,
        r.balance_checked_at,
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

  // DROP-02: cron, recheck and balance refresh never touch a dropped key. Run against real D1 so the SQL
  // predicates are what proves it.
  describe('DROP-02 cron, recheck and balance writes (real local D1)', () => {
    it('cron leaves the dropped key alone', async () => {
      const { runMaintenance } = await import('../src/worker/cron');
      // runMaintenance reads the real clock, so the expired cooldowns are set relative to Date.now().
      const realNow = Date.now();
      const invalidId = await seedKey({
        status: 'invalid',
        status_reason: 'HTTP 401: bad key',
        status_changed_at: T_FIRST,
        cooldown_until: realNow - 1_000_000,
      });
      const limitedId = await seedKey({ status: 'rate_limited', status_reason: 'HTTP 429: slow', cooldown_until: realNow - 1_000 });
      const invalidBefore = await rowOf(invalidId);

      await runMaintenance(env);

      // Positive control: the rate-limited key with an expired cooldown returns to active.
      expect((await rowOf(limitedId)).status).toBe('active');
      // The dropped key is unchanged field for field.
      expect(await rowOf(invalidId)).toEqual(invalidBefore);
    });

    it('recheckKey on an invalid key returns skipped and leaves the row unchanged', async () => {
      const { recheckKey } = await import('../src/worker/cron');
      const { loadConfig } = await import('../src/worker/db/repo');
      const id = await seedKey({ status: 'invalid', status_reason: 'HTTP 401: bad key', status_changed_at: T_FIRST, next_recheck_at: null });
      const before = await rowOf(id);

      const config = await loadConfig(db);
      const outcome = await recheckKey(env, config, provider, await keyOf(id));

      expect(outcome).toMatchObject({ key_id: id, result: 'skipped' });
      expect(await rowOf(id)).toEqual(before);
    });

    // A balance fetch that was already in flight when the key dropped must not write its balance fields back.
    // The balance provider uses custom balance mode, so checkBalance makes one fetch that the test controls.
    it('an in-flight balance refresh cannot change a dropped key', async () => {
      const { recheckKey } = await import('../src/worker/cron');
      const { loadConfig } = await import('../src/worker/db/repo');
      const balanceProvider = await seedBalanceProvider();
      const id = await seedKeyFor(balanceProvider, { status: 'exhausted', balance: 0, balance_checked_at: T_FIRST, next_recheck_at: T_FIRST });

      let releaseFetch!: () => void;
      const held = new Promise<void>((r) => (releaseFetch = r));
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
        await held;
        return new Response(JSON.stringify({ data: { total_available: 999 } }), { status: 200, headers: { 'content-type': 'application/json' } });
      });
      try {
        const config = await loadConfig(db);
        const recheck = recheckKey(env, config, balanceProvider, await keyOf(id));
        // Wait until the balance request is parked, then drop the key independently.
        while (fetchSpy.mock.calls.length < 1) await new Promise((r) => setTimeout(r, 0));
        await db
          .prepare("UPDATE provider_keys SET status = 'invalid', status_reason = 'HTTP 401: bad key', status_changed_at = ? WHERE id = ?")
          .bind(T_SECOND, id)
          .run();
        const afterDrop = await rowOf(id);

        releaseFetch();
        await recheck;

        expect(await rowOf(id)).toEqual(afterDrop);
      } finally {
        fetchSpy.mockRestore();
      }
    });

    it('a normal active balance refresh still updates its balance fields', async () => {
      const { recheckKey } = await import('../src/worker/cron');
      const { loadConfig } = await import('../src/worker/db/repo');
      const balanceProvider = await seedBalanceProvider();
      const id = await seedKeyFor(balanceProvider, { status: 'exhausted', balance: 0, balance_checked_at: T_FIRST, next_recheck_at: T_FIRST });
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(JSON.stringify({ data: { total_available: 2000000 } }), { status: 200, headers: { 'content-type': 'application/json' } }),
      );
      try {
        const config = await loadConfig(db);
        await recheckKey(env, config, balanceProvider, await keyOf(id));
        const row = await rowOf(id);
        // total_available 2000000 with divisor 1000000 is a balance of 2, so the active refresh writes it.
        expect(row.balance).toBe(2);
        expect(row.balance_checked_at).not.toBe(T_FIRST);
      } finally {
        fetchSpy.mockRestore();
      }
    });

    // DROP-03 with real SQL: Disable reads an active row, a drop commits after that read, and the Disable write
    // must not overwrite the drop. The handler's first key SELECT is served the captured active row (the stale
    // read). Every other call goes to the real D1 binding, so the production SQL guard is what refuses the write.
    it('admin Disable cannot overwrite a drop that wins after its read', async () => {
      const worker = (await import('../src/worker/index')).default;
      const id = await seedKey({ status: 'active' });
      const staleActive = await rowOf(id);
      const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

      const adminEnv = { ...env, ADMIN_PASSWORD: 'pw-disable-race', SESSION_SECRET: 'sess-disable-race' };
      const login = await worker.fetch(
        new Request('https://gw.test/api/admin/login', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ password: 'pw-disable-race' }),
        }),
        adminEnv,
        ctx,
      );
      const cookie = login.headers.get('set-cookie')!.split(';')[0];

      // The first SELECT of this key by id returns the stale active row. Everything else is the real binding.
      let served = false;
      const staleDb = new Proxy(db, {
        get(target, prop) {
          if (prop === 'prepare') {
            return (sql: string) => {
              const stmt = target.prepare(sql);
              if (!served && sql.includes('SELECT * FROM provider_keys WHERE id')) {
                served = true;
                return { bind: () => ({ first: async () => staleActive }) } as unknown as D1PreparedStatement;
              }
              return stmt;
            };
          }
          const value = Reflect.get(target, prop, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      }) as unknown as D1Database;

      // The drop commits in D1 after the handler's stale read, from a different isolate.
      await db
        .prepare("UPDATE provider_keys SET status = 'invalid', status_reason = 'HTTP 401: bad key', status_changed_at = ? WHERE id = ?")
        .bind(T_FIRST, id)
        .run();
      const snapshot = await rowOf(id);

      const disable = await worker.fetch(
        new Request(`https://gw.test/api/admin/keys/${id}`, {
          method: 'PUT',
          headers: { cookie, 'content-type': 'application/json' },
          body: JSON.stringify({ status: 'disabled' }),
        }),
        { ...adminEnv, DB: staleDb },
        ctx,
      );
      expect(disable.status).toBe(200);
      expect(served).toBe(true);
      expect(await rowOf(id)).toEqual(snapshot);

      // Re-enable is the only forced path: the same route with status active clears the drop.
      const reenable = await worker.fetch(
        new Request(`https://gw.test/api/admin/keys/${id}`, {
          method: 'PUT',
          headers: { cookie, 'content-type': 'application/json' },
          body: JSON.stringify({ status: 'active' }),
        }),
        adminEnv,
        ctx,
      );
      expect(reenable.status).toBe(200);
      expect((await rowOf(id)).status).toBe('active');
    });
  });
});
