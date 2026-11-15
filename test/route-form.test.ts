import { describe, expect, it } from 'vitest';
import {
  addToChain,
  availableProviders,
  buildRoutePayload,
  emptyRouteForm,
  moveChainItem,
  removeFromChain,
  routeToForm,
  splitPatterns,
  validateRouteForm,
} from '../src/dashboard/lib/route-form';

const PROVIDERS = [
  { id: 4, name: 'A' },
  { id: 9, name: 'B' },
  { id: 2, name: 'C' },
];

// One line per value, so a failing assertion prints on a single line (and the TDD RED report stays valid TAP).
// Double quotes become single quotes so an assertion message holds no escaped quotes, which the TAP parser rejects.
const j = (v: unknown): string => JSON.stringify(v).replace(/"/g, "'");

describe('splitPatterns', () => {
  it('splits on commas and new lines, trims and drops blanks', () => {
    expect(j(splitPatterns('claude-*, sonnet-*\ngpt-?'))).toBe(j(['claude-*', 'sonnet-*', 'gpt-?']));
    expect(j(splitPatterns('  a ,, \n\n b\r\nc '))).toBe(j(['a', 'b', 'c']));
  });

  it('returns an empty list for blank text', () => {
    expect(j(splitPatterns(''))).toBe('[]');
    expect(j(splitPatterns(' \n , '))).toBe('[]');
  });
});

describe('emptyRouteForm', () => {
  it('starts with an empty name, position 10, no patterns and every provider in provider order', () => {
    const form = emptyRouteForm(PROVIDERS);
    expect(form.name).toBe('');
    expect(form.position).toBe('10');
    expect(form.patterns).toBe('');
    expect(j(form.provider_ids)).toBe(j([4, 9, 2]));
  });
});

describe('buildRoutePayload (VIEW-03, research Pitfall 2)', () => {
  const route = { name: 'Fast', model_patterns: ['gpt-*'], is_default: false, position: 5, provider_ids: [9, 4] };
  const defaultRoute = { name: 'Default', model_patterns: ['*'], is_default: true, position: 100000, provider_ids: [4] };

  it('a normal route sends the name, a numeric position, the split patterns and the full chain', () => {
    const form = { name: ' Fast ', position: '5', patterns: 'gpt-*, o1-*', provider_ids: [9, 4, 2] };
    expect(j(buildRoutePayload(form, route))).toBe(j({ name: 'Fast', position: 5, model_patterns: ['gpt-*', 'o1-*'], provider_ids: [9, 4, 2] }));
  });

  it('the default route sends its existing patterns although the field is disabled', () => {
    const form = { name: 'Default', position: '100000', patterns: '', provider_ids: [4] };
    expect(j(buildRoutePayload(form, defaultRoute).model_patterns)).toBe(j(['*']));
  });

  it('always sends the full provider_ids list, also when it is empty', () => {
    const form = { name: 'Fast', position: '5', patterns: '', provider_ids: [] as number[] };
    expect(j(buildRoutePayload(form, route).provider_ids)).toBe('[]');
  });

  it('routeToForm and buildRoutePayload round trip a route', () => {
    expect(j(buildRoutePayload(routeToForm(route), route))).toBe(j({ name: 'Fast', position: 5, model_patterns: ['gpt-*'], provider_ids: [9, 4] }));
  });
});

describe('chain helpers (D-09: Move up and Move down, no drag)', () => {
  it('moveChainItem swaps with the neighbour', () => {
    expect(j(moveChainItem([1, 2, 3], 1, -1))).toBe(j([2, 1, 3]));
    expect(j(moveChainItem([1, 2, 3], 1, 1))).toBe(j([1, 3, 2]));
  });

  it('moveChainItem keeps the order at either end and never mutates its input', () => {
    const ids = [1, 2, 3];
    expect(j(moveChainItem(ids, 0, -1))).toBe(j([1, 2, 3]));
    expect(j(moveChainItem(ids, 2, 1))).toBe(j([1, 2, 3]));
    expect(j(ids)).toBe(j([1, 2, 3]));
  });

  it('removeFromChain and addToChain keep order and never add a duplicate', () => {
    expect(j(removeFromChain([1, 2, 3], 2))).toBe(j([1, 3]));
    expect(j(addToChain([1, 3], 2))).toBe(j([1, 3, 2]));
    expect(j(addToChain([1, 3], 3))).toBe(j([1, 3]));
  });

  it('availableProviders lists the providers not yet in the chain', () => {
    expect(j(availableProviders(PROVIDERS, [9]).map((p) => p.id))).toBe(j([4, 2]));
    expect(j(availableProviders(PROVIDERS, [4, 9, 2]))).toBe('[]');
  });
});

describe('validateRouteForm', () => {
  const ok = { name: 'Fast', position: '10', patterns: '', provider_ids: [] as number[] };

  it('asks for a name', () => {
    expect(validateRouteForm({ ...ok, name: '  ' }).name).toBe('Enter a route name.');
  });

  it('limits the name to 60 characters', () => {
    expect(validateRouteForm({ ...ok, name: 'x'.repeat(61) }).name).toBe('Use 60 characters or fewer.');
    expect(validateRouteForm({ ...ok, name: 'x'.repeat(60) }).name).toBeUndefined();
  });

  it('keeps the position between 0 and 100000', () => {
    const msg = 'Enter a position between 0 and 100000.';
    expect(validateRouteForm({ ...ok, position: '-1' }).position).toBe(msg);
    expect(validateRouteForm({ ...ok, position: '100001' }).position).toBe(msg);
    expect(validateRouteForm({ ...ok, position: 'abc' }).position).toBe(msg);
    expect(validateRouteForm({ ...ok, position: '' }).position).toBe(msg);
    expect(validateRouteForm({ ...ok, position: '0' }).position).toBeUndefined();
  });

  it('gives no errors for a valid form', () => {
    expect(j(validateRouteForm(ok))).toBe('{}');
  });
});
