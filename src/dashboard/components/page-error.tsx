import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';

interface PageErrorProps {
  /** Fixed copy, never raw server text: 'Failed to load {page name}. Check your connection and try again.' */
  message: string;
  onRefresh: () => void;
  isFetching: boolean;
}

/**
 * The shared load-failure panel: shown when a page's query fails with no cached data to show. It
 * never shows cached numbers as current (UI-SPEC error contract).
 */
export function PageError({ message, onRefresh, isFetching }: PageErrorProps) {
  return (
    <Card role="alert">
      <CardContent className="flex flex-wrap items-center justify-between gap-3">
        <span className="min-w-0 text-sm break-words">{message}</span>
        <Button variant="outline" size="sm" className="h-11 md:h-8" onClick={onRefresh} disabled={isFetching}>
          Refresh
        </Button>
      </CardContent>
    </Card>
  );
}
