import { useQuery } from '@tanstack/react-query';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { statsQuery } from '@/lib/queries';

// Named overview-page (not overview) because src/dashboard/views/overview.ts stays until plan 01-08,
// and a bare './views/overview' import would resolve to that old .ts file first.
export default function OverviewView() {
  const stats = useQuery(statsQuery('24h'));

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-normal text-muted-foreground">Requests (24h)</CardTitle>
        </CardHeader>
        <CardContent>
          {stats.isFetching ? (
            <span className="text-sm text-muted-foreground">Loading…</span>
          ) : stats.isError || !stats.data ? (
            <span role="alert" className="text-sm text-status-danger">
              Failed to load gateway data. Check your connection and try again.
            </span>
          ) : (
            <span className="font-mono text-2xl font-semibold">{Number(stats.data.totals.requests ?? 0)}</span>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
