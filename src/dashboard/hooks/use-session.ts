import { useEffect } from 'react';
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api, ApiError, setUnauthorizedHandler } from '@/lib/api';
import { sessionQuery } from '@/lib/queries';

export interface SessionInfo {
  state: 'checking' | 'signed-in' | 'signed-out';
  /** True when the boot probe failed on the network (not a 401). */
  probeFailed: boolean;
}

export function useSession(): SessionInfo {
  const query = useQuery(sessionQuery);
  const probeFailed = query.isError;
  if (query.isPending) return { state: 'checking', probeFailed: false };
  if (query.data === true) return { state: 'signed-in', probeFailed: false };
  return { state: 'signed-out', probeFailed };
}

/**
 * Marks the session signed out and drops every other cached query, so no stats or provider data
 * stays in memory for the next person using the device (T-01-07).
 */
export function endSession(queryClient: QueryClient): void {
  queryClient.setQueryData(['session'], false);
  queryClient.removeQueries({ predicate: (q) => q.queryKey[0] !== 'session' });
}

/**
 * Wires the 401 handler from lib/api. A 401 while signed in ends the session and toasts once;
 * a 401 when already signed out (or the boot probe) does nothing.
 */
export function useUnauthorizedHandler(): void {
  const queryClient = useQueryClient();
  useEffect(() => {
    setUnauthorizedHandler(() => {
      if (queryClient.getQueryData<boolean>(['session']) !== true) return;
      endSession(queryClient);
      toast.error('Session expired — please sign in again.');
    });
  }, [queryClient]);
}

/**
 * Sign Out. The session ends only after the server confirms the cookie is cleared, or answers 401
 * (already signed out; the unauthorized handler has then ended the session and toasted). Any other
 * failure leaves the operator signed in and says so, so the UI never looks signed out while the
 * cookie is still valid (T-01-12). `api.post` adds the JSON content-type the CSRF guard needs.
 */
export function useSignOut() {
  const queryClient = useQueryClient();
  return useMutation({
    retry: false,
    mutationFn: () => api.post('/logout'),
    onSuccess: () => endSession(queryClient),
    onError: (err) => {
      if (err instanceof ApiError && err.status === 401) return;
      toast.error('Could not sign out. Check your connection and try again.');
    },
  });
}
