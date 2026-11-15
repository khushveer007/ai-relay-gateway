// Pure form model for the add-provider dialog. It has no imports at all and no DOM: the Worker
// tsconfig type-checks every file a test imports, and './api' needs DOM types the Worker lacks.

/** Canonical wire-format order. The payload always lists formats in this order (PRV-02 ordering). */
export const PROVIDER_FORMATS = ['anthropic', 'openai-chat', 'openai-responses'] as const;

/** Same union as `Format` in lib/api.ts, kept here so this file stays import-free. */
export type ProviderFormat = (typeof PROVIDER_FORMATS)[number];

export type KeyStrategy = 'sequential' | 'round_robin';
export type BalanceMode = 'standard' | 'custom' | 'none';
export type RecheckMode = 'auto' | 'balance' | 'manual';

/** Every field is a string or boolean while typing; numbers are converted in buildProviderPayload. */
export interface ProviderForm {
  name: string;
  base_url: string;
  keys: string;
  formats: ProviderFormat[];
  key_strategy: KeyStrategy;
  timeout_ms: string;
  model_map: string;
  model_allowlist: boolean;
  balance_mode: BalanceMode;
  balance_path: string;
  balance_field: string;
  balance_divisor: string;
  recheck_mode: RecheckMode;
  recheck_hours: string;
  test_model: string;
  extra_headers: string;
  parse_usage: boolean;
  enabled: boolean;
  add_to_default: boolean;
}

export type FormMode = 'create' | 'edit';

/** Defaults identical to the server defaults (providerColumns in the Worker). */
export function emptyProviderForm(): ProviderForm {
  return {
    name: '',
    base_url: '',
    keys: '',
    formats: [...PROVIDER_FORMATS],
    key_strategy: 'sequential',
    timeout_ms: '60000',
    model_map: '',
    model_allowlist: false,
    balance_mode: 'standard',
    balance_path: '',
    balance_field: '',
    balance_divisor: '1',
    recheck_mode: 'auto',
    recheck_hours: '6',
    test_model: '',
    extra_headers: '',
    parse_usage: true,
    enabled: true,
    add_to_default: true,
  };
}

/** Splits pasted keys exactly like the Worker does: any run of whitespace, commas or semicolons. */
export function splitKeys(text: string): string[] {
  return text
    .split(/[\s,;]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Parses a model map or header box. Text starting with `{` is a JSON object (a parse failure comes
 * back as an error, never a throw). Otherwise one `key=value` or `key:value` pair per line; `=` wins
 * when a line has both, so a header value or a model pattern may contain `:`. `#` lines and blank
 * lines are skipped.
 */
export function linesToMap(text: string): { map: Record<string, string>; error: string | null } {
  const trimmed = text.trim();
  if (!trimmed) return { map: {}, error: null };
  if (trimmed.startsWith('{')) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { map: {}, error: 'Enter a JSON object, or one key=value per line.' };
      }
      const map: Record<string, string> = {};
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        if (!k.trim()) continue;
        map[k.trim()] = String(v).trim();
      }
      return { map, error: null };
    } catch {
      return { map: {}, error: 'That JSON is not valid. Fix it or use one key=value per line.' };
    }
  }
  const map: Record<string, string> = {};
  for (const raw of trimmed.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    const idx = eq >= 0 ? eq : line.indexOf(':');
    if (idx <= 0) continue;
    const k = line.slice(0, idx).trim();
    const v = line.slice(idx + 1).trim();
    if (k) map[k] = v;
  }
  return { map, error: null };
}

/** True when `linesToMap` would read `key=value` back to exactly this pair. */
function lineSafe(k: string, v: string): boolean {
  return k !== '' && k === k.trim() && !/[=\n\r]/.test(k) && !/^[#{]/.test(k) && v === v.trim() && !/[\n\r]/.test(v);
}

/**
 * One `key=value` per line; the inverse of linesToMap. A pair the line form cannot carry (a key with
 * `=`, a value with a newline, a key starting with `#` or `{`) switches the whole box to JSON, which
 * linesToMap also reads, so loading a provider never changes what is saved back (PRV-03).
 */
export function mapToLines(map: Record<string, string>): string {
  const entries = Object.entries(map);
  if (!entries.every(([k, v]) => lineSafe(k, v))) return JSON.stringify(map, null, 2);
  return entries.map(([k, v]) => `${k}=${v}`).join('\n');
}

const orNull = (s: string): string | null => (s.trim() ? s.trim() : null);

/** A blank number box means "use the default"; anything else is converted as typed (validation catches NaN). */
const numOr = (text: string, fallback: number): number => (text.trim() === '' ? fallback : Number(text));

/**
 * The create and edit payload. Edit sends exactly the 17 editable fields and nothing else, custom balance
 * fields included even when the mode is not custom, so nothing hidden is wiped (D-15). Formats are sent in canonical order whatever order they were ticked in, blank
 * optional text sends null, blank maps send {}, and keys travel as the raw text the Worker splits.
 */
export function buildProviderPayload(form: ProviderForm, mode: FormMode): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    name: form.name.trim(),
    base_url: form.base_url.trim(),
    formats: PROVIDER_FORMATS.filter((f) => form.formats.includes(f)),
    key_strategy: form.key_strategy,
    timeout_ms: numOr(form.timeout_ms, 60000),
    model_map: linesToMap(form.model_map).map,
    model_allowlist: form.model_allowlist,
    balance_mode: form.balance_mode,
    balance_path: orNull(form.balance_path),
    balance_field: orNull(form.balance_field),
    balance_divisor: numOr(form.balance_divisor, 1),
    recheck_mode: form.recheck_mode,
    recheck_hours: numOr(form.recheck_hours, 6),
    test_model: orNull(form.test_model),
    extra_headers: linesToMap(form.extra_headers).map,
    parse_usage: form.parse_usage,
    enabled: form.enabled,
  };
  if (mode === 'create') {
    payload.keys = form.keys;
    payload.add_to_default = form.add_to_default;
  }
  return payload;
}

