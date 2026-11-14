import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ResponsiveList, TruncatedText, type ResponsiveColumn } from '@/components/responsive-list';
import { fmtMs, fmtNum, fmtTokens } from '@/lib/format';
import type { ProviderDTO, StatsDTO } from '@/lib/api';

type ProviderRow = StatsDTO['by_provider'][number];

interface ProviderTrafficProps {
  rows: readonly ProviderRow[];
  providers: readonly ProviderDTO[] | undefined;
  isLoading: boolean;
}

/** Traffic by provider. Names come from /providers, falling back to `#{id}` when one is missing. */
export function ProviderTraffic({ rows, providers, isLoading }: ProviderTrafficProps) {
  const names = new Map((providers ?? []).map((p) => [p.id, p.name]));

  const columns: ResponsiveColumn<ProviderRow>[] = [
    {
      key: 'provider',
      header: 'Provider',
      isRowTitle: true,
      cell: (row) => (
        <TruncatedText className="max-w-[200px]" text={names.get(row.provider_id) ?? `#${row.provider_id}`} />
      ),
    },
    {
      key: 'requests',
      header: 'Requests',
      cell: (row) => <span className="font-mono">{fmtNum(row.requests)}</span>,
    },
    {
      key: 'ok',
      header: 'Success',
      cell: (row) => <span className="font-mono">{fmtNum(row.ok)}</span>,
    },
    {
      key: 'tokens',
      header: 'Tokens (In / Out)',
      cell: (row) => (
        <span className="font-mono">{`${fmtTokens(row.input_tokens)} / ${fmtTokens(row.output_tokens)}`}</span>
      ),
    },
    {
      key: 'ttfb',
      header: 'Avg TTFB',
      cell: (row) => <span className="font-mono">{fmtMs(row.avg_ttfb)}</span>,
    },
  ];

  return (
    <Card>
      <CardHeader>
        <CardTitle>Traffic by Provider</CardTitle>
      </CardHeader>
      <CardContent>
        <ResponsiveList
          rows={rows}
          columns={columns}
          getRowKey={(row) => row.provider_id}
          ariaLabel="Traffic by provider"
          isLoading={isLoading}
          emptyMessage="No provider traffic in this window."
        />
      </CardContent>
    </Card>
  );
}
