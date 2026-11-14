import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getPlatformProxy } from 'wrangler';
import migration from '../migrations/0001_init.sql?raw';
import { getStats } from '../src/worker/admin/stats';
import type { Env } from '../src/worker/types';

// Runs getStats against real local D1 (workerd via wrangler). D1 binds JS numbers as REAL, so
// SQLite's integer-vs-real division only shows up on a real engine — a hand-written fake DB
// cannot reproduce it.
describe('Stats series bucketing (real local D1)', () => {
  let proxy: Awaited<ReturnType<typeof getPlatformProxy<Env>>>;

  beforeAll(async () => {
    proxy = await getPlatformProxy<Env>({ persist: false });
    const ddl = migration.match(/CREATE TABLE request_logs \([\s\S]*?\n\);/)?.[0];
    if (!ddl) throw new Error('request_logs DDL not found in migrations/0001_init.sql');
    await proxy.env.DB.prepare(ddl.replace(/--.*$/gm, '')).run();
  }, 60_000);

  afterAll(async () => {
    await proxy?.dispose();
  });

  it('groups requests from the same hour into one bucket aligned to bucket_ms', async () => {
    const hour = 3_600_000;
    const start = Math.floor(Date.now() / hour) * hour - 3 * hour;
    const db = proxy.env.DB;
    await db.batch(
      [start + 1_000, start + 2_000, start + 3_000, start + hour + 5_000].map((ts) =>
        db.prepare('INSERT INTO request_logs (ts, status) VALUES (?, 200)').bind(ts),
      ),
    );

    const stats = await getStats(proxy.env, 24);

    expect(stats.bucket_ms).toBe(hour);
    expect(stats.series).toEqual([
      expect.objectContaining({ bucket: start, requests: 3 }),
      expect.objectContaining({ bucket: start + hour, requests: 1 }),
    ]);
  });
});
