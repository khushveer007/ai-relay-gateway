import { useState } from 'react';
import { Plus } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardAction, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { ResponsiveList, TruncatedText, type ResponsiveColumn } from '@/components/responsive-list';
import { ActionBadge } from '@/components/status-badge';
import { useDeleteRule } from '@/hooks/use-rules';
import type { Action, ErrorRuleDTO, ProviderDTO } from '@/lib/api';
import { actionLabel } from '@/lib/format';
import { cn } from '@/lib/utils';
import { RuleDialog } from './rule-dialog';

const scopeName = (rule: ErrorRuleDTO, providers: ProviderDTO[]): string =>
  rule.provider_id === null ? 'Global' : (providers.find((p) => p.id === rule.provider_id)?.name ?? `Provider #${rule.provider_id}`);

const statusText = (rule: ErrorRuleDTO): string => rule.status_codes || 'any status';

function DisabledMark({ rule }: { rule: ErrorRuleDTO }) {
  return rule.enabled ? null : (
    <Badge variant="outline" className="ml-2 border-transparent bg-status-neutral/15 text-status-neutral">
      Disabled
    </Badge>
  );
}

type RuleTarget = { kind: 'edit' | 'delete'; rule: ErrorRuleDTO };

/** Only the two buttons: the dialogs live in `RulesList`, so a table to cards swap cannot close them. */
function RuleActions({ rule, onTarget }: { rule: ErrorRuleDTO; onTarget: (target: RuleTarget) => void }) {
  return (
    <>
      <Button variant="outline" size="sm" className="h-11 md:h-8" onClick={() => onTarget({ kind: 'edit', rule })}>
        Edit
      </Button>
      <Button variant="outline" size="sm" className="h-11 text-destructive md:h-8" onClick={() => onTarget({ kind: 'delete', rule })}>
        Delete
      </Button>
    </>
  );
}

/** A wrapper so `useDeleteRule` always has the id of the rule being deleted. */
function DeleteRuleConfirm({
  rule,
  providers,
  onOpenChange,
}: {
  rule: ErrorRuleDTO;
  providers: ProviderDTO[];
  onOpenChange: (open: boolean) => void;
}) {
  const del = useDeleteRule(rule.id);
  return (
    <ConfirmDialog
      open
      onOpenChange={onOpenChange}
      title="Delete this error rule?"
      body={`${scopeName(rule, providers)}: ${statusText(rule)} → ${actionLabel(rule.action)}. This cannot be undone.`}
      confirmLabel="Delete rule"
      pendingLabel="Deleting…"
      keepLabel="Keep rule"
      onConfirm={async () => {
        await del.mutateAsync();
        toast.success('Rule deleted.');
      }}
    />
  );
}

interface RulesListProps {
  rules: ErrorRuleDTO[];
  providers: ProviderDTO[];
  actions: Action[];
}

/** Error rules as cards on phones and a table from 768px. Disabled rules are dimmed and labelled. */
export function RulesList({ rules, providers, actions }: RulesListProps) {
  const [adding, setAdding] = useState(false);
  // Owned here, not by each row: ResponsiveList swaps its whole tree at 768px and would unmount a row-owned dialog.
  const [target, setTarget] = useState<RuleTarget | null>(null);
  const closeTarget = (open: boolean) => {
    if (!open) setTarget(null);
  };
  const dim = (r: ErrorRuleDTO) => (r.enabled ? undefined : 'opacity-60');

  const columns: ResponsiveColumn<ErrorRuleDTO>[] = [
    {
      key: 'scope',
      header: 'Scope',
      isRowTitle: true,
      cell: (r) => (
        <span className={cn('flex flex-wrap items-center gap-2', dim(r))}>
          <Badge variant="outline" className={cn('h-auto whitespace-normal break-words', r.provider_id !== null && 'text-primary')}>
            {scopeName(r, providers)}
          </Badge>
          {r.enabled ? null : <DisabledMark rule={r} />}
        </span>
      ),
    },
    { key: 'priority', header: 'Priority', cell: (r) => <span className={cn('font-mono', dim(r))}>{r.priority}</span> },
    { key: 'statuses', header: 'Statuses', cell: (r) => <span className={cn('font-mono break-all', dim(r))}>{statusText(r)}</span> },
    {
      key: 'regex',
      header: 'Body regex',
      className: 'max-w-64',
      cell: (r) =>
        r.body_regex ? (
          <TruncatedText text={r.body_regex} className={cn('font-mono text-xs break-all', dim(r))} />
        ) : (
          <span className="text-muted-foreground">any body</span>
        ),
    },
    {
      key: 'action',
      header: 'Action',
      cell: (r) => (
        <span className={cn('flex flex-wrap items-center gap-2', dim(r))}>
          <ActionBadge action={r.action} />
          {r.action === 'RATE_LIMITED' && r.cooldown_s ? <span className="font-mono text-xs">{r.cooldown_s}s</span> : null}
        </span>
      ),
    },
    {
      key: 'note',
      header: 'Note',
      className: 'max-w-48',
      // No note: null, which card mode leaves out entirely.
      cell: (r) => (r.note ? <TruncatedText text={r.note} className={cn('text-muted-foreground', dim(r))} /> : null),
    },
  ];

  return (
    <Card>
      <CardHeader>
        <CardTitle>Error rules ({rules.length})</CardTitle>
        <CardDescription>Provider rules run before global rules. Lower priority numbers run first.</CardDescription>
        <CardAction>
          <Button className="h-11 md:h-9" onClick={() => setAdding(true)}>
            <Plus aria-hidden="true" />
            Add rule
          </Button>
        </CardAction>
      </CardHeader>
      <div className="px-(--card-spacing)">
        <ResponsiveList
          rows={rules}
          columns={columns}
          getRowKey={(r) => r.id}
          renderActions={(r) => <RuleActions rule={r} onTarget={setTarget} />}
          emptyMessage={
            <div className="flex flex-col items-center gap-3">
              <span>No error rules yet. The built-in fallback still applies.</span>
              <Button className="h-11 md:h-9" onClick={() => setAdding(true)}>
                <Plus aria-hidden="true" />
                Add rule
              </Button>
            </div>
          }
          ariaLabel="Error rules"
        />
      </div>
      {/* Mounted only while open, so the form starts fresh each time. */}
      {adding ? <RuleDialog open onOpenChange={setAdding} mode="create" providers={providers} actions={actions} /> : null}
      {target?.kind === 'edit' ? (
        <RuleDialog key={target.rule.id} open onOpenChange={closeTarget} mode="edit" rule={target.rule} providers={providers} actions={actions} />
      ) : null}
      {target?.kind === 'delete' ? <DeleteRuleConfirm key={target.rule.id} rule={target.rule} providers={providers} onOpenChange={closeTarget} /> : null}
    </Card>
  );
}
