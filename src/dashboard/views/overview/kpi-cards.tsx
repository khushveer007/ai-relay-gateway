import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { fmtMs, fmtNum, fmtTokens } from '@/lib/format';
import { successRate, type Range } from '@/lib/overview';
import type { ProviderDTO, StatsDTO } from '@/lib/api';

interface KpiCardsProps {
  range: Range;
  stats: StatsDTO | undefined;
  statsLoading: boolean;
  /** /stats failed: cards 1 to 3 read dashes, never zeros or a green health badge (WR-01). */
  statsFailed: boolean;
  providers: ProviderDTO[] | undefined;
  providersLoading: boolean;
  /** /providers failed: the Healthy Keys card reads dashes. */
  providersFailed: boolean;
}

interface KpiCardProps {
  label: string;
  badge: React.ReactNode;
  value: string;
  sub: string;
  loading: boolean;
  failed?: boolean;
}

function KpiCard({ label, badge, value, sub, loading, failed = false }: KpiCardProps) {
  return (
    <Card className="p-5">
      <div className="flex items-center justify-between gap-2 text-xs font-semibold text-muted-foreground">
        <span>{label}</span>
        {loading ? <Skeleton className="h-4 w-16" /> : failed ? null : badge}
      </div>
      {loading ? (
        <Skeleton className="mt-2 h-8 w-24" />
      ) : (
        <div className="mt-1 font-mono text-2xl font-semibold tabular-nums">{failed ? '—' : value}</div>
      )}
      {loading ? (
        <Skeleton className="mt-2 h-3 w-32" />
      ) : (
        <div className="mt-1 text-xs text-muted-foreground">{failed ? 'Unavailable' : sub}</div>
      )}
    </Card>
  );
}

/**
 * Four KPI cards per VIEW-01. Cards 1-3 depend on `stats`, card 4 on `providers`; each renders its
 * own skeleton while its dependency is loading (D-08) and `Number(x ?? 0)` everywhere because the
 * totals are NULL on an empty window (Pattern 6 null-safety).
 */
export function KpiCards({ range, stats, statsLoading, statsFailed, providers, providersLoading, providersFailed }: KpiCardsProps) {
  const totals = stats?.totals;
  const total = Number(totals?.requests ?? 0);
  const ok = Number(totals?.ok ?? 0);
  const failovered = Number(totals?.failovered ?? 0);
  const inTokens = Number(totals?.input_tokens ?? 0);
  const outTokens = Number(totals?.output_tokens ?? 0);
  const cacheTokens = Number(totals?.cache_tokens ?? 0);

  const allKeys = (providers ?? []).flatMap((p) => p.keys);
  const activeKeys = allKeys.filter((k) => k.status === 'active').length;
  const enabledProviders = (providers ?? []).filter((p) => p.enabled).length;
  const totalProviders = (providers ?? []).length;

  return (
    <div className="grid grid-cols-1 gap-4 md:gap-8 sm:grid-cols-2 xl:grid-cols-4">
      <KpiCard
        label={`Requests (${range})`}
        badge={<Badge variant="outline" className="border-status-ok/40 text-status-ok">{successRate(totals ?? {})}% OK</Badge>}
        value={fmtNum(total)}
        sub={`${fmtNum(ok)} succeeded · ${fmtNum(total - ok)} failed`}
        loading={statsLoading}
        failed={statsFailed}
      />
      <KpiCard
        label="Automatic Failovers"
        badge={<Badge className="bg-accent text-accent-foreground">Self-healing</Badge>}
        value={fmtNum(failovered)}
        sub="Requests recovered via key/provider rotation"
        loading={statsLoading}
        failed={statsFailed}
      />
      <KpiCard
        label="Tokens Processed"
        badge={<Badge className="bg-cyan/15 text-cyan">{`Out: ${fmtTokens(outTokens)}`}</Badge>}
        value={fmtTokens(inTokens + outTokens)}
        sub={`In: ${fmtTokens(inTokens)} · Cache read: ${fmtTokens(cacheTokens)}`}
        loading={statsLoading}
        failed={statsFailed}
      />
      <KpiCard
        label="Healthy Keys"
        badge={<Badge variant="secondary">{`${enabledProviders}/${totalProviders} providers`}</Badge>}
        value={`${activeKeys} / ${allKeys.length}`}
        sub={statsFailed ? 'Avg TTFB: — · Total: —' : `Avg TTFB: ${fmtMs(totals?.avg_ttfb)} · Total: ${fmtMs(totals?.avg_latency)}`}
        loading={providersLoading}
        failed={providersFailed}
      />
    </div>
  );
}
