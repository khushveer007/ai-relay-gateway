import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api } from '@/lib/api';

/**
 * Enable a non-active key (PUT /keys/:id { status: 'active' }). Invalidates `['providers']` and
 * `['stats']` on settle so Overview reloads through its own skeletons (D-08) rather than this
 * hook patching cached data by hand.
 */
export function useEnableKey() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (keyId: number) => api.put(`/keys/${keyId}`, { status: 'active' }),
    onSuccess: () => {
      toast.success('Key re-enabled.');
    },
    onError: (err: Error) => {
      toast.error(err.message);
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ['providers'] });
      void queryClient.invalidateQueries({ queryKey: ['stats'] });
    },
  });
}

interface TestKeyResult {
  ok: boolean;
  message: string;
  ms: number;
}

/**
 * Test a key (POST /keys/:id/test). The endpoint re-activates a non-active key on success today
 * (Phase 3 changes this under DROP-10), so the toast never claims the key's status is unchanged.
 */
export function useTestKey() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (keyId: number) => api.post<TestKeyResult>(`/keys/${keyId}/test`),
    onSuccess: (res) => {
      const text = `${res.message} (${res.ms} ms)`;
      if (res.ok) toast.success(text);
      else toast.error(text);
    },
    onError: (err: Error) => {
      toast.error(err.message);
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ['providers'] });
      void queryClient.invalidateQueries({ queryKey: ['stats'] });
    },
  });
}
