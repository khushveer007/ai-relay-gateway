import { Badge } from '@/components/ui/badge';
import type { Action, KeyStatus } from '@/lib/api';
import { cn } from '@/lib/utils';

type Tone = 'ok' | 'warn' | 'danger' | 'neutral';

const TONE_CLASS: Record<Tone, string> = {
  ok: 'bg-status-ok/15 text-status-ok',
  warn: 'bg-status-warn/15 text-status-warn',
  danger: 'bg-status-danger/15 text-status-danger',
  neutral: 'bg-status-neutral/15 text-status-neutral',
};

function toneDot() {
  return <span aria-hidden="true" className="size-1.5 rounded-full bg-current" />;
}

const KEY_STATUS_TONE: Record<KeyStatus, Tone> = {
  active: 'ok',
  rate_limited: 'warn',
  exhausted: 'danger',
  invalid: 'danger',
  disabled: 'neutral',
};

/** Status pill for a provider key: active/rate_limited/exhausted/invalid/disabled. */
export function KeyStatusBadge({ status }: { status: KeyStatus }) {
  const tone = KEY_STATUS_TONE[status] ?? 'neutral';
  return (
    <Badge variant="outline" className={cn('border-transparent', TONE_CLASS[tone])}>
      {toneDot()}
      {status.replace('_', ' ')}
    </Badge>
  );
}

const ACTION_TONE: Record<string, Tone> = {
  OK: 'ok',
  RATE_LIMITED: 'warn',
  EXHAUSTED: 'danger',
  INVALID_KEY: 'danger',
};

/** Outcome pill for an upstream attempt action: OK, RATE_LIMITED, EXHAUSTED, INVALID_KEY, etc. */
export function ActionBadge({ action }: { action: Action | 'OK' | string }) {
  const tone = ACTION_TONE[action] ?? 'neutral';
  return <Badge variant="outline" className={cn('border-transparent', TONE_CLASS[tone])}>{action}</Badge>;
}
