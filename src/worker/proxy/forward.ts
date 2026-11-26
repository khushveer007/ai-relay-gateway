import { getConfig, plainKey } from '../db/cache';
import { sha256Hex } from '../db/crypto';
import { classify, type Classification } from '../routing/error-rules';
import { ACTIVE_PATCH, applyKeyPatch, patchForAction } from '../routing/key-state';
import { mapModel, supportsModel } from '../routing/model-map';
import { resolveRoute } from '../routing/resolve-route';
import { isUsable, orderKeys } from '../routing/select-key';
import type { Attempt, Config, Env, Format, GatewayKey, Provider } from '../types';
import { resolvePrice, type PriceIndex, type PriceResolution } from '../../shared/pricing';
import {
  buildClientHeaders,
  buildUpstreamHeaders,
  buildUpstreamUrl,
  detectFormat,
  errorResponse,
  extractClientTokens,
  extractModel,
  extractModelBytes,
  looksLikeJsonError,
  replaceModel,
  replaceModelBytes,
  type ModelByteSpan,
} from './formats';
import { newLog, writeLog, type LogEntry } from './logs';
import { peekStream, type PeekResult } from './stream-peek';
import { UsageTap, type Usage } from './usage';

/** Workers free plan allows 50 subrequests per invocation; keep headroom for D1 calls. */
const HARD_ATTEMPT_CAP = 40;

/** Bodies larger than 16 KB stay as raw UTF-8 Uint8Arrays to avoid multi-MB UTF-16 string decode/re-encode CPU spikes. */
const SMALL_BODY_BYTES = 16_384;
const bodyDecoder = new TextDecoder();

interface Failure {
  status: number;
  text: string;
  headers: Headers | null;
  cls: Classification;
}

async function authenticate(
  req: Request,
  env: Env,
  format: Format,
  ctx?: ExecutionContext,
): Promise<{ config: Config; gk: GatewayKey } | Response> {
  let tokens: string[];
  try {
    tokens = extractClientTokens(req);
  } catch {
    tokens = [];
  }
  if (tokens.length === 0) {
    return errorResponse(format, 401, 'Missing gateway key. Send it as "Authorization: Bearer sk-gw-…" or "x-api-key".', 'authentication_error');
  }
  let config: Config;
  try {
    config = await getConfig(env, ctx);
  } catch (err) {
    console.error('config load failed in authenticate', err);
    return errorResponse(format, 503, 'Gateway configuration database is temporarily unavailable.', 'api_error');
  }
  for (const token of tokens) {
    try {
      const gk = config.gatewayKeysByHash.get(await sha256Hex(token));
      if (gk && gk.enabled) return { config, gk };
    } catch {
      /* ignore malformed token candidate */
    }
  }
  return errorResponse(format, 401, 'Invalid or disabled gateway key.', 'authentication_error');
}

