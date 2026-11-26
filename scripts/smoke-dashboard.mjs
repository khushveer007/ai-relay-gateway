#!/usr/bin/env node
// End-to-end smoke check for the rebuilt dashboard, run against `wrangler dev` on 127.0.0.1:8787.
//
//   node scripts/smoke-dashboard.mjs                  checks 1-10, provider round trip and local key-drop lifecycle
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
// The script uses loopback for the Worker, fixture relay and browser debugging.
import { ok } from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const BASE = 'http://127.0.0.1:8787';
const PRICE_CATALOG_URL = 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';
const DEV_VARS_PATH = new URL('../.dev.vars', import.meta.url);
const CHECK_HEADERS = process.argv.includes('--check-headers');
const CHECK_MOBILE = process.argv.includes('--check-mobile');
const SKIP_RENDER = process.argv.includes('--skip-render');

let failures = 0;
let passes = 0;
let child = null;
let persistence = null;

function report(ok, label, detail = '') {
  if (ok) passes += 1;
  else failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ` - ${detail}` : ''}`);
}

function info(label, detail = '') {
  console.log(`INFO ${label}${detail ? ` - ${detail}` : ''}`);
}

function signalChild(proc, signal) {
  try {
    process.kill(-proc.pid, signal);
  } catch {
    proc.kill(signal);
  }
}

async function stopServer() {
  if (child?.pid && child.exitCode === null && child.signalCode === null) {
    const exited = once(child, 'exit');
    signalChild(child, 'SIGTERM');
    const timeout = setTimeout(() => signalChild(child, 'SIGKILL'), 5000);
    try {
      await exited;
    } finally {
      clearTimeout(timeout);
    }
  }
  child = null;
  if (persistence) {
    rmSync(persistence, { recursive: true, force: true });
    persistence = null;
  }
}

for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.once(sig, async () => {
    await stopServer();
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

async function ensureServer(reusePassword) {
  if (await healthy()) {
    if (CHECK_MOBILE) throw new Error('The mobile audit requires a Worker started by this script. Stop the Worker on port 8787 and retry.');
    if (process.env.SMOKE_ALLOW_REUSE !== '1') {
      throw new Error('A Worker is already answering on port 8787. Stop it or set SMOKE_ALLOW_REUSE=1 for a disposable local Worker.');
    }
    console.log(`Using the Worker already running at ${BASE} (SMOKE_ALLOW_REUSE=1)`);
    return reusePassword;
  }
  console.log('No Worker on 127.0.0.1:8787, applying local migrations and starting wrangler dev...');
  persistence = mkdtempSync(join(tmpdir(), 'gw-smoke-d1-'));
  const persistArgs = ['--persist-to', persistence];
  const mig = spawnSync('npm', ['run', 'db:migrate:local', '--', ...persistArgs], { stdio: 'ignore', timeout: 120_000 });
  if (mig.status !== 0) throw new Error('Local D1 migrations did not succeed.');

  // A per-run login and signing key bind all fixture mutations to this managed Worker.
  const password = crypto.randomUUID();
  const envFile = join(persistence, 'smoke.env');
  writeFileSync(envFile, [
    `ADMIN_PASSWORD=${password}`,
    `SESSION_SECRET=${crypto.randomUUID()}`,
    `ENCRYPTION_KEY=${crypto.randomUUID()}`,
  ].join('\n'), { mode: 0o600 });
  child = spawn('npx', ['--no-install', 'wrangler', 'dev', '--local', '--ip', '127.0.0.1', '--port', '8787', '--env-file', envFile, ...persistArgs], {
    stdio: 'ignore',
    detached: true,
  });
  let startError = null;
  child.once('error', (error) => { startError = error; });
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (startError) throw startError;
    if (child.exitCode !== null || child.signalCode !== null) throw new Error('wrangler dev exited before answering /api/health.');
    if (await healthy()) return password;
    await sleep(500);
  }
  throw new Error('wrangler dev did not answer /api/health within 90 s.');
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
  const res = await fetch(`${BASE}/api/admin${path}`, { ...init, signal: AbortSignal.timeout(10_000) });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    /* leave null */
  }
  return { status: res.status, data, text };
}

async function checkedAdmin(cookie, method, path, body, status = 200) {
  const response = await adminCall(cookie, method, path, body);
  ok(response.status === status, `${method} ${path} expected HTTP ${status}, got ${response.status}`);
  return response.data;
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
    const created = await adminCall(cookie, 'POST', '/providers', {
      name, base_url: 'http://127.0.0.1:9', keys: KEY_TEXT, add_to_default: false,
      ...(persistence ? { drop_codes: '418' } : {}),
    });
    id = created.data?.id ?? null;
    const list = await adminCall(cookie, 'GET', '/providers');
    const listed = list.data?.providers?.find((p) => p.id === id && p.name === name);
    report(created.status === 201 && Boolean(listed) && (!persistence || listed.drop_codes === '418'),
      'check 18: provider round trip saves and lists the provider', `create ${created.status}, listed ${Boolean(listed)}`);
  } finally {
    if (id !== null) await adminCall(cookie, 'DELETE', `/providers/${id}`);
  }
}

async function until(find, description) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const found = await find();
    if (found) return found;
    await sleep(150);
  }
  throw new Error(description);
}

async function keyDropLifecycle(cookie, audit) {
  ok(persistence, 'key-drop lifecycle requires disposable local D1');
  const tag = `audit-${crypto.randomUUID().slice(0, 12)}`;
  const model = `${tag}-model`;
  const testModel = `${tag}-test`;
  const keys = [`sk-${tag}-first`, `sk-${tag}-second`];
  const dropCodes = '403,418';
  const dropMessage = 'Account blocked (smoke).';
  const suffix = 'End of smoke drop reason.';
  const pad = 'This key was rejected by the local fixture. ';
  const longReason = `${dropMessage} ${pad.repeat(7).slice(0, 298 - dropMessage.length - suffix.length)} ${suffix}`;
  let rejection = dropMessage;
  const calls = [];
  const mock = createServer((req, res) => {
    const path = req.url.split('?')[0];
    res.setHeader('content-type', 'application/json');
    if (req.method === 'GET' && path === '/v1/models') {
      res.end(JSON.stringify({ data: [{ id: testModel }] }));
      return;
    }
    const key = keys.indexOf(req.headers['x-api-key']);
    if (req.method !== 'POST' || path !== '/v1/messages' || key === -1) {
      res.writeHead(404).end('{}');
      return;
    }
    calls.push(key + 1);
    req.resume();
    if (key === 0 && rejection) {
      res.writeHead(403).end(JSON.stringify({ error: { message: rejection } }));
      return;
    }
    res.end(JSON.stringify({ id: `smoke-key-${key + 1}`, type: 'message', content: [], usage: { input_tokens: 1, output_tokens: 1 } }));
  });

  const api = checkedAdmin.bind(null, cookie);
  const ruleTest = (body) => api('POST', '/rules/test', body);
  let providerId;
  let routeId;
  let gatewayKey;
  const readProvider = async () => (await api('GET', '/providers')).providers.find((provider) => provider.id === providerId);

  try {
    await once(mock.listen(0, '127.0.0.1'), 'listening');
    ({ id: providerId } = await api('POST', '/providers', {
      name: tag, base_url: `http://127.0.0.1:${mock.address().port}`, keys: keys.join('\n'),
      formats: ['anthropic'], key_strategy: 'sequential', test_model: testModel, add_to_default: false,
      drop_codes: dropCodes, drop_message: dropMessage,
    }, 201));
    const provider = await readProvider();
    ok(provider?.drop_codes === dropCodes && provider.drop_message === dropMessage && provider.models.includes(testModel),
      'key-drop lifecycle: provider saved its drop list and loaded models');
    const [first, second] = provider.keys;
    ok(first?.id && second?.id && first.priority < second.priority, 'key-drop lifecycle: two ordered provider keys');
    ({ id: routeId } = await api('POST', '/routes', {
      name: tag, model_patterns: [`${tag}-*`], provider_ids: [providerId],
    }, 201));
    ({ key: gatewayKey } = await api('POST', '/gateway-keys', { name: tag, route_id: routeId }, 201));
    ok(gatewayKey, 'key-drop lifecycle: gateway key created');
    await api('POST', '/rules', { provider_id: providerId, priority: 0, status_codes: '403', action: 'RATE_LIMITED', note: tag }, 201);
    const { rules } = await api('GET', '/rules');
    const dropRule = rules.find((rule) => rule.provider_id === providerId && rule.origin === 'drop_list');
    const manualRule = rules.find((rule) => rule.provider_id === providerId && rule.note === tag);
    ok(dropRule?.status_codes === dropCodes && dropRule.note === dropMessage && dropRule.priority === -1 && manualRule?.id,
      'key-drop lifecycle: Rules mirrors the provider drop list');
    await api('DELETE', `/rules/${dropRule.id}`, {}, 409);
    const matched = await ruleTest({ provider_id: providerId, status: 403, body: dropMessage });
    const unmatched = await ruleTest({ provider_id: providerId, status: 403, body: 'Account blocked smoke!' });
    ok(matched.ruleId === dropRule.id && matched.action === 'INVALID_KEY' && unmatched.ruleId === manualRule.id && unmatched.action === 'RATE_LIMITED',
      'key-drop lifecycle: matching text drops the key before the manual rule, altered text matches the manual rule');

    const proxy = async (expectedKeys, requestModel = model) => {
      calls.length = 0;
      const response = await fetch(`${BASE}/v1/messages`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': gatewayKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: requestModel, max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] }),
        signal: AbortSignal.timeout(10_000),
      });
      const payload = await response.json().catch(() => null);
      ok(response.status === 200 && payload?.id === `smoke-key-${expectedKeys.at(-1)}` && calls.join() === expectedKeys.join(),
        `key-drop lifecycle: proxy expected keys ${expectedKeys.join(', ')}, got ${calls.join(', ') || 'none'} (HTTP ${response.status})`);
    };
    const firstKey = async () => (await readProvider()).keys.find((key) => key.id === first.id);
    const droppedKey = () => until(async () => {
      const key = await firstKey();
      return key?.status === 'invalid' && key;
    }, 'key-drop lifecycle: first key did not become dropped');

    const beforeDrop = Date.now();
    await proxy([1, 2]);
    const drop = await droppedKey();
    ok(drop.status_code === 403 && drop.status_reason === rejection && drop.status_changed_at >= beforeDrop && drop.status_changed_at <= Date.now(),
      'key-drop lifecycle: first drop stores HTTP 403, reason and timestamp');
    rejection = null;
    calls.length = 0;
    const diagnostic = await api('POST', `/keys/${first.id}/test`);
    ok(diagnostic.ok && diagnostic.status === 200 && diagnostic.key_status === 'invalid' && calls.join() === '1',
      'key-drop lifecycle: diagnostic succeeded on the dropped key');
    const afterTest = await firstKey();
    ok(['status', 'status_code', 'status_reason', 'status_changed_at'].every((field) => afterTest[field] === drop[field]),
      'key-drop lifecycle: diagnostic left the drop record intact');
    await proxy([2]);
    await api('PUT', `/keys/${first.id}`, { status: 'active' });
    const enabled = await firstKey();
    ok(enabled.status === 'active' && enabled.status_code === null && enabled.status_reason === null,
      'key-drop lifecycle: explicit Re-enable cleared the drop record');
    await proxy([1]);
    report(true, 'key-drop lifecycle', 'drop, rotation, report-only Test, and explicit Re-enable passed on local D1');

    if (audit) {
      rejection = longReason;
      const auditModel = `${tag}-mobile`;
      await proxy([1, 2], auditModel);
      const dropped = await droppedKey();
      ok(dropped.status_reason === longReason, 'key-drop lifecycle: browser fixture stored the full reason');
      await until(async () => (await api('GET', `/logs?model=${auditModel}`)).logs
        .find((item) => item.model === auditModel && item.route_id === routeId && item.attempts[0]?.key_id === first.id && item.attempts[1]?.key_id === second.id),
      'key-drop lifecycle: browser fixture request log did not commit');
      await audit({ tag, providerId, dropCodes, dropMessage, suffix, auditModel });
    }
  } finally {
    try {
      if (routeId !== undefined) {
        const { keys } = await api('GET', '/gateway-keys');
        for (const key of keys) {
          if (key.name === tag && key.route_id === routeId) await api('DELETE', `/gateway-keys/${key.id}`);
        }
        await api('DELETE', `/routes/${routeId}`);
      }
      if (providerId !== undefined) await api('DELETE', `/providers/${providerId}`);
    } finally {
      if (mock.listening) await new Promise((resolve) => mock.close(resolve));
    }
  }
}

