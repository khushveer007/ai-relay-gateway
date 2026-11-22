import { useQuery } from '@tanstack/react-query';
import { Field, fieldMessageId } from '@/components/field';
import { RiskNote } from '@/components/risk-note';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { globalDropNote, type FormErrors, type ProviderForm } from '@/lib/provider-form';
import { rulesQuery } from '@/lib/queries';

interface DropKeysSectionProps {
  form: ProviderForm;
  onChange: (patch: Partial<ProviderForm>) => void;
  errors: FormErrors;
  onCodesBlur: () => void;
}

const RAW_TEXT = { autoCapitalize: 'off', autoCorrect: 'off', spellCheck: false, autoComplete: 'off' } as const;
const RISK_ID = 'drop_codes-risk';

export function DropKeysSection({ form, onChange, errors, onCodesBlur }: DropKeysSectionProps) {
  const { data, isPending } = useQuery(rulesQuery);
  return (
    <div className="flex flex-col gap-4">
      {isPending ? (
        <Skeleton className="h-4 w-full max-w-96" />
      ) : (
        <p className="text-xs break-words text-muted-foreground">
          {data ? globalDropNote(data.rules) : 'Could not load the global rules. Your list still saves.'}
        </p>
      )}
      <Field
        label="HTTP status codes"
        htmlFor="drop_codes"
        error={errors.drop_codes}
        helper="Separate with commas or spaces. Ranges like 500-503 work. Limit 100 characters after spacing is normalized."
      >
        <Input
          id="drop_codes"
          inputMode="text"
          {...RAW_TEXT}
          placeholder="403, 418 or 500-503"
          value={form.drop_codes}
          aria-invalid={errors.drop_codes ? true : undefined}
          aria-describedby={`${fieldMessageId('drop_codes')} ${RISK_ID}`}
          onChange={(e) => onChange({ drop_codes: e.target.value })}
          onBlur={onCodesBlur}
        />
      </Field>
      <RiskNote text={form.drop_codes} id={RISK_ID} />
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
