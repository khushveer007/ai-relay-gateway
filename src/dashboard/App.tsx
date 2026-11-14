import { lazy, Suspense, useSyncExternalStore } from 'react';
import { Toaster } from '@/components/ui/sonner';
import { AppShell } from '@/components/app-shell';
import { Login } from '@/components/login';
import { useView } from '@/hooks/use-hash-route';
import { useSession, useSignOut, useUnauthorizedHandler } from '@/hooks/use-session';
import { loginErrorMessage } from '@/lib/guards';
import { NAV_LABEL } from '@/lib/routes';

// One chunk per view file, so a tab left open across a deploy fails a chunk load (and recovers by
// reloading, FND-04) instead of holding every view in one bundle. No manual chunk config.
const OverviewView = lazy(() => import('./views/overview-page'));
const NextPhaseView = lazy(() => import('./views/next-phase'));

// Dev-only test page (D-10). Every reference to it, including the hash string, sits inside an
// import.meta.env.DEV expression, which Vite replaces with `false` in `vite build`, so the dynamic
// import and the string are dead code and never reach dist/ui. It is resolved before the session
// gate so it needs neither the Worker nor a sign-in; `npm run dev:ui` serves it.
const PlaygroundView = import.meta.env.DEV ? lazy(() => import('./views/__playground')) : null;

function subscribeToHash(onChange: () => void): () => void {
  window.addEventListener('hashchange', onChange);
  return () => window.removeEventListener('hashchange', onChange);
}

function playgroundRequested(): boolean {
  return import.meta.env.DEV && window.location.hash === '#/__playground';
}

function SessionApp() {
  useUnauthorizedHandler();
  const { state, probeFailed } = useSession();
  const view = useView();
  const signOut = useSignOut();

  let body;
  if (state === 'checking') {
    body = (
      <div className="flex min-h-dvh items-center justify-center text-sm text-muted-foreground">Loading…</div>
    );
  } else if (state === 'signed-out') {
    body = <Login initialError={probeFailed ? loginErrorMessage(0) : undefined} />;
  } else {
    body = (
      <AppShell view={view} onSignOut={() => signOut.mutate()} signingOut={signOut.isPending}>
        {view === 'overview' ? <OverviewView /> : <NextPhaseView title={NAV_LABEL[view]} />}
      </AppShell>
    );
  }

  return (
    <>
      {body}
      <Toaster />
    </>
  );
}

export default function App() {
  const showPlayground = useSyncExternalStore(subscribeToHash, playgroundRequested, () => false);
  if (import.meta.env.DEV && showPlayground && PlaygroundView) {
    return (
      <Suspense fallback={null}>
        <PlaygroundView />
      </Suspense>
    );
  }
  return <SessionApp />;
}
