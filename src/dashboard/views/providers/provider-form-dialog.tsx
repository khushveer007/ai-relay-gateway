import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ResponsiveDialog } from '@/components/responsive-dialog';
import { api } from '@/lib/api';
import { buildProviderPayload, emptyProviderForm, type ProviderForm } from '@/lib/provider-form';

type TestResponse = { ok: boolean; count?: number; status?: number; message?: string; ms: number };

interface ProviderFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

// The owner holds the form so values survive the Dialog to Drawer swap at 768px (D-15).
export function ProviderFormDialog({ open, onOpenChange }: ProviderFormDialogProps) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState<ProviderForm>(emptyProviderForm);
  const set = <K extends keyof ProviderForm>(key: K, value: ProviderForm[K]) => setForm((f) => ({ ...f, [key]: value }));

  const test = useMutation({
    mutationFn: () => api.post<TestResponse>('/providers/test-connection', { base_url: form.base_url, keys: form.keys }),
  });
  const create = useMutation({
    mutationFn: () => api.post<{ id: number }>('/providers', buildProviderPayload(form, 'create')),
    onSuccess: () => {
      toast.success('Provider created.');
      onOpenChange(false);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['providers'] }),
  });

  return (
    <ResponsiveDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Add provider"
      footer={
        <Button onClick={() => create.mutate()} disabled={create.isPending}>
          {create.isPending ? 'Creating…' : 'Create provider'}
        </Button>
      }
    >
      <div className="flex flex-col gap-4">
        {create.isError ? <div role="alert">{create.error.message}</div> : null}
        <Input aria-label="Name" placeholder="e.g. Relay A" value={form.name} onChange={(e) => set('name', e.target.value)} />
        <Input
          aria-label="Base URL"
          type="url"
          inputMode="url"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          placeholder="https://api.anthropic.com"
          value={form.base_url}
          onChange={(e) => set('base_url', e.target.value)}
        />
        <textarea
          aria-label="API keys"
          className="min-h-24 w-full rounded-lg border border-input bg-transparent p-2.5 text-base"
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          placeholder="sk-…"
          value={form.keys}
          onChange={(e) => set('keys', e.target.value)}
        />
        <Button variant="outline" onClick={() => test.mutate()} disabled={test.isPending || !form.base_url.trim() || !form.keys.trim()}>
          {test.isPending ? 'Testing…' : 'Test connection'}
        </Button>
        <div aria-live="polite">
          {test.data ? (test.data.ok ? `Connected, ${test.data.count} models found.` : `HTTP ${test.data.status}: ${test.data.message}. You can still save.`) : null}
        </div>
      </div>
    </ResponsiveDialog>
  );
}
