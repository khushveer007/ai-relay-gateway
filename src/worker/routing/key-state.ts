import { invalidateConfig, isProtectedKeyStatus, patchCachedKey } from '../db/cache';
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
 * Applies a key-state patch and returns whether D1 accepted it. Unforced writes protect both the caller's
 * snapshot and the live cache, with a SQL guard for drops seen by another isolate. Only explicit Re-enable
 * bypasses the guards. A transition to active waits for D1 before exposing the key in this isolate.
 */
export async function applyKeyPatch(
  env: Env,
  key: ProviderKey,
  patch: KeyStatePatch,
  now = Date.now(),
  force = false,
): Promise<boolean> {
  const activate = patch.status === 'active';
  const update = { ...patch, status_changed_at: now };
  if (!force) {
    if (isProtectedKeyStatus(key.status)) return false;
    if (!patchCachedKey(key.id, activate ? undefined : update)) return false;
    if (!activate) Object.assign(key, update);
  }
  try {
    const [result] = await env.DB.batch([keyStateStmt(env.DB, key.id, patch, now, force), bumpVersionStmt(env.DB)]);
    const applied = (result.meta.changes ?? 0) > 0;
    if (activate || !applied) invalidateConfig();
    return applied;
  } catch (error) {
    invalidateConfig();
    throw error;
  }
}
