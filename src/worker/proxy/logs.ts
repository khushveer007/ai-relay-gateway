import { priceUsage, type PriceIndex, type PriceResolution } from '../../shared/pricing';
import type { Attempt, Env } from '../types';

export interface LogEntry {
  ts: number;
  gateway_key_id: number | null;
  route_id: number | null;
  format: string;
  path: string;
  model: string | null;
  upstream_model: string | null;
  provider_id: number | null;
  key_id: number | null;
  status: number;
  stream: boolean;
  latency_ms: number;
  ttfb_ms: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_tokens: number | null;
  cache_write_tokens: number | null;
  attempts: Attempt[];
  error: string | null;
}

export function newLog(path: string, format: string): LogEntry {
  return {
    ts: Date.now(),
    gateway_key_id: null,
    route_id: null,
    format,
    path,
    model: null,
    upstream_model: null,
    provider_id: null,
    key_id: null,
    status: 0,
    stream: false,
    latency_ms: 0,
    ttfb_ms: null,
    input_tokens: null,
    output_tokens: null,
    cache_tokens: null,
    cache_write_tokens: null,
    attempts: [],
    error: null,
  };
}

/** One INSERT per request: the only D1 write on the happy path. */
export function writeLog(env: Env, e: LogEntry, prices: PriceIndex | null = null, resolution: PriceResolution | null = null): Promise<unknown> {
  if (!env?.DB) return Promise.resolve();
  const failovers = Math.max(0, e.attempts.length - 1);
  const priced = priceUsage(prices, resolution, e.format, {
    input: e.input_tokens,
    output: e.output_tokens,
    cache: e.cache_tokens,
    cacheWrite: e.cache_write_tokens,
  });
  return env.DB.prepare(
    `INSERT INTO request_logs
       (ts, gateway_key_id, route_id, format, path, model, upstream_model, provider_id, key_id, status, stream,
        latency_ms, ttfb_ms, input_tokens, output_tokens, cache_tokens, failovers, attempts, error,
        cache_write_tokens, cost_nano_usd, cost_reason, priced_model, price_match_type, price_tier_threshold_tokens,
        cache_read_savings_nano_usd)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      e.ts,
      e.gateway_key_id,
      e.route_id,
      e.format,
      e.path,
      e.model,
      e.upstream_model,
      e.provider_id,
      e.key_id,
      e.status,
      e.stream ? 1 : 0,
      e.latency_ms,
      e.ttfb_ms,
      e.input_tokens,
      e.output_tokens,
      e.cache_tokens,
      failovers,
      JSON.stringify(e.attempts),
      e.error ? e.error.slice(0, 500) : null,
      e.cache_write_tokens,
      priced.cost_nano_usd,
      priced.cost_reason,
      priced.priced_model,
      priced.price_match_type,
      priced.price_tier_threshold_tokens,
      priced.cache_read_savings_nano_usd,
    )
    .run()
    .catch((err) => console.error('log write failed', err));
}
