import { checkBalance, testKey } from './balance';
import { invalidateConfig } from './db/cache';
import { cleanupRolledLogs, rollupCompletedDays } from './db/cost-rollup';
import { bumpVersionStmt, loadConfig } from './db/repo';
import { ACTIVE_PATCH, applyKeyPatch, patchForAction } from './routing/key-state';
import type { Config, Env, Provider, ProviderKey } from './types';

// Cron invocations on the free plan also get 50 subrequests. A standard balance check uses 2, a test request 1.
const MAX_RECHECKS_PER_RUN = 8;
const MAX_BALANCE_REFRESH_PER_RUN = 8;

export interface RecheckOutcome {
  key_id: number;
  result: 'reactivated' | 'still_exhausted' | 'skipped';
  detail: string;
}

/**
 * Re-checks an exhausted key:
 *   1. balance endpoint (if the provider has one): balance > 0 → reactivate
 *   2. auto mode only: if no balance info, send a 1-token test request
 *   3. otherwise stay exhausted and schedule the next check
 *
 * The admin recheck endpoint can hand this function any key, so a key that is not exhausted (including a
 * dropped `invalid` key) is skipped before any balance request or write (DROP-02). The direct UPDATEs below
 * also filter on status, so a drop that lands during the balance request is not overwritten.
 */
export async function recheckKey(env: Env, config: Config, provider: Provider, key: ProviderKey): Promise<RecheckOutcome> {
  if (key.status !== 'exhausted') return { key_id: key.id, result: 'skipped', detail: 'key is ' + key.status };
  const skipped: RecheckOutcome = { key_id: key.id, result: 'skipped', detail: 'Key state changed during recheck.' };
  const now = Date.now();
  const bal = await checkBalance(env, provider, key);
  if (bal.balance !== null) {
    await env.DB.prepare("UPDATE provider_keys SET balance = ?, balance_checked_at = ? WHERE id = ? AND status = 'exhausted'")
      .bind(bal.balance, now, key.id)
      .run();
  }
  if (bal.balance !== null && bal.balance > 0) {
    if (!(await applyKeyPatch(env, key, ACTIVE_PATCH))) return skipped;
    return { key_id: key.id, result: 'reactivated', detail: `balance ${bal.balance}` };
  }

  let detail = bal.balance !== null ? `balance ${bal.balance}` : `no balance info${bal.error ? ` (${bal.error})` : ''}`;
  if (bal.balance === null && provider.recheck_mode === 'auto') {
    const t = await testKey(env, provider, key, config.rules);
    if (t.ok) {
      if (!(await applyKeyPatch(env, key, ACTIVE_PATCH))) return skipped;
      return { key_id: key.id, result: 'reactivated', detail: `test request ok (${t.ms} ms)` };
    }
    detail += `; test: ${t.message}`;
    if (t.cls && t.cls.action !== 'EXHAUSTED') {
      const patch = patchForAction(provider, t.cls.action, t.cls.reason, t.cls.cooldownS, t.status, now);
      if (patch) {
        if (!(await applyKeyPatch(env, key, patch))) return skipped;
        return { key_id: key.id, result: 'still_exhausted', detail };
      }
    }
  }

  const scheduled = await env.DB.prepare("UPDATE provider_keys SET next_recheck_at = ? WHERE id = ? AND status = 'exhausted'")
    .bind(now + provider.recheck_hours * 3_600_000, key.id)
    .run();
  if (scheduled.meta.changes === 0) return skipped;
  return { key_id: key.id, result: 'still_exhausted', detail };
}

export async function runMaintenance(env: Env): Promise<{ cooldowns: number; rechecks: RecheckOutcome[]; balances: number }> {
  const now = Date.now();

  // 1. Expired rate-limit cooldowns → active
  const cleared = await env.DB.prepare(
    `UPDATE provider_keys SET status = 'active', status_reason = NULL, cooldown_until = NULL, status_changed_at = ?
      WHERE status = 'rate_limited' AND cooldown_until IS NOT NULL AND cooldown_until <= ?`,
  )
    .bind(now, now)
    .run();
  const cooldowns = cleared.meta.changes ?? 0;
  if (cooldowns > 0) await bumpVersionStmt(env.DB).run();

  const config = await loadConfig(env.DB);

  // 2. Due re-checks of exhausted keys
  const due: Array<[Provider, ProviderKey]> = [];
  for (const [pid, keys] of config.keysByProvider) {
    const p = config.providers.get(pid);
    if (!p || !p.enabled || p.recheck_mode === 'manual') continue;
    for (const k of keys) {
      if (k.status === 'exhausted' && k.next_recheck_at !== null && k.next_recheck_at <= now) due.push([p, k]);
    }
  }
  due.sort((a, b) => (a[1].next_recheck_at ?? 0) - (b[1].next_recheck_at ?? 0));
  const rechecks: RecheckOutcome[] = [];
  for (const [p, k] of due.slice(0, MAX_RECHECKS_PER_RUN)) {
    try {
      rechecks.push(await recheckKey(env, config, p, k));
    } catch (e) {
      rechecks.push({ key_id: k.id, result: 'skipped', detail: (e as Error).message });
    }
  }

  // 3. Periodic balance refresh for active keys
  const staleBefore = now - config.settings.balance_refresh_hours * 3_600_000;
  const stale: Array<[Provider, ProviderKey]> = [];
  for (const [pid, keys] of config.keysByProvider) {
    const p = config.providers.get(pid);
    if (!p || !p.enabled || p.balance_mode === 'none') continue;
    for (const k of keys) {
      if (k.status === 'active' && (k.balance_checked_at ?? 0) < staleBefore) stale.push([p, k]);
    }
  }
  stale.sort((a, b) => (a[1].balance_checked_at ?? 0) - (b[1].balance_checked_at ?? 0));
  let balances = 0;
  for (const [p, k] of stale.slice(0, MAX_BALANCE_REFRESH_PER_RUN)) {
    const bal = await checkBalance(env, p, k).catch(() => null);
    // Record the attempt time even when unsupported so we don't retry every 15 min. The status predicate means a
    // key that dropped while its balance request was in flight keeps its whole row unchanged (DROP-02).
    const written = await env.DB.prepare(
      "UPDATE provider_keys SET balance = COALESCE(?, balance), balance_checked_at = ? WHERE id = ? AND status = 'active'",
    )
      .bind(bal?.balance ?? null, now, k.id)
      .run();
    if ((written.meta.changes ?? 0) > 0) balances++;
  }

  invalidateConfig();
  return { cooldowns, rechecks, balances };
}

export async function scheduled(event: ScheduledController, env: Env): Promise<void> {
  if (event.cron === '0 3 * * *') {
    await rollupCompletedDays(env.DB, event.scheduledTime);
    const deleted = await cleanupRolledLogs(env.DB, event.scheduledTime);
    console.log(`log cleanup: deleted ${deleted} rows`);
    return;
  }
  const r = await runMaintenance(env);
  console.log(`maintenance: ${r.cooldowns} cooldowns cleared, ${r.rechecks.length} rechecks, ${r.balances} balances refreshed`);
}
