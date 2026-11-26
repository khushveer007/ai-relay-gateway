import { RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useNow } from '@/hooks/use-now';
import { fmtAgo } from '@/lib/format';
import { RANGES, RANGE_LABEL, type Range } from '@/lib/overview';
import { cn } from '@/lib/utils';

interface OverviewHeaderProps {
  range: Range;
  onRangeChange: (range: Range) => void;
  onRefresh: () => void;
  isFetching: boolean;
  /** `dataUpdatedAt` from the stats query; 0 before the first result arrives. */
  updatedAt: number;
}

/**
 * Title, subtitle, range segmented control, Refresh button and the ticking "Updated" label
 * (D-09). Calls `useNow` itself so only this header re-renders once a minute, not the whole page.
 */
export function OverviewHeader({ range, onRangeChange, onRefresh, isFetching, updatedAt }: OverviewHeaderProps) {
  useNow(60_000);

  return (
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div>
        <h1 className="text-xl font-semibold">Overview</h1>
        <p className="text-sm text-muted-foreground">
          Real-time health, failover activity, and token throughput across your providers.
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <div role="group" aria-label="Time range" className="flex gap-1 rounded-lg border border-border-subtle p-1">
          {RANGES.map((r) => (
            <button
              key={r}
              type="button"
              aria-pressed={range === r}
              onClick={() => onRangeChange(r)}
              className={cn(
                'min-h-11 rounded-md px-2.5 text-sm font-semibold transition-colors md:min-h-8',
                range === r
                  ? 'bg-accent text-accent-foreground'
                  : 'text-muted-foreground hover:bg-muted hover:text-foreground',
              )}
            >
              {RANGE_LABEL[r]}
            </button>
          ))}
        </div>
        <Button variant="outline" size="sm" onClick={onRefresh} disabled={isFetching} aria-label="Refresh overview">
          <RefreshCw aria-hidden="true" className={cn(isFetching && 'animate-spin')} />
          Refresh
        </Button>
        {updatedAt !== 0 && (
          <span className="text-xs text-muted-foreground">Updated {fmtAgo(updatedAt)}</span>
        )}
      </div>
    </div>
  );
}