// ---------------------------------------------------------------------------------------------
// --check-mobile: 360x800 audit over CDP (Node's global WebSocket, no Playwright or Puppeteer).

const MOBILE_ROUTES = ['overview', 'providers', 'routes', 'gateway-keys', 'logs', 'prices', 'settings'];
const MOBILE_DIALOG_BUTTONS = { providers: 'Add provider', routes: 'New route', 'gateway-keys': 'Create key', logs: 'Filters', settings: 'Add rule' };

// Runs inside the page. Returns violations in document order. The documented exceptions: elements
// inside a label whose own box is at least 44px (a switch row), .sr-only, aria-hidden or fully
// transparent controls, and Sonner toasts. Sizes allow 0.5px of sub-pixel rounding.
function pageAudit(scopeSelector) {
  const root = scopeSelector ? document.querySelector(scopeSelector) : document;
  if (!root) return JSON.stringify({ missing: true, violations: [] });
  const SEL = 'button, a[href], [role=button], [role=menuitem], select, input, textarea';
  const violations = [];
  const scrollRoot = scopeSelector ? root : document.documentElement;
  const width = scopeSelector ? root.clientWidth : window.innerWidth;
  if (scrollRoot.scrollWidth > width) {
    violations.push({ kind: 'scroll-x', where: scopeSelector || 'document', detail: `scrollWidth ${scrollRoot.scrollWidth} > width ${width}` });
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
  const listeners = new Map();
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(String(ev.data));
    if (msg.id !== undefined && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(`${msg.error.message}`));
      else resolve(msg.result);
    }
    listeners.get(msg.method)?.(msg.params);
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
  return { send, evaluate, waitFor, on: (method, listener) => listeners.set(method, listener), close: () => ws.close() };
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
  const expectedButton = MOBILE_DIALOG_BUTTONS[id];
  const clicked = expectedButton && await cdp.evaluate(`(${clickButtonByText.toString()})([${JSON.stringify(expectedButton)}])`);
  if (expectedButton && !clicked) out.push({ kind: 'dialog', tag: 'page', where: expectedButton, detail: 'control not found' });
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
        } else out.push({ kind: 'dialog', tag: 'dialog', where: 'Advanced', detail: 'control not found' });
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
    } else if (phase === 'seeded') out.push({ kind: 'dialog', tag: 'page', where: 'Request details', detail: 'seeded request not found' });
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

