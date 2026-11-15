// Pure log filter model: no imports, so Vitest and the Worker tsconfig can load it.

export interface LogFilters {
  provider_id: string;
  gateway_key_id: string;
  /** '' (all), 'ok', 'failover' or 'error': sent to GET /logs verbatim. */
  status: string;
  model: string;
}

export const EMPTY_LOG_FILTERS: LogFilters = { provider_id: '', gateway_key_id: '', status: '', model: '' };

export const LOG_PAGE_SIZE = 50;

/** The query string for GET /logs: 50 rows, each non-empty filter, and the before cursor when paging. */
export function filtersToParams(filters: LogFilters, before?: number): string {
  const params = new URLSearchParams({ limit: String(LOG_PAGE_SIZE) });
  if (filters.provider_id) params.set('provider_id', filters.provider_id);
  if (filters.gateway_key_id) params.set('gateway_key_id', filters.gateway_key_id);
  if (filters.status) params.set('status', filters.status);
  if (filters.model) params.set('model', filters.model);
  if (before !== undefined) params.set('before', String(before));
  return params.toString();
}

/** How many of the four filters are set. */
export function activeFilterCount(filters: LogFilters): number {
  return [filters.provider_id, filters.gateway_key_id, filters.status, filters.model].filter((v) => v !== '').length;
}

/** The model line of a log row: the model, '→ upstream' only when it differs, the path when there is no model. */
export function logModelLine(row: { model: string | null; upstream_model: string | null; path: string }): string {
  if (!row.model) return row.path;
  return row.upstream_model && row.upstream_model !== row.model ? `${row.model} → ${row.upstream_model}` : row.model;
}

// In-memory store (D-21): filters survive leaving the page and reset on a reload. Replaced, never mutated,
// so useSyncExternalStore sees a new reference on every change.
let current: LogFilters = EMPTY_LOG_FILTERS;
const listeners = new Set<() => void>();

export function getLogFilters(): LogFilters {
  return current;
}

export function setLogFilters(next: LogFilters): void {
  current = { ...next };
  for (const l of [...listeners]) l();
}

export function clearLogFilters(): void {
  current = EMPTY_LOG_FILTERS;
  for (const l of [...listeners]) l();
}

export function subscribeLogFilters(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
