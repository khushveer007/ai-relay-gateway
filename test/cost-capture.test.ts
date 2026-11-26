import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { getPlatformProxy, unstable_splitSqlQuery } from 'wrangler';
import initial from '../migrations/0001_init.sql?raw';
import keyDrop from '../migrations/0002_key_drop.sql?raw';
import costMigration from '../migrations/0003_cost_capture.sql?raw';
import { buildPriceIndex, priceUsage, quantizeRate, resolvePrice, type PriceRecord, type TokenUsage } from '../src/shared/pricing';
import { getConfig, invalidateConfig } from '../src/worker/db/cache';
import { encrypt, sha256Hex } from '../src/worker/db/crypto';
import type { Env } from '../src/worker/types';
import worker from '../src/worker/index';

const token = 'sk-gw-local-cost-test';
const sonnetRates = Object.fromEntries(Object.entries({ input: 3, output: 15, cache_read: 0.30, cache_write: 3.75 })
  .map(([name, value]) => [name, quantizeRate(value, 'usd_per_million')]));
let proxy: Awaited<ReturnType<typeof getPlatformProxy<Env>>>;
let env: Env;
let db: D1Database;

beforeAll(async () => {
  proxy = await getPlatformProxy<Env>({ persist: false });
  env = { ...proxy.env, ENCRYPTION_KEY: 'cost-capture-local-test-key' };
  db = env.DB;
  for (const statement of (initial + keyDrop).replace(/--.*$/gm, '').split(';')) {
    if (statement.trim()) await db.prepare(statement).run();
  }
  await db.prepare("INSERT INTO request_logs (ts, upstream_model, input_tokens) VALUES (1, 'historic', 1)").run();
  await db.batch(unstable_splitSqlQuery(costMigration).map((statement) => db.prepare(statement)));
  const enc = await encrypt('local-test-relay-key', env.ENCRYPTION_KEY);
  await db.batch([
    db.prepare("INSERT INTO providers (id, name, base_url, model_map) VALUES (11, 'first', 'https://first.example', '{\"client\":\"first-model\"}'), (12, 'second', 'https://second.example', '{\"client\":\"second-model\"}')"),
    db.prepare("INSERT INTO provider_keys (id, provider_id, key_enc) VALUES (21, 11, ?), (22, 12, ?)").bind(enc, enc),
    db.prepare('INSERT INTO route_providers VALUES (1, 11, 0), (1, 12, 1)'),
    db.prepare("INSERT INTO gateway_keys (id, name, key_hash, key_prefix) VALUES (31, 'test', ?, 'sk-gw-local')").bind(await sha256Hex(token)),
  ]);
}, 60_000);

afterAll(async () => {
  invalidateConfig();
  await proxy?.dispose();
});

it('freezes the Sonnet token cost with the serving model in D1', async () => {
  invalidateConfig();
  await db.batch([
    db.prepare('UPDATE route_providers SET position = CASE provider_id WHEN 11 THEN 1 ELSE 0 END'),
    db.prepare("INSERT INTO model_prices (model, catalog_imported, catalog_base) VALUES ('second-model', 1, ?)").bind(
      JSON.stringify(sonnetRates),
    ),
  ]);
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementationOnce(async () => Response.json({
    usage: { input_tokens: 105, cache_read_input_tokens: 7123, cache_creation_input_tokens: 7345, output_tokens: 6039 },
  }));
  try {
    const writes: string[] = [];
    const reads: string[] = [];
    const observed = observedDatabase(writes, reads);
    await getConfig({ ...env, DB: observed });
    expect(reads).toHaveLength(9);
    reads.length = 0;
    const flow = request('/v1/messages', observed, writes);
    const response = await flow.response;
    expect(response.status).toBe(200);
    await response.text();
    await Promise.all(flow.pending);
    expect(flow.writesOnQueue).toEqual([0]);
    expect(writes).toEqual(['request_logs']);
    expect(reads).toEqual([]);
    const frozen = await newest();
    expect(frozen).toMatchObject({
      upstream_model: 'second-model', provider_id: 12, key_id: 22,
      input_tokens: 105, cache_tokens: 7123, cache_write_tokens: 7345, output_tokens: 6039,
      cost_nano_usd: 120580650, cost_reason: null, priced_model: 'second-model', price_match_type: 'exact',
      cache_read_savings_nano_usd: 19232100,
    });
    await db.prepare(`UPDATE model_prices SET catalog_base = '{"input":0}' WHERE model = 'second-model'`).run();
    expect(await newest()).toEqual(frozen);
    expect(await db.prepare("SELECT * FROM request_logs WHERE upstream_model = 'historic'").first()).toMatchObject({
      input_tokens: 1, cost_nano_usd: null, cost_reason: null, price_match_type: null,
    });
  } finally {
    fetch.mockRestore();
  }
});

