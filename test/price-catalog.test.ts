import { afterEach, expect, it, vi } from 'vitest';
import { readPriceModels } from '../src/dashboard/lib/api';
import { PRICE_CATALOG_URL, refreshCatalogPrices, selectCatalogPrices } from '../src/dashboard/lib/price-catalog';

afterEach(() => vi.unstubAllGlobals());

it('selects only relevant ordered catalog prices and complete tier snapshots', () => {
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

it('fails the entire projection on malformed relevant records or excess candidates', () => {
  expect(selectCatalogPrices({ ignored: null }, [])).toEqual([]);
  expect(() => selectCatalogPrices({ actual: null }, ['actual'])).toThrow('Invalid catalog record');
  expect(() => selectCatalogPrices({ actual: { input_cost_per_token: -1 } }, ['actual'])).toThrow('Invalid catalog rate');
  const names = Array.from({ length: 513 }, (_, i) => 'model-' + i);
  const catalog = Object.fromEntries(names.map((name) => [name, { input_cost_per_token: 0 }]));
  expect(selectCatalogPrices(catalog, names.slice(0, 512))).toHaveLength(512);
  expect(() => selectCatalogPrices(catalog, names)).toThrow('512 models');
});

function page(names: string[], version = 1, next_after: string | null = null) {
  return Response.json({
    models: names.map((upstream_model) => ({ upstream_model, priced_model: null, match_type: 'none', candidates: [] })),
    next_after,
    version,
  });
}

it('fetches the fixed catalog anonymously and submits one import after every inventory page', async () => {
  const fetcher = vi.fn(async (url: string, _init?: RequestInit) => {
    if (url === PRICE_CATALOG_URL) return Response.json({
      'actual-model': { input_cost_per_token: 3e-6 },
      'pinned-target': { output_cost_per_token: 15e-6 },
      unrelated: { input_cost_per_token: 3e-6 },
    });
    if (url === '/api/admin/prices/models') return page(['actual-model'], 1, 'actual-model');
    if (url === '/api/admin/prices/models?after=actual-model') return page(['pinned-target']);
    return Response.json({ ok: true });
  });
  vi.stubGlobal('fetch', fetcher);
  await refreshCatalogPrices();
  const [catalogCall] = fetcher.mock.calls;
  expect(catalogCall).toEqual([PRICE_CATALOG_URL, { credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer' }]);
  expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
    PRICE_CATALOG_URL, '/api/admin/prices/models', '/api/admin/prices/models?after=actual-model', '/api/admin/prices/import',
  ]);
  const importCall = fetcher.mock.calls.at(-1)?.[1];
  expect(importCall).toMatchObject({ method: 'POST', credentials: 'same-origin' });
  expect(JSON.parse(importCall!.body as string)).toEqual({
    prices: [
      { model: 'actual-model', base: { input: 3_000_000, output: null, cache_read: null, cache_write: null } },
      { model: 'pinned-target', base: { input: null, output: 15_000_000, cache_read: null, cache_write: null } },
    ],
  });
});

it('restarts a mixed-version traversal and rejects a stale or non-advancing cursor', async () => {
  const fetcher = vi.fn()
    .mockResolvedValueOnce(page(['a'], 1, 'a'))
    .mockResolvedValueOnce(page(['b'], 2))
    .mockResolvedValueOnce(page(['a'], 2, 'a'))
    .mockResolvedValueOnce(page(['b'], 2));
  vi.stubGlobal('fetch', fetcher);
  const models = await readPriceModels();
  expect(models.version).toBe(2);
  expect(models.models.map(({ upstream_model }) => upstream_model)).toEqual(['a', 'b']);
  expect(fetcher).toHaveBeenCalledTimes(4);

  fetcher.mockReset().mockImplementation(async () => page(['a'], 1, 'a'));
  await expect(readPriceModels()).rejects.toThrow('Invalid pricing page order');
  expect(fetcher).toHaveBeenCalledTimes(2);
  fetcher.mockReset().mockResolvedValueOnce(page(['a'], 1, 'wrong'));
  await expect(readPriceModels()).rejects.toThrow('cursor did not advance');
});

it('continues oversized model cursors in the authenticated request body', async () => {
  const longName = 'é'.repeat(3000);
  const fetcher = vi.fn()
    .mockResolvedValueOnce(page([longName], 1, longName))
    .mockResolvedValueOnce(page(['Ω-final']));
  vi.stubGlobal('fetch', fetcher);
  expect((await readPriceModels()).models.map(({ upstream_model }) => upstream_model)).toEqual([longName, 'Ω-final']);
  expect(fetcher).toHaveBeenLastCalledWith('/api/admin/prices/models', expect.objectContaining({
    method: 'POST', body: JSON.stringify({ after: longName }), credentials: 'same-origin',
  }));
});

it('leaves saved prices usable on catalog or submission failure', async () => {
  const fetcher = vi.fn();
  vi.stubGlobal('fetch', fetcher);
  for (const catalog of [
    () => new Response('', { status: 503 }),
    () => new Response('invalid JSON'),
    () => Response.json({ actual: { input_cost_per_token: -1 } }),
  ]) {
    fetcher.mockReset().mockImplementation(async (url: string) => url === PRICE_CATALOG_URL ? catalog() : page(['actual']));
    await expect(refreshCatalogPrices()).rejects.toThrow();
    expect(fetcher.mock.calls.map(([url]) => url)).not.toContain('/api/admin/prices/import');
  }

  const names = Array.from({ length: 250 }, (_, i) => (i + '').padStart(3, '0') + 'x'.repeat(509));
  const catalog = Object.fromEntries(names.map((name) => [name, { input_cost_per_token: 0 }]));
  fetcher.mockReset().mockImplementation(async (url: string) => url === PRICE_CATALOG_URL ? Response.json(catalog) : page(names));
  await expect(refreshCatalogPrices()).rejects.toThrow('128 KiB');
  expect(fetcher.mock.calls.map(([url]) => url)).not.toContain('/api/admin/prices/import');

  fetcher.mockReset().mockImplementation(async (url: string) => {
    if (url === PRICE_CATALOG_URL) return Response.json({ actual: { input_cost_per_token: 0 } });
    if (url === '/api/admin/prices/models') return page(['actual']);
    return Response.json({ error: 'Price table is full' }, { status: 409 });
  });
  await expect(refreshCatalogPrices()).rejects.toThrow('Price table is full');
  expect(fetcher.mock.calls.filter(([url]) => url === '/api/admin/prices/import')).toHaveLength(1);
});
