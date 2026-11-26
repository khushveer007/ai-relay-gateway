import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { fmtNum } from '@/lib/format';

type AttentionState = { status: 'loading' | 'error' } | { status: 'ready'; names: string[] };

function AttentionGroup({ title, href, link, error, state }: {
  title: string;
  href: string;
  link: string;
  error: string;
  state: AttentionState;
}) {
  return (
    <section aria-label={title} aria-busy={state.status === 'loading'} className="flex min-w-0 flex-col items-start gap-2">
      <h3 className="text-sm font-semibold">{title}</h3>
      {state.status === 'loading' && <Skeleton className="h-7 w-20" aria-label={`Loading ${title.toLowerCase()}`} />}
      {state.status === 'error' && <p role="status" className="text-sm text-muted-foreground">{error}</p>}
      {state.status === 'ready' && (
        <>
          <p className="text-xl font-semibold tabular-nums" aria-label={`${fmtNum(state.names.length)} ${title.toLowerCase()}`}>
            {fmtNum(state.names.length)}
          </p>
          {state.names.length > 0 && (
            <ul className="w-full space-y-1 text-sm wrap-anywhere text-muted-foreground">
              {state.names.slice(0, 3).map((name, i) => <li key={i}>{name}</li>)}
              {state.names.length > 3 && <li>+{fmtNum(state.names.length - 3)} more</li>}
            </ul>
          )}
        </>
      )}
      <Button asChild variant="outline" size="sm" className="mt-auto">
        <a href={href}>{link}</a>
      </Button>
    </section>
  );
}

export function NeedsAttention({ dropped, unpriced }: { dropped: AttentionState; unpriced: AttentionState }) {
  return (
    <section aria-labelledby="needs-attention-title">
      <Card>
        <CardHeader>
          <h2 id="needs-attention-title" className="font-semibold">Needs attention</h2>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-2 md:gap-8">
          <AttentionGroup title="Dropped keys" href="#/providers" link="View providers" error="Couldn’t load dropped keys." state={dropped} />
          <AttentionGroup title="Unpriced models" href="#/prices" link="View prices" error="Couldn’t load unpriced models." state={unpriced} />
        </CardContent>
      </Card>
    </section>
  );
}
