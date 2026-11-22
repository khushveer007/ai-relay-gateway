import { useReducer, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, CircleAlert, CircleCheck } from 'lucide-react';
import { toast } from 'sonner';
import { FormError } from '@/components/form-error';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Field, fieldMessageId } from '@/components/field';
import { ResponsiveDialog } from '@/components/responsive-dialog';
import { useUpdateProvider } from '@/hooks/use-provider-actions';
import { api, type ProviderDTO } from '@/lib/api';
import {
  ADVANCED_FIELDS,
  DROP_FIELDS,
  buildProviderPayload,
  dropSummary,
  emptyProviderForm,
  initialTestState,
  linesToMap,
  providerToForm,
  splitKeys,
  testReducer,
  validateProviderForm,
  type FormErrorKey,
  type ProviderForm,
  type TestResult,
} from '@/lib/provider-form';
import { cn } from '@/lib/utils';
import { AdvancedSection } from './advanced-section';
import { DropKeysSection } from './drop-keys-section';

interface CreateResponse {
  id: number;
  keys: { added: number; duplicates: number };
  models: string[] | null;
  models_error: string | null;
}

interface ProviderFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Create starts from the defaults; edit starts from `provider` with every loaded value (PRV-03). */
  mode: 'create' | 'edit';
  provider?: ProviderDTO;
  initialDropOpen?: boolean;
}

const NAME_ID = 'provider-name';
const URL_ID = 'provider-base-url';
const KEYS_ID = 'provider-keys';

// Top to bottom, as the fields appear: the first one with an error gets focus.
const FOCUS_ORDER: readonly FormErrorKey[] = ['name', 'base_url', 'drop_codes', 'formats', 'timeout_ms', 'model_map', 'balance_divisor', 'recheck_hours', 'extra_headers'];
const FIELD_ID: Partial<Record<FormErrorKey, string>> = { name: NAME_ID, base_url: URL_ID };

function hostOf(rawUrl: string): string {
  try {
    return new URL(rawUrl.trim()).host;
  } catch {
    return rawUrl.trim();
  }
}

