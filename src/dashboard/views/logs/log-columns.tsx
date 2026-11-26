import { Badge } from '@/components/ui/badge';
import { HttpStatusBadge } from '@/components/status-badge';
import { TruncatedText, type ResponsiveColumn } from '@/components/responsive-list';
import { useIsDesktop } from '@/hooks/use-media-query';
import type { GatewayKeyDTO, LogRowDTO, ProviderDTO, RouteDTO } from '@/lib/api';
import { fmtAgo, fmtMs, fmtTime, fmtTokensOrDash } from '@/lib/format';
import { logModelLine } from '@/lib/logs-filters';

/** Name lookups for a log row. A deleted provider, key, gateway key or route falls back to '#id'; no id is an em dash. */
export interface LogLabels {
  provider: (id: number | null) => string;
  key: (id: number | null) => string;
  gatewayKey: (id: number | null) => string;
  route: (id: number | null) => string;
}

export function buildLogLabels(providers: ProviderDTO[], gatewayKeys: GatewayKeyDTO[], routes: RouteDTO[]): LogLabels {
  const providerNames = new Map(providers.map((p) => [p.id, p.name]));
  const keyNames = new Map<number, string>();
  for (const p of providers) for (const k of p.keys) keyNames.set(k.id, k.alias || k.key_hint);
  const gatewayNames = new Map(gatewayKeys.map((k) => [k.id, k.name]));
  const routeNames = new Map(routes.map((r) => [r.id, r.name]));
  const pick = (names: Map<number, string>) => (id: number | null) => (id === null ? '—' : (names.get(id) ?? `#${id}`));
  return { provider: pick(providerNames), key: pick(keyNames), gatewayKey: pick(gatewayNames), route: pick(routeNames) };
}

/** '2 failovers' pill, warn tone. Only rendered when failovers is above zero. */
export function FailoverBadge({ count }: { count: number }) {
  return (
    <Badge variant="outline" className="border-transparent bg-status-warn/15 text-status-warn">
      {count} {count === 1 ? 'failover' : 'failovers'}
    </Badge>
  );
}

function TimeCell({ row }: { row: LogRowDTO }) {
  const isDesktop = useIsDesktop();
  return (
    <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
      <span className="font-mono" title={new Date(row.ts).toISOString()}>
        {fmtTime(row.ts)}
      </span>
      <span className="text-xs font-normal text-muted-foreground">{fmtAgo(row.ts)}</span>
      {/* Card mode puts the status on the first line; the table has its own Status column. */}
      {isDesktop ? null : <HttpStatusBadge status={row.status} />}
    </span>
  );
}

function ModelCell({ row }: { row: LogRowDTO }) {
  const line = logModelLine(row);
  return <TruncatedText text={line} className="font-mono text-xs" />;
}

function summaryLine(row: LogRowDTO): string {
  return `${fmtMs(row.latency_ms)} · ${fmtTokensOrDash(row.input_tokens)} in · ${fmtTokensOrDash(row.output_tokens)} out`;
}

export function logColumns(labels: LogLabels): ResponsiveColumn<LogRowDTO>[] {
  return [
    { key: 'time', header: 'Time', isRowTitle: true, cell: (r) => <TimeCell row={r} /> },
    { key: 'model', header: 'Model', mobileLabel: 'Model', className: 'max-w-64', cell: (r) => <ModelCell row={r} /> },
    {
      key: 'summary',
      header: 'Summary',
      mobileOnly: true,
      mobileLabel: 'Latency and tokens',
      cell: (r) => (
        <span className="flex flex-wrap items-center gap-2">
          <span>{summaryLine(r)}</span>
          {r.failovers > 0 ? <FailoverBadge count={r.failovers} /> : null}
        </span>
      ),
    },
    {
      key: 'route',
      header: 'Route → Provider / Key',
      desktopOnly: true,
      className: 'max-w-64',
      cell: (r) => (
        <TruncatedText
          text={`${labels.route(r.route_id)} → ${labels.provider(r.provider_id)} / ${labels.key(r.key_id)}`}
          className="text-xs"
        />
      ),
    },
    { key: 'status', header: 'Status', desktopOnly: true, cell: (r) => <HttpStatusBadge status={r.status} /> },
    {
      key: 'timing',
      header: 'TTFB / Total',
      desktopOnly: true,
      className: 'font-mono text-xs whitespace-nowrap',
      cell: (r) => `${fmtMs(r.ttfb_ms)} / ${fmtMs(r.latency_ms)}`,
    },
    {
      key: 'tokens',
      header: 'Tokens (in / out / cache)',
      desktopOnly: true,
      className: 'font-mono text-xs whitespace-nowrap',
      cell: (r) => `${fmtTokensOrDash(r.input_tokens)} / ${fmtTokensOrDash(r.output_tokens)} / ${fmtTokensOrDash(r.cache_tokens)}`,
    },
    {
      key: 'failovers',
      header: 'Failovers',
      desktopOnly: true,
      cell: (r) => (r.failovers > 0 ? <FailoverBadge count={r.failovers} /> : <span className="text-muted-foreground">—</span>),
    },
  ];
}

/** Accessible name of a tappable row. */
export function logRowLabel(row: LogRowDTO): string {
  return `Request at ${fmtTime(row.ts)}, ${logModelLine(row)}, HTTP ${row.status}. Open details.`;
}
