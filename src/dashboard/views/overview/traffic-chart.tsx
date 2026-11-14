import { useMemo } from 'react';
import { Bar, BarChart, CartesianGrid, XAxis } from 'recharts';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from '@/components/ui/chart';
import { useMediaQuery } from '@/hooks/use-media-query';
import { alignSeries, fillSeries, type Range, type SeriesPoint } from '@/lib/overview';
import type { StatsDTO } from '@/lib/api';

const CHART_CONFIG: ChartConfig = {
  ok: { label: 'OK', color: '#8a5cf5' },
  errors: { label: 'Errors', color: 'var(--status-danger)' },
};

interface TrafficChartProps {
  range: Range;
  stats: StatsDTO | undefined;
  isLoading: boolean;
  isFailed: boolean;
}

function fmtTick(bucket: number, bucketMs: number): string {
  const d = new Date(bucket);
  if (bucketMs < 6 * 3_600_000) {
    return d.toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit' });
  }
  return d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', hour12: false });
}

function fmtTooltipLabel(point: SeriesPoint | undefined): string {
  if (!point) return '';
  const ts = new Date(point.bucket).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  return `${ts} · ${point.failovers} failover${point.failovers === 1 ? '' : 's'}`;
}

/** Traffic & Errors stacked bar chart over `fillSeries`. Owned by the Overview error panel: never rendered when stats failed. */
export function TrafficChart({ range, stats, isLoading, isFailed }: TrafficChartProps) {
  const isCoarsePointer = useMediaQuery('(pointer: coarse)');
  const data = useMemo(() => {
    if (!stats) return [];
    return fillSeries(alignSeries(stats.series, stats.bucket_ms), stats.since, stats.bucket_ms, Date.now());
  }, [stats]);
  const byBucket = useMemo(() => new Map(data.map((d) => [d.bucket, d])), [data]);
  const bucketMs = stats?.bucket_ms ?? 3_600_000;

  if (isFailed) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-xl font-semibold">Traffic &amp; Errors</CardTitle>
        <CardDescription className="text-xs">Requests per time bucket over the last {range}</CardDescription>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <Skeleton className="h-64 w-full" />
        ) : data.length === 0 ? (
          <div className="flex h-64 w-full items-center justify-center text-sm text-muted-foreground">
            No requests recorded in this window yet.
          </div>
        ) : (
          <ChartContainer config={CHART_CONFIG} className="h-64 w-full aspect-auto">
            <BarChart data={data}>
              <defs>
                <linearGradient id="trafficOkGradient" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#6e36f2" />
                  <stop offset="100%" stopColor="#8a5cf5" />
                </linearGradient>
              </defs>
              <CartesianGrid vertical={false} />
              <XAxis
                dataKey="bucket"
                tickFormatter={(v: number) => fmtTick(v, bucketMs)}
                interval="preserveStartEnd"
                minTickGap={24}
                tickLine={false}
                axisLine={false}
              />
              <ChartTooltip
                trigger={isCoarsePointer ? 'click' : 'hover'}
                content={
                  <ChartTooltipContent
                    labelFormatter={(_label, payload) => fmtTooltipLabel(byBucket.get(payload?.[0]?.payload?.bucket))}
                  />
                }
              />
              <Bar dataKey="ok" stackId="traffic" fill="url(#trafficOkGradient)" maxBarSize={32} />
              <Bar dataKey="errors" stackId="traffic" fill="var(--color-status-danger)" maxBarSize={32} />
            </BarChart>
          </ChartContainer>
        )}
      </CardContent>
    </Card>
  );
}
