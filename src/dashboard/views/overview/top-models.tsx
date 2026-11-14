import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ResponsiveList, TruncatedText, type ResponsiveColumn } from '@/components/responsive-list';
import { fmtNum, fmtTokensOrDash } from '@/lib/format';
import type { StatsDTO } from '@/lib/api';

type ModelRow = StatsDTO['by_model'][number];

interface TopModelsProps {
  rows: readonly ModelRow[];
  isLoading: boolean;
}

const columns: ResponsiveColumn<ModelRow>[] = [
  {
    key: 'model',
    header: 'Model',
    isRowTitle: true,
    cell: (row) => <TruncatedText className="max-w-[240px] font-mono" text={row.model} />,
  },
  {
    key: 'requests',
    header: 'Requests',
    cell: (row) => <span className="font-mono">{fmtNum(row.requests)}</span>,
  },
  {
    key: 'input',
    header: 'Input Tokens',
    cell: (row) => <span className="font-mono">{fmtTokensOrDash(row.input_tokens)}</span>,
  },
  {
    key: 'output',
    header: 'Output Tokens',
    cell: (row) => <span className="font-mono">{fmtTokensOrDash(row.output_tokens)}</span>,
  },
];

/** Top models in the API's request-count order (no client sorting). */
export function TopModels({ rows, isLoading }: TopModelsProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Top Models</CardTitle>
      </CardHeader>
      <CardContent>
        <ResponsiveList
          rows={rows}
          columns={columns}
          getRowKey={(row) => row.model}
          ariaLabel="Top models"
          isLoading={isLoading}
          emptyMessage="No model traffic in this window."
        />
      </CardContent>
    </Card>
  );
}
