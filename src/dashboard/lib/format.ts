// Pure formatting helpers. DOM-free and import-free so Vitest and the Worker tsconfig can load them.

export function fmtNum(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '0';
  return n.toLocaleString();
}

export function fmtTokens(n: number | null | undefined): string {
  const v = Number(n ?? 0);
  if (!v) return '0';
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(1)}k`;
  return String(v);
}

export function fmtTokensOrDash(n: number | null | undefined): string {
  if (n === null || n === undefined) return '—';
  return fmtTokens(n);
}

export function fmtBalance(b: number | null | undefined): string {
  if (b === null || b === undefined || !Number.isFinite(b)) return '—';
  return `$${b.toFixed(b < 1 && b > 0 ? 4 : 2)}`;
}

export function fmtAgo(ts: number | null | undefined): string {
  if (!ts) return 'never';
  const diffS = Math.round((Date.now() - ts) / 1000);
  if (diffS < -5) {
    const remS = -diffS;
    if (remS < 60) return `in ${remS}s`;
    if (remS < 3600) return `in ${Math.round(remS / 60)}m`;
    return `in ${(remS / 3600).toFixed(1)}h`;
  }
  if (diffS < 5) return 'just now';
  if (diffS < 60) return `${diffS}s ago`;
  if (diffS < 3600) return `${Math.floor(diffS / 60)}m ago`;
  if (diffS < 86400) return `${Math.floor(diffS / 3600)}h ago`;
  return `${Math.floor(diffS / 86400)}d ago`;
}

export function fmtTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function fmtMs(v: number | null | undefined): string {
  if (!v) return '—';
  return `${v} ms`;
}

// RED stub: the real helper arrives in the GREEN commit.
export function actionLabel(_action: string): string {
  return '';
}
