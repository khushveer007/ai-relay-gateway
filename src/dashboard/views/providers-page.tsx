import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { PageError } from '@/components/page-error';
import { PageHeader } from '@/components/page-header';
import { useLoadErrorToast } from '@/hooks/use-load-error-toast';
import { providersQuery } from '@/lib/queries';
import { ProviderFormDialog } from './providers/provider-form-dialog';
import { ProviderCard } from './providers/provider-card';

const LOAD_MESSAGE = 'Failed to load Providers & Keys. Check your connection and try again.';

function ProviderSkeleton() {
  return (
    <Card className="gap-4 p-4" aria-hidden="true">
      <Skeleton className="h-5 w-1/2" />
      <div className="flex flex-col gap-2">
        <Skeleton className="h-4 w-3/4" />
        <Skeleton className="h-4 w-2/3" />
      </div>
      <div className="flex gap-2">
        <Skeleton className="h-11 flex-1 md:h-8 md:flex-none md:w-24" />
        <Skeleton className="h-11 w-11 md:h-8 md:w-8" />
      </div>
    </Card>
  );
}

// Skeletons show on the first load only (isPending, never the fetch flag): after an action or a focus
// refetch the cards update in place (D-29). A failed load with nothing cached is an error panel, never
// the empty state (WR-01).
export default function ProvidersView() {
  const providersQ = useQuery(providersQuery);
  const [adding, setAdding] = useState(false);
  useLoadErrorToast(providersQ, 'providers-load', LOAD_MESSAGE);

  const providers = providersQ.data?.providers;

  let body;
  if (providersQ.isPending) {
    body = (
      <div className="flex flex-col gap-4">
        <ProviderSkeleton />
        <ProviderSkeleton />
      </div>
    );
  } else if (!providers) {
    body = (
      <PageError message={LOAD_MESSAGE} onRefresh={() => void providersQ.refetch()} refreshing={providersQ.fetchStatus === 'fetching'} />
    );
  } else if (providers.length === 0) {
    body = (
      <Card className="items-center gap-3 p-8 text-center">
        <h2 className="text-sm font-semibold">No providers yet</h2>
        <p className="max-w-md text-sm text-muted-foreground">Add an Anthropic, OpenAI or compatible relay, then paste your API keys.</p>
        <Button onClick={() => setAdding(true)}>
          <Plus aria-hidden="true" />
          Add provider
        </Button>
      </Card>
    );
  } else {
    body = (
      <div className="flex flex-col gap-4">
        {providers.map((p) => (
          <ProviderCard key={p.id} provider={p} />
        ))}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Providers & Keys"
        subtitle="Upstream relays and the API keys the gateway rotates through."
        actions={
          <Button className="h-11 md:h-9" onClick={() => setAdding(true)}>
            <Plus aria-hidden="true" />
            Add provider
          </Button>
        }
      />
      {body}
      {/* Mounted only while open, so the form resets every time the dialog opens. */}
      {adding ? <ProviderFormDialog open onOpenChange={setAdding} mode="create" /> : null}
    </div>
  );
}
