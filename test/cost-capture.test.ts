import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { getPlatformProxy } from 'wrangler';
import initial from '../migrations/0001_init.sql?raw';
import keyDrop from '../migrations/0002_key_drop.sql?raw';
import { invalidateConfig } from '../src/worker/db/cache';
import { encrypt, sha256Hex } from '../src/worker/db/crypto';
import type { Env } from '../src/worker/types';
import worker from '../src/worker/index';

const token = 'sk-gw-local-cost-test';
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

function request(path = '/v1/messages') {
  const pending: Promise<unknown>[] = [];
  const ctx = {
    waitUntil: (promise: Promise<unknown>) => pending.push(promise),
    passThroughOnException: () => {},
  } as ExecutionContext;
  return {
    response: worker.fetch(new Request('https://gw.test' + path, {
      method: 'POST',
      headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
      body: '{"model":"client"}',
    }), env, ctx),
    pending,
  };
}

it('non-stream failover writes the serving attribution', async () => {
  invalidateConfig();
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
    const saved = await db.prepare('SELECT * FROM request_logs ORDER BY id').all<Record<string, unknown>>();
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
    const rows = await db.prepare('SELECT * FROM request_logs ORDER BY id').all<Record<string, unknown>>();
    expect(rows.results).toHaveLength(3);
    expect(rows.results[2]).toMatchObject({ provider_id: null, key_id: null, upstream_model: null, failovers: 1 });
    expect(JSON.parse(String(rows.results[2].attempts))).toMatchObject([
      { provider_id: 12, action: 'UPSTREAM_ERROR' },
      { provider_id: 11, action: 'UPSTREAM_ERROR' },
    ]);
  } finally {
    fetch.mockRestore();
  }
});
