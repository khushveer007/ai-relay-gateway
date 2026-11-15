import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Field } from '@/components/field';
import { ResponsiveDialog } from '@/components/responsive-dialog';
import { splitKeys } from '@/lib/provider-form';

interface AddKeysDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  providerName: string;
  /** The pasted text and the prefix live in the card, so they survive the Dialog to Drawer swap (D-15). */
  keys: string;
  onKeysChange: (keys: string) => void;
  prefix: string;
  onPrefixChange: (prefix: string) => void;
  onSubmit: () => void;
  pending: boolean;
  error: string | null;
}

const KEYS_ID = 'add-keys-text';
const PREFIX_ID = 'add-keys-prefix';
const FORM_ID = 'add-keys-form';

/** Bulk add: one key per line or separated by commas or spaces, plus an optional alias prefix. Keys never leave this box except in the request. */
export function AddKeysDialog({
  open,
  onOpenChange,
  providerName,
  keys,
  onKeysChange,
  prefix,
  onPrefixChange,
  onSubmit,
  pending,
  error,
}: AddKeysDialogProps) {
  const canSubmit = splitKeys(keys).length > 0 && !pending;

  return (
    <ResponsiveDialog
      open={open}
      // A close request while the request runs is ignored, so the typed text and the pending state stay put.
      onOpenChange={(next) => {
        if (!pending) onOpenChange(next);
      }}
      title={`Add keys to ${providerName}`}
      dismissible={!pending}
      footer={
        <>
          <Button type="button" variant="outline" className="flex-1 md:flex-none" onClick={() => onOpenChange(false)} disabled={pending}>
            Discard keys
          </Button>
          <Button type="submit" form={FORM_ID} className="flex-1 md:flex-none" disabled={!canSubmit}>
            {pending ? 'Adding…' : 'Add keys'}
          </Button>
        </>
      }
    >
      <form
        id={FORM_ID}
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (canSubmit) onSubmit();
        }}
      >
        {error ? (
          <div role="alert" className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm break-words text-destructive">
            {error}
          </div>
        ) : null}
        <Field
          label="API keys"
          htmlFor={KEYS_ID}
          helper="One per line, or separated by commas or spaces. Duplicates are skipped. Keys are encrypted before they are stored."
        >
          <Textarea
            id={KEYS_ID}
            rows={5}
            data-vaul-no-drag
            className="max-h-48 overflow-y-auto font-mono break-all"
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            placeholder="sk-…"
            value={keys}
            aria-describedby={`${KEYS_ID}-message`}
            onChange={(e) => onKeysChange(e.target.value)}
          />
        </Field>
        <Field label="Alias prefix (optional)" htmlFor={PREFIX_ID}>
          <Input
            id={PREFIX_ID}
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            maxLength={40}
            placeholder="e.g. Account"
            value={prefix}
            onChange={(e) => onPrefixChange(e.target.value)}
          />
        </Field>
      </form>
    </ResponsiveDialog>
  );
}
