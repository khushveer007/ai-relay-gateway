import { Button } from '@/components/ui/button';
import { ResponsiveDialog } from '@/components/responsive-dialog';
import type { ProviderDTO } from '@/lib/api';
import { fmtAgo } from '@/lib/format';

interface ModelsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  provider: ProviderDTO;
}

const CHIP = 'rounded-md bg-muted px-2 py-1 font-mono text-xs break-all';

/** The fetched model list and the model map. The list scrolls inside the dialog body, never the page behind. */
export function ModelsDialog({ open, onOpenChange, provider }: ModelsDialogProps) {
  const mapEntries = Object.entries(provider.model_map);
  const count = provider.models.length;

  return (
    <ResponsiveDialog
      open={open}
      onOpenChange={onOpenChange}
      title={`${provider.name} models (${count})`}
      footer={
        <Button variant="outline" className="flex-1 md:flex-none" onClick={() => onOpenChange(false)}>
          Close models
        </Button>
      }
    >
      <div className="flex flex-col gap-6">
        {mapEntries.length > 0 ? (
          <section className="flex flex-col gap-2">
            <h3 className="text-xs font-semibold">Model map ({mapEntries.length})</h3>
            <div className="flex flex-wrap gap-2">
              {mapEntries.map(([pattern, upstream]) => (
                <span key={pattern} className={CHIP}>
                  {pattern} → {upstream}
                </span>
              ))}
            </div>
          </section>
        ) : null}
        {count === 0 ? (
          <p className="text-sm text-muted-foreground">No models fetched yet. Use Fetch models in the provider menu.</p>
        ) : (
          <section className="flex flex-col gap-2">
            <h3 className="text-xs font-semibold">
              Fetched from /v1/models{provider.models_fetched_at ? ` ${fmtAgo(provider.models_fetched_at)}` : ''}
            </h3>
            <div className="flex flex-wrap gap-2">
              {provider.models.map((m) => (
                <span key={m} className={CHIP}>
                  {m}
                </span>
              ))}
            </div>
          </section>
        )}
      </div>
    </ResponsiveDialog>
  );
}
