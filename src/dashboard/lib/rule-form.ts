import { actionLabel } from './format';
import { STATUS_CODES_LENGTH_ERROR, STATUS_CODES_MAX_CHARS, parseStatusCodes } from './status-codes';

// Pure settings and rule models shared with the tests.
// The ranges mirror the Worker (PUT /settings, ruleInput) for UX only; the Worker still validates.

export interface SettingsForm {
  max_attempts: string;
  log_retention_days: string;
  balance_refresh_hours: string;
}
export type SettingsErrors = Partial<Record<keyof SettingsForm, string>>;

export interface RuleForm {
  /** '' is the global scope. */
  provider_id: string;
  priority: string;
  status_codes: string;
  action: string;
  cooldown_s: string;
  body_regex: string;
  note: string;
  enabled: boolean;
}
/** `rule` is the form-level message for a rule with neither a status filter nor a regex. */
export type RuleErrors = Partial<Record<'status_codes' | 'priority' | 'cooldown_s' | 'rule', string>>;

/** The fields of ErrorRuleDTO this model reads (structural, so no import is needed). */
export interface RuleDtoLike {
  id: number;
  provider_id: number | null;
  priority: number;
  status_codes: string;
  body_regex: string | null;
  action: string;
  cooldown_s: number | null;
  note: string | null;
  enabled: boolean;
  origin?: 'rule' | 'drop_list';
}

export interface TesterForm {
  /** '' is the all-provider scope. */
  provider_id: string;
  status: string;
  retry_after: string;
  body: string;
}

/** A strict number from text: blank or non-numeric is NaN (Number('') would be 0). */
function parseNumber(text: string): number {
  const t = text.trim();
  return t === '' ? Number.NaN : Number(t);
}

function wholeInRange(text: string, min: number, max: number): boolean {
  const n = parseNumber(text);
  return Number.isInteger(n) && n >= min && n <= max;
}

// ---------------------------------------------------------------- settings

export function settingsToForm(dto: { max_attempts: number; log_retention_days: number; balance_refresh_hours: number }): SettingsForm {
  return {
    max_attempts: String(dto.max_attempts),
    log_retention_days: String(dto.log_retention_days),
    balance_refresh_hours: String(dto.balance_refresh_hours),
  };
}

/** Max attempts and retention are whole numbers; balance hours may be a decimal. Each message names its range. */
export function validateSettings(form: SettingsForm): SettingsErrors {
  const errors: SettingsErrors = {};
  if (!wholeInRange(form.max_attempts, 1, 40)) errors.max_attempts = 'Enter a whole number from 1 to 40.';
  if (!wholeInRange(form.log_retention_days, 1, 90)) errors.log_retention_days = 'Enter a whole number from 1 to 90.';
  const hours = parseNumber(form.balance_refresh_hours);
  if (!(Number.isFinite(hours) && hours >= 0.5 && hours <= 168)) errors.balance_refresh_hours = 'Enter a number from 0.5 to 168.';
  return errors;
}

/** Numbers as typed; the hours are never rounded (the Worker keeps decimals for them and rounds the other two). */
export function buildSettingsPayload(form: SettingsForm): Record<string, number> {
  return {
    max_attempts: parseNumber(form.max_attempts),
    log_retention_days: parseNumber(form.log_retention_days),
    balance_refresh_hours: parseNumber(form.balance_refresh_hours),
  };
}

// ---------------------------------------------------------------- error rules

const RULE_CODE_RANGE = { min: 100, max: 999 };

type NamedProvider = { id: number; name: string };

function ruleScope(providerId: number | null, providers: readonly NamedProvider[]): string {
  if (providerId === null) return 'All providers';
  return providers.find((provider) => provider.id === providerId)?.name ?? `Provider #${providerId}`;
}

