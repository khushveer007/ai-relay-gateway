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

/** Pulls a short human-readable message out of an upstream error body. */
export function extractReason(body: string): string {
  const trimmed = body.trim();
  // SSE: take the first data line
  let candidate = trimmed;
  const dataIdx = trimmed.indexOf('data:');
  if (!trimmed.startsWith('{') && dataIdx >= 0) {
    candidate = trimmed.slice(dataIdx + 5).split('\n')[0].trim();
  }
  try {
    const j = JSON.parse(candidate) as Record<string, any>;
    const msg =
      j?.error?.message ?? j?.message ?? j?.error?.msg ?? j?.msg ?? (typeof j?.error === 'string' ? j.error : null) ?? j?.detail;
    if (msg) return String(msg).slice(0, 300);
  } catch {
    /* not JSON */
  }
  return trimmed.slice(0, 300) || 'empty response body';
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
  const reason = status === 0 ? body || 'network error' : extractReason(body);
  if (status === 0) return { action: 'UPSTREAM_ERROR', ruleId: null, cooldownS: null, reason };

  const sample = body.length > 16384 ? body.slice(0, 16384) : body;
  const retry = parseRetryAfter(retryAfter);

  // `rules` are pre-sorted: provider-specific first, then global; each by priority.
  for (const rule of rules) {
    if (!rule.enabled) continue;
    if (rule.provider_id !== null && rule.provider_id !== providerId) continue;
    // Rules with a status filter only apply to real HTTP error statuses, not to 2xx bodies.
    if (rule.status_codes.trim() !== '' && (status < 300 || !statusMatches(rule.status_codes, status))) continue;
    if (rule.body_regex) {
      const re = compile(rule.body_regex);
      if (!re || !re.test(sample)) continue;
    }
    const cooldownS = rule.action === 'RATE_LIMITED' ? (retry ?? rule.cooldown_s ?? 60) : null;
    return { action: rule.action, ruleId: rule.id, cooldownS, reason };
  }

  // Fallbacks when no rule matched.
  if (status === 429) return { action: 'RATE_LIMITED', ruleId: null, cooldownS: retry ?? 60, reason };
  if (status >= 400 && status < 500) return { action: 'CLIENT_ERROR', ruleId: null, cooldownS: null, reason };
  return { action: 'UPSTREAM_ERROR', ruleId: null, cooldownS: null, reason };
}
