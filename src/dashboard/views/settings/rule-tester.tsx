import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Textarea } from '@/components/ui/textarea';
import { Field, fieldMessageId } from '@/components/field';
import { ActionBadge } from '@/components/status-badge';
import { useRuleTest } from '@/hooks/use-settings';
import type { ErrorRuleDTO, ProviderDTO } from '@/lib/api';
import { actionConsequence, actionLabel, fmtCooldown, plainActionText } from '@/lib/format';
import { buildTesterPayload, ruleMatchLabel, validateTester, type TesterForm } from '@/lib/rule-form';

const SAMPLE_BODY = '{"error":{"message":"You exceeded your current quota, please check your plan and billing details."}}';

/**
 * Dry-runs the classifier against a sample error (VIEW-07). Nothing is saved. The result appears only
 * after a run and stays until the next one; its text wraps and a failure shows in the danger colour.
 */
export function RuleTester({ providers, rules }: { providers: ProviderDTO[]; rules: ErrorRuleDTO[] }) {
  const [form, setForm] = useState<TesterForm>({ provider_id: '', status: '429', retry_after: '', body: SAMPLE_BODY });
  const [attempted, setAttempted] = useState(false);
  const test = useRuleTest();
  const set = (changes: Partial<TesterForm>) => setForm((f) => ({ ...f, ...changes }));
  const statusError = validateTester(form).status;
  const shownStatus = attempted ? statusError : undefined;
  const result = test.data;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Rule tester</CardTitle>
        <CardDescription>See how the gateway would classify an upstream error. Nothing is saved.</CardDescription>
      </CardHeader>
      <CardContent>
        <form
          noValidate
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (test.isPending) return;
            if (statusError) {
              setAttempted(true);
              document.getElementById('tester-status')?.focus();
              return;
            }
            test.mutate(buildTesterPayload(form));
          }}
        >
          <Field
            label="Scope"
            htmlFor="tester-scope"
            helper="“All providers” tests global rules only. Select a provider to include its rules and drop list."
          >
            <NativeSelect
              id="tester-scope"
              value={form.provider_id}
              aria-describedby={fieldMessageId('tester-scope')}
              onChange={(e) => set({ provider_id: e.target.value })}
            >
              <NativeSelectOption value="">All providers</NativeSelectOption>
              {providers.map((p) => (
                <NativeSelectOption key={p.id} value={String(p.id)}>
                  {p.name}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="HTTP status" htmlFor="tester-status" error={shownStatus}>
              <Input
                id="tester-status"
                inputMode="numeric"
                autoComplete="off"
                value={form.status}
                aria-invalid={shownStatus ? true : undefined}
                aria-describedby={shownStatus ? fieldMessageId('tester-status') : undefined}
                onChange={(e) => set({ status: e.target.value })}
              />
            </Field>
            <Field label="Retry-After" htmlFor="tester-retry">
              <Input
                id="tester-retry"
                autoComplete="off"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                placeholder="e.g. 30"
                value={form.retry_after}
                onChange={(e) => set({ retry_after: e.target.value })}
              />
            </Field>
          </div>
          <Field label="Sample error body" htmlFor="tester-body">
            <Textarea
              id="tester-body"
              rows={4}
              data-vaul-no-drag
              className="font-mono break-all"
              autoComplete="off"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              value={form.body}
              onChange={(e) => set({ body: e.target.value })}
            />
          </Field>
          <div>
            <Button type="submit" variant="outline" className="h-11 md:h-9" disabled={test.isPending}>
              {test.isPending ? 'Classifying…' : 'Classify sample'}
            </Button>
          </div>
          {test.isError ? (
            <p role="alert" className="text-sm break-words text-destructive">
              {test.error.message}
            </p>
          ) : result ? (
            <div role="status" className="flex min-w-0 flex-col gap-2 rounded-lg border p-3 text-sm wrap-anywhere">
              <p className="font-semibold">This would: {actionLabel(result.action, { cooldownS: result.cooldownS })}</p>
              <div className="flex flex-wrap items-center gap-2">
                <ActionBadge action={result.action} cooldownS={result.cooldownS} />
              </div>
              <p className="text-xs text-muted-foreground">{actionConsequence(result.action)}</p>
              <div className="flex flex-wrap gap-2 font-mono text-xs">
                <span>{ruleMatchLabel(result.ruleId, rules, providers)}</span>
                {result.cooldownS !== null ? <span>pause {fmtCooldown(result.cooldownS)}</span> : null}
              </div>
              <p className="text-muted-foreground">{plainActionText(result.reason)}</p>
            </div>
          ) : null}
        </form>
      </CardContent>
    </Card>
  );
}
