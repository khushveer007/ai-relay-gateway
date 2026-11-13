export type Format = 'anthropic' | 'openai-chat' | 'openai-responses';
export type Action = 'EXHAUSTED' | 'INVALID_KEY' | 'RATE_LIMITED' | 'UPSTREAM_ERROR' | 'CLIENT_ERROR';
export type KeyStatus = 'active' | 'exhausted' | 'rate_limited' | 'invalid' | 'disabled';

export interface ProviderKeyDTO {
  id: number;
  provider_id: number;
  alias: string;
  key_hint: string;
  priority: number;
  status: KeyStatus;
  status_reason: string | null;
  status_changed_at: number | null;
  cooldown_until: number | null;
  next_recheck_at: number | null;
  balance: number | null;
  balance_checked_at: number | null;
  created_at: number;
}

export interface ProviderDTO {
  id: number;
  name: string;
  base_url: string;
  formats: Format[];
  key_strategy: 'sequential' | 'round_robin';
  model_map: Record<string, string>;
  models: string[];
  models_fetched_at: number | null;
  model_allowlist: boolean;
  balance_mode: 'standard' | 'custom' | 'none';
  balance_path: string | null;
  balance_field: string | null;
  balance_divisor: number;
  recheck_mode: 'auto' | 'balance' | 'manual';
  recheck_hours: number;
  test_model: string | null;
  parse_usage: boolean;
  timeout_ms: number;
  extra_headers: Record<string, string>;
  enabled: boolean;
  created_at: number;
  keys: ProviderKeyDTO[];
  routes: string[];
}

export interface RouteDTO {
  id: number;
  name: string;
  model_patterns: string[];
  is_default: boolean;
  position: number;
  provider_ids: number[];
}

export interface ErrorRuleDTO {
  id: number;
  provider_id: number | null;
  priority: number;
  status_codes: string;
  body_regex: string | null;
  action: Action;
  cooldown_s: number | null;
  note: string | null;
  enabled: boolean;
}

export interface GatewayKeyDTO {
  id: number;
  name: string;
  key_prefix: string;
  route_id: number | null;
  enabled: boolean;
  created_at: number;
}

export interface SettingsDTO {
  log_retention_days: number;
  max_attempts: number;
  balance_refresh_hours: number;
  config_version: number;
}

export interface AttemptDTO {
  provider_id: number;
  provider: string;
  key_id: number;
  key: string;
  model: string;
  status: number;
  action: Action | 'OK';
  reason?: string;
  ms: number;
}

export interface LogRowDTO {
  id: number;
  ts: number;
  gateway_key_id: number | null;
  route_id: number | null;
  format: string;
  path: string;
  model: string | null;
  upstream_model: string | null;
  provider_id: number | null;
  key_id: number | null;
  status: number;
  stream: boolean;
  latency_ms: number;
  ttfb_ms: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_tokens: number | null;
  failovers: number;
  attempts: AttemptDTO[];
  error: string | null;
}

export interface StatsDTO {
  hours: number;
  bucket_ms: number;
  since: number;
  totals: {
    requests: number;
    ok: number;
    failovered: number;
    input_tokens: number;
    output_tokens: number;
    cache_tokens: number;
    avg_latency: number | null;
    avg_ttfb: number | null;
  };
  by_provider: Array<{
    provider_id: number;
    requests: number;
    ok: number;
    input_tokens: number;
    output_tokens: number;
    avg_ttfb: number | null;
  }>;
  by_key: Array<{
    key_id: number;
    requests: number;
    input_tokens: number;
    output_tokens: number;
    last_used: number | null;
  }>;
  by_model: Array<{
    model: string;
    requests: number;
    input_tokens: number;
    output_tokens: number;
  }>;
  series: Array<{
    bucket: number;
    requests: number;
    errors: number;
    failovers: number;
    output_tokens: number;
  }>;
  actions: Array<{ action: string; count: number }>;
  key_failures: Array<{ key_id: number; action: string; count: number }>;
}

let onUnauthorized: (() => void) | null = null;
export function setUnauthorizedHandler(fn: () => void): void {
  onUnauthorized = fn;
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const init: RequestInit = {
    method,
    credentials: 'same-origin',
  };
  if (method !== 'GET' && method !== 'HEAD') {
    init.headers = { 'content-type': 'application/json' };
    init.body = JSON.stringify(body ?? {});
  }
  const res = await fetch(`/api/admin${path}`, init);
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== '/login') {
    onUnauthorized?.();
    throw new Error(data.error || 'Session expired');
  }
  if (!res.ok) {
    throw new Error(data.error || `HTTP ${res.status}`);
  }
  return data as T;
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body),
  put: <T>(path: string, body?: unknown) => request<T>('PUT', path, body),
  del: <T>(path: string) => request<T>('DELETE', path, {}),
};

