import { useState } from 'react';
import { Ellipsis } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Drawer, DrawerContent, DrawerHeader, DrawerTitle } from '@/components/ui/drawer';
import { NAV_ICON, ProxyUrlBox } from '@/components/nav';
import { useEditableFocus } from '@/hooks/use-editable-focus';
import { cn } from '@/lib/utils';
import { BOTTOM_VIEW_IDS, MORE_VIEW_IDS, NAV_LABEL, isMoreActive, type ViewId } from '@/lib/routes';

// Short labels (9 characters at most) so five slots fit at 360px; the long NAV_LABEL is for the sidebar.
const SLOT_LABEL: Record<(typeof BOTTOM_VIEW_IDS)[number], string> = {
  overview: 'Overview',
  providers: 'Providers',
  routes: 'Routes',
  logs: 'Logs',
};

const SLOT_BASE =
  'm-1 flex min-h-12 min-w-0 flex-col items-center justify-center gap-1 rounded-lg border text-xs font-semibold outline-none transition-colors focus-visible:ring-3 focus-visible:ring-ring/50';
const SLOT_ACTIVE = 'border-primary/50 bg-accent text-foreground';
const SLOT_IDLE = 'border-transparent text-muted-foreground';

interface BottomNavProps {
  view: ViewId;
  onSignOut: () => void;
  signingOut: boolean;
}

/**
 * Below 768px: five fixed slots (four views and More) and the More sheet (D-01). The bar has no data
 * of its own, so it never loads or errors; links only change the URL hash.
 */
export function BottomNav({ view, onSignOut, signingOut }: BottomNavProps) {
  const [moreOpen, setMoreOpen] = useState(false);
  const moreActive = isMoreActive(view) || moreOpen;
  // With interactive-widget=resizes-content a fixed bar would ride on top of the phone keyboard, so it
  // is hidden while a text field has focus. The More drawer stays mounted.
  const editing = useEditableFocus();

  return (
    <>
      <nav
        aria-label="Dashboard navigation"
        className={cn(
          'fixed inset-x-0 bottom-0 z-40 border-t border-border-subtle bg-card pb-[env(safe-area-inset-bottom)] md:hidden',
          editing && 'hidden',
        )}
      >
        <div className="grid grid-cols-5">
          {BOTTOM_VIEW_IDS.map((id) => {
            const Icon = NAV_ICON[id];
            const active = id === view;
            return (
              <a
                key={id}
                href={'#/' + id}
                aria-current={active ? 'page' : undefined}
                className={cn(SLOT_BASE, active ? SLOT_ACTIVE : SLOT_IDLE)}
              >
                <Icon className="size-5 shrink-0" aria-hidden="true" />
                <span className="max-w-full truncate">{SLOT_LABEL[id]}</span>
              </a>
            );
          })}
          <button
            type="button"
            aria-haspopup="dialog"
            aria-expanded={moreOpen}
            onClick={() => setMoreOpen(true)}
            className={cn(SLOT_BASE, moreActive ? SLOT_ACTIVE : SLOT_IDLE)}
          >
            <Ellipsis className="size-5 shrink-0" aria-hidden="true" />
            <span className="max-w-full truncate">More</span>
          </button>
        </div>
      </nav>

      <Drawer open={moreOpen} onOpenChange={setMoreOpen} shouldScaleBackground={false}>
        <DrawerContent className="flex max-h-[90dvh] flex-col" aria-describedby={undefined}>
          <DrawerHeader className="shrink-0 text-left">
            <DrawerTitle>More</DrawerTitle>
          </DrawerHeader>
          <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto overscroll-contain px-4 py-2">
            <ul className="flex flex-col gap-1">
              {MORE_VIEW_IDS.map((id) => {
                const Icon = NAV_ICON[id];
                const active = id === view;
                return (
                  <li key={id}>
                    <a
                      href={'#/' + id}
                      aria-current={active ? 'page' : undefined}
                      onClick={() => setMoreOpen(false)}
                      className={cn(
                        'flex min-h-11 items-center gap-2 rounded-lg border px-2.5 text-sm font-semibold outline-none transition-colors focus-visible:ring-3 focus-visible:ring-ring/50',
                        active ? SLOT_ACTIVE : 'border-transparent text-muted-foreground hover:bg-muted hover:text-foreground',
                      )}
                    >
                      <Icon className="size-4 shrink-0" aria-hidden="true" />
                      <span className="truncate">{NAV_LABEL[id]}</span>
                    </a>
                  </li>
                );
              })}
            </ul>
            <ProxyUrlBox />
          </div>
          <div className="shrink-0 px-4 pt-2 pb-[max(1rem,env(safe-area-inset-bottom))]">
            <Button variant="ghost" className="w-full" onClick={onSignOut} disabled={signingOut}>
              {signingOut ? 'Signing out…' : 'Sign Out'}
            </Button>
          </div>
        </DrawerContent>
      </Drawer>
    </>
  );
}
