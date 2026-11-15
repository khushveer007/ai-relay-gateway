// Pure guards and copy. DOM-free and import-free so Vitest and the Worker tsconfig can load them.

// Shared by the responsive components in plan 01-05: cards below this width, table at or above.
export const DESKTOP_MIN_WIDTH_PX = 768;
export const DESKTOP_QUERY = `(min-width: ${DESKTOP_MIN_WIDTH_PX}px)`;

export function isDesktopWidth(px: number): boolean {
  return px >= DESKTOP_MIN_WIDTH_PX;
}

/** Exact UI-SPEC copy for 401 and 429; anything else (including 0 for a network failure) is a connection error. */
export function loginErrorMessage(status: number): string {
  if (status === 401) return 'Incorrect password. Check your ADMIN_PASSWORD and try again.';
  if (status === 429) return 'Too many sign-in attempts. Wait 15 minutes and try again.';
  return 'Could not reach the gateway. Check your connection and try again.';
}

export function canSubmitPassword(pw: string): boolean {
  return pw.trim().length > 0;
}

/**
 * Loop guard for a stale hashed chunk: reload unless a reload already happened within `windowMs`.
 * A missing or unparsable stored value counts as "never reloaded".
 */
export function shouldReloadForPreloadError(nowMs: number, lastRaw: string | null, windowMs = 10_000): boolean {
  if (lastRaw === null) return true;
  const last = Number(lastRaw);
  if (!Number.isFinite(last)) return true;
  return nowMs - last >= windowMs;
}
