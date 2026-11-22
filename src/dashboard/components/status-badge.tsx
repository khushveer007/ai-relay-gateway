import { Badge } from '@/components/ui/badge';
import type { Action, KeyStatus } from '@/lib/api';
import { actionLabel, keyStatusLabel } from '@/lib/format';
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

/** Status pill for a provider key: Active, Paused, Out of balance, Dropped or Disabled. */
export function KeyStatusBadge({ status }: { status: KeyStatus }) {
  const tone = KEY_STATUS_TONE[status] ?? 'neutral';
  return (
    <Badge variant="outline" className={cn('border-transparent', TONE_CLASS[tone])}>
      {toneDot()}
      {keyStatusLabel(status)}
    </Badge>
  );
}

const ACTION_TONE: Record<string, Tone> = {
  OK: 'ok',
  RATE_LIMITED: 'warn',
  EXHAUSTED: 'danger',
  INVALID_KEY: 'danger',
};

/**
 * Outcome pill for an upstream attempt action. The tone is keyed by the raw code and the text is the
 * plain name. A long name wraps inside the pill (DROP-08, UI-SPEC E10).
 */
export function ActionBadge({ action, cooldownS }: { action: Action | 'OK' | string; cooldownS?: number | null }) {
  const tone = ACTION_TONE[action] ?? 'neutral';
  return (
    <Badge
      variant="outline"
      className={cn('h-auto whitespace-normal text-left border-transparent', TONE_CLASS[tone])}
    >
      {actionLabel(action, { cooldownS })}
    </Badge>
  );
}


/** Enabled or disabled pill for a provider or a gateway key: same outline Badge and tones as KeyStatusBadge. */
export function EnabledBadge({ enabled }: { enabled: boolean }) {
  return (
    <Badge variant="outline" className={cn('border-transparent', TONE_CLASS[enabled ? 'ok' : 'neutral'])}>
      {toneDot()}
      {enabled ? 'enabled' : 'disabled'}
    </Badge>
  );
}

/** HTTP status pill for a request or an attempt: 2xx ok, 3xx neutral, 4xx, 5xx and 0 danger. The text is the code. */
export function HttpStatusBadge({ status }: { status: number }) {
  const tone: Tone = status >= 200 && status < 300 ? 'ok' : status >= 300 && status < 400 ? 'neutral' : 'danger';
  return (
    <Badge variant="outline" className={cn('border-transparent', TONE_CLASS[tone])}>
      {toneDot()}
      {status}
    </Badge>
  );
}
