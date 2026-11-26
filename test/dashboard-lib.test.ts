import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  actionConsequence,
  actionLabel,
  enableLabel,
  fmtAgo,
  fmtBalance,
  fmtCooldown,
  fmtDateTime,
  fmtMs,
  fmtNum,
  fmtTime,
  fmtTokens,
  fmtTokensOrDash,
  keyStatusLabel,
  plainActionText,
} from '../src/dashboard/lib/format';
import { ALL_ACTIONS } from '../src/worker/types';
import {
  DEFAULT_RANGE,
  RANGES,
  RANGE_LABEL,
  RANGE_STORAGE_KEY,
  alignSeries,
  fillSeries,
  keyDetailText,
  keyLabel,
  parseRange,
  successRate,
} from '../src/dashboard/lib/overview';
import {
  DESKTOP_MIN_WIDTH_PX,
  DESKTOP_QUERY,
  canSubmitPassword,
  isDesktopWidth,
  loginErrorMessage,
  shouldReloadForPreloadError,
} from '../src/dashboard/lib/guards';
import { NAV_LABEL, VIEW_IDS, parseHash } from '../src/dashboard/lib/routes';

const NOW = Date.UTC(2026, 10, 14, 12, 0, 0);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('format', () => {
  it('fmtNum treats null and undefined as 0 and groups digits', () => {
    expect(fmtNum(null)).toBe('0');
    expect(fmtNum(undefined)).toBe('0');
    expect(fmtNum(Number.NaN)).toBe('0');
    expect(fmtNum(1234)).toBe((1234).toLocaleString());
  });

  it('fmtTokens switches unit at 1k and 1M', () => {
    expect(fmtTokens(null)).toBe('0');
    expect(fmtTokens(999)).toBe('999');
    expect(fmtTokens(1000)).toBe('1.0k');
    expect(fmtTokens(1_500_000)).toBe('1.50M');
  });

  it('fmtTokensOrDash shows a dash for missing values only', () => {
    expect(fmtTokensOrDash(null)).toBe('—');
    expect(fmtTokensOrDash(undefined)).toBe('—');
    expect(fmtTokensOrDash(1500)).toBe('1.5k');
    expect(fmtTokensOrDash(0)).toBe('0');
  });

  it('fmtBalance uses 4 decimals under a dollar and 2 above', () => {
    expect(fmtBalance(null)).toBe('—');
    expect(fmtBalance(0.5)).toBe('$0.5000');
    expect(fmtBalance(12)).toBe('$12.00');
    expect(fmtBalance(0)).toBe('$0.00');
  });

  it('fmtMs shows a dash for missing or zero latency', () => {
    expect(fmtMs(null)).toBe('—');
    expect(fmtMs(0)).toBe('—');
    expect(fmtMs(240)).toBe('240 ms');
  });

  it('fmtAgo reads relative to the current time in both directions', () => {
    expect(fmtAgo(0)).toBe('never');
    expect(fmtAgo(null)).toBe('never');
    expect(fmtAgo(NOW)).toBe('just now');
    expect(fmtAgo(NOW - 30_000)).toBe('30s ago');
    expect(fmtAgo(NOW - 2 * 60_000)).toBe('2m ago');
    expect(fmtAgo(NOW - 3 * 3_600_000)).toBe('3h ago');
    expect(fmtAgo(NOW - 2 * 86_400_000)).toBe('2d ago');
    expect(fmtAgo(NOW + 10_000)).toBe('in 10s');
    expect(fmtAgo(NOW + 2 * 60_000)).toBe('in 2m');
  });

  it('fmtTime renders a 24-hour clock', () => {
    expect(fmtTime(NOW)).toMatch(/^\d{2}:\d{2}:\d{2}$/);
  });
});

describe('overview: range', () => {
  it('exposes the three ranges, the default and the storage key', () => {
    expect([...RANGES]).toEqual(['1h', '24h', '7d']);
    expect(DEFAULT_RANGE).toBe('24h');
    expect(RANGE_STORAGE_KEY).toBe('gw.overview.range');
    expect(RANGE_LABEL).toEqual({ '1h': 'Last 1h', '24h': 'Last 24h', '7d': 'Last 7d' });
  });

  it('parseRange keeps valid values', () => {
    expect(parseRange('1h')).toBe('1h');
    expect(parseRange('24h')).toBe('24h');
    expect(parseRange('7d')).toBe('7d');
  });

  it('parseRange falls back to 24h for anything else', () => {
    expect(parseRange(null)).toBe('24h');
    expect(parseRange(undefined)).toBe('24h');
    expect(parseRange('')).toBe('24h');
    expect(parseRange('abc')).toBe('24h');
    expect(parseRange('30d')).toBe('24h');
  });
});

