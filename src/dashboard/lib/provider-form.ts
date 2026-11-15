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

/** One `key=value` per line; the inverse of linesToMap for the `=` form. */
export function mapToLines(map: Record<string, string>): string {
  return Object.entries(map)
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
}

const orNull = (s: string): string | null => (s.trim() ? s.trim() : null);

/**
 * The create payload. Formats are sent in canonical order whatever order they were ticked in, blank
 * optional text sends null, blank maps send {}, and keys travel as the raw text the Worker splits.
 */
export function buildProviderPayload(form: ProviderForm, mode: FormMode): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    name: form.name.trim(),
    base_url: form.base_url.trim(),
    formats: PROVIDER_FORMATS.filter((f) => form.formats.includes(f)),
    key_strategy: form.key_strategy,
    timeout_ms: Number(form.timeout_ms),
    model_map: linesToMap(form.model_map).map,
    model_allowlist: form.model_allowlist,
    balance_mode: form.balance_mode,
    balance_path: orNull(form.balance_path),
    balance_field: orNull(form.balance_field),
    balance_divisor: Number(form.balance_divisor),
    recheck_mode: form.recheck_mode,
    recheck_hours: Number(form.recheck_hours),
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
