import type { ReactNode } from 'react';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { Field, fieldMessageId } from '@/components/field';
import {
  PROVIDER_FORMATS,
  type BalanceMode,
  type FormErrors,
  type FormMode,
  type KeyStrategy,
  type ProviderForm,
  type ProviderFormat,
  type RecheckMode,
} from '@/lib/provider-form';

interface AdvancedSectionProps {
  form: ProviderForm;
  /** The owner applies the patch to its form; this section keeps nothing of its own (D-15). */
  onChange: (patch: Partial<ProviderForm>) => void;
  mode: FormMode;
  errors: FormErrors;
}

const FORMAT_LABEL: Record<ProviderFormat, string> = {
  anthropic: 'anthropic (/v1/messages)',
  'openai-chat': 'openai-chat (/v1/chat/completions)',
  'openai-responses': 'openai-responses (/v1/responses)',
};

// Text boxes that take a URL, a path, a model or a header: no capitalising or correcting on phones (D-16).
const RAW_TEXT = { autoCapitalize: 'off', autoCorrect: 'off', spellCheck: false, autoComplete: 'off' } as const;

function Subgroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-4 border-t border-border-subtle pt-4">
      <h3 className="text-xs font-semibold">{title}</h3>
      {children}
    </section>
  );
}

// A whole-row label (min 44px) with the Switch on the right, so the row is the touch target.
function SwitchRow({
  id,
  label,
  helper,
  checked,
  onCheckedChange,
}: {
  id: string;
  label: string;
  helper: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <label htmlFor={id} className="flex min-h-11 cursor-pointer items-center justify-between gap-4">
      <span className="flex min-w-0 flex-col gap-1">
        <span className="text-xs font-semibold">{label}</span>
        <span id={fieldMessageId(id)} className="text-xs break-words text-muted-foreground">
          {helper}
        </span>
      </span>
      <Switch id={id} checked={checked} onCheckedChange={onCheckedChange} aria-describedby={fieldMessageId(id)} />
    </label>
  );
}

const invalid = (error: string | undefined) => (error ? true : undefined);
const describedBy = (id: string) => fieldMessageId(id);

/**
 * The five Advanced subgroups over controlled form state (D-13 to D-16). Every control has an id equal
 * to its form key so the dialog can focus the first invalid one. All of it stays mounted when the
 * section is collapsed, so values persist and survive the Dialog to Drawer swap at 768px.
 */
