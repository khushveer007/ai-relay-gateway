import { useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Field, fieldMessageId } from '@/components/field';
import { FormError } from '@/components/form-error';
import { ResponsiveDialog } from '@/components/responsive-dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { ApiError, priceApi, type ModelPriceResolutionDTO, type PriceDTO, type PriceOverrideInput } from '@/lib/api';
import { PRICE_QUERY_KEY } from '@/lib/queries';
import { quantizeRate, RATE_FIELDS, type RateFields, validModelName } from '../../../shared/pricing';

type RateField = keyof RateFields;
type RateGroup = 'base' | 'tier';
type Draft = Partial<Record<RateField, string | null>>;
const INVALID_MODEL = 'Use an exact model name of 1–512 UTF-8 bytes without surrounding whitespace or control characters.';

export const RATE_LABEL = { input: 'Input', output: 'Output', cache_read: 'Cache read', cache_write: 'Cache write' } as const;

function rateDecimal(picos: number, minimumDecimals = 0): string {
  const whole = Math.floor(picos / 1_000_000);
  const fraction = String(picos % 1_000_000).padStart(6, '0').replace(/0+$/, '').padEnd(minimumDecimals, '0');
  return fraction ? whole + '.' + fraction : String(whole);
}

export function displayRate(rate: number | null): string {
  return rate === null ? 'Rate unavailable' : '$' + rateDecimal(rate, 2);
}

export function hasUsablePrice(price: PriceDTO): boolean {
  return RATE_FIELDS.some((field) => price.effective_base[field] !== null);
}

function saveError(error: Error | null, message: string) {
  if (!error) return null;
  if (error instanceof ApiError && (error.status === 400 || error.status === 409)) return message + ' ' + error.message;
  return message;
}

