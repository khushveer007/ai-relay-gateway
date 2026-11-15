import { useReducer, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { CircleAlert, CircleCheck } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Field, fieldMessageId } from '@/components/field';
import { ResponsiveDialog } from '@/components/responsive-dialog';
import { api } from '@/lib/api';
import {
  buildProviderPayload,
  emptyProviderForm,
  initialTestState,
  linesToMap,
  splitKeys,
  testReducer,
  validateProviderForm,
  type ProviderForm,
  type TestResult,
} from '@/lib/provider-form';

interface CreateResponse {
  id: number;
  keys: { added: number; duplicates: number };
  models: string[] | null;
  models_error: string | null;
}

interface ProviderFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const NAME_ID = 'provider-name';
const URL_ID = 'provider-base-url';
const KEYS_ID = 'provider-keys';

function hostOf(rawUrl: string): string {
  try {
    return new URL(rawUrl.trim()).host;
  } catch {
    return rawUrl.trim();
  }
}

function testLine(result: TestResult, baseUrl: string): string {
  if (result.ok) return `Connected, ${result.count ?? 0} models found.`;
  const message = result.message || 'No answer';
  if (result.status) return `HTTP ${result.status}: ${message}. You can still save.`;
  return `Could not reach ${hostOf(baseUrl)}: ${message}. You can still save.`;
}

function createdToast(res: CreateResponse, addedToDefault: boolean): string {
  const keys = `${res.keys.added} ${res.keys.added === 1 ? 'key' : 'keys'} added`;
  const models = res.models ? `${res.models.length} found` : res.models_error || 'not fetched';
  return `Provider created. ${keys}. Models: ${models}.${addedToDefault ? ' Added to the default route.' : ''}`;
}

