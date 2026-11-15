import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { EnabledBadge } from '@/components/status-badge';
import { useDeleteGatewayKey, useUpdateGatewayKey } from '@/hooks/use-gateway-key-actions';
import type { GatewayKeyDTO, RouteDTO } from '@/lib/api';
import { fmtAgo } from '@/lib/format';
import { EditKeyDialog } from './edit-key-dialog';

interface GatewayKeyCardProps {
  gatewayKey: GatewayKeyDTO;
  routes?: RouteDTO[];
}

/** One client key: name, prefix, route, status and created time, with Enable or Disable, Edit and Delete in one wrapping row (D-25). */
export function GatewayKeyCard({ gatewayKey, routes }: GatewayKeyCardProps) {
  const update = useUpdateGatewayKey();
  const del = useDeleteGatewayKey();
  const [dialog, setDialog] = useState<'edit' | 'delete' | null>(null);

  const route = gatewayKey.route_id === null ? undefined : routes?.find((r) => r.id === gatewayKey.route_id);
  const routeText = gatewayKey.route_id === null ? 'Auto' : route ? route.name : `#${gatewayKey.route_id}`;

  return (
    <Card className="gap-3 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="min-w-0 text-sm font-semibold break-words">{gatewayKey.name}</h2>
        <EnabledBadge enabled={gatewayKey.enabled} />
      </div>
      <div className="flex flex-col gap-1 text-xs text-muted-foreground">
        <span className="font-mono break-all">{gatewayKey.key_prefix}…</span>
        <span className="break-words">Route: {routeText}</span>
        <span>Created {fmtAgo(gatewayKey.created_at)}</span>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          size="sm"
          className="h-11 md:h-8"
          disabled={update.isPending}
          onClick={() => update.mutate({ key: gatewayKey, patch: { enabled: !gatewayKey.enabled } })}
        >
          {gatewayKey.enabled ? (update.isPending ? 'Disabling…' : 'Disable') : update.isPending ? 'Enabling…' : 'Enable'}
        </Button>
        <Button variant="outline" size="sm" className="h-11 md:h-8" onClick={() => setDialog('edit')}>
          Edit
        </Button>
        <Button variant="outline" size="sm" className="h-11 text-destructive md:h-8" onClick={() => setDialog('delete')}>
          Delete
        </Button>
      </div>

      {dialog === 'edit' ? (
        <EditKeyDialog open onOpenChange={(o) => setDialog(o ? 'edit' : null)} gatewayKey={gatewayKey} routes={routes} />
      ) : null}
      <ConfirmDialog
        open={dialog === 'delete'}
        onOpenChange={(o) => setDialog(o ? 'delete' : null)}
        title={`Delete gateway key "${gatewayKey.name}"?`}
        body="Clients using this key stop working right away. This cannot be undone."
        confirmLabel="Delete gateway key"
        pendingLabel="Deleting…"
        keepLabel="Keep gateway key"
        onConfirm={async () => {
          await del.mutateAsync(gatewayKey.id);
          toast.success(`Deleted gateway key ${gatewayKey.name}.`);
        }}
      />
    </Card>
  );
}
