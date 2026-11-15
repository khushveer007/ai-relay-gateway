import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { providersQuery } from '@/lib/queries';
import { ProviderFormDialog } from './providers/provider-form-dialog';

// First Providers page (the tracer): list of names and the Add provider path. Cards and the
// page states come in plan 02-02.
export default function ProvidersView() {
  const providersQ = useQuery(providersQuery);
  const [adding, setAdding] = useState(false);
  const providers = providersQ.data?.providers ?? [];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <h1 className="text-xl font-semibold">Providers &amp; Keys</h1>
        <Button onClick={() => setAdding(true)}>Add provider</Button>
      </div>
      <ul className="space-y-1">
        {providers.map((p) => (
          <li key={p.id} className="text-sm">
            {p.name}
          </li>
        ))}
      </ul>
      {/* Mounted only while open, so the form resets every time the dialog opens. */}
      {adding ? <ProviderFormDialog open onOpenChange={setAdding} /> : null}
    </div>
  );
}