const DIALOG = '[role=dialog]';
const RULE_CARDS = '[role=list][aria-label="Error rules"] > [role=listitem]';
const RAW_ACTIONS = /\b(INVALID_KEY|RATE_LIMITED|EXHAUSTED|UPSTREAM_ERROR|CLIENT_ERROR)\b/;
const DROP_LABEL = 'Drop key until I re-enable it';
const EXHAUSTED_LABEL = 'Mark out of balance (auto-recheck)';

async function mobileRoute(cdp, route) {
  const url = `${BASE}/?audit=${crypto.randomUUID()}#/${route}`;
  await cdp.send('Page.navigate', { url });
  ok(await cdp.waitFor(`location.href === ${JSON.stringify(url)} && !!document.querySelector('main h1') && !document.querySelector('[data-slot=skeleton]')`),
    `mobile ${route}: page did not load`);
}

async function mobileClick(cdp, label, scope = 'main, [role=dialog]') {
  const findButton = `[...document.querySelectorAll(${JSON.stringify(scope)})].flatMap((root) => [...root.querySelectorAll('button')]).find((button) => button.getClientRects().length && !button.disabled && button.innerText.trim().startsWith(${JSON.stringify(label)}))`;
  ok(await cdp.waitFor(`Boolean(${findButton})`), `mobile: control missing or disabled: ${label}`);
  await cdp.evaluate(`(${findButton}).click()`);
}

// The native setter bypasses React's value tracker so the DOM event reaches onChange.
function setMobileField(cdp, id, value) {
  return cdp.evaluate(`(() => {
    const field = document.getElementById(${JSON.stringify(id)});
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), 'value').set.call(field, ${JSON.stringify(value)});
    field.dispatchEvent(new Event(field.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
  })()`);
}

async function checkMobileLayout(cdp, label, scope = null) {
  const audit = JSON.parse(await cdp.evaluate(`(${pageAudit.toString()})(${JSON.stringify(scope)})`));
  ok(!audit.missing && audit.measured > 0, `mobile ${label}: nothing was measured`);
  for (const issue of audit.violations) report(false, `mobile ${label} ${issue.kind}: ${issue.where}`, issue.detail);
  ok(audit.violations.length === 0, `mobile ${label}: layout audit failed`);
}

async function checkVisibleCopy(cdp, expression, expected, label) {
  const actual = await cdp.evaluate(expression);
  ok(typeof actual === 'string' && expected.every((part) => actual.includes(part)) && !RAW_ACTIONS.test(actual),
    `mobile ${label}: expected copy missing or raw action code visible`);
}

function wrapsText(element) {
  if (!element?.getClientRects().length) return false;
  element.scrollIntoView({ block: 'center' });
  const style = getComputedStyle(element);
  const range = document.createRange();
  range.selectNodeContents(element);
  const lines = [...range.getClientRects()];
  const bounds = element.getBoundingClientRect();
  return new Set(lines.map((line) => line.top)).size > 1 && lines.every((line) =>
    line.left >= bounds.left - 1 && line.right <= bounds.right + 1 && line.bottom <= bounds.bottom + 1) &&
    style.textOverflow !== 'ellipsis' && !element.hasAttribute('title');
}

