import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { PageError } from '@/components/page-error';
import { PageHeader } from '@/components/page-header';
import { useLoadErrorToast } from '@/hooks/use-load-error-toast';
import { providersQuery, routesQuery } from '@/lib/queries';
import { RouteCard } from './routes/route-card';
import { RouteDialog } from './routes/route-dialog';

const LOAD_MESSAGE = 'Failed to load Routes & Chains. Check your connection and try again.';

function RouteSkeleton() {
  return (
    <Card className="gap-4 p-4" aria-hidden="true">
      <Skeleton className="h-5 w-1/2" />
      <div className="flex flex-col gap-2">
        <Skeleton className="h-4 w-3/4" />
        <Skeleton className="h-4 w-2/3" />
      </div>
      <div className="flex gap-2">
        <Skeleton className="h-11 w-20 md:h-8" />
        <Skeleton className="h-11 w-24 md:h-8" />
      </div>
    </Card>
  );
}

// Skeletons on the first load only; later refetches update in place (D-29). The default route always
// exists, so there is no empty state: a failed load with nothing cached is the error panel (WR-01).
export default function RoutesView() {
  const routesQ = useQuery(routesQuery);
  const providersQ = useQuery(providersQuery);
  const [creating, setCreating] = useState(false);
  useLoadErrorToast(routesQ, 'routes-load', LOAD_MESSAGE);

  const routes = routesQ.data?.routes;
  const providers = providersQ.data?.providers ?? [];

  let body;
  if (routesQ.isPending) {
    body = (
      <div className="flex flex-col gap-4">
        <RouteSkeleton />
        <RouteSkeleton />
      </div>
    );
  } else if (!routes) {
    body = <PageError message={LOAD_MESSAGE} onRefresh={() => void routesQ.refetch()} refreshing={routesQ.fetchStatus === 'fetching'} />;
  } else {
    body = (
      <div className="flex flex-col gap-4">
        {routes.map((r) => (
          <RouteCard key={r.id} route={r} providers={providers} />
        ))}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Routes & Chains"
        subtitle="A request uses the route pinned to its gateway key, then the first route whose model pattern matches, then the default route."
        actions={
          <Button className="h-11 md:h-9" onClick={() => setCreating(true)} disabled={!routes}>
            <Plus aria-hidden="true" />
            New route
          </Button>
        }
      />
      {body}
      {/* Mounted only while open, so the form starts fresh each time. */}
      {creating ? <RouteDialog open onOpenChange={setCreating} mode="create" providers={providers} /> : null}
    </div>
  );
}
