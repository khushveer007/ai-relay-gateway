import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { EnabledBadge } from '@/components/status-badge';
import { useReorderKeys } from '@/hooks/use-key-actions';
import type { ProviderDTO } from '@/lib/api';
import { KeyRow } from './key-row';

const META_BADGE = 'h-auto whitespace-normal break-words text-left';

/** One provider: header, meta badges, key summary and its key rows. Every dialog is a sibling of the menus (D-05). */
export function ProviderCard({ provider }: { provider: ProviderDTO }) {
  const total = provider.keys.length;
  const active = provider.keys.filter((k) => k.status === 'active').length;
  const keyWord = total === 1 ? 'key' : 'keys';
  const reorder = useReorderKeys(provider.id);

  // Move up and Move down swap with the neighbour. The ids list is built from the CURRENT cached key
  // order at click time, so a stale list is never sent (Pitfall 10, D-09). No drag and drop.
  const onMove = (keyId: number, delta: -1 | 1) => {
    if (reorder.isPending) return;
    const ids = provider.keys.map((k) => k.id);
    const from = ids.indexOf(keyId);
    const to = from + delta;
    if (from < 0 || to < 0 || to >= ids.length) return;
    [ids[from], ids[to]] = [ids[to], ids[from]];
    reorder.mutate(ids);
  };

  return (
    <Card className="gap-4 p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex min-w-0 flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-sm font-semibold break-words">{provider.name}</h2>
            <EnabledBadge enabled={provider.enabled} />
          </div>
          <p className="font-mono text-xs break-all text-muted-foreground">{provider.base_url}</p>
        </div>
      </div>

      <div className="flex flex-wrap gap-1">
        {provider.formats.map((f) => (
          <Badge key={f} variant="secondary" className={META_BADGE}>
            {f}
          </Badge>
        ))}
        <Badge variant="secondary" className={META_BADGE}>
          strategy: {provider.key_strategy}
        </Badge>
        <Badge variant="secondary" className={META_BADGE}>
          recheck: {provider.recheck_mode} ({provider.recheck_hours}h)
        </Badge>
        <Badge variant="secondary" className={META_BADGE}>
          balance: {provider.balance_mode}
        </Badge>
        {provider.routes.length > 0 ? (
          <Badge variant="secondary" className={META_BADGE}>
            routes: {provider.routes.join(', ')}
          </Badge>
        ) : null}
      </div>

      <p className="text-xs text-muted-foreground">
        {active}/{total} {keyWord} active
      </p>

      {total === 0 ? (
        <p className="border-t border-border-subtle pt-3 text-sm break-words text-muted-foreground">
          No API keys for {provider.name} yet. Add keys to start sending requests here.
        </p>
      ) : (
        <div className="flex flex-col">
          {provider.keys.map((k, i) => (
            <div key={k.id} className="border-t border-border-subtle">
              <KeyRow keyDto={k} index={i} count={total} reordering={reorder.isPending} onMove={onMove} />
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
