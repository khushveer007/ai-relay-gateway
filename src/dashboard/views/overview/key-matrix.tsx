import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { KeyStatusBadge } from '@/components/status-badge';
import { ResponsiveList, TruncatedText, type ResponsiveColumn } from '@/components/responsive-list';
import { useEnableKey, useTestKey } from '@/hooks/use-key-actions';
import { enableLabel, fmtAgo, fmtBalance, fmtNum } from '@/lib/format';
import { keyDetailText, keyLabel, type Range } from '@/lib/overview';
import type { ProviderDTO, ProviderKeyDTO, StatsDTO } from '@/lib/api';

interface KeyRow {
  provider: ProviderDTO;
  key: ProviderKeyDTO;
}

interface KeyMatrixProps {
  range: Range;
  providers: ProviderDTO[] | undefined;
  stats: StatsDTO | undefined;
  isLoading: boolean;
  /** /providers failed: no rows, and the empty message must not send the operator to add a provider. */
  providersFailed?: boolean;
  /** /stats failed: Reqs and Last Used show an em dash instead of 0 and never. */
  statsFailed?: boolean;
}

/**
 * Key Health Matrix: every upstream key across every provider, on ResponsiveList. Only `key_hint`
 * (never the encrypted or a plaintext key) is ever rendered (T-01-19).
 */
export function KeyMatrix({ range, providers, stats, isLoading, providersFailed = false, statsFailed = false }: KeyMatrixProps) {
  const enableKey = useEnableKey();
  const testKey = useTestKey();

  const rows: KeyRow[] = (providers ?? []).flatMap((provider) =>
    provider.keys.map((key) => ({ provider, key })),
  );
  const usageMap = new Map((stats?.by_key ?? []).map((u) => [u.key_id, u]));

  const columns: ResponsiveColumn<KeyRow>[] = [
    {
      key: 'provider',
      header: 'Provider',
      isRowTitle: true,
      cell: ({ provider }) => <TruncatedText className="max-w-[200px]" text={provider.name} />,
    },
    {
      key: 'key',
      header: 'Key',
      cell: ({ key }) => <TruncatedText className="max-w-[220px] font-mono text-xs" text={keyLabel(key)} />,
    },
    {
      key: 'status',
      header: 'Status',
      cell: ({ key }) => <KeyStatusBadge status={key.status} />,
    },
    {
      key: 'balance',
      header: 'Balance',
      cell: ({ key }) => <span className="font-mono">{fmtBalance(key.balance)}</span>,
    },
    {
      key: 'reqs',
      header: `Reqs (${range})`,
      cell: ({ key }) => <span className="font-mono">{statsFailed ? '—' : fmtNum(usageMap.get(key.id)?.requests ?? 0)}</span>,
    },
    {
      key: 'last-used',
      header: 'Last Used',
      cell: ({ key }) => (statsFailed ? '—' : fmtAgo(usageMap.get(key.id)?.last_used)),
    },
    {
      key: 'detail',
      header: 'Detail / Cooldown',
      cell: ({ key }) => <span className="block max-w-[280px] break-words">{keyDetailText(key)}</span>,
    },
  ];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-xl">Key Health Matrix</CardTitle>
        <CardDescription>Live status of every upstream API key across all providers</CardDescription>
      </CardHeader>
      <CardContent>
        <ResponsiveList
          rows={rows}
          columns={columns}
          getRowKey={(row) => row.key.id}
          ariaLabel="Key health matrix"
          actionsHeader="Quick Action"
          isLoading={isLoading}
          emptyMessage={
            providersFailed ? 'Unavailable — see the error above.' : 'No API keys configured yet. Add your first provider in Providers & Keys.'
          }
          renderActions={(row) => {
            const enablePending = enableKey.isPending && enableKey.variables === row.key.id;
            const testPending = testKey.isPending && testKey.variables === row.key.id;
            return (
              <>
                {row.key.status !== 'active' ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="h-11 md:h-8"
                    disabled={enablePending}
                    onClick={() => enableKey.mutate(row.key.id)}
                  >
                    {enablePending ? (row.key.status === 'invalid' ? 'Re-enabling…' : 'Enabling…') : enableLabel(row.key.status)}
                  </Button>
                ) : null}
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="h-11 md:h-8"
                  disabled={testPending}
                  onClick={() => testKey.mutate(row.key.id)}
                >
                  {testPending ? 'Testing…' : 'Test Key'}
                </Button>
              </>
            );
          }}
        />
      </CardContent>
    </Card>
  );
}
