import { describe, expect, it } from 'vitest';
import type { ProviderDTO } from '../src/dashboard/lib/api';
import {
  PROVIDER_FORMATS,
  buildProviderPayload,
  emptyProviderForm,
  initialTestState,
  linesToMap,
  mapToLines,
  providerToForm,
  splitKeys,
  testReducer,
  validateProviderForm,
  type TestResult,
} from '../src/dashboard/lib/provider-form';

const OK: TestResult = { ok: true, count: 2, ms: 40 };

describe('splitKeys (PRV-01)', () => {
  it('returns an empty list for empty, whitespace, comma and semicolon input', () => {
    expect(splitKeys('')).toEqual([]);
    expect(splitKeys('   ')).toEqual([]);
    expect(splitKeys(' , ;\n')).toEqual([]);
  });

  it('splits on CRLF, tabs, no-break spaces, commas and semicolons exactly like the server regex', () => {
    const text = 'sk-a\r\nsk-b sk-c;sk-d,sk-e\tsk-f';
    expect(splitKeys(text)).toEqual(['sk-a', 'sk-b', 'sk-c', 'sk-d', 'sk-e', 'sk-f']);
    expect(splitKeys('sk-a sk-b')).toEqual(text.length ? 'sk-a sk-b'.split(/[\s,;]+/).filter(Boolean) : []);
  });
});

describe('buildProviderPayload (PRV-01, PRV-02)', () => {
  it('a form with only name, URL and keys filled sends the server defaults', () => {
    const form = { ...emptyProviderForm(), name: ' Relay A ', base_url: 'https://r.test', keys: 'sk-1' };
    expect(buildProviderPayload(form, 'create')).toEqual({
      name: 'Relay A',
      base_url: 'https://r.test',
      keys: 'sk-1',
      add_to_default: true,
      formats: ['anthropic', 'openai-chat', 'openai-responses'],
      key_strategy: 'sequential',
      timeout_ms: 60000,
      model_map: {},
      model_allowlist: false,
      balance_mode: 'standard',
      balance_path: null,
      balance_field: null,
      balance_divisor: 1,
      recheck_mode: 'auto',
      recheck_hours: 6,
      test_model: null,
      extra_headers: {},
      parse_usage: true,
      enabled: true,
    });
  });

  it('a create with no keys sends an empty keys string', () => {
    expect(buildProviderPayload(emptyProviderForm(), 'create').keys).toBe('');
  });

  it('sends formats in canonical order whatever order they were ticked in', () => {
    const form = { ...emptyProviderForm(), formats: ['openai-responses', 'anthropic', 'openai-chat'] as const };
    expect(buildProviderPayload({ ...form, formats: [...form.formats] }, 'create').formats).toEqual([...PROVIDER_FORMATS]);
  });

  it('blank optional text sends null and blank maps send {}', () => {
    const p = buildProviderPayload({ ...emptyProviderForm(), balance_path: '  ', balance_field: '', test_model: ' ' }, 'create');
    expect(p.balance_path).toBeNull();
    expect(p.balance_field).toBeNull();
    expect(p.test_model).toBeNull();
    expect(p.model_map).toEqual({});
    expect(p.extra_headers).toEqual({});
  });
});

