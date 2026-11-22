import type { Action, ErrorRule } from '../types';

export interface Classification {
  action: Action;
  ruleId: number | null;
  cooldownS: number | null;
  reason: string;
}

/** "402", "401,403", "500-599", "" (any). */
export function statusMatches(spec: string, status: number): boolean {
  const s = spec.trim();
  if (s === '' || s === '*') return true;
  for (const part of s.split(',')) {
    const p = part.trim();
    if (!p) continue;
    const dash = p.indexOf('-');
    if (dash > 0) {
      const lo = Number(p.slice(0, dash));
      const hi = Number(p.slice(dash + 1));
      if (status >= lo && status <= hi) return true;
    } else if (Number(p) === status) {
      return true;
    }
  }
  return false;
}

const regexCache = new Map<string, RegExp | null>();

function compile(src: string): RegExp | null {
  if (regexCache.has(src)) return regexCache.get(src)!;
  let re: RegExp | null = null;
  try {
    re = new RegExp(src, 'i');
  } catch {
    re = null; // invalid user regex → rule is ignored
  }
  if (regexCache.size > 200) regexCache.clear();
  regexCache.set(src, re);
  return re;
}

export function validateRegex(src: string): string | null {
  try {
    new RegExp(src, 'i');
    return null;
  } catch (e) {
    return (e as Error).message;
  }
}

function readErrorText(body: string): { message: string; reason: string } {
  const trimmed = body.trim();
  // SSE: take the first data line
  const candidate = trimmed.startsWith('{') ? trimmed : /^data:(.*)$/m.exec(trimmed)?.[1] ?? trimmed;
  try {
    const j = JSON.parse(candidate) as Record<string, any>;
    const msg =
      j?.error?.message ?? j?.message ?? j?.error?.msg ?? j?.msg ?? (typeof j?.error === 'string' ? j.error : null) ?? j?.detail;
    return {
      message: typeof j === 'string' ? j : typeof msg === 'string' ? msg : '',
      reason: typeof msg === 'string' && msg ? msg : trimmed,
    };
  } catch {
    /* not JSON */
  }
  return { message: body, reason: trimmed };
}

export function parseRetryAfter(value: string | null | undefined, now = Date.now()): number | null {
  if (!value) return null;
  const secs = Number(value);
  if (Number.isFinite(secs)) return Math.max(1, Math.ceil(secs));
  const date = Date.parse(value);
  if (!Number.isNaN(date)) return Math.max(1, Math.ceil((date - now) / 1000));
  return null;
}

/**
 * Classifies an upstream failure.
 * @param status HTTP status; 0 = network error / timeout; 200 = error found inside a 2xx body or stream
 */
export function classify(
  rules: ErrorRule[],
  providerId: number,
  status: number,
  body: string,
  retryAfter?: string | null,
): Classification {
  if (status === 0) return { action: 'UPSTREAM_ERROR', ruleId: null, cooldownS: null, reason: body || 'network error' };

  const error = readErrorText(body);
  const reason = error.reason.slice(0, 300) || 'empty response body';
  const maxMatchLength = 16384;
  const sample = body.slice(0, maxMatchLength);
  const messageSample = error.message.slice(0, maxMatchLength);
  const retry = parseRetryAfter(retryAfter);

  // `rules` are pre-sorted: provider-specific first, then global; each by priority.
  for (const rule of rules) {
    if (!rule.enabled) continue;
    if (rule.provider_id !== null && rule.provider_id !== providerId) continue;
    // Rules with a status filter only apply to real HTTP error statuses, not to 2xx bodies.
    if (rule.status_codes.trim() !== '' && (status < 300 || !statusMatches(rule.status_codes, status))) continue;
    if (rule.body_regex) {
      const re = compile(rule.body_regex);
      const matchText = rule.origin === 'drop_list' ? messageSample : sample;
      if (!re || !re.test(matchText)) continue;
    }
    const cooldownS = rule.action === 'RATE_LIMITED' ? (retry ?? rule.cooldown_s ?? 60) : null;
    return { action: rule.action, ruleId: rule.id, cooldownS, reason };
  }

  // Fallbacks when no rule matched.
  if (status === 429) return { action: 'RATE_LIMITED', ruleId: null, cooldownS: retry ?? 60, reason };
  if (status >= 400 && status < 500) return { action: 'CLIENT_ERROR', ruleId: null, cooldownS: null, reason };
  return { action: 'UPSTREAM_ERROR', ruleId: null, cooldownS: null, reason };
}
