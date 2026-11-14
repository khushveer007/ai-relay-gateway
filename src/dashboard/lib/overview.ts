// RED-phase stubs: real implementations arrive in the GREEN commit.
export const RANGES = [] as unknown as readonly ['1h', '24h', '7d'];
export type Range = '1h' | '24h' | '7d';
export const DEFAULT_RANGE: Range = '1h';
export const RANGE_STORAGE_KEY = '';
export const RANGE_LABEL: Record<Range, string> = { '1h': '', '24h': '', '7d': '' };
export function parseRange(_raw: string | null | undefined): Range {
  return '1h';
}
export function successRate(_totals: { requests?: number | null; ok?: number | null }): string {
  return '';
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
export function fillSeries(_series: SeriesInput[], _since: number, _bucketMs: number, _now: number): SeriesPoint[] {
  return [{ bucket: -1, requests: -1, ok: -1, errors: -1, failovers: -1 }];
}
export interface KeyTextInput {
  alias: string;
  key_hint: string;
  status: string;
  status_reason: string | null;
  cooldown_until: number | null;
  next_recheck_at: number | null;
}
export function keyLabel(_key: KeyTextInput): string {
  return '';
}
export function keyDetailText(_key: KeyTextInput): string {
  return '';
}
