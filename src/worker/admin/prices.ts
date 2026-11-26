import { Hono } from 'hono';
import { MAX_RATE_PICO, RATE_FIELDS, mergeRates, resolvePrice, validModelName, type PriceTier, type RateFields } from '../../shared/pricing';
import { getConfig } from '../db/cache';
import { loadConfig, parsePrice } from '../db/repo';
import type { Env } from '../types';

const LIMIT = 50;
const IMPORT_BYTES = 128 * 1024;
const IMPORT_ROWS = 512;
const VERSION_SQL = "SELECT value FROM settings WHERE key = 'config_version'";
type Row = Record<string, unknown>;
type RatePatch = Partial<RateFields>;

export function pricesRoutes(
  mutate: (env: Env, statements: D1PreparedStatement[]) => Promise<unknown>,
  HttpError: new (status: number, message: string) => Error,
) {
  const routes = new Hono<{ Bindings: Env }>();

  function shape(value: unknown, allowed: readonly string[], description: string): Row {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some((key) => !allowed.includes(key))) {
      throw new HttpError(400, `invalid ${description}`);
    }
    return value as Row;
  }

  function modelName(value: unknown): string {
    if (!validModelName(value)) throw new HttpError(400, 'Use an exact model name of 1–512 UTF-8 bytes without surrounding whitespace or control characters.');
    return value;
  }

  function rates(value: unknown, complete: true): RateFields;
  function rates(value: unknown, complete: false): RatePatch;
  function rates(value: unknown, complete: boolean): RatePatch {
    const fields = shape(value, RATE_FIELDS, 'rates');
    const result: RatePatch = {};
    for (const field of RATE_FIELDS) {
      const rate = fields[field];
      if (!complete && rate === undefined) continue;
      if (rate !== null && (typeof rate !== 'number' || !Number.isInteger(rate) || rate < 0 || rate > MAX_RATE_PICO)) {
        throw new HttpError(400, `invalid ${field} rate`);
      }
      result[field] = rate;
    }
    return result;
  }

  function tier(value: unknown): PriceTier {
    if (value === undefined) return { state: 'base', threshold_tokens: null, rates: mergeRates({}) };
    const { state, threshold_tokens: threshold, rates: fields } = shape(value, ['state', 'threshold_tokens', 'rates'], 'tier');
    if (state !== 'base' && state !== 'supported' && state !== 'unsupported') throw new HttpError(400, 'invalid tier state');
    if (threshold === null ? state === 'supported' : state === 'base' || typeof threshold !== 'number' || !Number.isSafeInteger(threshold) || threshold <= 0) {
      throw new HttpError(400, 'invalid tier threshold');
    }
    const tierRates = rates(fields, true);
    if (state !== 'supported' && RATE_FIELDS.some((field) => tierRates[field] !== null)) throw new HttpError(400, 'invalid rates for tier state');
    return { state, threshold_tokens: threshold as number | null, rates: tierRates };
  }

  async function boundedJson(request: Request): Promise<unknown> {
    if (!request.body) throw new HttpError(400, 'invalid JSON body');
    const tooLarge = () => new HttpError(413, 'Price submission exceeds 128 KiB. Select fewer models and try again.');
    if (Number(request.headers.get('content-length')) > IMPORT_BYTES) throw tooLarge();
    const reader = request.body.getReader();
    const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });
    let received = 0;
    let text = '';
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        received += chunk.value.byteLength;
        if (received > IMPORT_BYTES) {
          await reader.cancel().catch(() => {});
          throw tooLarge();
        }
        text += decoder.decode(chunk.value, { stream: true });
      }
      return JSON.parse(text + decoder.decode()) as unknown;
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(400, 'invalid JSON body');
    } finally {
      reader.releaseLock();
    }
  }

  async function apply(env: Env, statement: D1PreparedStatement) {
    try {
      await mutate(env, [statement]);
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      if (message.includes('model_price_capacity')) throw new HttpError(409, 'The price table is full (600 models).');
      if (message.includes('model_alias_capacity')) throw new HttpError(409, 'The alias table is full (1,024 aliases).');
      if (message.includes('NOT NULL constraint failed: model_price_aliases.priced_model')) {
        throw new HttpError(409, 'Choose an imported catalog model with an available rate.');
      }
      if (message.includes('NOT NULL constraint failed: model_prices.override_base')) {
        throw new HttpError(409, 'Set at least one base rate for a new model. Only available catalog fields can be reset.');
      }
      if (message.includes('NOT NULL constraint failed: model_prices.override_tier')) {
        throw new HttpError(409, 'A supported long-context tier is required. Only available catalog fields can be reset.');
      }
      throw error;
    }
  }

  function versionOf(result: D1Result<Row>): number {
    return Number(result.results[0]?.value ?? 0);
  }

  routes.get('/', async (c) => {
    const db = c.env.DB;
    const [page, version] = await db.batch<Row>([
      db.prepare('SELECT * FROM model_prices WHERE model > ? ORDER BY model COLLATE BINARY LIMIT ?').bind(c.req.query('after') ?? '', LIMIT + 1),
      db.prepare(VERSION_SQL),
    ]);
    const prices = page.results.slice(0, LIMIT).map((row) => {
      const price = parsePrice(row);
      const catalogTier = { ...price.catalog_tier, rates: mergeRates(price.catalog_tier.rates) };
      const overrideTier = mergeRates(price.override_tier);
      return {
        ...price,
        catalog_base: mergeRates(price.catalog_base),
        override_base: mergeRates(price.override_base),
        effective_base: mergeRates(price.catalog_base, price.override_base),
        catalog_tier: catalogTier,
        override_tier: overrideTier,
        effective_tier: { ...catalogTier, rates: mergeRates(catalogTier.rates, catalogTier.state === 'supported' ? overrideTier : {}) },
      };
    });
    return c.json({ prices, next_after: page.results.length > LIMIT ? prices[LIMIT - 1].model : null, version: versionOf(version) });
  });

  routes.get('/models', async (c) => {
    const db = c.env.DB;
    const after = c.req.query('after') ?? '';
    const names = db.prepare(`
      SELECT DISTINCT upstream_model AS model FROM request_logs
        WHERE upstream_model IS NOT NULL AND upstream_model <> '' AND upstream_model COLLATE BINARY > ?1
      UNION SELECT value FROM providers, json_each(CASE WHEN json_valid(models) THEN models ELSE '[]' END)
        WHERE json_each.type = 'text' AND value COLLATE BINARY > ?1
      UNION SELECT value FROM providers, json_each(CASE WHEN json_valid(model_map) THEN model_map ELSE '{}' END)
        WHERE json_each.type = 'text' AND value COLLATE BINARY > ?1
      UNION SELECT upstream_model FROM model_price_aliases WHERE upstream_model COLLATE BINARY > ?1
      UNION SELECT priced_model FROM model_price_aliases WHERE priced_model COLLATE BINARY > ?1
      ORDER BY model COLLATE BINARY LIMIT ?2
    `).bind(after, LIMIT + 1);
    let config = await getConfig(c.env);
    for (let attempt = 0; attempt < 2; attempt++) {
      const [page, version] = await db.batch<Row>([names, db.prepare(VERSION_SQL)]);
      const currentVersion = versionOf(version);
      if (config.version === currentVersion) {
        const models = page.results.slice(0, LIMIT).map(({ model }) => {
          const upstream_model = String(model);
          return { upstream_model, ...resolvePrice(config.prices, upstream_model) };
        });
        return c.json({ models, next_after: page.results.length > LIMIT ? models[LIMIT - 1].upstream_model : null, version: currentVersion });
      }
      if (attempt === 0) config = await loadConfig(db);
    }
    throw new HttpError(503, 'Prices changed while loading. Try loading prices again.');
  });

  routes.post('/import', async (c) => {
    const { prices } = shape(await boundedJson(c.req.raw), ['prices'], 'price import');
    if (!Array.isArray(prices)) throw new HttpError(400, 'prices must be an array');
    if (prices.length > IMPORT_ROWS) throw new HttpError(413, 'Price import exceeds 512 models. Select fewer models and try again.');
    const names = new Set<string>();
    const rows = prices.map((item) => {
      const price = shape(item, ['model', 'base', 'tier'], 'price row');
      const model = modelName(price.model);
      if (names.has(model)) throw new HttpError(400, 'Price import contains a duplicate model.');
      names.add(model);
      return { model, base: rates(price.base, true), tier: tier(price.tier) };
    });
    if (rows.length) {
      await apply(c.env, c.env.DB.prepare(`
        INSERT INTO model_prices (model, catalog_base, catalog_tier, catalog_imported)
        SELECT value ->> 'model', value -> 'base', value -> 'tier', 1 FROM json_each(?) WHERE TRUE
        ON CONFLICT(model) DO UPDATE SET catalog_base = excluded.catalog_base, catalog_tier = excluded.catalog_tier, catalog_imported = 1
      `).bind(JSON.stringify(rows)));
    }
    return c.json({ ok: true });
  });

  routes.put('/override', async (c) => {
    const data = shape(await boundedJson(c.req.raw), ['model', 'base', 'tier'], 'price override');
    const model = modelName(data.model);
    const base = data.base === undefined ? {} : rates(data.base, false);
    const elevated = data.tier === undefined ? {} : rates(data.tier, false);
    if (Object.keys(base).length + Object.keys(elevated).length === 0) throw new HttpError(400, 'Change at least one price field.');
    await apply(c.env, c.env.DB.prepare(`
      INSERT INTO model_prices (model, override_base, override_tier)
      SELECT ?1,
        CASE WHEN (current.model IS NOT NULL OR EXISTS (SELECT 1 FROM json_each(?2) WHERE type <> 'null'))
          AND NOT EXISTS (SELECT 1 FROM json_each(?2) WHERE type = 'null' AND current.catalog_base ->> key IS NULL)
          THEN json_patch(COALESCE(current.override_base, '{}'), ?2) END,
        CASE WHEN ?3 = '{}' OR (
          current.catalog_tier ->> 'state' = 'supported'
          AND NOT EXISTS (SELECT 1 FROM json_each(?3) WHERE type = 'null' AND current.catalog_tier -> 'rates' ->> key IS NULL)
        ) THEN json_patch(COALESCE(current.override_tier, '{}'), ?3) END
      FROM (SELECT 1) LEFT JOIN model_prices AS current ON current.model = ?1 WHERE TRUE
      ON CONFLICT(model) DO UPDATE SET override_base = excluded.override_base, override_tier = excluded.override_tier
    `).bind(model, JSON.stringify(base), JSON.stringify(elevated)));
    return c.json({ ok: true });
  });

  routes.put('/alias', async (c) => {
    const data = shape(await boundedJson(c.req.raw), ['upstream_model', 'priced_model'], 'model alias');
    const upstream = modelName(data.upstream_model);
    const priced = modelName(data.priced_model);
    await apply(c.env, c.env.DB.prepare(`
      INSERT INTO model_price_aliases (upstream_model, priced_model)
      VALUES (?1, (
        SELECT model FROM model_prices WHERE model = ?2 AND catalog_imported = 1
        AND EXISTS (SELECT 1 FROM json_each(json_patch(catalog_base, override_base)) WHERE type = 'integer')
      ))
      ON CONFLICT(upstream_model) DO UPDATE SET priced_model = excluded.priced_model
    `).bind(upstream, priced));
    return c.json({ ok: true });
  });

  return routes;
}
