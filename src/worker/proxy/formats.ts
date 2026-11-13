import type { Format } from '../types';

/** Detects the wire format from the request path. */
export function detectFormat(path: string): Format {
  if (path.startsWith('/v1/messages')) return 'anthropic';
  if (path.startsWith('/v1/responses')) return 'openai-responses';
  return 'openai-chat';
}

/**
 * Joins a provider base URL with the incoming path.
 * Accepts base URLs with or without a trailing `/v1`.
 */
export function buildUpstreamUrl(baseUrl: string, path: string, search = ''): string {
  let base = baseUrl.trim().replace(/\/+$/, '');
  if (/\/v1$/i.test(base) && path.startsWith('/v1/')) base = base.slice(0, -3);
  return `${base}${path}${search}`;
}

const DROP_REQUEST_HEADERS = new Set([
  'host',
  'authorization',
  'x-api-key',
  'api-key',
  'cookie',
  'content-length',
  'accept-encoding',
  'connection',
  'keep-alive',
  'transfer-encoding',
  'upgrade',
  'cdn-loop',
  'true-client-ip',
  'x-real-ip',
  'x-forwarded-for',
  'x-forwarded-proto',
  'x-forwarded-host',
]);

export function buildUpstreamHeaders(
  incoming: Headers,
  format: Format,
  apiKey: string,
  extra: Record<string, string> = {},
): Headers {
  const h = new Headers();
  incoming.forEach((value, name) => {
    const n = name.toLowerCase();
    if (DROP_REQUEST_HEADERS.has(n) || n.startsWith('cf-')) return;
    h.set(name, value);
  });
  h.set('authorization', `Bearer ${apiKey}`);
  if (format === 'anthropic') {
    h.set('x-api-key', apiKey);
    if (!h.has('anthropic-version')) h.set('anthropic-version', '2023-06-01');
  }
  if (!h.has('content-type')) h.set('content-type', 'application/json');
  for (const [k, v] of Object.entries(extra)) h.set(k, v);
  return h;
}

const DROP_RESPONSE_HEADERS = new Set([
  'content-length',
  'content-encoding',
  'transfer-encoding',
  'connection',
  'keep-alive',
  'set-cookie',
]);

export function buildClientHeaders(upstream: Headers, extra: Record<string, string>): Headers {
  const h = new Headers();
  upstream.forEach((value, name) => {
    const n = name.toLowerCase();
    if (DROP_RESPONSE_HEADERS.has(n) || n.startsWith('cf-')) return;
    h.set(name, value);
  });
  for (const [k, v] of Object.entries(extra)) h.set(k, v);
  return h;
}

/** Reads the gateway key from `Authorization: Bearer …` or `x-api-key`. */
export function extractClientToken(req: Request): string | null {
  const auth = req.headers.get('authorization');
  if (auth) {
    const m = auth.match(/^Bearer\s+(.+)$/i);
    if (m) return m[1].trim();
  }
  const x = req.headers.get('x-api-key') ?? req.headers.get('api-key');
  return x ? x.trim() : null;
}

const MODEL_RE = /"model"\s*:\s*"((?:[^"\\]|\\.)*)"/;

/**
 * Extracts the top-level model without JSON.parse. Claude Code bodies can exceed 1 MB, and parsing them would
 * eat into the 10 ms free-tier CPU budget. Clients serialize `model` before `messages`, so the first match wins.
 */
export function extractModel(body: string): string | null {
  const m = MODEL_RE.exec(body);
  if (!m) return null;
  try {
    return JSON.parse(`"${m[1]}"`) as string;
  } catch {
    return m[1];
  }
}

export function replaceModel(body: string, newModel: string): string {
  const m = MODEL_RE.exec(body);
  if (!m) return body;
  const replacement = `"model":${JSON.stringify(newModel)}`;
  return body.slice(0, m.index) + replacement + body.slice(m.index + m[0].length);
}

/** Error body in the client's own format so Claude Code / Codex display it nicely. */
export function errorResponse(
  format: Format,
  status: number,
  message: string,
  type: string,
  extraHeaders: Record<string, string> = {},
): Response {
  const body =
    format === 'anthropic'
      ? { type: 'error', error: { type, message } }
      : { error: { message, type, code: type } };
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...extraHeaders },
  });
}

/** Detects provider errors returned with a 2xx JSON body. */
export function looksLikeJsonError(text: string): boolean {
  const head = text.slice(0, 200);
  return /^\s*\{\s*"(error|type"\s*:\s*"error|success"\s*:\s*false)/.test(head) && !/"choices"|"content"\s*:\s*\[/.test(head);
}
