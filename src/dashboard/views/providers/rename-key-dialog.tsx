import { useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Field } from '@/components/field';
import { ResponsiveDialog } from '@/components/responsive-dialog';

interface RenameKeyDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The draft lives in the parent, so it survives the Dialog to Drawer swap at 768px (D-15). */
  alias: string;
  onAliasChange: (alias: string) => void;
  /** Rejects with an Error to show its message inline and keep the draft. */
  onSave: () => Promise<void>;
}

const ALIAS_ID = 'rename-key-alias';
const FORM_ID = 'rename-key-form';

/** One field, Enter submits. An empty alias is allowed and clears it. The error shows here, not in a toast. */
export function RenameKeyDialog({ open, onOpenChange, alias, onAliasChange, onSave }: RenameKeyDialogProps) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      await onSave();
      setPending(false);
      onOpenChange(false);
    } catch (err) {
      setPending(false);
      setError(err instanceof Error ? err.message : 'Something went wrong.');
    }
  };

  return (
    <ResponsiveDialog
      open={open}
      onOpenChange={(next) => {
        if (!pending) onOpenChange(next);
      }}
      title="Rename key"
      dismissible={!pending}
      footer={
        <>
          <Button type="button" variant="outline" className="flex-1 md:flex-none" onClick={() => onOpenChange(false)} disabled={pending}>
            Discard changes
          </Button>
          <Button type="submit" form={FORM_ID} className="flex-1 md:flex-none" disabled={pending}>
            {pending ? 'Saving…' : 'Save alias'}
          </Button>
        </>
      }
    >
      <form id={FORM_ID} onSubmit={(e) => void submit(e)} className="flex flex-col gap-4">
        {error ? (
          <div role="alert" className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm break-words text-destructive">
            {error}
          </div>
        ) : null}
        <Field label="Alias" htmlFor={ALIAS_ID} helper="Leave empty to clear the alias.">
          <Input
            id={ALIAS_ID}
            value={alias}
            maxLength={60}
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            onChange={(e) => onAliasChange(e.target.value)}
          />
        </Field>
      </form>
    </ResponsiveDialog>
  );
}
