import { describe, expect, it } from 'vitest';
import {
  PROVIDER_FORMATS,
  buildProviderPayload,
  emptyProviderForm,
  initialTestState,
  linesToMap,
  mapToLines,
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
