import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
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

// In-memory store for the one-time key so a hash change mid-request or mid-reveal cannot discard it.
// Never written to web storage, URLs or the TanStack cache; cleared only when the user closes the reveal view.
let revealedKey: string | null = null;
const revealedListeners = new Set<() => void>();

function setRevealedKey(next: string | null) {
  revealedKey = next;
  for (const fn of revealedListeners) fn();
}

export function useRevealedGatewayKey(): string | null {
  return useSyncExternalStore(
    (onStoreChange) => {
      revealedListeners.add(onStoreChange);
      return () => revealedListeners.delete(onStoreChange);
    },
    () => revealedKey,
  );
}

/**
 * Create, then reveal in the same dialog (D-24). The one-time key lives only in this module's memory:
 * the mutation has gcTime 0 and is reset() the moment it answers, so the TanStack mutation cache never
 * holds the plaintext; it is never put in a toast, URL, storage or query key. Android Back is guarded
 * via a history state entry so Back cannot unmount the dialog while a key is revealed or in flight.
 */
export function CreateKeyDialog({ open, onOpenChange, routes }: CreateKeyDialogProps) {
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [routeId, setRouteId] = useState('');
  const [attempted, setAttempted] = useState(false);
  const revealed = useRevealedGatewayKey();
  const keyRef = useRef<HTMLElement | null>(null);
  const closingFromUi = useRef(false);

  const create = useMutation({
    gcTime: 0,
    mutationFn: async (vars: { name: string; route_id: number | null }) => {
      const res = await api.post<{ key: string }>('/gateway-keys', vars);
      // Set in the store before React observers run so an unmount mid-flight still keeps the reveal.
      setRevealedKey(res.key);
      return res;
    },
    onSuccess: () => {
      toast.success('Gateway key created.');
      void queryClient.invalidateQueries({ queryKey: ['gateway-keys'] });
    },
  });
  const pending = create.isPending;
  const nameError = name.trim() ? undefined : 'Enter a name.';

  const stateRef = useRef({ revealed: false, pending: false });
  stateRef.current = { revealed: revealed !== null, pending };

  useEffect(() => {
    if (!(window.history.state as { gwDialog?: boolean } | null)?.gwDialog) {
      window.history.pushState({ gwDialog: true }, '');
    }
    const onPop = () => {
      if (closingFromUi.current) {
        closingFromUi.current = false;
        return;
      }
      if (stateRef.current.revealed) {
        window.history.pushState({ gwDialog: true }, '');
        toast.info('Copy the key, then tap Done. It cannot be shown again.', { id: 'gateway-key-back' });
        return;
      }
      if (stateRef.current.pending) {
        window.history.pushState({ gwDialog: true }, '');
        return;
      }
      onOpenChange(false);
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [onOpenChange]);

  const closeFromUi = () => {
    if ((window.history.state as { gwDialog?: boolean } | null)?.gwDialog) {
      closingFromUi.current = true;
      window.history.back();
    }
    onOpenChange(false);
  };

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
        onSuccess: () => {
          // The key now lives in the module store only: drop it from the mutation cache at once.
          create.reset();
        },
      },
    );
  };

  const done = () => {
    setRevealedKey(null);
    closeFromUi();
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
        if (!pending) {
          if (next) onOpenChange(true);
          else closeFromUi();
        }
      }}
      title="Create gateway key"
      dismissible={!pending}
      footer={
        <>
          <Button type="button" variant="outline" className="flex-1 md:flex-none" onClick={closeFromUi} disabled={pending}>
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
