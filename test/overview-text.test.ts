import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { keyReasonLine, type KeyTextInput } from '../src/dashboard/lib/overview';

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
