import type { KeyboardEvent, ReactNode } from 'react';
import { Card } from '@/components/ui/card';
import { ScrollArea, ScrollBar } from '@/components/ui/scroll-area';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useIsDesktop } from '@/hooks/use-media-query';
import { cn } from '@/lib/utils';

// Rows, an empty message, skeleton rows, per-row action buttons and (for Request Logs) tappable rows
// with a footer slot for Load older. No drag-to-reorder. Without onRowClick it renders exactly as before.

export type ResponsiveColumn<T> = {
  key: string;
  header: ReactNode;
  cell: (row: T) => ReactNode;
  className?: string;
  /** Label shown in card mode. Defaults to the header when it is a string, else the key. */
  mobileLabel?: string;
  /** The column used as the card heading in card mode. Defaults to the first column. */
  isRowTitle?: boolean;
  /** Shown in the table only; card mode leaves it out. */
  desktopOnly?: boolean;
  /** Shown in card mode only; the table leaves it out. */
  mobileOnly?: boolean;
};

type ResponsiveListProps<T> = {
  rows: readonly T[];
  columns: ResponsiveColumn<T>[];
  getRowKey: (row: T) => string | number;
  renderActions?: (row: T) => ReactNode;
  actionsHeader?: string;
  isLoading?: boolean;
  skeletonRows?: number;
  emptyMessage: ReactNode;
  ariaLabel: string;
  /** Makes each row a button (Enter and Space work, with a focus ring). Not used together with renderActions. */
  onRowClick?: (row: T) => void;
  /** Accessible name of a tappable row. */
  getRowLabel?: (row: T) => string;
  /** Rendered under the list in both modes (a Load older button, an inline error). */
  footer?: ReactNode;
};

/**
 * A cell that shows an ellipsis when too long and reveals the full value on hover. Below 768px
 * (card mode) it wraps instead: a phone cannot hover a title, so the text must stay readable.
 */
export function TruncatedText({ text, className }: { text: string; className?: string }) {
  const isDesktop = useIsDesktop();
  if (!isDesktop) return <span className={cn('block break-words', className)}>{text}</span>;
  return (
    <span className={cn('block truncate', className)} title={text}>
      {text}
    </span>
  );
}

function mobileLabelOf<T>(col: ResponsiveColumn<T>): string {
  return col.mobileLabel ?? (typeof col.header === 'string' ? col.header : col.key);
}

export function ResponsiveList<T>({
  rows,
  columns: allColumns,
  getRowKey,
  renderActions,
  actionsHeader = 'Actions',
  isLoading = false,
  skeletonRows = 3,
  emptyMessage,
  ariaLabel,
  onRowClick,
  getRowLabel,
  footer,
}: ResponsiveListProps<T>) {
  const isDesktop = useIsDesktop();
  const columns = allColumns.filter((c) => (isDesktop ? !c.mobileOnly : !c.desktopOnly));
  const skeletonKeys = Array.from({ length: skeletonRows }, (_, i) => i);

  // Empty (and not loading): only the message, no table and no cards. Loading never shows it.
  if (!isLoading && rows.length === 0) {
    return (
      <div className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
        {emptyMessage}
      </div>
    );
  }

  if (isDesktop) {
    return (
      <>
      <div role="region" aria-label={ariaLabel} tabIndex={0} className="rounded-lg outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
        <ScrollArea className="w-full">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                {columns.map((col) => (
                  <TableHead key={col.key} className={col.className}>
                    {col.header}
                  </TableHead>
                ))}
                {renderActions ? <TableHead className="text-right">{actionsHeader}</TableHead> : null}
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading
                ? skeletonKeys.map((i) => (
                    <TableRow key={`skeleton-${i}`} className="hover:bg-transparent">
                      {columns.map((col) => (
                        <TableCell key={col.key} className={col.className}>
                          <Skeleton className="h-5 w-full max-w-40" />
                        </TableCell>
                      ))}
                      {renderActions ? (
                        <TableCell className="text-right">
                          <Skeleton className="ml-auto h-8 w-24" />
                        </TableCell>
                      ) : null}
                    </TableRow>
                  ))
                : rows.map((row) => (
                    <TableRow
                      key={getRowKey(row)}
                      {...(onRowClick
                        ? {
                            role: 'button',
                            tabIndex: 0,
                            'aria-label': getRowLabel?.(row),
                            className: 'cursor-pointer outline-none focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:ring-inset',
                            onClick: () => onRowClick(row),
                            onKeyDown: (e: KeyboardEvent<HTMLTableRowElement>) => {
                              if (e.target !== e.currentTarget) return;
                              if (e.key === 'Enter' || e.key === ' ') {
                                e.preventDefault();
                                onRowClick(row);
                              }
                            },
                          }
                        : {})}
                    >
                      {columns.map((col) => (
                        <TableCell key={col.key} className={col.className}>
                          {col.cell(row)}
                        </TableCell>
                      ))}
                      {renderActions ? (
                        <TableCell className="text-right">
                          <div className="flex justify-end gap-2">{renderActions(row)}</div>
                        </TableCell>
                      ) : null}
                    </TableRow>
                  ))}
            </TableBody>
          </Table>
          <ScrollBar orientation="horizontal" />
        </ScrollArea>
      </div>
      {footer}
      </>
    );
  }

  // Card mode: the heading is the isRowTitle column (else the first); the rest are label/value pairs.
  const titleCol = columns.find((c) => c.isRowTitle) ?? columns[0];
  const detailCols = columns.filter((c) => c !== titleCol);

  return (
    <>
    <div role="list" aria-label={ariaLabel} className="flex flex-col gap-3">
      {isLoading
        ? skeletonKeys.map((i) => (
            <Card key={`skeleton-${i}`} className="p-4" role="listitem">
              <Skeleton className="h-5 w-1/2" />
              {detailCols.map((col) => (
                <Skeleton key={col.key} className="h-4 w-full" />
              ))}
              {renderActions ? <Skeleton className="h-11 w-28" /> : null}
            </Card>
          ))
        : rows.map((row) => {
            const content = (
              <>
                {titleCol ? <div className="min-w-0 text-sm font-semibold break-words">{titleCol.cell(row)}</div> : null}
                <dl className="flex flex-col gap-2">
                  {detailCols.map((col) => (
                    <div key={col.key} className="flex flex-col gap-0.5">
                      <dt className="text-xs font-semibold text-muted-foreground">{mobileLabelOf(col)}</dt>
                      <dd className="min-w-0 text-sm break-words">{col.cell(row)}</dd>
                    </div>
                  ))}
                </dl>
                {renderActions ? <div className="flex flex-wrap gap-2">{renderActions(row)}</div> : null}
              </>
            );
            if (!onRowClick) {
              return (
                <Card key={getRowKey(row)} className="p-4" role="listitem">
                  {content}
                </Card>
              );
            }
            // Tappable card: a full-width button wrapper with left-aligned text. The Card inside stays the visual box.
            return (
              <div key={getRowKey(row)} role="listitem">
                <button
                  type="button"
                  aria-label={getRowLabel?.(row)}
                  onClick={() => onRowClick(row)}
                  className="block w-full rounded-xl text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
                >
                  <Card className="p-4 transition-colors hover:bg-muted/40">{content}</Card>
                </button>
              </div>
            );
          })}
    </div>
    {footer}
    </>
  );
}
