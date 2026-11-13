import type { Config, Env, ProviderKey } from '../types';
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

export async function getConfig(env: Env): Promise<Config> {
  const now = Date.now();
  if (cached && now - checkedAt < CHECK_MS) return cached;
  if (loading) return loading;

  loading = (async () => {
    try {
      if (cached) {
        const v = await getConfigVersion(env.DB);
        if (v === cached.version) {
          checkedAt = Date.now();
          return cached;
        }
      }
      cached = await loadConfig(env.DB);
      checkedAt = Date.now();
      return cached;
    } finally {
      loading = null;
    }
  })();
  return loading;
}

export function invalidateConfig(): void {
  cached = null;
  checkedAt = 0;
}

/** Applies a key-state change to the in-memory config so this isolate reacts instantly. */
export function patchCachedKey(keyId: number, patch: Partial<ProviderKey>): void {
  if (!cached) return;
  for (const list of cached.keysByProvider.values()) {
    const k = list.find((x) => x.id === keyId);
    if (k) {
      Object.assign(k, patch);
      return;
    }
  }
}

const plainKeys = new Map<string, string>();

/** Decrypts an upstream key, memoized per ciphertext. */
export async function plainKey(env: Env, key: ProviderKey): Promise<string> {
  const hit = plainKeys.get(key.key_enc);
  if (hit !== undefined) return hit;
  const pt = await decrypt(key.key_enc, env.ENCRYPTION_KEY);
  if (plainKeys.size > 500) plainKeys.clear();
  plainKeys.set(key.key_enc, pt);
  return pt;
}