function request(path = '/v1/messages', dbBinding = db, writes: string[] = []) {
  const pending: Promise<unknown>[] = [];
  const writesOnQueue: number[] = [];
  const ctx = {
    waitUntil: (promise: Promise<unknown>) => {
      pending.push(promise);
      writesOnQueue.push(writes.length);
    },
    passThroughOnException: () => {},
  } as unknown as ExecutionContext;
  return {
    response: worker.fetch(new Request('https://gw.test' + path, {
      method: 'POST',
      headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
      body: '{"model":"client"}',
    }), { ...env, DB: dbBinding }, ctx),
    pending,
    writesOnQueue,
  };
}

function observedDatabase(writes: string[], reads: string[] = []): D1Database {
  return new Proxy(db, {
    get(target, key) {
      if (key === 'prepare') return (sql: string) => {
        const statement = target.prepare(sql);
        const write = /^(?:INSERT INTO|UPDATE|DELETE FROM) (\w+)/.exec(sql);
        if (!write) {
          reads.push(sql);
          return statement;
        }
        return {
          bind(...args: unknown[]) {
            const bound = statement.bind(...args);
            return {
              run() {
                writes.push(write[1]);
                return bound.run();
              },
            };
          },
        };
      };
      const value = Reflect.get(target, key) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

function newest() {
  return db.prepare('SELECT * FROM request_logs ORDER BY id DESC LIMIT 1').first<Record<string, unknown>>();
}

it('non-stream failover writes the serving attribution', async () => {
  invalidateConfig();
  await db.prepare('UPDATE route_providers SET position = CASE provider_id WHEN 11 THEN 0 ELSE 1 END').run();
  const previous = (await newest())?.id;
  let fail: string | null = 'first.example';
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const host = new URL(String(input)).hostname;
    expect(typeof init?.body).toBe('string');
    expect(JSON.parse(String(init?.body)).model).toBe(host.replace('.example', '-model'));
    if (fail === '*' || fail === host) return new Response('relay unavailable', { status: 502 });
    return Response.json({ usage: { input_tokens: 4, output_tokens: 2 } });
  });
  try {
    const first = request();
    const response = await first.response;
    expect(response.status).toBe(200);
    await response.text();
    await Promise.all(first.pending);
    const saved = await db.prepare('SELECT * FROM request_logs WHERE id > ? ORDER BY id').bind(previous).all<Record<string, unknown>>();
    expect(saved.results).toHaveLength(1);
    const row = saved.results[0];
    expect(row).toMatchObject({ provider_id: 12, key_id: 22, upstream_model: 'second-model', failovers: 1 });
    expect(JSON.parse(String(row.attempts))).toMatchObject([
      { provider_id: 11, key_id: 21, model: 'first-model', action: 'UPSTREAM_ERROR' },
      { provider_id: 12, key_id: 22, model: 'second-model', action: 'OK' },
    ]);

    await db.prepare('UPDATE route_providers SET position = 1 - position').run();
    invalidateConfig();
    fail = 'second.example';
    const reversed = request();
    const reversedResponse = await reversed.response;
    expect(reversedResponse.status).toBe(200);
    await reversedResponse.text();
    await Promise.all(reversed.pending);
    expect(await db.prepare('SELECT * FROM request_logs ORDER BY id DESC LIMIT 1').first()).toMatchObject({
      provider_id: 11, key_id: 21, upstream_model: 'first-model', failovers: 1,
    });

    fail = '*';
    const failed = request();
    expect((await failed.response).status).toBe(502);
    await Promise.all(failed.pending);
    const rows = await db.prepare('SELECT * FROM request_logs WHERE id > ? ORDER BY id').bind(previous).all<Record<string, unknown>>();
    expect(rows.results).toHaveLength(3);
    expect(rows.results[2]).toMatchObject({
      provider_id: null, key_id: null, upstream_model: null, failovers: 1, cost_reason: 'no_usage', price_match_type: 'none',
    });
    expect(JSON.parse(String(rows.results[2].attempts))).toMatchObject([
      { provider_id: 12, action: 'UPSTREAM_ERROR' },
      { provider_id: 11, action: 'UPSTREAM_ERROR' },
    ]);
  } finally {
    fetch.mockRestore();
  }
});

it('prices cache writes once for native Chat, relay Chat and Responses', async () => {
  await db.batch([
    db.prepare('UPDATE route_providers SET position = CASE provider_id WHEN 11 THEN 1 ELSE 0 END'),
    db.prepare(`INSERT INTO model_prices (model, catalog_imported, catalog_base) VALUES ('second-model', 1, ?)
      ON CONFLICT(model) DO UPDATE SET catalog_base = excluded.catalog_base`).bind(JSON.stringify(sonnetRates)),
  ]);
  invalidateConfig();
  const fetch = vi.spyOn(globalThis, 'fetch');
  try {
    for (const [path, body] of [
      ['/v1/chat/completions', { choices: [{ message: { output_tokens: 90_000 } }], usage: { prompt_tokens: 14573, completion_tokens: 6039,
        prompt_tokens_details: { cached_tokens: 7123, cached_creation_tokens: 7345 } } }],
      ['/v1/chat/completions', { usage: { prompt_tokens: 14573, completion_tokens: 6039,
        prompt_tokens_details: { cached_tokens: 7123, cache_write_tokens: 7345, cached_creation_tokens: 7345 } } }],
      ['/v1/responses', { response: { usage: { input_tokens: 14573, output_tokens: 6039,
        input_tokens_details: { cached_tokens: 7123, cache_write_tokens: 7345 } } } }],
    ] as const) {
      const prior = (await newest())?.id;
      fetch.mockResolvedValueOnce(Response.json(body));
      const flow = request(path);
      const response = await flow.response;
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual(body);
      await Promise.all(flow.pending);
      const actual = await db.prepare('SELECT * FROM request_logs WHERE id > ?').bind(prior).all();
      expect(actual.results).toHaveLength(1);
      expect(actual.results[0]).toMatchObject({
        input_tokens: 14573, output_tokens: 6039, cache_tokens: 7123, cache_write_tokens: 7345,
        cost_nano_usd: 120580650, priced_model: 'second-model', price_match_type: 'exact', cost_reason: null,
      });
    }
  } finally {
    fetch.mockRestore();
  }
});

it('uses the original stream price after a config change and writes once after completion or cancellation', async () => {
  await db.batch([
    db.prepare('UPDATE route_providers SET position = CASE provider_id WHEN 11 THEN 1 ELSE 0 END'),
    db.prepare(`INSERT INTO model_prices (model, catalog_imported, catalog_base) VALUES ('second-model', 1, ?)
      ON CONFLICT(model) DO UPDATE SET catalog_base = excluded.catalog_base`).bind(JSON.stringify(sonnetRates)),
  ]);
  invalidateConfig();
  const enc = new TextEncoder();
  const head = 'data: {"type":"message_start","message":{"usage":{"input_tokens":105,"output_tokens":1,"cache_read_input_tokens":7123}}}\n\n';
  const tail = [
    'data: {"type":"content_block_start","content_block":{"type":"tool_use","input":{"output_tokens":90000}}}\n\n',
    'data: {"type":"message_delta","usage":{"cache_crea', 'tion_input_tokens":73', '45,"output_tokens":60', '39}}\n\n',
  ];
  let upstream!: ReadableStreamDefaultController<Uint8Array>;
  const fetch = vi.spyOn(globalThis, 'fetch');
  const open = (cancel: () => void = () => {}) => {
    fetch.mockResolvedValueOnce(new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        upstream = controller;
        controller.enqueue(enc.encode(head));
      },
      cancel,
    }), { headers: { 'content-type': 'text/event-stream' } }));
    const writes: string[] = [];
    const flow = request('/v1/messages', observedDatabase(writes), writes);
    return { ...flow, writes };
  };
  try {
    const flow = open();
    const response = await flow.response;
    const reader = response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe(head);
    expect(flow.writes).toEqual([]);
    await db.batch([
      db.prepare(`UPDATE model_prices SET override_base = '{"input":0,"output":0,"cache_read":0,"cache_write":0}' WHERE model = 'second-model'`),
      db.prepare("UPDATE settings SET value = '2' WHERE key = 'config_version'"),
    ]);
    invalidateConfig();
    fetch.mockResolvedValueOnce(Response.json({ usage: { input_tokens: 1, output_tokens: 1 } }));
    const newer = request();
    expect((await newer.response).status).toBe(200);
    await Promise.all(newer.pending);
    expect(await newest()).toMatchObject({ stream: 0, cost_nano_usd: 0 });
    for (const part of tail) upstream.enqueue(enc.encode(part));
    upstream.close();
    const received = [];
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      received.push(new TextDecoder().decode(chunk.value));
    }
    expect(received.join('')).toBe(tail.join(''));
    await Promise.all(flow.pending);
    expect(flow.writesOnQueue).toEqual([0]);
    expect(flow.writes).toEqual(['request_logs']);
    expect(await newest()).toMatchObject({
      stream: 1, cost_nano_usd: 120580650, cache_write_tokens: 7345,
      provider_id: 12, key_id: 22, upstream_model: 'second-model', price_match_type: 'exact',
    });

    const cancel = vi.fn();
    const cancelled = open(cancel);
    const cancelledBody = (await cancelled.response).body!.getReader();
    await cancelledBody.read();
    await cancelledBody.cancel('finished early');
    await Promise.all(cancelled.pending);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(cancelled.writes).toEqual(['request_logs']);
    expect(await newest()).toMatchObject({
      error: 'client disconnected', upstream_model: 'second-model', stream: 1,
      input_tokens: 105, output_tokens: 1, cost_nano_usd: null, cost_reason: 'no_usage',
    });

    const withFinalUsage = open();
    const finalBody = (await withFinalUsage.response).body!.getReader();
    await finalBody.read();
    for (const part of tail) upstream.enqueue(enc.encode(part));
    for (const _ of tail) expect((await finalBody.read()).done).toBe(false);
    await finalBody.cancel();
    await Promise.all(withFinalUsage.pending);
    expect(withFinalUsage.writes).toEqual(['request_logs']);
    expect(await newest()).toMatchObject({
      error: 'client disconnected', output_tokens: 6039, cost_nano_usd: 0, cost_reason: null,
    });
  } finally {
    fetch.mockRestore();
  }
});

