import { Field, fieldMessageId } from '@/components/field';
import { Input } from '@/components/ui/input';
import type { FormErrors, ProviderForm } from '@/lib/provider-form';

interface DropKeysSectionProps {
  form: ProviderForm;
  onChange: (patch: Partial<ProviderForm>) => void;
  errors: FormErrors;
  onCodesBlur: () => void;
}

const RAW_TEXT = { autoCapitalize: 'off', autoCorrect: 'off', spellCheck: false, autoComplete: 'off' } as const;

export function DropKeysSection({ form, onChange, errors, onCodesBlur }: DropKeysSectionProps) {
  return (
    <div className="flex flex-col gap-4">
      <Field
        label="HTTP status codes"
        htmlFor="drop_codes"
        error={errors.drop_codes}
        helper="Separate with commas or spaces. Ranges like 500-503 work."
      >
        <Input
          id="drop_codes"
          inputMode="text"
          {...RAW_TEXT}
          placeholder="403, 418 or 500-503"
          value={form.drop_codes}
          aria-invalid={errors.drop_codes ? true : undefined}
          aria-describedby={fieldMessageId('drop_codes')}
          onChange={(e) => onChange({ drop_codes: e.target.value })}
          onBlur={onCodesBlur}
        />
      </Field>
      <Field
        label="Only if message contains (optional)"
        htmlFor="drop_message"
        helper="Plain text, not case sensitive. Applies to every code above. Blank drops on the code alone."
      >
        <Input
          id="drop_message"
          inputMode="text"
          {...RAW_TEXT}
          maxLength={200}
          placeholder="e.g. quota exceeded"
          value={form.drop_message}
          aria-describedby={fieldMessageId('drop_message')}
          onChange={(e) => onChange({ drop_message: e.target.value })}
        />
      </Field>
    </div>
  );
}
