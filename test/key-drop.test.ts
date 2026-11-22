import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { getPlatformProxy } from 'wrangler';
import migration from '../migrations/0001_init.sql?raw';
import dropMigration from '../migrations/0002_key_drop.sql?raw';
import { encrypt } from '../src/worker/db/crypto';
import { getConfig, invalidateConfig } from '../src/worker/db/cache';
import { keyStateStmt, loadConfig, parseKey, parseProvider, parseRule, type KeyStatePatch } from '../src/worker/db/repo';
import { classify } from '../src/worker/routing/error-rules';
import { ACTIVE_PATCH, applyKeyPatch, patchForAction } from '../src/worker/routing/key-state';
import { dropListStmts, parseDropList } from '../src/worker/routing/drop-list';
import type { Env, ErrorRule, Provider, ProviderKey } from '../src/worker/types';
import worker from '../src/worker/index';

type Row = Record<string, unknown>;
type TestProxy = Awaited<ReturnType<typeof getPlatformProxy<Env>>>;

// The classify cases use these rules rather than the 0001 seed rows, which this harness does not insert. They copy
// the default invalid-token rule (body regex, any status) and the global 401 rule, so the rules match production.
const DROP_RULES: ErrorRule[] = [
  {
    id: 3,
    provider_id: null,
    priority: 30,
    status_codes: '',
    body_regex: 'invalid[_ ]?(api[_ ]?key|token)|incorrect api key|无效的令牌',
    action: 'INVALID_KEY',
    cooldown_s: null,
    note: 'Invalid key text',
    enabled: true,
    origin: 'rule',
  },
  {
    id: 5,
    provider_id: null,
    priority: 40,
    status_codes: '401',
    body_regex: null,
    action: 'INVALID_KEY',
    cooldown_s: null,
    note: '401',
    enabled: true,
    origin: 'rule',
  },
];

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

    // Legacy rows, written before migration 0002 with plain INSERTs that name only 0001 columns. The migration
    // must leave every one of them intact (DROP-04 empty edge: a key dropped before this phase reads status_code null).
    const legacyEnc = await encrypt('sk-legacy-key', env.ENCRYPTION_KEY);
    await db
      .prepare(
        "INSERT INTO provider_keys (id, provider_id, alias, key_enc, key_hint, status, status_reason, status_changed_at) VALUES (900, ?, 'legacy-invalid', ?, 'sk-leg...0000', 'invalid', 'HTTP 401: legacy bad key', ?)",
      )
      .bind(provider.id, legacyEnc, Date.UTC(2026, 10, 1))
      .run();
    await db
      .prepare(
        "INSERT INTO provider_keys (id, provider_id, alias, key_enc, key_hint, status, cooldown_until, next_recheck_at) VALUES (901, ?, 'legacy-exhausted', ?, 'sk-leg...0001', 'exhausted', NULL, ?)",
      )
      .bind(provider.id, legacyEnc, Date.UTC(2026, 10, 2))
      .run();
    await db
      .prepare(
        "INSERT INTO error_rules (id, provider_id, priority, status_codes, body_regex, action, cooldown_s, note, enabled) VALUES (902, NULL, 990, '', 'legacy-global-rule', 'UPSTREAM_ERROR', NULL, 'legacy global rule', 1)",
      )
      .run();

    // Apply 0002 the way a deploy does, one statement at a time: strip `--` comments, then split on semicolons.
    const statements = dropMigration
      .replace(/--.*$/gm, '')
      .split(';')
      .map((s) => s.trim())
      .filter(Boolean);
    for (const stmt of statements) await db.prepare(stmt).run();
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

  const invalidPatch = (reason: string): KeyStatePatch => patchForAction(provider, 'INVALID_KEY', reason, null, 401, NOW)!;
  const rateLimitedPatch = (): KeyStatePatch => patchForAction(provider, 'RATE_LIMITED', 'HTTP 429: slow down', 60, 429, NOW)!;

  it('migration 0002 only adds two columns and keeps every existing row', async () => {
    // Every statement in the file has the additive ADD COLUMN form and nothing else (T-03-07).
    const statements = dropMigration
      .replace(/--.*$/gm, '')
      .split(';')
      .map((s) => s.trim())
      .filter(Boolean);
    expect(statements).toHaveLength(2);
    for (const s of statements) expect(s).toMatch(/^ALTER TABLE \w+ ADD COLUMN /);

    // The legacy rows seeded before 0002 are all still there, each with the new defaults.
    const legacyInvalid = await rowOf(900);
    expect(legacyInvalid).toMatchObject({ status: 'invalid', status_reason: 'HTTP 401: legacy bad key', status_code: null });
    const legacyExhausted = await rowOf(901);
    expect(legacyExhausted).toMatchObject({ status: 'exhausted', status_code: null });
    // The legacy global rule seeded before 0002 is still there after it. The harness creates tables only, so the
    // 0001 seed rows are not in D1 here; this row stands in for an existing rule.
    const legacyRule = await db.prepare('SELECT * FROM error_rules WHERE id = 902').first<Row>();
    expect(parseRule(legacyRule!)).toMatchObject({ action: 'UPSTREAM_ERROR', body_regex: 'legacy-global-rule', origin: 'rule' });
  });

  it('a 403 from the relay drops the key and stores status_code 403 in D1', async () => {
    const id = await seedKey({ status: 'active' });
    const key = await keyOf(id);
    const patch = patchForAction(provider, 'INVALID_KEY', 'HTTP 403: forbidden', null, 403, NOW)!;
    expect(patch.status_code).toBe(403);
    await applyKeyPatch(env, key, patch, NOW);
    expect(parseKey(await rowOf(id))).toMatchObject({ status: 'invalid', status_reason: 'HTTP 403: forbidden', status_code: 403, status_changed_at: NOW });
  });

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

  it('first drop wins keeps the status code too', async () => {
    const id = await seedKey({ status: 'active' });
    const stale = await keyOf(id); // read before any drop

    const first = patchForAction(provider, 'INVALID_KEY', 'HTTP 403: first', null, 403, T_FIRST)!;
    await applyKeyPatch(env, await keyOf(id), first, T_FIRST);
    const afterFirst = await rowOf(id);
    expect(afterFirst).toMatchObject({ status: 'invalid', status_reason: 'HTTP 403: first', status_code: 403, status_changed_at: T_FIRST });

    // A later drop with another code, through a stale active copy: it must not change code, reason or time.
    const second = patchForAction(provider, 'INVALID_KEY', 'HTTP 429: second', null, 429, T_SECOND)!;
    await applyKeyPatch(env, stale, second, T_SECOND);
    expect(await rowOf(id)).toEqual(afterFirst);
  });

  it('Re-enable clears the drop record and a later drop records its own code', async () => {
    const id = await seedKey({ status: 'active' });
    await applyKeyPatch(env, await keyOf(id), patchForAction(provider, 'INVALID_KEY', 'HTTP 403: forbidden', null, 403, T_FIRST)!, T_FIRST);
    expect(await rowOf(id)).toMatchObject({ status: 'invalid', status_code: 403 });

    // Forced ACTIVE_PATCH is the explicit Re-enable: it clears the code together with the reason.
    await applyKeyPatch(env, await keyOf(id), ACTIVE_PATCH, T_SECOND, true);
    expect(await rowOf(id)).toMatchObject({ status: 'active', status_code: null, status_reason: null });

    // A later drop after Re-enable records its own code.
    await applyKeyPatch(env, await keyOf(id), patchForAction(provider, 'INVALID_KEY', 'HTTP 418: teapot', null, 418, NOW)!, NOW);
    expect(await rowOf(id)).toMatchObject({ status: 'invalid', status_code: 418, status_reason: 'HTTP 418: teapot' });
  });

  it('a drop never stores 0: an INVALID_KEY with no relay status stores a null code', async () => {
    // Status 0 means no HTTP answer (the cannot-decrypt path). The drop still happens, but the code stays null.
    const id = await seedKey({ status: 'active' });
    const patch = patchForAction(provider, 'INVALID_KEY', 'cannot decrypt key (ENCRYPTION_KEY changed?)', null, 0, NOW)!;
    expect(patch.status_code).toBeNull();
    await applyKeyPatch(env, await keyOf(id), patch, NOW);
    const row = await rowOf(id);
    expect(row).toMatchObject({ status: 'invalid', status_code: null });
    expect(row.status_code).not.toBe(0);
  });

  it('a key dropped before this phase reads back with no code', async () => {
    // Legacy row 900 was dropped by 0001 rules before migration 0002, so its status_code is NULL.
    const cfgKey = parseKey(await rowOf(900));
    expect(cfgKey).toMatchObject({ status: 'invalid', status_reason: 'HTTP 401: legacy bad key', status_code: null });
    expect(cfgKey.status_changed_at).toBe(Date.UTC(2026, 10, 1));
  });

  it('a relay answer with an empty body drops with a readable reason', async () => {
    const id = await seedKey({ status: 'active' });
    const cls = classify(DROP_RULES, provider.id, 401, '', null);
    expect(cls).toMatchObject({ action: 'INVALID_KEY', reason: 'empty response body' });
    const patch = patchForAction(provider, cls.action, cls.reason, cls.cooldownS, 401, NOW)!;
    await applyKeyPatch(env, await keyOf(id), patch, NOW);
    expect(parseKey(await rowOf(id))).toMatchObject({ status: 'invalid', status_reason: 'empty response body', status_code: 401 });
  });

  it('a drop from an error inside a 200 reply stores 200', async () => {
    const id = await seedKey({ status: 'active' });
    const body = '{"error":{"message":"invalid_api_key: the token is bad"}}';
    const cls = classify(DROP_RULES, provider.id, 200, body, null);
    expect(cls.action).toBe('INVALID_KEY');
    const patch = patchForAction(provider, cls.action, cls.reason, cls.cooldownS, 200, NOW)!;
    expect(patch.status_code).toBe(200);
    await applyKeyPatch(env, await keyOf(id), patch, NOW);
    expect(parseKey(await rowOf(id))).toMatchObject({ status: 'invalid', status_code: 200 });
  });

  it('a non-ASCII message round-trips and a long one is cut at 300 characters', async () => {
    const idCn = await seedKey({ status: 'active' });
    await applyKeyPatch(env, await keyOf(idCn), patchForAction(provider, 'INVALID_KEY', '余额不足', null, 401, NOW)!, NOW);
    expect((await rowOf(idCn)).status_reason).toBe('余额不足');
    expect(parseKey(await rowOf(idCn)).status_reason).toBe('余额不足');

    const idLong = await seedKey({ status: 'active' });
    const long = 'x'.repeat(400);
    await applyKeyPatch(env, await keyOf(idLong), patchForAction(provider, 'INVALID_KEY', long, null, 401, NOW)!, NOW);
    const stored = (await rowOf(idLong)).status_reason as string;
    expect(stored).toHaveLength(300);
    expect(stored).toBe(long.slice(0, 300));
  });

  it('admin Disable keeps the first drop code, reason and time, on a stale active read and on an already dropped row', async () => {
    const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
    const adminEnv = { ...env, ADMIN_PASSWORD: 'pw-code-race', SESSION_SECRET: 'sess-code-race' };
    const login = await worker.fetch(
      new Request('https://gw.test/api/admin/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password: 'pw-code-race' }),
      }),
      adminEnv,
      ctx,
    );
    const cookie = login.headers.get('set-cookie')!.split(';')[0];

    // Case 1: the row is already dropped with HTTP 403 when Disable arrives.
    const alreadyDropped = await seedKey({ status: 'active' });
    await db
      .prepare("UPDATE provider_keys SET status = 'invalid', status_reason = 'HTTP 403: first reason', status_code = 403, status_changed_at = ? WHERE id = ?")
      .bind(T_FIRST, alreadyDropped)
      .run();
    const droppedSnapshot = await rowOf(alreadyDropped);
    const disable1 = await worker.fetch(
      new Request(`https://gw.test/api/admin/keys/${alreadyDropped}`, {
        method: 'PUT',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ status: 'disabled' }),
      }),
      adminEnv,
      ctx,
    );
    expect(disable1.status).toBe(200);
    expect(await rowOf(alreadyDropped)).toEqual(droppedSnapshot);

    // Case 2: Disable reads an active row, a 403 drop commits after that read, and Disable must not overwrite it.
    const raced = await seedKey({ status: 'active' });
    const staleActive = await rowOf(raced);
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
    await db
      .prepare("UPDATE provider_keys SET status = 'invalid', status_reason = 'HTTP 403: winning drop', status_code = 403, status_changed_at = ? WHERE id = ?")
      .bind(T_SECOND, raced)
      .run();
    const racedSnapshot = await rowOf(raced);
    const disable2 = await worker.fetch(
      new Request(`https://gw.test/api/admin/keys/${raced}`, {
        method: 'PUT',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ status: 'disabled' }),
      }),
      { ...adminEnv, DB: staleDb },
      ctx,
    );
    expect(disable2.status).toBe(200);
    expect(served).toBe(true);
    expect(await rowOf(raced)).toEqual(racedSnapshot);
    expect((await rowOf(raced)).status_code).toBe(403);

    // Explicit Re-enable through the same route clears the code and the reason.
    const reenable = await worker.fetch(
      new Request(`https://gw.test/api/admin/keys/${raced}`, {
        method: 'PUT',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ status: 'active' }),
      }),
      adminEnv,
      ctx,
    );
    expect(reenable.status).toBe(200);
    expect(await rowOf(raced)).toMatchObject({ status: 'active', status_code: null, status_reason: null });
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
      const id = await seedKeyFor(balanceProvider, { status: 'exhausted', balance: 0, balance_checked_at: T_FIRST, next_recheck_at: Date.now() + 6 * 3_600_000 });

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
      const id = await seedKeyFor(balanceProvider, { status: 'exhausted', balance: 0, balance_checked_at: T_FIRST, next_recheck_at: Date.now() + 6 * 3_600_000 });
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
    // runMaintenance selects an active key for a balance refresh. If that key drops while the balance request is
    // in flight, the refresh must leave the whole row as the drop wrote it.
    it('an in-flight maintenance balance refresh cannot change a key that dropped during the fetch', async () => {
      const { runMaintenance } = await import('../src/worker/cron');
      const balanceProvider = await seedBalanceProvider();
      const id = await seedKeyFor(balanceProvider, { status: 'active', balance: 1, balance_checked_at: 0 });

      let releaseFetch!: () => void;
      const held = new Promise<void>((r) => (releaseFetch = r));
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
        await held;
        return new Response(JSON.stringify({ data: { total_available: 3000000 } }), { status: 200, headers: { 'content-type': 'application/json' } });
      });
      try {
        const maintenance = runMaintenance(env);
        while (fetchSpy.mock.calls.length < 1) await new Promise((r) => setTimeout(r, 0));
        await db
          .prepare("UPDATE provider_keys SET status = 'invalid', status_reason = 'HTTP 401: bad key', status_changed_at = ? WHERE id = ?")
          .bind(T_SECOND, id)
          .run();
        const afterDrop = await rowOf(id);

        releaseFetch();
        await maintenance;

        expect(await rowOf(id)).toEqual(afterDrop);
      } finally {
        fetchSpy.mockRestore();
      }
    });

    // Admin balance handlers: a dropped key is skipped before any request, and a drop during the fetch keeps its row.
    describe('admin balance routes (authenticated, real D1)', () => {
      const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

      async function adminCookieFor(adminEnv: Env): Promise<string> {
        const login = await worker.fetch(
          new Request('https://gw.test/api/admin/login', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ password: adminEnv.ADMIN_PASSWORD }),
          }),
          adminEnv,
          ctx,
        );
        return login.headers.get('set-cookie')!.split(';')[0];
      }

      it('single-key check-balance on an invalid key skips the balance request and writes nothing', async () => {
        const balanceProvider = await seedBalanceProvider();
        const id = await seedKeyFor(balanceProvider, { status: 'invalid', status_reason: 'HTTP 401: bad key', status_changed_at: T_FIRST });
        const before = await rowOf(id);
        const adminEnv = { ...env, ADMIN_PASSWORD: 'pw-balance-skip', SESSION_SECRET: 'sess-balance-skip' };
        const cookie = await adminCookieFor(adminEnv);
        const fetchSpy = vi.spyOn(globalThis, 'fetch');
        try {
          const res = await worker.fetch(
            new Request(`https://gw.test/api/admin/keys/${id}/check-balance`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: '{}' }),
            adminEnv,
            ctx,
          );
          expect(await res.json()).toEqual({ supported: false, balance: null, error: 'Key is dropped.' });
          expect(fetchSpy).not.toHaveBeenCalled();
          expect(await rowOf(id)).toEqual(before);
        } finally {
          fetchSpy.mockRestore();
        }
      });

      it('provider check-balances skips a dropped key and refreshes an active one', async () => {
        const balanceProvider = await seedBalanceProvider();
        const droppedId = await seedKeyFor(balanceProvider, { status: 'invalid', status_reason: 'HTTP 401: bad key', status_changed_at: T_FIRST });
        const activeId = await seedKeyFor(balanceProvider, { status: 'active' });
        const droppedBefore = await rowOf(droppedId);
        const adminEnv = { ...env, ADMIN_PASSWORD: 'pw-balance-list', SESSION_SECRET: 'sess-balance-list' };
        const cookie = await adminCookieFor(adminEnv);
        const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
          new Response(JSON.stringify({ data: { total_available: 4000000 } }), { status: 200, headers: { 'content-type': 'application/json' } }),
        );
        try {
          const res = await worker.fetch(
            new Request(`https://gw.test/api/admin/providers/${balanceProvider.id}/check-balances`, {
              method: 'POST',
              headers: { cookie, 'content-type': 'application/json' },
              body: '{}',
            }),
            adminEnv,
            ctx,
          );
          const json = (await res.json()) as { results: Array<{ key_id: number; error?: string }> };
          expect(json.results.find((r) => r.key_id === droppedId)).toMatchObject({ error: 'Key is dropped.' });
          // Only the active key reached the balance endpoint.
          expect(fetchSpy).toHaveBeenCalledTimes(1);
          expect(await rowOf(droppedId)).toEqual(droppedBefore);
          expect((await rowOf(activeId)).balance).toBe(4);
        } finally {
          fetchSpy.mockRestore();
        }
      });
    });
  });
});