describe('linesToMap / mapToLines', () => {
  it('parses a JSON object', () => {
    expect(linesToMap('{"a":"b"}')).toEqual({ map: { a: 'b' }, error: null });
  });

  it('returns an error and an empty map for broken JSON instead of throwing', () => {
    const r = linesToMap('{"a":');
    expect(r.map).toEqual({});
    expect(r.error).toBeTruthy();
  });

  it('accepts a=b and a:b, and splits on = when a line has both', () => {
    expect(linesToMap('a=b').map).toEqual({ a: 'b' });
    expect(linesToMap('a:b').map).toEqual({ a: 'b' });
    expect(linesToMap('a:b=c').map).toEqual({ 'a:b': 'c' });
  });

  it('keeps = inside a header value and : inside a model id', () => {
    expect(linesToMap('X-Test=a=b').map).toEqual({ 'X-Test': 'a=b' });
    expect(linesToMap('claude-*=anthropic/claude:beta').map).toEqual({ 'claude-*': 'anthropic/claude:beta' });
  });

  it('skips # comment lines and blank lines', () => {
    expect(linesToMap('# note\n\na=b\n  \n# more\nc=d').map).toEqual({ a: 'b', c: 'd' });
  });

  it('round-trips through mapToLines', () => {
    const map = { 'X-One': '1', 'X-Two': 'a=b' };
    expect(linesToMap(mapToLines(map)).map).toEqual(map);
  });
});

describe('validateProviderForm', () => {
  it('asks for a name', () => {
    const errors = validateProviderForm({ ...emptyProviderForm(), base_url: 'https://r.test' }, 'create');
    expect(errors.name).toBe('Enter a name.');
    expect(errors.base_url).toBeUndefined();
  });

  it('asks for a full http(s) URL when empty or not http(s)', () => {
    const msg = 'Enter a full URL starting with http:// or https://.';
    expect(validateProviderForm({ ...emptyProviderForm(), name: 'A' }, 'create').base_url).toBe(msg);
    expect(validateProviderForm({ ...emptyProviderForm(), name: 'A', base_url: 'ftp://x' }, 'create').base_url).toBe(msg);
    expect(validateProviderForm({ ...emptyProviderForm(), name: 'A', base_url: 'not a url' }, 'create').base_url).toBe(msg);
  });

  it('gives no errors for a valid form', () => {
    expect(validateProviderForm({ ...emptyProviderForm(), name: 'A', base_url: 'https://r.test' }, 'create')).toEqual({});
  });
});

describe('testReducer (PRV-04 concurrency)', () => {
  it('start sets running with the new id and clears any result', () => {
    const s = testReducer(initialTestState, { type: 'start', id: 1 });
    expect(s).toEqual({ id: 1, status: 'running', result: null });
  });

  it('settle with the current id stores the result', () => {
    const running = testReducer(initialTestState, { type: 'start', id: 1 });
    expect(testReducer(running, { type: 'settle', id: 1, result: OK })).toEqual({ id: 1, status: 'done', result: OK });
  });

  it('settle with a stale id is ignored', () => {
    const running = testReducer(initialTestState, { type: 'start', id: 2 });
    expect(testReducer(running, { type: 'settle', id: 1, result: OK })).toBe(running);
  });

  it('reset invalidates a running test, so its later settle is ignored', () => {
    const running = testReducer(initialTestState, { type: 'start', id: 1 });
    const reset = testReducer(running, { type: 'reset' });
    expect(reset.status).toBe('idle');
    expect(reset.id).toBeGreaterThan(1);
    expect(testReducer(reset, { type: 'settle', id: 1, result: OK })).toBe(reset);
  });

  it('pressing Test twice runs one request: a second start while running is ignored', () => {
    const running = testReducer(initialTestState, { type: 'start', id: 1 });
    expect(testReducer(running, { type: 'start', id: 2 })).toBe(running);
  });

  it('a new start after a finished test clears the old result', () => {
    const done = testReducer(testReducer(initialTestState, { type: 'start', id: 1 }), { type: 'settle', id: 1, result: OK });
    expect(testReducer(done, { type: 'start', id: 2 })).toEqual({ id: 2, status: 'running', result: null });
  });
});

