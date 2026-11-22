import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { keyDetailText, keyDropLines, keyReasonLine, type KeyTextInput } from '../src/dashboard/lib/overview';

const NOW = Date.UTC(2026, 10, 14, 12, 0, 0);
const MIN = 60_000;
const HOUR = 60 * MIN;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

function key(over: Partial<KeyTextInput>): KeyTextInput {
  return {
    alias: 'A',
    key_hint: 'sk-…abcd',
    status: 'active',
    status_reason: null,
    cooldown_until: null,
    next_recheck_at: null,
    ...over,
  };
}

describe('keyDropLines (DROP-05)', () => {
  const droppedAt = NOW - 3 * HOUR;

  it('builds the meta line from the code, the relative time and the absolute time', () => {
    const lines = keyDropLines(
      key({ status: 'invalid', status_reason: 'bad key', status_code: 403, status_changed_at: droppedAt }),
    );
    expect(lines.meta).toMatch(/^HTTP 403 · dropped 3h ago \(\d{1,2} [A-Z][a-z]{2}, \d{2}:\d{2}\)$/);
    expect(lines.message).toBe('bad key');
  });

  it('starts the meta line with Dropped when there is no stored code', () => {
    const lines = keyDropLines(key({ status: 'invalid', status_reason: 'old', status_code: null, status_changed_at: droppedAt }));
    expect(lines.meta).toMatch(/^Dropped 3h ago \(/);
  });

  it('shows only the HTTP code when there is no stored time', () => {
    const lines = keyDropLines(key({ status: 'invalid', status_reason: 'x', status_code: 403, status_changed_at: null }));
    expect(lines.meta).toBe('HTTP 403');
  });

  it('gives no meta line when there is neither a code nor a time', () => {
    const lines = keyDropLines(key({ status: 'invalid', status_reason: 'x', status_code: null, status_changed_at: null }));
    expect(lines.meta).toBeNull();
    expect(lines.message).toBe('x');
  });

  it('gives no message line when there is no reason', () => {
    const lines = keyDropLines(key({ status: 'invalid', status_code: 401, status_changed_at: droppedAt }));
    expect(lines.message).toBeNull();
  });
});

describe('keyDetailText invalid branch (DROP-05, E9)', () => {
  it('joins the code, reason and time for a dropped key', () => {
    const out = keyDetailText(key({ status: 'invalid', status_reason: 'bad key', status_code: 403, status_changed_at: NOW - 3 * HOUR }));
    expect(out).toBe('HTTP 403 · bad key · dropped 3h ago');
  });

  it('leaves the code out when there is none', () => {
    const out = keyDetailText(key({ status: 'invalid', status_reason: 'bad key', status_code: null, status_changed_at: NOW - HOUR }));
    expect(out).toBe('bad key · dropped 1h ago');
  });

  it('keeps the bare reason for a dropped key with only the reason', () => {
    expect(keyDetailText(key({ status: 'invalid', status_reason: 'HTTP 401' }))).toBe('HTTP 401');
  });

  it('reads Dropped when a dropped key has nothing stored', () => {
    expect(keyDetailText(key({ status: 'invalid', status_reason: null, status_code: null, status_changed_at: null }))).toBe('Dropped');
  });
});

describe('keyReasonLine (research correction C3)', () => {
  it('returns null for a key with no status_reason', () => {
    expect(keyReasonLine(key({}))).toBeNull();
    expect(keyReasonLine(key({ status: 'exhausted', next_recheck_at: NOW + 2 * HOUR }))).toBeNull();
  });

  it('adds the recheck time to an exhausted key with a future recheck', () => {
    const line = keyReasonLine(key({ status: 'exhausted', status_reason: 'out of balance', next_recheck_at: NOW + 2 * HOUR }));
    expect(line).toBe('out of balance · recheck in 2.0h');
  });

  it('adds the cooldown time to a rate limited key with a future cooldown', () => {
    const line = keyReasonLine(key({ status: 'rate_limited', status_reason: 'too many requests', cooldown_until: NOW + 14 * MIN }));
    expect(line).toBe('too many requests · back in 14m');
  });

  it('returns the bare reason when the cooldown or recheck time is already past', () => {
    expect(keyReasonLine(key({ status: 'rate_limited', status_reason: 'slow down', cooldown_until: NOW - 5 * MIN }))).toBe('slow down');
    expect(keyReasonLine(key({ status: 'exhausted', status_reason: 'no credit', next_recheck_at: NOW - HOUR }))).toBe('no credit');
  });

  it('returns the bare reason for an active key and for a status with no schedule', () => {
    expect(keyReasonLine(key({ status: 'active', status_reason: 'recovered' }))).toBe('recovered');
    expect(keyReasonLine(key({ status: 'invalid', status_reason: 'HTTP 401' }))).toBe('HTTP 401');
  });
});