// DROP-06 and DROP-07 (plan 03-03 Task 1): a saved drop list is the first rule for its provider, through real D1.
describe('drop list classification (real local D1)', () => {
  let proxy: TestProxy;
  let db: D1Database;
  let dropProvider: Provider;
  let plainProvider: Provider;

  beforeAll(async () => {
    proxy = await getPlatformProxy<Env>({ persist: false });
    db = proxy.env.DB;
    const ddls = migration.match(/CREATE TABLE [\s\S]*?\n\);/g) ?? [];
    for (const ddl of ddls) await db.prepare(ddl.replace(/--.*$/gm, '')).run();
    const statements = dropMigration
      .replace(/--.*$/gm, '')
      .split(';')
      .map((s) => s.trim())
      .filter(Boolean);
    for (const stmt of statements) await db.prepare(stmt).run();
    await db.prepare("INSERT INTO settings (key, value) VALUES ('config_version', '1')").run();
    await db
      .prepare("INSERT INTO providers (id, name, base_url, balance_mode, recheck_mode) VALUES (1, 'drop-list-provider', 'https://drop.example', 'none', 'manual')")
      .run();
    await db
      .prepare("INSERT INTO providers (id, name, base_url, balance_mode, recheck_mode) VALUES (2, 'plain-provider', 'https://plain.example', 'none', 'manual')")
      .run();
    dropProvider = parseProvider((await db.prepare('SELECT * FROM providers WHERE id = 1').first<Row>())!);
    plainProvider = parseProvider((await db.prepare('SELECT * FROM providers WHERE id = 2').first<Row>())!);

    // Operator rule for the drop-list provider at priority 0 on 403, written before the drop list. Its id is lower than
    // the drop-list row, and the drop list must still win (D-06).
    await db
      .prepare(
        "INSERT INTO error_rules (id, provider_id, priority, status_codes, body_regex, action, cooldown_s, note, enabled) VALUES (910, 1, 0, '403', NULL, 'RATE_LIMITED', 120, 'operator 403', 1)",
      )
      .run();
    // Global rules: 401 drops the key and 403 pauses it (the 0001 defaults, copied here because this harness inserts none).
    await db
      .prepare(
        "INSERT INTO error_rules (id, provider_id, priority, status_codes, body_regex, action, cooldown_s, note, enabled) VALUES (911, NULL, 40, '401', NULL, 'INVALID_KEY', NULL, '401', 1)",
      )
      .run();
    await db
      .prepare(
        "INSERT INTO error_rules (id, provider_id, priority, status_codes, body_regex, action, cooldown_s, note, enabled) VALUES (912, NULL, 50, '403', NULL, 'RATE_LIMITED', 600, '403', 1)",
      )
      .run();
  }, 60_000);

  afterAll(async () => {
    invalidateConfig();
    await proxy?.dispose();
  });

  async function seedKeyFor(p: Provider): Promise<number> {
    const enc_ = await encrypt('sk-drop-list-key', proxy.env.ENCRYPTION_KEY);
    const res = await db
      .prepare("INSERT INTO provider_keys (provider_id, alias, key_enc, key_hint, status) VALUES (?, ?, ?, 'sk-dro...0000', 'active')")
      .bind(p.id, `dl-${Math.random().toString(36).slice(2)}`, enc_)
      .run();
    return Number(res.meta.last_row_id);
  }

  async function keyRow(id: number): Promise<Row> {
    return (await db.prepare('SELECT * FROM provider_keys WHERE id = ?').bind(id).first<Row>())!;
  }

  async function keyOf(id: number): Promise<ProviderKey> {
    return parseKey(await keyRow(id));
  }

  it('a provider drop list drops a key before the operator rules and the global rules (DROP-07, D-06)', async () => {
    // Save the drop list through the Worker's own statements, in one batch, the way POST /providers does.
    await db.batch(dropListStmts(db, dropProvider.id, parseDropList('403,418', undefined)));

    const cfg = await loadConfig(db);
    const dropRow = cfg.rules.find((r) => r.origin === 'drop_list');
    expect(dropRow).toBeDefined();
    expect(cfg.rules.filter((r) => r.provider_id === dropProvider.id)[0]).toMatchObject({ origin: 'drop_list', priority: -1 });

    // 403 and 418 both drop with the drop-list rule's id, ahead of the operator rule on 403.
    expect(classify(cfg.rules, dropProvider.id, 403, 'forbidden', null)).toMatchObject({ action: 'INVALID_KEY', ruleId: dropRow!.id });
    expect(classify(cfg.rules, dropProvider.id, 418, 'teapot', null)).toMatchObject({ action: 'INVALID_KEY', ruleId: dropRow!.id });
    // 401 is not in the list, so it falls through to the global 401 rule.
    expect(classify(cfg.rules, dropProvider.id, 401, 'nope', null)).toMatchObject({ action: 'INVALID_KEY', ruleId: 911 });

    // Drop a key on 418 through the guarded UPDATE and read the code back from D1.
    const id = await seedKeyFor(dropProvider);
    const cls = classify(cfg.rules, dropProvider.id, 418, 'teapot', null);
    const patch = patchForAction(dropProvider, cls.action, cls.reason, cls.cooldownS, 418, NOW)!;
    await applyKeyPatch(proxy.env, await keyOf(id), patch, NOW);
    expect(parseKey(await keyRow(id))).toMatchObject({ status: 'invalid', status_code: 418 });
  });

  it('a provider without a drop list classifies as before (DROP-07)', async () => {
    const cfg = await loadConfig(db);
    // The plain provider has no drop-list row, so 403 is the global RATE_LIMITED rule and 401 the global INVALID_KEY rule.
    expect(classify(cfg.rules, plainProvider.id, 403, 'forbidden', null)).toMatchObject({ action: 'RATE_LIMITED', ruleId: 912 });
    expect(classify(cfg.rules, plainProvider.id, 401, 'nope', null)).toMatchObject({ action: 'INVALID_KEY', ruleId: 911 });
  });

  it('DROP-06 empty: a blank code list deletes the drop-list row and inserts none', async () => {
    await db.batch(dropListStmts(db, dropProvider.id, parseDropList('403,418', undefined)));
    expect((await loadConfig(db)).rules.some((r) => r.origin === 'drop_list' && r.provider_id === dropProvider.id)).toBe(true);
    await db.batch(dropListStmts(db, dropProvider.id, parseDropList('', undefined)));
    expect((await loadConfig(db)).rules.some((r) => r.origin === 'drop_list' && r.provider_id === dropProvider.id)).toBe(false);
  });

  it('DROP-06 encoding: a message with metacharacters matches itself literally, case-insensitively, and not looser text', async () => {
    await db.batch(dropListStmts(db, dropProvider.id, parseDropList('429', 'quota (soon).')));
    const cfg = await loadConfig(db);
    expect(classify(cfg.rules, dropProvider.id, 429, 'QUOTA (SOON).', null)).toMatchObject({ action: 'INVALID_KEY' });
    expect(classify(cfg.rules, dropProvider.id, 429, 'quota xsoonx', null).action).not.toBe('INVALID_KEY');
  });

  it('DROP-06 encoding: a CJK message matches literally on its code', async () => {
    await db.batch(dropListStmts(db, dropProvider.id, parseDropList('400', '余额不足')));
    const cfg = await loadConfig(db);
    expect(classify(cfg.rules, dropProvider.id, 400, '{"error":"余额不足，请充值"}', null)).toMatchObject({ action: 'INVALID_KEY' });
  });
});


