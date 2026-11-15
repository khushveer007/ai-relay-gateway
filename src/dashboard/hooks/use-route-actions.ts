import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api } from '@/lib/api';

/**
 * Create (no id) or update a route. Driven with `mutateAsync` from the route dialog, which shows the
 * error inline, so there is no error toast. Provider cards list their route names, so providers refetch too.
 */
export function useSaveRoute(routeId?: number) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: Record<string, unknown>) => (routeId === undefined ? api.post('/routes', payload) : api.put(`/routes/${routeId}`, payload)),
    onSuccess: () => {
      toast.success(routeId === undefined ? 'Route created.' : 'Route updated.');
    },
    onSettled: () =>
      Promise.all([queryClient.invalidateQueries({ queryKey: ['routes'] }), queryClient.invalidateQueries({ queryKey: ['providers'] })]),
  });
}

/**
 * Delete a route. The Worker unpins gateway keys that pointed at it, so gateway keys refetch too. No
 * error toast (the confirm dialog shows it); the caller toasts the success with the route name.
 */
export function useDeleteRoute(routeId: number) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.del(`/routes/${routeId}`),
    onSettled: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: ['routes'] }),
        queryClient.invalidateQueries({ queryKey: ['providers'] }),
        queryClient.invalidateQueries({ queryKey: ['gateway-keys'] }),
      ]),
  });
}