async function auditDropUi(cdp, fixture) {
  const { tag, providerId, dropCodes, dropMessage, suffix, auditModel } = fixture;
  const dialogText = `document.querySelector('${DIALOG}')?.innerText`;
  const cards = `[...document.querySelectorAll(${JSON.stringify(RULE_CARDS)})]`;
  const mirror = `${cards}.find((card) => card.innerText.includes(${JSON.stringify(`From ${tag}'s drop list`)}))`;
  const findExact = (selector, value) => `[...document.querySelectorAll(${JSON.stringify(selector)})].find((el) => el.innerText.endsWith(${JSON.stringify(value)}))`;
  const awaitDialog = async () => {
    ok(await cdp.waitFor(`!!document.querySelector('${DIALOG}')`), 'mobile: expected a drawer');
    await sleep(500);
  };
  const awaitClosed = async () => ok(await cdp.waitFor(`!document.querySelector('${DIALOG}')`), 'mobile: drawer failed to close');

  await mobileRoute(cdp, 'providers');
  ok(await cdp.waitFor(`document.querySelector('main')?.innerText.includes(${JSON.stringify(suffix)})`), 'mobile: dropped-key row did not load');
  const reason = findExact('main p', suffix);
  ok(await cdp.evaluate(`(${wrapsText.toString()})(${reason})`), 'mobile: dropped-key reason must wrap and show its last line');
  ok(await cdp.evaluate(`(() => {
    const row = (${reason})?.parentElement.parentElement;
    return row && /HTTP 403 · dropped .+ \\(.+\\)/.test(row.innerText) && row.innerText.includes('Dropped') &&
      [...row.querySelectorAll('button')].some((button) => button.innerText === 'Re-enable');
  })()`), 'mobile: dropped-key row needs code, times, badge and Re-enable');
  await checkVisibleCopy(cdp, `document.querySelector('main').innerText`, [suffix], 'dropped key');
  await checkMobileLayout(cdp, 'dropped provider key');
  report(true, 'mobile dropped key: code, both times, wrapped reason and Re-enable');

  await mobileClick(cdp, 'Add provider');
  await awaitDialog();
  await setMobileField(cdp, 'provider-name', 'Smoke draft');
  await setMobileField(cdp, 'provider-base-url', 'http://127.0.0.1:9');
  await setMobileField(cdp, 'provider-keys', 'sk-smoke-draft-key');
  const dropTrigger = `[...document.querySelectorAll('${DIALOG} button[aria-expanded]')].find((button) => button.innerText.startsWith('Drop keys'))`;
  ok(await cdp.evaluate(`(${dropTrigger})?.getAttribute('aria-expanded') === 'false'`), 'mobile: add starts with Drop keys closed');
  await mobileClick(cdp, 'Drop keys', DIALOG);
  const longCodes = '401, 403, 410, 415, 418, 425, 426, 428, 431, 451, 500-503, 511';
  const longMessage = 'Long drop-list message '.repeat(9).slice(0, 200);
  await setMobileField(cdp, 'drop_codes', longCodes);
  await setMobileField(cdp, 'drop_message', longMessage);
  await checkVisibleCopy(cdp, dialogText, ['Risky:', '500-503'], 'provider range warning');
  await checkMobileLayout(cdp, 'provider Drop keys drawer', DIALOG);
  const saveVisible = await cdp.evaluate(`(() => {
    const save = [...document.querySelectorAll('${DIALOG} button')].find((button) => button.innerText === 'Create provider');
    if (!save || save.disabled) return false;
    const r = save.getBoundingClientRect();
    return r.height >= 44 && r.top >= 0 && r.bottom <= innerHeight && save.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2));
  })()`);
  ok(saveVisible, 'mobile: Create provider stays visible, enabled and reachable');
  await mobileClick(cdp, 'Drop keys', DIALOG);
  ok(await cdp.evaluate(`(${wrapsText.toString()})((${dropTrigger})?.querySelector('span > span:last-child'))`), 'mobile: closed Drop keys summary must wrap');
  await checkMobileLayout(cdp, 'provider Drop keys summary', DIALOG);
  await mobileClick(cdp, 'Drop keys', DIALOG);
  ok(await cdp.evaluate(`document.getElementById('drop_codes')?.value === ${JSON.stringify(longCodes)} && document.getElementById('drop_message')?.value === ${JSON.stringify(longMessage)}`),
    'mobile: collapsing Drop keys clears a draft');
  await mobileClick(cdp, 'Discard provider', DIALOG);
  await awaitClosed();
  report(true, 'mobile Drop keys drawer: 12 codes, 200 characters, wrapped summary and reachable Save');

  await mobileRoute(cdp, 'settings');
  ok(await cdp.waitFor(`Boolean(${mirror})`), 'mobile: drop-list mirror did not load');
  await checkVisibleCopy(cdp, `(${mirror})?.innerText`, [`On ${dropCodes} → ${DROP_LABEL}`, dropMessage, '403 can be a short block', 'Checked before all rules'], 'Rules mirror');
  ok(await cdp.evaluate(`(() => {
    const buttons = (${mirror})?.querySelectorAll('button');
    if (buttons?.length !== 1 || buttons[0].innerText !== 'Edit in provider') return false;
    buttons[0].click();
    return true;
  })()`), 'mobile: mirror needs exactly one Edit in provider control');
  await awaitDialog();
  ok(await cdp.evaluate(`location.hash === '#/settings' && (${dropTrigger})?.getAttribute('aria-expanded') === 'true' &&
    document.getElementById('provider-name')?.value === ${JSON.stringify(tag)} &&
    document.getElementById('drop_codes')?.value === ${JSON.stringify(dropCodes)} &&
    document.getElementById('drop_message')?.value === ${JSON.stringify(dropMessage)}`), 'mobile: Edits must open the matching provider in place with its Drop keys expanded');
  await setMobileField(cdp, 'drop_codes', '403, 500-503');
  await checkVisibleCopy(cdp, dialogText, ['Risky:', '500-503'], 'Rules provider edit warning');
  await checkMobileLayout(cdp, 'Rules provider edit', DIALOG);
  await mobileClick(cdp, 'Save changes', DIALOG);
  await awaitClosed();
  ok(await cdp.waitFor(`location.hash === '#/settings' && (${mirror})?.innerText.includes('403,500-503')`), 'mobile: saving must update the Rules mirror in place');
  await checkVisibleCopy(cdp, `(${mirror})?.innerText`, ['Risky:', '500-503', dropMessage], 'updated Rules mirror');
  report(true, 'mobile Rules mirror: provider identity, warnings and in-place save');

  await mobileClick(cdp, 'Add rule');
  await awaitDialog();
  await setMobileField(cdp, 'rule-action', 'EXHAUSTED');
  await checkVisibleCopy(cdp, dialogText, [EXHAUSTED_LABEL, 'comes back when it has balance'], 'rule action caption');
  const ruleCaption = `document.getElementById(document.getElementById('rule-action')?.getAttribute('aria-describedby'))`;
  ok(await cdp.evaluate(`(${wrapsText.toString()})(${ruleCaption})`), 'mobile: rule consequence caption must wrap');
  await checkMobileLayout(cdp, 'ordinary rule drawer', DIALOG);
  await mobileClick(cdp, 'Discard rule', DIALOG);
  await awaitClosed();

  await setMobileField(cdp, 'tester-scope', String(providerId));
  await setMobileField(cdp, 'tester-status', '403');
  await setMobileField(cdp, 'tester-body', dropMessage);
  await mobileClick(cdp, 'Classify sample');
  const tester = `[...document.querySelectorAll('main [role=status]')].find((el) => el.innerText.startsWith('This would:'))`;
  ok(await cdp.waitFor(`Boolean(${tester})`), 'mobile: Rule tester did not render a result');
  await checkVisibleCopy(cdp, `(${tester})?.innerText`, [DROP_LABEL, `matched ${tag}'s drop list`, 'Stays off. Requests and cron never use it until you press Re-enable.'], 'Rule tester result');
  await checkMobileLayout(cdp, 'Rule tester result');
  report(true, 'mobile Rules: longest action caption and tester match attribution');

  await mobileRoute(cdp, 'logs');
  const logRow = `[...document.querySelectorAll('[aria-label^="Request at"]')].find((row) => row.getAttribute('aria-label').includes(${JSON.stringify(auditModel)}))`;
  ok(await cdp.waitFor(`Boolean(${logRow})`), 'mobile: the seeded request is missing in Logs');
  await cdp.evaluate(`(${logRow}).click()`);
  await awaitDialog();
  await checkVisibleCopy(cdp, dialogText, [auditModel, tag, DROP_LABEL, '403', suffix], 'Logs attempt');
  ok(await cdp.evaluate(`(${wrapsText.toString()})(${findExact('section[aria-label="Attempts"] li p', suffix)})`), 'mobile: attempt reason must wrap');
  await checkMobileLayout(cdp, 'Logs attempt drawer', DIALOG);
  await mobileClick(cdp, 'Close request details', DIALOG);
  await awaitClosed();
  report(true, 'mobile Logs: exact request, readable drop action and wrapped reason');
}

