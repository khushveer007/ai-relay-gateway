import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSession, verifySession } from '../src/worker/admin/auth';
import { invalidateConfig } from '../src/worker/db/cache';
import { decrypt, encrypt, keyHint, safeEqual, sha256Hex } from '../src/worker/db/crypto';
import worker from '../src/worker/index';
import { detectFormat, extractModel, looksLikeJsonError, replaceModel } from '../src/worker/proxy/formats';
import { handleModels, handleProxy } from '../src/worker/proxy/forward';
import { peekStream } from '../src/worker/proxy/stream-peek';
import { UsageTap } from '../src/worker/proxy/usage';
import { buildProviderPayload, emptyProviderForm } from '../src/dashboard/lib/provider-form';
import { classify } from '../src/worker/routing/error-rules';
import { globMatch, mapModel, supportsModel } from '../src/worker/routing/model-map';
import { resolveRoute } from '../src/worker/routing/resolve-route';
import { isUsable, orderKeys } from '../src/worker/routing/select-key';
import type { Config, Env, ErrorRule, GatewayKey, Provider, ProviderKey, Route } from '../src/worker/types';

const DEFAULT_RULES: ErrorRule[] = [
  {
    id: 1,
    provider_id: null,
    priority: 10,
    status_codes: '',
    body_regex:
      'insufficient[_ ]?(quota|balance|credit|funds)|余额不足|额度不足|额度已用尽|credit balance is too low|out of credits|exceeded your current quota',
    action: 'EXHAUSTED',
    cooldown_s: null,
    note: 'Out of balance',
    enabled: true,
  },
  { id: 2, provider_id: null, priority: 20, status_codes: '402', body_regex: null, action: 'EXHAUSTED', cooldown_s: null, note: '402', enabled: true },
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
  },
  {
    id: 4,
    provider_id: null,
    priority: 35,
    status_codes: '',
    body_regex: 'model_not_found|no available channel|无可用渠道',
    action: 'UPSTREAM_ERROR',
    cooldown_s: null,
    note: 'Model not available',
    enabled: true,
  },
  { id: 5, provider_id: null, priority: 40, status_codes: '401', body_regex: null, action: 'INVALID_KEY', cooldown_s: null, note: '401', enabled: true },
  { id: 6, provider_id: null, priority: 50, status_codes: '403', body_regex: null, action: 'RATE_LIMITED', cooldown_s: 600, note: '403', enabled: true },
  { id: 7, provider_id: null, priority: 60, status_codes: '429', body_regex: null, action: 'RATE_LIMITED', cooldown_s: 60, note: '429', enabled: true },
  { id: 8, provider_id: null, priority: 70, status_codes: '408,500-599', body_regex: null, action: 'UPSTREAM_ERROR', cooldown_s: null, note: '5xx', enabled: true },
  { id: 9, provider_id: null, priority: 80, status_codes: '400-499', body_regex: null, action: 'CLIENT_ERROR', cooldown_s: null, note: '4xx', enabled: true },
];

function makeProvider(overrides: Partial<Provider> = {}): Provider {
  return {
    id: 1,
    name: 'prov-a',
    base_url: 'https://relay-a.example.com',
    formats: ['anthropic', 'openai-chat', 'openai-responses'],
    key_strategy: 'sequential',
    model_map: {},
    models: [],
    models_fetched_at: null,
    model_allowlist: false,
    balance_mode: 'standard',
    balance_path: null,
    balance_field: null,
    balance_divisor: 1,
    recheck_mode: 'auto',
    recheck_hours: 6,
    test_model: null,
    parse_usage: true,
    timeout_ms: 5000,
    extra_headers: {},
    enabled: true,
    created_at: 0,
    ...overrides,
  };
}

function makeKey(overrides: Partial<ProviderKey> = {}): ProviderKey {
  return {
    id: 1,
    provider_id: 1,
    alias: 'k1',
    key_enc: '',
    key_hint: 'sk-1…1111',
    priority: 0,
    status: 'active',
    status_reason: null,
    status_changed_at: null,
    cooldown_until: null,
    next_recheck_at: null,
    balance: null,
    balance_checked_at: null,
    created_at: 0,
    ...overrides,
  };
}