// A provider whose Advanced values are all away from the defaults, so a form that forgets a field
// (or a payload that drops one) changes something the test can see (PRV-03).
const NON_DEFAULT: ProviderDTO = {
  id: 7,
  name: 'Relay B',
  base_url: 'https://relay.example.com',
  formats: ['openai-chat'],
  key_strategy: 'round_robin',
  model_map: { 'claude-3-7-sonnet-*': 'claude-3-7-sonnet-20250219' },
  models: ['m1'],
  models_fetched_at: 1,
  model_allowlist: true,
  balance_mode: 'custom',
  balance_path: '/api/usage/token',
  balance_field: 'data.total_available',
  balance_divisor: 500000,
  recheck_mode: 'balance',
  recheck_hours: 12,
  test_model: 'gpt-4o-mini',
  parse_usage: false,
  timeout_ms: 45000,
  extra_headers: { 'HTTP-Referer': 'https://example.com', 'X-Title': 'Gateway' },
  enabled: false,
  created_at: 1,
  keys: [],
  routes: [],
};

// One line per value, so a failing assertion prints on a single line (and the TDD RED report stays valid TAP).
const canon = (o: object): string => JSON.stringify(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : 1)));

function editableFields(dto: ProviderDTO) {
  return {
    name: dto.name,
    base_url: dto.base_url,
    formats: dto.formats,
    key_strategy: dto.key_strategy,
    timeout_ms: dto.timeout_ms,
    model_map: dto.model_map,
    model_allowlist: dto.model_allowlist,
    balance_mode: dto.balance_mode,
    balance_path: dto.balance_path,
    balance_field: dto.balance_field,
    balance_divisor: dto.balance_divisor,
    recheck_mode: dto.recheck_mode,
    recheck_hours: dto.recheck_hours,
    test_model: dto.test_model,
    extra_headers: dto.extra_headers,
    parse_usage: dto.parse_usage,
    enabled: dto.enabled,
  };
}

describe('providerToForm (PRV-03)', () => {
  it('turns numbers into strings, nulls into empty text and the maps into key=value lines', () => {
    const form = providerToForm({ ...NON_DEFAULT, balance_path: null, balance_field: null, test_model: null });
    expect(form.timeout_ms).toBe('45000');
    expect(form.balance_divisor).toBe('500000');
    expect(form.recheck_hours).toBe('12');
    expect(form.balance_path).toBe('');
    expect(form.balance_field).toBe('');
    expect(form.test_model).toBe('');
    expect(form.model_map).toBe('claude-3-7-sonnet-*=claude-3-7-sonnet-20250219');
    expect(form.extra_headers).toBe('HTTP-Referer=https://example.com\nX-Title=Gateway');
  });

  it('leaves keys empty and add_to_default on', () => {
    const form = providerToForm(NON_DEFAULT);
    expect(form.keys).toBe('');
    expect(form.add_to_default).toBe(true);
  });

  it('keeps a map entry whose key contains = by switching that box to JSON', () => {
    const dto = { ...NON_DEFAULT, model_map: { 'a=b': 'c', 'd': 'e' } };
    expect(buildProviderPayload(providerToForm(dto), 'edit').model_map).toEqual({ 'a=b': 'c', d: 'e' });
  });
});

describe('edit payload round trip (PRV-03, D-15)', () => {
  it('sends every loaded value back unchanged for a provider with non-default Advanced values', () => {
    expect(canon(buildProviderPayload(providerToForm(NON_DEFAULT), 'edit'))).toBe(canon(editableFields(NON_DEFAULT)));
  });

  it('changing only the name changes only the name', () => {
    const form = { ...providerToForm(NON_DEFAULT), name: 'Renamed' };
    expect(buildProviderPayload(form, 'edit')).toEqual({ ...editableFields(NON_DEFAULT), name: 'Renamed' });
  });

  it('has no keys and no add_to_default', () => {
    const payload = buildProviderPayload(providerToForm(NON_DEFAULT), 'edit');
    expect(payload).not.toHaveProperty('keys');
    expect(payload).not.toHaveProperty('add_to_default');
    expect(Object.keys(payload)).toHaveLength(17);
  });

  it('blank numeric text falls back to 60000, 6 and 1', () => {
    const payload = buildProviderPayload({ ...providerToForm(NON_DEFAULT), timeout_ms: '', recheck_hours: ' ', balance_divisor: '' }, 'edit');
    expect(payload.timeout_ms).toBe(60000);
    expect(payload.recheck_hours).toBe(6);
    expect(payload.balance_divisor).toBe(1);
  });
});