export function PriceEditor({ model, price, title, onClose }: { model: string; price?: PriceDTO; title: 'Set price' | 'Edit price'; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<Record<RateGroup, Draft>>({ base: {}, tier: {} });
  const [attempted, setAttempted] = useState(false);
  const submitting = useRef(false);
  const save = useMutation({
    mutationFn: priceApi.override,
    onSuccess: () => {
      toast.success('Price saved.');
      void queryClient.invalidateQueries({ queryKey: PRICE_QUERY_KEY });
      onClose();
    },
    onSettled: () => { submitting.current = false; },
  });
  const payload: PriceOverrideInput = { model };
  const invalid = new Set<string>();
  for (const group of ['base', 'tier'] as const) {
    for (const field of RATE_FIELDS) {
      const raw = draft[group][field];
      if (raw === undefined) continue;
      if (raw === '') {
        const effective = group === 'base' ? price?.effective_base[field] : price?.effective_tier.rates[field];
        if (effective != null) invalid.add(group + '-' + field);
        continue;
      }
      const parsed = raw === null ? null : quantizeRate(raw.trim(), 'usd_per_million');
      if (raw !== null && parsed === null) {
        invalid.add(group + '-' + field);
        continue;
      }
      (payload[group] ??= {})[field] = parsed;
    }
  }
  const hasChanges = Boolean(payload.base || payload.tier);
  const pending = save.isPending;
  const modelError = validModelName(model) ? null : INVALID_MODEL;

  function submit() {
    if (submitting.current || modelError || !hasChanges && invalid.size === 0) return;
    if (invalid.size) {
      setAttempted(true);
      document.getElementById('price-' + invalid.values().next().value)?.focus();
      return;
    }
    submitting.current = true;
    save.mutate(payload);
  }

  function fields(group: RateGroup, effective?: RateFields, catalog?: RateFields, overrides?: RateFields) {
    return RATE_FIELDS.map((field) => {
      const id = 'price-' + group + '-' + field;
      const current = effective?.[field] ?? null;
      const catalogRate = catalog?.[field] ?? null;
      const overridden = overrides?.[field] != null;
      const value = draft[group][field];
      const shown = value === undefined ? current : value === null ? catalogRate : null;
      const error = attempted && invalid.has(group + '-' + field) ? 'Enter a non-negative rate.' : undefined;
      const helper = overridden && value !== null
        ? (catalogRate === null ? 'Catalog rate unavailable' : 'Catalog ' + displayRate(catalogRate))
        : shown === null && !value ? 'Rate unavailable' : undefined;
      const set = (next: string | null) => setDraft((prev) => ({ ...prev, [group]: { ...prev[group], [field]: next } }));
      return (
        <Field
          key={field}
          label={RATE_LABEL[field]}
          htmlFor={id}
          error={error}
          helper={helper}
        >
          <Input
            id={id}
            inputMode="decimal"
            className="font-mono"
            autoComplete="off"
            disabled={pending}
            aria-invalid={error ? true : undefined}
            aria-describedby={error || helper ? fieldMessageId(id) : undefined}
            value={typeof value === 'string' ? value : shown === null ? '' : rateDecimal(shown)}
            onChange={(event) => set(event.target.value)}
          />
          {overridden && catalogRate !== null && value !== null ? (
            <Button variant="outline" size="sm" className="h-11 w-fit md:h-8" onClick={() => set(null)} disabled={pending}>
              Use catalog rate
            </Button>
          ) : null}
        </Field>
      );
    });
  }

  return (
    <ResponsiveDialog
      open
      onOpenChange={(open) => { if (!open && !pending) onClose(); }}
      title={title}
      description="USD per 1M tokens"
      dismissible={!pending}
      footer={
        <>
          <Button variant="outline" className="min-h-11 flex-1 whitespace-normal md:flex-none" onClick={onClose} disabled={pending}>Cancel price edit</Button>
          <Button className="min-h-11 flex-1 whitespace-normal md:flex-none" onClick={submit} disabled={pending || !!modelError || (!hasChanges && !invalid.size)}>
            {pending ? 'Saving price…' : 'Save price'}
          </Button>
        </>
      }
    >
      <div className="flex min-w-0 flex-col gap-4">
        <p className="font-mono text-sm wrap-anywhere">{model}</p>
        <FormError message={modelError ?? saveError(save.error, 'Couldn’t save the price. Try Save price again.')} />
        <div className="grid gap-4 md:grid-cols-2">{fields('base', price?.effective_base, price?.catalog_base, price?.override_base)}</div>
        {price?.effective_tier.state === 'supported' ? (
          <fieldset className="grid gap-4 border-t pt-4 md:grid-cols-2">
            <legend className="pr-2 text-sm font-semibold">Long-context rates</legend>
            {fields('tier', price.effective_tier.rates, price.catalog_tier.rates, price.override_tier)}
          </fieldset>
        ) : null}
      </div>
    </ResponsiveDialog>
  );
}

export function AliasEditor({ model, prices, onClose }: { model: ModelPriceResolutionDTO; prices: PriceDTO[]; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [target, setTarget] = useState('');
  const [attempted, setAttempted] = useState(false);
  const submitting = useRef(false);
  const eligible = prices.filter((price) => price.catalog_imported && hasUsablePrice(price));
  const matching = eligible.filter((price) => model.candidates.includes(price.model));
  const others = eligible.filter((price) => !model.candidates.includes(price.model));
  const validTarget = eligible.some((price) => price.model === target);
  const modelError = validModelName(model.upstream_model) ? null : INVALID_MODEL;
  const save = useMutation({
    mutationFn: () => priceApi.pin(model.upstream_model, target),
    onSuccess: () => {
      toast.success('Alias saved.');
      void queryClient.invalidateQueries({ queryKey: PRICE_QUERY_KEY });
      onClose();
    },
    onSettled: () => { submitting.current = false; },
  });
  const pending = save.isPending;
  const targetId = 'priced-catalog-model';
  const error = attempted && !validTarget ? 'Choose a priced catalog model.' : undefined;

  function submit() {
    if (submitting.current || modelError) return;
    if (!validTarget) {
      setAttempted(true);
      document.getElementById(targetId)?.focus();
      return;
    }
    submitting.current = true;
    save.mutate();
  }

  return (
    <ResponsiveDialog
      open
      onOpenChange={(open) => { if (!open && !pending) onClose(); }}
      title="Pin alias"
      dismissible={!pending}
      footer={
        <>
          <Button variant="outline" className="min-h-11 flex-1 whitespace-normal md:flex-none" onClick={onClose} disabled={pending}>Cancel alias edit</Button>
          <Button className="min-h-11 flex-1 whitespace-normal md:flex-none" onClick={submit} disabled={pending || !eligible.length || !!modelError}>
            {pending ? 'Saving alias…' : 'Save alias'}
          </Button>
        </>
      }
    >
      <div className="flex min-w-0 flex-col gap-4">
        <p className="font-mono text-sm wrap-anywhere">{model.upstream_model}</p>
        <FormError message={modelError ?? saveError(save.error, 'Couldn’t save the alias. Try Save alias again.')} />
        {model.candidates.length ? (
          <div>
            <h3 className="text-sm font-semibold">Matching candidates</h3>
            <ul className="mt-1 space-y-1 font-mono text-sm wrap-anywhere">
              {model.candidates.map((candidate) => <li key={candidate}>{candidate}</li>)}
            </ul>
          </div>
        ) : null}
        <Field label="Priced catalog model" htmlFor={targetId} error={error}
          helper={eligible.length ? undefined : 'No priced catalog models available. Refresh prices to import rates.'}>
          <NativeSelect id={targetId} value={validTarget ? target : ''} aria-invalid={error ? true : undefined}
            aria-describedby={error || !eligible.length ? fieldMessageId(targetId) : undefined}
            disabled={pending || !eligible.length} onChange={(event) => setTarget(event.target.value)}>
            <NativeSelectOption value="">Choose a model</NativeSelectOption>
            {matching.length ? (
              <optgroup label="Matching candidates">
                {matching.map((price) => <NativeSelectOption key={price.model} value={price.model}>{price.model}</NativeSelectOption>)}
              </optgroup>
            ) : null}
            {others.length ? (
              <optgroup label="Other priced catalog models">
                {others.map((price) => <NativeSelectOption key={price.model} value={price.model}>{price.model}</NativeSelectOption>)}
              </optgroup>
            ) : null}
          </NativeSelect>
        </Field>
        {validTarget ? <p className="font-mono text-sm wrap-anywhere">{target}</p> : null}
      </div>
    </ResponsiveDialog>
  );
}
