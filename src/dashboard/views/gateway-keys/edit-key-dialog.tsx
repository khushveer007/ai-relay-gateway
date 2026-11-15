import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { FormError } from '@/components/form-error';
import { Input } from '@/components/ui/input';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Field, fieldMessageId } from '@/components/field';
import { ResponsiveDialog } from '@/components/responsive-dialog';
import { useSaveGatewayKey } from '@/hooks/use-gateway-key-actions';
import type { GatewayKeyDTO, RouteDTO } from '@/lib/api';

interface EditKeyDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  gatewayKey: GatewayKeyDTO;
  routes: RouteDTO[];
}

const NAME_ID = 'gateway-key-name';
const ROUTE_ID = 'gateway-key-route';

/** Edit name and pinned route. The draft is held here (D-15); saving goes through gatewayKeyPayload so `enabled` is preserved. */
export function EditKeyDialog({ open, onOpenChange, gatewayKey, routes }: EditKeyDialogProps) {
  const [name, setName] = useState(gatewayKey.name);
  const [routeId, setRouteId] = useState(gatewayKey.route_id === null ? '' : String(gatewayKey.route_id));
  const [attempted, setAttempted] = useState(false);
  const save = useSaveGatewayKey();
  const pending = save.isPending;
  const nameError = name.trim() ? undefined : 'Enter a name.';

  const submit = () => {
    if (pending) return;
    if (nameError) {
      setAttempted(true);
      document.getElementById(NAME_ID)?.focus();
      return;
    }
    save
      .mutateAsync({ key: gatewayKey, patch: { name: name.trim(), route_id: routeId === '' ? null : Number(routeId) } })
      .then(() => onOpenChange(false))
      .catch(() => {
        /* the server message shows in the banner through save.error */
      });
  };

  return (
    <ResponsiveDialog
      open={open}
      onOpenChange={(next) => {
        if (!pending) onOpenChange(next);
      }}
      title="Edit gateway key"
      dismissible={!pending}
      footer={
        <>
          <Button variant="outline" className="flex-1 md:flex-none" onClick={() => onOpenChange(false)} disabled={pending}>
            Discard changes
          </Button>
          <Button className="flex-1 md:flex-none" onClick={submit} disabled={pending}>
            {pending ? 'Saving…' : 'Save changes'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <FormError message={save.isError ? save.error.message : null} />
        <Field label="Name" htmlFor={NAME_ID} error={attempted ? nameError : undefined}>
          <Input
            id={NAME_ID}
            value={name}
            maxLength={60}
            autoComplete="off"
            aria-invalid={attempted && nameError ? true : undefined}
            aria-describedby={attempted && nameError ? fieldMessageId(NAME_ID) : undefined}
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
        <Field label="Route" htmlFor={ROUTE_ID}>
          <NativeSelect id={ROUTE_ID} value={routeId} onChange={(e) => setRouteId(e.target.value)}>
            <NativeSelectOption value="">Auto (match by model, then default)</NativeSelectOption>
            {routes.map((r) => (
              <NativeSelectOption key={r.id} value={String(r.id)}>
                {r.is_default ? `${r.name} (default)` : r.name}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </Field>
      </div>
    </ResponsiveDialog>
  );
}