export function AdvancedSection({ form, onChange, mode, errors }: AdvancedSectionProps) {
  const toggleFormat = (format: ProviderFormat, on: boolean) => {
    const next = PROVIDER_FORMATS.filter((f) => (f === format ? on : form.formats.includes(f)));
    onChange({ formats: next });
  };

  return (
    <div className="flex flex-col gap-6">
      <Subgroup title="Formats">
        <div className="flex flex-col" role="group" aria-labelledby="formats-label">
          <span id="formats-label" className="text-xs font-semibold">
            Wire formats
          </span>
          {PROVIDER_FORMATS.map((f, i) => {
            const id = i === 0 ? 'formats' : `format-${f}`;
            return (
              <label key={f} htmlFor={id} className="flex min-h-11 cursor-pointer items-center gap-3 text-sm">
                <Checkbox
                  id={id}
                  checked={form.formats.includes(f)}
                  onCheckedChange={(on) => toggleFormat(f, on === true)}
                  aria-invalid={invalid(errors.formats)}
                  aria-describedby={describedBy('formats')}
                />
                <span className="min-w-0 break-all">{FORMAT_LABEL[f]}</span>
              </label>
            );
          })}
          <p id={fieldMessageId('formats')} className={errors.formats ? 'text-xs break-words text-destructive' : 'text-xs break-words text-muted-foreground'}>
            {errors.formats ?? 'Default: all three. At least one is required.'}
          </p>
        </div>
      </Subgroup>

      <Subgroup title="Keys & rotation">
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Key strategy" htmlFor="key_strategy" helper="Default: Sequential.">
            <NativeSelect
              id="key_strategy"
              value={form.key_strategy}
              aria-describedby={describedBy('key_strategy')}
              onChange={(e) => onChange({ key_strategy: e.target.value as KeyStrategy })}
            >
              <NativeSelectOption value="sequential">Sequential (use #1 until it fails)</NativeSelectOption>
              <NativeSelectOption value="round_robin">Round-robin (spread across active keys)</NativeSelectOption>
            </NativeSelect>
          </Field>
          <Field label="Response timeout (ms)" htmlFor="timeout_ms" helper="Default: 60000 ms." error={errors.timeout_ms}>
            <Input
              id="timeout_ms"
              type="number"
              inputMode="numeric"
              min={1000}
              max={300000}
              value={form.timeout_ms}
              aria-invalid={invalid(errors.timeout_ms)}
              aria-describedby={describedBy('timeout_ms')}
              onChange={(e) => onChange({ timeout_ms: e.target.value })}
            />
          </Field>
        </div>
      </Subgroup>

      <Subgroup title="Models">
        <Field
          label="Model map"
          htmlFor="model_map"
          helper="Optional. Example: claude-3-7-sonnet-*=claude-3-7-sonnet-20250219"
          error={errors.model_map}
        >
          <Textarea
            id="model_map"
            rows={3}
            data-vaul-no-drag
            className="font-mono break-all"
            {...RAW_TEXT}
            placeholder="client-pattern=upstream-model"
            value={form.model_map}
            aria-invalid={invalid(errors.model_map)}
            aria-describedby={describedBy('model_map')}
            onChange={(e) => onChange({ model_map: e.target.value })}
          />
        </Field>
        <SwitchRow
          id="model_allowlist"
          label="Strict allowlist"
          helper="Default: off. Only route models that are fetched or mapped."
          checked={form.model_allowlist}
          onCheckedChange={(model_allowlist) => onChange({ model_allowlist })}
        />
      </Subgroup>

      <Subgroup title="Balance & recheck">
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Balance mode" htmlFor="balance_mode" helper="Default: Standard.">
            <NativeSelect
              id="balance_mode"
              value={form.balance_mode}
              aria-describedby={describedBy('balance_mode')}
              onChange={(e) => onChange({ balance_mode: e.target.value as BalanceMode })}
            >
              <NativeSelectOption value="standard">Standard (/v1/dashboard/billing/*)</NativeSelectOption>
              <NativeSelectOption value="custom">Custom JSON endpoint</NativeSelectOption>
              <NativeSelectOption value="none">None</NativeSelectOption>
            </NativeSelect>
          </Field>
          <Field label="Recheck mode" htmlFor="recheck_mode" helper="Default: Auto.">
            <NativeSelect
              id="recheck_mode"
              value={form.recheck_mode}
              aria-describedby={describedBy('recheck_mode')}
              onChange={(e) => onChange({ recheck_mode: e.target.value as RecheckMode })}
            >
              <NativeSelectOption value="auto">Auto (balance, then 1-token test)</NativeSelectOption>
              <NativeSelectOption value="balance">Balance endpoint only</NativeSelectOption>
              <NativeSelectOption value="manual">Manual re-enable only</NativeSelectOption>
            </NativeSelect>
          </Field>
        </div>

        {/* The custom fields stay in the form state when the mode is switched away, so switching back finds them. */}
        {form.balance_mode === 'custom' ? (
          <div className="grid gap-4 md:grid-cols-2">
            <Field label="Custom balance path" htmlFor="balance_path" helper="e.g. /api/usage/token">
              <Input
                id="balance_path"
                {...RAW_TEXT}
                placeholder="/api/usage/token"
                value={form.balance_path}
                aria-describedby={describedBy('balance_path')}
                onChange={(e) => onChange({ balance_path: e.target.value })}
              />
            </Field>
            <Field label="JSON field" htmlFor="balance_field" helper="e.g. data.total_available">
              <Input
                id="balance_field"
                {...RAW_TEXT}
                placeholder="data.total_available"
                value={form.balance_field}
                aria-describedby={describedBy('balance_field')}
                onChange={(e) => onChange({ balance_field: e.target.value })}
              />
            </Field>
            <Field label="Divisor" htmlFor="balance_divisor" helper="Default: 1." error={errors.balance_divisor}>
              <Input
                id="balance_divisor"
                type="number"
                inputMode="decimal"
                step="any"
                min={0}
                value={form.balance_divisor}
                aria-invalid={invalid(errors.balance_divisor)}
                aria-describedby={describedBy('balance_divisor')}
                onChange={(e) => onChange({ balance_divisor: e.target.value })}
              />
            </Field>
          </div>
        ) : null}

        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Recheck interval (hours)" htmlFor="recheck_hours" helper="Default: 6 hours." error={errors.recheck_hours}>
            <Input
              id="recheck_hours"
              type="number"
              inputMode="decimal"
              step="any"
              min={0.25}
              max={720}
              value={form.recheck_hours}
              aria-invalid={invalid(errors.recheck_hours)}
              aria-describedby={describedBy('recheck_hours')}
              onChange={(e) => onChange({ recheck_hours: e.target.value })}
            />
          </Field>
          <Field label="Test model" htmlFor="test_model" helper="Default: picked from the fetched models when blank.">
            <Input
              id="test_model"
              {...RAW_TEXT}
              value={form.test_model}
              aria-describedby={describedBy('test_model')}
              onChange={(e) => onChange({ test_model: e.target.value })}
            />
          </Field>
        </div>
      </Subgroup>

      <Subgroup title="Other">
        <Field
          label="Extra headers"
          htmlFor="extra_headers"
          helper="Optional. Example: HTTP-Referer=https://example.com"
          error={errors.extra_headers}
        >
          <Textarea
            id="extra_headers"
            rows={2}
            data-vaul-no-drag
            className="font-mono break-all"
            {...RAW_TEXT}
            placeholder="Header=Value"
            value={form.extra_headers}
            aria-invalid={invalid(errors.extra_headers)}
            aria-describedby={describedBy('extra_headers')}
            onChange={(e) => onChange({ extra_headers: e.target.value })}
          />
        </Field>
        <SwitchRow
          id="parse_usage"
          label="Parse token usage"
          helper="Default: on."
          checked={form.parse_usage}
          onCheckedChange={(parse_usage) => onChange({ parse_usage })}
        />
        <SwitchRow
          id="enabled"
          label="Provider enabled"
          helper="Default: on."
          checked={form.enabled}
          onCheckedChange={(enabled) => onChange({ enabled })}
        />
        {mode === 'create' ? (
          <SwitchRow
            id="add_to_default"
            label="Add to default route"
            helper="Default: on."
            checked={form.add_to_default}
            onCheckedChange={(add_to_default) => onChange({ add_to_default })}
          />
        ) : null}
      </Subgroup>
    </div>
  );
}
