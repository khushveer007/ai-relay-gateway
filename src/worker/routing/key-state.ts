import { invalidateConfig, patchCachedKey } from '../db/cache';
import { bumpVersionStmt, keyStateStmt, type KeyStatePatch } from '../db/repo';
import type { Action, Env, Provider, ProviderKey } from '../types';

/**
 * Translates a classified failure into a key-state change (or null when the key should not be penalized).
 * `status` is the HTTP status the relay answered, or 200 when the error was found inside a 2xx body. An INVALID_KEY
 * drop stores it as `status_code`, so the key card can show "HTTP 403 · message · dropped 3h ago". Other actions
 * store null, and a drop never stores 0: a network failure (status 0) stores null.
 */
export function patchForAction(
  provider: Provider,
  action: Action,
  reason: string,
  cooldownS: number | null,
  status: number,
  now = Date.now(),
): KeyStatePatch | null {
  switch (action) {
    case 'EXHAUSTED':
      return {
        status: 'exhausted',
        status_reason: reason.slice(0, 300),
        status_code: null,
        cooldown_until: null,
        next_recheck_at: provider.recheck_mode !== 'manual' ? now + provider.recheck_hours * 3_600_000 : null,
      };
    case 'INVALID_KEY':
      return {
        status: 'invalid',
        status_reason: reason.slice(0, 300),
        status_code: status > 0 ? status : null,
        cooldown_until: null,
        next_recheck_at: null,
      };
    case 'RATE_LIMITED':
      return {
        status: 'rate_limited',
        status_reason: reason.slice(0, 300),
        status_code: null,
        cooldown_until: now + (cooldownS ?? 60) * 1000,
        next_recheck_at: null,
      };
    default:
      return null;
  }
}

export const ACTIVE_PATCH: KeyStatePatch = {
  status: 'active',
  status_reason: null,
  status_code: null,
  cooldown_until: null,
  next_recheck_at: null,
};

/**
 * Applies a key-state patch: instantly in this isolate's memory, durably in D1, and bumps the config version so
 * other isolates refresh within ~30 s. Returns the DB promise (pass it to ctx.waitUntil on hot paths).
 *
 * A dropped (`invalid`) or `disabled` key is protected. Without `force`, the call returns before any memory
 * change or D1 call, and the SQL guard in keyStateStmt refuses the write when D1 holds a drop this isolate
 * has not seen. Only the explicit admin Re-enable passes `force = true` (DROP-03). Disable uses the default
 * guard, so it cannot overwrite a drop either.
 */
export function applyKeyPatch(
  env: Env,
  key: ProviderKey,
  patch: KeyStatePatch,
  now = Date.now(),
  force = false,
): Promise<unknown> {
  if (!force && (key.status === 'invalid' || key.status === 'disabled')) return Promise.resolve();
  Object.assign(key, patch, { status_changed_at: now });
  patchCachedKey(key.id, { ...patch, status_changed_at: now }, true);
  if (!env?.DB) return Promise.resolve();
  return env.DB.batch([keyStateStmt(env.DB, key.id, patch, now, force), bumpVersionStmt(env.DB)])
    .then((res) => {
      // D1 refused the write (the row is dropped in D1 but this isolate still had it active). The optimistic
      // copy above is wrong now, so discard the isolate cache and reload it from D1 on the next read.
      if (res[0]?.meta?.changes === 0) invalidateConfig();
    })
    .catch((e) => {
      console.error('key state write failed', e);
    });
}
