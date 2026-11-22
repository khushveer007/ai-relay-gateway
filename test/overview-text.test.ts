import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { keyDetailText, keyDropLines, keyReasonLine, keyTestToast, type KeyTextInput } from '../src/dashboard/lib/overview';

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

describe('keyTestToast (DROP-10, E8)', () => {
  const ok = (key_status: string) => ({ ok: true, message: 'Key works', ms: 412, status: 200, key_status });
  const fail = (key_status: string, status: number, reason: string | undefined, message = 'boom') => ({
    ok: false,
    message,
    ms: 412,
    status,
    key_status,
    cls: reason === undefined ? undefined : { reason },
  });

  it('says a dropped key that works is still dropped and points at Re-enable', () => {
    expect(keyTestToast(ok('invalid'))).toEqual({
      kind: 'success',
      text: 'Key works. Still dropped. Press Re-enable to use it. (412 ms)',
    });
  });

  it('says a dropped key that fails is still dropped, with its HTTP status and reason', () => {
    expect(keyTestToast(fail('invalid', 403, 'blocked'))).toEqual({
      kind: 'error',
      text: 'Still failing: HTTP 403 blocked. Still dropped.',
    });
  });

  it('keeps Still dropped as the last words of a long reason', () => {
    const long = 'x'.repeat(400);
    const { text } = keyTestToast(fail('invalid', 403, long));
    expect(text.endsWith('Still dropped.')).toBe(true);
    expect(text.startsWith('Still failing: HTTP 403 ')).toBe(true);
  });

  it('says a disabled key that works is still disabled and points at Enable', () => {
    expect(keyTestToast(ok('disabled'))).toEqual({
      kind: 'success',
      text: 'Key works. Still disabled. Press Enable to use it. (412 ms)',
    });
  });

  it('says a disabled key that fails is still disabled', () => {
    expect(keyTestToast(fail('disabled', 403, 'blocked'))).toEqual({
      kind: 'error',
      text: 'Still failing: HTTP 403 blocked. Still disabled.',
    });
  });

  it('uses the message when there is no HTTP status (a network error)', () => {
    expect(keyTestToast(fail('invalid', 0, undefined, 'network error: boom'))).toEqual({
      kind: 'error',
      text: 'Still failing: network error: boom. Still dropped.',
    });
  });

  it('uses plain action names in HTTP reasons and fallback messages', () => {
    const action = 'Drop key until I re-enable it';
    expect(keyTestToast(fail('invalid', 403, 'INVALID_KEY')).text).toBe(
      `Still failing: HTTP 403 ${action}. Still dropped.`,
    );
    expect(keyTestToast(fail('disabled', 0, undefined, 'INVALID_KEY')).text).toBe(
      `Still failing: ${action}. Still disabled.`,
    );
    expect(keyTestToast(fail('active', 0, undefined, 'INVALID_KEY')).text).toBe(`${action} (412 ms)`);
  });

  it('keeps the plain message for any other key status', () => {
    expect(keyTestToast(ok('active'))).toEqual({ kind: 'success', text: 'Key works (412 ms)' });
    expect(keyTestToast(fail('exhausted', 402, 'no credit', 'No balance'))).toEqual({
      kind: 'error',
      text: 'No balance (412 ms)',
    });
  });

  it('keeps the plain message when key_status is missing', () => {
    expect(keyTestToast({ ok: true, message: 'Key works', ms: 9, status: 200 })).toEqual({
      kind: 'success',
      text: 'Key works (9 ms)',
    });
  });
});

describe('plain action names in stored and test text (D-13)', () => {
  it('replaces a raw action name in a stored key reason', () => {
    expect(keyReasonLine(key({ status: 'invalid', status_reason: 'All failed (A/k: INVALID_KEY)' }))).toBe(
      'All failed (A/k: Drop key until I re-enable it)',
    );
  });

  it('replaces a raw action name in the Overview detail text', () => {
    const out = keyDetailText(key({ status: 'invalid', status_reason: 'EXHAUSTED on try', status_code: 403, status_changed_at: NOW - HOUR }));
    expect(out).toBe('HTTP 403 · Mark out of balance (auto-recheck) on try · dropped 1h ago');
    expect(out).not.toMatch(/EXHAUSTED/);
  });

  it('replaces a raw action name in a dropped key message line', () => {
    expect(keyDropLines(key({ status: 'invalid', status_reason: 'RATE_LIMITED', status_code: 429 })).message).toBe(
      'Pause key for N min',
    );
  });
});