export async function handleProxy(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const started = Date.now();
  const url = new URL(req.url);
  const path = url.pathname;
  const format = detectFormat(path);
  const log = newLog(path, format);

  const auth = await authenticate(req, env, format, ctx);
  if (auth instanceof Response) return auth;
  const { config, gk } = auth;
  log.gateway_key_id = gk.id;

  const finishWithError = (res: Response, error: string): Response => {
    log.status = res.status;
    log.error = error;
    log.latency_ms = Date.now() - started;
    ctx.waitUntil(writeLog(env, log));
    return res;
  };

  const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
  let rawBytes: Uint8Array | null = null;
  let bodyText = '';
  let model: string | null = null;
  let modelSpan: ModelByteSpan | null = null;

  if (hasBody) {
    try {
      rawBytes = new Uint8Array(await req.arrayBuffer());
    } catch {
      return finishWithError(errorResponse(format, 400, 'Could not read request body.', 'invalid_request_error'), 'unreadable request body');
    }
    if (rawBytes.byteLength <= SMALL_BODY_BYTES) {
      bodyText = bodyDecoder.decode(rawBytes);
      model = extractModel(bodyText);
    } else {
      const extracted = extractModelBytes(rawBytes);
      model = extracted.model;
      modelSpan = extracted.span;
    }
  }
  log.model = model;

  const route = resolveRoute(config, gk, model);
  if (!route) {
    return finishWithError(errorResponse(format, 503, 'No route configured. Create a default route in the dashboard.', 'api_error'), 'no route');
  }
  log.route_id = route.id;

  const candidates = route.provider_ids
    .map((id) => config.providers.get(id))
    .filter((p): p is Provider => !!p && p.enabled && p.formats.includes(format) && supportsModel(p, model));

  if (candidates.length === 0) {
    const msg = `No enabled provider on route "${route.name}" supports format "${format}"${model ? ` and model "${model}"` : ''}.`;
    return finishWithError(errorResponse(format, 503, msg, 'api_error'), msg);
  }

  const maxAttempts = Math.min(Math.max(1, config.settings.max_attempts || 10), HARD_ATTEMPT_CAP);
  const attempts: Attempt[] = [];
  log.attempts = attempts;
  let lastFailure: Failure | null = null;

  providers: for (const provider of candidates) {
    const keys = orderKeys(provider, config.keysByProvider.get(provider.id) ?? []);
    if (keys.length === 0) continue;

    // Compute mapped model and rewritten payload once per provider, not on every key rotation attempt.
    const upstreamModel = model ? mapModel(provider, model) : null;
    const rewriteModel = !!(upstreamModel && upstreamModel !== model);
    const upstreamBody: BodyInit | undefined = !hasBody
      ? undefined
      : rawBytes && rawBytes.byteLength > SMALL_BODY_BYTES
        ? rewriteModel
          ? (replaceModelBytes(rawBytes, modelSpan, upstreamModel!) as unknown as BodyInit)
          : (rawBytes as unknown as BodyInit)
        : rewriteModel
          ? replaceModel(bodyText, upstreamModel!)
          : bodyText;

    for (const key of keys) {
      if (attempts.length >= maxAttempts) break providers;
      if (!isUsable(key)) continue; // may have been disabled by a concurrent request in this isolate

      const attempt: Attempt = {
        provider_id: provider.id,
        provider: provider.name,
        key_id: key.id,
        key: key.alias || key.key_hint,
        model: upstreamModel ?? model ?? '',
        status: 0,
        action: 'OK',
        ms: 0,
      };
      attempts.push(attempt);
      const t0 = Date.now();

      let apiKey: string;
      try {
        apiKey = await plainKey(env, key);
      } catch {
        const reason = 'cannot decrypt key (ENCRYPTION_KEY changed?)';
        attempt.action = 'INVALID_KEY';
        attempt.reason = reason;
        lastFailure = {
          status: 0,
          text: reason,
          headers: null,
          cls: { action: 'INVALID_KEY', ruleId: null, cooldownS: null, reason },
        };
        continue;
      }

      const timeoutMs = provider.timeout_ms > 0 ? provider.timeout_ms : 60_000;
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(new Error('timeout')), timeoutMs);
      let failure: Failure | null = null;
      let success: Response | null = null;

      try {
        const res = await fetch(buildUpstreamUrl(provider.base_url, path, url.search), {
          method: req.method,
          headers: buildUpstreamHeaders(req.headers, format, apiKey, provider.extra_headers),
          body: upstreamBody,
          signal: ac.signal,
        });
        attempt.status = res.status;
        const ct = res.headers.get('content-type') ?? '';

        if (!res.ok) {
          clearTimeout(timer);
          const text = await res.text().catch(() => '');
          failure = {
            status: res.status,
            text,
            headers: res.headers,
            cls: classify(config.rules, provider.id, res.status, text, res.headers.get('retry-after')),
          };
        } else if (ct.includes('text/event-stream') && res.body) {
          // Timer keeps running until the first event arrives, so a stalled relay still fails over.
          const peek = await peekStream(res.body);
          clearTimeout(timer);
          if (peek.kind === 'error') {
            peek.reader.cancel().catch(() => {});
            failure = { status: 200, text: peek.headText, headers: res.headers, cls: classify(config.rules, provider.id, 200, peek.headText) };
          } else {
            log.ttfb_ms = Date.now() - started;
            const resolution = resolvePrice(config.prices, upstreamModel);
            success = streamToClient(peek, res, provider, attempt, log, env, ctx, started, config.prices, resolution);
          }
        } else {
          clearTimeout(timer);
          const text = await res.text();
          if (looksLikeJsonError(text)) {
            failure = { status: 200, text, headers: res.headers, cls: classify(config.rules, provider.id, 200, text) };
          } else {
            if (provider.parse_usage) {
              const tap = new UsageTap(format);
              tap.readBody(text);
              applyUsage(log, tap.usage);
            }
            log.ttfb_ms = Date.now() - started;
            success = new Response(text, { status: res.status, headers: gatewayHeaders(res.headers, provider, attempts) });
          }
        }
      } catch (e) {
        clearTimeout(timer);
        const msg = ac.signal.aborted ? `timeout after ${provider.timeout_ms} ms` : `network error: ${(e as Error).message}`;
        failure = { status: 0, text: msg, headers: null, cls: classify(config.rules, provider.id, 0, msg) };
      }

      attempt.ms = Date.now() - t0;

      if (success) {
        log.provider_id = provider.id;
        log.key_id = key.id;
        log.upstream_model = upstreamModel;
        if (!log.stream) {
          log.status = success.status;
          log.latency_ms = Date.now() - started;
          const prices = config.prices;
          const resolution = resolvePrice(prices, upstreamModel);
          ctx.waitUntil(Promise.resolve().then(() => writeLog(env, log, prices, resolution)));
        }
        if (key.status !== 'active') {
          ctx.waitUntil(applyKeyPatch(env, key, ACTIVE_PATCH).catch((error) => console.error('key state write failed', error)));
        }
        return success;
      }

      // ---- failure handling
      const f = failure!;
      attempt.action = f.cls.action;
      attempt.reason = f.cls.reason;
      lastFailure = f;

      switch (f.cls.action) {
        case 'CLIENT_ERROR': {
          // The request itself is bad; another key or provider won't help. Return the upstream error unchanged.
          log.provider_id = provider.id;
          log.key_id = key.id;
          log.upstream_model = upstreamModel;
          const res = new Response(f.text, {
            status: f.status || 400,
            headers: f.headers ? gatewayHeaders(f.headers, provider, attempts) : { 'content-type': 'application/json' },
          });
          return finishWithError(res, f.cls.reason);
        }
        case 'EXHAUSTED':
        case 'INVALID_KEY':
        case 'RATE_LIMITED': {
          const patch = patchForAction(provider, f.cls.action, f.cls.reason, f.cls.cooldownS, f.status);
          if (patch) {
            ctx.waitUntil(applyKeyPatch(env, key, patch).catch((error) => console.error('key state write failed', error)));
          }
          continue; // next key of the same provider
        }
        case 'UPSTREAM_ERROR':
        default:
          continue providers; // relay itself is unhealthy → next provider, key not penalized
      }
    }
  }

  // ---- everything failed
  const summary = attempts.length
    ? attempts.map((a) => `${a.provider}/${a.key}: ${a.action}`).join(', ')
    : 'no usable keys (all exhausted, invalid, disabled or cooling down)';
  const actions = new Set(attempts.map((a) => a.action));
  let status = 502;
  let type = 'api_error';
  if (attempts.length === 0 || [...actions].every((a) => a === 'EXHAUSTED' || a === 'INVALID_KEY')) {
    status = 402;
    type = 'billing_error';
  } else if ([...actions].every((a) => a === 'RATE_LIMITED' || a === 'EXHAUSTED' || a === 'INVALID_KEY')) {
    status = 429;
    type = 'rate_limit_error';
  }
  const last = lastFailure ? ` Last error: ${lastFailure.cls.reason}` : '';
  const msg = `[gateway] All providers on route "${route.name}" failed (${summary}).${last}`;
  return finishWithError(errorResponse(format, status, msg, type, { 'x-gateway-attempts': String(attempts.length) }), msg);
}

