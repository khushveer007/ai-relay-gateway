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

function RuleActions({ rule, providers, actions }: { rule: ErrorRuleDTO; providers: ProviderDTO[]; actions: Action[] }) {
  const del = useDeleteRule(rule.id);
  const [dialog, setDialog] = useState<'edit' | 'delete' | null>(null);
  return (
    <>
      <Button variant="outline" size="sm" className="h-11 md:h-8" onClick={() => setDialog('edit')}>
        Edit
      </Button>
      <Button variant="outline" size="sm" className="h-11 text-destructive md:h-8" onClick={() => setDialog('delete')}>
        Delete
      </Button>
      {dialog === 'edit' ? (
        <RuleDialog open onOpenChange={(o) => setDialog(o ? 'edit' : null)} mode="edit" rule={rule} providers={providers} actions={actions} />
      ) : null}
      <ConfirmDialog
        open={dialog === 'delete'}
        onOpenChange={(o) => setDialog(o ? 'delete' : null)}
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
    </>
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
          renderActions={(r) => <RuleActions rule={r} providers={providers} actions={actions} />}
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
    </Card>
  );
}
