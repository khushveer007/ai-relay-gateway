import type { Config, Env, KeyStatus, ProviderKey } from '../types';
import { decrypt } from './crypto';
import { getConfigVersion, loadConfig } from './repo';

/**
 * Per-isolate config cache.
 * - Full config is loaded once, then only the version counter (1 row read) is checked every CHECK_MS.
 * - Admin edits and key-state changes bump the version, so other isolates pick them up within CHECK_MS.
 * - Edits made in this isolate invalidate immediately.
 */
const CHECK_MS = 30_000;

let cached: Config | null = null;
let checkedAt = 0;
let loading: Promise<Config> | null = null;
let epoch = 0;

function refreshConfig(env: Env): Promise<Config> {
  if (loading) return loading;
  const startEpoch = epoch;
  let p!: Promise<Config>;
  p = (async () => {
    try {
      if (cached) {
        const v = await getConfigVersion(env.DB);
        if (v === cached.version) {
          if (epoch === startEpoch) checkedAt = Date.now();
          return cached;
        }
      }
      let next: Config;
      try {
        next = await loadConfig(env.DB);
      } catch (firstErr) {
        if (cached) throw firstErr;
        // Cold-start transient D1 failure: retry once before giving up.
        next = await loadConfig(env.DB);
      }
      if (epoch === startEpoch) {
        cached = next;
        checkedAt = Date.now();
      }
      return next;
    } catch (err) {
      if (cached && epoch === startEpoch) {
        checkedAt = Date.now();
        return cached;
      }
      throw err;
    } finally {
      if (loading === p) loading = null;
    }
  })();
  loading = p;
  return p;
}

export async function getConfig(env: Env, ctx?: ExecutionContext): Promise<Config> {
  const now = Date.now();
  if (cached) {
    if (now - checkedAt < CHECK_MS) return cached;
    // Stale-while-revalidate on the proxy hot path: return warm config in 0 ms and refresh in the background.
    if (ctx) {
      checkedAt = now;
      ctx.waitUntil(refreshConfig(env).catch(() => {}));
      return cached;
    }
  }
  return refreshConfig(env);
}

export function invalidateConfig(): void {
  epoch++;
  cached = null;
  checkedAt = 0;
  loading = null;
  plainKeys.clear();
}

export function isProtectedKeyStatus(status: KeyStatus): boolean {
  return status === 'invalid' || status === 'disabled';
}

/** Checks the live key guard and applies an optimistic patch when provided. */
export function patchCachedKey(keyId: number, patch?: Partial<ProviderKey>): boolean {
  if (!cached) return true;
  for (const list of cached.keysByProvider.values()) {
    const k = list.find((x) => x.id === keyId);
    if (k) {
      if (isProtectedKeyStatus(k.status)) return false;
      if (patch) Object.assign(k, patch);
      break;
    }
  }
  if (patch) {
    cached.version += 1;
    cached.settings.config_version = cached.version;
  }
  return true;
}

const plainKeys = new Map<string, string>();
let lastEncSecret = '';

/** Decrypts an upstream key, memoized per ciphertext. */
export async function plainKey(env: Env, key: ProviderKey): Promise<string> {
  if (env.ENCRYPTION_KEY !== lastEncSecret) {
    plainKeys.clear();
    lastEncSecret = env.ENCRYPTION_KEY ?? '';
  }
  const hit = plainKeys.get(key.key_enc);
  if (hit !== undefined) return hit;
  const pt = await decrypt(key.key_enc, env.ENCRYPTION_KEY);
  if (plainKeys.size > 500) plainKeys.clear();
  plainKeys.set(key.key_enc, pt);
  return pt;
}
