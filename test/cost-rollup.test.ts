import { afterEach, beforeEach, expect, it } from 'vitest';
import { getPlatformProxy, unstable_splitSqlQuery } from 'wrangler';
import initial from '../migrations/0001_init.sql?raw';
import keyDrop from '../migrations/0002_key_drop.sql?raw';
import costMigration from '../migrations/0003_cost_capture.sql?raw';
import { cleanupRolledLogs } from '../src/worker/db/cost-rollup';
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

function progress() {
  return db.prepare('SELECT before_day_ms, through_request_id FROM cost_rollup_progress WHERE id = 1').first();
}

function addLog(ts: number, model: string, cost: number) {
  return db.prepare('INSERT INTO request_logs (ts, upstream_model, cost_nano_usd) VALUES (?, ?, ?)')
    .bind(ts, model, cost).run();
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

it('reruns empty, concurrent, and stale events without regressing or double counting', async () => {
  await Promise.all([schedule(), schedule()]);
  expect(await progress()).toEqual({ before_day_ms: TODAY, through_request_id: 0 });
  await addLog(OLD, 'maintenance-check', 1);
  await schedule(DAILY, '*/15 * * * *');
  expect(await groups()).toEqual([]);
  expect(await timestamps()).toEqual([OLD]);
  await Promise.all([schedule(), schedule(), schedule()]);
  expect(await groups()).toEqual([expect.objectContaining({ request_count: 1, cost_nano_usd: 1 })]);
  expect(await timestamps()).toEqual([]);
  await schedule();
  await addLog(TODAY, 'closed-after-midnight', 7);
  await schedule();
  await expect(db.prepare('DELETE FROM request_logs WHERE ts = ?').bind(TODAY).run()).rejects.toThrow('cost_rollup_required');
  await schedule(DAILY + DAY);
  const committed = await progress();
  expect(committed).toEqual({ before_day_ms: TODAY + DAY, through_request_id: 2 });
  await schedule(DAILY - DAY);
  expect(await progress()).toEqual(committed);
  expect(await groups()).toEqual([
    expect.objectContaining({ request_count: 1, cost_nano_usd: 1 }),
    expect.objectContaining({ request_count: 1, cost_nano_usd: 7 }),
  ]);
});

it('retains rolled detail and rolls back the new delta when progress cannot commit', async () => {
  const becomesOld = TODAY - 7 * DAY;
  await addLog(becomesOld, 'already-rolled', 5);
  await schedule();
  const beforeGroups = await groups();
  const beforeProgress = await progress();
  await addLog(OLD, 'new-delta', 2);
  await db.prepare(`CREATE TRIGGER abort_progress BEFORE UPDATE ON cost_rollup_progress
    WHEN EXISTS (SELECT 1 FROM daily_cost_rollup WHERE upstream_model = 'new-delta')
    BEGIN SELECT RAISE(ABORT, 'fixture_progress_failure'); END`).run();

  await expect(schedule(DAILY + DAY)).rejects.toThrow('fixture_progress_failure');
  expect(await groups()).toEqual(beforeGroups);
  expect(await progress()).toEqual(beforeProgress);
  expect(await timestamps()).toEqual([OLD, becomesOld]);

  await db.prepare(`CREATE TRIGGER abort_cleanup BEFORE DELETE ON request_logs
    BEGIN SELECT RAISE(ABORT, 'fixture_cleanup_failure'); END`).run();
  await db.prepare('DROP TRIGGER abort_progress').run();
  await expect(schedule(DAILY + DAY)).rejects.toThrow('fixture_cleanup_failure');
  const committed = await groups();
  expect(committed).toEqual([
    expect.objectContaining({ upstream_model: 'new-delta', request_count: 1, cost_nano_usd: 2 }),
    expect.objectContaining({ upstream_model: 'already-rolled', request_count: 1, cost_nano_usd: 5 }),
  ]);
  expect(await progress()).toEqual({ before_day_ms: TODAY + DAY, through_request_id: 2 });
  expect(await timestamps()).toEqual([OLD, becomesOld]);

  await db.prepare('DROP TRIGGER abort_cleanup').run();
  await schedule(DAILY + DAY);
  expect(await groups()).toEqual(committed);
  expect(await timestamps()).toEqual([]);
});

it('adds late stream logs from retained and purged days exactly once', async () => {
  const retained = TODAY - DAY;
  await addLog(OLD, 'late', 11);
  await addLog(retained, 'late', 7);
  await schedule();
  expect(await timestamps()).toEqual([retained]);
  expect(await progress()).toEqual({ before_day_ms: TODAY, through_request_id: 2 });

  await addLog(OLD + 1, 'late', 13);
  await addLog(retained + 1, 'late', 5);
  await expect(db.prepare('DELETE FROM request_logs WHERE ts = ?').bind(OLD + 1).run()).rejects.toThrow('cost_rollup_required');
  expect(await cleanupRolledLogs(db, DAILY)).toBe(0);
  expect(await timestamps()).toEqual([OLD + 1, retained, retained + 1]);
  await Promise.all([schedule(), schedule()]);
  expect(await groups()).toEqual([
    expect.objectContaining({ day_start_ms: OLD, request_count: 2, cost_nano_usd: 24 }),
    expect.objectContaining({ day_start_ms: retained, request_count: 2, cost_nano_usd: 12 }),
  ]);
  expect(await timestamps()).toEqual([retained, retained + 1]);
});

it('blocks the old Worker delete during the migration overlap and rolls its old-format log', async () => {
  await db.prepare("INSERT INTO request_logs (ts, upstream_model, input_tokens) VALUES (?, 'old-worker', 17)").bind(OLD).run();
  await expect(db.prepare('DELETE FROM request_logs WHERE ts < ?').bind(DAILY - 7 * DAY).run())
    .rejects.toThrow('cost_rollup_required');
  expect(await timestamps()).toEqual([OLD]);
  await schedule();
  expect(await groups()).toEqual([expect.objectContaining({ upstream_model: 'old-worker', legacy_count: 1, priced_count: 0 })]);
  expect(await timestamps()).toEqual([]);
});

it('retains source detail if progress is missing or integer cost overflows', async () => {
  await db.prepare(`INSERT INTO request_logs (ts, upstream_model, cost_nano_usd)
    VALUES (?1, 'large', 9223372036854775807)`).bind(OLD).run();
  await db.prepare('DELETE FROM cost_rollup_progress').run();
  await expect(schedule()).rejects.toThrow('Cost rollup progress row is missing');
  expect(await cleanupRolledLogs(db, DAILY)).toBe(0);
  expect(await timestamps()).toEqual([OLD]);
  expect(await groups()).toEqual([]);

  await db.prepare('INSERT INTO cost_rollup_progress VALUES (1, 0, 0)').run();
  await addLog(OLD + 1, 'large', 1);
  await expect(schedule()).rejects.toThrow('integer overflow');
  expect(await groups()).toEqual([]);
  expect(await progress()).toEqual({ before_day_ms: 0, through_request_id: 0 });
  expect(await timestamps()).toEqual([OLD, OLD + 1]);
});

it('uses a whole-day retention cutoff and keeps at least one preceding UTC day', async () => {
  await db.prepare("UPDATE settings SET value = '0' WHERE key = 'log_retention_days'").run();
  await addLog(TODAY - DAY - 1, 'expired', 2);
  await addLog(TODAY - DAY, 'retained', 3);
  await addLog(TODAY, 'live', 4);
  await schedule();
  expect(await timestamps()).toEqual([TODAY - DAY, TODAY]);
  expect(await groups()).toEqual([
    expect.objectContaining({ upstream_model: 'expired', cost_nano_usd: 2 }),
    expect.objectContaining({ upstream_model: 'retained', cost_nano_usd: 3 }),
  ]);
});
