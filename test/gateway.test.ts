import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSession, verifySession } from '../src/worker/admin/auth';
import { invalidateConfig } from '../src/worker/db/cache';
import { decrypt, encrypt, keyHint, safeEqual, sha256Hex } from '../src/worker/db/crypto';
import worker from '../src/worker/index';
import {
  detectFormat,
  extractClientTokens,
  extractModel,
  extractModelBytes,
  looksLikeJsonError,
  replaceModel,
  replaceModelBytes,
} from '../src/worker/proxy/formats';
import { handleModels, handleProxy } from '../src/worker/proxy/forward';
import { peekStream } from '../src/worker/proxy/stream-peek';
import { UsageTap } from '../src/worker/proxy/usage';
import { buildProviderPayload, emptyProviderForm } from '../src/dashboard/lib/provider-form';
import { classify } from '../src/worker/routing/error-rules';
import { globMatch, mapModel, supportsModel } from '../src/worker/routing/model-map';
import { resolveRoute } from '../src/worker/routing/resolve-route';
import { isUsable, orderKeys } from '../src/worker/routing/select-key';
import type { Config, Env, ErrorRule, GatewayKey, Provider, ProviderKey, Route } from '../src/worker/types';

/** The default global rules without `origin`; DEFAULT_RULES maps them so the origin is set in one place. */
const BASE_DEFAULT_RULES: Omit<ErrorRule, 'origin'>[] = [
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
const DEFAULT_RULES: ErrorRule[] = BASE_DEFAULT_RULES.map((r) => ({ ...r, origin: 'rule' as const }));

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
    status_code: null,
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
      origin: 'rule',
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
  let keyUpdateSql: string[];
  let keyUpdateCodes: Array<number | null>;
  let providerInserts: unknown[][];
  let providerUpdates: unknown[][];
  let ruleWrites: Array<{ sql: string; bound: unknown[] }>;
  let batchSizes: number[];
  let env: Env;

  beforeEach(async () => {
    invalidateConfig();
    insertedLogs = [];
    keyUpdates = [];
    keyUpdateSql = [];
    keyUpdateCodes = [];
    providerInserts = [];
    providerUpdates = [];
    ruleWrites = [];
    batchSizes = [];

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
            keyUpdates.push({ id: Number(bound[6]), status: String(bound[0]), reason: bound[1] as string | null });
            keyUpdateCodes.push(bound[2] as number | null);
            keyUpdateSql.push(sql);
          } else if (/(INSERT INTO|UPDATE|DELETE FROM) error_rules/.test(sql)) {
            // Record the rule writes and their binds for the provider save assertions.
            ruleWrites.push({ sql, bound });
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
          if (sql.includes('FROM provider_keys WHERE id')) return mockKeys.find((k) => k.id === bound[0]) ?? null;
          if (sql.includes('SELECT * FROM providers WHERE id')) return mockProviders.find((p) => p.id === bound[0]) ?? null;
          if (sql.includes('SELECT origin FROM error_rules WHERE id')) {
            const rule = mockRules.find((r) => r.id === bound[0]);
            return rule ? { origin: rule.origin ?? 'rule' } : null;
          }
          return null;
        },
      };
      return stmt;
    };

    const fakeDB = {
      prepare: fakePrepare,
      async batch(stmts: any[]) {
        const out = [];
        batchSizes.push(stmts.length);
        for (const s of stmts) {
          if (/UPDATE|INSERT|DELETE/.test(s.sql)) {
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

  it('a 401 drops the key and records the status (DROP-04)', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      const headers = new Headers(init?.headers);
      if (headers.get('x-api-key') === 'sk-provA-key1') {
        return new Response('{"error":{"message":"bad key"}}', { status: 401, headers: { 'content-type': 'application/json' } });
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
    expect(keyUpdates).toEqual([{ id: 101, status: 'invalid', reason: 'bad key' }]);
    expect(keyUpdateCodes).toEqual([401]);
  });

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

    it('WR-04: a key echoed across the 200-character cut is redacted before truncation', async () => {
      const key = 'sk-secret-echo-straddle-1234567890';
      const body = `{"error":"${'x'.repeat(150)} token ${key}"}`;
      vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(body, { status: 401 }));
      const cookie = await adminCookie();
      const tested = await adminPost(cookie, '/providers/test-connection', { base_url: 'https://new-relay.test', keys: key });
      const text = await tested.text();
      expect(text).not.toContain(key.slice(0, 12));
      expect(JSON.parse(text)).toMatchObject({ ok: false, status: 401 });
      expect(JSON.parse(text).message).toContain('***');
    });

    it('WR-03: a 200 that is not a model list, or not JSON, is reported as a 200 verdict, not as success or unreachable', async () => {
      const cookie = await adminCookie();
      vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('{"error":{"message":"bad token"}}', { status: 200 }));
      const errBody = await adminPost(cookie, '/providers/test-connection', { base_url: 'https://new-relay.test', keys: 'sk-a' });
      expect(await errBody.json()).toMatchObject({ ok: false, status: 200, message: expect.stringContaining('did not return a model list') });

      vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('<html>relay</html>', { status: 200 }));
      const html = await adminPost(cookie, '/providers/test-connection', { base_url: 'https://new-relay.test', keys: 'sk-a' });
      expect(await html.json()).toMatchObject({ ok: false, status: 200 });

      vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('{"data":[]}', { status: 200 }));
      const empty = await adminPost(cookie, '/providers/test-connection', { base_url: 'https://new-relay.test', keys: 'sk-a' });
      expect(await empty.json()).toMatchObject({ ok: true, count: 0 });
    });

    it('D-17 guards: no key is 400, a bad URL is 400, no session is 401, a text/plain body is 415', async () => {
      const cookie = await adminCookie();
      const noKey = await adminPost(cookie, '/providers/test-connection', { base_url: 'https://new-relay.test' });
      expect(noKey.status).toBe(400);
      expect(await noKey.json()).toEqual({ error: 'no key to test with' });

      const badUrl = await adminPost(cookie, '/providers/test-connection', { base_url: 'ftp://x', keys: 'sk-a' });
      expect(badUrl.status).toBe(400);

      const badHeader = await adminPost(cookie, '/providers/test-connection', {
        base_url: 'https://new-relay.test',
        keys: 'sk-a',
        extra_headers: { 'X-Token: dGVzdA': '=' },
      });
      expect(badHeader.status).toBe(400);

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

  describe('Auth resilience, Stale-While-Revalidate & Large-Body Byte-Level Proxy (intermittent-500-cpu-latency)', () => {
    it('extracts and rewrites models on raw UTF-8 buffers across 0, 4096, 4097, 16384, and 16385 byte boundaries', () => {
      const enc = new TextEncoder();
      const dec = new TextDecoder();

      expect(extractModelBytes(new Uint8Array(0))).toEqual({ model: null, span: null });

      for (const targetLen of [4096, 4097, 16384, 16385]) {
        // Case A: model in the first 4KB
        const prefixA = '{"model":"claude-sonnet-4","messages":[{"role":"user","content":"';
        const suffixA = '"}]}';
        const padA = 'x'.repeat(Math.max(0, targetLen - prefixA.length - suffixA.length));
        const bytesA = enc.encode(prefixA + padA + suffixA);
        expect(bytesA.byteLength).toBe(targetLen);
        const extA = extractModelBytes(bytesA);
        expect(extA.model).toBe('claude-sonnet-4');
        const repA = dec.decode(replaceModelBytes(bytesA, extA.span, 'anthropic/claude-sonnet-4'));
        expect(repA.startsWith('{"model":"anthropic/claude-sonnet-4"')).toBe(true);

        // Case B: model at the very end (beyond 4KB) after Unicode content
        const prefixB = '{"messages":[{"role":"user","content":"─…→✓ ';
        const suffixB = '"}],"model":"claude-sonnet-4"}';
        const padB = 'a'.repeat(Math.max(0, targetLen - enc.encode(prefixB).byteLength - enc.encode(suffixB).byteLength));
        const bytesB = enc.encode(prefixB + padB + suffixB);
        expect(bytesB.byteLength).toBe(targetLen);
        const extB = extractModelBytes(bytesB);
        expect(extB.model).toBe('claude-sonnet-4');
        const repB = dec.decode(replaceModelBytes(bytesB, extB.span, 'anthropic/claude-sonnet-4'));
        expect(repB.endsWith('"model":"anthropic/claude-sonnet-4"}')).toBe(true);
      }

      // Escaped \"model\" inside content must not shadow the real top-level "model" field at the tail (>16KB).
      const escapedBody = enc.encode(
        `{"messages":[{"role":"user","content":"example \\"model\\":\\"fake\\" ${'z'.repeat(20_000)}"}],"model":"claude-sonnet-4"}`,
      );
      const extEsc = extractModelBytes(escapedBody);
      expect(extEsc.model).toBe('claude-sonnet-4');
      expect(dec.decode(replaceModelBytes(escapedBody, extEsc.span, 'anthropic/claude-sonnet-4'))).toMatch(
        /"model":"anthropic\/claude-sonnet-4"\}$/,
      );
    });

    it('accepts valid x-api-key on POST /v1/messages?beta=true even when Authorization: Bearer is whitespace or another token', async () => {
      vi.spyOn(globalThis, 'fetch').mockImplementation(
        async () =>
          new Response('{"id":"msg_1","content":[{"type":"text","text":"ok"}]}', {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      );

      const reqWhitespaceBearer = new Request('https://gw.test/v1/messages?beta=true', {
        method: 'POST',
        headers: { authorization: 'Bearer    ', 'x-api-key': GW_TOKEN, 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'claude-sonnet-4', messages: [{ role: 'user', content: 'hi' }] }),
      });
      expect(extractClientTokens(reqWhitespaceBearer)).toEqual([GW_TOKEN]);
      const res1 = await handleProxy(reqWhitespaceBearer, env, makeCtx().ctx);
      expect(res1.status).toBe(200);

      const reqDualHeader = new Request('https://gw.test/v1/messages?beta=true', {
        method: 'POST',
        headers: { authorization: 'Bearer non-gateway-token', 'x-api-key': GW_TOKEN, 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'claude-sonnet-4', messages: [{ role: 'user', content: 'hi' }] }),
      });
      expect(extractClientTokens(reqDualHeader)[0]).toBe(GW_TOKEN);
      const res2 = await handleProxy(reqDualHeader, env, makeCtx().ctx);
      expect(res2.status).toBe(200);
    });

    it('retries cold-start transient D1 errors in authenticate() and returns 503 JSON (never unhandled 500) on persistent D1 failure', async () => {
      vi.spyOn(globalThis, 'fetch').mockImplementation(
        async () =>
          new Response('{"id":"msg_1","content":[]}', {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      );

      // 1. Cold start where first DB.batch throws and retry succeeds -> 200 OK
      invalidateConfig();
      let calls = 0;
      const origBatch = env.DB.batch.bind(env.DB);
      vi.spyOn(env.DB, 'batch').mockImplementation(async (stmts: any[]) => {
        calls++;
        if (calls === 1) throw new Error('D1_ERROR: transient network reset');
        return origBatch(stmts);
      });

      const resRecovered = await worker.fetch(
        new Request('https://gw.test/v1/messages?beta=true', {
          method: 'POST',
          headers: { 'x-api-key': GW_TOKEN, 'content-type': 'application/json' },
          body: JSON.stringify({ model: 'claude-sonnet-4', messages: [{ role: 'user', content: 'hi' }] }),
        }),
        env,
        makeCtx().ctx,
      );
      expect(resRecovered.status).toBe(200);
      expect(calls).toBe(2);

      // 2. Cold start where D1 is completely unreachable -> clean 503 Anthropic JSON error, never unhandled 500
      invalidateConfig();
      vi.spyOn(env.DB, 'batch').mockRejectedValue(new Error('D1_ERROR: database unavailable'));
      const resDown = await worker.fetch(
        new Request('https://gw.test/v1/messages?beta=true', {
          method: 'POST',
          headers: { 'x-api-key': GW_TOKEN, 'content-type': 'application/json' },
          body: JSON.stringify({ model: 'claude-sonnet-4', messages: [{ role: 'user', content: 'hi' }] }),
        }),
        env,
        makeCtx().ctx,
      );
      expect(resDown.status).toBe(503);
      const errJson = (await resDown.json()) as { type: string; error: { type: string; message: string } };
      expect(errJson.type).toBe('error');
      expect(errJson.error.type).toBe('api_error');
    });

    it('serves warm config via Stale-While-Revalidate after 30s without blocking on D1 or failing when D1 errors, and keeps cached.version synced on key patches', async () => {
      let versionValue = '1';
      let versionChecks = 0;
      let batchLoads = 0;
      const origPrepare = env.DB.prepare;
      const origBatch = env.DB.batch;

      env.DB.prepare = ((sql: string) => {
        const stmt = origPrepare(sql);
        if (sql.includes("key = 'config_version'") && sql.startsWith('SELECT')) {
          stmt.first = async () => {
            versionChecks++;
            return { value: versionValue } as any;
          };
        } else if (sql.includes("key = 'config_version'") && sql.startsWith('UPDATE')) {
          stmt.run = async () => {
            versionValue = String(Number(versionValue) + 1);
            return { results: [], success: true, meta: { changes: 1 } } as any;
          };
        }
        return stmt;
      }) as any;

      env.DB.batch = (async (stmts: any[]) => {
        if (stmts.length === 9) batchLoads++;
        return origBatch(stmts);
      }) as any;

      let now = 1_000_000;
      vi.spyOn(Date, 'now').mockImplementation(() => now);

      vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
        const auth = new Headers(init?.headers).get('x-api-key');
        if (auth === 'sk-provA-key1') return new Response('{"error":{"message":"Quota exceeded"}}', { status: 402 });
        return new Response('{"id":"msg_ok","content":[]}', { status: 200, headers: { 'content-type': 'application/json' } });
      });

      // Request 1 (cold): loads config via batch (batchLoads = 1) and rotates key1 -> key2 (bumps version to 2 in D1 AND in cached.version)
      const c1 = makeCtx();
      const r1 = await handleProxy(
        new Request('https://gw.test/v1/messages?beta=true', {
          method: 'POST',
          headers: { 'x-api-key': GW_TOKEN },
          body: JSON.stringify({ model: 'claude-sonnet-4', messages: [] }),
        }),
        env,
        c1.ctx,
      );
      await c1.flush();
      expect(r1.status).toBe(200);
      expect(batchLoads).toBe(1);
      expect(versionValue).toBe('2');

      // Advance 35s (> CHECK_MS): Request 2 returns warm config immediately, background check sees version 2 === cached.version 2 (no second 7-table batchLoad!)
      now += 35_000;
      const c2 = makeCtx();
      const r2 = await handleProxy(
        new Request('https://gw.test/v1/messages?beta=true', {
          method: 'POST',
          headers: { 'x-api-key': GW_TOKEN },
          body: JSON.stringify({ model: 'claude-sonnet-4', messages: [] }),
        }),
        env,
        c2.ctx,
      );
      await c2.flush();
      expect(r2.status).toBe(200);
      expect(versionChecks).toBe(1);
      expect(batchLoads).toBe(1);
    });

    it('rewrites model in-place on >16KB UTF-8 request bodies and extracts split-chunk SSE usage without full-body string decode', async () => {
      const enc = new TextEncoder();
      const dec = new TextDecoder();
      let receivedBodies: Uint8Array[] = [];

      // ProviderA has no usable keys so it routes to ProviderB (which maps claude-sonnet-4 -> anthropic/claude-sonnet-4)
      mockKeys[0].status = 'exhausted';
      mockKeys[1].status = 'exhausted';

      vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
        const raw = init?.body;
        expect(raw).toBeInstanceOf(Uint8Array);
        receivedBodies.push(raw as Uint8Array);

        const sse = [
          'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tok',
          'ens":1234,"cache_read_input_tokens":500,"output_tokens":1}}}\n\n',
          ...Array(50).fill('event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"chunk "}}\n\n'),
          'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":99}}\n\n',
        ];
        let idx = 0;
        const stream = new ReadableStream<Uint8Array>({
          pull(controller) {
            if (idx < sse.length) controller.enqueue(enc.encode(sse[idx++]));
            else controller.close();
          },
        });
        return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
      });

      const largePrompt = '─…→✓ '.repeat(5000); // > 40 KB UTF-8 body with multi-byte Unicode
      const payload = `{"model":"claude-sonnet-4","messages":[{"role":"user","content":${JSON.stringify(largePrompt)}}],"stream":true}`;
      const { ctx, flush } = makeCtx();
      const res = await handleProxy(
        new Request('https://gw.test/v1/messages?beta=true', {
          method: 'POST',
          headers: { 'x-api-key': GW_TOKEN, 'content-type': 'application/json' },
          body: enc.encode(payload),
        }),
        env,
        ctx,
      );

      expect(res.status).toBe(200);
      // Drain response stream so UsageTap finishes and writes log
      const reader = res.body!.getReader();
      while (!(await reader.read()).done) {}
      await flush();

      expect(receivedBodies).toHaveLength(1);
      const upstreamHead = dec.decode(receivedBodies[0].subarray(0, 80));
      expect(upstreamHead.startsWith('{"model":"anthropic/claude-sonnet-4"')).toBe(true);
      expect(insertedLogs).toHaveLength(1);
      // insertedLogs[0] bindings: input_tokens=13, output_tokens=14, cache_tokens=15
      expect(insertedLogs[0][13]).toBe(1234);
      expect(insertedLogs[0][14]).toBe(99);
      expect(insertedLogs[0][15]).toBe(500);
    });

    it('preserves token counts when peekStream boundary splits _tokens" or digits without another _tokens" in the next chunk', async () => {
      const enc = new TextEncoder();
      const splitStreams = [
        // Boundary inside key name ("input_tok" + "ens":4321) across peek.head -> next pull
        [
          'event: ping\ndata: {"type":"ping"}\n\nevent: message_start\ndata: {"message":{"usage":{"input_tok',
          'ens":4321}}}\n\n',
          'event: message_delta\ndata: {"usage":{"output_tokens":77}}\n\n',
        ],
        // Boundary inside digits ("input_tokens":12 + "34) across peek.head -> next pull
        [
          'event: ping\ndata: {"type":"ping"}\n\nevent: message_start\ndata: {"message":{"usage":{"input_tokens":12',
          '34}}}\n\n',
          'event: message_delta\ndata: {"usage":{"output_tokens":88}}\n\n',
        ],
      ];

      for (let s = 0; s < splitStreams.length; s++) {
        insertedLogs.length = 0;
        const chunks = splitStreams[s];
        vi.spyOn(globalThis, 'fetch').mockImplementationOnce(async () => {
          let i = 0;
          const stream = new ReadableStream<Uint8Array>({
            pull(controller) {
              if (i < chunks.length) controller.enqueue(enc.encode(chunks[i++]));
              else controller.close();
            },
          });
          return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
        });

        const { ctx, flush } = makeCtx();
        const res = await handleProxy(
          new Request('https://gw.test/v1/messages?beta=true', {
            method: 'POST',
            headers: { 'x-api-key': GW_TOKEN, 'content-type': 'application/json' },
            body: JSON.stringify({ model: 'claude-sonnet-4', messages: [], stream: true }),
          }),
          env,
          ctx,
        );
        expect(res.status).toBe(200);
        const reader = res.body!.getReader();
        while (!(await reader.read()).done) {}
        await flush();

        expect(insertedLogs).toHaveLength(1);
        expect(insertedLogs[0][13]).toBe(s === 0 ? 4321 : 1234);
        expect(insertedLogs[0][14]).toBe(s === 0 ? 77 : 88);
      }
    });

    it('handles non-ASCII provider names and missing/wrong ENCRYPTION_KEY cleanly without 500 crashes', async () => {
      mockProviders[0].name = '中转 🚀';
      invalidateConfig();

      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response('{"id":"msg_1","content":[]}', { status: 200, headers: { 'content-type': 'application/json' } }),
      );
      const c1 = makeCtx();
      const r1 = await handleProxy(
        new Request('https://gw.test/v1/messages?beta=true', {
          method: 'POST',
          headers: { 'x-api-key': GW_TOKEN, 'content-type': 'application/json' },
          body: JSON.stringify({ model: 'claude-sonnet-4', messages: [] }),
        }),
        env,
        c1.ctx,
      );
      await c1.flush();
      expect(r1.status).toBe(200);
      expect(r1.headers.get('x-gateway-provider')).toBeTruthy();

      // Missing/invalid auth returns 401 Anthropic JSON, never 500
      const unauth = await worker.fetch(
        new Request('https://gw.test/v1/messages?beta=true', { method: 'POST', body: '{}' }),
        env,
        makeCtx().ctx,
      );
      expect(unauth.status).toBe(401);

      // Corrupted ENCRYPTION_KEY / wrong secret fails gracefully with 402 instead of throwing 500
      const badEnv = { ...env, ENCRYPTION_KEY: 'wrong-encryption-secret' };
      const c2 = makeCtx();
      const r2 = await handleProxy(
        new Request('https://gw.test/v1/messages?beta=true', {
          method: 'POST',
          headers: { 'x-api-key': GW_TOKEN, 'content-type': 'application/json' },
          body: JSON.stringify({ model: 'claude-sonnet-4', messages: [] }),
        }),
        badEnv,
        c2.ctx,
      );
      await c2.flush();
      expect(r2.status).toBe(402);
    });

    // DROP-01 (fake D1, same isolate): a request that is already in flight when a drop lands must not revive
    // the key. The two requests share one cached key object, so the in-memory guard is what this proves.
    it('a concurrent request that succeeds after the drop leaves the key dropped', async () => {
      invalidateConfig();
      let release!: () => void;
      const held = new Promise<void>((r) => (release = r));
      let calls = 0;
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
        calls++;
        if (calls === 1) {
          // Request 1 holds key 101 open until released.
          await held;
          return new Response('{"id":"msg_slow","content":[]}', { status: 200, headers: { 'content-type': 'application/json' } });
        }
        if (calls === 2) {
          // Request 2 gets a 401 for key 101, so it drops the key.
          expect(new Headers(init?.headers).get('x-api-key')).toBe('sk-provA-key1');
          return new Response('{"error":{"message":"bad key"}}', { status: 401, headers: { 'content-type': 'application/json' } });
        }
        // Request 2 then succeeds on key 102.
        return new Response('{"id":"msg_2","content":[]}', { status: 200, headers: { 'content-type': 'application/json' } });
      });

      const body = JSON.stringify({ model: 'claude-sonnet-4', messages: [{ role: 'user', content: 'hi' }] });
      const first = makeCtx();
      const p1 = handleProxy(
        new Request('https://gw.test/v1/messages', { method: 'POST', headers: { 'x-api-key': GW_TOKEN, 'content-type': 'application/json' }, body }),
        env,
        first.ctx,
      );
      // Wait until request 1 has reached upstream and is parked on the held promise.
      while (calls < 1) await new Promise((r) => setTimeout(r, 0));

      const second = makeCtx();
      const res2 = await handleProxy(
        new Request('https://gw.test/v1/messages', { method: 'POST', headers: { 'x-api-key': GW_TOKEN, 'content-type': 'application/json' }, body }),
        env,
        second.ctx,
      );
      await second.flush();
      expect(res2.status).toBe(200);
      expect(res2.headers.get('x-gateway-attempts')).toBe('2');

      release();
      const res1 = await p1;
      await first.flush();
      expect(res1.status).toBe(200);
      expect(keyUpdates).toEqual([{ id: 101, status: 'invalid', reason: 'bad key' }]);
      expect(keyUpdates.some((u) => u.id === 101 && u.status === 'active')).toBe(false);
    });

    // DROP-03: only an explicit Re-enable (PUT status active) forces a dropped key back to active.
    describe('DROP-03 admin Re-enable and Disable', () => {
      const adminPut = async (cookie: string, path: string, payload: unknown): Promise<Response> =>
        worker.fetch(
          new Request(`https://gw.test/api/admin${path}`, {
            method: 'PUT',
            headers: { cookie, 'content-type': 'application/json' },
            body: JSON.stringify(payload),
          }),
          env,
          makeCtx().ctx,
        );

      it('PUT status active on an invalid key writes once, with no NOT IN guard in the SQL', async () => {
        mockKeys[0].status = 'invalid';
        mockKeys[0].status_reason = 'bad key';
        const cookie = await adminCookie();
        const res = await adminPut(cookie, '/keys/101', { status: 'active' });
        expect(res.status).toBe(200);
        expect(keyUpdates).toEqual([{ id: 101, status: 'active', reason: null }]);
        expect(keyUpdateSql).toHaveLength(1);
        expect(keyUpdateSql[0]).not.toContain("NOT IN ('invalid','disabled')");
      });

      it('PUT status disabled on an active key writes disabled through the guarded SQL', async () => {
        const cookie = await adminCookie();
        const res = await adminPut(cookie, '/keys/101', { status: 'disabled' });
        expect(res.status).toBe(200);
        expect(keyUpdates).toEqual([{ id: 101, status: 'disabled', reason: 'disabled manually' }]);
        expect(keyUpdateSql[0]).toContain("NOT IN ('invalid','disabled')");
      });

      it('PUT status disabled on an invalid key answers 200 and records no key write', async () => {
        mockKeys[0].status = 'invalid';
        mockKeys[0].status_reason = 'bad key';
        const cookie = await adminCookie();
        const res = await adminPut(cookie, '/keys/101', { status: 'disabled' });
        expect(res.status).toBe(200);
        expect(keyUpdates).toEqual([]);
      });

      it('a request-path drop write carries the guard', async () => {
        vi.spyOn(globalThis, 'fetch').mockResolvedValue(
          new Response('{"error":{"message":"bad key"}}', { status: 401, headers: { 'content-type': 'application/json' } }),
        );
        const { ctx, flush } = makeCtx();
        await handleProxy(
          new Request('https://gw.test/v1/messages', {
            method: 'POST',
            headers: { 'x-api-key': GW_TOKEN, 'content-type': 'application/json' },
            body: JSON.stringify({ model: 'claude-sonnet-4', messages: [] }),
          }),
          env,
          ctx,
        );
        await flush();
        expect(keyUpdates.length).toBeGreaterThan(0);
        expect(keyUpdateSql.every((s) => s.includes("NOT IN ('invalid','disabled')"))).toBe(true);
      });
    });

    // DROP-10: Test on an invalid or disabled key reports the result and writes nothing.
    describe('DROP-10 Test on a dropped or disabled key', () => {
      const testKeyCall = async (cookie: string, id: number): Promise<Response> =>
        worker.fetch(
          new Request(`https://gw.test/api/admin/keys/${id}/test`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: '{}' }),
          env,
          makeCtx().ctx,
        );

      it('an invalid key with an upstream 200 answers ok with key_status invalid and records no key write', async () => {
        mockKeys[0].status = 'invalid';
        vi.spyOn(globalThis, 'fetch').mockResolvedValue(
          new Response('{"id":"msg_t","content":[]}', { status: 200, headers: { 'content-type': 'application/json' } }),
        );
        const cookie = await adminCookie();
        const res = await testKeyCall(cookie, 101);
        const json = (await res.json()) as { ok: boolean; key_status: string };
        expect(json).toMatchObject({ ok: true, key_status: 'invalid' });
        expect(keyUpdates).toEqual([]);
      });

      it('an invalid key with an upstream 429 records no key write', async () => {
        mockKeys[0].status = 'invalid';
        vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{"error":"slow"}', { status: 429 }));
        const cookie = await adminCookie();
        const res = await testKeyCall(cookie, 101);
        expect(await res.json()).toMatchObject({ ok: false, key_status: 'invalid' });
        expect(keyUpdates).toEqual([]);
      });

      it('a disabled key with an upstream 200 records no key write', async () => {
        mockKeys[0].status = 'disabled';
        vi.spyOn(globalThis, 'fetch').mockResolvedValue(
          new Response('{"id":"msg_t","content":[]}', { status: 200, headers: { 'content-type': 'application/json' } }),
        );
        const cookie = await adminCookie();
        const res = await testKeyCall(cookie, 101);
        expect(await res.json()).toMatchObject({ ok: true, key_status: 'disabled' });
        expect(keyUpdates).toEqual([]);
      });

      it('an exhausted key with an upstream 200 is written back to active', async () => {
        mockKeys[0].status = 'exhausted';
        vi.spyOn(globalThis, 'fetch').mockResolvedValue(
          new Response('{"id":"msg_t","content":[]}', { status: 200, headers: { 'content-type': 'application/json' } }),
        );
        const cookie = await adminCookie();
        const res = await testKeyCall(cookie, 101);
        expect(await res.json()).toMatchObject({ ok: true, key_status: 'exhausted' });
        expect(keyUpdates).toEqual([{ id: 101, status: 'active', reason: null }]);
      });

      it('an active key with an upstream 401 is written to invalid through the guarded SQL', async () => {
        vi.spyOn(globalThis, 'fetch').mockResolvedValue(
          new Response('{"error":{"message":"bad key"}}', { status: 401, headers: { 'content-type': 'application/json' } }),
        );
        const cookie = await adminCookie();
        const res = await testKeyCall(cookie, 101);
        expect(await res.json()).toMatchObject({ ok: false, key_status: 'active' });
        expect(keyUpdates).toEqual([{ id: 101, status: 'invalid', reason: 'bad key' }]);
        expect(keyUpdateSql[0]).toContain("NOT IN ('invalid','disabled')");
      });

      it("a failing key test answers 'HTTP 401: {reason}' with no raw action code", async () => {
        vi.spyOn(globalThis, 'fetch').mockResolvedValue(
          new Response('{"error":{"message":"bad key"}}', { status: 401, headers: { 'content-type': 'application/json' } }),
        );
        const cookie = await adminCookie();
        const res = await testKeyCall(cookie, 101);
        const json = (await res.json()) as { message: string };
        expect(json.message).toBe('HTTP 401: bad key');
        expect(json.message).not.toMatch(/^(EXHAUSTED|INVALID_KEY|RATE_LIMITED|UPSTREAM_ERROR|CLIENT_ERROR)/);
      });
    });

    describe('DROP-04 providers list carries the drop record', () => {
      it('GET /providers returns status_code and never key_enc (DROP-04)', async () => {
        // Key 101 was dropped with HTTP 403; key 102 has no drop record (a key dropped before this phase, status_code null).
        mockKeys[0].status = 'invalid';
        mockKeys[0].status_code = 403;
        mockKeys[0].status_reason = 'HTTP 403: forbidden';
        mockKeys[1].status_code = null;
        const cookie = await adminCookie();
        const res = await worker.fetch(
          new Request('https://gw.test/api/admin/providers', { method: 'GET', headers: { cookie } }),
          env,
          makeCtx().ctx,
        );
        expect(res.status).toBe(200);
        const text = await res.text();
        expect(text).not.toContain('key_enc');
        const json = JSON.parse(text) as { providers: Array<{ id: number; keys: Array<Record<string, unknown>> }> };
        const provA = json.providers.find((p) => p.id === 1)!;
        const dropped = provA.keys.find((k) => k.id === 101)!;
        const oldKey = provA.keys.find((k) => k.id === 102)!;
        expect(dropped).toMatchObject({ status: 'invalid', status_code: 403, status_reason: 'HTTP 403: forbidden' });
        expect(oldKey.status_code).toBeNull();
        for (const p of json.providers) for (const k of p.keys) expect(Object.keys(k)).not.toContain('key_enc');
      });
    });

    // DROP-06, D-04, DROP-07 at the route layer: drop-list fields on provider writes, and the Rules endpoints refuse
    // a drop-list row (plan 03-03 Task 2). Every write is checked against the fake D1, with no real engine.
    describe('DROP-06 provider drop list routes (plan 03-03)', () => {
      const adminJson = async (cookie: string, method: string, path: string, payload: unknown): Promise<Response> =>
        worker.fetch(
          new Request(`https://gw.test/api/admin${path}`, {
            method,
            headers: { cookie, 'content-type': 'application/json' },
            body: JSON.stringify(payload),
          }),
          env,
          makeCtx().ctx,
        );

      it('a create with drop_codes and drop_message writes its rule with the provider id in one batch (DROP-07, D-06)', async () => {
        const cookie = await adminCookie();
        const res = await adminJson(cookie, 'POST', '/providers', {
          name: 'Drop Relay',
          base_url: 'https://drop-relay.test',
          keys: [],
          drop_codes: '403 418',
          drop_message: 'quota (soon).',
        });
        expect(res.status).toBe(201);
        const insert = ruleWrites.find((w) => /INSERT INTO error_rules/.test(w.sql));
        expect(insert).toBeDefined();
        expect(insert!.sql).toContain("'drop_list'");
        expect(insert!.bound).toContain(-1);
        expect(insert!.bound).toContain('403,418');
        expect(insert!.bound).toContain('quota \\(soon\\)\\.');
        expect(insert!.bound).toContain('quota (soon).');
      });

      it('a create with an invalid drop_codes answers 400 and writes no provider or rule', async () => {
        const cookie = await adminCookie();
        for (const drop_codes of ['abc', '200', '503-500']) {
          const res = await adminJson(cookie, 'POST', '/providers', { name: `Bad ${drop_codes}`, base_url: 'https://bad.test', keys: [], drop_codes });
          expect(res.status).toBe(400);
        }
        expect(providerInserts).toEqual([]);
        expect(ruleWrites).toEqual([]);
      });

      it('a message with no codes answers 400 and writes nothing (DROP-06 empty)', async () => {
        const cookie = await adminCookie();
        const res = await adminJson(cookie, 'POST', '/providers', { name: 'Msg Only', base_url: 'https://msg.test', keys: [], drop_message: 'quota' });
        expect(res.status).toBe(400);
        expect(await res.json()).toMatchObject({ error: 'Add a status code to use this message.' });
        expect(providerInserts).toEqual([]);
        expect(ruleWrites).toEqual([]);
      });

      it('a create with neither drop field writes no error rule at all', async () => {
        const cookie = await adminCookie();
        const res = await adminJson(cookie, 'POST', '/providers', { name: 'Plain Relay', base_url: 'https://plain.test', keys: [] });
        expect(res.status).toBe(201);
        expect(ruleWrites).toEqual([]);
      });

      it('PUT with only the basic fields leaves the drop-list row alone (DROP-06)', async () => {
        const cookie = await adminCookie();
        const res = await adminJson(cookie, 'PUT', '/providers/1', { name: 'ProviderA', base_url: 'https://prov-a.test' });
        expect(res.status).toBe(200);
        expect(providerUpdates).toHaveLength(1);
        expect(ruleWrites).toEqual([]);
      });

      it('PUT with blank drop fields deletes the drop-list row and inserts none (DROP-06 empty)', async () => {
        const cookie = await adminCookie();
        const res = await adminJson(cookie, 'PUT', '/providers/1', { drop_codes: '', drop_message: '' });
        expect(res.status).toBe(200);
        expect(ruleWrites).toHaveLength(1);
        expect(ruleWrites[0].sql).toMatch(/^DELETE FROM error_rules WHERE provider_id = \? AND origin = 'drop_list'/);
        expect(ruleWrites[0].sql).not.toMatch(/INSERT/);
      });

      it('PUT with codes writes the provider and upserts the rule in one batch (DROP-07)', async () => {
        const cookie = await adminCookie();
        const res = await adminJson(cookie, 'PUT', '/providers/1', { drop_codes: '403, 418', drop_message: '' });
        expect(res.status).toBe(200);
        expect(providerUpdates).toHaveLength(1);
        expect(ruleWrites.map((w) => w.sql.split(' ')[0])).toEqual(['UPDATE', 'INSERT']);
        expect(ruleWrites[0].bound).toContain('403,418');
        expect(ruleWrites[1].bound).toContain('403,418');
        expect(ruleWrites[1].sql).toContain('WHERE NOT EXISTS');
        expect(batchSizes).toEqual([4]);
      });

      it('GET /providers shows the drop list on its provider and empty strings on a provider without one (DROP-06)', async () => {
        mockRules.push({
          id: 50,
          provider_id: 1,
          priority: -1,
          status_codes: '403,418',
          body_regex: 'quota',
          action: 'INVALID_KEY',
          cooldown_s: null,
          note: 'quota',
          enabled: 1,
          origin: 'drop_list',
        });
        const cookie = await adminCookie();
        const res = await worker.fetch(
          new Request('https://gw.test/api/admin/providers', { method: 'GET', headers: { cookie } }),
          env,
          makeCtx().ctx,
        );
        const json = (await res.json()) as { providers: Array<{ id: number; drop_codes: string; drop_message: string }> };
        expect(json.providers.find((p) => p.id === 1)).toMatchObject({ drop_codes: '403,418', drop_message: 'quota' });
        expect(json.providers.find((p) => p.id === 2)).toMatchObject({ drop_codes: '', drop_message: '' });
      });

      it('PUT and DELETE on a drop-list rule answer 409 and write nothing (T-03-13)', async () => {
        mockRules.push({
          id: 50,
          provider_id: 1,
          priority: -1,
          status_codes: '403,418',
          body_regex: null,
          action: 'INVALID_KEY',
          cooldown_s: null,
          note: null,
          enabled: 1,
          origin: 'drop_list',
        });
        const cookie = await adminCookie();
        const put = await adminJson(cookie, 'PUT', '/rules/50', { action: 'INVALID_KEY', status_codes: '401', priority: 5 });
        expect(put.status).toBe(409);
        expect(await put.json()).toMatchObject({ error: "This rule comes from a provider's drop list. Edit it in the provider." });
        const del = await adminJson(cookie, 'DELETE', '/rules/50', {});
        expect(del.status).toBe(409);
        expect(ruleWrites).toEqual([]);
      });

      it('a normal rule keeps the same behavior, with spaces typed between its codes stored as commas (DROP-06)', async () => {
        const cookie = await adminCookie();
        const res = await adminJson(cookie, 'PUT', '/rules/2', { action: 'EXHAUSTED', status_codes: '401 403', priority: 20 });
        expect(res.status).toBe(200);
        expect(ruleWrites).toHaveLength(1);
        expect(ruleWrites[0].bound).toContain('401,403');
      });
    });
  });
});
