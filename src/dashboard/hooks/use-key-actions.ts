import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api, type KeyStatus } from '@/lib/api';
import { keyTestToast, type KeyTestResultLike } from '@/lib/overview';

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

interface TestKeyResult extends KeyTestResultLike {
  /** The status the key had before the test. A dropped or disabled key is only reported on, never changed. */
  key_status: KeyStatus;
  cls?: { reason: string };
}

/**
 * Test a key (POST /keys/:id/test). The Worker reports on a dropped or disabled key without writing to it
 * (DROP-10). For any other key it keeps the old behaviour, so a passing test can bring back a paused or
 * out-of-balance key. The toast copy comes from `keyTestToast`, which never says a dropped key is back.
 */
export function useTestKey() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (keyId: number) => api.post<TestKeyResult>(`/keys/${keyId}/test`),
    onSuccess: (res) => {
      const { kind, text } = keyTestToast(res);
      if (kind === 'success') toast.success(text);
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

/** Disable a key (PUT /keys/:id { status: 'disabled' }). */
export function useDisableKey() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (keyId: number) => api.put(`/keys/${keyId}`, { status: 'disabled' }),
    onSuccess: () => {
      toast.success('Key disabled.');
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

interface RecheckResult {
  result: string;
  detail: string;
}

/** Recheck an exhausted key now (POST /keys/:id/recheck). */
export function useRecheckKey() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (keyId: number) => api.post<RecheckResult>(`/keys/${keyId}/recheck`),
    onSuccess: (res) => {
      toast.success(`${res.result}: ${res.detail}`);
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

/**
 * Save a new key order for one provider (the provider reorder endpoint, body { ids }). `ids` is the whole
 * key list in the new order. `onSuccess` returns the refetch promise, so the mutation stays pending
 * until the list shows the new order and a second tap cannot send an order built from a stale list.
 */
export function useReorderKeys(providerId: number) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (ids: number[]) => api.post(`/providers/${providerId}/keys/reorder`, { ids }),
    onSuccess: () => {
      toast.success('Key order saved.');
      return queryClient.invalidateQueries({ queryKey: ['providers'] });
    },
    onError: (err: Error) => {
      toast.error(err.message);
      // The order on screen may now differ from the server's, so reload it.
      void queryClient.invalidateQueries({ queryKey: ['providers'] });
    },
  });
}

/**
 * Rename a key (PUT /keys/:id { alias }). No error toast: the rename dialog drives this with
 * `mutateAsync` and shows the error inline.
 */
export function useRenameKey() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, alias }: { id: number; alias: string }) => api.put(`/keys/${id}`, { alias }),
    onSuccess: () => {
      toast.success('Key renamed.');
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ['providers'] });
      void queryClient.invalidateQueries({ queryKey: ['stats'] });
    },
  });
}

/** Delete a key (DELETE /keys/:id). No error toast: the confirm dialog shows the error inline. */
export function useDeleteKey() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id }: { id: number; label: string }) => api.del(`/keys/${id}`),
    onSuccess: (_res, { label }) => {
      toast.success(`Deleted ${label}.`);
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ['providers'] });
      void queryClient.invalidateQueries({ queryKey: ['stats'] });
    },
  });
}
