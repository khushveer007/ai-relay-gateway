import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';

/** Shown when the page cannot render, typically after a deploy removed the chunk this tab needs. */
export function ReloadPanel() {
  return (
    <div className="flex min-h-dvh items-center justify-center p-4">
      <Card role="alert" className="w-full max-w-sm gap-4 p-6">
        <p className="text-sm">This page failed to load. Reload to get the latest version.</p>
        <Button className="h-11 w-full" onClick={() => window.location.reload()}>
          Reload
        </Button>
      </Card>
    </div>
  );
}

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
  /** When this value changes the boundary clears its error and tries to render the children again. */
  resetKey?: unknown;
}

interface State {
  hasError: boolean;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false };

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error('Dashboard render error', error, info.componentStack);
  }

  componentDidUpdate(prev: Props): void {
    if (this.state.hasError && prev.resetKey !== this.props.resetKey) {
      this.setState({ hasError: false });
    }
  }

  render(): ReactNode {
    if (this.state.hasError) return this.props.fallback ?? <ReloadPanel />;
    return this.props.children;
  }
}