async function auditRuleCounts(cookie, cdp) {
  ok(persistence, 'rule count fixtures require disposable local D1');
  const tag = `audit-count-${crypto.randomUUID().slice(0, 12)}`;
  const api = checkedAdmin.bind(null, cookie);
  const rules = async () => (await api('GET', '/rules')).rules;
  const expectCount = async (count, dropRows) => {
    await mobileRoute(cdp, 'settings');
    ok(await cdp.waitFor(`document.querySelector('main')?.innerText.includes('Error rules (${count})')`), `mobile Rules: expected heading count ${count}`);
    ok(await cdp.evaluate(`document.querySelectorAll(${JSON.stringify(RULE_CARDS)}).length === ${count} &&
      [...document.querySelectorAll(${JSON.stringify(RULE_CARDS + ' button')})].filter((button) => button.innerText === 'Edit in provider').length === ${dropRows}`),
    `mobile Rules: expected ${count} cards and ${dropRows} provider controls`);
    if (count === 0) await checkVisibleCopy(cdp, `document.querySelector('main').innerText`, ['No error rules yet. The built-in fallback still applies.'], 'zero Rules');
    await checkMobileLayout(cdp, `Rules with ${count} rows`);
    report(true, `mobile Rules: ${count} rows including ${dropRows} drop lists`);
  };

  const providerIds = [];
  try {
    // This is the freshly migrated local database owned by this run.
    for (const rule of await rules()) await api('DELETE', `/rules/${rule.id}`);
    await expectCount(0, 0);
    for (let i = 0; i < 5; i += 1) {
      const provider = await api('POST', '/providers', { name: `${tag}-${i}`, base_url: 'http://127.0.0.1:9', drop_codes: '403', add_to_default: false }, 201);
      providerIds.push(provider.id);
      if (i === 0) await expectCount(1, 1);
    }
    const regex = 'long-synthetic-regex-'.repeat(8).slice(0, 150);
    const note = `${tag} ${'audit-long-note-'.repeat(9)}end`;
    for (let i = 0; i < 25; i += 1) {
      await api('POST', '/rules', { priority: i, status_codes: '402', action: 'EXHAUSTED', note: i === 0 ? note : `${tag} ${i}`,
        ...(i === 0 ? { body_regex: regex } : {}) }, 201);
    }
    await expectCount(30, 5);
    const cardList = `[...document.querySelectorAll(${JSON.stringify(RULE_CARDS)})]`;
    for (const ending of [regex, note]) {
      ok(await cdp.evaluate(`(${wrapsText.toString()})((${cardList})[5]?.querySelectorAll('p') &&
        [...(${cardList})[5].querySelectorAll('p')].find((el) => el.innerText.endsWith(${JSON.stringify(ending)})))`), 'mobile Rules: long regex and note must wrap');
    }
    await checkVisibleCopy(cdp, `(${cardList})[5]?.innerText`, [EXHAUSTED_LABEL, regex, note], 'long rule copy');
    report(true, 'mobile Rules: long regex and note wrap inside the rule card');
  } finally {
    for (const rule of await rules()) {
      if (rule.note?.startsWith(`${tag} `)) await api('DELETE', `/rules/${rule.id}`);
    }
    for (const id of providerIds) await api('DELETE', `/providers/${id}`);
  }
}