export type FormErrorKey = 'name' | 'base_url' | 'formats' | 'timeout_ms' | 'recheck_hours' | 'balance_divisor' | 'model_map' | 'extra_headers';
export type FormErrors = Partial<Record<FormErrorKey, string>>;

const URL_MESSAGE = 'Enter a full URL starting with http:// or https://.';

function isHttpUrl(raw: string): boolean {
  try {
    const u = new URL(raw.trim());
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

/** The editable fields of a provider as the dashboard loads them: the structural part of ProviderDTO. */
export interface ProviderDtoLike {
  name: string;
  base_url: string;
  formats: readonly ProviderFormat[];
  key_strategy: KeyStrategy;
  timeout_ms: number;
  model_map: Record<string, string>;
  model_allowlist: boolean;
  balance_mode: BalanceMode;
  balance_path: string | null;
  balance_field: string | null;
  balance_divisor: number;
  recheck_mode: RecheckMode;
  recheck_hours: number;
  test_model: string | null;
  extra_headers: Record<string, string>;
  parse_usage: boolean;
  enabled: boolean;
}

/**
 * The form an edit starts from: every loaded value, so saving only the basics sends the rest back
 * unchanged (PRV-03, D-15). Keys are never loaded (the browser never has them). A new column added to
 * ProviderDTO later must be added here, to buildProviderPayload and to the round-trip test.
 */
export function providerToForm(dto: ProviderDtoLike): ProviderForm {
  return {
    name: dto.name,
    base_url: dto.base_url,
    keys: '',
    formats: [...dto.formats],
    key_strategy: dto.key_strategy,
    timeout_ms: String(dto.timeout_ms),
    model_map: mapToLines(dto.model_map),
    model_allowlist: dto.model_allowlist,
    balance_mode: dto.balance_mode,
    balance_path: dto.balance_path ?? '',
    balance_field: dto.balance_field ?? '',
    balance_divisor: String(dto.balance_divisor),
    recheck_mode: dto.recheck_mode,
    recheck_hours: String(dto.recheck_hours),
    test_model: dto.test_model ?? '',
    extra_headers: mapToLines(dto.extra_headers),
    parse_usage: dto.parse_usage,
    enabled: dto.enabled,
    add_to_default: true,
  };
}

/** Field names that live inside the collapsed Advanced section; the dialog opens it for these. */
export const ADVANCED_FIELDS: readonly FormErrorKey[] = ['formats', 'timeout_ms', 'recheck_hours', 'balance_divisor', 'model_map', 'extra_headers'];

const inRange = (text: string, min: number, max: number): boolean => {
  if (text.trim() === '') return true; // blank means the default
  const n = Number(text);
  return Number.isFinite(n) && n >= min && n <= max;
};

/**
 * Inline errors, keyed by the field's name so the dialog can open Advanced and focus it. The ranges
 * mirror the Worker's for a quicker answer only; the Worker still validates every value.
 */
export function validateProviderForm(form: ProviderForm, _mode: FormMode): FormErrors {
  const errors: FormErrors = {};
  if (!form.name.trim()) errors.name = 'Enter a name.';
  if (!isHttpUrl(form.base_url)) errors.base_url = URL_MESSAGE;
  if (form.formats.length === 0) errors.formats = 'Pick at least one format.';
  if (!inRange(form.timeout_ms, 1000, 300000)) errors.timeout_ms = 'Enter a timeout between 1000 and 300000 ms.';
  if (!inRange(form.recheck_hours, 0.25, 720)) errors.recheck_hours = 'Enter hours between 0.25 and 720.';
  const divisor = form.balance_divisor.trim();
  if (divisor !== '' && !(Number.isFinite(Number(divisor)) && Number(divisor) > 0)) errors.balance_divisor = 'Enter a number above 0.';
  const mapError = linesToMap(form.model_map).error;
  if (mapError) errors.model_map = mapError;
  const headerError = linesToMap(form.extra_headers).error;
  if (headerError) errors.extra_headers = headerError;
  return errors;
}

/** The Worker's answer to POST /providers/test-connection. */
export interface TestResult {
  ok: boolean;
  count?: number;
  status?: number;
  message?: string;
  ms: number;
}

export interface TestState {
  /** Id of the latest start or reset; a settle only applies while it still matches. */
  id: number;
  status: 'idle' | 'running' | 'done';
  result: TestResult | null;
}

export type TestAction = { type: 'start'; id: number } | { type: 'settle'; id: number; result: TestResult } | { type: 'reset' };

export const initialTestState: TestState = { id: 0, status: 'idle', result: null };

/**
 * Keeps Test connection honest: a second start while one is running is ignored (one request), a
 * result whose id is stale is discarded, and reset (URL, headers or keys changed) invalidates a
 * running test so its late answer never shows against the new input.
 */
export function testReducer(state: TestState, action: TestAction): TestState {
  switch (action.type) {
    case 'start':
      return state.status === 'running' ? state : { id: action.id, status: 'running', result: null };
    case 'settle':
      return state.status === 'running' && action.id === state.id ? { id: state.id, status: 'done', result: action.result } : state;
    case 'reset':
      return { id: state.id + 1, status: 'idle', result: null };
  }
}