export function ruleSentence(
  rule: Pick<RuleDtoLike, 'provider_id' | 'origin' | 'status_codes' | 'action' | 'cooldown_s' | 'body_regex' | 'note'>,
  providers: readonly NamedProvider[],
) {
  const provider = ruleScope(rule.provider_id, providers);
  const dropList = rule.origin === 'drop_list';
  const status = rule.status_codes || 'any status';
  const action = actionLabel(rule.action, { cooldownS: rule.cooldown_s });
  const pauseSuffix = rule.action === 'RATE_LIMITED' ? ', then use it again' : '';

  return {
    scope: dropList ? `From ${provider}'s drop list` : provider,
    sentence: `On ${status} → ${action}${pauseSuffix}`,
    message: dropList
      ? (rule.note ? `Message contains: ${rule.note}` : null)
      : (rule.body_regex ? `Message matches: ${rule.body_regex}` : null),
    note: dropList ? null : rule.note,
  };
}

export function ruleMatchLabel(
  ruleId: number | null,
  rules: readonly Pick<RuleDtoLike, 'id' | 'origin' | 'provider_id'>[],
  providers: readonly NamedProvider[],
): string {
  if (ruleId === null) return 'fallback rule';
  const rule = rules.find((r) => r.id === ruleId);
  return rule?.origin === 'drop_list'
    ? `matched ${ruleScope(rule.provider_id, providers)}'s drop list`
    : `matched rule #${ruleId}`;
}

export function emptyRuleForm(firstAction: string): RuleForm {
  return { provider_id: '', priority: '25', status_codes: '', action: firstAction, cooldown_s: '60', body_regex: '', note: '', enabled: true };
}

export function ruleToForm(dto: RuleDtoLike): RuleForm {
  return {
    provider_id: dto.provider_id === null ? '' : String(dto.provider_id),
    priority: String(dto.priority),
    status_codes: dto.status_codes,
    action: dto.action,
    cooldown_s: dto.cooldown_s === null ? '60' : String(dto.cooldown_s),
    body_regex: dto.body_regex ?? '',
    note: dto.note ?? '',
    enabled: dto.enabled,
  };
}

export function validateRuleForm(form: RuleForm): RuleErrors {
  const errors: RuleErrors = {};
  const { codes, error } = parseStatusCodes(form.status_codes, RULE_CODE_RANGE);
  if (error) errors.status_codes = 'Use a code like 402, 401,403 or 500-599.';
  else if (codes.length > STATUS_CODES_MAX_CHARS) errors.status_codes = STATUS_CODES_LENGTH_ERROR;
  else if (!codes && !form.body_regex.trim()) errors.rule = 'Add a status code, a body regex, or both.';
  if (!wholeInRange(form.priority, 0, 100000)) errors.priority = 'Enter a priority from 0 to 100000.';
  if (form.action === 'RATE_LIMITED' && !wholeInRange(form.cooldown_s, 1, 604800)) errors.cooldown_s = 'Enter seconds from 1 to 604800.';
  return errors;
}

/** The POST/PUT /rules body. Cooldown only exists for RATE_LIMITED; blank regex and note are null. */
export function buildRulePayload(form: RuleForm): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    provider_id: form.provider_id ? Number(form.provider_id) : null,
    priority: parseNumber(form.priority),
    status_codes: parseStatusCodes(form.status_codes, RULE_CODE_RANGE).codes,
    action: form.action,
    body_regex: form.body_regex.trim() ? form.body_regex.trim() : null,
    note: form.note.trim() ? form.note.trim() : null,
    enabled: form.enabled,
  };
  if (form.action === 'RATE_LIMITED') payload.cooldown_s = parseNumber(form.cooldown_s);
  return payload;
}

/** The POST /rules/test body: provider_id 0 is "global rules only", a blank Retry-After is null, the body is as typed. */
export function buildTesterPayload(form: TesterForm): Record<string, unknown> {
  return {
    provider_id: form.provider_id ? Number(form.provider_id) : 0,
    status: parseNumber(form.status),
    retry_after: form.retry_after.trim() ? form.retry_after.trim() : null,
    body: form.body,
  };
}

/** Strict 3-digit HTTP status validation so blank or non-numeric input cannot silently fall back to 200. */
export function validateTester(form: TesterForm): { status?: string } {
  return wholeInRange(form.status, 100, 599) ? {} : { status: 'Enter a status from 100 to 599.' };
}
