import { useSyncExternalStore } from 'react';
import { infiniteQueryOptions } from '@tanstack/react-query';
import { api, type LogRowDTO } from '@/lib/api';
import { filtersToParams, getLogFilters, subscribeLogFilters, type LogFilters } from '@/lib/logs-filters';

export interface LogsPage {
  logs: LogRowDTO[];
  next_before: number | null;
}

// D-23, T-02-27: logs load when the page opens and when Refresh is pressed, and never on their own.
// staleTime Infinity plus no refetch on focus or reconnect means returning to the tab never discards
// the older pages already loaded; gcTime 0 drops the cache on leaving the page, so re-opening fetches
// page 1 only instead of replaying every loaded page. There is no timer-driven refetch anywhere.
export const logsQuery = (filters: LogFilters) =>
  infiniteQueryOptions({
    queryKey: ['logs', filters],
    queryFn: ({ pageParam }) => api.get<LogsPage>('/logs?' + filtersToParams(filters, pageParam)),
    initialPageParam: undefined as number | undefined,
    getNextPageParam: (last) => last.next_before ?? undefined,
    staleTime: Infinity,
    gcTime: 0,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });

/** The in-memory filters (D-21), re-rendering the owner when they change. */
export function useLogFilters(): LogFilters {
  return useSyncExternalStore(subscribeLogFilters, getLogFilters, getLogFilters);
}
