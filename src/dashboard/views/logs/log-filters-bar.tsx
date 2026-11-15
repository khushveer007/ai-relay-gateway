import { useEffect, useState } from 'react';
import { SlidersHorizontal } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Field } from '@/components/field';
import { ResponsiveDialog } from '@/components/responsive-dialog';
import { useLogFilters } from '@/hooks/use-logs';
import { useIsDesktop } from '@/hooks/use-media-query';
import type { GatewayKeyDTO, ProviderDTO } from '@/lib/api';
import { activeFilterCount, clearLogFilters, setLogFilters, type LogFilters } from '@/lib/logs-filters';

interface LogFiltersBarProps {
  providers: ProviderDTO[];
  gatewayKeys: GatewayKeyDTO[];
}

const STATUS_OPTIONS: Array<{ value: string; label: string }> = [
  { value: '', label: 'All requests' },
  { value: 'ok', label: 'Succeeded (2xx)' },
  { value: 'failover', label: 'Had failovers' },
  { value: 'error', label: 'Failed' },
];

const MODEL_PLACEHOLDER = 'e.g. claude-3-7 or gpt-4';

interface FieldsProps {
  idPrefix: string;
  filters: LogFilters;
  providers: ProviderDTO[];
  gatewayKeys: GatewayKeyDTO[];
  onChange: (changes: Partial<LogFilters>) => void;
  /** Desktop applies the model text on Enter or blur; the drawer applies everything on Apply. */
  onModelCommit?: () => void;
}

// The selects show only their 'All …' option until the already-loaded data arrives.
function FilterFields({ idPrefix, filters, providers, gatewayKeys, onChange, onModelCommit }: FieldsProps) {
  return (
    <>
      <Field label="Provider" htmlFor={`${idPrefix}-provider`}>
        <NativeSelect id={`${idPrefix}-provider`} value={filters.provider_id} onChange={(e) => onChange({ provider_id: e.target.value })}>
          <NativeSelectOption value="">All providers</NativeSelectOption>
          {providers.map((p) => (
            <NativeSelectOption key={p.id} value={String(p.id)}>
              {p.name}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </Field>
      <Field label="Gateway key" htmlFor={`${idPrefix}-gateway-key`}>
        <NativeSelect
          id={`${idPrefix}-gateway-key`}
          value={filters.gateway_key_id}
          onChange={(e) => onChange({ gateway_key_id: e.target.value })}
        >
          <NativeSelectOption value="">All gateway keys</NativeSelectOption>
          {gatewayKeys.map((k) => (
            <NativeSelectOption key={k.id} value={String(k.id)}>
              {k.name}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </Field>
      <Field label="Status" htmlFor={`${idPrefix}-status`}>
        <NativeSelect id={`${idPrefix}-status`} value={filters.status} onChange={(e) => onChange({ status: e.target.value })}>
          {STATUS_OPTIONS.map((o) => (
            <NativeSelectOption key={o.value} value={o.value}>
              {o.label}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </Field>
      <Field label="Model" htmlFor={`${idPrefix}-model`}>
        <Input
          id={`${idPrefix}-model`}
          type="search"
          value={filters.model}
          placeholder={MODEL_PLACEHOLDER}
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          onChange={(e) => onChange({ model: e.target.value })}
          onBlur={onModelCommit}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && onModelCommit) {
              e.preventDefault();
              onModelCommit();
            }
          }}
        />
      </Field>
    </>
  );
}

/**
 * Filters read and write the in-memory store (D-21). Desktop: an inline row, selects apply on change
 * and the model text on Enter or blur. Phones: a Filters button with an active-count badge opens a
 * drawer whose draft lives here (D-15) and is written to the store when the operator applies it.
 */
export function LogFiltersBar({ providers, gatewayKeys }: LogFiltersBarProps) {
  const isDesktop = useIsDesktop();
  const filters = useLogFilters();
  const count = activeFilterCount(filters);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<LogFilters>(filters);

  // Desktop model text: typed locally, applied on Enter or blur; follows the store when it changes (Clear).
  const [modelText, setModelText] = useState(filters.model);
  useEffect(() => setModelText(filters.model), [filters.model]);

  if (isDesktop) {
    const commitModel = () => {
      if (modelText !== filters.model) setLogFilters({ ...filters, model: modelText });
    };
    return (
      <div className="grid grid-cols-[repeat(4,minmax(0,1fr))_auto] items-end gap-3">
        <FilterFields
          idPrefix="lf"
          filters={{ ...filters, model: modelText }}
          providers={providers}
          gatewayKeys={gatewayKeys}
          onChange={(changes) => {
            if ('model' in changes) setModelText(changes.model ?? '');
            else setLogFilters({ ...filters, ...changes });
          }}
          onModelCommit={commitModel}
        />
        {count > 0 ? (
          <Button variant="ghost" className="h-9" onClick={clearLogFilters}>
            Clear
          </Button>
        ) : (
          <span aria-hidden="true" />
        )}
      </div>
    );
  }

  const openDrawer = () => {
    setDraft(filters);
    setOpen(true);
  };

  return (
    <>
      <div>
        <Button variant="outline" className="h-11" onClick={openDrawer}>
          <SlidersHorizontal aria-hidden="true" />
          Filters
          {count > 0 ? (
            <Badge className="ml-1" aria-label={`${count} active`}>
              {count}
            </Badge>
          ) : null}
        </Button>
      </div>
      {open ? (
        <ResponsiveDialog
          open
          onOpenChange={setOpen}
          title="Filters"
          footer={
            <>
              <Button
                variant="outline"
                className="h-11 flex-1"
                onClick={() => {
                  clearLogFilters();
                  setOpen(false);
                }}
              >
                Clear filters
              </Button>
              <Button
                className="h-11 flex-1"
                onClick={() => {
                  setLogFilters(draft);
                  setOpen(false);
                }}
              >
                Apply filters
              </Button>
            </>
          }
        >
          <div className="flex flex-col gap-4">
            <FilterFields
              idPrefix="lfd"
              filters={draft}
              providers={providers}
              gatewayKeys={gatewayKeys}
              onChange={(changes) => setDraft((d) => ({ ...d, ...changes }))}
            />
          </div>
        </ResponsiveDialog>
      ) : null}
    </>
  );
}
