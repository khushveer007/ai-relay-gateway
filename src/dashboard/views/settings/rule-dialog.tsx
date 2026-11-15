import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { Field, fieldMessageId } from '@/components/field';
import { ResponsiveDialog } from '@/components/responsive-dialog';
import { useSaveRule } from '@/hooks/use-rules';
import type { Action, ErrorRuleDTO, ProviderDTO } from '@/lib/api';
import { actionLabel } from '@/lib/format';
import { buildRulePayload, emptyRuleForm, ruleToForm, validateRuleForm, type RuleForm } from '@/lib/rule-form';

interface RuleDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: 'create' | 'edit';
  rule?: ErrorRuleDTO;
  providers: ProviderDTO[];
  /** The actions the rules query returned, in the Worker's order. */
  actions: Action[];
}

const ID = {
  scope: 'rule-scope',
  priority: 'rule-priority',
  status: 'rule-status',
  action: 'rule-action',
  cooldown: 'rule-cooldown',
  regex: 'rule-regex',
  note: 'rule-note',
  enabled: 'rule-enabled',
} as const;

const TEXT_INPUT = { autoComplete: 'off', autoCapitalize: 'off', autoCorrect: 'off', spellCheck: false } as const;

/**
 * The owner holds the whole form (D-15), so every value survives the Dialog to Drawer swap. Client
 * checks come from `validateRuleForm`; an invalid regex or status format from the Worker shows inline in
 * an alert and the dialog stays open with the values intact.
 */
export function RuleDialog({ open, onOpenChange, mode, rule, providers, actions }: RuleDialogProps) {
  const editing = mode === 'edit' && rule !== undefined;
  const [form, setForm] = useState<RuleForm>(() => (editing ? ruleToForm(rule) : emptyRuleForm(actions[0] ?? 'EXHAUSTED')));
  const [attempted, setAttempted] = useState(false);
  const save = useSaveRule(editing ? rule.id : undefined);

  const errors = validateRuleForm(form);
  const shown = attempted ? errors : {};
  const pending = save.isPending;
  const set = (changes: Partial<RuleForm>) => setForm((f) => ({ ...f, ...changes }));

  const submit = () => {
    if (pending) return;
    const firstBad = errors.status_codes || errors.rule ? ID.status : errors.priority ? ID.priority : errors.cooldown_s ? ID.cooldown : null;
    if (firstBad) {
      setAttempted(true);
      document.getElementById(firstBad)?.focus();
      return;
    }
    save
      .mutateAsync(buildRulePayload(form))
      .then(() => onOpenChange(false))
      .catch(() => {
        /* the server message shows in the alert through save.error */
      });
  };

  return (
    <ResponsiveDialog
      open={open}
      onOpenChange={(next) => {
        if (!pending) onOpenChange(next);
      }}
      title={editing ? `Edit rule #${rule.id}` : 'Add rule'}
      dismissible={!pending}
      footer={
        <>
          <Button variant="outline" className="h-11 flex-1 md:h-9 md:flex-none" onClick={() => onOpenChange(false)} disabled={pending}>
            {editing ? 'Discard changes' : 'Discard rule'}
          </Button>
          <Button className="h-11 flex-1 md:h-9 md:flex-none" onClick={submit} disabled={pending}>
            {pending ? 'Saving…' : 'Save rule'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {save.isError ? (
          <div role="alert" className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm break-words text-destructive">
            {save.error.message}
          </div>
        ) : null}

        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Scope" htmlFor={ID.scope}>
            <NativeSelect id={ID.scope} value={form.provider_id} onChange={(e) => set({ provider_id: e.target.value })}>
              <NativeSelectOption value="">Global (all providers)</NativeSelectOption>
              {providers.map((p) => (
                <NativeSelectOption key={p.id} value={String(p.id)}>
                  Provider: {p.name}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </Field>
          <Field label="Priority" htmlFor={ID.priority} helper="Lower runs first" error={shown.priority}>
            <Input
              id={ID.priority}
              inputMode="numeric"
              {...TEXT_INPUT}
              value={form.priority}
              aria-invalid={shown.priority ? true : undefined}
              aria-describedby={fieldMessageId(ID.priority)}
              onChange={(e) => set({ priority: e.target.value })}
            />
          </Field>
        </div>

        <Field
          label="HTTP statuses"
          htmlFor={ID.status}
          helper="Blank matches any status. Examples: 402, 401,403, 500-599"
          error={shown.status_codes ?? shown.rule}
        >
          <Input
            id={ID.status}
            {...TEXT_INPUT}
            placeholder="e.g. 402"
            value={form.status_codes}
            aria-invalid={shown.status_codes || shown.rule ? true : undefined}
            aria-describedby={fieldMessageId(ID.status)}
            onChange={(e) => set({ status_codes: e.target.value })}
          />
        </Field>

        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Action" htmlFor={ID.action}>
            <NativeSelect id={ID.action} value={form.action} onChange={(e) => set({ action: e.target.value })}>
              {actions.map((a) => (
                <NativeSelectOption key={a} value={a}>
                  {actionLabel(a)}
                </NativeSelectOption>
              ))}
              {/* A saved rule whose action the list no longer offers stays selectable instead of silently changing. */}
              {actions.includes(form.action as Action) ? null : <NativeSelectOption value={form.action}>{actionLabel(form.action)}</NativeSelectOption>}
            </NativeSelect>
          </Field>
          {form.action === 'RATE_LIMITED' ? (
            <Field label="Cooldown (seconds)" htmlFor={ID.cooldown} helper="How long the key rests after a rate limit." error={shown.cooldown_s}>
              <Input
                id={ID.cooldown}
                inputMode="numeric"
                {...TEXT_INPUT}
                value={form.cooldown_s}
                aria-invalid={shown.cooldown_s ? true : undefined}
                aria-describedby={fieldMessageId(ID.cooldown)}
                onChange={(e) => set({ cooldown_s: e.target.value })}
              />
            </Field>
          ) : null}
        </div>

        <Field label="Body regex" htmlFor={ID.regex} helper="Case-insensitive. Blank matches any body.">
          <Textarea
            id={ID.regex}
            rows={3}
            data-vaul-no-drag
            className="font-mono break-all"
            {...TEXT_INPUT}
            placeholder="insufficient_quota"
            value={form.body_regex}
            aria-describedby={fieldMessageId(ID.regex)}
            onChange={(e) => set({ body_regex: e.target.value })}
          />
        </Field>

        <Field label="Note" htmlFor={ID.note}>
          <Input id={ID.note} {...TEXT_INPUT} placeholder="Why this rule exists" value={form.note} onChange={(e) => set({ note: e.target.value })} />
        </Field>

        <label htmlFor={ID.enabled} className="flex min-h-11 cursor-pointer items-center justify-between gap-4">
          <span className="text-sm font-semibold">Rule enabled</span>
          <Switch id={ID.enabled} checked={form.enabled} onCheckedChange={(enabled) => set({ enabled })} />
        </label>
      </div>
    </ResponsiveDialog>
  );
}