describe('overview: successRate', () => {
  it('is 100.0 when there are no requests', () => {
    expect(successRate({ requests: 0, ok: null })).toBe('100.0');
  });

  it('is the share of ok requests with one decimal', () => {
    expect(successRate({ requests: 4, ok: 3 })).toBe('75.0');
  });

  it('treats a null ok count (SUM over no matching rows) as zero', () => {
    expect(successRate({ requests: 4, ok: null })).toBe('0.0');
  });
});

describe('overview: fillSeries', () => {
  const H = 3_600_000;
  const row = (bucket: number, requests: number, errors = 0, failovers = 0) => ({
    bucket,
    requests,
    errors,
    failovers,
    output_tokens: 0,
  });

  it('returns an empty list for an empty series so the chart keeps its empty state', () => {
    expect(fillSeries([], 0, H, 10 * H)).toEqual([]);
  });

  it('fills a gap between buckets with zero entries', () => {
    const out = fillSeries([row(2 * H, 5, 1, 2), row(5 * H, 3)], 2 * H, H, 5 * H);
    expect(out.map((b) => b.bucket)).toEqual([2 * H, 3 * H, 4 * H, 5 * H]);
    expect(out[0]).toEqual({ bucket: 2 * H, requests: 5, ok: 4, errors: 1, failovers: 2 });
    expect(out[1]).toEqual({ bucket: 3 * H, requests: 0, ok: 0, errors: 0, failovers: 0 });
    expect(out[3]).toEqual({ bucket: 5 * H, requests: 3, ok: 3, errors: 0, failovers: 0 });
  });

  it('starts at the bucket-aligned floor of since even when since is not a multiple of bucketMs', () => {
    const since = 2 * H + 1_234_567;
    const out = fillSeries([row(2 * H, 1)], since, H, 4 * H);
    expect(out[0]!.bucket).toBe(2 * H);
    expect(out.map((b) => b.bucket)).toEqual([2 * H, 3 * H, 4 * H]);
  });

  it('still yields the full aligned range for a single bucket', () => {
    const out = fillSeries([row(10 * H, 7)], 7 * H, H, 10 * H + 5);
    expect(out.map((b) => b.bucket)).toEqual([7 * H, 8 * H, 9 * H, 10 * H]);
    expect(out.map((b) => b.requests)).toEqual([0, 0, 0, 7]);
  });

  it('walks on to the last input bucket when it is later than now', () => {
    const out = fillSeries([row(6 * H, 2)], 4 * H, H, 5 * H);
    expect(out.map((b) => b.bucket)).toEqual([4 * H, 5 * H, 6 * H]);
  });

  it('clamps ok at zero when errors exceed requests', () => {
    const out = fillSeries([row(H, 2, 5)], H, H, H);
    expect(out[0]!.ok).toBe(0);
    expect(out[0]!.errors).toBe(5);
  });

  it('returns the input buckets unfilled when bucketMs is not positive', () => {
    const input = [row(1, 4, 1), row(100, 2)];
    const out = fillSeries(input, 0, 0, 1000);
    expect(out.map((b) => b.bucket)).toEqual([1, 100]);
    expect(out[0]!.ok).toBe(3);
    expect(fillSeries(input, 0, -5, 1000)).toHaveLength(2);
  });
});

describe('overview: alignSeries', () => {
  const H = 3_600_000;
  const row = (bucket: number, requests: number, errors = 0, failovers = 0) => ({
    bucket,
    requests,
    errors,
    failovers,
  });

  it('leaves already aligned buckets unchanged', () => {
    expect(alignSeries([row(2 * H, 5, 1, 2), row(4 * H, 3)], H)).toEqual([row(2 * H, 5, 1, 2), row(4 * H, 3)]);
  });

  it('snaps raw timestamps to their bucket and merges rows in the same slot', () => {
    const out = alignSeries([row(2 * H + 10, 1, 1, 0), row(2 * H + 999, 2, 0, 1), row(3 * H + 5, 4)], H);
    expect(out).toEqual([row(2 * H, 3, 1, 1), row(3 * H, 4)]);
  });

  it('makes unaligned rows reachable by fillSeries', () => {
    const aligned = alignSeries([row(2 * H + 10, 1)], H);
    const out = fillSeries(aligned, 2 * H, H, 3 * H);
    expect(out.map((b) => b.requests)).toEqual([1, 0]);
  });

  it('returns the input when bucketMs is not positive', () => {
    const input = [row(7, 1)];
    expect(alignSeries(input, 0)).toBe(input);
  });
});