// ---------------- Formatting & UI helpers

export function esc(v: unknown): string {
  if (v === null || v === undefined) return '';
  return String(v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

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

export function statusPill(status: KeyStatus): string {
  const label = status.replace('_', ' ');
  return `<span class="pill pill-${esc(status)}"><span class="pill-dot"></span>${esc(label)}</span>`;
}

export function actionPill(action: Action | 'OK' | string): string {
  const cls =
    action === 'OK'
      ? 'pill-ok'
      : action === 'RATE_LIMITED'
        ? 'pill-warn'
        : action === 'EXHAUSTED' || action === 'INVALID_KEY'
          ? 'pill-danger'
          : 'pill-neutral';
  return `<span class="pill ${cls}">${esc(action)}</span>`;
}

export function copyButtonHtml(targetId: string, ariaLabel: string, labelText = 'Copy'): string {
  return `<span class="copy">
    <button type="button" class="copy-button" command="--copy" commandfor="${esc(targetId)}" aria-label="${esc(ariaLabel)}">
      <span aria-hidden="true">⧉</span> ${esc(labelText)}
    </button>
    <span class="tip" role="status"></span>
  </span>`;
}

export function toast(msg: string, kind: 'info' | 'ok' | 'error' = 'info'): void {
  const region = document.getElementById('toast-region');
  if (!region) return;
  const el = document.createElement('div');
  el.className = `toast ${kind === 'error' ? 'toast-error' : kind === 'ok' ? 'toast-ok' : ''}`;
  el.textContent = msg;
  region.appendChild(el);
  setTimeout(() => {
    el.remove();
  }, 3600);
}

// ---------------- Copy button & Dialog light-dismiss wiring per modern-web-guidance

const copyTimers = new WeakMap<Element, ReturnType<typeof setTimeout>>();
let lastCopyMessage = '';

function legacyCopy(text: string): boolean {
  const field = Object.assign(document.createElement('textarea'), { value: text });
  field.setAttribute('readonly', '');
  field.style.cssText = 'position:fixed;inset-block-start:0;opacity:0';
  document.body.append(field);
  field.select();
  try {
    return document.execCommand('copy');
  } finally {
    field.remove();
  }
}

function reportCopy(button: HTMLElement, ok: boolean): void {
  const tip = button.nextElementSibling as HTMLElement | null;
  const prev = copyTimers.get(button);
  if (prev) clearTimeout(prev);
  button.removeAttribute('data-copied');
  button.removeAttribute('data-failed');
  let message = ok ? 'Copied' : 'Copy failed';
  if (message === lastCopyMessage) message += '\u00A0';
  lastCopyMessage = message;
  if (tip) tip.textContent = '';
  void button.offsetWidth;
  button.setAttribute(ok ? 'data-copied' : 'data-failed', '');
  if (tip) requestAnimationFrame(() => (tip.textContent = message));
  copyTimers.set(
    button,
    setTimeout(() => {
      button.removeAttribute('data-copied');
      button.removeAttribute('data-failed');
      if (tip) tip.textContent = '';
    }, 2000),
  );
}

async function performCopy(button: HTMLElement, target: HTMLElement): Promise<void> {
  const text =
    target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement
      ? target.value
      : (target.innerText || target.textContent || '').trim();
  if (!text) return;
  try {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      if (!legacyCopy(text)) throw new Error('Copy failed');
    }
    reportCopy(button, true);
  } catch {
    reportCopy(button, false);
  }
}

export function initGlobalInteractions(): void {
  if ('CommandEvent' in window) {
    document.addEventListener(
      'command',
      (event: any) => {
        if (typeof event.command === 'string' && event.command.startsWith('--copy')) {
          performCopy(event.source as HTMLElement, event.target as HTMLElement);
        }
      },
      true,
    );
  } else {
    document.addEventListener('click', (event) => {
      const targetEl = event.target as HTMLElement | null;
      const button = targetEl?.closest('button[command^="--copy"]') as HTMLElement | null;
      if (!button) return;
      const id = button.getAttribute('commandfor');
      const target = id ? document.getElementById(id) : null;
      if (target) performCopy(button, target);
    });
  }
}

export function openModal(dialog: HTMLDialogElement): void {
  if (!('closedBy' in HTMLDialogElement.prototype) && dialog.getAttribute('closedby') === 'any' && !(dialog as any)._lightDismissBound) {
    (dialog as any)._lightDismissBound = true;
    const outside = (e: PointerEvent) => {
      const r = dialog.getBoundingClientRect();
      return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
    };
    let pressedOutside = false;
    dialog.addEventListener('pointerdown', (e) => {
      pressedOutside = outside(e);
    });
    dialog.addEventListener('pointerup', (e) => {
      if (pressedOutside && outside(e)) dialog.close();
    });
  }
  dialog.showModal();
}
