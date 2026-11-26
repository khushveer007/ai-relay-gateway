import { useQuery } from '@tanstack/react-query';
import { PageError } from '@/components/page-error';
import { useLoadErrorToast } from '@/hooks/use-load-error-toast';
import { useRange } from '@/hooks/use-range';
import { priceModelsQuery, providersQuery, statsQuery } from '@/lib/queries';
import { droppedKeyNames, unpricedModelNames } from '@/lib/overview';
import { OverviewHeader } from './overview/overview-header';
import { NeedsAttention } from './overview/needs-attention';
import { KpiCards } from './overview/kpi-cards';
import { TrafficChart } from './overview/traffic-chart';
import { AttemptOutcomes } from './overview/attempt-outcomes';
import { KeyMatrix } from './overview/key-matrix';
import { ProviderTraffic } from './overview/provider-traffic';
import { TopModels } from './overview/top-models';

const LOAD_MESSAGE = 'Failed to load gateway data. Check your connection and try again.';

// Named overview-page (not overview) because src/dashboard/views/overview.ts stays until plan 01-08,
// and a bare './views/overview' import would resolve to that old .ts file first.
export default function OverviewView() {
  const [range, setRange] = useRange();
  const statsQ = useQuery(statsQuery(range));
  const providersQ = useQuery(providersQuery);
  const modelsQ = useQuery(priceModelsQuery);

  // D-08: stats/providers are read as failed only once their own fetch has settled, and the
  // failed branch never reads cached `data` (UI-SPEC error contract: never show stale numbers as
  // current). The other query's half of the page keeps rendering when only one query fails.
  const statsFailed = !statsQ.isFetching && statsQ.isError;
  const providersFailed = !providersQ.isFetching && providersQ.isError;
  const stats = statsFailed ? undefined : statsQ.data;
  const providers = providersFailed ? undefined : providersQ.data?.providers;

  // One toast per new failure, shared id so two failing queries show one toast, never replayed on remount.
  useLoadErrorToast(statsQ, 'overview-load', LOAD_MESSAGE);
  useLoadErrorToast(providersQ, 'overview-load', LOAD_MESSAGE);

  const isFetching = statsQ.isFetching || providersQ.isFetching || modelsQ.isFetching;
  const anyFailed = statsFailed || providersFailed;

  function handleRefresh(): void {
    void statsQ.refetch();
    void providersQ.refetch();
    void modelsQ.refetch();
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
      <NeedsAttention
        dropped={providersFailed ? { status: 'error' } : providers ? { status: 'ready', names: droppedKeyNames(providers) } : { status: 'loading' }}
        unpriced={modelsQ.isError && !modelsQ.isFetching
          ? { status: 'error' }
          : modelsQ.data ? { status: 'ready', names: unpricedModelNames(modelsQ.data.models) } : { status: 'loading' }}
      />
      {anyFailed && <PageError message={LOAD_MESSAGE} onRefresh={handleRefresh} refreshing={isFetching} />}
      <KpiCards
        range={range}
        stats={stats}
        statsLoading={statsQ.isFetching}
        statsFailed={statsFailed}
        providers={providers}
        providersLoading={providersQ.isFetching}
        providersFailed={providersFailed}
      />
      <div className="grid gap-8 lg:grid-cols-2">
        <TrafficChart range={range} stats={stats} isLoading={statsQ.isFetching} isFailed={statsFailed} />
        <AttemptOutcomes range={range} rows={stats?.actions ?? []} isLoading={statsQ.isFetching} failed={statsFailed} />
      </div>
      <KeyMatrix
        range={range}
        providers={providers ?? []}
        stats={stats}
        isLoading={providersQ.isFetching}
        providersFailed={providersFailed}
        statsFailed={statsFailed}
      />
      <div className="grid gap-8 lg:grid-cols-2">
        <ProviderTraffic rows={stats?.by_provider ?? []} providers={providers} isLoading={statsQ.isFetching} failed={statsFailed} />
        <TopModels rows={stats?.by_model ?? []} isLoading={statsQ.isFetching} failed={statsFailed} />
      </div>
    </div>
  );
}
