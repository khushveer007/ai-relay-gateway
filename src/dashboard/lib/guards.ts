// RED-phase stubs: real implementations arrive in the GREEN commit.
export const DESKTOP_MIN_WIDTH_PX = 0;
export const DESKTOP_QUERY = '';
export function isDesktopWidth(_px: number): boolean {
  return false;
}
export function loginErrorMessage(_status: number): string {
  return '';
}
export function canSubmitPassword(_pw: string): boolean {
  return true;
}
export function shouldReloadForPreloadError(_nowMs: number, _lastRaw: string | null, _windowMs = 10_000): boolean {
  return false;
}