describe('custom balance fields survive a mode switch (PRV-02 adjacency)', () => {
  it('keeps path, field and divisor after the mode goes to none and back to custom', () => {
    const custom = { ...emptyProviderForm(), name: 'n', base_url: 'https://x.test', balance_mode: 'custom' as const, balance_path: '/p', balance_field: 'f', balance_divisor: '500000' };
    const none = { ...custom, balance_mode: 'none' as const };
    const back = { ...none, balance_mode: 'custom' as const };
    for (const form of [custom, none, back]) {
      const payload = buildProviderPayload(form, 'edit');
      expect(payload.balance_path).toBe('/p');
      expect(payload.balance_field).toBe('f');
      expect(payload.balance_divisor).toBe(500000);
    }
    expect(buildProviderPayload(none, 'edit').balance_mode).toBe('none');
    expect(buildProviderPayload(back, 'edit').balance_mode).toBe('custom');
  });
});

describe('validateProviderForm, Advanced rules', () => {
  const valid = () => ({ ...emptyProviderForm(), name: 'n', base_url: 'https://x.test' });

  it('asks for at least one format', () => {
    expect(validateProviderForm({ ...valid(), formats: [] }, 'create').formats).toBe('Pick at least one format.');
  });

  it('keeps the timeout between 1000 and 300000', () => {
    const msg = 'Enter a timeout between 1000 and 300000 ms.';
    expect(validateProviderForm({ ...valid(), timeout_ms: '999' }, 'edit').timeout_ms).toBe(msg);
    expect(validateProviderForm({ ...valid(), timeout_ms: '300001' }, 'edit').timeout_ms).toBe(msg);
    expect(validateProviderForm({ ...valid(), timeout_ms: 'abc' }, 'edit').timeout_ms).toBe(msg);
    expect(validateProviderForm({ ...valid(), timeout_ms: '1000' }, 'edit').timeout_ms).toBeUndefined();
    expect(validateProviderForm({ ...valid(), timeout_ms: '300000' }, 'edit').timeout_ms).toBeUndefined();
  });

  it('keeps the recheck hours between 0.25 and 720', () => {
    const msg = 'Enter hours between 0.25 and 720.';
    expect(validateProviderForm({ ...valid(), recheck_hours: '0.2' }, 'edit').recheck_hours).toBe(msg);
    expect(validateProviderForm({ ...valid(), recheck_hours: '721' }, 'edit').recheck_hours).toBe(msg);
    expect(validateProviderForm({ ...valid(), recheck_hours: '0.25' }, 'edit').recheck_hours).toBeUndefined();
  });

  it('wants a positive finite divisor', () => {
    const msg = 'Enter a number above 0.';
    for (const bad of ['0', '-1', 'abc', 'Infinity']) {
      expect(validateProviderForm({ ...valid(), balance_divisor: bad }, 'edit').balance_divisor).toBe(msg);
    }
    expect(validateProviderForm({ ...valid(), balance_divisor: '500000' }, 'edit').balance_divisor).toBeUndefined();
  });

  it('reports invalid JSON in the model map and the extra headers under their own field', () => {
    const errors = validateProviderForm({ ...valid(), model_map: '{"a":', extra_headers: '{nope' }, 'edit');
    expect(errors.model_map).toBe(linesToMap('{"a":').error);
    expect(errors.extra_headers).toBe(linesToMap('{nope').error);
    expect(errors.model_map).toBeTruthy();
  });

  it('returns no errors for a valid form', () => {
    expect(validateProviderForm(valid(), 'create')).toEqual({});
    expect(validateProviderForm(providerToForm(NON_DEFAULT), 'edit')).toEqual({});
  });
});
