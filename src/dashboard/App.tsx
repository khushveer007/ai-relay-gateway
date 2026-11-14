import { Toaster } from '@/components/ui/sonner';
import { Login } from '@/components/login';
import { useSession, useUnauthorizedHandler } from '@/hooks/use-session';
import { loginErrorMessage } from '@/lib/guards';
import OverviewView from '@/views/overview-page';

export default function App() {
  useUnauthorizedHandler();
  const { state, probeFailed } = useSession();

  let body;
  if (state === 'checking') {
    body = (
      <div className="flex min-h-dvh items-center justify-center text-sm text-muted-foreground">Loading…</div>
    );
  } else if (state === 'signed-out') {
    body = <Login initialError={probeFailed ? loginErrorMessage(0) : undefined} />;
  } else {
    // The navigation shell arrives in plan 01-04.
    body = <OverviewView />;
  }

  return (
    <>
      {body}
      <Toaster />
    </>
  );
}