async function auditPricing(cdp, cookie) {
  const api = checkedAdmin.bind(null, cookie);
  const long = 'a-' + 'unpriced'.repeat(48);
  const missing = 'b-no-catalog-rates';
  const ambiguous = 'c-smoke-family-20251231-thinking';
  const candidates = ['anthropic/c-smoke-family-20250101', 'openai/c-smoke-family-20250102'];
  const zero = 'd-explicit-zero';
  const legacy = 'e-legacy-cost';
  const noUsage = 'f-no-usage';
  const inventory = [long, missing, ambiguous, zero, ...Array.from({ length: 51 }, (_, i) => `z-smoke-${i}`)];
  const base = {
    input_cost_per_token: 0.000003, output_cost_per_token: 0.000015,
    cache_read_input_token_cost: 0.0000003, cache_creation_input_token_cost: 0.00000375,
    input_cost_per_token_above_100k_tokens: 0.000006, output_cost_per_token_above_100k_tokens: 0.00003,
  };
  const catalog = {
    [candidates[0]]: base, [candidates[1]]: base, [missing]: {},
    [zero]: Object.fromEntries(Object.keys(base).slice(0, 4).map((field) => [field, 0])),
    unrelated: base,
  };
  const relay = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url.split('?')[0] === '/v1/models') return res.end(JSON.stringify({ data: [{ id: long }] }));
    if (req.headers['x-api-key'] === 'sk-smoke-price-1') {
      req.resume();
      return res.writeHead(403).end(JSON.stringify({ error: { message: 'Fixture key rejection' } }));
    }
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const { model } = JSON.parse(body);
      const usage = { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 1 };
      res.end(JSON.stringify({ id: 'smoke-price', content: [], ...(model === noUsage ? {} : { usage }) }));
    });
  });
  const mobile = async (width) => {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width, height: 800, deviceScaleFactor: 2, mobile: width === 360 });
    ok(await cdp.waitFor(`innerWidth === ${width} && matchMedia('(min-width: 768px)').matches === ${width >= 768}`),
      `pricing viewport did not reach ${width}px`);
    await cdp.evaluate('new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))');
  };
  const visible = (selector, copy) =>
    `[...document.querySelectorAll(${JSON.stringify(selector)})].some((el) => el.getClientRects().length && el.textContent.includes(${JSON.stringify(copy)}))`;
  const expectCopy = async (selector, copy) => ok(await cdp.waitFor(visible(selector, copy)), `pricing: missing "${copy}" in ${selector}`);
  const group = (name) => `[aria-labelledby="needs-attention-title"] [aria-label="${name}"]`;
  const priceTable = '[aria-labelledby="price-table-title"]';
  const unpricedList = '[aria-labelledby="unpriced-models-title"]';
  const rowFor = (section, model) =>
    `[...document.querySelectorAll(${JSON.stringify(section + ' tbody tr, ' + section + ' [role=listitem]')})].find((row) => row.innerText.includes(${JSON.stringify(model)}))`;
  const clickRow = async (section, model, label) => {
    const button = `[...(${rowFor(section, model)})?.querySelectorAll('button') || []].find((el) => el.innerText.trim() === ${JSON.stringify(label)})`;
    ok(await cdp.waitFor(`!!(${button})`), `pricing: "${label}" missing for ${model}`);
    await cdp.evaluate(`(${button}).click()`);
  };
  const waitDialogClosed = async () => ok(await cdp.waitFor(`!document.querySelector('${DIALOG}')`), 'pricing dialog did not close');
  const logDetail = async (model, cost, details = []) => {
    const label = `[...document.querySelectorAll('[aria-label^="Request at"]')].find((el) =>
      el.getAttribute('aria-label').includes(${JSON.stringify(model + ', HTTP')}) &&
      el.getAttribute('aria-label').includes(${JSON.stringify('Cost: ' + cost)}))`;
    ok(await cdp.waitFor(`(${label})?.innerText.includes(${JSON.stringify(cost)})`), `request row cost missing for ${model}`);
    await cdp.evaluate(`(${label}).click()`);
    for (const detail of ['List-price cost', cost, ...details]) await expectCopy(DIALOG, detail);
    if ((await cdp.evaluate('innerWidth')) === 360) await checkMobileLayout(cdp, `log detail ${model}`, DIALOG);
    await mobileClick(cdp, 'Close request details', DIALOG);
    await waitDialogClosed();
  };
  let catalogHits = 0;
  let catalogFailure = false;
  let localFailure = '';
  let holdPath = '';
  let heldRequest = null;
  let interceptionError;
  let providerId;
  let routeId;
  const continueRequest = (requestId) => cdp.send('Fetch.continueRequest', { requestId });
  const fulfill = (requestId, code, body, headers = []) => cdp.send('Fetch.fulfillRequest', {
    requestId, responseCode: code, body: Buffer.from(JSON.stringify(body)).toString('base64'),
    responseHeaders: [{ name: 'content-type', value: 'application/json' }, ...headers],
  });
  cdp.on('Fetch.requestPaused', ({ requestId, request }) => {
    void (async () => {
      if (request.url === PRICE_CATALOG_URL) {
        ok(request.method === 'GET' && !Object.keys(request.headers).some((name) => /^(cookie|authorization)$/i.test(name)),
          'catalog request sent credentials');
        catalogHits += 1;
        if (holdPath === 'catalog') {
          await new Promise((resolve) => { heldRequest = resolve; });
        }
        await fulfill(requestId, catalogFailure ? 503 : 200, catalog, [{ name: 'access-control-allow-origin', value: '*' }]);
        return;
      }
      const path = new URL(request.url).pathname;
      if (localFailure === path) {
        await fulfill(requestId, 503, { error: { message: 'Fixture request failed' } });
      } else if (holdPath === path && !heldRequest) {
        heldRequest = () => continueRequest(requestId);
      } else {
        await continueRequest(requestId);
      }
    })().catch((error) => {
      interceptionError = error;
      void cdp.send('Fetch.failRequest', { requestId, errorReason: 'Failed' }).catch(() => {});
    });
  });
  const releaseRequest = async () => {
    const resume = await until(() => heldRequest, `browser never requested ${holdPath}`);
    holdPath = '';
    heldRequest = null;
    await resume();
  };
  const startNavigation = (route) => cdp.send('Page.navigate', { url: `${BASE}/?audit=${crypto.randomUUID()}#/${route}` });
  try {
    await cdp.send('Fetch.enable', { patterns: [{ urlPattern: PRICE_CATALOG_URL }, { urlPattern: BASE + '/api/admin/*' }] });
    await mobileRoute(cdp, 'overview');
    await expectCopy(group('Dropped keys'), '0');
    await expectCopy(group('Unpriced models'), '0');
    await mobileClick(cdp, 'More', 'nav[aria-label="Dashboard navigation"]');
    await checkMobileLayout(cdp, 'pricing More', DIALOG);
    await cdp.evaluate(`document.querySelector('${DIALOG} a[href="#/prices"]').click()`);
    await expectCopy('main h1', 'Prices');
    await waitDialogClosed();
    await expectCopy('main', 'No prices saved.');
    ok(await cdp.evaluate(`document.activeElement?.tagName === 'MAIN' && location.hash === '#/prices'`), 'More did not focus the Prices view');
    await mobileClick(cdp, 'More', 'nav[aria-label="Dashboard navigation"]');
    ok(await cdp.waitFor(`!!document.querySelector('${DIALOG} a[href="#/prices"][aria-current="page"]')`), 'More did not mark Prices current');
    await cdp.evaluate(`document.querySelector('${DIALOG} a[href="#/prices"]').click()`);
    await waitDialogClosed();

    await once(relay.listen(0, '127.0.0.1'), 'listening');
    ({ id: providerId } = await api('POST', '/providers', {
      name: 'Price fixture', base_url: `http://127.0.0.1:${relay.address().port}`, keys: 'sk-smoke-price-1\nsk-smoke-price-2',
      formats: ['anthropic'], parse_usage: true, add_to_default: false, drop_codes: '403',
    }, 201));
    await mobileRoute(cdp, 'overview');
    await expectCopy(group('Unpriced models'), long);
    ok((await cdp.evaluate(`document.querySelector('${group('Unpriced models')}').querySelectorAll('li').length`)) === 1,
      'a single unpriced model must render one preview name');
    await mobileRoute(cdp, 'prices');
    await clickRow(unpricedList, long, 'Pin alias');
    await expectCopy(DIALOG, 'No priced catalog models available.');
    ok(await cdp.evaluate(`[...document.querySelectorAll('${DIALOG} button')].some((button) => button.innerText === 'Save alias' && button.disabled)`),
      'the empty alias picker must disable Save alias');
    await mobileClick(cdp, 'Cancel alias edit', DIALOG);
    await waitDialogClosed();
    ok(await cdp.waitFor(`document.activeElement?.getAttribute('aria-label')?.startsWith('Pin alias for ')`),
      'dismissing the alias editor did not restore focus to its row action');

    await api('PUT', `/providers/${providerId}`, { model_map: Object.fromEntries(inventory.map((model) => [model, model])) });
    const provider = (await api('GET', '/providers')).providers.find(({ id }) => id === providerId);
    await api('PUT', `/keys/${provider.keys[0].id}`, { alias: 'Dropped fixture' });
    ({ id: routeId } = await api('POST', '/routes', {
      name: 'Pricing smoke route', model_patterns: ['*'], provider_ids: [providerId],
    }, 201));
    const { key } = await api('POST', '/gateway-keys', { name: 'Pricing smoke key', route_id: routeId }, 201);
    const proxy = async (model) => {
      const response = await fetch(BASE + '/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model, max_tokens: 2, messages: [{ role: 'user', content: 'hi' }] }),
        signal: AbortSignal.timeout(10_000),
      });
      ok(response.ok && (await response.json()).id === 'smoke-price', `pricing proxy did not succeed for ${model}`);
      return until(async () => (await api('GET', `/logs?model=${encodeURIComponent(model)}`)).logs.find((log) => log.model === model),
        `pricing proxy log did not commit for ${model}`);
    };

    localFailure = '/api/admin/prices';
    await mobileRoute(cdp, 'prices');
    await expectCopy('main', 'Failed to load prices.');
    localFailure = '';
    await cdp.evaluate(`document.querySelector('[aria-label="Retry loading prices"]').click()`);
    await expectCopy('main', 'No prices saved.');
    holdPath = 'catalog';
    await mobileClick(cdp, 'Refresh prices');
    await expectCopy('main', 'Refreshing prices…');
    ok(await cdp.evaluate(`[...document.querySelectorAll('main button')].some((button) => button.innerText === 'Refreshing prices…' && button.disabled)`),
      'catalog refresh must block a duplicate submit');
    await expectCopy(priceTable, 'No prices saved.');
    await releaseRequest();
    await expectCopy(priceTable, candidates[0]);
    await expectCopy(priceTable, '$0.00');
    await expectCopy(unpricedList, missing);
    ok(!(await cdp.evaluate(visible(unpricedList, zero))), 'zero price must leave the unpriced list');
    await expectCopy(unpricedList, 'Multiple matches. Choose a model to pin.');
    const imported = (await api('GET', '/prices')).prices;
    ok(imported.length === 4 && imported.every((price) => price.model !== 'unrelated') && imported.find((price) => price.model === missing).effective_base.input === null,
      'browser did not import the complete relevant slim catalog');
    ok(catalogHits === 1, `expected one catalog request, got ${catalogHits}`);
    catalogFailure = true;
    await mobileClick(cdp, 'Refresh prices');
    await expectCopy('main [role=alert]', 'The last saved prices are still in use.');
    await expectCopy(priceTable, candidates[0]);
    catalogFailure = false;
    await checkMobileLayout(cdp, 'Prices with imported and unpriced rows');
    ok(await cdp.evaluate(`(${wrapsText.toString()})([...(${rowFor(unpricedList, long)}).querySelectorAll('span')].find((el) => el.textContent === ${JSON.stringify(long)}))`),
      '360px unpriced model did not wrap');

    await clickRow(unpricedList, ambiguous, 'Pin alias');
    await expectCopy(DIALOG, 'Matching candidates');
    ok(await cdp.evaluate(`document.getElementById('priced-catalog-model').value === '' &&
      JSON.stringify([...document.querySelectorAll('[label="Matching candidates"] option')].map((el) => el.value)) === ${JSON.stringify(JSON.stringify(candidates))}`),
      'ambiguous alias picker must list candidates in order with no automatic selection');
    await checkMobileLayout(cdp, 'ambiguous alias', DIALOG);
    await setMobileField(cdp, 'priced-catalog-model', candidates[0]);
    await mobileClick(cdp, 'Save alias', DIALOG);
    await waitDialogClosed();
    ok(await cdp.waitFor(`!(${rowFor(unpricedList, ambiguous)})`), 'pin did not refresh the unpriced list');
    ok(await cdp.waitFor(`document.activeElement?.id === 'unpriced-models-title'`),
      'saving an alias did not return focus to the list when its row disappeared');
    const captured = await proxy(ambiguous);
    ok(captured.cost_nano_usd === 64_650 && captured.priced_model === candidates[0] && captured.price_match_type === 'pinned',
      'real proxy request did not persist expected pinned price and cost');
    ok((await proxy(zero)).cost_nano_usd === 0, 'explicit zero amount did not persist');
    ok((await proxy(noUsage)).cost_reason === 'no_usage', 'no-usage reason did not persist');
    ok((await proxy(long)).cost_reason === 'unpriced', 'unpriced reason did not persist');

    const legacySql = `INSERT INTO request_logs (ts, model, upstream_model, status, format, path) VALUES (${Date.now()}, '${legacy}', '${legacy}', 200, 'anthropic', '/v1/messages')`;
    const legacyInsert = spawnSync('npx', ['--no-install', 'wrangler', 'd1', 'execute', 'DB', '--local',
      '--persist-to', persistence, '--command', legacySql], { stdio: 'ignore', timeout: 30_000 });
    ok(legacyInsert.status === 0, 'could not write a legacy request on disposable local D1');
    await mobileRoute(cdp, 'logs');
    await logDetail(ambiguous, '$0.00006465', [candidates[0], 'Pinned alias', 'Cache read', 'Cache write']);
    await logDetail(zero, '$0.00');
    await logDetail(noUsage, 'No usage reported');
    await logDetail(long, 'Unpriced');
    await logDetail(legacy, 'Cost unavailable', ['Pricing details weren’t recorded for this request.']);

    await mobileRoute(cdp, 'prices');
    await clickRow(priceTable, candidates[0], 'Edit price');
    await setMobileField(cdp, 'price-base-input', '7.5');
    await setMobileField(cdp, 'price-base-output', '20');
    ok(await cdp.waitFor(`document.querySelector('${DIALOG}')?.getBoundingClientRect().bottom <= innerHeight + 0.5`),
      'phone price drawer did not settle into the viewport');
    await checkMobileLayout(cdp, 'price edit and sticky footer', DIALOG);
    const footerBox = await cdp.evaluate(`(() => {
      const dialog = document.querySelector('${DIALOG}');
      const field = document.getElementById('price-tier-cache_write');
      field.scrollIntoView({ block: 'end' });
      const save = [...dialog.querySelectorAll('button')].find((button) => button.innerText === 'Save price');
      const box = save.getBoundingClientRect();
      return { top: box.top, bottom: box.bottom, height: box.height, viewport: innerHeight, dialogTop: dialog.getBoundingClientRect().top };
    })()`);
    ok(footerBox.top >= footerBox.dialogTop - 0.5 && footerBox.bottom <= footerBox.viewport + 0.5 && footerBox.height >= 43.5,
      `price editor footer is not reachable after scrolling the rate fields: ${JSON.stringify(footerBox)}`);
    await mobile(768);
    ok(await cdp.waitFor(`document.querySelector('[data-slot="dialog-content"] input#price-base-input')?.value === '7.5'`),
      'price draft did not survive switching from drawer to dialog at 768px');
    await mobile(360);
    ok(await cdp.waitFor(`document.querySelector('[data-slot="drawer-content"] input#price-base-output')?.value === '20'`),
      'price draft did not survive switching back to the drawer');
    localFailure = '/api/admin/prices/override';
    await mobileClick(cdp, 'Save price', DIALOG);
    await expectCopy(DIALOG, 'Couldn’t save the price.');
    ok(await cdp.evaluate(`document.getElementById('price-base-input').value === '7.5'`), 'a failed save cleared the price draft');
    localFailure = '';
    holdPath = '/api/admin/prices/override';
    await mobileClick(cdp, 'Save price', DIALOG);
    await expectCopy(DIALOG, 'Saving price…');
    await releaseRequest();
    await waitDialogClosed();
    await expectCopy(priceTable, '$7.50');
    await mobileClick(cdp, 'Refresh prices');
    await expectCopy('body', 'Prices refreshed.');
    await expectCopy(priceTable, '$7.50');
    await clickRow(priceTable, candidates[0], 'Edit price');
    await mobileClick(cdp, 'Use catalog rate', DIALOG);
    ok(await cdp.evaluate(`document.getElementById('price-base-input').value === '3' && document.getElementById('price-base-output').value === '20'`),
      'reset did not apply to exactly one field in the draft');
    await mobileClick(cdp, 'Save price', DIALOG);
    await waitDialogClosed();
    const saved = (await api('GET', '/prices')).prices.find((price) => price.model === candidates[0]);
    ok(saved.effective_base.input === 3_000_000 && saved.effective_base.output === 20_000_000, 'one-field reset did not preserve the other override');
    await api('PUT', '/prices/alias', { upstream_model: ambiguous, priced_model: candidates[1] });

    await mobile(1280);
    await mobileRoute(cdp, 'logs');
    ok(await cdp.waitFor(`[...document.querySelectorAll('th')].some((el) => el.innerText === 'Cost')`), 'desktop Cost column missing');
    await logDetail(ambiguous, '$0.00006465', [candidates[0], 'Pinned alias']);
    await setMobileField(cdp, 'lf-model', long);
    await cdp.evaluate(`document.getElementById('lf-model').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))`);
    ok(await cdp.waitFor(`[...document.querySelectorAll('main tbody tr')].filter((row) => row.getClientRects().length).length === 1`),
      'desktop Logs did not filter to the full-length model name');
    await logDetail(long, 'Unpriced');
    await mobileClick(cdp, 'Clear');
    const after = (await api('GET', `/logs?model=${ambiguous}`)).logs.find((log) => log.id === captured.id);
    ok(JSON.stringify(after) === JSON.stringify(captured), 'price and alias edits changed a captured row');
    await mobile(768);
    await mobileRoute(cdp, 'logs');
    ok(await cdp.evaluate(`document.documentElement.scrollWidth <= innerWidth && [...document.querySelectorAll('main [data-slot]')].some((el) => el.scrollWidth > el.clientWidth && /auto|scroll/.test(getComputedStyle(el).overflowX))`),
      '768px logs table must scroll within its list');

    const dropped = group('Dropped keys');
    const unpriced = group('Unpriced models');
    localFailure = '/api/admin/providers';
    holdPath = '/api/admin/prices/models';
    await startNavigation('overview');
    ok(await cdp.waitFor(`!!document.querySelector('${unpriced} [data-slot="skeleton"]') &&
      !document.querySelector('${unpriced} p[aria-label]')`), 'pending model inventory must show a skeleton without a zero');
    await releaseRequest();
    await expectCopy(dropped, 'Couldn’t load dropped keys.');
    await expectCopy(unpriced, '+52 more');
    ok(await cdp.evaluate(`JSON.stringify([...document.querySelectorAll('${unpriced} li')].map((el) => el.innerText)) ===
      ${JSON.stringify(JSON.stringify([long, missing, legacy, '+52 more']))}`), 'Overview did not render the complete ordered model preview');
    ok(await cdp.evaluate(`!!document.querySelector('${dropped} a[href="#/providers"]') && !!document.querySelector('${unpriced} a[href="#/prices"]')`),
      'Overview destinations are absent during a partial failure');
    localFailure = '/api/admin/prices/models';
    await cdp.evaluate(`document.querySelector('[aria-label="Refresh overview"]').click()`);
    await expectCopy(unpriced, 'Couldn’t load unpriced models.');
    await expectCopy(dropped, 'Price fixture / Dropped fixture');
    await expectCopy('main', 'Traffic & Errors');
    localFailure = '';
    await cdp.evaluate(`document.querySelector('[aria-label="Refresh overview"]').click()`);
    await expectCopy(unpriced, missing);
    ok(await cdp.evaluate(`Math.abs(document.querySelector('${dropped}').offsetWidth - document.querySelector('${unpriced}').offsetWidth) < 2`),
      '768px Overview attention columns are not equal');
    await mobile(360);
    await mobileRoute(cdp, 'overview');
    await expectCopy(unpriced, missing);
    await checkMobileLayout(cdp, 'Overview attention');
    ok(await cdp.evaluate(`document.querySelector('${dropped}').getBoundingClientRect().bottom <= document.querySelector('${unpriced}').getBoundingClientRect().top`),
      '360px Overview attention groups did not stack');
    if (interceptionError) throw interceptionError;
    report(true, 'Phase 4 pricing, frozen Request Logs and Overview', 'real local D1 and built Chromium at 360, 768 and 1280px');
  } finally {
    try {
      if (heldRequest) await heldRequest();
      await cdp.send('Fetch.disable');
      if (routeId !== undefined) {
        const { keys } = await api('GET', '/gateway-keys');
        for (const key of keys) if (key.route_id === routeId) await api('DELETE', `/gateway-keys/${key.id}`);
        await api('DELETE', `/routes/${routeId}`);
      }
      if (providerId !== undefined) await api('DELETE', `/providers/${providerId}`);
    } finally {
      if (relay.listening) await new Promise((resolve) => relay.close(resolve));
    }
  }
}

