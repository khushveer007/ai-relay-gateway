import { plainKey } from './db/cache';
import { classify, type Classification } from './routing/error-rules';
import { buildUpstreamUrl, looksLikeJsonError } from './proxy/formats';
import type { Env, ErrorRule, Provider, ProviderKey } from './types';

export interface BalanceResult {
  supported: boolean;
  balance: number | null;
  error?: string;
}

export interface TestResult {
  ok: boolean;
  status: number;
  ms: number;
  cls?: Classification;
  message: string;
}

const TIMEOUT = 15_000;

/** What test connection says when a relay answers 200 but the body is not a model list. */
export const NOT_A_MODEL_LIST = 'The relay answered 200 but did not return a model list';

function authHeaders(key: string, extra: Record<string, string>): Headers {
  const h = new Headers({
    authorization: `Bearer ${key}`,
    'x-api-key': key,
    'anthropic-version': '2023-06-01',
    accept: 'application/json',
  });
  for (const [k, v] of Object.entries(extra)) h.set(k, v);
  return h;
}

async function getJson(url: string, key: string, extra: Record<string, string>): Promise<any> {
  const res = await fetch(url, { headers: authHeaders(key, extra), signal: AbortSignal.timeout(TIMEOUT) });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`not JSON: ${text.slice(0, 120)}`);
  }
}

/** Reads `a.b.0.c` style paths. */
export function readPath(obj: unknown, path: string): unknown {
  let cur: any = obj;
  for (const part of path.split('.').filter(Boolean)) {
    if (cur === null || cur === undefined) return undefined;
    cur = cur[part];
  }
  return cur;
}

/** Resolves a balance path: absolute URL, `/v1/...` (relative to base), or root path on the base origin. */
export function balanceUrl(baseUrl: string, path: string): string {
  if (/^https?:\/\//i.test(path)) return path;
  if (path.startsWith('/v1/')) return buildUpstreamUrl(baseUrl, path);
  return new URL(path, new URL(baseUrl).origin).toString();
}

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Balance modes:
 * - standard: OpenAI-style billing endpoints (supported by new-api / one-api relays):
 *             balance = subscription.hard_limit_usd − usage.total_usage / 100
 * - custom:   any JSON endpoint + field path (+ divisor), e.g. new-api `/api/usage/token` → `data.total_available` ÷ 500000
 * - none:     relay offers no balance endpoint
 */
export async function checkBalance(env: Env, provider: Provider, key: ProviderKey): Promise<BalanceResult> {
  if (provider.balance_mode === 'none') return { supported: false, balance: null };
  const apiKey = await plainKey(env, key);
  try {
    if (provider.balance_mode === 'custom') {
      if (!provider.balance_path || !provider.balance_field) {
        return { supported: false, balance: null, error: 'custom balance path/field not configured' };
      }
      const j = await getJson(balanceUrl(provider.base_url, provider.balance_path), apiKey, provider.extra_headers);
      const raw = Number(readPath(j, provider.balance_field));
      if (!Number.isFinite(raw)) return { supported: true, balance: null, error: `field "${provider.balance_field}" not numeric` };
      return { supported: true, balance: raw / (provider.balance_divisor || 1) };
    }
    const sub = await getJson(buildUpstreamUrl(provider.base_url, '/v1/dashboard/billing/subscription'), apiKey, provider.extra_headers);
    const hard = Number(sub?.hard_limit_usd ?? sub?.system_hard_limit_usd);
    if (!Number.isFinite(hard)) return { supported: false, balance: null, error: 'subscription response has no hard_limit_usd' };
    const now = new Date();
    const start = new Date(now.getTime() - 99 * 86_400_000);
    const end = new Date(now.getTime() + 86_400_000);
    const usage = await getJson(
      buildUpstreamUrl(provider.base_url, `/v1/dashboard/billing/usage?start_date=${ymd(start)}&end_date=${ymd(end)}`),
      apiKey,
      provider.extra_headers,
    );
    const used = Number(usage?.total_usage ?? 0) / 100;
    return { supported: true, balance: Math.round((hard - (Number.isFinite(used) ? used : 0)) * 10000) / 10000 };
  } catch (e) {
    return { supported: false, balance: null, error: (e as Error).message };
  }
}

/** Sends the smallest possible real request to verify that a key works (costs ~1 output token). */
export async function testKey(env: Env, provider: Provider, key: ProviderKey, rules: ErrorRule[]): Promise<TestResult> {
  const model = provider.test_model || provider.models[0] || Object.values(provider.model_map)[0];
  if (!model) return { ok: false, status: 0, ms: 0, message: 'No test model: set one in the provider or fetch the model list.' };
  const apiKey = await plainKey(env, key);

  let path: string;
  let body: unknown;
  if (provider.formats.includes('openai-chat')) {
    path = '/v1/chat/completions';
    body = { model, max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] };
  } else if (provider.formats.includes('anthropic')) {
    path = '/v1/messages';
    body = { model, max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] };
  } else {
    path = '/v1/responses';
    body = { model, max_output_tokens: 16, input: 'hi' };
  }

  const t0 = Date.now();
  try {
    const headers = authHeaders(apiKey, provider.extra_headers);
    headers.set('content-type', 'application/json');
    const res = await fetch(buildUpstreamUrl(provider.base_url, path), {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(Math.min(provider.timeout_ms, 30_000)),
    });
    const text = await res.text();
    const ms = Date.now() - t0;
    if (res.ok && !looksLikeJsonError(text)) return { ok: true, status: res.status, ms, message: `OK (${model})` };
    const cls = classify(rules, provider.id, res.ok ? 200 : res.status, text, res.headers.get('retry-after'));
    return { ok: false, status: res.status, ms, cls, message: `${cls.action}: ${cls.reason}` };
  } catch (e) {
    return { ok: false, status: 0, ms: Date.now() - t0, message: `network error: ${(e as Error).message}` };
  }
}

/**
 * Fetches the provider's model list from GET /v1/models (OpenAI and Anthropic list formats).
 * `strict` (test connection) throws when a 200 body holds no model list at all, so a relay that
 * answers 200 with an error body is not reported as a working connection with 0 models.
 */
export async function fetchModels(
  provider: Pick<Provider, 'base_url' | 'extra_headers'>,
  apiKey: string,
  opts: { strict?: boolean } = {},
): Promise<string[]> {
  const j = await getJson(buildUpstreamUrl(provider.base_url, '/v1/models?limit=1000'), apiKey, provider.extra_headers);
  const found = Array.isArray(j) ? j : Array.isArray(j?.data) ? j.data : Array.isArray(j?.models) ? j.models : null;
  if (found === null && opts.strict) throw new Error(`HTTP 200: ${NOT_A_MODEL_LIST}`);
  const list: unknown[] = found ?? [];
  const ids = list
    .map((m: any) => (typeof m === 'string' ? m : m?.id ?? m?.name))
    .filter((x): x is string => typeof x === 'string' && x.length > 0)
    .map((x) => x.replace(/^models\//, ''));
  return [...new Set(ids)].sort();
}
