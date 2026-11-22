// Pure status-code parser and risk helper shared by the Worker (drop-list validation) and the dashboard (the provider
// form and the Rules page). No imports and no DOM: the Worker tsconfig type-checks every file a test imports.

export type CodeError = 'unreadable' | 'out_of_range' | 'reversed';

export interface ParsedCodes {
  /** The normalized codes text, in the order typed. Empty when the input is blank or malformed. */
  codes: string;
  error: CodeError | null;
}

export interface CodeRisk {
  level: 'amber' | 'grey' | null;
  tokens: string[];
}

export const DROP_CODE_ERRORS: Record<CodeError, string> = {
  unreadable: 'Enter codes like 403, 418 or 500-503.',
  out_of_range: 'Use error codes from 400 to 599.',
  reversed: 'A range must go up, like 500-503.',
};

export const DROP_MESSAGE_NEEDS_CODES = 'Add a status code to use this message.';

const CODES_PATTERN = /^(\d{3}(-\d{3})?)(,\d{3}(-\d{3})?)*$/;
const RISKY_AMBER = [400, 404, 408, 413, 422, 429];
const RISKY_GREY = 403;
const DEFAULT_RANGE = { min: 400, max: 599 };

/** Trims, drops the spaces around commas and turns every other whitespace run into a comma. Nothing else changes. */
export function normalizeCodes(text: string): string {
  return text.trim().replace(/\s*,\s*/g, ',').replace(/\s+/g, ',');
}

/**
 * Validates typed status codes. Accepts single codes, ranges and any mix of commas and spaces. The result keeps the
 * typed order and keeps duplicates and overlaps: nothing is sorted or merged. A reversed range is checked before
 * the range bounds, so `503-500` is reversed, not out of range.
 */
export function parseStatusCodes(text: string, range: { min: number; max: number } = DEFAULT_RANGE): ParsedCodes {
  const normalized = normalizeCodes(text);
  if (normalized === '') return { codes: '', error: null };
  if (!CODES_PATTERN.test(normalized)) return { codes: '', error: 'unreadable' };
  for (const entry of normalized.split(',')) {
    const [loText, hiText] = entry.split('-');
    const lo = Number(loText);
    const hi = hiText === undefined ? lo : Number(hiText);
    if (lo > hi) return { codes: '', error: 'reversed' };
    if (lo < range.min || hi > range.max) return { codes: '', error: 'out_of_range' };
  }
  return { codes: normalized, error: null };
}

/** An entry is a three-digit code or a range whose low bound is not above its high bound. Junk returns null. */
function entryBounds(entry: string): { lo: number; hi: number } | null {
  if (/^\d{3}$/.test(entry)) {
    const n = Number(entry);
    return { lo: n, hi: n };
  }
  const m = /^(\d{3})-(\d{3})$/.exec(entry);
  if (!m) return null;
  const lo = Number(m[1]);
  const hi = Number(m[2]);
  return lo > hi ? null : { lo, hi };
}

/** True when an entry's code or range includes any of the given codes. */
function includesAny(bounds: { lo: number; hi: number }, codes: number[]): boolean {
  return codes.some((c) => c >= bounds.lo && c <= bounds.hi);
}

/**
 * The risk of a drop list (D-07, D-08). Amber codes are often temporary (400, 404, 408, 413, 422, 429 and 5xx), so
 * dropping on them can switch off a whole pool during an outage. Grey is 403, which can be a short block. Amber wins:
 * when any amber entry exists, the level is amber and only the amber entries are listed. Junk entries are ignored.
 */
export function codeRisk(text: string): CodeRisk {
  const amber: string[] = [];
  const grey: string[] = [];
  for (const entry of normalizeCodes(text).split(',')) {
    const bounds = entryBounds(entry);
    if (!bounds) continue;
    if (includesAny(bounds, RISKY_AMBER) || overlaps5xx(bounds)) {
      amber.push(entry);
    } else if (includesAny(bounds, [RISKY_GREY])) {
      grey.push(entry);
    }
  }
  if (amber.length) return { level: 'amber', tokens: amber };
  if (grey.length) return { level: 'grey', tokens: grey };
  return { level: null, tokens: [] };
}

/** True when an entry's range reaches into the 500 to 599 band at all. */
function overlaps5xx(bounds: { lo: number; hi: number }): boolean {
  return bounds.lo <= 599 && bounds.hi >= 500;
}

/** The first `max` tokens joined with commas, then " and {n} more" when there are more. */
export function formatRiskTokens(tokens: string[], max = 4): string {
  const shown = tokens.slice(0, max).join(', ');
  const more = tokens.length - max;
  return more > 0 ? `${shown} and ${more} more` : shown;
}

/** The one place that words the risk note, so the Rules page and the provider form show the same text (D-09). */
export function riskNoteText(risk: CodeRisk): string | null {
  if (risk.level === 'amber') {
    return `Risky: ${formatRiskTokens(risk.tokens)}. Often temporary, so dropping a key on this can switch off every key during an outage.`;
  }
  if (risk.level === 'grey') {
    return '403 can be a short block rather than a bad key. Dropping on it keeps the key off until you re-enable it.';
  }
  return null;
}