// The owner holds the form, the test state and the validation flags, so every value survives the
// Dialog to Drawer swap at 768px (D-15): the children below are controlled and keep no state.
export function ProviderFormDialog({ open, onOpenChange }: ProviderFormDialogProps) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState<ProviderForm>(emptyProviderForm);
  const [attempted, setAttempted] = useState(false);
  const [touched, setTouched] = useState<{ name?: boolean; base_url?: boolean }>({});
  const [testState, dispatchTest] = useReducer(testReducer, initialTestState);

  const set = <K extends keyof ProviderForm>(key: K, value: ProviderForm[K]) => setForm((f) => ({ ...f, [key]: value }));
  const resetTest = () => {
    if (testState.status !== 'idle') dispatchTest({ type: 'reset' });
  };

  const errors = validateProviderForm(form, 'create');
  const shown = {
    name: attempted || touched.name ? errors.name : undefined,
    base_url: attempted || touched.base_url ? errors.base_url : undefined,
  };

  const hasKeys = splitKeys(form.keys).length > 0;
  const canTest = !errors.base_url && hasKeys && testState.status !== 'running';
  const testHint = errors.base_url
    ? 'Enter a full URL to test the connection.'
    : !hasKeys
      ? 'Paste a key to test the connection.'
      : null;

  const test = useMutation({
    mutationFn: (_vars: { id: number }) =>
      api.post<TestResult>('/providers/test-connection', {
        base_url: form.base_url.trim(),
        keys: form.keys,
        extra_headers: linesToMap(form.extra_headers).map,
      }),
    // Results apply only through the reducer, which drops one whose id is stale (PRV-04).
    onSuccess: (result, { id }) => dispatchTest({ type: 'settle', id, result }),
    onError: (error, { id }) => dispatchTest({ type: 'settle', id, result: { ok: false, status: 0, message: error.message, ms: 0 } }),
  });

  const create = useMutation({
    mutationFn: () => api.post<CreateResponse>('/providers', buildProviderPayload(form, 'create')),
    onSuccess: (res) => {
      toast.success(createdToast(res, form.add_to_default));
      if (form.add_to_default) void queryClient.invalidateQueries({ queryKey: ['routes'] });
      onOpenChange(false);
    },
    // The Worker create is not atomic: a failure can leave the provider row behind, so always refetch.
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['providers'] }),
  });

  const runTest = () => {
    if (!canTest) return;
    const id = testState.id + 1;
    dispatchTest({ type: 'start', id });
    test.mutate({ id });
  };

  const submit = () => {
    if (create.isPending) return;
    if (errors.name || errors.base_url) {
      setAttempted(true);
      document.getElementById(errors.name ? NAME_ID : URL_ID)?.focus();
      return;
    }
    create.mutate();
  };

  const describedBy = (id: string, has: boolean) => (has ? fieldMessageId(id) : undefined);

  return (
    <ResponsiveDialog
      open={open}
      // A close request while the create is in flight is ignored, so the values and the pending state stay put.
      onOpenChange={(next) => {
        if (!create.isPending) onOpenChange(next);
      }}
      title="Add provider"
      dismissible={!create.isPending}
      description="Name, URL and keys are enough. Everything else has a working default."
      footer={
        <>
          <Button variant="outline" className="flex-1 md:flex-none" onClick={() => onOpenChange(false)} disabled={create.isPending}>
            Discard provider
          </Button>
          <Button className="flex-1 md:flex-none" onClick={submit} disabled={create.isPending}>
            {create.isPending ? 'Creating…' : 'Create provider'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {create.isError ? (
          <div role="alert" className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm break-words text-destructive">
            {create.error.message}
          </div>
        ) : null}

        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Name" htmlFor={NAME_ID} error={shown.name}>
            <Input
              id={NAME_ID}
              placeholder="e.g. Relay A"
              autoComplete="off"
              value={form.name}
              aria-invalid={shown.name ? true : undefined}
              aria-describedby={describedBy(NAME_ID, Boolean(shown.name))}
              onChange={(e) => set('name', e.target.value)}
              onBlur={() => setTouched((t) => ({ ...t, name: true }))}
            />
          </Field>
          <Field label="Base URL" htmlFor={URL_ID} error={shown.base_url}>
            <Input
              id={URL_ID}
              type="url"
              inputMode="url"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              autoComplete="off"
              placeholder="https://api.anthropic.com"
              value={form.base_url}
              aria-invalid={shown.base_url ? true : undefined}
              aria-describedby={describedBy(URL_ID, Boolean(shown.base_url))}
              onChange={(e) => {
                set('base_url', e.target.value);
                resetTest();
              }}
              onBlur={() => setTouched((t) => ({ ...t, base_url: true }))}
            />
          </Field>
        </div>

        <Field
          label="API keys"
          htmlFor={KEYS_ID}
          helper="One per line, or separated by commas or spaces. The gateway also fetches the model list with the first key."
        >
          <Textarea
            id={KEYS_ID}
            rows={3}
            className="max-h-48 overflow-y-auto font-mono break-all"
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            placeholder="sk-…"
            value={form.keys}
            aria-describedby={fieldMessageId(KEYS_ID)}
            onChange={(e) => {
              set('keys', e.target.value);
              resetTest();
            }}
          />
        </Field>

        <div className="flex flex-col gap-2">
          <Button type="button" variant="outline" className="w-full md:w-auto md:self-start" onClick={runTest} disabled={!canTest}>
            {testState.status === 'running' ? 'Testing…' : 'Test connection'}
          </Button>
          {testHint && testState.status !== 'running' ? <p className="text-xs text-muted-foreground">{testHint}</p> : null}
          <div aria-live="polite">
            {testState.status === 'done' && testState.result ? (
              <p
                className={`flex items-start gap-2 text-sm break-words ${testState.result.ok ? 'text-status-ok' : 'text-status-danger'}`}
              >
                {testState.result.ok ? (
                  <CircleCheck className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                ) : (
                  <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                )}
                <span className="min-w-0">{testLine(testState.result, form.base_url)}</span>
              </p>
            ) : null}
          </div>
        </div>
      </div>
    </ResponsiveDialog>
  );
}
