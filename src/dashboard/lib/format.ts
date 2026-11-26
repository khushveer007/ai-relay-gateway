import type { MatchType } from '../../shared/pricing';

export const MATCH_LABEL: Record<MatchType, string> = {
  pinned: 'Pinned alias',
  exact: 'Exact match',
  normalized: 'Normalized match',
  ambiguous: 'Ambiguous match',
  none: 'No match',
};

export function fmtNum(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '0';
  return n.toLocaleString();
}

export function fmtTokens(n: number | null | undefined): string {
  const v = Number(n ?? 0);
  if (!v) return '0';
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(1)}k`;
  return String(v);
}

export function fmtTokensOrDash(n: number | null | undefined): string {
  if (n === null || n === undefined) return '—';
  return fmtTokens(n);
}

export function fmtBalance(b: number | null | undefined): string {
  if (b === null || b === undefined || !Number.isFinite(b)) return '—';
  return `$${b.toFixed(b < 1 && b > 0 ? 4 : 2)}`;
}

export function fmtRequestCost(cost: number | null | undefined, reason?: 'unpriced' | 'no_usage' | null): string {
  if (cost == null) {
    if (reason === 'unpriced') return 'Unpriced';
    if (reason === 'no_usage') return 'No usage reported';
    return 'Cost unavailable';
  }
  const scale = 1_000_000_000;
  const nanos = cost % scale;
  const dollars = (cost - nanos) / scale;
  const fraction = String(nanos).padStart(9, '0').replace(/0+$/, '').padEnd(2, '0');
  return `$${dollars}.${fraction}`;
}

export function fmtAgo(ts: number | null | undefined): string {
  if (!ts) return 'never';
  const diffS = Math.round((Date.now() - ts) / 1000);
  if (diffS < -5) {
    const remS = -diffS;
    if (remS < 60) return `in ${remS}s`;
    if (remS < 3600) return `in ${Math.round(remS / 60)}m`;
    return `in ${(remS / 3600).toFixed(1)}h`;
  }
  if (diffS < 5) return 'just now';
  if (diffS < 60) return `${diffS}s ago`;
  if (diffS < 3600) return `${Math.floor(diffS / 60)}m ago`;
  if (diffS < 86400) return `${Math.floor(diffS / 3600)}h ago`;
  return `${Math.floor(diffS / 86400)}d ago`;
}

export function fmtTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function fmtMs(v: number | null | undefined): string {
  if (!v) return '—';
  return `${v} ms`;
}

/**
 * The one place that names an action for the operator (DROP-08, D-11). Every screen that shows an
 * action calls this, so a raw code such as INVALID_KEY never reaches the screen. An unknown value comes
 * back unchanged. `opts.cooldownS` fills in the minutes for RATE_LIMITED.
 */
export function actionLabel(action: string, opts?: { cooldownS?: number | null }): string {
  switch (action) {
    case 'INVALID_KEY':
      return 'Drop key until I re-enable it';
    case 'RATE_LIMITED': {
      const s = opts?.cooldownS;
      return typeof s === 'number' && Number.isFinite(s) && s > 0 ? `Pause key for ${fmtCooldown(s)}` : 'Pause key for N min';
    }
    case 'EXHAUSTED':
      return 'Mark out of balance (auto-recheck)';
    case 'UPSTREAM_ERROR':
      return 'Try next provider';
    case 'CLIENT_ERROR':
      return 'Return error to client';
    case 'OK':
      return 'OK';
    default:
      return action;
  }
}

/** The "what happens to the key" caption for an action (D-11). Empty for an unknown action. */
export function actionConsequence(action: string): string {
  switch (action) {
    case 'INVALID_KEY':
      return 'Stays off. Requests and cron never use it until you press Re-enable.';
    case 'RATE_LIMITED':
      return 'Comes back by itself after that time, or after the time the provider asks for.';
    case 'EXHAUSTED':
      return "Rests, then is rechecked on the provider's recheck interval and comes back when it has balance.";
    case 'UPSTREAM_ERROR':
      return 'Not changed. The request moves on to the next provider.';
    case 'CLIENT_ERROR':
      return 'Not changed. The error goes back to the client, with no retry.';
    default:
      return '';
  }
}

/** The operator word for a key status (DROP-05). An unknown status comes back unchanged. */
export function keyStatusLabel(status: string): string {
  switch (status) {
    case 'active':
      return 'Active';
    case 'rate_limited':
      return 'Paused';
    case 'exhausted':
      return 'Out of balance';
    case 'invalid':
      return 'Dropped';
    case 'disabled':
      return 'Disabled';
    default:
      return status;
  }
}

/** The main and menu label that turns a non-active key back on (DROP-03): Re-enable for a dropped key. */
export function enableLabel(status: string): string {
  return status === 'invalid' ? 'Re-enable' : 'Enable';
}

/**
 * A cooldown in words: "59 s" under a minute, then minutes to one decimal with a trailing ".0" removed
 * ("1.5 min", "10 min"). A zero or negative value reads "0 s"; a non-finite value gives an empty string.
 */
export function fmtCooldown(seconds: number): string {
  if (!Number.isFinite(seconds)) return '';
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s} s`;
  return `${(s / 60).toFixed(1).replace(/\.0$/, '')} min`;
}

/**
 * Absolute local date and time, without a year: "18 Nov, 14:32". The locale is fixed to en-GB so the
 * shape does not change with the browser language. The time zone is the viewer's own.
 */
export function fmtDateTime(ts: number): string {
  return new Date(ts).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
}

const RAW_ACTION_CODE = /\b(INVALID_KEY|RATE_LIMITED|EXHAUSTED|UPSTREAM_ERROR|CLIENT_ERROR)\b/g;

/** Free text from a relay or a log line, with each whole-word raw action code replaced by its plain name (D-13). */
export function plainActionText(text: string): string {
  return text.replace(RAW_ACTION_CODE, (code) => actionLabel(code));
}