function gatewayHeaders(upstream: Headers, provider: Provider, attempts: Attempt[]): Headers {
  return buildClientHeaders(upstream, {
    'x-gateway-provider': provider.name,
    'x-gateway-attempts': String(attempts.length),
  });
}

function applyUsage(log: LogEntry, u: Usage | null): void {
  if (!u) return;
  log.input_tokens = u.input;
  log.output_tokens = u.output;
  log.cache_tokens = u.cache;
  log.cache_write_tokens = u.cacheWrite;
}

/**
 * Re-emits the peeked head, then pipes the rest of the upstream stream chunk-by-chunk (pull-based, so client
 * backpressure is respected). Usage is tapped along the way and the log row is written when the stream ends.
 */
function streamToClient(
  peek: PeekResult,
  res: Response,
  provider: Provider,
  attempt: Attempt,
  log: LogEntry,
  env: Env,
  ctx: ExecutionContext,
  started: number,
  prices: PriceIndex,
  resolution: PriceResolution,
): Response {
  const tap = provider.parse_usage ? new UsageTap(log.format) : null;
  const reader = peek.reader;
  log.stream = true;
  log.status = res.status;

  let resolveDone!: () => void;
  const done = new Promise<void>((r) => (resolveDone = r));
  ctx.waitUntil(done.then(() => writeLog(env, log, prices, resolution, tap?.hasFinalUsage === true)));

  let finished = false;
  const finish = (error?: string) => {
    if (finished) return;
    finished = true;
    applyUsage(log, tap?.usage ?? null);
    log.latency_ms = Date.now() - started;
    if (error) log.error = error;
    resolveDone();
  };

  const headers = buildClientHeaders(res.headers, {
    'x-gateway-provider': provider.name,
    'x-gateway-attempts': String(log.attempts.length),
    'cache-control': 'no-cache',
  });

  if (peek.done) {
    tap?.feed(peek.head);
    finish();
    return new Response(peek.head as unknown as BodyInit, { status: res.status, headers });
  }

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      tap.feed(peek.head);
      if (peek.head.length > 0) controller.enqueue(peek.head);
    },
    async pull(controller) {
      try {
        const r = await reader.read();
        if (r.done) {
          controller.close();
          finish();
          return;
        }
        tap?.feed(r.value);
        controller.enqueue(r.value);
      } catch (e) {
        controller.error(e);
        finish(`stream interrupted: ${(e as Error).message}`);
      }
    },
    cancel(reason) {
      reader.cancel(reason).catch(() => {});
      finish('client disconnected');
    },
  });

  return new Response(stream, { status: res.status, headers });
}

/** GET /v1/models: merged model list of the providers reachable with this gateway key. */
export async function handleModels(req: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
  const format = detectFormat(new URL(req.url).pathname);
  const auth = await authenticate(req, env, format, ctx);
  if (auth instanceof Response) return auth;
  const { config, gk } = auth;

  const routes = gk.route_id !== null ? config.routes.filter((r) => r.id === gk.route_id) : config.routes;
  const seen = new Map<string, string>();
  for (const route of routes) {
    for (const pid of route.provider_ids) {
      const p = config.providers.get(pid);
      if (!p || !p.enabled) continue;
      const names = [...Object.keys(p.model_map).filter((k) => !/[*?]/.test(k)), ...p.models];
      for (const m of names) if (!seen.has(m)) seen.set(m, p.name);
    }
  }
  const data = [...seen.entries()].map(([id, owner]) => ({
    id,
    object: 'model',
    type: 'model',
    display_name: id,
    created: 0,
    created_at: '1970-01-01T00:00:00Z',
    owned_by: owner,
  }));
  return Response.json({
    object: 'list',
    data,
    has_more: false,
    first_id: data[0]?.id ?? null,
    last_id: data[data.length - 1]?.id ?? null,
  });
}
