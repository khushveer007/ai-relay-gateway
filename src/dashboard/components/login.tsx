import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowLeftRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { api, ApiError } from '@/lib/api';
import { canSubmitPassword, loginErrorMessage } from '@/lib/guards';

// Server strings are only ever rendered as React text; nothing here injects raw HTML.
export function Login({ initialError }: { initialError?: string }) {
  const queryClient = useQueryClient();
  const inputRef = useRef<HTMLInputElement>(null);
  const [password, setPassword] = useState('');

  // retry: false so a 401 or a 429 never auto-retries against the brute-force limiter (T-01-23).
  const login = useMutation({
    retry: false,
    mutationFn: () => api.post('/login', { password }),
    onSuccess: () => {
      queryClient.setQueryData(['session'], true);
    },
  });

  // After a failed attempt the field re-enables; put the cursor back so the password can be corrected.
  useEffect(() => {
    if (login.isError) inputRef.current?.focus();
  }, [login.isError, login.failureCount]);

  const error = login.isError
    ? loginErrorMessage(login.error instanceof ApiError ? login.error.status : 0)
    : login.isIdle
      ? initialError
      : undefined;

  const canSubmit = canSubmitPassword(password) && !login.isPending;

  const onSubmit = (ev: FormEvent) => {
    ev.preventDefault();
    if (!canSubmit) return;
    login.mutate();
  };

  return (
    <div className="flex min-h-dvh items-center justify-center p-4">
      <Card className="w-full max-w-sm p-6">
        <form onSubmit={onSubmit} className="flex flex-col gap-4">
          <div className="flex items-center gap-3">
            <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-primary to-ring text-primary-foreground">
              <ArrowLeftRight className="size-5" aria-hidden="true" />
            </div>
            <div className="min-w-0">
              <h1 className="text-xl font-semibold">AI Relay Gateway</h1>
              <p className="text-sm text-muted-foreground">Multi-provider key rotation &amp; failover</p>
            </div>
          </div>

          {error && (
            <div role="alert" className="rounded-md bg-status-danger/10 p-3 text-sm text-status-danger">
              {error}
            </div>
          )}

          <div className="flex flex-col gap-2">
            <label htmlFor="login-password" className="text-xs font-semibold text-muted-foreground">
              Admin Password
            </label>
            <Input
              ref={inputRef}
              id="login-password"
              name="password"
              type="password"
              autoComplete="current-password"
              autoFocus
              placeholder="Enter admin password"
              className="text-base"
              value={password}
              disabled={login.isPending}
              onChange={(ev) => setPassword(ev.target.value)}
            />
          </div>

          <Button type="submit" size="lg" className="h-11 w-full" disabled={!canSubmit}>
            {login.isPending ? 'Signing in…' : 'Sign In'}
          </Button>
        </form>
      </Card>
    </div>
  );
}
