import { Suspense, useEffect, useState, type ReactNode } from 'react';
import { Menu } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorBoundary } from '@/components/error-boundary';
import { SidebarContent } from '@/components/nav';
import type { ViewId } from '@/lib/routes';

/** Shown in the content region only while a view chunk loads; the navigation never shows a loading state. */
function ViewSkeleton() {
  return (
    <div className="space-y-4" aria-busy="true" aria-label="Loading page">
      <Skeleton className="h-7 w-48" />
      <div className="grid gap-4 sm:grid-cols-2">
        <Skeleton className="h-28" />
        <Skeleton className="h-28" />
        <Skeleton className="h-28" />
        <Skeleton className="h-28" />
      </div>
    </div>
  );
}

interface AppShellProps {
  view: ViewId;
  onSignOut: () => void;
  signingOut: boolean;
  children: ReactNode;
}

export function AppShell({ view, onSignOut, signingOut, children }: AppShellProps) {
  const [menuOpen, setMenuOpen] = useState(false);

  // Close the phone menu whenever the destination changes.
  useEffect(() => {
    setMenuOpen(false);
  }, [view]);

  return (
    <div className="min-h-dvh">
      {/* From 768px up: a permanent sidebar. Hidden with classes, so no JS media hook is needed. */}
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-64 border-r border-border-subtle bg-card md:block">
        <SidebarContent view={view} onSignOut={onSignOut} signingOut={signingOut} />
      </aside>

      {/* Below 768px: a top bar with an icon-only trigger for the slide-in menu. */}
      <header className="sticky top-0 z-30 flex items-center gap-2 border-b border-border-subtle bg-card px-2 py-1 md:hidden">
        <Sheet open={menuOpen} onOpenChange={setMenuOpen}>
          <SheetTrigger asChild>
            <Button variant="ghost" size="icon" aria-label="Open navigation">
              <Menu aria-hidden="true" />
            </Button>
          </SheetTrigger>
          <SheetContent side="left" className="w-72 gap-0 p-0" aria-describedby={undefined}>
            <SheetTitle className="sr-only">Navigation</SheetTitle>
            <SidebarContent
              view={view}
              onSignOut={onSignOut}
              signingOut={signingOut}
              onNavigate={() => setMenuOpen(false)}
            />
          </SheetContent>
        </Sheet>
        <span className="truncate text-sm font-semibold">AI Relay Gateway</span>
      </header>

      <div className="md:pl-64">
        <main id="view-root" className="mx-auto max-w-screen-xl p-4 md:p-8">
          <ErrorBoundary resetKey={view}>
            <Suspense fallback={<ViewSkeleton />}>{children}</Suspense>
          </ErrorBoundary>
        </main>
      </div>
    </div>
  );
}
