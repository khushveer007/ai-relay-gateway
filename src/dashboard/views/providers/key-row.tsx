import { Ellipsis } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { KeyStatusBadge } from '@/components/status-badge';
import { useDisableKey, useEnableKey, useRecheckKey, useTestKey } from '@/hooks/use-key-actions';
import type { ProviderKeyDTO } from '@/lib/api';
import { fmtAgo, fmtBalance } from '@/lib/format';
import { keyReasonLine } from '@/lib/overview';

interface KeyRowProps {
  keyDto: ProviderKeyDTO;
  /** Position in the provider's key list, for the Move up and Move down ends. */
  index: number;
  count: number;
  /** The provider's reorder request is running (including its refetch): both Move items are disabled. */
  reordering: boolean;
  onMove: (keyId: number, delta: -1 | 1) => void;
}

/**
 * One upstream key. The mutation hooks live in the row so each row owns its own pending state, not a
 * shared last-call-wins observer (research correction C4). Only `key_hint` is rendered, never the key.
 */
export function KeyRow({ keyDto, index, count, reordering, onMove }: KeyRowProps) {
  const enable = useEnableKey();
  const disable = useDisableKey();
  const test = useTestKey();
  const recheck = useRecheckKey();
  const reason = keyReasonLine(keyDto);
  const isActive = keyDto.status === 'active';
  const label = keyDto.alias || keyDto.key_hint;
  const mainPending = isActive ? test.isPending : enable.isPending;
  const statusPending = enable.isPending || disable.isPending;

  return (
    <div className="grid gap-2 py-3 md:grid-cols-[1fr_auto] md:items-center md:gap-x-4">
      <div className="flex min-w-0 flex-col gap-2 md:flex-row md:flex-wrap md:items-center md:gap-x-4">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="font-mono text-xs text-muted-foreground">#{keyDto.priority + 1}</span>
          <span className="min-w-0 text-sm font-semibold break-words">{keyDto.alias || '—'}</span>
          <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs break-all text-muted-foreground">{keyDto.key_hint}</code>
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <KeyStatusBadge status={keyDto.status} />
          <span className="font-mono text-xs tabular-nums">{fmtBalance(keyDto.balance)}</span>
          {keyDto.balance_checked_at ? (
            <span className="text-xs text-muted-foreground">checked {fmtAgo(keyDto.balance_checked_at)}</span>
          ) : null}
        </div>
      </div>
      {reason ? <p className="text-xs break-words text-muted-foreground md:col-span-2 md:row-start-2">{reason}</p> : null}
      <div className="flex items-center gap-2 md:col-start-2 md:row-start-1">
        <Button
          variant="outline"
          size="sm"
          className="h-11 flex-1 md:h-8 md:flex-none"
          disabled={mainPending}
          onClick={() => (isActive ? test.mutate(keyDto.id) : enable.mutate(keyDto.id))}
        >
          {isActive ? (test.isPending ? 'Testing…' : 'Test') : enable.isPending ? 'Enabling…' : 'Enable'}
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" aria-label={`Key actions for ${label}`}>
              <Ellipsis aria-hidden="true" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" collisionPadding={8}>
            <DropdownMenuItem disabled={test.isPending} onSelect={() => test.mutate(keyDto.id)}>
              {test.isPending ? 'Testing…' : 'Test'}
            </DropdownMenuItem>
            {keyDto.status === 'exhausted' ? (
              <DropdownMenuItem disabled={recheck.isPending} onSelect={() => recheck.mutate(keyDto.id)}>
                {recheck.isPending ? 'Rechecking…' : 'Recheck'}
              </DropdownMenuItem>
            ) : null}
            {isActive ? (
              <DropdownMenuItem disabled={statusPending} onSelect={() => disable.mutate(keyDto.id)}>
                Disable
              </DropdownMenuItem>
            ) : (
              <DropdownMenuItem disabled={statusPending} onSelect={() => enable.mutate(keyDto.id)}>
                Enable
              </DropdownMenuItem>
            )}
            <DropdownMenuItem disabled={reordering || index === 0} onSelect={() => onMove(keyDto.id, -1)}>
              Move up
            </DropdownMenuItem>
            <DropdownMenuItem disabled={reordering || index === count - 1} onSelect={() => onMove(keyDto.id, 1)}>
              Move down
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}
