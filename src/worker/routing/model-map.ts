import type { Provider } from '../types';

const globCache = new Map<string, RegExp>();

/** Case-insensitive glob match supporting `*` and `?`. */
export function globMatch(pattern: string, value: string): boolean {
  let re = globCache.get(pattern);
  if (!re) {
    const src = pattern
      .trim()
      .split('')
      .map((ch) => (ch === '*' ? '.*' : ch === '?' ? '.' : ch.replace(/[.+^${}()|[\]\\]/g, '\\$&')))
      .join('');
    re = new RegExp(`^${src}$`, 'i');
    if (globCache.size > 500) globCache.clear();
    globCache.set(pattern, re);
  }
  return re.test(value);
}

/** Resolves the upstream model name: exact mapping first, then glob mappings in insertion order. */
export function mapModel(provider: Provider, model: string): string {
  const map = provider.model_map;
  if (Object.prototype.hasOwnProperty.call(map, model) && map[model]) return map[model];
  for (const [pattern, target] of Object.entries(map)) {
    if ((pattern.includes('*') || pattern.includes('?')) && target && globMatch(pattern, model)) return target;
  }
  return model;
}

function hasMapping(provider: Provider, model: string): boolean {
  return mapModel(provider, model) !== model || Object.prototype.hasOwnProperty.call(provider.model_map, model);
}

/** Whether a provider can serve the requested client model. */
export function supportsModel(provider: Provider, model: string | null): boolean {
  if (!model) return true;
  if (hasMapping(provider, model)) return true;
  if (!provider.model_allowlist) return true;
  return provider.models.includes(model);
}
