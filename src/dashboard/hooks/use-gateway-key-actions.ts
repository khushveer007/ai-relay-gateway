import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api, type GatewayKeyDTO } from '@/lib/api';
import { gatewayKeyPayload, type GatewayKeyLike } from '@/lib/gateway-snippets';

interface UpdateVars {
  key: GatewayKeyDTO;
  patch: Partial<GatewayKeyLike>;
}

// The Worker's PUT writes name, route_id and enabled together, so every update goes through
// gatewayKeyPayload, which always sends all three from the key as loaded (research Pitfall 1, D-25).
const put = ({ key, patch }: UpdateVars) => api.put(`/gateway-keys/${key.id}`, gatewayKeyPayload(key, patch));

/** Enable, Disable and other card-button updates: toasts its own success and error. */
export function useUpdateGatewayKey() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: put,
    onSuccess: (_res, { patch }) => {
      toast.success(patch.enabled === true ? 'Key enabled.' : patch.enabled === false ? 'Key disabled.' : 'Gateway key updated.');
    },
    onError: (err: Error) => {
      toast.error(err.message);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['gateway-keys'] }),
  });
}

/** The edit dialog's save: driven with `mutateAsync`, the dialog shows the error inline, so no error toast. */
export function useSaveGatewayKey() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: put,
    onSuccess: () => {
      toast.success('Gateway key updated.');
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['gateway-keys'] }),
  });
}

/** Delete a gateway key. No error toast (the confirm dialog shows it); the caller toasts the success with the name. */
export function useDeleteGatewayKey() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api.del(`/gateway-keys/${id}`),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['gateway-keys'] }),
  });
}