describe('Crypto & Auth helpers', () => {
  it('encrypts and decrypts upstream keys with AES-256-GCM', async () => {
    const secret = 'test-encryption-secret-32-bytes!!';
    const plain = 'sk-ant-api03-super-secret-upstream-key';
    const ct1 = await encrypt(plain, secret);
    const ct2 = await encrypt(plain, secret);
    expect(ct1).not.toBe(ct2); // random IV
    expect(await decrypt(ct1, secret)).toBe(plain);
    expect(await decrypt(ct2, secret)).toBe(plain);
    expect(keyHint(plain)).toBe('sk-ant…-key');
  });

  it('signs and verifies admin sessions and performs constant-time comparison', async () => {
    const secret = 'session-secret-xyz';
    const token = await createSession(secret);
    expect(await verifySession(token, secret)).toBe(true);
    expect(await verifySession(token, 'wrong-secret')).toBe(false);
    expect(await verifySession(`${token}tamper`, secret)).toBe(false);
    expect(await safeEqual('abc', 'abc')).toBe(true);
    expect(await safeEqual('abc', 'def')).toBe(false);
  });
});

describe('Error Classifier', () => {
  it('classifies default error rules accurately', () => {
    expect(classify(DEFAULT_RULES, 1, 402, '{"error":{"message":"Payment required"}}').action).toBe('EXHAUSTED');
    expect(
      classify(DEFAULT_RULES, 1, 429, '{"error":{"message":"You exceeded your current quota"}}').action,
    ).toBe('EXHAUSTED');
    expect(classify(DEFAULT_RULES, 1, 400, '{"error":{"message":"该令牌额度已用尽"}}').action).toBe('EXHAUSTED');
    expect(classify(DEFAULT_RULES, 1, 401, '{"error":{"message":"Unauthorized"}}').action).toBe('INVALID_KEY');
    expect(classify(DEFAULT_RULES, 1, 200, '{"error":{"message":"无效的令牌"}}').action).toBe('INVALID_KEY');

    const rl = classify(DEFAULT_RULES, 1, 429, '{"error":{"message":"Too many requests per minute"}}', '45');
    expect(rl.action).toBe('RATE_LIMITED');
    expect(rl.cooldownS).toBe(45);

    expect(classify(DEFAULT_RULES, 1, 503, 'Service Unavailable').action).toBe('UPSTREAM_ERROR');
    expect(classify(DEFAULT_RULES, 1, 400, '{"error":{"message":"No available channel for model"}}').action).toBe('UPSTREAM_ERROR');
    expect(classify(DEFAULT_RULES, 1, 400, '{"error":{"message":"messages.0.content is required"}}').action).toBe('CLIENT_ERROR');
  });

  it('evaluates per-provider rules before global rules', () => {
    const providerRule: ErrorRule = {
      id: 99,
      provider_id: 7,
      priority: 100,
      status_codes: '400',
      body_regex: 'custom_relay_empty_wallet',
      action: 'EXHAUSTED',
      cooldown_s: null,
      note: 'Custom relay 400 exhausted',
      enabled: true,
    };
    const rules = [providerRule, ...DEFAULT_RULES];
    expect(classify(rules, 7, 400, '{"error":"custom_relay_empty_wallet"}').action).toBe('EXHAUSTED');
    expect(classify(rules, 2, 400, '{"error":"custom_relay_empty_wallet"}').action).toBe('CLIENT_ERROR');
  });
});

