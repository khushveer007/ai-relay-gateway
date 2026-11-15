import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api, type Action } from '@/lib/api';

/**
 * Save the three settings. Driven with `mutateAsync` from the form, which shows range and server errors
 * inline, so there is no error toast.
 */
export function useSaveSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: Record<string, number>) => api.put('/settings', payload),
    onSuccess: () => {
      toast.success('Settings saved.');
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['settings'] }),
  });
}

export interface RuleTestResult {
  action: Action | 'OK';
  ruleId: number | null;
  cooldownS: number | null;
  reason: string;
}

/** Dry-run the classifier (POST /rules/test). Nothing is saved, so nothing is invalidated. */
export function useRuleTest() {
  return useMutation({
    mutationFn: (payload: Record<string, unknown>) => api.post<RuleTestResult>('/rules/test', payload),
  });
}
