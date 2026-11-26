import { afterEach, expect, it, vi } from 'vitest';

afterEach(() => vi.unstubAllGlobals());

it('selects only relevant ordered catalog prices and complete tier snapshots', async () => {
  const pricing = import.meta.glob('../src/dashboard/lib/price-catalog.ts');
  const load = pricing['../src/dashboard/lib/price-catalog.ts'];
  expect(typeof load).toBe('function');
  const { selectCatalogPrices } = await load() as {
    selectCatalogPrices: (catalog: unknown, modelNames: readonly string[]) => unknown;
  };
  const amounts = { input_cost_per_token: 5e-13, output_cost_per_token: 0, cache_creation_input_token_cost: 0.000004 };
  const tier = (threshold: number) => ({
    [`input_cost_per_token_above_${threshold}k_tokens`]: 0.000006,
    [`output_cost_per_token_above_${threshold}k_tokens`]: 0.000015,
    [`cache_read_input_token_cost_above_${threshold}k_tokens`]: 0.0000005,
  });
  const selected = selectCatalogPrices({
    sample_spec: { input_cost_per_token: 100 },
    'claude-sonnet-4-5': { ...amounts, ...tier(100), cache_creation_input_token_cost_above_100k_tokens: 0.000005 },
    'claude-sonnet-4-5-20250929': { input_cost_per_token: 0.000009 },
    'gemini-2-5-pro': { ...amounts, ...tier(200) },
    'gpt-5-4': { ...amounts, ...tier(272) },
    'gpt-5': { ...amounts },
    'gpt-5-mini-20250929': { ...amounts },
    'gpt-5-mini-20250930': { ...amounts },
    'thin-model': { max_tokens: 8192 },
    'inconsistent-model': { ...amounts, input_cost_per_token_above_100k_tokens: 0.00002, output_cost_per_token_above_200k_tokens: 0.000015 },
    'unrelated-model': { input_cost_per_token: 'invalid and irrelevant' },
  }, [
    'anthropic/claude-sonnet-4.5-20250929-thinking', 'claude-sonnet-4.5-20250929-thinking',
    'gemini-2-5-pro', 'gpt-5-4', 'thin-model', 'gpt-5-mini-20250928', 'inconsistent-model',
  ]);
  expect(selected).toMatchObject([
    { model: 'claude-sonnet-4-5', base: { input: 1, output: 0, cache_read: null, cache_write: 4_000_000 },
      tier: { state: 'supported', threshold_tokens: 100_000, rates: { cache_write: 5_000_000 } } },
    { model: 'gemini-2-5-pro', tier: { threshold_tokens: 200_000, rates: { cache_write: null } } },
    { model: 'gpt-5-4', tier: { threshold_tokens: 272_000, rates: { cache_read: 500_000 } } },
    { model: 'gpt-5-mini-20250929' }, { model: 'gpt-5-mini-20250930' },
    { model: 'inconsistent-model', tier: { state: 'unsupported', threshold_tokens: 100_000 } },
    { model: 'thin-model', base: { input: null, output: null, cache_read: null, cache_write: null } },
  ]);
});
