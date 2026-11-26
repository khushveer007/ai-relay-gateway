import { compareModelNames, mergeRates, modelPriceCandidates, quantizeRate, RATE_FIELDS, validModelName, type PriceTier, type RateFields } from '../../shared/pricing';
import { priceApi, readPriceModels, type CatalogPriceInput } from './api';

export const PRICE_CATALOG_URL = 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';
export const REFRESH_PRICE_ERROR = 'Couldn’t refresh prices. The last saved prices are still in use. Try Refresh prices again.';
const CATALOG_FIELDS = {
  input: 'input_cost_per_token',
  output: 'output_cost_per_token',
  cache_read: 'cache_read_input_token_cost',
  cache_write: 'cache_creation_input_token_cost',
} satisfies Record<keyof RateFields, string>;
const TIER_FIELD = /^(input_cost_per_token|output_cost_per_token|cache_read_input_token_cost|cache_creation_input_token_cost)_above_(\d+)k_tokens$/;

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid catalog record');
  return value as Record<string, unknown>;
}

function rate(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number') throw new Error('Invalid catalog rate');
  const amount = quantizeRate(value);
  if (amount === null) throw new Error('Invalid catalog rate');
  return amount;
}

function projectPrice(model: string, value: unknown): CatalogPriceInput {
  const entry = record(value);
  const base = mergeRates({});
  for (const field of RATE_FIELDS) base[field] = rate(entry[CATALOG_FIELDS[field]]);

  const byThreshold = new Map<number, RateFields>();
  for (const [key, value] of Object.entries(entry)) {
    const match = TIER_FIELD.exec(key);
    if (!match) continue;
    const amount = rate(value);
    const threshold = Number(match[2]) * 1000;
    if (!Number.isSafeInteger(threshold) || threshold <= 0) continue;
    const fields = byThreshold.get(threshold) ?? mergeRates({});
    const field = RATE_FIELDS.find((field) => CATALOG_FIELDS[field] === match[1])!;
    fields[field] = amount;
    byThreshold.set(threshold, fields);
  }
  if (byThreshold.size === 0 && !Object.keys(entry).some((key) => TIER_FIELD.test(key))) return { model, base };

  const threshold = byThreshold.size ? Math.min(...byThreshold.keys()) : null;
  const rates = threshold === null ? undefined : byThreshold.get(threshold);
  const supported = byThreshold.size === 1 && rates && rates.input !== null && rates.output !== null;
  const tier: PriceTier = {
    state: supported ? 'supported' : 'unsupported',
    threshold_tokens: threshold,
    rates: supported ? rates : mergeRates({}),
  };
  return { model, base, tier };
}

export function selectCatalogPrices(catalog: unknown, modelNames: readonly string[]): CatalogPriceInput[] {
  const entries = record(catalog);
  const families = new Map<string, string[]>();
  for (const model of Object.keys(entries)) {
    if (model === 'sample_spec' || !validModelName(model)) continue;
    const family = modelPriceCandidates(model).at(-1)!;
    const models = families.get(family) ?? [];
    models.push(model);
    families.set(family, models);
  }
  const picked = new Map<string, CatalogPriceInput>();
  const pick = (model: string) => {
    const found = picked.get(model);
    if (found) return found;
    const entry = projectPrice(model, entries[model]);
    if (picked.size >= 512) throw new Error('Price import exceeds 512 models');
    picked.set(model, entry);
    return entry;
  };
  for (const model of new Set(modelNames)) {
    if (!validModelName(model)) continue;
    const candidates = modelPriceCandidates(model);
    const direct = candidates.some((candidate) => candidate !== 'sample_spec' && validModelName(candidate) && Object.hasOwn(entries, candidate)
      && RATE_FIELDS.some((field) => pick(candidate).base[field] !== null));
    if (!direct) {
      for (const candidate of families.get(candidates.at(-1)!) ?? []) pick(candidate);
    }
  }
  return [...picked.values()].sort((a, b) => compareModelNames(a.model, b.model));
}

export async function refreshCatalogPrices(): Promise<void> {
  const [response, { models }] = await Promise.all([
    fetch(PRICE_CATALOG_URL, { credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer' } as RequestInit),
    readPriceModels(),
  ]);
  if (!response.ok) throw new Error('Catalog request failed');
  const prices = selectCatalogPrices(await response.json(), models.map((model) => model.upstream_model));
  if (new TextEncoder().encode(JSON.stringify({ prices })).length > 128 * 1024) throw new Error('Price import exceeds 128 KiB');
  await priceApi.import(prices);
}
