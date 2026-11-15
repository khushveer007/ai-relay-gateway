import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { PageError } from '@/components/page-error';
import { PageHeader } from '@/components/page-header';
import { useLoadErrorToast } from '@/hooks/use-load-error-toast';
import { gatewayKeysQuery, routesQuery } from '@/lib/queries';
import { ClientSetup } from './gateway-keys/client-setup';
import { CreateKeyDialog } from './gateway-keys/create-key-dialog';
import { GatewayKeyCard } from './gateway-keys/gateway-key-card';

const LOAD_MESSAGE = 'Failed to load Gateway Keys. Check your connection and try again.';

function KeySkeleton() {
  return (
    <Card className="gap-3 p-4" aria-hidden="true">
      <Skeleton className="h-5 w-1/2" />
      <div className="flex flex-col gap-2">
        <Skeleton className="h-4 w-1/3" />
        <Skeleton className="h-4 w-2/3" />
      </div>
      <div className="flex gap-2">
        <Skeleton className="h-11 w-20 md:h-8" />
        <Skeleton className="h-11 w-16 md:h-8" />
        <Skeleton className="h-11 w-20 md:h-8" />
      </div>
    </Card>
  );
}

// Skeletons on the first load only (D-29); a failed load with nothing cached is the error panel, never
// the empty state (WR-01).
export default function GatewayKeysView() {
  const keysQ = useQuery(gatewayKeysQuery);
  const routesQ = useQuery(routesQuery);
  const [creating, setCreating] = useState(false);
  useLoadErrorToast(keysQ, 'gateway-keys-load', LOAD_MESSAGE);

  const keys = keysQ.data?.keys;
  const routes = routesQ.data?.routes ?? [];

  let body;
  if (keysQ.isPending) {
    body = (
      <div className="flex flex-col gap-4">
        <KeySkeleton />
        <KeySkeleton />
      </div>
    );
  } else if (!keys) {
    body = <PageError message={LOAD_MESSAGE} onRefresh={() => void keysQ.refetch()} refreshing={keysQ.fetchStatus === 'fetching'} />;
  } else if (keys.length === 0) {
    body = (
      <Card className="items-center gap-3 p-8 text-center">
        <h2 className="text-sm font-semibold">No gateway keys yet</h2>
        <p className="max-w-md text-sm text-muted-foreground">Create a key, then use it in Claude Code, Codex or any SDK client.</p>
        <Button onClick={() => setCreating(true)}>
          <Plus aria-hidden="true" />
          Create key
        </Button>
      </Card>
    );
  } else {
    body = (
      <div className="flex flex-col gap-4">
        <h2 className="text-sm font-semibold">
          {keys.length} gateway {keys.length === 1 ? 'key' : 'keys'}
        </h2>
        {keys.map((k) => (
          <GatewayKeyCard key={k.id} gatewayKey={k} routes={routes} />
        ))}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Gateway Keys"
        subtitle="Keys your clients use to call this gateway. Only a hash is stored."
        actions={
          <Button className="h-11 md:h-9" onClick={() => setCreating(true)}>
            <Plus aria-hidden="true" />
            Create key
          </Button>
        }
      />
      {body}
      <ClientSetup />
      {/* Mounted only while open, so the form and any revealed key are gone once it closes. */}
      {creating ? <CreateKeyDialog open onOpenChange={setCreating} routes={routes} /> : null}
    </div>
  );
}
