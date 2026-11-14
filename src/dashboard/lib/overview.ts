// Pure Overview helpers. DOM-free; relative imports only (Vitest has no alias, and the Worker
// tsconfig that type-checks test/ has no DOM lib).
import { fmtAgo } from './format';

export const RANGES = ['1h', '24h', '7d'] as const;
export type Range = (typeof RANGES)[number];
export const DEFAULT_RANGE: Range = '24h';
// D-07: the chosen range is persisted under this browser-storage key by the caller.
export const RANGE_STORAGE_KEY = 'gw.overview.range';
export const RANGE_LABEL: Record<Range, string> = {
  '1h': 'Last 1h',
  '24h': 'Last 24h',
  '7d': 'Last 7d',
};

/** D-07: an invalid or missing stored value falls back to the default range. */
export function parseRange(raw: string | null | undefined): Range {
  return (RANGES as readonly string[]).includes(raw ?? '') ? (raw as Range) : DEFAULT_RANGE;
}

/** `ok` and `failovered` are SUM(...) and come back null when no rows match, so coerce first. */
export function successRate(totals: { requests?: number | null; ok?: number | null }): string {
  const requests = Number(totals.requests ?? 0);
  const ok = Number(totals.ok ?? 0);
  return requests > 0 ? ((ok / requests) * 100).toFixed(1) : '100.0';
}

export interface SeriesInput {
  bucket: number;
  requests: number;
  errors: number;
  failovers: number;
}

export interface SeriesPoint {
  bucket: number;
  requests: number;
  ok: number;
  errors: number;
  failovers: number;
}

function toPoint(s: SeriesInput): SeriesPoint {
  return {
    bucket: s.bucket,
    requests: s.requests,
    ok: Math.max(0, s.requests - s.errors),
    errors: s.errors,
    failovers: s.failovers,
  };
}

/**
 * The stats API returns only non-empty buckets. Walk every bucket slot from the aligned start of
 * the time span to the later of `now` and the last returned bucket, filling gaps with zeros.
 */
export function fillSeries(series: SeriesInput[], since: number, bucketMs: number, now: number): SeriesPoint[] {
  if (series.length === 0) return [];
  if (!(bucketMs > 0)) return series.map(toPoint);
  const byBucket = new Map(series.map((s) => [s.bucket, s]));
  const last = Math.max(...series.map((s) => s.bucket));
  const end = Math.max(now, last);
  const out: SeriesPoint[] = [];
  for (let b = Math.floor(since / bucketMs) * bucketMs; b <= end; b += bucketMs) {
    const hit = byBucket.get(b);
    out.push(hit ? toPoint(hit) : { bucket: b, requests: 0, ok: 0, errors: 0, failovers: 0 });
  }
  return out;
}

export interface KeyTextInput {
  alias: string;
  key_hint: string;
  status: string;
  status_reason: string | null;
  cooldown_until: number | null;
  next_recheck_at: number | null;
}

export function keyLabel(key: Pick<KeyTextInput, 'alias' | 'key_hint'>): string {
  if (key.alias) return `${key.alias} (${key.key_hint})`;
  return key.key_hint || '—';
}

export function keyDetailText(key: KeyTextInput): string {
  let detail = key.status_reason ? key.status_reason : 'Healthy';
  if (key.status === 'rate_limited' && key.cooldown_until) {
    detail += ` · cools down ${fmtAgo(key.cooldown_until)}`;
  } else if (key.status === 'exhausted' && key.next_recheck_at) {
    detail += ` · recheck ${fmtAgo(key.next_recheck_at)}`;
  }
  return detail;
}
