import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Field, fieldMessageId } from '@/components/field';
import { useSaveSettings } from '@/hooks/use-settings';
import type { SettingsDTO } from '@/lib/api';
import { buildSettingsPayload, settingsToForm, validateSettings, type SettingsForm } from '@/lib/rule-form';

const IDS = {
  max_attempts: 'settings-max-attempts',
  log_retention_days: 'settings-retention',
  balance_refresh_hours: 'settings-balance-hours',
} as const;

/**
 * The three gateway settings. Opens pre-filled from the saved values; a blank or out-of-range number
 * shows its allowed range under the field and blocks Save. A server error shows in a banner and the
 * entered values stay.
 */
export function SettingsFormCard({ settings }: { settings: SettingsDTO }) {
  const [form, setForm] = useState<SettingsForm>(() => settingsToForm(settings));
  const [attempted, setAttempted] = useState(false);
  const save = useSaveSettings();
  const errors = validateSettings(form);
  const shown = attempted ? errors : {};
  const pending = save.isPending;
  const set = (changes: Partial<SettingsForm>) => setForm((f) => ({ ...f, ...changes }));

  const submit = () => {
    if (pending) return;
    const first = (Object.keys(IDS) as Array<keyof SettingsForm>).find((k) => errors[k]);
    if (first) {
      setAttempted(true);
      document.getElementById(IDS[first])?.focus();
      return;
    }
    save.mutateAsync(buildSettingsPayload(form)).catch(() => {
      /* the server message shows in the banner through save.error */
    });
  };

  const common = (key: keyof SettingsForm) => ({
    id: IDS[key],
    value: form[key],
    autoComplete: 'off',
    'aria-invalid': shown[key] ? (true as const) : undefined,
    'aria-describedby': fieldMessageId(IDS[key]),
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => set({ [key]: e.target.value }),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Limits & maintenance</CardTitle>
      </CardHeader>
      <CardContent>
        <form
          className="flex flex-col gap-4"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          {save.isError ? (
            <div role="alert" className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm break-words text-destructive">
              {save.error.message}
            </div>
          ) : null}
          <Field
            label="Max attempts per request (1 to 40)"
            htmlFor={IDS.max_attempts}
            helper="Caps key and provider retries per client call. Cloudflare free allows 50 subrequests."
            error={shown.max_attempts}
          >
            <Input {...common('max_attempts')} inputMode="numeric" />
          </Field>
          <Field
            label="Log retention (days) (1 to 90)"
            htmlFor={IDS.log_retention_days}
            helper="Older logs are deleted by the 03:00 UTC cron."
            error={shown.log_retention_days}
          >
            <Input {...common('log_retention_days')} inputMode="numeric" />
          </Field>
          <Field
            label="Balance refresh (hours) (0.5 to 168)"
            htmlFor={IDS.balance_refresh_hours}
            helper="How often active key balances are rechecked."
            error={shown.balance_refresh_hours}
          >
            <Input {...common('balance_refresh_hours')} inputMode="decimal" />
          </Field>
          <div>
            <Button type="submit" className="h-11 md:h-9" disabled={pending}>
              {pending ? 'Saving…' : 'Save settings'}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
