import { Hono } from 'hono';
import { admin } from './admin/routes';
import { scheduled } from './cron';
import { detectFormat, errorResponse } from './proxy/formats';
import { handleModels, handleProxy } from './proxy/forward';
import type { Env } from './types';

const app = new Hono<{ Bindings: Env }>();

function safeExecutionCtx(c: { executionCtx: unknown }): ExecutionContext {
  try {
    return c.executionCtx as ExecutionContext;
  } catch {
    return { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
  }
}

app.onError((err, c) => {
  console.error('unhandled worker error', err);
  const path = c.req.path;
  if (path.startsWith('/v1/')) {
    return errorResponse(detectFormat(path), 500, 'Internal gateway error.', 'api_error');
  }
  return c.json({ error: String((err as Error)?.message ?? err) }, 500);
});

// CORS preflight for browser-based clients hitting the proxy API.
app.options('/v1/*', () =>
  new Response(null, {
    status: 204,
    headers: {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      'access-control-allow-headers': '*',
      'access-control-max-age': '86400',
    },
  }),
);

app.get('/v1/models', (c) => handleModels(c.req.raw, c.env, safeExecutionCtx(c)));
app.all('/v1/*', (c) => handleProxy(c.req.raw, c.env, safeExecutionCtx(c)));

// Admin JSON is never cached (T-02-24): a stale key status or provider list on a control panel is
// dangerous. `_headers` cannot reach Worker-generated responses (`run_worker_first` covers /api/*).
app.use('/api/admin/*', async (c, next) => {
  await next();
  c.res.headers.set('Cache-Control', 'no-store');
});

app.route('/api/admin', admin);
app.get('/api/health', (c) => c.json({ ok: true, ts: Date.now() }));
app.all('/api/*', (c) => c.json({ error: 'not found' }, 404));

// Everything else → dashboard (static assets, SPA fallback).
app.all('*', async (c) => {
  if (c.env.ASSETS) return c.env.ASSETS.fetch(c.req.raw);
  return c.text('Dashboard not built. Run `npm run build:ui`.', 404);
});

export default {
  fetch: app.fetch,
  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(scheduled(event, env));
  },
} satisfies ExportedHandler<Env>;