it('distinguishes no usage, unpriced usage and zero for plain requests', async () => {
  await db.batch([
    db.prepare('UPDATE route_providers SET position = CASE provider_id WHEN 11 THEN 0 ELSE 1 END'),
    db.prepare('UPDATE providers SET parse_usage = 1 WHERE id = 11'),
  ]);
  invalidateConfig();
  const fetch = vi.spyOn(globalThis, 'fetch');
  const call = async (body: unknown) => {
    fetch.mockResolvedValueOnce(Response.json(body));
    const flow = request();
    expect((await flow.response).status).toBe(200);
    await Promise.all(flow.pending);
    return newest();
  };
  try {
    expect(await call({})).toMatchObject({ cost_reason: 'no_usage', cost_nano_usd: null });
    expect(await call({ usage: { input_tokens: 0 } })).toMatchObject({ cost_reason: 'unpriced', cost_nano_usd: null });
    await db.prepare(`INSERT INTO model_prices (model, catalog_base) VALUES ('first-model', '{"input":0}')`).run();
    invalidateConfig();
    expect(await call({ usage: { input_tokens: 4 } })).toMatchObject({ cost_reason: null, cost_nano_usd: 0 });
    await db.prepare('UPDATE providers SET parse_usage = 0 WHERE id = 11').run();
    invalidateConfig();
    expect(await call({ usage: { input_tokens: 4, cache_creation_input_tokens: 6 } })).toMatchObject({
      input_tokens: null, cache_write_tokens: null, priced_model: 'first-model', cost_reason: 'no_usage', cost_nano_usd: null,
    });
  } finally {
    fetch.mockRestore();
  }
});

