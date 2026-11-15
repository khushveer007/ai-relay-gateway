import { Button } from '@/components/ui/button';
import { KeyStatusBadge } from '@/components/status-badge';
import { useEnableKey, useTestKey } from '@/hooks/use-key-actions';
import type { ProviderKeyDTO } from '@/lib/api';
import { fmtAgo, fmtBalance } from '@/lib/format';
import { keyReasonLine } from '@/lib/overview';

/**
 * One upstream key. The mutation hooks live in the row so each row owns its own pending state, not a
 * shared last-call-wins observer (research correction C4). Only `key_hint` is rendered, never the key.
 */
export function KeyRow({ keyDto }: { keyDto: ProviderKeyDTO }) {
  const enable = useEnableKey();
  const test = useTestKey();
  const reason = keyReasonLine(keyDto);
  const isActive = keyDto.status === 'active';
  const mainPending = isActive ? test.isPending : enable.isPending;

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
      </div>
    </div>
  );
}
