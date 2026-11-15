// Pure settings and rule models: no imports, so Vitest and the Worker tsconfig can load them.
// RED stub: returns wrong values on purpose so the tests fail on their assertions.

export interface SettingsForm {
  max_attempts: string;
  log_retention_days: string;
  balance_refresh_hours: string;
}
export type SettingsErrors = Partial<Record<keyof SettingsForm, string>>;

export interface RuleForm {
  provider_id: string;
  priority: string;
  status_codes: string;
  action: string;
  cooldown_s: string;
  body_regex: string;
  note: string;
  enabled: boolean;
}
export type RuleErrors = Partial<Record<'status_codes' | 'priority' | 'cooldown_s' | 'rule', string>>;

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
}

export interface TesterForm {
  provider_id: string;
  status: string;
  retry_after: string;
  body: string;
}

export function settingsToForm(_dto: { max_attempts: number; log_retention_days: number; balance_refresh_hours: number }): SettingsForm {
  return { max_attempts: '', log_retention_days: '', balance_refresh_hours: '' };
}
export function validateSettings(_form: SettingsForm): SettingsErrors {
  return { max_attempts: 'stub' };
}
export function buildSettingsPayload(_form: SettingsForm): Record<string, number> {
  return {};
}
export function emptyRuleForm(_firstAction: string): RuleForm {
  return { provider_id: 'x', priority: '', status_codes: 'x', action: '', cooldown_s: '', body_regex: 'x', note: 'x', enabled: false };
}
export function ruleToForm(_dto: RuleDtoLike): RuleForm {
  return emptyRuleForm('');
}
export function validateRuleForm(_form: RuleForm): RuleErrors {
  return { rule: 'stub' };
}
export function buildRulePayload(_form: RuleForm): Record<string, unknown> {
  return {};
}
export function buildTesterPayload(_form: TesterForm): Record<string, unknown> {
  return {};
}
