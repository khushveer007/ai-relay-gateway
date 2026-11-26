const DAY_MS = 86_400_000;

function utcMidnight(time: number): number {
  return Math.floor(time / DAY_MS) * DAY_MS;
}

export async function rollupCompletedDays(db: D1Database, scheduledTime: number): Promise<void> {
  const midnight = utcMidnight(scheduledTime);
  // Newly closed days and late arrivals are disjoint by ID. Both statements share the D1 transaction snapshot.
  const [, progress] = await db.batch([
    db.prepare(`WITH bounds AS (
      SELECT before_day_ms, through_request_id, MAX(before_day_ms, ?1) AS next_day_ms,
             MAX(through_request_id, COALESCE((SELECT MAX(id) FROM request_logs), 0)) AS next_request_id
      FROM cost_rollup_progress WHERE id = 1
    ), delta AS (
      SELECT logs.* FROM bounds JOIN request_logs AS logs
        ON logs.id <= through_request_id AND logs.ts >= before_day_ms AND logs.ts < next_day_ms
      UNION ALL
      SELECT logs.* FROM bounds JOIN request_logs AS logs
        ON logs.id > through_request_id AND logs.id <= next_request_id AND logs.ts < next_day_ms
    )
    INSERT INTO daily_cost_rollup (
      day_start_ms, upstream_model, provider_id, gateway_key_id, request_count,
      priced_count, unpriced_count, no_usage_count, legacy_count, cost_nano_usd,
      cache_read_tokens, cache_write_tokens, cache_read_savings_nano_usd, cache_savings_known_count
    )
    SELECT ts - ts % ${DAY_MS}, COALESCE(upstream_model, ''), COALESCE(provider_id, 0), COALESCE(gateway_key_id, 0),
      COUNT(*), COUNT(cost_nano_usd),
      COUNT(CASE WHEN cost_nano_usd IS NULL AND cost_reason = 'unpriced' THEN 1 END),
      COUNT(CASE WHEN cost_nano_usd IS NULL AND cost_reason = 'no_usage' THEN 1 END),
      COUNT(CASE WHEN cost_nano_usd IS NULL AND cost_reason IS NULL THEN 1 END),
      COALESCE(SUM(cost_nano_usd), 0), COALESCE(SUM(cache_tokens), 0), COALESCE(SUM(cache_write_tokens), 0),
      COALESCE(SUM(cache_read_savings_nano_usd), 0), COUNT(cache_read_savings_nano_usd)
    FROM delta
    GROUP BY 1, 2, 3, 4
    ON CONFLICT (day_start_ms, upstream_model, provider_id, gateway_key_id) DO UPDATE SET
      request_count = request_count + excluded.request_count,
      priced_count = priced_count + excluded.priced_count,
      unpriced_count = unpriced_count + excluded.unpriced_count,
      no_usage_count = no_usage_count + excluded.no_usage_count,
      legacy_count = legacy_count + excluded.legacy_count,
      cost_nano_usd = cost_nano_usd + excluded.cost_nano_usd,
      cache_read_tokens = cache_read_tokens + excluded.cache_read_tokens,
      cache_write_tokens = cache_write_tokens + excluded.cache_write_tokens,
      cache_read_savings_nano_usd = cache_read_savings_nano_usd + excluded.cache_read_savings_nano_usd,
      cache_savings_known_count = cache_savings_known_count + excluded.cache_savings_known_count`).bind(midnight),
    db.prepare(`UPDATE cost_rollup_progress
      SET before_day_ms = MAX(before_day_ms, ?1),
          through_request_id = MAX(through_request_id, COALESCE((SELECT MAX(id) FROM request_logs), 0))
      WHERE id = 1`).bind(midnight),
  ]);
  if (progress.meta.changes !== 1) throw new Error('Cost rollup progress row is missing');
}

export async function cleanupRolledLogs(db: D1Database, scheduledTime: number): Promise<number> {
  const row = await db.prepare("SELECT value FROM settings WHERE key = 'log_retention_days'").first<{ value: string }>();
  const days = Number(row?.value ?? 7);
  const retentionDays = Number.isInteger(days) ? Math.max(1, days) : 7;
  const cutoff = utcMidnight(scheduledTime) - retentionDays * DAY_MS;
  const result = await db.prepare(`DELETE FROM request_logs
    WHERE ts < (SELECT MIN(before_day_ms, ?1) FROM cost_rollup_progress WHERE id = 1)
      AND id <= (SELECT through_request_id FROM cost_rollup_progress WHERE id = 1)`).bind(cutoff).run();
  return result.meta.changes ?? 0;
}
