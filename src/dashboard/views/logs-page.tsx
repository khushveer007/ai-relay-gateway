import { useMemo, useState } from 'react';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { PageError } from '@/components/page-error';
import { PageHeader } from '@/components/page-header';
import { ResponsiveList } from '@/components/responsive-list';
import { useLoadErrorToast } from '@/hooks/use-load-error-toast';
import { logsQuery, useLogFilters } from '@/hooks/use-logs';
import type { LogRowDTO } from '@/lib/api';
import { activeFilterCount, clearLogFilters } from '@/lib/logs-filters';
import { gatewayKeysQuery, providersQuery, routesQuery } from '@/lib/queries';
import { cn } from '@/lib/utils';
import { buildLogLabels, logColumns, logRowLabel } from './logs/log-columns';
import { LogDetailDialog } from './logs/log-detail-dialog';
import { LogFiltersBar } from './logs/log-filters-bar';

const LOAD_MESSAGE = 'Failed to load logs. Check your connection and try again.';

// Logs load when the page opens and when Refresh is pressed, nothing else (D-23): the query never
// refetches on focus, reconnect or a timer. Older pages are appended through the `before` cursor.
export default function LogsView() {
  const queryClient = useQueryClient();
  const filters = useLogFilters();
  const q = useInfiniteQuery(logsQuery(filters));
  const providersQ = useQuery(providersQuery);
  const gatewayKeysQ = useQuery(gatewayKeysQuery);
  const routesQ = useQuery(routesQuery);
  const [selected, setSelected] = useState<LogRowDTO | null>(null);
  useLoadErrorToast(q, 'logs-load', LOAD_MESSAGE);

  const labels = useMemo(
    () => buildLogLabels(providersQ.data?.providers ?? [], gatewayKeysQ.data?.keys ?? [], routesQ.data?.routes ?? []),
    [providersQ.data, gatewayKeysQ.data, routesQ.data],
  );
  const columns = useMemo(() => logColumns(labels), [labels]);

  const rows = q.data?.pages.flatMap((p) => p.logs) ?? [];
  const hasFilters = activeFilterCount(filters) > 0;
  const refreshing = q.isFetching && !q.isFetchingNextPage;

  // Refresh drops the loaded pages, shows the skeleton and reloads page 1 only.
  const refresh = () => void queryClient.resetQueries({ queryKey: ['logs'] });

  const emptyMessage = hasFilters ? (
    <div className="flex flex-col items-center gap-3">
      <span>No requests match these filters.</span>
      <Button variant="outline" className="h-11 md:h-9" onClick={clearLogFilters}>
        Clear filters
      </Button>
    </div>
  ) : (
    'No requests logged yet. Send a request through the gateway and it will show up here.'
  );

  const footer = (
    <div className="flex flex-col items-center gap-3 pt-3">
      {q.isFetchNextPageError ? (
        <div role="alert" className="flex w-full flex-wrap items-center justify-between gap-3 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
          <span className="min-w-0 break-words">Could not load older requests.</span>
          <Button variant="outline" className="h-11 md:h-9" onClick={() => void q.fetchNextPage()}>
            Retry
          </Button>
        </div>
      ) : null}
      {q.hasNextPage && !q.isFetchNextPageError ? (
        <Button variant="outline" className="h-11 md:h-9" onClick={() => void q.fetchNextPage()} disabled={q.isFetchingNextPage}>
          {q.isFetchingNextPage ? 'Loading…' : 'Load older'}
        </Button>
      ) : null}
    </div>
  );

  let body;
  if (q.isError && !q.data) {
    body = <PageError message={LOAD_MESSAGE} onRefresh={refresh} refreshing={refreshing} />;
  } else {
    body = (
      <ResponsiveList
        rows={rows}
        columns={columns}
        getRowKey={(r) => r.id}
        isLoading={q.isPending}
        skeletonRows={5}
        emptyMessage={emptyMessage}
        ariaLabel="Request logs"
        onRowClick={setSelected}
        getRowLabel={logRowLabel}
        footer={rows.length > 0 ? footer : undefined}
      />
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Request Logs"
        subtitle="Tap a request to see every key and provider it tried."
        actions={
          <Button variant="outline" className="h-11 md:h-9" onClick={refresh} disabled={refreshing}>
            <RefreshCw aria-hidden="true" className={cn(refreshing && 'animate-spin')} />
            Refresh
          </Button>
        }
      />
      <LogFiltersBar providers={providersQ.data?.providers ?? []} gatewayKeys={gatewayKeysQ.data?.keys ?? []} />
      {body}
      {/* Mounted only while open, so each request opens at the top of its own trail. */}
      {selected ? (
        <LogDetailDialog log={selected} labels={labels} open onOpenChange={(open) => !open && setSelected(null)} />
      ) : null}
    </div>
  );
}