describe('Key Selection & Route Resolution', () => {
  it('orders keys sequentially or round-robin while skipping unusable keys', () => {
    const now = 1_000_000;
    const keys: ProviderKey[] = [
      makeKey({ id: 1, priority: 0, status: 'exhausted' }),
      makeKey({ id: 2, priority: 1, status: 'rate_limited', cooldown_until: now + 30_000 }),
      makeKey({ id: 3, priority: 2, status: 'rate_limited', cooldown_until: now - 1_000 }), // expired cooldown -> usable!
      makeKey({ id: 4, priority: 3, status: 'active' }),
      makeKey({ id: 5, priority: 4, status: 'invalid' }),
    ];

    const seqProv = makeProvider({ id: 10, key_strategy: 'sequential' });
    expect(orderKeys(seqProv, keys, now).map((k) => k.id)).toEqual([3, 4]);
    expect(orderKeys(seqProv, keys, now).map((k) => k.id)).toEqual([3, 4]);

    const rrProv = makeProvider({ id: 11, key_strategy: 'round_robin' });
    expect(orderKeys(rrProv, keys, now).map((k) => k.id)).toEqual([3, 4]);
    expect(orderKeys(rrProv, keys, now).map((k) => k.id)).toEqual([4, 3]);
    expect(orderKeys(rrProv, keys, now).map((k) => k.id)).toEqual([3, 4]);
  });

  it('resolves routes by gateway key binding, then model glob, then default', () => {
    const routes: Route[] = [
      { id: 1, name: 'claude-route', model_patterns: ['claude-*'], is_default: false, position: 10, provider_ids: [1] },
      { id: 2, name: 'pinned-route', model_patterns: [], is_default: false, position: 20, provider_ids: [2] },
      { id: 3, name: 'default', model_patterns: [], is_default: true, position: 1000, provider_ids: [1, 2] },
    ];
    const cfg = { routes } as Config;
    const freeKey: GatewayKey = { id: 1, name: 'free', key_hash: 'h1', key_prefix: 'sk-gw-1', route_id: null, enabled: true, created_at: 0 };
    const pinnedKey: GatewayKey = { ...freeKey, id: 2, route_id: 2 };

    expect(resolveRoute(cfg, pinnedKey, 'claude-3-7-sonnet')?.name).toBe('pinned-route');
    expect(resolveRoute(cfg, freeKey, 'claude-3-7-sonnet')?.name).toBe('claude-route');
    expect(resolveRoute(cfg, freeKey, 'gpt-4.1')?.name).toBe('default');
  });

  it('maps models and checks allowlist', () => {
    const p = makeProvider({
      model_map: { 'claude-sonnet-*': 'anthropic/claude-3.7-sonnet', 'gpt-fast': 'gpt-4.1-mini' },
      models: ['gpt-4.1', 'o3'],
      model_allowlist: true,
    });
    expect(globMatch('claude-*', 'Claude-3-Opus')).toBe(true);
    expect(mapModel(p, 'gpt-fast')).toBe('gpt-4.1-mini');
    expect(mapModel(p, 'claude-sonnet-4')).toBe('anthropic/claude-3.7-sonnet');
    expect(supportsModel(p, 'gpt-4.1')).toBe(true);
    expect(supportsModel(p, 'claude-sonnet-4')).toBe(true);
    expect(supportsModel(p, 'unknown-model')).toBe(false);
  });
});

describe('SSE Stream Peek & Token Usage Tap', () => {
  function streamFromChunks(chunks: string[]): ReadableStream<Uint8Array> {
    const enc = new TextEncoder();
    return new ReadableStream({
      start(c) {
        for (const ch of chunks) c.enqueue(enc.encode(ch));
        c.close();
      },
    });
  }

  it('peeks split SSE chunks and preserves exact bytes on re-emit', async () => {
    const chunks = [': keepalive\n\n', 'event: message_start\ndata: {"type":"message_', 'start","message":{"id":"1"}}\n\n', 'data: {"type":"ping"}\n\n'];
    const peek = await peekStream(streamFromChunks(chunks));
    expect(peek.kind).toBe('content');

    const dec = new TextDecoder();
    let reassembled = dec.decode(peek.head, { stream: true });
    while (true) {
      const r = await peek.reader.read();
      if (r.done) break;
      reassembled += dec.decode(r.value, { stream: true });
    }
    expect(reassembled).toBe(chunks.join(''));
  });

  it('detects error events inside HTTP 200 SSE streams', async () => {
    const errStream = streamFromChunks(['event: error\ndata: {"type":"error","error":{"message":"余额不足"}}\n\n']);
    const peek = await peekStream(errStream);
    expect(peek.kind).toBe('error');
    expect(peek.headText).toContain('余额不足');
  });

  it('extracts token usage across Anthropic, OpenAI Chat, and OpenAI Responses formats', () => {
    const tap1 = new UsageTap();
    tap1.feedText('event: message_start\ndata: {"message":{"usage":{"input_tokens":420,"cache_read_input_tokens":100}}}\n\n');
    tap1.feedText('event: message_delta\ndata: {"usage":{"output_tokens":85}}\n\n');
    expect(tap1.usage).toEqual({ input: 420, output: 85, cache: 100 });

    const tap2 = new UsageTap();
    tap2.feedText('data: {"choices":[],"usage":{"prompt_tokens":50,"completion_tokens":25,"prompt_tokens_details":{"cached_tokens":10}}}\n\n');
    expect(tap2.usage).toEqual({ input: 50, output: 25, cache: 10 });
  });

  it('rewrites model in request JSON without full parse', () => {
    const body = '{"model":"claude-3-7-sonnet","messages":[{"role":"user","content":"hello"}]}';
    expect(extractModel(body)).toBe('claude-3-7-sonnet');
    expect(replaceModel(body, 'claude-3-7-sonnet-20250219')).toContain('"model":"claude-3-7-sonnet-20250219"');
    expect(detectFormat('/v1/messages')).toBe('anthropic');
    expect(detectFormat('/v1/responses')).toBe('openai-responses');
    expect(detectFormat('/v1/chat/completions')).toBe('openai-chat');
    expect(looksLikeJsonError('{"error":{"message":"quota exceeded"}}')).toBe(true);
  });
});

