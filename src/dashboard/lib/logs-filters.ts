// Pure log filter model: no imports, so Vitest and the Worker tsconfig can load it.
// RED stub: returns wrong values on purpose so the tests fail on their assertions.

export interface LogFilters {
  provider_id: string;
  gateway_key_id: string;
  status: string;
  model: string;
}

export const EMPTY_LOG_FILTERS: LogFilters = { provider_id: '', gateway_key_id: '', status: '', model: '' };

export function filtersToParams(_filters: LogFilters, _before?: number): string {
  return '';
}

export function activeFilterCount(_filters: LogFilters): number {
  return -1;
}

export function logModelLine(_row: { model: string | null; upstream_model: string | null; path: string }): string {
  return '';
}

export function getLogFilters(): LogFilters {
  return { provider_id: 'stub', gateway_key_id: 'stub', status: 'stub', model: 'stub' };
}

export function setLogFilters(_next: LogFilters): void {}

export function clearLogFilters(): void {}

export function subscribeLogFilters(_listener: () => void): () => void {
  return () => {};
}
