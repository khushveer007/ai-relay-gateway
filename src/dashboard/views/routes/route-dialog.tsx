import { useState } from 'react';
import { ArrowDown, ArrowUp } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { FormError } from '@/components/form-error';
import { Input } from '@/components/ui/input';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Textarea } from '@/components/ui/textarea';
import { Field, fieldMessageId } from '@/components/field';
import { ResponsiveDialog } from '@/components/responsive-dialog';
import { useSaveRoute } from '@/hooks/use-route-actions';
import type { ProviderDTO, RouteDTO } from '@/lib/api';
import {
  addToChain,
  availableProviders,
  buildRoutePayload,
  emptyRouteForm,
  moveChainItem,
  removeFromChain,
  routeToForm,
  validateRouteForm,
  type RouteForm,
} from '@/lib/route-form';

interface RouteDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: 'create' | 'edit';
  route?: RouteDTO;
  providers: ProviderDTO[];
}

const NAME_ID = 'route-name';
const POSITION_ID = 'route-position';
const PATTERNS_ID = 'route-patterns';
const ADD_ID = 'route-chain-add';

/**
 * The owner holds the whole form (D-15): the children below are controlled and keep no state, so every
 * value survives the Dialog to Drawer swap. The chain is edited with Move up, Move down and Remove
 * (D-09, no drag) and saved as a whole.
 */
export function RouteDialog({ open, onOpenChange, mode, route, providers }: RouteDialogProps) {
  const editing = mode === 'edit' && route !== undefined;
  const isDefault = editing && route.is_default;
  const [form, setForm] = useState<RouteForm>(() => (editing ? routeToForm(route) : emptyRouteForm(providers)));
  const [attempted, setAttempted] = useState(false);
  const save = useSaveRoute(editing ? route.id : undefined);

  const errors = validateRouteForm(form);
  const shown = attempted ? errors : {};
  const pending = save.isPending;
  const set = (changes: Partial<RouteForm>) => setForm((f) => ({ ...f, ...changes }));
  const byId = (id: number) => providers.find((p) => p.id === id);
  const remaining = availableProviders(providers, form.provider_ids);

  const submit = () => {
    if (pending) return;
    if (errors.name || errors.position) {
      setAttempted(true);
      document.getElementById(errors.name ? NAME_ID : POSITION_ID)?.focus();
      return;
    }
    save
      .mutateAsync(buildRoutePayload(form, route))
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
      title={editing ? `Edit route: ${route.name}` : 'New route'}
      dismissible={!pending}
      footer={
        <>
          <Button variant="outline" className="flex-1 md:flex-none" onClick={() => onOpenChange(false)} disabled={pending}>
            {editing ? 'Discard changes' : 'Discard route'}
          </Button>
          <Button className="flex-1 md:flex-none" onClick={submit} disabled={pending}>
            {pending ? (editing ? 'Saving…' : 'Creating…') : editing ? 'Save route' : 'Create route'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <FormError message={save.isError ? save.error.message : null} />

        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Route name" htmlFor={NAME_ID} error={shown.name}>
            <Input
              id={NAME_ID}
              value={form.name}
              readOnly={isDefault}
              autoComplete="off"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              aria-invalid={shown.name ? true : undefined}
              aria-describedby={shown.name ? fieldMessageId(NAME_ID) : undefined}
              onChange={(e) => set({ name: e.target.value })}
            />
          </Field>
          <Field label="Position" htmlFor={POSITION_ID} helper="Lower numbers match first. Default: 10" error={shown.position}>
            <Input
              id={POSITION_ID}
              type="number"
              inputMode="numeric"
              min={0}
              max={100000}
              value={form.position}
              aria-invalid={shown.position ? true : undefined}
              aria-describedby={fieldMessageId(POSITION_ID)}
              onChange={(e) => set({ position: e.target.value })}
            />
          </Field>
        </div>

        <Field
          label="Model patterns"
          htmlFor={PATTERNS_ID}
          helper={
            isDefault
              ? 'The default route matches everything.'
              : 'Comma or new line separated. Case-insensitive, * and ? work. Leave empty if only a gateway key uses this route.'
          }
        >
          <Textarea
            id={PATTERNS_ID}
            rows={2}
            data-vaul-no-drag
            className="font-mono break-all"
            disabled={isDefault}
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            placeholder="claude-*, gpt-*"
            value={form.patterns}
            aria-describedby={fieldMessageId(PATTERNS_ID)}
            onChange={(e) => set({ patterns: e.target.value })}
          />
        </Field>

        <section className="flex flex-col gap-2" aria-labelledby="route-chain-label">
          <div className="flex flex-col gap-1">
            <h3 id="route-chain-label" className="text-xs font-semibold">
              Provider chain
            </h3>
            <p className="text-xs text-muted-foreground">Tried in order, #1 first.</p>
          </div>

          {form.provider_ids.length > 0 ? (
            <ol className="flex flex-col gap-2">
              {form.provider_ids.map((id, i) => {
                const provider = byId(id);
                const name = provider ? provider.name : `Provider #${id}`;
                return (
                  <li key={id} className="flex min-h-11 flex-wrap items-center gap-2 rounded-lg border border-border-subtle p-2">
                    <span className="font-mono text-xs text-muted-foreground">#{i + 1}</span>
                    <span className="flex min-w-0 flex-1 basis-32 flex-col">
                      <span className="text-sm font-semibold break-words">{name}</span>
                      {provider ? <span className="text-xs break-words text-muted-foreground">{provider.formats.join(', ')}</span> : null}
                    </span>
                    <span className="flex items-center gap-1">
                      {/* Icon buttons read "Move {name} up" and "Move {name} down" to a screen reader. */}
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        aria-label={`Move ${name} up`}
                        disabled={i === 0}
                        onClick={() => set({ provider_ids: moveChainItem(form.provider_ids, i, -1) })}
                      >
                        <ArrowUp aria-hidden="true" />
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        aria-label={`Move ${name} down`}
                        disabled={i === form.provider_ids.length - 1}
                        onClick={() => set({ provider_ids: moveChainItem(form.provider_ids, i, 1) })}
                      >
                        <ArrowDown aria-hidden="true" />
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="h-11 text-destructive md:h-8"
                        aria-label={`Remove ${name}`}
                        onClick={() => set({ provider_ids: removeFromChain(form.provider_ids, id) })}
                      >
                        Remove
                      </Button>
                    </span>
                  </li>
                );
              })}
            </ol>
          ) : (
            <p className="text-sm text-muted-foreground">No providers in this chain.</p>
          )}

          {providers.length === 0 ? (
            <p className="text-sm text-muted-foreground">No providers yet. Add one on the Providers page.</p>
          ) : remaining.length > 0 ? (
            <NativeSelect
              id={ADD_ID}
              aria-label="Add a provider"
              value=""
              onChange={(e) => {
                const id = Number(e.target.value);
                if (id) set({ provider_ids: addToChain(form.provider_ids, id) });
              }}
            >
              <NativeSelectOption value="">Add a provider…</NativeSelectOption>
              {remaining.map((p) => (
                <NativeSelectOption key={p.id} value={p.id}>
                  {p.name}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          ) : null}
        </section>
      </div>
    </ResponsiveDialog>
  );
}
