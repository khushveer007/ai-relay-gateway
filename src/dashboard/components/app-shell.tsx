import { Suspense, useEffect, useRef, type ReactNode } from 'react';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorBoundary } from '@/components/error-boundary';
import { BottomNav } from '@/components/bottom-nav';
import { SidebarContent } from '@/components/nav';
import { NAV_LABEL, type ViewId } from '@/lib/routes';

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
  const firstView = useRef(true);

  // The hash router keeps the scroll position across views, so every change starts at the top, and
  // focus moves to the main region (after the first mount) so a screen reader announces the new page.
  useEffect(() => {
    window.scrollTo(0, 0);
    if (firstView.current) {
      firstView.current = false;
      return;
    }
    document.getElementById('view-root')?.focus({ preventScroll: true });
  }, [view]);

  return (
    <div className="min-h-dvh">
      {/* From 768px up: a permanent sidebar. Hidden with classes, so no JS media hook is needed. */}
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-64 border-r border-border-subtle bg-card md:block">
        <SidebarContent view={view} onSignOut={onSignOut} signingOut={signingOut} />
      </aside>

      {/* Below 768px: a title-only top bar; navigation is the bottom bar (D-01, D-02). */}
      <header className="sticky top-0 z-30 border-b border-border-subtle bg-card px-4 py-3 md:hidden">
        <span className="block truncate text-sm font-semibold">{NAV_LABEL[view]}</span>
      </header>

      <div className="md:pl-64">
        <main
          id="view-root"
          tabIndex={-1}
          className="mx-auto max-w-screen-xl p-4 pb-[calc(3.5rem+env(safe-area-inset-bottom)+1rem)] outline-none md:p-8"
        >
          <ErrorBoundary resetKey={view}>
            <Suspense fallback={<ViewSkeleton />}>{children}</Suspense>
          </ErrorBoundary>
        </main>
      </div>

      <BottomNav view={view} onSignOut={onSignOut} signingOut={signingOut} />
    </div>
  );
}
