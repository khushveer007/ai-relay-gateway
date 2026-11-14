import { useEffect, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useRange } from '@/hooks/use-range';
import { providersQuery, statsQuery } from '@/lib/queries';
import { OverviewError } from './overview/overview-error';
import { OverviewHeader } from './overview/overview-header';
import { KpiCards } from './overview/kpi-cards';

// Named overview-page (not overview) because src/dashboard/views/overview.ts stays until plan 01-08,
// and a bare './views/overview' import would resolve to that old .ts file first.
export default function OverviewView() {
  const [range, setRange] = useRange();
  const statsQ = useQuery(statsQuery(range));
  const providersQ = useQuery(providersQuery);

  // D-08: stats/providers are read as failed only once their own fetch has settled, and the
  // failed branch never reads cached `data` (UI-SPEC error contract: never show stale numbers as
  // current). The other query's half of the page keeps rendering when only one query fails.
  const statsFailed = !statsQ.isFetching && statsQ.isError;
  const providersFailed = !providersQ.isFetching && providersQ.isError;
  const stats = statsFailed ? undefined : statsQ.data;
  const providers = providersFailed ? undefined : providersQ.data?.providers;

  // One toast per new failure, not one per render.
  const lastStatsErrorAt = useRef(0);
  const lastProvidersErrorAt = useRef(0);
  useEffect(() => {
    if (statsQ.errorUpdatedAt && statsQ.errorUpdatedAt !== lastStatsErrorAt.current) {
      lastStatsErrorAt.current = statsQ.errorUpdatedAt;
      toast.error('Failed to load gateway data. Check your connection and try again.');
    }
  }, [statsQ.errorUpdatedAt]);
  useEffect(() => {
    if (providersQ.errorUpdatedAt && providersQ.errorUpdatedAt !== lastProvidersErrorAt.current) {
      lastProvidersErrorAt.current = providersQ.errorUpdatedAt;
      toast.error('Failed to load gateway data. Check your connection and try again.');
    }
  }, [providersQ.errorUpdatedAt]);

  const isFetching = statsQ.isFetching || providersQ.isFetching;
  const anyFailed = statsFailed || providersFailed;

  function handleRefresh(): void {
    void statsQ.refetch();
    void providersQ.refetch();
  }

  return (
    <div className="space-y-8">
      <OverviewHeader
        range={range}
        onRangeChange={setRange}
        onRefresh={handleRefresh}
        isFetching={isFetching}
        updatedAt={statsQ.dataUpdatedAt}
      />
      {anyFailed && <OverviewError onRefresh={handleRefresh} isFetching={isFetching} />}
      <KpiCards
        range={range}
        stats={stats}
        statsLoading={statsQ.isFetching}
        providers={providers}
        providersLoading={providersQ.isFetching}
      />
    </div>
  );
}
