import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';

interface OverviewErrorProps {
  onRefresh: () => void;
  isFetching: boolean;
}

/** Inline failure panel per the UI-SPEC error contract: never shows cached numbers as current. */
export function OverviewError({ onRefresh, isFetching }: OverviewErrorProps) {
  return (
    <Card role="alert">
      <CardContent className="flex flex-wrap items-center justify-between gap-3">
        <span className="text-sm">Failed to load gateway data. Check your connection and try again.</span>
        <Button variant="outline" size="sm" className="h-11 md:h-8" onClick={onRefresh} disabled={isFetching}>
          Refresh
        </Button>
      </CardContent>
    </Card>
  );
}
