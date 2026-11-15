import { describe, expect, it } from 'vitest';
import {
  buildRulePayload,
  buildSettingsPayload,
  buildTesterPayload,
  emptyRuleForm,
  ruleToForm,
  settingsToForm,
  validateRuleForm,
  validateSettings,
  validateTester,
  type RuleForm,
} from '../src/dashboard/lib/rule-form';

// One line per value so a failing assertion prints on a single line (keeps a TDD RED report valid TAP).
const j = (v: unknown): string => JSON.stringify(v).replace(/"/g, "'");

const settings = (attempts: string, retention: string, hours: string) => ({
  max_attempts: attempts,
  log_retention_days: retention,
  balance_refresh_hours: hours,
});

describe('validateSettings (VIEW-06 boundary and precision)', () => {
  it('accepts max attempts 1 and 40, retention 1 and 90, hours 0.5 and 168, and 1.25 hours', () => {
    expect(j(validateSettings(settings('1', '1', '0.5')))).toBe(j({}));
    expect(j(validateSettings(settings('40', '90', '168')))).toBe(j({}));
    expect(j(validateSettings(settings('10', '7', '1.25')))).toBe(j({}));
  });

  it('rejects max attempts 0, 41 and 2.5 with the allowed range', () => {
    for (const v of ['0', '41', '2.5']) {
      expect(validateSettings(settings(v, '7', '6')).max_attempts).toBe('Enter a whole number from 1 to 40.');
    }
  });

  it('rejects retention 0, 91 and 1.5 with the allowed range', () => {
    for (const v of ['0', '91', '1.5']) {
      expect(validateSettings(settings('10', v, '6')).log_retention_days).toBe('Enter a whole number from 1 to 90.');
    }
  });

  it('rejects balance hours 0.4 and 168.1 with the allowed range', () => {
    for (const v of ['0.4', '168.1']) {
      expect(validateSettings(settings('10', '7', v)).balance_refresh_hours).toBe('Enter a number from 0.5 to 168.');
    }
  });

  it('rejects blank and non-numeric values', () => {
    const errors = validateSettings(settings('', '  ', 'abc'));
    expect(errors.max_attempts).toBe('Enter a whole number from 1 to 40.');
    expect(errors.log_retention_days).toBe('Enter a whole number from 1 to 90.');
    expect(errors.balance_refresh_hours).toBe('Enter a number from 0.5 to 168.');
  });
});

describe('settings payload', () => {
  it('sends numbers and does not round the hours', () => {
    expect(j(buildSettingsPayload(settings('12', '30', '1.25')))).toBe(j({ max_attempts: 12, log_retention_days: 30, balance_refresh_hours: 1.25 }));
  });

  it('opens pre-filled from the saved settings', () => {
    expect(j(settingsToForm({ max_attempts: 10, log_retention_days: 7, balance_refresh_hours: 6.5 }))).toBe(j(settings('10', '7', '6.5')));
  });
});

const form = (changes: Partial<RuleForm> = {}): RuleForm => ({ ...emptyRuleForm('EXHAUSTED'), ...changes });

describe('emptyRuleForm', () => {
  it('opens with priority 25, enabled on, cooldown 60 and the first action', () => {
    const f = emptyRuleForm('INVALID_KEY');
    expect(j([f.priority, f.enabled, f.cooldown_s, f.action, f.provider_id, f.status_codes, f.body_regex, f.note])).toBe(
      j(['25', true, '60', 'INVALID_KEY', '', '', '', '']),
    );
  });
});

describe('validateRuleForm', () => {
  it('needs a status filter, a body regex or both', () => {
    expect(validateRuleForm(form()).rule).toBe('Add a status code, a body regex, or both.');
    expect(validateRuleForm(form({ status_codes: '  ', body_regex: '  ' })).rule).toBe('Add a status code, a body regex, or both.');
    expect(validateRuleForm(form({ status_codes: '402' })).rule).toBeUndefined();
    expect(validateRuleForm(form({ body_regex: 'quota' })).rule).toBeUndefined();
  });

  it('checks status codes after removing spaces', () => {
    for (const ok of ['402', '401,403', '500-599', ' 401 , 403 ']) {
      expect(validateRuleForm(form({ status_codes: ok })).status_codes).toBeUndefined();
    }
    for (const bad of ['40', '4xx', '402,', '500-59']) {
      expect(validateRuleForm(form({ status_codes: bad })).status_codes).toBe('Use a code like 402, 401,403 or 500-599.');
    }
  });

  it('checks the priority range', () => {
    for (const bad of ['-1', '100001', '', 'x']) {
      expect(validateRuleForm(form({ status_codes: '402', priority: bad })).priority).toBe('Enter a priority from 0 to 100000.');
    }
    for (const ok of ['0', '100000', '25']) {
      expect(validateRuleForm(form({ status_codes: '402', priority: ok })).priority).toBeUndefined();
    }
  });

  it('checks the cooldown only for RATE_LIMITED', () => {
    const limited = form({ status_codes: '429', action: 'RATE_LIMITED' });
    for (const bad of ['0', '604801', '', 'x']) {
      expect(validateRuleForm({ ...limited, cooldown_s: bad }).cooldown_s).toBe('Enter seconds from 1 to 604800.');
    }
    expect(validateRuleForm({ ...limited, cooldown_s: '604800' }).cooldown_s).toBeUndefined();
    expect(validateRuleForm(form({ status_codes: '402', action: 'EXHAUSTED', cooldown_s: '0' })).cooldown_s).toBeUndefined();
  });
});

describe('buildRulePayload', () => {
  it('global scope sends provider_id null and a provider scope sends its number', () => {
    expect(buildRulePayload(form({ status_codes: '402' })).provider_id).toBeNull();
    expect(buildRulePayload(form({ status_codes: '402', provider_id: '4' })).provider_id).toBe(4);
  });

  it('sends cooldown_s only for RATE_LIMITED', () => {
    expect('cooldown_s' in buildRulePayload(form({ status_codes: '402', action: 'EXHAUSTED' }))).toBe(false);
    expect(buildRulePayload(form({ status_codes: '429', action: 'RATE_LIMITED', cooldown_s: '90' })).cooldown_s).toBe(90);
  });

  it('blank regex and note send null and status codes are sent without spaces', () => {
    const p = buildRulePayload(form({ status_codes: ' 401 , 403 ', body_regex: '  ', note: '' }));
    expect(j([p.status_codes, p.body_regex, p.note])).toBe(j(['401,403', null, null]));
  });

  it('sends the typed priority, action and enabled flag', () => {
    const p = buildRulePayload(form({ status_codes: '402', priority: '7', action: 'INVALID_KEY', enabled: false, body_regex: 'quota', note: 'why' }));
    expect(j([p.priority, p.action, p.enabled, p.body_regex, p.note])).toBe(j([7, 'INVALID_KEY', false, 'quota', 'why']));
  });
});

describe('ruleToForm', () => {
  it('loads every value of a saved rule back into the form', () => {
    const f = ruleToForm({
      id: 3,
      provider_id: 5,
      priority: 12,
      status_codes: '402',
      body_regex: 'quota',
      action: 'RATE_LIMITED',
      cooldown_s: 45,
      note: 'n',
      enabled: false,
    });
    expect(j(f)).toBe(
      j({ provider_id: '5', priority: '12', status_codes: '402', action: 'RATE_LIMITED', cooldown_s: '45', body_regex: 'quota', note: 'n', enabled: false }),
    );
  });

  it('uses the defaults for a rule with no cooldown, regex or note', () => {
    const f = ruleToForm({ id: 1, provider_id: null, priority: 25, status_codes: '', body_regex: null, action: 'EXHAUSTED', cooldown_s: null, note: null, enabled: true });
    expect(j([f.provider_id, f.cooldown_s, f.body_regex, f.note, f.status_codes])).toBe(j(['', '60', '', '', '']));
  });
});

describe('buildTesterPayload', () => {
  it('sends provider_id 0 for global scope, a numeric status and null for a blank Retry-After', () => {
    const p = buildTesterPayload({ provider_id: '', status: '429', retry_after: '', body: '{"a":1}' });
    expect(j(p)).toBe(j({ provider_id: 0, status: 429, retry_after: null, body: '{"a":1}' }));
  });

  it('sends a provider scope, the Retry-After text and the body as typed', () => {
    const p = buildTesterPayload({ provider_id: '4', status: '402', retry_after: '30', body: '' });
    expect(j(p)).toBe(j({ provider_id: 4, status: 402, retry_after: '30', body: '' }));
  });
});

describe('validateTester', () => {
  it('accepts integer HTTP statuses from 100 to 599 and rejects blank, non-numeric or out-of-range values', () => {
    expect(validateTester({ provider_id: '', status: '100', retry_after: '', body: '' }).status).toBeUndefined();
    expect(validateTester({ provider_id: '', status: '599', retry_after: '', body: '' }).status).toBeUndefined();
    for (const bad of ['', '  ', '4O3', '99', '600', '429.5']) {
      expect(validateTester({ provider_id: '', status: bad, retry_after: '', body: '' }).status).toBe('Enter a status from 100 to 599.');
    }
  });
});
