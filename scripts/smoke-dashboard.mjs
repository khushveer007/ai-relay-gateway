#!/usr/bin/env node
// End-to-end smoke check for the rebuilt dashboard, run against `wrangler dev` on 127.0.0.1:8787.
//
//   node scripts/smoke-dashboard.mjs                  checks 1-10 and 17-18 (provider round trip)
//   node scripts/smoke-dashboard.mjs --check-headers  also checks 11-16 (cache headers on built assets, security
//                                                     headers, manifest and icons, no Google font host, no-store)
//   node scripts/smoke-dashboard.mjs --check-mobile   also audit every page and main dialog at 360x800 in
//                                                     headless Chromium: no sideways scroll, 44px targets,
//                                                     16px inputs, no overlapping targets (empty and seeded data)
//   node scripts/smoke-dashboard.mjs --skip-render    skip check 10 (no Chrome on this machine)
//
// Env: CHROME_BIN optionally points at a Chrome or Chromium binary for check 10.
//      SMOKE_ALLOW_REUSE=1 lets the script use a Worker that is already running on the port. Without it the
//      script refuses, because it creates and deletes data and that Worker may not be a disposable local one.
// The script only ever talks to 127.0.0.1:8787 and never deploys anything.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const BASE = 'http://127.0.0.1:8787';
const DEV_VARS_PATH = new URL('../.dev.vars', import.meta.url);
const CHECK_HEADERS = process.argv.includes('--check-headers');
const CHECK_MOBILE = process.argv.includes('--check-mobile');
const SKIP_RENDER = process.argv.includes('--skip-render');

let failures = 0;
let passes = 0;
let child = null;