describe('Full Proxy Failover & Admin Integration', () => {
  const ENC_SECRET = 'test-enc-secret';
  const SESS_SECRET = 'test-sess-secret';
  const ADMIN_PW = 'super-admin-pw';
  const GW_TOKEN = 'sk-gw-testtoken123';

  let mockProviders: Record<string, unknown>[];
  let mockKeys: Record<string, unknown>[];
  let mockRoutes: Record<string, unknown>[];
  let mockRouteProviders: Record<string, unknown>[];
  let mockRules: Record<string, unknown>[];
  let mockGatewayKeys: Record<string, unknown>[];
  let mockSettings: Record<string, unknown>[];
  let insertedLogs: unknown[][];
  let keyUpdates: Array<{ id: number; status: string; reason: string | null }>;
  let providerInserts: unknown[][];
  let providerUpdates: unknown[][];
  let env: Env;

  beforeEach(async () => {
    invalidateConfig();
    insertedLogs = [];
    keyUpdates = [];
    providerInserts = [];
    providerUpdates = [];

    const k1Enc = await encrypt('sk-provA-key1', ENC_SECRET);
    const k2Enc = await encrypt('sk-provA-key2', ENC_SECRET);
    const k3Enc = await encrypt('sk-provB-key1', ENC_SECRET);

    mockProviders = [
      {
        id: 1,
        name: 'ProviderA',
        base_url: 'https://prov-a.test',
        formats: '["anthropic","openai-chat"]',
        key_strategy: 'sequential',
        model_map: '{}',
        models: '["claude-sonnet-4","gpt-4.1"]',
        models_fetched_at: 1000,
        model_allowlist: 0,
        balance_mode: 'standard',
        balance_path: null,
        balance_field: null,
        balance_divisor: 1,
        recheck_mode: 'auto',
        recheck_hours: 6,
        test_model: null,
        parse_usage: 1,
        timeout_ms: 5000,
        extra_headers: '{}',
        enabled: 1,
        created_at: 0,
      },
      {
        id: 2,
        name: 'ProviderB',
        base_url: 'https://prov-b.test',
        formats: '["anthropic","openai-chat","openai-responses"]',
        key_strategy: 'sequential',
        model_map: '{"claude-sonnet-4":"anthropic/claude-sonnet-4"}',
        models: '["anthropic/claude-sonnet-4"]',
        models_fetched_at: 1000,
        model_allowlist: 0,
        balance_mode: 'none',
        balance_path: null,
        balance_field: null,
        balance_divisor: 1,
        recheck_mode: 'auto',
        recheck_hours: 6,
        test_model: null,
        parse_usage: 1,
        timeout_ms: 5000,
        extra_headers: '{}',
        enabled: 1,
        created_at: 0,
      },
    ];

    mockKeys = [
      { id: 101, provider_id: 1, alias: 'A-1', key_enc: k1Enc, key_hint: 'sk-pro…key1', priority: 0, status: 'active', created_at: 0 },
      { id: 102, provider_id: 1, alias: 'A-2', key_enc: k2Enc, key_hint: 'sk-pro…key2', priority: 1, status: 'active', created_at: 0 },
      { id: 201, provider_id: 2, alias: 'B-1', key_enc: k3Enc, key_hint: 'sk-pro…key1', priority: 0, status: 'active', created_at: 0 },
    ];

    mockRoutes = [{ id: 1, name: 'default', model_patterns: '[]', is_default: 1, position: 1000 }];
    mockRouteProviders = [
      { route_id: 1, provider_id: 1, position: 0 },
      { route_id: 1, provider_id: 2, position: 1 },
    ];
    mockRules = DEFAULT_RULES.map((r) => ({ ...r, enabled: 1 }));
    mockGatewayKeys = [
      {
        id: 1,
        name: 'TestClient',
        key_hash: await sha256Hex(GW_TOKEN),
        key_prefix: 'sk-gw-testto',
        route_id: null,
        enabled: 1,
        created_at: 0,
      },
    ];
    mockSettings = [
      { key: 'log_retention_days', value: '7' },
      { key: 'max_attempts', value: '10' },
      { key: 'balance_refresh_hours', value: '6' },
      { key: 'config_version', value: '1' },
    ];

    const fakePrepare = (sql: string) => {
      let bound: unknown[] = [];
      const stmt: any = {
        sql,
        bind(...args: unknown[]) {
          bound = args;
          return stmt;
        },
        async run() {
          if (sql.includes('INSERT INTO request_logs')) {
            insertedLogs.push(bound);
          } else if (sql.includes('UPDATE provider_keys')) {
            keyUpdates.push({ id: Number(bound[5]), status: String(bound[0]), reason: bound[1] as string | null });
          } else if (sql.startsWith('UPDATE providers SET')) {
            providerUpdates.push(bound);
          } else if (sql.startsWith('INSERT INTO providers')) {
            // The create handler reads res.results[0].id from RETURNING id.
            providerInserts.push(bound);
            return { results: [{ id: 3 }], success: true, meta: { changes: 1 } };
          }
          return { results: [], success: true, meta: { changes: 1 } };
        },
        async all() {
          if (sql.includes('FROM providers')) return { results: mockProviders };
          if (sql.includes('FROM provider_keys')) return { results: mockKeys };
          if (sql.includes('FROM routes')) return { results: mockRoutes };
          if (sql.includes('FROM route_providers')) return { results: mockRouteProviders };
          if (sql.includes('FROM error_rules')) return { results: mockRules };
          if (sql.includes('FROM gateway_keys')) return { results: mockGatewayKeys };
          if (sql.includes('FROM settings')) return { results: mockSettings };
          return { results: [] };
        },
        async first() {
          if (sql.includes("key = 'config_version'")) return { value: '1' };
          if (sql.includes('SELECT * FROM providers WHERE id')) return mockProviders.find((p) => p.id === bound[0]) ?? null;
          return null;
        },
      };
      return stmt;
    };

    const fakeDB = {
      prepare: fakePrepare,
      async batch(stmts: any[]) {
        const out = [];
        for (const s of stmts) {
          if (s.sql.includes('UPDATE') || s.sql.includes('INSERT')) {
            out.push(await s.run());
          } else {
            out.push(await s.all());
          }
        }
        return out;
      },
    } as unknown as D1Database;

    env = {
      DB: fakeDB,
      ADMIN_PASSWORD: ADMIN_PW,
      ENCRYPTION_KEY: ENC_SECRET,
      SESSION_SECRET: SESS_SECRET,
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function makeCtx(): { ctx: ExecutionContext; flush: () => Promise<void> } {
    const tasks: Promise<unknown>[] = [];
    return {
      ctx: {
        waitUntil(p: Promise<unknown>) {
          tasks.push(p);
        },
        passThroughOnException() {},
      } as unknown as ExecutionContext,
      async flush() {
        await Promise.all(tasks);
      },
    };
  }

  it('rotates from Key 1 (402 Exhausted) to Key 2 (200 OK) on the same provider', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      const headers = new Headers(init?.headers);
      const auth = headers.get('x-api-key');
      if (auth === 'sk-provA-key1') {
        return new Response('{"error":{"message":"Quota exceeded"}}', { status: 402 });
      }
      return new Response('{"id":"msg_1","content":[{"type":"text","text":"Hi"}],"usage":{"input_tokens":12,"output_tokens":4}}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    const { ctx, flush } = makeCtx();
    const req = new Request('https://gw.test/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': GW_TOKEN, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-sonnet-4', messages: [{ role: 'user', content: 'hi' }] }),
    });

    const res = await handleProxy(req, env, ctx);
    await flush();

    expect(res.status).toBe(200);
    expect(res.headers.get('x-gateway-provider')).toBe('ProviderA');
    expect(res.headers.get('x-gateway-attempts')).toBe('2');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(keyUpdates).toEqual([{ id: 101, status: 'exhausted', reason: 'Quota exceeded' }]);
    expect(insertedLogs).toHaveLength(1);
  });

  it('fails over across providers when all keys of ProviderA are exhausted or stream returns an SSE error', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      const auth = headers.get('x-api-key');

      if (url.startsWith('https://prov-a.test')) {
        if (auth === 'sk-provA-key1') {
          return new Response('{"error":{"message":"insufficient_quota"}}', { status: 429 });
        }
        // Key 2 returns HTTP 200 SSE stream whose first event is an error!
        const enc = new TextEncoder();
        const stream = new ReadableStream({
          start(c) {
            c.enqueue(enc.encode('event: error\ndata: {"type":"error","error":{"message":"余额不足"}}\n\n'));
            c.close();
          },
        });
        return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
      }

      // ProviderB receives mapped model "anthropic/claude-sonnet-4"
      const bodyText = String(init?.body ?? '');
      expect(bodyText).toContain('"model":"anthropic/claude-sonnet-4"');
      return new Response('{"id":"msg_b","content":[{"type":"text","text":"From B"}]}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    const { ctx, flush } = makeCtx();
    const req = new Request('https://gw.test/v1/messages', {
      method: 'POST',
      headers: { authorization: `Bearer ${GW_TOKEN}` },
      body: JSON.stringify({ model: 'claude-sonnet-4', messages: [{ role: 'user', content: 'hi' }] }),
    });

    const res = await handleProxy(req, env, ctx);
    await flush();

    expect(res.status).toBe(200);
    expect(res.headers.get('x-gateway-provider')).toBe('ProviderB');
    expect(res.headers.get('x-gateway-attempts')).toBe('3');
    expect(keyUpdates.map((u) => u.id)).toEqual([101, 102]);
  });

  it('returns 400 CLIENT_ERROR immediately without retrying other keys or providers', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{"error":{"message":"Invalid request parameter: temperature"}}', {
        status: 400,
        headers: { 'content-type': 'application/json' },
      }),
    );

    const { ctx, flush } = makeCtx();
    const req = new Request('https://gw.test/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': GW_TOKEN },
      body: JSON.stringify({ model: 'claude-sonnet-4', messages: [] }),
    });

    const res = await handleProxy(req, env, ctx);
    await flush();

    expect(res.status).toBe(400);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(keyUpdates).toHaveLength(0);
  });

  it('skips providers that do not support the requested wire format and serves /v1/models', async () => {
    // Only ProviderB supports openai-responses
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{"id":"resp_1","output":[]}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    const { ctx, flush } = makeCtx();
    const req = new Request('https://gw.test/v1/responses', {
      method: 'POST',
      headers: { authorization: `Bearer ${GW_TOKEN}` },
      body: JSON.stringify({ model: 'o3', input: 'hi' }),
    });

    const res = await handleProxy(req, env, ctx);
    await flush();
    expect(res.status).toBe(200);
    expect(res.headers.get('x-gateway-provider')).toBe('ProviderB');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const modelsRes = await handleModels(
      new Request('https://gw.test/v1/models', { headers: { authorization: `Bearer ${GW_TOKEN}` } }),
      env,
    );
    const modelsJson = (await modelsRes.json()) as { data: Array<{ id: string }> };
    expect(modelsJson.data.map((m) => m.id)).toContain('claude-sonnet-4');
  });

  it('protects /api/admin/* endpoints with signed session cookie and CSRF content-type check', async () => {
    const unauth = await worker.fetch(new Request('https://gw.test/api/admin/settings'), env, makeCtx().ctx);
    expect(unauth.status).toBe(401);

    const badLogin = await worker.fetch(
      new Request('https://gw.test/api/admin/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password: 'wrong' }),
      }),
      env,
      makeCtx().ctx,
    );
    expect(badLogin.status).toBe(401);

    const goodLogin = await worker.fetch(
      new Request('https://gw.test/api/admin/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password: ADMIN_PW }),
      }),
      env,
      makeCtx().ctx,
    );
    expect(goodLogin.status).toBe(200);
    const cookie = goodLogin.headers.get('set-cookie')!.split(';')[0];

    const sessionRes = await worker.fetch(
      new Request('https://gw.test/api/admin/session', { headers: { cookie } }),
      env,
      makeCtx().ctx,
    );
    expect(sessionRes.status).toBe(200);

    // Mutating request without application/json is blocked (415)
    const csrfBlocked = await worker.fetch(
      new Request('https://gw.test/api/admin/settings', {
        method: 'PUT',
        headers: { cookie, 'content-type': 'text/plain' },
        body: '{}',
      }),
      env,
      makeCtx().ctx,
    );
    expect(csrfBlocked.status).toBe(415);
  });
  async function adminCookie(): Promise<string> {
    const res = await worker.fetch(
      new Request('https://gw.test/api/admin/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password: ADMIN_PW }),
      }),
      env,
      makeCtx().ctx,
    );
    return res.headers.get('set-cookie')!.split(';')[0];
  }

  async function adminPost(cookie: string, path: string, payload: unknown): Promise<Response> {
    return await worker.fetch(
      new Request(`https://gw.test/api/admin${path}`, {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      }),
      env,
      makeCtx().ctx,
    );
  }

  it('add-provider tracer: Test connection, then create with the form payload (PRV-01, PRV-04)', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(
      async () =>
        new Response('{"data":[{"id":"m1"},{"id":"m2"}]}', { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    const cookie = await adminCookie();

    const tested = await adminPost(cookie, '/providers/test-connection', { base_url: 'https://new-relay.test/', keys: 'sk-new-1' });
    expect(tested.status).toBe(200);
    const testedJson = (await tested.json()) as { ok: boolean; count: number };
    expect(testedJson).toMatchObject({ ok: true, count: 2 });
    expect(String(fetchMock.mock.calls[0][0])).toMatch(/^https:\/\/new-relay\.test\/v1\/models/);

    const form = { ...emptyProviderForm(), name: 'New Relay', base_url: 'https://new-relay.test/', keys: 'sk-new-1' };
    const created = await adminPost(cookie, '/providers', buildProviderPayload(form, 'create'));
    expect(created.status).toBe(201);
    expect(providerInserts).toHaveLength(1);
    const bound = providerInserts[0];
    expect(bound).toContain('https://new-relay.test');
    expect(bound).not.toContain('https://new-relay.test/');
    expect(bound).toContain('["anthropic","openai-chat","openai-responses"]');
  });
  describe('providers test-connection and merge', () => {
    const modelsOk = () =>
      new Response('{"data":[{"id":"m1"},{"id":"m2"}]}', { status: 200, headers: { 'content-type': 'application/json' } });

    it('D-17 create mode: a typed key goes upstream as x-api-key and Bearer, and the answer is ok with a count', async () => {
      const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => modelsOk());
      const cookie = await adminCookie();
      const res = await adminPost(cookie, '/providers/test-connection', { base_url: 'https://new-relay.test', keys: 'sk-typed-1\nsk-typed-2' });
      expect(res.status).toBe(200);
      const json = (await res.json()) as { ok: boolean; count: number; ms: number };
      expect(json.ok).toBe(true);
      expect(typeof json.count).toBe('number');
      const headers = new Headers((fetchMock.mock.calls[0][1] as RequestInit).headers);
      expect(headers.get('x-api-key')).toBe('sk-typed-1');
      expect(headers.get('authorization')).toBe('Bearer sk-typed-1');
    });

    it('D-19 edit mode: the stored first key is used server-side and never appears in the response', async () => {
      const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => modelsOk());
      const cookie = await adminCookie();
      const res = await adminPost(cookie, '/providers/test-connection', { base_url: 'https://prov-a.test', provider_id: 1 });
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(new Headers((fetchMock.mock.calls[0][1] as RequestInit).headers).get('x-api-key')).toBe('sk-provA-key1');
      expect(text).not.toContain('sk-provA-key1');
      expect(JSON.parse(text)).toMatchObject({ ok: true, count: 2 });
    });

    it('D-17, D-18 read-only: nothing is written, no key changes state, and no D1 batch runs', async () => {
      vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('{"error":"quota exceeded"}', { status: 402 }));
      const cookie = await adminCookie();
      const batchSpy = vi.spyOn(env.DB, 'batch');
      const ok = await adminPost(cookie, '/providers/test-connection', { base_url: 'https://prov-a.test', provider_id: 1 });
      const failed = await adminPost(cookie, '/providers/test-connection', { base_url: 'https://new-relay.test', keys: 'sk-x' });
      expect(ok.status).toBe(200);
      expect(failed.status).toBe(200);
      expect(keyUpdates).toEqual([]);
      expect(insertedLogs).toEqual([]);
      expect(providerInserts).toEqual([]);
      expect(providerUpdates).toEqual([]);
      expect(batchSpy).not.toHaveBeenCalled();
    });

    it('D-18 redaction: an upstream 401 that echoes the key comes back without it; a network failure is status 0', async () => {
      const cookie = await adminCookie();
      vi.spyOn(globalThis, 'fetch').mockImplementation(
        async () => new Response('{"error":"Invalid token sk-secret-echo-9"}', { status: 401 }),
      );
      const res = await adminPost(cookie, '/providers/test-connection', { base_url: 'https://new-relay.test', keys: 'sk-secret-echo-9' });
      const text = await res.text();
      expect(res.status).toBe(200);
      expect(text).not.toContain('sk-secret-echo-9');
      expect(JSON.parse(text)).toMatchObject({ ok: false, status: 401 });
      expect(JSON.parse(text).message).toContain('***');

      vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('fetch failed'));
      const net = await adminPost(cookie, '/providers/test-connection', { base_url: 'https://new-relay.test', keys: 'sk-secret-echo-9' });
      expect(net.status).toBe(200);
      expect(await net.json()).toMatchObject({ ok: false, status: 0 });
    });

    it('D-17 guards: no key is 400, a bad URL is 400, no session is 401, a text/plain body is 415', async () => {
      const cookie = await adminCookie();
      const noKey = await adminPost(cookie, '/providers/test-connection', { base_url: 'https://new-relay.test' });
      expect(noKey.status).toBe(400);
      expect(await noKey.json()).toEqual({ error: 'no key to test with' });

      const badUrl = await adminPost(cookie, '/providers/test-connection', { base_url: 'ftp://x', keys: 'sk-a' });
      expect(badUrl.status).toBe(400);

      const anon = await adminPost('', '/providers/test-connection', { base_url: 'https://new-relay.test', keys: 'sk-a' });
      expect(anon.status).toBe(401);

      const plain = await worker.fetch(
        new Request('https://gw.test/api/admin/providers/test-connection', {
          method: 'POST',
          headers: { cookie, 'content-type': 'text/plain' },
          body: '{}',
        }),
        env,
        makeCtx().ctx,
      );
      expect(plain.status).toBe(415);
    });

    it('PRV-03 server layer: PUT with only name and base_url keeps every other stored value', async () => {
      const cookie = await adminCookie();
      const res = await worker.fetch(
        new Request('https://gw.test/api/admin/providers/1', {
          method: 'PUT',
          headers: { cookie, 'content-type': 'application/json' },
          body: JSON.stringify({ name: 'Renamed', base_url: 'https://prov-a.test' }),
        }),
        env,
        makeCtx().ctx,
      );
      expect(res.status).toBe(200);
      expect(providerUpdates).toHaveLength(1);
      const bound = providerUpdates[0];
      expect(bound).toContain('Renamed');
      expect(bound).toContain(5000);
      expect(bound).toContain('sequential');
      expect(bound).toContain('["anthropic","openai-chat"]');
      expect(bound.filter((v) => v === '{}')).toHaveLength(2);
    });
  });
});
