import { useState } from 'react';
import { Ellipsis, Plus } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { EnabledBadge } from '@/components/status-badge';
import { useReorderKeys } from '@/hooks/use-key-actions';
import { useAddKeys, useCheckBalances, useDeleteProvider, useFetchModels } from '@/hooks/use-provider-actions';
import type { ProviderDTO } from '@/lib/api';
import { AddKeysDialog } from './add-keys-dialog';
import { KeyRow } from './key-row';
import { ModelsDialog } from './models-dialog';
import { ProviderFormDialog } from './provider-form-dialog';

const META_BADGE = 'h-auto whitespace-normal break-words text-left';

type CardDialog = 'edit' | 'models' | 'add-keys' | 'delete' | null;

/**
 * One provider: header, meta badges, key summary and its key rows. Every dialog is a sibling of the
 * menus, never inside a menu's content, and each menu item that opens one closes the menu first and
 * opens on the next frame so Radix's pointer-events lock cannot stick on the page (D-05, D-08).
 */
export function ProviderCard({ provider }: { provider: ProviderDTO }) {
  const total = provider.keys.length;
  const active = provider.keys.filter((k) => k.status === 'active').length;
  const keyWord = total === 1 ? 'key' : 'keys';
  const reorder = useReorderKeys(provider.id);
  const fetchModels = useFetchModels(provider.id);
  const checkBalances = useCheckBalances(provider.id);
  const addKeys = useAddKeys(provider.id);
  const del = useDeleteProvider(provider.id);

  const [dialog, setDialog] = useState<CardDialog>(null);
  // The add-keys draft lives here so it survives the Dialog to Drawer swap (D-15).
  const [keysDraft, setKeysDraft] = useState('');
  const [prefixDraft, setPrefixDraft] = useState('');

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

  const openAddKeys = () => {
    addKeys.reset();
    setDialog('add-keys');
  };

  const submitKeys = () => {
    addKeys.mutate(
      { keys: keysDraft, alias_prefix: prefixDraft },
      {
        onSuccess: () => {
          setKeysDraft('');
          setPrefixDraft('');
          setDialog(null);
        },
      },
    );
  };

  const busyLine = fetchModels.isPending ? 'Fetching models…' : checkBalances.isPending ? 'Checking balances…' : null;

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
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" className="h-11 md:h-8" onClick={openAddKeys}>
            <Plus aria-hidden="true" />
            Add keys
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" aria-label={`Provider actions for ${provider.name}`}>
                <Ellipsis aria-hidden="true" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" collisionPadding={8}>
              <DropdownMenuItem onSelect={() => requestAnimationFrame(() => setDialog('edit'))}>Edit provider</DropdownMenuItem>
              <DropdownMenuItem disabled={fetchModels.isPending} onSelect={() => fetchModels.mutate()}>
                {fetchModels.isPending ? 'Fetching models…' : 'Fetch models'}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => requestAnimationFrame(() => setDialog('models'))}>
                Models ({provider.models.length})
              </DropdownMenuItem>
              {provider.balance_mode !== 'none' ? (
                <DropdownMenuItem disabled={checkBalances.isPending} onSelect={() => checkBalances.mutate()}>
                  {checkBalances.isPending ? 'Checking balances…' : 'Check balances'}
                </DropdownMenuItem>
              ) : null}
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onSelect={() => requestAnimationFrame(() => setDialog('delete'))}>
                Delete provider
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
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
      <p aria-live="polite" className={busyLine ? 'text-xs text-muted-foreground' : 'sr-only'}>
        {busyLine}
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

      {/* Mounted only while open, so the edit form starts from the provider as loaded each time. */}
      {dialog === 'edit' ? <ProviderFormDialog open onOpenChange={(o) => setDialog(o ? 'edit' : null)} mode="edit" provider={provider} /> : null}
      {dialog === 'models' ? <ModelsDialog open onOpenChange={(o) => setDialog(o ? 'models' : null)} provider={provider} /> : null}
      <AddKeysDialog
        open={dialog === 'add-keys'}
        onOpenChange={(o) => setDialog(o ? 'add-keys' : null)}
        providerName={provider.name}
        keys={keysDraft}
        onKeysChange={setKeysDraft}
        prefix={prefixDraft}
        onPrefixChange={setPrefixDraft}
        onSubmit={submitKeys}
        pending={addKeys.isPending}
        error={addKeys.isError ? addKeys.error.message : null}
      />
      <ConfirmDialog
        open={dialog === 'delete'}
        onOpenChange={(o) => setDialog(o ? 'delete' : null)}
        title={`Delete provider "${provider.name}"?`}
        body={`This also deletes its ${total} ${keyWord} and its error rules, and removes it from every route. This cannot be undone.`}
        confirmLabel="Delete provider"
        pendingLabel="Deleting…"
        keepLabel="Keep provider"
        onConfirm={async () => {
          await del.mutateAsync(provider.name);
        }}
      />
    </Card>
  );
}
