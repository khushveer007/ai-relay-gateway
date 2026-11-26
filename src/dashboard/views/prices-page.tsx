import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import { PageError } from '@/components/page-error';
import { PageHeader } from '@/components/page-header';
import { ResponsiveList, type ResponsiveColumn } from '@/components/responsive-list';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { type ModelPriceResolutionDTO, type PriceDTO } from '@/lib/api';
import { REFRESH_PRICE_ERROR, refreshCatalogPrices } from '@/lib/price-catalog';
import { PRICE_QUERY_KEY, priceModelsQuery, pricesQuery } from '@/lib/queries';
import { RATE_FIELDS, type MatchType } from '../../shared/pricing';
import { AliasEditor, displayRate, hasUsablePrice, PriceEditor, RATE_LABEL } from './prices/price-dialogs';

const LOAD_MESSAGE = 'Failed to load prices. Check your connection and try again.';
const PAGE_SIZE = 50;
const ROW_ACTION = 'h-11 md:h-8';
const MATCH_LABEL: Record<MatchType, string> = {
  pinned: 'Pinned alias',
  exact: 'Exact match',
  normalized: 'Normalized match',
  ambiguous: 'Ambiguous match',
  none: 'No match',
};

const unpricedColumns: ResponsiveColumn<ModelPriceResolutionDTO>[] = [
  {
    key: 'model',
    header: 'Upstream model',
    cell: ({ upstream_model }) => <span className="block max-w-96 font-mono wrap-anywhere whitespace-normal">{upstream_model}</span>,
  },
  {
    key: 'reason',
    header: 'Reason',
    cell: ({ match_type }) => (
      <span className="whitespace-normal text-muted-foreground">
        {match_type === 'ambiguous' ? 'Multiple matches. Choose a model to pin.' : 'No price found.'}
      </span>
    ),
  },
];

function RateValue({ rate, overridden }: { rate: number | null; overridden: boolean }) {
  return (
    <span className="flex flex-wrap items-baseline gap-x-2">
      <span className={rate === null ? 'text-muted-foreground' : 'font-mono tabular-nums'}>{displayRate(rate)}</span>
      {overridden ? <span className="text-xs text-muted-foreground">Override</span> : null}
    </span>
  );
}

function MoreRows({ amount, onMore }: { amount: number; onMore: () => void }) {
  return (
    <Button variant="outline" className="h-11 self-start md:h-9" onClick={onMore}>
      Show {Math.min(amount, PAGE_SIZE)} more
    </Button>
  );
}

function PriceModel({ price, matches, onPin }: {
  price: PriceDTO;
  matches: readonly ModelPriceResolutionDTO[];
  onPin: (model: ModelPriceResolutionDTO) => void;
}) {
  const { effective_tier: tier } = price;
  const hasTier = tier.state !== 'base';
  return (
    <div className="flex w-full max-w-96 min-w-0 flex-col gap-2 whitespace-normal md:w-60">
      <span className="font-mono wrap-anywhere">{price.model}</span>
      {matches.length ? (
        <Collapsible>
          <CollapsibleTrigger asChild>
            <Button variant="outline" size="sm" className={ROW_ACTION}>
              Match details <ChevronDown aria-hidden="true" />
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <ul className="mt-2 space-y-2">
              {matches.map((match) => (
                <li className="space-y-2 border-t border-border-subtle pt-2 text-sm" key={match.upstream_model}>
                  <p className="font-mono wrap-anywhere">{match.upstream_model}</p>
                  <p className="text-xs text-muted-foreground">{MATCH_LABEL[match.match_type]}</p>
                  <Button variant="outline" size="sm" className={ROW_ACTION} onClick={() => onPin(match)}>Pin alias</Button>
                </li>
              ))}
            </ul>
          </CollapsibleContent>
        </Collapsible>
      ) : null}
      {hasTier ? (
        <Collapsible>
          <CollapsibleTrigger asChild>
            <Button variant="outline" size="sm" className={ROW_ACTION}>
              Long-context rates <ChevronDown aria-hidden="true" />
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div className="mt-2 space-y-2 text-sm">
              {tier.threshold_tokens !== null ? (
                <p className="text-muted-foreground">Applies when the prompt exceeds {tier.threshold_tokens.toLocaleString('en-US')} tokens.</p>
              ) : null}
              <dl className="space-y-2">
                {RATE_FIELDS.map((field) => (
                  <div key={field}>
                    <dt className="text-xs font-semibold text-muted-foreground">{RATE_LABEL[field]}</dt>
                    <dd><RateValue rate={tier.rates[field]} overridden={tier.state === 'supported' && price.override_tier[field] !== null} /></dd>
                  </div>
                ))}
              </dl>
            </div>
          </CollapsibleContent>
        </Collapsible>
      ) : null}
    </div>
  );
}

type PricingDialog =
  | { kind: 'price'; model: string; price?: PriceDTO; title: 'Set price' | 'Edit price' }
  | { kind: 'alias'; model: ModelPriceResolutionDTO };

