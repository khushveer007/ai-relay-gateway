import { useEffect, useState } from 'react';
import { ResponsiveDialog } from '@/components/responsive-dialog';
import { ResponsiveList, TruncatedText, type ResponsiveColumn } from '@/components/responsive-list';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useIsDesktop } from '@/hooks/use-media-query';

// Development-only test page for the two responsive primitives (D-10). Registered in App.tsx only
// inside import.meta.env.DEV guards, so it is absent from the production build. Open it with
// `npm run dev:ui` at http://localhost:5173/#/__playground, no sign-in needed.

type Sample = { id: number; name: string; status: string; count: number; detail: string };

const SAMPLE_COLUMNS: ResponsiveColumn<Sample>[] = [
  { key: 'name', header: 'Name', isRowTitle: true, cell: (r) => r.name },
  { key: 'status', header: 'Status', cell: (r) => r.status },
  { key: 'count', header: 'Count', className: 'tabular-nums', cell: (r) => r.count },
  {
    key: 'detail',
    header: 'Detail',
    className: 'max-w-[220px]',
    cell: (r) => <TruncatedText text={r.detail} />,
  },
];

function makeRows(n: number): Sample[] {
  return Array.from({ length: n }, (_, i) => ({
    id: i + 1,
    name: `Sample provider ${i + 1}`,
    status: i % 3 === 0 ? 'active' : i % 3 === 1 ? 'cooldown' : 'invalid',
    count: (i + 1) * 137,
    detail: `https://very-long-relay-hostname-${i + 1}.example.com/v1/chat/completions?region=eu-west&tier=standard`,
  }));
}

type ListState = 'empty' | 'loading' | 'one' | 'many';
const LIST_STATES: { id: ListState; label: string }[] = [
  { id: 'empty', label: 'Empty' },
  { id: 'loading', label: 'Loading' },
  { id: 'one', label: 'One row' },
  { id: 'many', label: 'Many rows (30)' },
];

const ROWS_BY_STATE: Record<ListState, Sample[]> = {
  empty: [],
  loading: [],
  one: makeRows(1),
  many: makeRows(30),
};

function useWindowWidth(): number {
  const [width, setWidth] = useState(() => window.innerWidth);
  useEffect(() => {
    const onResize = () => setWidth(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return width;
}

export default function Playground() {
  const width = useWindowWidth();
  const isDesktop = useIsDesktop();
  const [open, setOpen] = useState(false);
  const [listState, setListState] = useState<ListState>('many');

  return (
    <div className="mx-auto flex min-h-dvh max-w-5xl flex-col gap-8 p-4 md:p-8">
      <header className="flex flex-col gap-2">
        <h1 className="text-xl font-semibold">Primitive test page (development only)</h1>
        <p className="text-sm text-muted-foreground">
          Width: <span className="font-mono">{width}px</span> | Mode:{' '}
          <span className="font-mono">{isDesktop ? 'table' : 'cards'}</span>
        </p>
      </header>

      <section className="flex flex-col gap-3">
        <h2 className="text-xl font-semibold">ResponsiveDialog</h2>
        <div>
          <Button onClick={() => setOpen(true)}>Open dialog</Button>
        </div>
        <ResponsiveDialog
          open={open}
          onOpenChange={setOpen}
          title="Sample form"
          description="Type in the inputs, then scroll the body. The page behind must stay still."
          footer={
            <>
              <Button variant="outline" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button onClick={() => setOpen(false)}>Save</Button>
            </>
          }
        >
          <div className="flex flex-col gap-4">
            <label className="flex flex-col gap-1.5 text-sm font-semibold">
              Name
              <Input type="text" placeholder="Provider name" />
            </label>
            <label className="flex flex-col gap-1.5 text-sm font-semibold">
              Contact email
              <Input type="email" placeholder="name@example.com" />
            </label>
            <label className="flex flex-col gap-1.5 text-sm font-semibold">
              Monthly budget
              <Input type="number" placeholder="0" />
            </label>
            {Array.from({ length: 20 }, (_, i) => (
              <p key={i} className="text-sm text-muted-foreground">
                Filler paragraph {i + 1}. This text exists so the dialog body has to scroll inside itself. Long
                copy should wrap inside the dialog width and never push the header or footer out of place.
              </p>
            ))}
          </div>
        </ResponsiveDialog>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-xl font-semibold">ResponsiveList</h2>
        <div role="group" aria-label="List state" className="flex flex-wrap gap-2">
          {LIST_STATES.map((s) => (
            <Button
              key={s.id}
              variant={listState === s.id ? 'default' : 'outline'}
              aria-pressed={listState === s.id}
              onClick={() => setListState(s.id)}
            >
              {s.label}
            </Button>
          ))}
        </div>
        <ResponsiveList
          rows={ROWS_BY_STATE[listState]}
          columns={SAMPLE_COLUMNS}
          getRowKey={(r) => r.id}
          isLoading={listState === 'loading'}
          emptyMessage="Nothing to show."
          ariaLabel="Sample providers"
          renderActions={() => (
            <>
              <Button size="sm" variant="outline">
                Enable
              </Button>
              <Button size="sm" variant="outline">
                Test Key
              </Button>
            </>
          )}
        />
      </section>
    </div>
  );
}
