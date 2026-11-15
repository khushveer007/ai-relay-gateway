import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api } from '@/lib/api';

/**
 * Create (no id) or update an error rule. Driven with `mutateAsync` from the rule dialog, which shows
 * the Worker's message inline (an invalid regex or status format), so there is no error toast.
 */
export function useSaveRule(ruleId?: number) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: Record<string, unknown>) => (ruleId === undefined ? api.post('/rules', payload) : api.put(`/rules/${ruleId}`, payload)),
    onSuccess: () => {
      toast.success(ruleId === undefined ? 'Error rule created.' : 'Error rule updated.');
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['rules'] }),
  });
}

/** Delete an error rule. No error toast (the confirm dialog shows it); the caller toasts 'Rule deleted.'. */
export function useDeleteRule(ruleId: number) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.del(`/rules/${ruleId}`),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['rules'] }),
  });
}
