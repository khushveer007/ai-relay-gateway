import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { api } from '@/lib/api';
import { sessionQuery } from '@/lib/queries';
import OverviewView from '@/views/overview-page';

// Bare sign-in form for the Walking Skeleton. Plan 01-03 replaces it with components/login.tsx.
function SignIn() {
  const queryClient = useQueryClient();
  const [password, setPassword] = useState('');
  const login = useMutation({
    mutationFn: () => api.post('/login', { password }),
    onSuccess: () => {
      queryClient.setQueryData(['session'], true);
    },
  });

  const onSubmit = (ev: FormEvent) => {
    ev.preventDefault();
    if (login.isPending) return;
    login.mutate();
  };

  return (
    <div className="flex min-h-dvh items-center justify-center p-4">
      <form onSubmit={onSubmit} className="flex w-full max-w-sm flex-col gap-4">
        <h1 className="text-xl font-semibold">AI Relay Gateway</h1>
        {login.isError && (
          <div role="alert" className="rounded-md bg-destructive/10 p-3 text-sm text-status-danger">
            {login.error.message}
          </div>
        )}
        <div className="flex flex-col gap-2">
          <label htmlFor="login-password" className="text-sm text-muted-foreground">
            Admin Password
          </label>
          <Input
            id="login-password"
            name="password"
            type="password"
            autoComplete="current-password"
            placeholder="Enter admin password"
            value={password}
            onChange={(ev) => setPassword(ev.target.value)}
            required
          />
        </div>
        <Button type="submit" disabled={login.isPending}>
          {login.isPending ? 'Signing in…' : 'Sign In'}
        </Button>
      </form>
    </div>
  );
}

export default function App() {
  const session = useQuery(sessionQuery);

  if (session.isPending) {
    return (
      <div className="flex min-h-dvh items-center justify-center text-sm text-muted-foreground">Loading…</div>
    );
  }
  if (session.isError || !session.data) return <SignIn />;
  return <OverviewView />;
}
