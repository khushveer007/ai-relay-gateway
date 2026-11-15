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

function sanitizeHeaderValue(value: string): string {
  // Fetch Headers require ByteString (0x00..0xff) without CR/LF/NUL.
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code > 0xff || code === 0 || code === 10 || code === 13) {
      return value.replace(/[\x00\r\n]|[^\x00-\xff]/g, '?');
    }
  }
  return value;
}

export function buildClientHeaders(upstream: Headers, extra: Record<string, string>): Headers {
  const h = new Headers();
  upstream.forEach((value, name) => {
    const n = name.toLowerCase();
    if (DROP_RESPONSE_HEADERS.has(n) || n.startsWith('cf-')) return;
    h.set(name, value);
  });
  for (const [k, v] of Object.entries(extra)) h.set(k, sanitizeHeaderValue(v));
  return h;
}

/** Reads all candidate gateway tokens from `Authorization: Bearer …`, `x-api-key`, and `api-key`. */
export function extractClientTokens(req: Request): string[] {
  const candidates: string[] = [];
  const push = (raw: string | null | undefined) => {
    if (!raw) return;
    const t = raw.trim();
    if (t && t.length <= 512 && !candidates.includes(t)) candidates.push(t);
  };

  const auth = req.headers.get('authorization');
  if (auth) {
    const m = /^Bearer\s+(.+)$/i.exec(auth);
    if (m) push(m[1]);
  }
  push(req.headers.get('x-api-key'));
  push(req.headers.get('api-key'));

  // If both Bearer and x-api-key were supplied and one has the `sk-gw-` prefix, try it first.
  if (candidates.length > 1) {
    candidates.sort((a, b) => (b.startsWith('sk-gw-') ? 1 : 0) - (a.startsWith('sk-gw-') ? 1 : 0));
  }
  return candidates;
}

/** Reads the primary gateway key from `Authorization: Bearer …` or `x-api-key`. */
export function extractClientToken(req: Request): string | null {
  return extractClientTokens(req)[0] ?? null;
}

const MODEL_RE = /"model"\s*:\s*"((?:[^"\\]|\\.)*)"/;
const MODEL_HEAD_RE = /^"model"\s*:\s*"((?:[^"\\]|\\.)*)"/;
const utf8Enc = new TextEncoder();
const utf8Dec = new TextDecoder();

export interface ModelByteSpan {
  start: number;
  end: number;
}

function parseModelMatch(raw: string): string {
  if (raw.indexOf('\\') === -1) return raw;
  try {
    return JSON.parse(`"${raw}"`) as string;
  } catch {
    return raw;
  }
}

/**
 * Extracts the top-level model without JSON.parse. Claude Code bodies can exceed 1 MB, and parsing them would
 * eat into the 10 ms free-tier CPU budget. Clients serialize `model` before `messages`, so the first match wins.
 */
export function extractModel(body: string): string | null {
  if (body.length > 4096) {
    const headMatch = MODEL_RE.exec(body.slice(0, 4096));
    if (headMatch) return parseModelMatch(headMatch[1]);
  }
  const m = MODEL_RE.exec(body);
  if (!m) return null;
  return parseModelMatch(m[1]);
}

export function replaceModel(body: string, newModel: string): string {
  const m = body.length > 4096 ? MODEL_RE.exec(body.slice(0, 4096)) ?? MODEL_RE.exec(body) : MODEL_RE.exec(body);
  if (!m) return body;
  const replacement = `"model":${JSON.stringify(newModel)}`;
  return body.slice(0, m.index) + replacement + body.slice(m.index + m[0].length);
}

function isEscapedQuote(buf: Uint8Array, quoteIdx: number): boolean {
  let slashes = 0;
  for (let j = quoteIdx - 1; j >= 0 && buf[j] === 92; j--) slashes++;
  return (slashes & 1) === 1;
}

function findModelKeyBytes(buf: Uint8Array, fromIndex: number, toIndex: number): number {
  const limit = Math.min(buf.length, toIndex);
  const view = limit < buf.length ? buf.subarray(0, limit) : buf;
  const end = limit - 6;
  let i = Math.max(1, fromIndex);
  while (i < end) {
    i = view.indexOf(109, i); // 'm'
    if (i === -1 || i >= end) return -1;
    if (
      buf[i - 1] === 34 && // '"'
      buf[i + 1] === 111 && // 'o'
      buf[i + 2] === 100 && // 'd'
      buf[i + 3] === 101 && // 'e'
      buf[i + 4] === 108 && // 'l'
      buf[i + 5] === 34 && // '"'
      !isEscapedQuote(buf, i - 1)
    ) {
      return i - 1;
    }
    i++;
  }
  return -1;
}

function matchModelAtRange(
  buf: Uint8Array,
  startOffset: number,
  endOffset: number,
): { model: string; span: ModelByteSpan } | null {
  let pos = startOffset;
  while (pos < endOffset) {
    const idx = findModelKeyBytes(buf, pos, endOffset);
    if (idx === -1) return null;
    const windowText = utf8Dec.decode(buf.subarray(idx, Math.min(buf.length, idx + 512)));
    const m = MODEL_HEAD_RE.exec(windowText);
    if (m) {
      const model = parseModelMatch(m[1]);
      const byteLen = utf8Enc.encode(m[0]).byteLength;
      return { model, span: { start: idx, end: idx + byteLen } };
    }
    pos = idx + 7;
  }
  return null;
}

/**
 * Extracts the `model` field and its exact UTF-8 byte span directly from a raw request buffer without
 * decoding multi-megabyte request bodies into UTF-16 JavaScript strings.
 */
export function extractModelBytes(buf: Uint8Array): { model: string | null; span: ModelByteSpan | null } {
  if (buf.length === 0) return { model: null, span: null };
  // 1. Fast path: first 16 KB (covers model-first and system-before-model requests).
  const headEnd = Math.min(buf.length, 16_384);
  const headHit = matchModelAtRange(buf, 0, headEnd);
  if (headHit) return headHit;
  if (buf.length <= 16_384) return { model: null, span: null };
  // 2. Tail fast path: last 4 KB (covers sorted-key / model-last requests without scanning multi-MB messages).
  const tailStart = Math.max(headEnd - 7, buf.length - 4096);
  const tailHit = matchModelAtRange(buf, tailStart, buf.length);
  if (tailHit) return tailHit;
  // 3. Fallback: scan remaining middle range if neither head nor tail contained the field.
  if (tailStart <= headEnd - 7) return { model: null, span: null };
  const midHit = matchModelAtRange(buf, headEnd - 7, Math.min(buf.length, tailStart + 7));
  return midHit ?? { model: null, span: null };
}

/** Splices a new model name directly into a UTF-8 request buffer at the pre-located byte span. */
export function replaceModelBytes(buf: Uint8Array, span: ModelByteSpan | null, newModel: string): Uint8Array {
  if (!span) return buf;
  const rep = utf8Enc.encode(`"model":${JSON.stringify(newModel)}`);
  const out = new Uint8Array(buf.length - (span.end - span.start) + rep.length);
  out.set(buf.subarray(0, span.start), 0);
  out.set(rep, span.start);
  out.set(buf.subarray(span.end), span.start + rep.length);
  return out;
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
