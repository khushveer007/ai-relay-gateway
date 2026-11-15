import type { Env } from '../types';

/** Aggregated usage/health statistics computed from request_logs over the last `hours`. */
export async function getStats(env: Env, hours: number) {
  const since = Date.now() - hours * 3_600_000;
  const bucketMs = hours <= 1 ? 60_000 * 5 : hours <= 24 ? 3_600_000 : 6 * 3_600_000;
  const db = env.DB;

  const [totals, byProvider, byKey, byModel, series, actions, keyActions] = await db.batch([
    db
      .prepare(
        `SELECT COUNT(*) AS requests,
                SUM(CASE WHEN status >= 200 AND status < 300 THEN 1 ELSE 0 END) AS ok,
                SUM(CASE WHEN failovers > 0 THEN 1 ELSE 0 END) AS failovered,
                COALESCE(SUM(input_tokens), 0) AS input_tokens,
                COALESCE(SUM(output_tokens), 0) AS output_tokens,
                COALESCE(SUM(cache_tokens), 0) AS cache_tokens,
                CAST(AVG(latency_ms) AS INTEGER) AS avg_latency,
                CAST(AVG(ttfb_ms) AS INTEGER) AS avg_ttfb
           FROM request_logs WHERE ts >= ?`,
      )
      .bind(since),
    db
      .prepare(
        `SELECT provider_id, COUNT(*) AS requests,
                SUM(CASE WHEN status >= 200 AND status < 300 THEN 1 ELSE 0 END) AS ok,
                COALESCE(SUM(input_tokens), 0) AS input_tokens, COALESCE(SUM(output_tokens), 0) AS output_tokens,
                CAST(AVG(ttfb_ms) AS INTEGER) AS avg_ttfb
           FROM request_logs WHERE ts >= ? AND provider_id IS NOT NULL GROUP BY provider_id ORDER BY requests DESC`,
      )
      .bind(since),
    db
      .prepare(
        `SELECT key_id, COUNT(*) AS requests, COALESCE(SUM(input_tokens), 0) AS input_tokens,
                COALESCE(SUM(output_tokens), 0) AS output_tokens, MAX(ts) AS last_used
           FROM request_logs WHERE ts >= ? AND key_id IS NOT NULL GROUP BY key_id`,
      )
      .bind(since),
    db
      .prepare(
        `SELECT model, COUNT(*) AS requests, COALESCE(SUM(input_tokens), 0) AS input_tokens,
                COALESCE(SUM(output_tokens), 0) AS output_tokens
           FROM request_logs WHERE ts >= ? AND model IS NOT NULL GROUP BY model ORDER BY requests DESC LIMIT 15`,
      )
      .bind(since),
    db
      .prepare(
        `SELECT CAST(ts / ? AS INTEGER) * ? AS bucket, COUNT(*) AS requests,
                SUM(CASE WHEN status >= 200 AND status < 300 THEN 0 ELSE 1 END) AS errors,
                SUM(CASE WHEN failovers > 0 THEN 1 ELSE 0 END) AS failovers,
                COALESCE(SUM(output_tokens), 0) AS output_tokens
           FROM request_logs WHERE ts >= ? GROUP BY bucket ORDER BY bucket`,
      )
      .bind(bucketMs, bucketMs, since),
    db
      .prepare(
        `SELECT json_extract(a.value, '$.action') AS action, COUNT(*) AS count
           FROM request_logs r, json_each(r.attempts) a
          WHERE r.ts >= ? GROUP BY action ORDER BY count DESC`,
      )
      .bind(since),
    db
      .prepare(
        `SELECT json_extract(a.value, '$.key_id') AS key_id, json_extract(a.value, '$.action') AS action, COUNT(*) AS count
           FROM request_logs r, json_each(r.attempts) a
          WHERE r.ts >= ? AND json_extract(a.value, '$.action') != 'OK' GROUP BY key_id, action`,
      )
      .bind(since),
  ]);

  return {
    hours,
    bucket_ms: bucketMs,
    since,
    totals: totals.results[0] ?? {},
    by_provider: byProvider.results,
    by_key: byKey.results,
    by_model: byModel.results,
    series: series.results,
    actions: actions.results,
    key_failures: keyActions.results,
  };
}