describe('overview: key text', () => {
  const key = {
    alias: 'main',
    key_hint: 'sk-…abcd',
    status: 'active',
    status_reason: null as string | null,
    cooldown_until: null as number | null,
    next_recheck_at: null as number | null,
  };

  it('keyLabel prefers alias plus hint, then the hint, then a dash', () => {
    expect(keyLabel(key)).toBe('main (sk-…abcd)');
    expect(keyLabel({ ...key, alias: '' })).toBe('sk-…abcd');
    expect(keyLabel({ ...key, alias: '', key_hint: '' })).toBe('—');
  });

  it('keyDetailText says Healthy when there is no reason', () => {
    expect(keyDetailText(key)).toBe('Healthy');
  });

  it('keyDetailText shows the reason as is', () => {
    expect(keyDetailText({ ...key, status: 'invalid', status_reason: 'HTTP 401' })).toBe('HTTP 401');
  });

  it('keyDetailText appends the cooldown for a rate limited key', () => {
    const out = keyDetailText({ ...key, status: 'rate_limited', status_reason: 'HTTP 429', cooldown_until: NOW + 120_000 });
    expect(out).toBe('HTTP 429 · cools down in 2m');
  });

  it('keyDetailText appends the recheck for an exhausted key', () => {
    const out = keyDetailText({ ...key, status: 'exhausted', status_reason: 'No balance', next_recheck_at: NOW + 3 * 3_600_000 });
    expect(out).toBe('No balance · recheck in 3.0h');
  });
});

describe('guards', () => {
  it('isDesktopWidth switches at exactly 768px', () => {
    expect(DESKTOP_MIN_WIDTH_PX).toBe(768);
    expect(DESKTOP_QUERY).toBe('(min-width: 768px)');
    expect(isDesktopWidth(767)).toBe(false);
    expect(isDesktopWidth(768)).toBe(true);
  });

  it('loginErrorMessage maps 401, 429 and everything else', () => {
    expect(loginErrorMessage(401)).toBe('Incorrect password. Check your ADMIN_PASSWORD and try again.');
    expect(loginErrorMessage(429)).toBe('Too many sign-in attempts. Wait 15 minutes and try again.');
    expect(loginErrorMessage(500)).toBe('Could not reach the gateway. Check your connection and try again.');
    expect(loginErrorMessage(0)).toBe('Could not reach the gateway. Check your connection and try again.');
  });

  it('canSubmitPassword rejects empty and whitespace-only input', () => {
    expect(canSubmitPassword('')).toBe(false);
    expect(canSubmitPassword('   ')).toBe(false);
    expect(canSubmitPassword('x')).toBe(true);
  });

  it('shouldReloadForPreloadError allows one reload per 10 seconds', () => {
    expect(shouldReloadForPreloadError(NOW, null)).toBe(true);
    expect(shouldReloadForPreloadError(NOW, String(NOW - 3_000))).toBe(false);
    expect(shouldReloadForPreloadError(NOW, String(NOW - 11_000))).toBe(true);
    expect(shouldReloadForPreloadError(NOW, 'junk')).toBe(true);
  });
});

describe('routes', () => {
  it('VIEW_IDS holds the six destinations in nav order', () => {
    expect([...VIEW_IDS]).toEqual(['overview', 'providers', 'routes', 'gateway-keys', 'logs', 'settings']);
  });

  it('NAV_LABEL maps every id to its exact label', () => {
    expect(NAV_LABEL).toEqual({
      overview: 'Overview',
      providers: 'Providers & Keys',
      routes: 'Routes & Chains',
      'gateway-keys': 'Gateway Keys',
      logs: 'Request Logs',
      settings: 'Rules & Settings',
    });
  });

  it('parseHash accepts #/id and #id', () => {
    expect(parseHash('#/providers')).toBe('providers');
    expect(parseHash('#providers')).toBe('providers');
    expect(parseHash('#/gateway-keys')).toBe('gateway-keys');
  });

  it('parseHash falls back to overview for empty, unknown and playground hashes', () => {
    expect(parseHash('')).toBe('overview');
    expect(parseHash('#')).toBe('overview');
    expect(parseHash('#/nope')).toBe('overview');
    expect(parseHash('#/__playground')).toBe('overview');
    expect(parseHash('#/providers/extra')).toBe('overview');
  });
});

