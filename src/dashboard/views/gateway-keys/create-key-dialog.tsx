import { useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { CodeBlock } from '@/components/code-block';
import { CopyButton } from '@/components/copy-button';
import { Field, fieldMessageId } from '@/components/field';
import { ResponsiveDialog } from '@/components/responsive-dialog';
import { api, type RouteDTO } from '@/lib/api';
import { ClientSnippets } from './client-setup';

interface CreateKeyDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  routes: RouteDTO[];
}

const NAME_ID = 'create-key-name';
const ROUTE_ID = 'create-key-route';
const FORM_ID = 'create-key-form';

/**
 * Create, then reveal in the same dialog (D-24). The one-time key lives only in this component's state:
 * the mutation has gcTime 0 and is reset() the moment it answers, so the TanStack mutation cache never
 * holds the plaintext; it is never put in a toast, URL, storage or query key. The reveal view cannot be
 * dismissed by tap-outside, swipe or Escape, and closing it discards the key.
 */
export function CreateKeyDialog({ open, onOpenChange, routes }: CreateKeyDialogProps) {
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [routeId, setRouteId] = useState('');
  const [attempted, setAttempted] = useState(false);
  const [revealed, setRevealed] = useState<string | null>(null);
  const keyRef = useRef<HTMLElement | null>(null);

  const create = useMutation({
    gcTime: 0,
    mutationFn: (vars: { name: string; route_id: number | null }) => api.post<{ key: string }>('/gateway-keys', vars),
    onSuccess: () => {
      toast.success('Gateway key created.');
      void queryClient.invalidateQueries({ queryKey: ['gateway-keys'] });
    },
  });
  const pending = create.isPending;
  const nameError = name.trim() ? undefined : 'Enter a name.';

  const submit = () => {
    if (pending) return;
    if (nameError) {
      setAttempted(true);
      document.getElementById(NAME_ID)?.focus();
      return;
    }
    create.mutate(
      { name: name.trim(), route_id: routeId === '' ? null : Number(routeId) },
      {
        onSuccess: (res) => {
          setRevealed(res.key);
          // The key now lives in state only: drop it from the mutation cache at once.
          create.reset();
        },
      },
    );
  };

  const done = () => {
    setRevealed(null);
    onOpenChange(false);
  };

  if (revealed !== null) {
    return (
      <ResponsiveDialog
        open={open}
        // Only Done or the close icon get here; closing discards the key from memory.
        onOpenChange={(next) => {
          if (!next) done();
        }}
        title="Copy your key now"
        dismissible={false}
        footer={
          <>
            <CopyButton text={revealed} label="Copy key" className="flex-1 md:flex-none" getSelectTarget={() => keyRef.current} />
            <Button className="flex-1 md:flex-none" onClick={done}>
              Done
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-6">
          <div className="rounded-lg border border-status-ok/40 bg-status-ok/10 p-3 text-sm break-words">
            This is the only time the full key is shown. Only its hash is stored, so it cannot be shown again.
          </div>
          <CodeBlock text={revealed} wrap hideCopy codeRef={keyRef} />
          <div className="flex flex-col gap-2">
            <p className="text-xs text-muted-foreground">The Claude Code and Codex snippets below use this key.</p>
            <ClientSnippets apiKey={revealed} />
          </div>
        </div>
      </ResponsiveDialog>
    );
  }

  return (
    <ResponsiveDialog
      open={open}
      onOpenChange={(next) => {
        if (!pending) onOpenChange(next);
      }}
      title="Create gateway key"
      dismissible={!pending}
      footer={
        <>
          <Button type="button" variant="outline" className="flex-1 md:flex-none" onClick={() => onOpenChange(false)} disabled={pending}>
            Discard key
          </Button>
          <Button type="submit" form={FORM_ID} className="flex-1 md:flex-none" disabled={pending}>
            {pending ? 'Creating…' : 'Create key'}
          </Button>
        </>
      }
    >
      <form
        id={FORM_ID}
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        {create.isError ? (
          <div role="alert" className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm break-words text-destructive">
            {create.error.message}
          </div>
        ) : null}
        <Field label="Name" htmlFor={NAME_ID} error={attempted ? nameError : undefined}>
          <Input
            id={NAME_ID}
            value={name}
            maxLength={60}
            disabled={pending}
            autoComplete="off"
            placeholder="e.g. Laptop Claude Code"
            aria-invalid={attempted && nameError ? true : undefined}
            aria-describedby={attempted && nameError ? fieldMessageId(NAME_ID) : undefined}
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
        <Field label="Route" htmlFor={ROUTE_ID}>
          <NativeSelect id={ROUTE_ID} value={routeId} disabled={pending} onChange={(e) => setRouteId(e.target.value)}>
            <NativeSelectOption value="">Auto (match by model, then default)</NativeSelectOption>
            {routes.map((r) => (
              <NativeSelectOption key={r.id} value={String(r.id)}>
                {r.is_default ? `${r.name} (default)` : r.name}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </Field>
      </form>
    </ResponsiveDialog>
  );
}
