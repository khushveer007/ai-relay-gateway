import { useState } from 'react';
import { ArrowDown, ArrowRight } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { useDeleteRoute } from '@/hooks/use-route-actions';
import type { ProviderDTO, RouteDTO } from '@/lib/api';
import { cn } from '@/lib/utils';
import { RouteDialog } from './route-dialog';

const PATTERN_BADGE = 'h-auto whitespace-normal break-all text-left font-mono';

/** One route: name, badge, patterns and its provider chain with each provider's active-key count. */
export function RouteCard({ route, providers }: { route: RouteDTO; providers: ProviderDTO[] }) {
  const del = useDeleteRoute(route.id);
  const [dialog, setDialog] = useState<'edit' | 'delete' | null>(null);

  return (
    <Card className="gap-4 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="min-w-0 text-sm font-semibold break-words">{route.name}</h2>
        {route.is_default ? (
          <Badge variant="outline" className="border-transparent bg-status-ok/15 text-status-ok">
            Default route
          </Badge>
        ) : (
          <Badge variant="outline" className="border-transparent bg-status-neutral/15 text-status-neutral">
            Position {route.position}
          </Badge>
        )}
      </div>

      {route.is_default ? null : route.model_patterns.length === 0 ? (
        <p className="text-xs text-muted-foreground">Key-bound only (no model patterns)</p>
      ) : (
        <div className="flex flex-wrap gap-1">
          {route.model_patterns.map((p) => (
            <Badge key={p} variant="secondary" className={PATTERN_BADGE}>
              {p}
            </Badge>
          ))}
        </div>
      )}

      {route.provider_ids.length === 0 ? (
        <p className="text-sm break-words text-muted-foreground">No providers in this chain. Edit the route to add some.</p>
      ) : (
        <ol className="flex flex-col gap-1 md:flex-row md:flex-wrap md:items-center md:gap-2">
          {route.provider_ids.map((id, i) => {
            const provider = providers.find((p) => p.id === id);
            const active = provider ? provider.keys.filter((k) => k.status === 'active').length : 0;
            const last = i === route.provider_ids.length - 1;
            return (
              <li key={id} className="flex flex-col items-start gap-1 md:flex-row md:items-center md:gap-2">
                <span className="text-sm break-words">
                  <span className="font-mono text-xs text-muted-foreground">#{i + 1}</span>{' '}
                  <span className="font-semibold">{provider ? provider.name : `Provider #${id}`}</span>
                  {provider ? (
                    <span className="text-xs text-muted-foreground">
                      {' '}
                      {active}/{provider.keys.length} keys
                    </span>
                  ) : null}
                </span>
                {last ? null : (
                  <>
                    <ArrowDown aria-hidden="true" className={cn('size-4 text-muted-foreground md:hidden')} />
                    <ArrowRight aria-hidden="true" className="hidden size-4 text-muted-foreground md:block" />
                  </>
                )}
              </li>
            );
          })}
        </ol>
      )}

      <div className="flex flex-wrap gap-2">
        <Button variant="outline" size="sm" className="h-11 md:h-8" onClick={() => setDialog('edit')}>
          Edit
        </Button>
        {route.is_default ? null : (
          <Button variant="outline" size="sm" className="h-11 text-destructive md:h-8" onClick={() => setDialog('delete')}>
            Delete
          </Button>
        )}
      </div>

      {dialog === 'edit' ? <RouteDialog open onOpenChange={(o) => setDialog(o ? 'edit' : null)} mode="edit" route={route} providers={providers} /> : null}
      <ConfirmDialog
        open={dialog === 'delete'}
        onOpenChange={(o) => setDialog(o ? 'delete' : null)}
        title={`Delete route "${route.name}"?`}
        body="Gateway keys pinned to it go back to Auto. This cannot be undone."
        confirmLabel="Delete route"
        pendingLabel="Deleting…"
        keepLabel="Keep route"
        onConfirm={async () => {
          await del.mutateAsync();
          toast.success(`Deleted route ${route.name}.`);
        }}
      />
    </Card>
  );
}