async function checkMobile(cookie) {
  const chrome = findChrome();
  if (!chrome) {
    report(false, 'mobile audit: headless Chromium', 'no Chrome found; set CHROME_BIN');
    return;
  }
  const profile = mkdtempSync(join(tmpdir(), 'gw-mobile-chrome-'));
  const args = ['--headless=new', '--disable-gpu', '--remote-debugging-port=0', '--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1', `--user-data-dir=${profile}`, '--no-first-run', 'about:blank'];
  if (typeof process.getuid === 'function' && process.getuid() === 0) args.push('--no-sandbox');
  const proc = spawn(chrome, args, { stdio: 'ignore' });
  let cdp = null;
  try {
    const target = await until(async () => {
      try {
        const port = Number(readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]);
        if (!port) return null;
        const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
        return list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      } catch {
        return null;
      }
    }, 'mobile audit: Chromium did not expose a debugging target');
    cdp = await connectCdp(target.webSocketDebuggerUrl);
    await cdp.send('Page.enable');
    await cdp.send('Network.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 360, height: 800, deviceScaleFactor: 2, mobile: true });
    const [name, ...rest] = cookie.split('=');
    await cdp.send('Network.setCookie', { name, value: rest.join('='), url: BASE, path: '/api', httpOnly: true, sameSite: 'Strict' });

    const nav = await auditAllRoutes(cdp, 'empty-db', 0);
    await auditPricing(cdp, cookie);
    await keyDropLifecycle(cookie, async (fixture) => {
      await auditAllRoutes(cdp, 'seeded', nav);
      await auditDropUi(cdp, fixture);
    });
    await auditRuleCounts(cookie, cdp);
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
  const password = await ensureServer(vars.ADMIN_PASSWORD);

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
    body: JSON.stringify({ password }),
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
  ok(cookieOk, 'Worker did not authenticate this run. Stopping before fixture changes.');

  // 7. Session probe with the cookie.
  const session = await fetch(`${BASE}/api/admin/session`, { headers: { cookie } });
  await session.arrayBuffer();
  report(session.status === 200, 'check 7: GET /api/admin/session with the cookie is 200', `status ${session.status}`);
  ok(session.status === 200, 'Worker did not recognize the session. Stopping before fixture changes.');

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
      ['content-security-policy', (v) => {
        const connect = v.split(';').map((d) => d.trim()).filter((d) => d.startsWith('connect-src '));
        return v.includes("default-src 'self'") && v.includes("frame-ancestors 'none'") &&
          connect.length === 1 && connect[0].split(/\s+/).slice(1).sort().join(' ') === "'self' https://raw.githubusercontent.com";
      }],
    ];
    const securityProblems = (res) => SECURITY.filter(([name, ok]) => !ok(res.headers.get(name) || '')).map(([name]) => name);
    for (const path of ['/', '/some/unknown/path']) {
      const res = await fetch(`${BASE}${path}`);
      await res.arrayBuffer();
      const missing = securityProblems(res);
      report(
        res.status === 200 && missing.length === 0 && !/\bimmutable\b/i.test(res.headers.get('cache-control') || ''),
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

  await providerRoundTrip(cookie);
  if (CHECK_MOBILE) await checkMobile(cookie);
  else if (persistence) await keyDropLifecycle(cookie);

  console.log(`\n${passes} passed, ${failures} failed`);
  process.exitCode = failures > 0 ? 1 : 0;
}

main().finally(stopServer).catch((err) => {
  console.error('FAIL smoke script crashed:', err?.message ?? err);
  process.exitCode = 1;
});