function testLine(result: TestResult, baseUrl: string): string {
  // The Worker answers 400 'no key to test with' when an edited provider has no stored key (D-19).
  if (!result.ok && /no key to test with/i.test(result.message ?? '')) return 'No key to test with. Add a key first.';
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
export function ProviderFormDialog({ open, onOpenChange, mode, provider, initialDropOpen }: ProviderFormDialogProps) {
  const queryClient = useQueryClient();
  const editing = mode === 'edit' && provider !== undefined;
  // Initialised once: the page and the card mount this only while it is open, so each opening starts fresh.
  const [form, setForm] = useState<ProviderForm>(() => (editing ? providerToForm(provider) : emptyProviderForm()));
  const [dropOpen, setDropOpen] = useState(initialDropOpen ?? false);
  // Advanced is collapsed on open in both modes (D-13); its fields stay mounted either way (D-15).
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const update = useUpdateProvider(provider?.id ?? 0);
  const [attempted, setAttempted] = useState(false);
  const [touched, setTouched] = useState<Partial<Record<'name' | 'base_url' | 'drop_codes', boolean>>>({});
  const [testState, dispatchTest] = useReducer(testReducer, initialTestState);

  const set = <K extends keyof ProviderForm>(key: K, value: ProviderForm[K]) => setForm((f) => ({ ...f, [key]: value }));
  const resetTest = () => {
    if (testState.status !== 'idle') dispatchTest({ type: 'reset' });
  };

  const errors = validateProviderForm(form, mode);
  const shown = {
    name: attempted || touched.name ? errors.name : undefined,
    base_url: attempted || touched.base_url ? errors.base_url : undefined,
    drop_codes: attempted || touched.drop_codes ? errors.drop_codes : undefined,
  };
  // Advanced errors show after the first Save attempt and then follow the field live.
  const advancedErrors = attempted ? errors : {};

  // Edit mode needs no typed key: the Worker tests with the provider's first stored key (D-19, PRV-04).
  const hasKeys = splitKeys(form.keys).length > 0;
  const keyOk = editing || hasKeys;
  const canTest = !errors.base_url && keyOk && testState.status !== 'running';
  const testHint = errors.base_url
    ? 'Enter a full URL to test the connection.'
    : !keyOk
      ? 'Paste a key to test the connection.'
      : null;

  const test = useMutation({
    mutationFn: (_vars: { id: number }) =>
      api.post<TestResult>('/providers/test-connection', {
        base_url: form.base_url.trim(),
        extra_headers: linesToMap(form.extra_headers).map,
        // Edit sends the provider id and no keys; create sends the typed keys.
        ...(editing ? { provider_id: provider.id } : { keys: form.keys }),
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
      void queryClient.invalidateQueries({ queryKey: ['rules'] });
      onOpenChange(false);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['providers'] }),
  });

  const runTest = () => {
    if (!canTest) return;
    const id = testState.id + 1;
    dispatchTest({ type: 'start', id });
    test.mutate({ id });
  };

  const pending = create.isPending || update.isPending;
  const serverError = create.isError ? create.error.message : update.isError ? update.error.message : null;

  const patch = (changes: Partial<ProviderForm>) => {
    setForm((f) => ({ ...f, ...changes }));
    if ('extra_headers' in changes) resetTest();
  };

  const submit = () => {
    if (pending) return;
    setLocalError(null);
    const firstBad = FOCUS_ORDER.find((k) => errors[k]);
    if (firstBad) {
      setAttempted(true);
      if (DROP_FIELDS.includes(firstBad)) setDropOpen(true);
      if (ADVANCED_FIELDS.includes(firstBad)) setAdvancedOpen(true);
      requestAnimationFrame(() => {
        const el = document.getElementById(FIELD_ID[firstBad] ?? firstBad);
        if (el) el.focus();
        else setLocalError(`${errors[firstBad]} Switch Balance mode to Custom to see that field.`);
      });
      return;
    }
    if (editing) {
      update
        .mutateAsync(buildProviderPayload(form, 'edit'))
        .then(() => onOpenChange(false))
        .catch(() => {
          /* the server message shows in the banner through update.error */
        });
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
        if (!pending) onOpenChange(next);
      }}
      title={editing ? `Edit provider: ${provider.name}` : 'Add provider'}
      dismissible={!pending}
      description={editing ? 'Keys are added from the provider card with Add keys.' : 'Name, URL and keys are enough. Everything else has a working default.'}
      footer={
        <>
          <Button variant="outline" className="flex-1 md:flex-none" onClick={() => onOpenChange(false)} disabled={pending}>
            {editing ? 'Discard changes' : 'Discard provider'}
          </Button>
          <Button className="flex-1 md:flex-none" onClick={submit} disabled={pending}>
            {pending ? (editing ? 'Saving…' : 'Creating…') : editing ? 'Save changes' : 'Create provider'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <FormError message={serverError ?? localError} />

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

        {editing ? null : (
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
        )}

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

        <Collapsible open={dropOpen} onOpenChange={setDropOpen} className="flex flex-col gap-4">
          <CollapsibleTrigger asChild>
            <Button type="button" variant="outline" className="h-auto min-h-11 w-full justify-between py-2 text-left whitespace-normal" aria-expanded={dropOpen}>
              <span className="flex min-w-0 flex-col items-start gap-1">
                <span>Drop keys</span>
                <span className="text-xs font-normal wrap-anywhere text-muted-foreground">
                  {dropSummary(form) || 'Status codes that switch a key off until you re-enable it'}
                </span>
              </span>
              <ChevronDown aria-hidden="true" className={cn('transition-transform', dropOpen && 'rotate-180')} />
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent forceMount className={cn(!dropOpen && 'hidden')}>
            <DropKeysSection
              form={form}
              onChange={patch}
              errors={shown}
              onCodesBlur={() => setTouched((t) => ({ ...t, drop_codes: true }))}
            />
          </CollapsibleContent>
        </Collapsible>

        <Collapsible open={advancedOpen} onOpenChange={setAdvancedOpen} className="flex flex-col gap-4">
          <CollapsibleTrigger asChild>
            <Button type="button" variant="outline" className="h-auto min-h-11 w-full justify-between py-2 text-left whitespace-normal" aria-expanded={advancedOpen}>
              <span className="flex min-w-0 flex-col items-start gap-0.5">
                <span>Advanced</span>
                <span className="text-xs font-normal text-muted-foreground">Formats, rotation, models, balance, headers</span>
              </span>
              <ChevronDown aria-hidden="true" className={cn('transition-transform', advancedOpen && 'rotate-180')} />
            </Button>
          </CollapsibleTrigger>
          {/* forceMount keeps every field mounted with its value while closed; the closed state is only hidden. */}
          <CollapsibleContent forceMount className={cn(!advancedOpen && 'hidden')}>
            <AdvancedSection form={form} onChange={patch} mode={mode} errors={advancedErrors} />
          </CollapsibleContent>
        </Collapsible>
      </div>
    </ResponsiveDialog>
  );
}
