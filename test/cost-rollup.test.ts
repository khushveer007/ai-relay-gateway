import { afterEach, beforeEach, expect, it } from 'vitest';
import { getPlatformProxy, unstable_splitSqlQuery } from 'wrangler';
import initial from '../migrations/0001_init.sql?raw';
import keyDrop from '../migrations/0002_key_drop.sql?raw';
import costMigration from '../migrations/0003_cost_capture.sql?raw';
import worker from '../src/worker/index';
import type { Env } from '../src/worker/types';

const DAY = 86_400_000;
const TODAY = Date.UTC(2026, 10, 26);
const DAILY = TODAY + 3 * 3_600_000;
const OLD = TODAY - 8 * DAY;
let platform: Awaited<ReturnType<typeof getPlatformProxy<Env>>>;
let db: D1Database;

beforeEach(async () => {
  platform = await getPlatformProxy<Env>({ persist: false });
  db = platform.env.DB;
  for (const migration of [initial, keyDrop, costMigration]) {
    await db.batch(unstable_splitSqlQuery(migration).map((statement) => db.prepare(statement)));
  }
}, 60_000);

afterEach(async () => {
  await platform?.dispose();
});

async function schedule(scheduledTime = DAILY, cron = '0 3 * * *') {
  const pending: Promise<unknown>[] = [];
  await worker.scheduled({ cron, scheduledTime, noRetry() {} }, platform.env, {
    waitUntil: (promise: Promise<unknown>) => { pending.push(promise); },
  } as ExecutionContext);
  await Promise.all(pending);
}

async function groups() {
  const { results } = await db.prepare('SELECT * FROM daily_cost_rollup ORDER BY day_start_ms, upstream_model, provider_id, gateway_key_id').all();
  return results;
}

async function timestamps() {
  const { results } = await db.prepare('SELECT ts FROM request_logs ORDER BY ts').all<{ ts: number }>();
  return results.map(({ ts }) => ts);
}

it('rolls up completed UTC days before the scheduled retention cleanup', async () => {
  await db.batch([
    db.prepare("INSERT INTO providers (id, name, base_url) VALUES (11, 'local', 'https://example.test')"),
    db.prepare("INSERT INTO gateway_keys (id, name, key_hash, key_prefix) VALUES (21, 'local', 'fixture-hash', 'local')"),
    db.prepare(`INSERT INTO request_logs (ts, upstream_model, provider_id, gateway_key_id, cost_nano_usd, cost_reason,
                                          cache_tokens, cache_write_tokens, cache_read_savings_nano_usd)
      VALUES (?1, 'a-model', 11, 21, 19, NULL, 3, 4, -8),
             (?1, 'a-model', 11, 21, 0, NULL, 0, 0, 0),
             (?1, 'a-model', 11, 21, NULL, 'unpriced', 1, 2, NULL),
             (?1, 'a-model', 11, 21, NULL, 'no_usage', NULL, NULL, NULL),
             (?1, 'a-model', 11, 21, NULL, NULL, 1, NULL, NULL),
             (?1, 'a-model', 11, 22, 13, NULL, NULL, NULL, NULL),
             (?1, 'a-model', 12, 21, 17, NULL, NULL, NULL, NULL),
             (?1, 'z-model', 11, 21, 23, NULL, NULL, NULL, NULL),
             (?2, NULL, NULL, NULL, NULL, 'no_usage', NULL, NULL, NULL),
             (?3, 'retained', 11, 21, 31, NULL, NULL, NULL, NULL),
             (?4, 'current', 11, 21, 37, NULL, NULL, NULL, NULL),
             (?5, 'future', 11, 21, 41, NULL, NULL, NULL, NULL)`)
      .bind(OLD, TODAY - 7 * DAY, TODAY - 1, TODAY, TODAY + DAY),
  ]);
  // Capture the old Worker's error so the RED assertion reports the missing aggregate.
  const [firstRun] = await Promise.allSettled([schedule()]);
  expect(await groups()).toEqual([
    { day_start_ms: OLD, upstream_model: 'a-model', provider_id: 11, gateway_key_id: 21,
      request_count: 5, priced_count: 2, unpriced_count: 1, no_usage_count: 1, legacy_count: 1,
      cost_nano_usd: 19, cache_read_tokens: 5, cache_write_tokens: 6, cache_read_savings_nano_usd: -8,
      cache_savings_known_count: 2 },
    expect.objectContaining({ day_start_ms: OLD, upstream_model: 'a-model', provider_id: 11, gateway_key_id: 22, cost_nano_usd: 13 }),
    expect.objectContaining({ day_start_ms: OLD, upstream_model: 'a-model', provider_id: 12, gateway_key_id: 21, cost_nano_usd: 17 }),
    expect.objectContaining({ day_start_ms: OLD, upstream_model: 'z-model', provider_id: 11, gateway_key_id: 21, cost_nano_usd: 23 }),
    expect.objectContaining({ day_start_ms: TODAY - 7 * DAY, upstream_model: '', provider_id: 0, gateway_key_id: 0, no_usage_count: 1 }),
    expect.objectContaining({ day_start_ms: TODAY - DAY, upstream_model: 'retained', cost_nano_usd: 31 }),
  ]);
  expect(firstRun.status).toBe('fulfilled');
  expect(await timestamps()).toEqual([TODAY - 7 * DAY, TODAY - 1, TODAY, TODAY + DAY]);

  await db.batch([
    db.prepare('DELETE FROM providers WHERE id = 11'),
    db.prepare('DELETE FROM gateway_keys WHERE id = 21'),
  ]);
  await schedule(DAILY + DAY);
  expect(await groups()).toEqual(expect.arrayContaining([
    expect.objectContaining({ day_start_ms: OLD, upstream_model: 'a-model', provider_id: 11, gateway_key_id: 21, request_count: 5 }),
    expect.objectContaining({ day_start_ms: TODAY, upstream_model: 'current', provider_id: 11, gateway_key_id: 21, cost_nano_usd: 37 }),
  ]));
  expect(await timestamps()).toEqual([TODAY - 1, TODAY, TODAY + DAY]);
});