it('rounds signed savings and exact request totals, preserving zero and guarding overflow', () => {
  const price = (catalog_base: PriceRecord['catalog_base'], catalog_tier?: PriceRecord['catalog_tier']) => buildPriceIndex([{
    model: 'model', catalog_imported: true, catalog_base, override_base: {},
    catalog_tier: catalog_tier ?? { state: 'base', threshold_tokens: null, rates: {} }, override_tier: {},
  }]);
  const usage = { input: null, output: null, cache: null, cacheWrite: null } satisfies TokenUsage;
  const cost = (index: ReturnType<typeof price>, values: Partial<TokenUsage>, format = 'anthropic') =>
    priceUsage(index, resolvePrice(index, 'model'), format, { ...usage, ...values });

  for (const [rate, expected] of [[499, 0], [500, 1], [501, 1]]) {
    expect(cost(price({ output: rate }), { output: 1 }).cost_nano_usd).toBe(expected);
  }
  expect(cost(price({ input: 250, output: 250 }), { input: 1, output: 1 }).cost_nano_usd).toBe(1);
  expect(cost(price({ input: 1, cache_read: 501 }), { input: 0, cache: 1 }).cache_read_savings_nano_usd).toBe(-1);
  expect(cost(price({ input: 501, cache_read: 1 }), { input: 0, cache: 1 }).cache_read_savings_nano_usd).toBe(1);
  expect(cost(price({ input: 1 }), {}).cost_reason).toBe('no_usage');
  expect(cost(price({ input: 1 }), { input: 0 }).cost_nano_usd).toBe(0);
  expect(cost(price({ input: 0 }), { input: 1 }).cost_nano_usd).toBe(0);
  expect(cost(price({ input: 0 }), { output: 1 }).cost_reason).toBe('unpriced');
  expect(cost(price({ input: 1_000_000_000 }), { input: Number.MAX_SAFE_INTEGER }).cost_reason).toBe('unpriced');
  expect(cost(price({ input: 1 }), { input: Number.MAX_SAFE_INTEGER + 1 }).cost_reason).toBe('unpriced');
  const tier = price({ input: 1000, cache_read: 1000, cache_write: 1000, output: 1000 }, {
    state: 'supported', threshold_tokens: 100, rates: { input: 2000, cache_read: 2000, cache_write: 2000 },
  });
  for (const [cacheWrite, expected, threshold] of [[8, 99, null], [9, 100, null], [10, 202, 100]]) {
    expect(cost(tier, { input: 90, cache: 1, cacheWrite })).toMatchObject({
      cost_nano_usd: expected, price_tier_threshold_tokens: threshold,
    });
  }
  expect(cost(tier, { input: 101, cache: 17, cacheWrite: 90 }, 'openai-chat')).toMatchObject({
    cost_nano_usd: 214, price_tier_threshold_tokens: 100,
  });
  expect(cost(tier, { input: 101, output: 1 }).cost_reason).toBe('unpriced');
  expect(cost(tier, { input: 101, output: 0 }).cost_nano_usd).toBe(202);
  expect(cost(tier, { output: 1 }).cost_reason).toBe('unpriced');
  expect(cost(tier, { cache: 101 }, 'openai-responses').cost_nano_usd).toBe(202);
  const unsupported = price({ input: 1000 }, { state: 'unsupported', threshold_tokens: 100, rates: {} });
  expect(cost(unsupported, { input: 100 }).cost_nano_usd).toBe(100);
  expect(cost(unsupported, { input: 101 })).toMatchObject({ cost_reason: 'unpriced', price_tier_threshold_tokens: null });
  const unknownTier = price({ input: 1000 }, { state: 'unsupported', threshold_tokens: null, rates: {} });
  expect(cost(unknownTier, { input: 1 }).cost_reason).toBe('unpriced');
  expect(cost(unknownTier, { input: 0 }).cost_nano_usd).toBe(0);
});