// D-04 (plan 03-03 Task 2): one batch writes the provider, its keys, its default-route link, its drop rule and the
// version, so a failed rule INSERT leaves none of them and does not bump config_version. Real D1, real batch.
describe('provider create is atomic with its drop rule (real local D1)', () => {
  let proxy: TestProxy;
  let db: D1Database;

  beforeAll(async () => {
    proxy = await getPlatformProxy<Env>({ persist: false });
    db = proxy.env.DB;
    const ddls = migration.match(/CREATE TABLE [\s\S]*?\n\);/g) ?? [];
    for (const ddl of ddls) await db.prepare(ddl.replace(/--.*$/gm, '')).run();
    const statements = dropMigration
      .replace(/--.*$/gm, '')
      .split(';')
      .map((s) => s.trim())
      .filter(Boolean);
    for (const stmt of statements) await db.prepare(stmt).run();
    await db.prepare("INSERT INTO settings (key, value) VALUES ('config_version', '1')").run();
    // A default route, so the create path has a link to write in the same batch.
    await db.prepare("INSERT INTO routes (id, name, model_patterns, is_default, position) VALUES (1, 'default', '[]', 1, 0)").run();
  }, 60_000);

  afterAll(async () => {
    invalidateConfig();
    await proxy?.dispose();
  });

  const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

  async function cookieFor(adminEnv: Env): Promise<string> {
    const login = await worker.fetch(
      new Request('https://gw.test/api/admin/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password: adminEnv.ADMIN_PASSWORD }),
      }),
      adminEnv,
      ctx,
    );
    return login.headers.get('set-cookie')!.split(';')[0];
  }

  async function count(sql: string, ...args: unknown[]): Promise<number> {
    const row = await db.prepare(sql).bind(...args).first<{ n: number }>();
    return Number(row?.n ?? 0);
  }

  it('a drop-rule insert failure rolls back the provider, its keys, the route link and the version (D-04)', async () => {
    const adminEnv = { ...proxy.env, ADMIN_PASSWORD: 'pw-create-rollback', SESSION_SECRET: 'sess-create-rollback' };
    const cookie = await cookieFor(adminEnv);
    const name = 'Rollback Relay';
    const beforeVersion = await count("SELECT CAST(value AS INTEGER) AS n FROM settings WHERE key = 'config_version'");
    const beforeRules = await count("SELECT COUNT(*) AS n FROM error_rules WHERE origin = 'drop_list'");

    // Force the generated drop rule insert to fail. The trigger is test-only and is dropped in the cleanup below.
    await db
      .prepare("CREATE TRIGGER fail_drop_rule BEFORE INSERT ON error_rules WHEN NEW.origin = 'drop_list' BEGIN SELECT RAISE(ABORT, 'drop rule refused'); END")
      .run();
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    try {
      const failed = await worker.fetch(
        new Request('https://gw.test/api/admin/providers', {
          method: 'POST',
          headers: { cookie, 'content-type': 'application/json' },
          body: JSON.stringify({ name, base_url: 'https://rollback.example', keys: 'sk-rollback-1', drop_codes: '403' }),
        }),
        adminEnv,
        ctx,
      );
      expect(failed.status).toBe(500);
      expect(await count('SELECT COUNT(*) AS n FROM providers WHERE name = ?', name)).toBe(0);
      expect(await count('SELECT COUNT(*) AS n FROM provider_keys')).toBe(0);
      expect(await count('SELECT COUNT(*) AS n FROM route_providers')).toBe(0);
      expect(await count("SELECT COUNT(*) AS n FROM error_rules WHERE origin = 'drop_list'")).toBe(beforeRules);
      expect(await count("SELECT CAST(value AS INTEGER) AS n FROM settings WHERE key = 'config_version'")).toBe(beforeVersion);
      // The failed save never reached the models fetch.
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      await db.prepare('DROP TRIGGER fail_drop_rule').run();
      fetchSpy.mockRestore();
    }

    // The same name saves successfully once the fault is removed: the provider, the key, the route link and the rule.
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{"data":[{"id":"m1"}]}', { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    try {
      const ok = await worker.fetch(
        new Request('https://gw.test/api/admin/providers', {
          method: 'POST',
          headers: { cookie, 'content-type': 'application/json' },
          body: JSON.stringify({ name, base_url: 'https://rollback.example', keys: 'sk-rollback-1', drop_codes: '403' }),
        }),
        adminEnv,
        ctx,
      );
      expect(ok.status).toBe(201);
      const body = (await ok.json()) as { id: number };
      expect(await count('SELECT COUNT(*) AS n FROM provider_keys WHERE provider_id = ?', body.id)).toBe(1);
      expect(await count('SELECT COUNT(*) AS n FROM route_providers WHERE provider_id = ?', body.id)).toBe(1);
      expect(await count("SELECT COUNT(*) AS n FROM error_rules WHERE provider_id = ? AND origin = 'drop_list' AND status_codes = '403'", body.id)).toBe(1);
    } finally {
      vi.restoreAllMocks();
    }
  });
});