export default function PricesView() {
  const queryClient = useQueryClient();
  const prices = useQuery(pricesQuery);
  const models = useQuery(priceModelsQuery);
  const [unpricedLimit, setUnpricedLimit] = useState(PAGE_SIZE);
  const [pricesLimit, setPricesLimit] = useState(PAGE_SIZE);
  const [dialog, setDialog] = useState<PricingDialog | null>(null);
  const refreshing = useRef(false);
  const refresh = useMutation({
    mutationFn: refreshCatalogPrices,
    onSuccess: () => {
      toast.success('Prices refreshed.');
      return queryClient.invalidateQueries({ queryKey: PRICE_QUERY_KEY });
    },
    onSettled: () => { refreshing.current = false; },
  });

  const rows = prices.data?.prices ?? [];
  const priced = rows.filter(hasUsablePrice);
  const names = models.data?.models ?? [];
  const unpriced = names.filter((entry) => entry.priced_model === null);
  const byName = new Map(rows.map((row) => [row.model, row]));
  const matches = new Map<string, ModelPriceResolutionDTO[]>();
  for (const name of names) {
    if (name.priced_model === null) continue;
    const previous = matches.get(name.priced_model) ?? [];
    previous.push(name);
    matches.set(name.priced_model, previous);
  }
  const pin = (model: ModelPriceResolutionDTO) => setDialog({ kind: 'alias', model });
  const priceColumns: ResponsiveColumn<PriceDTO>[] = [
    {
      key: 'model',
      header: 'Model',
      cell: (price) => <PriceModel price={price} matches={matches.get(price.model) ?? []} onPin={pin} />,
    },
    ...RATE_FIELDS.map((field): ResponsiveColumn<PriceDTO> => ({
      key: field,
      header: RATE_LABEL[field],
      cell: (price) => <RateValue rate={price.effective_base[field]} overridden={price.override_base[field] !== null} />,
    })),
  ];

  function importPrices() {
    if (refreshing.current) return;
    refreshing.current = true;
    refresh.mutate();
  }

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <PageHeader title="Prices" actions={
        <Button className="h-11 md:h-9" onClick={importPrices} disabled={refresh.isPending}>
          <RefreshCw aria-hidden="true" />
          {refresh.isPending ? 'Refreshing prices…' : 'Refresh prices'}
        </Button>
      } />
      {refresh.isError ? <p role="alert" className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">{REFRESH_PRICE_ERROR}</p> : null}
      {(prices.isError && !prices.data) || (models.isError && !models.data) ? (
        <PageError message={LOAD_MESSAGE} retryName="Retry loading prices"
          onRefresh={() => { void prices.refetch(); void models.refetch(); }} refreshing={prices.isFetching || models.isFetching} />
      ) : null}
      {models.data || models.isPending ? (
        <section className="flex min-w-0 flex-col gap-3" aria-labelledby="unpriced-models-title">
          <h2 id="unpriced-models-title" className="text-sm font-semibold">Unpriced models</h2>
          <ResponsiveList
            rows={unpriced.slice(0, unpricedLimit)}
            columns={unpricedColumns}
            getRowKey={(row) => row.upstream_model}
            renderActions={(row) => (
              <div className="flex flex-wrap gap-2">
                <Button variant="outline" size="sm" className={ROW_ACTION} onClick={() => pin(row)} disabled={!prices.data}>Pin alias</Button>
                <Button variant="outline" size="sm" className={ROW_ACTION} disabled={!prices.data}
                  onClick={() => setDialog({ kind: 'price', model: row.upstream_model, price: byName.get(row.upstream_model), title: 'Set price' })}>
                  Set price
                </Button>
              </div>
            )}
            isLoading={models.isPending}
            emptyMessage="No unpriced models found."
            ariaLabel="Unpriced models"
            footer={unpriced.length > unpricedLimit ? <MoreRows amount={unpriced.length - unpricedLimit} onMore={() => setUnpricedLimit(unpricedLimit + PAGE_SIZE)} /> : null}
          />
        </section>
      ) : null}
      {prices.data || prices.isPending ? (
        <section className="flex min-w-0 flex-col gap-3" aria-labelledby="price-table-title">
          <div>
            <h2 id="price-table-title" className="text-sm font-semibold">Price table</h2>
            <p className="text-sm text-muted-foreground">USD per 1M tokens</p>
          </div>
          <ResponsiveList
            rows={priced.slice(0, pricesLimit)}
            columns={priceColumns}
            getRowKey={(row) => row.model}
            renderActions={(row) => (
              <Button variant="outline" size="sm" className={ROW_ACTION}
                onClick={() => setDialog({ kind: 'price', model: row.model, price: row, title: 'Edit price' })}>Edit price</Button>
            )}
            isLoading={prices.isPending}
            emptyMessage="No prices saved. Refresh prices to import rates for relevant models."
            ariaLabel="Price table"
            footer={priced.length > pricesLimit ? <MoreRows amount={priced.length - pricesLimit} onMore={() => setPricesLimit(pricesLimit + PAGE_SIZE)} /> : null}
          />
        </section>
      ) : null}
      {dialog?.kind === 'price' ? <PriceEditor model={dialog.model} price={dialog.price} title={dialog.title} onClose={() => setDialog(null)} /> : null}
      {dialog?.kind === 'alias' ? <AliasEditor model={dialog.model} prices={rows} onClose={() => setDialog(null)} /> : null}
    </div>
  );
}
