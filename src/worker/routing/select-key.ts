import type { Provider, ProviderKey } from '../types';

/** A key is usable when active, or rate-limited with an expired cooldown. */
export function isUsable(key: ProviderKey, now = Date.now()): boolean {
  if (key.status === 'active') return true;
  if (key.status === 'rate_limited') return (key.cooldown_until ?? 0) <= now;
  return false;
}

// Round-robin cursor lives in memory (per isolate) so it never costs a D1 write.
const rrCursor = new Map<number, number>();

/**
 * Returns usable keys in the order they should be tried.
 * - sequential:  by priority; always starts with the first healthy key
 * - round_robin: same set, rotated by one on every request
 */
export function orderKeys(provider: Provider, keys: ProviderKey[], now = Date.now()): ProviderKey[] {
  const usable = keys.filter((k) => isUsable(k, now)).sort((a, b) => a.priority - b.priority || a.id - b.id);
  if (provider.key_strategy !== 'round_robin' || usable.length < 2) return usable;
  const cursor = rrCursor.get(provider.id) ?? 0;
  rrCursor.set(provider.id, cursor + 1);
  const start = cursor % usable.length;
  return [...usable.slice(start), ...usable.slice(0, start)];
}