function report(ok, label, detail = '') {
  if (ok) passes += 1;
  else failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ` - ${detail}` : ''}`);
}

function info(label, detail = '') {
  console.log(`INFO ${label}${detail ? ` - ${detail}` : ''}`);
}

function stopChild() {
  if (!child || child.killed) return;
  try {
    // The child leads its own process group so workerd dies with `npx wrangler`.
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    try {
      child.kill('SIGTERM');
    } catch {
      /* already gone */
    }
  }
  child = null;
}

process.on('exit', stopChild);
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => {
    stopChild();
    process.exit(130);
  });
}

function readDevVars() {
  if (!existsSync(DEV_VARS_PATH)) {
    console.error('FAIL .dev.vars not found at the repo root. Copy .dev.vars.example to .dev.vars first.');
    process.exit(1);
  }
  const vars = {};
  for (const raw of readFileSync(DEV_VARS_PATH, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    vars[key] = value;
  }
  // Key names only, never values.
  console.log(`.dev.vars keys: ${Object.keys(vars).join(', ') || '(none)'}`);
  if (!vars.ADMIN_PASSWORD) {
    console.error('FAIL ADMIN_PASSWORD is missing from .dev.vars.');
    process.exit(1);
  }
  return vars;
}

async function healthy() {
  try {
    const res = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

async function ensureServer() {
  if (await healthy()) {
    // The provider round trip always creates and deletes rows, and --check-mobile seeds and sweeps `audit-*`
    // ones. A Worker this script did not start could be `wrangler dev --remote` on the production D1 (T-02-31),
    // so reusing one needs an explicit opt-in.
    if (process.env.SMOKE_ALLOW_REUSE !== '1') {
      console.error(`FAIL a Worker is already answering at ${BASE}. This script creates and deletes data through its admin API.`);
      console.error('     Stop it so the script starts a local one, or set SMOKE_ALLOW_REUSE=1 if it is a local, disposable Worker.');
      process.exit(1);
    }
    console.log(`Using the Worker already running at ${BASE} (SMOKE_ALLOW_REUSE=1)`);
    return;
  }
  console.log('No Worker on 127.0.0.1:8787, applying local migrations and starting wrangler dev...');
  const mig = spawnSync('npm', ['run', 'db:migrate:local'], { stdio: 'ignore', timeout: 120_000 });
  if (mig.status !== 0) {
    console.error('FAIL npm run db:migrate:local did not succeed.');
    process.exit(1);
  }
  child = spawn('npx', ['wrangler', 'dev', '--port', '8787'], { stdio: 'ignore', detached: true });
  child.on('exit', (code) => {
    if (child) {
      console.error(`FAIL wrangler dev exited early (code ${code}).`);
      child = null;
      process.exit(1);
    }
  });
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (await healthy()) return;
    await sleep(500);
  }
  console.error('FAIL wrangler dev did not answer /api/health within 90 s.');
  process.exit(1);
}

function jsonType(res) {
  return (res.headers.get('content-type') || '').toLowerCase().includes('json');
}

function findChrome() {
  if (process.env.CHROME_BIN) return process.env.CHROME_BIN;
  for (const name of ['google-chrome-stable', 'google-chrome', 'chromium', 'chromium-browser']) {
    const probe = spawnSync('sh', ['-c', `command -v ${name}`], { encoding: 'utf8' });
    if (probe.status === 0 && probe.stdout.trim()) return probe.stdout.trim();
  }
  return null;
}

function assetPaths(html) {
  const out = new Set();
  const tags = html.match(/<(script|link)\b[^>]*>/gi) || [];
  for (const tag of tags) {
    const isScript = /^<script/i.test(tag);
    const rel = /\brel\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1] ?? '';
    if (!isScript && !/modulepreload|stylesheet/i.test(rel)) continue;
    const attr = isScript ? 'src' : 'href';
    const m = new RegExp(`\\b${attr}\\s*=\\s*["']([^"']+)["']`, 'i').exec(tag);
    if (m && m[1].startsWith('/assets/')) out.add(m[1]);
  }
  return [...out];
}

// ---------------------------------------------------------------------------------------------
// Admin API helper for the checks below. Never prints a secret.

async function adminCall(cookie, method, path, body) {
  const init = { method, headers: { cookie } };
  if (method !== 'GET') {
    init.headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body ?? {});
  }
  const res = await fetch(`${BASE}/api/admin${path}`, init);
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    /* leave null */
  }
  return { status: res.status, data, text };
}

// 17-18. Provider round trip: Test connection is advice only, and creating a provider with only a name,
// a URL and keys works even when the relay is unreachable (its model fetch just fails).
async function providerRoundTrip(cookie) {
  const KEY_TEXT = 'sk-smoke-test-key-123';
  const test = await adminCall(cookie, 'POST', '/providers/test-connection', { base_url: BASE, keys: KEY_TEXT });
  report(
    test.status === 200 && test.data?.ok === false && test.data?.status === 401 && !test.text.includes(KEY_TEXT),
    'check 17: POST /providers/test-connection answers 200 { ok: false, status: 401 } and never echoes the key',
    `status ${test.status}, ok ${test.data?.ok}, relay status ${test.data?.status}`,
  );

  const name = `smoke-provider-${Date.now()}`;
  let id = null;
  try {
    const created = await adminCall(cookie, 'POST', '/providers', { name, base_url: 'http://127.0.0.1:9', keys: KEY_TEXT });
    id = created.data?.id ?? null;
    const list = await adminCall(cookie, 'GET', '/providers');
    const listed = (list.data?.providers ?? []).some((p) => p.id === id && p.name === name);
    report(created.status === 201 && id !== null && listed, 'check 18: POST /providers with name, URL and keys answers 201 and the provider is listed', `create ${created.status}, listed ${listed}`);
  } finally {
    if (id !== null) await adminCall(cookie, 'DELETE', `/providers/${id}`);
  }
}

// ---------------------------------------------------------------------------------------------
// --check-mobile: 360x800 audit over CDP (Node's global WebSocket, no Playwright or Puppeteer).

const MOBILE_ROUTES = ['overview', 'providers', 'routes', 'gateway-keys', 'logs', 'settings'];
const MOBILE_DIALOG_BUTTONS = ['Add provider', 'New route', 'Create key', 'Add rule', 'Filters'];
const CDP_PORT = 9333;

// Runs inside the page. Returns violations in document order. The documented exceptions: elements
// inside a label whose own box is at least 44px (a switch row), .sr-only, aria-hidden or fully
// transparent controls, and Sonner toasts. Sizes allow 0.5px of sub-pixel rounding.
function pageAudit(scopeSelector) {
  const root = scopeSelector ? document.querySelector(scopeSelector) : document;
  if (!root) return JSON.stringify({ missing: true, violations: [] });
  const SEL = 'button, a[href], [role=button], [role=menuitem], select, input, textarea';
  const violations = [];
  if (!scopeSelector && document.documentElement.scrollWidth > window.innerWidth) {
    violations.push({ kind: 'scroll-x', where: 'document', detail: `scrollWidth ${document.documentElement.scrollWidth} > innerWidth ${window.innerWidth}` });
  }
  const text = (el) => (el.getAttribute('aria-label') || el.textContent || el.getAttribute('placeholder') || '').replace(/\s+/g, ' ').trim().slice(0, 32);
  const describe = (el) => {
    const id = el.id ? `#${el.id}` : '';
    const label = text(el);
    return `${el.tagName.toLowerCase()}${id}${label ? ` "${label}"` : ''}`;
  };
  const layerOf = (el) => {
    for (let n = el.parentElement; n; n = n.parentElement) {
      const pos = getComputedStyle(n).position;
      if (pos === 'fixed' || pos === 'sticky') return n;
    }
    return null;
  };
  // The rect that is actually on screen: clipped by every scroll or overflow-hidden ancestor.
  const clippedRect = (el) => {
    const r = el.getBoundingClientRect();
    let l = r.left, t = r.top, rt = r.right, b = r.bottom;
    for (let n = el.parentElement; n && n !== document.documentElement; n = n.parentElement) {
      const cs = getComputedStyle(n);
      if (cs.overflowX === 'visible' && cs.overflowY === 'visible') continue;
      const nr = n.getBoundingClientRect();
      l = Math.max(l, nr.left); t = Math.max(t, nr.top); rt = Math.min(rt, nr.right); b = Math.min(b, nr.bottom);
    }
    return { left: l, top: t, right: rt, bottom: b };
  };
  const measured = [];
  for (const el of root.querySelectorAll(SEL)) {
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    if (cs.display === 'none' || cs.visibility === 'hidden' || r.width === 0 || r.height === 0) continue;
    if (el.closest('.sr-only, [data-sonner-toast]') || el.closest('[aria-hidden="true"]') || cs.opacity === '0') continue;
    if (el.tagName === 'INPUT' && el.type === 'hidden') continue;
    measured.push({ el, r, cs });
  }
  measured.forEach(({ el, r, cs }) => {
    const label = el.closest('label');
    const labelOk = label && Math.min(label.getBoundingClientRect().width, label.getBoundingClientRect().height) >= 43.5;
    const smaller = Math.min(r.width, r.height);
    if (smaller < 43.5 && !labelOk) {
      violations.push({ kind: 'small-target', where: describe(el), detail: `${Math.round(r.width)}x${Math.round(r.height)}px` });
    }
    const isField = el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || (el.tagName === 'INPUT' && !['checkbox', 'radio', 'hidden', 'button', 'submit', 'reset', 'range', 'file', 'color', 'image'].includes(el.type));
    if (isField && cs.fontSize !== '16px') {
      violations.push({ kind: 'font-size', where: describe(el), detail: `computed ${cs.fontSize}` });
    }
  });
  const boxes = measured.map((m) => ({ ...m, c: clippedRect(m.el), layer: layerOf(m.el) }));
  for (let i = 0; i < boxes.length; i += 1) {
    for (let j = i + 1; j < boxes.length; j += 1) {
      const a = boxes[i], b = boxes[j];
      if (a.layer !== b.layer || a.el.contains(b.el) || b.el.contains(a.el)) continue;
      const ow = Math.min(a.c.right, b.c.right) - Math.max(a.c.left, b.c.left);
      const oh = Math.min(a.c.bottom, b.c.bottom) - Math.max(a.c.top, b.c.top);
      if (ow > 1 && oh > 1) {
        violations.push({ kind: 'overlap', where: `${describe(a.el)} / ${describe(b.el)}`, detail: `${Math.round(ow)}x${Math.round(oh)}px` });
      }
    }
  }
  return JSON.stringify({ missing: false, measured: measured.length, violations });
}

