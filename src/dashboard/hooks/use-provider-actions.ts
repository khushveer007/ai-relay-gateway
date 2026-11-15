import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api } from '@/lib/api';

/**
 * Save an edited provider (PUT /providers/:id). The caller builds the full payload and drives this with
 * `mutateAsync` from the dialog, which shows the error inline, so there is no error toast here.
 */
export function useUpdateProvider(providerId: number) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: Record<string, unknown>) => api.put(`/providers/${providerId}`, payload),
    onSuccess: () => {
      toast.success('Provider updated.');
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['providers'] }),
  });
}

interface AddKeysResult {
  added: number;
  duplicates: number;
  models: string[] | null;
}

/**
 * Add keys in bulk (POST /providers/:id/keys). The toast carries counts only: a pasted key is never
 * toasted, logged or placed in a URL. The dialog shows the error inline.
 */
export function useAddKeys(providerId: number) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (vars: { keys: string; alias_prefix: string }) =>
      api.post<AddKeysResult>(`/providers/${providerId}/keys`, { keys: vars.keys, alias_prefix: vars.alias_prefix.trim() }),
    onSuccess: (res) => {
      toast.success(`Added ${res.added} key(s), ${res.duplicates} duplicate(s) skipped.`);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['providers'] }),
  });
}

/** Fetch the model list from the relay (POST /providers/:id/fetch-models). */
export function useFetchModels(providerId: number) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<{ models: string[] }>(`/providers/${providerId}/fetch-models`),
    onSuccess: (res) => {
      toast.success(`Fetched ${res.models.length} models.`);
    },
    onError: (err: Error) => {
      toast.error(err.message);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['providers'] }),
  });
}

interface BalanceResult {
  key_id: number;
  balance: number | null;
}

/** Check every key balance of the provider now. */
export function useCheckBalances(providerId: number) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<{ results: BalanceResult[] }>(`/providers/${providerId}/check-balances`),
    onSuccess: (res) => {
      const withBalance = res.results.filter((r) => r.balance !== null && r.balance !== undefined).length;
      toast.success(`Checked ${res.results.length} key(s), ${withBalance} returned a balance.`);
    },
    onError: (err: Error) => {
      toast.error(err.message);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['providers'] }),
  });
}

/**
 * Delete a provider (DELETE /providers/:id). The Worker also deletes its keys, its error rules and its
 * route entries, so routes, rules and stats refetch too. No error toast: the confirm dialog shows it.
 */
export function useDeleteProvider(providerId: number) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (_name: string) => api.del(`/providers/${providerId}`),
    onSuccess: (_res, name) => {
      toast.success(`Deleted ${name}.`);
    },
    onSettled: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: ['providers'] }),
        queryClient.invalidateQueries({ queryKey: ['routes'] }),
        queryClient.invalidateQueries({ queryKey: ['rules'] }),
        queryClient.invalidateQueries({ queryKey: ['stats'] }),
      ]),
  });
}
