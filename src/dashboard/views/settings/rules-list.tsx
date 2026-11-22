import { useState } from 'react';
import { Plus } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardAction, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { ResponsiveList, type ResponsiveColumn } from '@/components/responsive-list';
import { useIsDesktop } from '@/hooks/use-media-query';
import { useDeleteRule } from '@/hooks/use-rules';
import type { Action, ErrorRuleDTO, ProviderDTO } from '@/lib/api';
import { actionLabel } from '@/lib/format';
import { ruleSentence } from '@/lib/rule-form';
import { cn } from '@/lib/utils';
import { ProviderFormDialog } from '../providers/provider-form-dialog';
import { RuleDialog } from './rule-dialog';
import { RuleSentence } from './rule-sentence';

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
      body={`${ruleSentence(rule, providers).scope}: ${rule.status_codes || 'any status'} → ${actionLabel(rule.action, { cooldownS: rule.cooldown_s })}. This cannot be undone.`}
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
  const isDesktop = useIsDesktop();
  const [adding, setAdding] = useState(false);
  // Keep dialog targets mounted across the table-to-cards breakpoint.
  const [target, setTarget] = useState<RuleTarget | null>(null);
  const [providerTarget, setProviderTarget] = useState<ProviderDTO | null>(null);
  const closeTarget = (open: boolean) => {
    if (!open) setTarget(null);
  };
  const dim = (rule: ErrorRuleDTO) => (rule.enabled ? undefined : 'opacity-60');
  const rows = [...rules].sort((a, b) =>
    Number(b.origin === 'drop_list') - Number(a.origin === 'drop_list') || a.priority - b.priority || a.id - b.id,
  );
  const scope = (rule: ErrorRuleDTO) => (
    <span className="flex min-w-0 flex-wrap items-center gap-2">
      <Badge variant="outline" className="h-auto min-w-0 max-w-full whitespace-normal wrap-anywhere">
        {ruleSentence(rule, providers).scope}
      </Badge>
      {!rule.enabled ? (
        <Badge variant="outline" className="border-transparent bg-status-neutral/15 text-status-neutral">Disabled</Badge>
      ) : null}
    </span>
  );
  const priority = (rule: ErrorRuleDTO) => (
    <span className="text-xs text-muted-foreground">
      {rule.origin === 'drop_list' ? 'Checked before all rules' : `Priority ${rule.priority}`}
    </span>
  );
  const editProvider = (providerId: number | null) => {
    const provider = providers.find((p) => p.id === providerId);
    if (provider) setProviderTarget(provider);
    else window.location.hash = '#/providers';
  };
  const rowActions = (rule: ErrorRuleDTO) => (
    rule.origin === 'drop_list' ? (
      <Button variant="outline" size="sm" className="h-11" onClick={() => editProvider(rule.provider_id)}>
        Edit in provider
      </Button>
    ) : <RuleActions rule={rule} onTarget={setTarget} />
  );

  const columns: ResponsiveColumn<ErrorRuleDTO>[] = [
    {
      key: 'scope',
      header: 'Scope',
      className: 'max-w-48',
      cell: (rule) => <div className={dim(rule)}>{scope(rule)}</div>,
    },
    {
      key: 'rule',
      header: 'Rule',
      className: 'w-full whitespace-normal',
      cell: (rule) => <div className={dim(rule)}><RuleSentence rule={rule} providers={providers} /></div>,
    },
    { key: 'priority', header: 'Priority', cell: (rule) => <span className={dim(rule)}>{priority(rule)}</span> },
  ];

  return (
    <Card>
      <CardHeader>
        <CardTitle>Error rules ({rules.length})</CardTitle>
        <CardDescription>Drop lists run first, then provider rules, then global rules. Lower priority numbers run first.</CardDescription>
        <CardAction>
          <Button className="h-11 md:h-9" onClick={() => setAdding(true)}>
            <Plus aria-hidden="true" />
            Add rule
          </Button>
        </CardAction>
      </CardHeader>
      <div className="px-(--card-spacing)">
        {isDesktop || rows.length === 0 ? (
          <ResponsiveList
            rows={rows}
            columns={columns}
            getRowKey={(rule) => rule.id}
            renderActions={rowActions}
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
        ) : (
          <div role="list" aria-label="Error rules" className="flex flex-col gap-4">
            {rows.map((rule) => (
              <Card key={rule.id} role="listitem" className={cn('gap-2 p-4', dim(rule))}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  {scope(rule)}
                  {priority(rule)}
                </div>
                <RuleSentence rule={rule} providers={providers} />
                <div className="flex flex-wrap gap-2">{rowActions(rule)}</div>
              </Card>
            ))}
          </div>
        )}
      </div>
      {/* Mounted only while open, so the form starts fresh each time. */}
      {adding ? <RuleDialog open onOpenChange={setAdding} mode="create" providers={providers} actions={actions} /> : null}
      {target?.kind === 'edit' ? (
        <RuleDialog key={target.rule.id} open onOpenChange={closeTarget} mode="edit" rule={target.rule} providers={providers} actions={actions} />
      ) : null}
      {target?.kind === 'delete' ? <DeleteRuleConfirm key={target.rule.id} rule={target.rule} providers={providers} onOpenChange={closeTarget} /> : null}
      {providerTarget ? (
        <ProviderFormDialog
          open
          onOpenChange={(open) => { if (!open) setProviderTarget(null); }}
          mode="edit"
          provider={providerTarget}
          initialDropOpen
        />
      ) : null}
    </Card>
  );
}
