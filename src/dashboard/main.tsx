import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import './styles/globals.css';
import App from './App';
import { ErrorBoundary } from './components/error-boundary';
import { shouldReloadForPreloadError } from './lib/guards';

// FND-04: after a deploy the hashed chunks this tab knows about no longer exist, so a lazy
// import fails and Vite fires `vite:preloadError`. Reload once to pick up the new build.
// The 10 s window (not a boolean flag) lets a later deploy in the same tab reload again while a
// chunk that stays broken cannot cause a reload loop. The event is not cancelled, so the original
// error still reaches the ErrorBoundary, which shows the Reload panel.
const PRELOAD_RELOAD_KEY = 'gw.preload-reload-at';
window.addEventListener('vite:preloadError', () => {
  try {
    const raw = sessionStorage.getItem(PRELOAD_RELOAD_KEY);
    const now = Date.now();
    if (!shouldReloadForPreloadError(now, raw)) return;
    sessionStorage.setItem(PRELOAD_RELOAD_KEY, String(now));
    window.location.reload();
  } catch {
    // Storage unavailable: the loop guard cannot work, so do not reload. The boundary's
    // Reload button is what the user sees instead.
  }
});

// D-06: refetch on focus, no polling. 15 s staleTime is a D1-read guard, not a polling interval.
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: true,
      staleTime: 15_000,
    },
  },
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    </ErrorBoundary>
  </StrictMode>,
);
