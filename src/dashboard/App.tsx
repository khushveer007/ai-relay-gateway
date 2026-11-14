import { lazy } from 'react';
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

export default function App() {
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