describe('actionLabel (DROP-08, D-11)', () => {
  it('gives every action a non-empty plain name that differs from its code', () => {
    for (const action of ALL_ACTIONS) {
      const name = actionLabel(action);
      expect(name.length).toBeGreaterThan(0);
      expect(name).not.toBe(action);
    }
  });

  it('names each of the five actions in plain words', () => {
    expect(actionLabel('INVALID_KEY')).toBe('Drop key until I re-enable it');
    expect(actionLabel('EXHAUSTED')).toBe('Mark out of balance (auto-recheck)');
    expect(actionLabel('UPSTREAM_ERROR')).toBe('Try next provider');
    expect(actionLabel('CLIENT_ERROR')).toBe('Return error to client');
  });

  it('shows RATE_LIMITED with its cooldown in minutes when one is valid', () => {
    expect(actionLabel('RATE_LIMITED', { cooldownS: 600 })).toBe('Pause key for 10 min');
  });

  it('shows RATE_LIMITED as Pause key for N min when the cooldown is missing or bad', () => {
    expect(actionLabel('RATE_LIMITED')).toBe('Pause key for N min');
    expect(actionLabel('RATE_LIMITED', { cooldownS: null })).toBe('Pause key for N min');
    expect(actionLabel('RATE_LIMITED', { cooldownS: 0 })).toBe('Pause key for N min');
    expect(actionLabel('RATE_LIMITED', { cooldownS: Number.NaN })).toBe('Pause key for N min');
  });

  it('keeps OK as OK and returns an unknown value unchanged', () => {
    expect(actionLabel('OK')).toBe('OK');
    expect(actionLabel('SOMETHING_NEW')).toBe('SOMETHING_NEW');
  });
});

describe('actionConsequence (DROP-08, D-11)', () => {
  it('gives each of the five actions a caption', () => {
    for (const action of ALL_ACTIONS) expect(actionConsequence(action).length).toBeGreaterThan(0);
  });

  it('returns an empty string for an unknown action', () => {
    expect(actionConsequence('SOMETHING_NEW')).toBe('');
  });
});

describe('keyStatusLabel and enableLabel (DROP-03, DROP-05)', () => {
  it('maps each key status to its operator word', () => {
    expect(keyStatusLabel('active')).toBe('Active');
    expect(keyStatusLabel('rate_limited')).toBe('Paused');
    expect(keyStatusLabel('exhausted')).toBe('Out of balance');
    expect(keyStatusLabel('invalid')).toBe('Dropped');
    expect(keyStatusLabel('disabled')).toBe('Disabled');
  });

  it('returns an unknown status unchanged', () => {
    expect(keyStatusLabel('mystery')).toBe('mystery');
  });

  it('reads Re-enable for a dropped key and Enable for any other status', () => {
    expect(enableLabel('invalid')).toBe('Re-enable');
    expect(enableLabel('disabled')).toBe('Enable');
    expect(enableLabel('exhausted')).toBe('Enable');
    expect(enableLabel('active')).toBe('Enable');
  });
});

describe('fmtCooldown (DROP-08 boundaries and precision)', () => {
  it('switches from seconds to minutes at exactly 60 seconds', () => {
    expect(fmtCooldown(59)).toBe('59 s');
    expect(fmtCooldown(60)).toBe('1 min');
    expect(fmtCooldown(61)).toBe('1 min');
  });

  it('rounds minutes to one decimal and drops a trailing .0', () => {
    expect(fmtCooldown(90)).toBe('1.5 min');
    expect(fmtCooldown(100)).toBe('1.7 min');
    expect(fmtCooldown(150)).toBe('2.5 min');
    expect(fmtCooldown(600)).toBe('10 min');
    expect(fmtCooldown(3600)).toBe('60 min');
  });

  it('gives 0 s for zero and an empty string for a non-finite input, without throwing', () => {
    expect(fmtCooldown(0)).toBe('0 s');
    expect(fmtCooldown(Number.NaN)).toBe('');
    expect(fmtCooldown(Number.POSITIVE_INFINITY)).toBe('');
  });
});

describe('fmtDateTime', () => {
  it('gives the day, short month and 24-hour time, without a year', () => {
    expect(fmtDateTime(Date.UTC(2026, 10, 18, 14, 32))).toMatch(/^\d{1,2} [A-Z][a-z]{2}, \d{2}:\d{2}$/);
  });
});

describe('plainActionText (D-13)', () => {
  it('replaces a whole-word raw action code with its plain name', () => {
    const out = plainActionText('All failed (A/k: INVALID_KEY)');
    expect(out).toContain('Drop key until I re-enable it');
    expect(out).not.toMatch(/INVALID_KEY/);
  });

  it('leaves text without a raw code alone', () => {
    expect(plainActionText('HTTP 403: forbidden')).toBe('HTTP 403: forbidden');
  });

  it('does not touch a code that is only part of a longer word', () => {
    expect(plainActionText('NOT_INVALID_KEY_X')).toBe('NOT_INVALID_KEY_X');
  });
});
