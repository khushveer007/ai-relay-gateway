import { useEffect, useRef } from 'react';
import { toast } from 'sonner';

/**
 * One toast per NEW query failure, never replayed. The last seen `errorUpdatedAt` is seeded from the
 * query's current value, so a remount after an old, already recovered error stays silent. The shared
 * toast `id` makes two queries that fail together show a single toast (WR-02, D-34).
 */
export function useLoadErrorToast(query: { isError: boolean; errorUpdatedAt: number }, id: string, message: string): void {
  const lastSeen = useRef(query.errorUpdatedAt);
  useEffect(() => {
    if (query.isError && query.errorUpdatedAt !== lastSeen.current) {
      lastSeen.current = query.errorUpdatedAt;
      toast.error(message, { id });
    }
  }, [query.isError, query.errorUpdatedAt, id, message]);
}
