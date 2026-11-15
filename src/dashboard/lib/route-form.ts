// Pure route form model and chain helpers (VIEW-03). No imports and no DOM: the Worker tsconfig
// type-checks every file a test imports.

/** Every field is text or a list while typing; the number is converted in buildRoutePayload. */
export interface RouteForm {
  name: string;
  position: string;
  /** Comma or new line separated. */
  patterns: string;
  /** The provider chain, first tried first. */
  provider_ids: number[];
}

/** The part of RouteDTO the form needs. */
export interface RouteDtoLike {
  name: string;
  model_patterns: string[];
  is_default: boolean;
  position: number;
  provider_ids: number[];
}

export interface ChainProvider {
  id: number;
}

export type RouteFormErrors = Partial<Record<'name' | 'position', string>>;

/** Comma or new line separated patterns, trimmed, blanks dropped. */
export function splitPatterns(text: string): string[] {
  return text
    .split(/[\n\r,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** A new route starts with every provider in provider order (same as master) and position 10. */
export function emptyRouteForm(providers: ChainProvider[]): RouteForm {
  return { name: '', position: '10', patterns: '', provider_ids: providers.map((p) => p.id) };
}

export function routeToForm(dto: RouteDtoLike): RouteForm {
  return {
    name: dto.name,
    position: String(dto.position),
    patterns: dto.model_patterns.join('\n'),
    provider_ids: [...dto.provider_ids],
  };
}

/**
 * The create and update body. It always carries the FULL provider_ids list, because the Worker
 * rewrites the whole chain. The default route's patterns field is disabled in the dialog, so its
 * existing patterns are sent back from the loaded route instead of the (empty) form text, or saving
 * would wipe them (research Pitfall 2).
 */
export function buildRoutePayload(form: RouteForm, dto?: RouteDtoLike): Record<string, unknown> {
  return {
    name: form.name.trim(),
    position: Number(form.position),
    model_patterns: dto?.is_default ? [...dto.model_patterns] : splitPatterns(form.patterns),
    provider_ids: [...form.provider_ids],
  };
}

/** Swap the item at `index` with its neighbour; at either end the order is returned unchanged. A copy, never the input. */
export function moveChainItem(ids: number[], index: number, delta: -1 | 1): number[] {
  const next = [...ids];
  const to = index + delta;
  if (index < 0 || index >= next.length || to < 0 || to >= next.length) return next;
  [next[index], next[to]] = [next[to], next[index]];
  return next;
}

export function removeFromChain(ids: number[], id: number): number[] {
  return ids.filter((x) => x !== id);
}

/** Append at the end; an id already in the chain is not added twice. */
export function addToChain(ids: number[], id: number): number[] {
  return ids.includes(id) ? [...ids] : [...ids, id];
}

/** The providers the "Add a provider…" select still offers. */
export function availableProviders<T extends ChainProvider>(providers: T[], ids: number[]): T[] {
  return providers.filter((p) => !ids.includes(p.id));
}

/** Inline errors; the ranges mirror the Worker's, which still validates. */
export function validateRouteForm(form: RouteForm): RouteFormErrors {
  const errors: RouteFormErrors = {};
  const name = form.name.trim();
  if (!name) errors.name = 'Enter a route name.';
  else if (name.length > 60) errors.name = 'Use 60 characters or fewer.';
  const position = form.position.trim();
  const n = Number(position);
  if (position === '' || !Number.isFinite(n) || n < 0 || n > 100000) errors.position = 'Enter a position between 0 and 100000.';
  return errors;
}