function clickButtonByText(texts) {
  const wanted = texts;
  const buttons = [...document.querySelectorAll('button')];
  const hit = buttons.find((b) => wanted.some((t) => (b.textContent || '').replace(/\s+/g, ' ').trim().startsWith(t)));
  if (!hit) return null;
  const label = (hit.textContent || '').replace(/\s+/g, ' ').trim();
  hit.click();
  return label;
}

async function connectCdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', () => reject(new Error('CDP websocket error')), { once: true });
  });
  let nextId = 0;
  const pending = new Map();
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(String(ev.data));
    if (msg.id !== undefined && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(`${msg.error.message}`));
      else resolve(msg.result);
    }
  });
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      nextId += 1;
      pending.set(nextId, { resolve, reject });
      ws.send(JSON.stringify({ id: nextId, method, params }));
    });
  const evaluate = async (expression) => {
    const res = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (res.exceptionDetails) throw new Error(`page script failed: ${res.exceptionDetails.text}`);
    return res.result.value;
  };
  const waitFor = async (expression, ms = 10_000) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (await evaluate(expression).catch(() => false)) return true;
      await sleep(100);
    }
    return false;
  };
  return { send, evaluate, waitFor, close: () => ws.close() };
}

async function auditRoute(cdp, id, phase, nav) {
  const token = `a${nav}`;
  await cdp.send('Page.navigate', { url: `${BASE}/?${token}#/${id}` });
  const ready = await cdp.waitFor(
    `location.search === '?${token}' && document.readyState === 'complete' && !!document.querySelector('main h1, main [role=alert]') && !document.querySelector('[data-slot=skeleton]')`,
    15_000,
  );
  await sleep(300);
  const label = `${phase} #/${id}`;
  if (!ready) {
    report(false, `mobile ${label}: page did not finish loading (no heading or still on skeletons)`);
    return;
  }
  const out = [];
  let measuredTotal = 0;
  const collect = async (scope, tag) => {
    const res = JSON.parse(await cdp.evaluate(`(${pageAudit.toString()})(${JSON.stringify(scope)})`));
    for (const v of res.violations) out.push({ ...v, tag });
    measuredTotal += res.measured ?? 0;
    return res.missing;
  };
  await collect(null, 'page');

  // The page's main dialog or drawer.
  const clicked = await cdp.evaluate(`(${clickButtonByText.toString()})(${JSON.stringify(MOBILE_DIALOG_BUTTONS)})`);
  if (clicked) {
    const opened = await cdp.waitFor(`!!document.querySelector('[role=dialog]')`, 4000);
    await sleep(700);
    if (!opened) {
      out.push({ kind: 'dialog', tag: 'dialog', where: `"${clicked}"`, detail: 'no dialog opened' });
    } else {
      await collect('[role=dialog]', `dialog "${clicked}"`);
      if (clicked.startsWith('Add provider')) {
        const adv = await cdp.evaluate(`(${clickButtonByText.toString()})(['Advanced'])`);
        if (adv) {
          await sleep(500);
          await collect('[role=dialog]', 'dialog "Add provider" + Advanced');
        }
      }
    }
    for (const type of ['keyDown', 'keyUp']) {
      await cdp.send('Input.dispatchKeyEvent', { type, key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    }
    await sleep(300);
  }

  // Logs: when there is a request row, open its detail drawer too (the seeded run has one).
  if (id === 'logs') {
    const row = await cdp.evaluate(`(() => { const b = document.querySelector('button[aria-label^="Request at"], [role=button][aria-label^="Request at"]'); if (!b) return false; b.click(); return true; })()`);
    if (row) {
      const opened = await cdp.waitFor(`!!document.querySelector('[role=dialog]')`, 4000);
      await sleep(700);
      if (opened) await collect('[role=dialog]', 'dialog "Request details"');
      else out.push({ kind: 'dialog', tag: 'dialog', where: '"Request details"', detail: 'no dialog opened' });
      for (const type of ['keyDown', 'keyUp']) {
        await cdp.send('Input.dispatchKeyEvent', { type, key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
      }
      await sleep(300);
    }
  }

  if (out.length === 0) {
    report(true, `mobile ${label}: clean${clicked ? ` (page and "${clicked}" dialog)` : ''}`, `${measuredTotal} targets measured`);
  } else {
    // Stable order: the in-page audit walks the document in order, and the passes run page, dialog, dialog + Advanced.
    for (const v of out) report(false, `mobile ${label} [${v.tag}] ${v.kind}: ${v.where}`, v.detail);
  }
}

async function auditAllRoutes(cdp, phase, navStart) {
  let nav = navStart;
  for (const id of MOBILE_ROUTES) {
    nav += 1;
    await auditRoute(cdp, id, phase, nav);
  }
  return nav;
}

// Seeds clearly named entries, runs `fn`, then removes them again (found by name or note).
async function withSeededData(cookie, fn) {
  const created = { provider: null, route: null, gatewayKey: null };
  try {
    const provider = await adminCall(cookie, 'POST', '/providers', {
      name: 'audit-provider',
      base_url: 'http://127.0.0.1:9',
      keys: 'sk-audit-key-aaaa1111\nsk-audit-key-bbbb2222',
    });
    created.provider = provider.data?.id ?? null;
    const route = await adminCall(cookie, 'POST', '/routes', { name: 'audit-route', model_patterns: ['audit-*'], provider_ids: [created.provider] });
    created.route = route.data?.id ?? null;
    const gk = await adminCall(cookie, 'POST', '/gateway-keys', { name: 'audit-key', route_id: created.route });
    const gatewayKeySecret = gk.data?.key ?? '';
    await adminCall(cookie, 'POST', '/rules', { action: 'RATE_LIMITED', status_codes: '429', cooldown_s: 60, priority: 25, note: 'audit', enabled: true });
    // One failed proxy request through the new gateway key, so Logs has a row with an attempt trail.
    const proxied = await fetch(`${BASE}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': gatewayKeySecret, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'audit-model', max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] }),
    });
    await proxied.arrayBuffer();
    const deadline = Date.now() + 8000;
    let rows = 0;
    while (Date.now() < deadline && rows === 0) {
      const logs = await adminCall(cookie, 'GET', '/logs?limit=1');
      rows = (logs.data?.logs ?? []).length;
      if (rows === 0) await sleep(250);
    }
    info('mobile audit seeded', `provider, route, gateway key, rule and a failed request (proxy status ${proxied.status})`);
    return await fn();
  } finally {
    // Only what this run seeded: the provider and route by the ids captured above, the gateway key by name on that
    // route, and the rule by its audit note (the Worker returns no id for a new rule).
    const rules = await adminCall(cookie, 'GET', '/rules');
    for (const r of rules.data?.rules ?? []) if (r.note === 'audit') await adminCall(cookie, 'DELETE', `/rules/${r.id}`);
    if (created.route !== null) {
      const keys = await adminCall(cookie, 'GET', '/gateway-keys');
      for (const k of keys.data?.keys ?? []) if (k.name === 'audit-key' && k.route_id === created.route) await adminCall(cookie, 'DELETE', `/gateway-keys/${k.id}`);
      await adminCall(cookie, 'DELETE', `/routes/${created.route}`);
    }
    if (created.provider !== null) await adminCall(cookie, 'DELETE', `/providers/${created.provider}`);
  }
}

async function checkMobile(cookie) {
  const chrome = findChrome();
  if (!chrome) {
    report(false, 'mobile audit: headless Chromium', 'no Chrome found; set CHROME_BIN');
    return;
  }
  const profile = mkdtempSync(join(tmpdir(), 'gw-mobile-chrome-'));
  const args = ['--headless=new', '--disable-gpu', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`, '--no-first-run', 'about:blank'];
  if (typeof process.getuid === 'function' && process.getuid() === 0) args.push('--no-sandbox');
  const proc = spawn(chrome, args, { stdio: 'ignore' });
  let cdp = null;
  try {
    let target = null;
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline && !target) {
      try {
        const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
        target = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl) ?? null;
      } catch {
        /* Chrome is still starting */
      }
      if (!target) await sleep(200);
    }
    if (!target) {
      report(false, 'mobile audit: Chromium did not expose a debugging target');
      return;
    }
    cdp = await connectCdp(target.webSocketDebuggerUrl);
    await cdp.send('Page.enable');
    await cdp.send('Network.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 360, height: 800, deviceScaleFactor: 2, mobile: true });
    const [name, ...rest] = cookie.split('=');
    await cdp.send('Network.setCookie', { name, value: rest.join('='), url: BASE, path: '/api', httpOnly: true, sameSite: 'Strict' });

    const nav = await auditAllRoutes(cdp, 'empty-db', 0);
    await withSeededData(cookie, () => auditAllRoutes(cdp, 'seeded', nav));
  } finally {
    try {
      cdp?.close();
    } catch {
      /* closing anyway */
    }
    const exited = new Promise((resolve) => proc.once('exit', resolve));
    proc.kill('SIGTERM');
    await Promise.race([exited, sleep(5000)]);
    // Chrome may still be flushing its profile for a moment; retry instead of crashing the run.
    rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}

async function main() {
  const vars = readDevVars();
  await ensureServer();

  // 1. Dashboard shell served by Workers Static Assets.
  const index = await fetch(`${BASE}/`);
  const html = await index.text();
  report(
    index.status === 200 && (index.headers.get('content-type') || '').includes('text/html') && html.includes('id="root"'),
    'check 1: GET / serves the React shell (200, text/html, id="root")',
    `status ${index.status}`,
  );

  // 2. Worker health is untouched.
  const health = await fetch(`${BASE}/api/health`);
  const healthBody = await health.json().catch(() => ({}));
  report(health.status === 200 && jsonType(health) && healthBody.ok === true, 'check 2: GET /api/health is 200 JSON ok', `status ${health.status}`);

  // 3. /v1 still reaches the Worker, not the SPA fallback.
  const models = await fetch(`${BASE}/v1/models`);
  await models.arrayBuffer();
  report(models.status === 401 && jsonType(models), 'check 3: GET /v1/models without a key is 401 JSON', `status ${models.status}`);

  // 4. Session probe without a cookie.
  const noSession = await fetch(`${BASE}/api/admin/session`);
  await noSession.arrayBuffer();
  report(noSession.status === 401, 'check 4: GET /api/admin/session without a cookie is 401', `status ${noSession.status}`);

  // 5. Wrong password (one probe only, the login limiter counts failures).
  const wrong = await fetch(`${BASE}/api/admin/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: 'definitely-not-the-password' }),
  });
  await wrong.arrayBuffer();
  report(wrong.status === 401, 'check 5: POST /api/admin/login with a wrong password is 401', `status ${wrong.status}`);

  // 6. Right password sets the session cookie with the expected attributes.
  const login = await fetch(`${BASE}/api/admin/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: vars.ADMIN_PASSWORD }),
  });
  await login.arrayBuffer();
  const setCookie = login.headers.getSetCookie?.() ?? [];
  const cookieLine = setCookie.find((c) => c.startsWith('gw_session=')) ?? '';
  const cookieOk =
    login.status === 200 &&
    cookieLine !== '' &&
    /;\s*HttpOnly/i.test(cookieLine) &&
    /;\s*SameSite=Strict/i.test(cookieLine) &&
    /;\s*Path=\/api(;|$)/i.test(cookieLine) &&
    /;\s*Max-Age=604800/i.test(cookieLine);
  report(
    cookieOk,
    'check 6: POST /api/admin/login sets gw_session (HttpOnly, SameSite=Strict, Path=/api, Max-Age=604800)',
    cookieLine ? `status ${login.status}, attributes: ${cookieLine.split(';').slice(1).map((s) => s.trim().split('=')[0]).join(', ')}` : `status ${login.status}, no gw_session cookie`,
  );
  const cookie = cookieLine.split(';')[0];

  // 7. Session probe with the cookie.
  const session = await fetch(`${BASE}/api/admin/session`, { headers: { cookie } });
  await session.arrayBuffer();
  report(session.status === 200, 'check 7: GET /api/admin/session with the cookie is 200', `status ${session.status}`);

  // 8. Stats data path.
  const stats = await fetch(`${BASE}/api/admin/stats?range=24h`, { headers: { cookie } });
  const statsBody = await stats.json().catch(() => ({}));
  report(
    stats.status === 200 && typeof statsBody?.totals?.requests === 'number',
    'check 8: GET /api/admin/stats?range=24h is 200 with totals.requests a number',
    `status ${stats.status}`,
  );

  // 9. Every JS and CSS file named in the served HTML loads through the Worker.
  const assets = assetPaths(html);
  const hasJs = assets.some((p) => p.endsWith('.js'));
  const hasCss = assets.some((p) => p.endsWith('.css'));
  let assetProblems = [];
  if (!hasJs) assetProblems.push('no .js path in the served HTML');
  if (!hasCss) assetProblems.push('no .css path in the served HTML');
  for (const path of assets) {
    const res = await fetch(`${BASE}${path}`);
    const body = await res.arrayBuffer();
    const type = (res.headers.get('content-type') || '').toLowerCase();
    const wantJs = path.endsWith('.js');
    const typeOk = wantJs ? type.includes('javascript') : path.endsWith('.css') ? type.includes('text/css') : true;
    if (res.status !== 200 || !typeOk || body.byteLength === 0) {
      assetProblems.push(`${path} -> status ${res.status}, content-type "${type}", ${body.byteLength} bytes`);
    }
  }
  report(
    assetProblems.length === 0,
    'check 9: every JS and CSS asset named in the served HTML loads through the Worker',
    assetProblems.length === 0 ? `${assets.length} assets checked` : assetProblems.join('; '),
  );

  // 10. React mounts the sign-in form in headless Chrome (no cookie, so the session probe answers 401).
  if (SKIP_RENDER) {
    console.log('SKIP check 10: headless Chrome render (--skip-render)');
  } else {
    const chrome = findChrome();
    if (!chrome) {
      report(false, 'check 10: headless Chrome renders the sign-in form', 'no Chrome found; set CHROME_BIN or pass --skip-render');
    } else {
      const profile = mkdtempSync(join(tmpdir(), 'gw-smoke-chrome-'));
      try {
        const args = [
          '--headless=new',
          '--disable-gpu',
          '--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1',
          '--virtual-time-budget=10000',
          '--dump-dom',
          `--user-data-dir=${profile}`,
        ];
        if (typeof process.getuid === 'function' && process.getuid() === 0) args.push('--no-sandbox');
        args.push(`${BASE}/`);
        const run = spawnSync(chrome, args, { encoding: 'utf8', timeout: 45_000, maxBuffer: 32 * 1024 * 1024 });
        const dom = run.stdout || '';
        const ok = run.status === 0 && /<input[^>]*type="password"/.test(dom);
        report(
          ok,
          'check 10: headless Chrome renders the sign-in password input',
          ok ? `binary ${chrome}` : `binary ${chrome}, exit ${run.status ?? run.signal ?? 'timeout'}, DOM ${dom.length} bytes, no password input found`,
        );
      } finally {
        rmSync(profile, { recursive: true, force: true });
      }
    }
  }

  // 11. Optional: cache headers on a built asset, and how a stale chunk is answered.
  if (CHECK_HEADERS) {
    const jsPath = assets.find((p) => p.endsWith('.js'));
    if (!jsPath) {
      report(false, 'check 11: cache headers on a built JS asset', 'no .js path in the served HTML');
    } else {
      const res = await fetch(`${BASE}${jsPath}`);
      await res.arrayBuffer();
      const cc = (res.headers.get('cache-control') || '').toLowerCase();
      const bad = ['no-cache', 'no-store', 'max-age=0', 'must-revalidate'].filter((t) => cc.includes(t));
      report(
        res.status === 200 && cc.includes('immutable') && bad.length === 0,
        'check 11: built JS asset is cached as immutable with no revalidation directive',
        `status ${res.status}, cache-control "${cc}"${bad.length ? `, unexpected: ${bad.join(', ')}` : ''}`,
      );
    }
    // 12. Security headers on / and on a SPA fallback path (T-02-22, T-02-23, WR-04).
    const SECURITY = [
      ['x-content-type-options', (v) => v.toLowerCase() === 'nosniff'],
      ['x-frame-options', (v) => v.toUpperCase() === 'DENY'],
      ['referrer-policy', (v) => v.toLowerCase() === 'no-referrer'],
      ['content-security-policy', (v) => v.includes("default-src 'self'") && v.includes("frame-ancestors 'none'")],
    ];
    const securityProblems = (res) => SECURITY.filter(([name, ok]) => !ok(res.headers.get(name) || '')).map(([name]) => name);
    for (const path of ['/', '/some/unknown/path']) {
      const res = await fetch(`${BASE}${path}`);
      await res.arrayBuffer();
      const missing = securityProblems(res);
      report(
        res.status === 200 && missing.length === 0,
        `check 12: GET ${path} carries the security headers and the CSP`,
        `status ${res.status}${missing.length ? `, missing or wrong: ${missing.join(', ')}` : ''}`,
      );
    }

    // 13. A hashed JS asset keeps exactly the immutable rule (no second Cache-Control) and also carries the CSP.
    if (jsPath) {
      const res = await fetch(`${BASE}${jsPath}`);
      await res.arrayBuffer();
      const cc = res.headers.get('cache-control') || '';
      const missing = securityProblems(res);
      report(
        cc === 'public, max-age=31536000, immutable' && missing.length === 0,
        'check 13: hashed JS asset has the exact immutable Cache-Control and the CSP',
        `cache-control "${cc}"${missing.length ? `, missing or wrong: ${missing.join(', ')}` : ''}`,
      );
    }

    // 14. No third-party font host in the served HTML.
    const googleHosts = ['fonts.googleapis.com', 'fonts.gstatic.com'].filter((h) => html.includes(h));
    report(googleHosts.length === 0, 'check 14: the served HTML names no Google font host', googleHosts.join(', '));

    // 15. Manifest fields, and every icon is a real PNG (a missing file would come back as the SPA HTML with 200).
    const mres = await fetch(`${BASE}/manifest.webmanifest`);
    const mtext = await mres.text();
    let manifest = null;
    try {
      manifest = JSON.parse(mtext);
    } catch {
      /* reported below */
    }
    const manifestOk =
      mres.status === 200 &&
      jsonType(mres) &&
      manifest?.name === 'AI Relay Gateway' &&
      manifest?.short_name === 'Gateway' &&
      manifest?.display === 'standalone' &&
      manifest?.start_url === '/' &&
      manifest?.scope === '/' &&
      Array.isArray(manifest?.icons) &&
      manifest.icons.length > 0;
    report(manifestOk, 'check 15: GET /manifest.webmanifest is JSON with the install fields', `status ${mres.status}, content-type "${mres.headers.get('content-type') || ''}"`);
    for (const icon of manifest?.icons ?? []) {
      const res = await fetch(`${BASE}${icon.src}`);
      const bytes = new Uint8Array(await res.arrayBuffer());
      const png = bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
      report(
        res.status === 200 && (res.headers.get('content-type') || '').includes('image/png') && png,
        `check 15: icon ${icon.src} is a PNG`,
        `status ${res.status}, content-type "${res.headers.get('content-type') || ''}", ${bytes.length} bytes`,
      );
    }

    // 16. Admin JSON is never cached (the Worker sets it; _headers cannot reach Worker responses).
    const adminRes = await fetch(`${BASE}/api/admin/session`, { headers: { cookie } });
    await adminRes.arrayBuffer();
    report(
      adminRes.status === 200 && (adminRes.headers.get('cache-control') || '').toLowerCase().includes('no-store'),
      'check 16: GET /api/admin/session answers Cache-Control no-store',
      `status ${adminRes.status}, cache-control "${adminRes.headers.get('cache-control') || ''}"`,
    );

    info('cache-control of /', `"${index.headers.get('cache-control') || ''}"`);
    const missing = await fetch(`${BASE}/assets/does-not-exist-0000.js`);
    await missing.arrayBuffer();
    info('stale chunk /assets/does-not-exist-0000.js', `status ${missing.status}, content-type "${missing.headers.get('content-type') || ''}"`);
  }

  // 17-18 always run; --check-mobile adds the 360px audit.
  await providerRoundTrip(cookie);
  if (CHECK_MOBILE) await checkMobile(cookie);

  console.log(`\n${passes} passed, ${failures} failed`);
  stopChild();
  process.exit(failures > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('FAIL smoke script crashed:', err?.message ?? err);
  stopChild();
  process.exit(1);
});
