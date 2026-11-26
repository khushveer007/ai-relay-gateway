export const RATE_FIELDS = ['input', 'output', 'cache_read', 'cache_write'] as const;
export type RateFields = Record<(typeof RATE_FIELDS)[number], number | null>;
export type TierState = 'base' | 'supported' | 'unsupported';
export interface PriceTier {
  state: TierState;
  threshold_tokens: number | null;
  rates: RateFields;
}

export interface PriceRecord {
  model: string;
  catalog_imported: boolean;
  catalog_base: Partial<RateFields>;
  override_base: Partial<RateFields>;
  catalog_tier: { state: TierState; threshold_tokens: number | null; rates: Partial<RateFields> };
  override_tier: Partial<RateFields>;
}

export interface PriceAlias {
  upstream_model: string;
  priced_model: string;
}

export type MatchType = 'pinned' | 'exact' | 'normalized' | 'ambiguous' | 'none';
export interface PriceResolution {
  priced_model: string | null;
  match_type: MatchType;
  candidates: readonly string[];
}

export interface EffectivePrice {
  model: string;
  catalog_imported: boolean;
  base: RateFields;
  tier: PriceTier;
}

export interface PriceIndex {
  exact: ReadonlyMap<string, EffectivePrice>;
  pins: ReadonlyMap<string, string>;
  families: ReadonlyMap<string, readonly string[]>;
  memo: Map<string, PriceResolution>;
}

export const MAX_RATE_PICO = 1_000_000_000;
const encoder = new TextEncoder();
const EMPTY_CANDIDATES: readonly string[] = [];
const UNMATCHED: PriceResolution = { priced_model: null, match_type: 'none', candidates: EMPTY_CANDIDATES };
const MEMO_LIMIT = 1024;
const PROVIDER_PREFIX = /^(?:(?:anthropic|openai|azure|azure_ai|vertex_ai|vertex_ai_beta|gemini|google|bedrock|openrouter|deepseek|xai|mistral|cohere|groq|together_ai|fireworks_ai|perplexity|meta|amazon|moonshot|qwen|alibaba|huggingface)\/)+/;
const DATED_SUFFIX = /-(?:[0-9]{8}|[0-9]{4}-[0-9]{2}-[0-9]{2})(?=-thinking$|$)/;

export function validModelName(model: unknown): model is string {
  return typeof model === 'string' && model.length > 0 && model.length <= 512 && model.trim() === model
    && !/[\u0000-\u001f\u007f-\u009f]|\p{Cs}/u.test(model) && encoder.encode(model).length <= 512;
}

export function compareModelNames(a: string, b: string): number {
  const left = encoder.encode(a);
  const right = encoder.encode(b);
  for (let i = 0; i < Math.min(left.length, right.length); i++) {
    if (left[i] !== right[i]) return left[i] - right[i];
  }
  return left.length - right.length;
}

/** Ordered exact candidates, ending in the family lookup key. */
export function modelPriceCandidates(model: string): string[] {
  const unprefixed = model.replace(PROVIDER_PREFIX, '');
  const undated = unprefixed.replace(DATED_SUFFIX, '');
  const standard = undated.replace(/-thinking$/, '');
  const family = standard.replace(/([0-9])\.(?=[0-9])/g, '$1-');
  return [...new Set([model, unprefixed, undated, standard, family])];
}

function hasBaseRates(rates: RateFields): boolean {
  return RATE_FIELDS.some((field) => rates[field] !== null);
}

export function mergeRates(catalog: Partial<RateFields>, overrides: Partial<RateFields> = {}): RateFields {
  return {
    input: overrides.input ?? catalog.input ?? null,
    output: overrides.output ?? catalog.output ?? null,
    cache_read: overrides.cache_read ?? catalog.cache_read ?? null,
    cache_write: overrides.cache_write ?? catalog.cache_write ?? null,
  };
}

export function buildPriceIndex(prices: readonly PriceRecord[], aliases: readonly PriceAlias[] = []): PriceIndex {
  const exact = new Map<string, EffectivePrice>();
  const families = new Map<string, string[]>();
  for (const row of prices) {
    const base = mergeRates(row.catalog_base, row.override_base);
    if (validModelName(row.model) && hasBaseRates(base)) {
      exact.set(row.model, {
        model: row.model,
        catalog_imported: row.catalog_imported,
        base,
        tier: {
          ...row.catalog_tier,
          rates: mergeRates(row.catalog_tier.rates, row.catalog_tier.state === 'supported' ? row.override_tier : {}),
        },
      });
    }
  }
  for (const name of exact.keys()) {
    const family = modelPriceCandidates(name).at(-1)!;
    const group = families.get(family) ?? [];
    group.push(name);
    families.set(family, group);
  }
  for (const group of families.values()) group.sort(compareModelNames);

  const pins = new Map<string, string>();
  for (const alias of aliases) {
    if (validModelName(alias.upstream_model) && exact.get(alias.priced_model)?.catalog_imported) {
      pins.set(alias.upstream_model, alias.priced_model);
    }
  }
  return { exact, pins, families, memo: new Map() };
}

export function resolvePrice(index: PriceIndex, model: string | null): PriceResolution {
  if (!model) return UNMATCHED;
  const pinned = index.pins.get(model);
  if (pinned !== undefined) return { priced_model: pinned, match_type: 'pinned', candidates: EMPTY_CANDIDATES };
  if (index.exact.has(model)) return { priced_model: model, match_type: 'exact', candidates: EMPTY_CANDIDATES };
  const memoized = index.memo.get(model);
  if (memoized !== undefined) return memoized;
  if (!validModelName(model)) return UNMATCHED;

  const candidates = modelPriceCandidates(model);
  const direct = candidates.find((name) => index.exact.has(name));
  const family = index.families.get(candidates.at(-1)!) ?? EMPTY_CANDIDATES;
  let resolved = UNMATCHED;
  if (direct || family.length === 1) {
    resolved = { priced_model: direct ?? family[0], match_type: 'normalized', candidates: EMPTY_CANDIDATES };
  } else if (family.length > 1) {
    resolved = { priced_model: null, match_type: 'ambiguous', candidates: family };
  }

  if (index.memo.size >= MEMO_LIMIT) {
    const oldest = index.memo.keys().next();
    if (!oldest.done) index.memo.delete(oldest.value);
  }
  index.memo.set(model, resolved);
  return resolved;
}

/** Convert decimal list rates without rounding through binary floating point arithmetic. */
export function quantizeRate(value: unknown, unit: 'usd_per_token' | 'usd_per_million' = 'usd_per_token'): number | null {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  const decimal = String(value);
  if (decimal.length > 128) return null;
  const match = /^\+?(?:(\d+)(?:\.(\d*))?|\.(\d+))(?:[eE]([+-]?\d+))?$/.exec(decimal);
  if (!match) return null;
  const fraction = match[2] ?? match[3] ?? '';
  const exponent = Number(match[4] ?? 0);
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 1000) return null;
  const coefficient = BigInt((match[1] ?? '') + fraction);
  if (coefficient === 0n) return 0;
  const scale = exponent - fraction.length + (unit === 'usd_per_token' ? 12 : 6);
  const cap = BigInt(MAX_RATE_PICO);
  if (scale >= 0) {
    if (scale > 9) return null;
    const pico = coefficient * 10n ** BigInt(scale);
    return pico <= cap ? Number(pico) : null;
  }
  const divisor = 10n ** BigInt(-scale);
  if (coefficient > cap * divisor) return null;
  return Number((coefficient + divisor / 2n) / divisor);
}
