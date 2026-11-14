import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ActionBadge } from '@/components/status-badge';
import { ResponsiveList, type ResponsiveColumn } from '@/components/responsive-list';
import { fmtNum } from '@/lib/format';
import type { StatsDTO } from '@/lib/api';
import type { Range } from '@/lib/overview';

type ActionRow = StatsDTO['actions'][number];

interface AttemptOutcomesProps {
  range: Range;
  rows: readonly ActionRow[];
  isLoading: boolean;
}

const columns: ResponsiveColumn<ActionRow>[] = [
  {
    key: 'action',
    header: 'Outcome Action',
    isRowTitle: true,
    cell: (row) => <ActionBadge action={row.action} />,
  },
  {
    key: 'count',
    header: 'Attempts',
    mobileLabel: 'Attempts',
    cell: (row) => <span className="font-mono">{fmtNum(row.count)}</span>,
  },
];

/** Classification of upstream attempts. Failure is owned by the Overview error panel (rows arrive empty). */
export function AttemptOutcomes({ range, rows, isLoading }: AttemptOutcomesProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Attempt Outcomes</CardTitle>
        <CardDescription className="text-xs">{`Classification of upstream attempts (${range})`}</CardDescription>
      </CardHeader>
      <CardContent>
        <ResponsiveList
          rows={rows}
          columns={columns}
          getRowKey={(row) => row.action}
          ariaLabel="Attempt outcomes"
          isLoading={isLoading}
          emptyMessage="No upstream attempts recorded in this window."
        />
      </CardContent>
    </Card>
  );
}
