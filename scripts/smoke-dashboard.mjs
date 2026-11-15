#!/usr/bin/env node
// End-to-end smoke check for the rebuilt dashboard, run against `wrangler dev` on 127.0.0.1:8787.
//
//   node scripts/smoke-dashboard.mjs                  checks 1-10
//   node scripts/smoke-dashboard.mjs --check-headers  also checks 11-16 (cache headers on built assets, security
//                                                     headers, manifest and icons, no Google font host, no-store)
//   node scripts/smoke-dashboard.mjs --skip-render    skip check 10 (no Chrome on this machine)
//
// Env: CHROME_BIN optionally points at a Chrome or Chromium binary for check 10.
// The script only ever talks to 127.0.0.1:8787 and never deploys anything.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const BASE = 'http://127.0.0.1:8787';
const DEV_VARS_PATH = new URL('../.dev.vars', import.meta.url);
const CHECK_HEADERS = process.argv.includes('--check-headers');
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
    console.log(`Using the Worker already running at ${BASE}`);
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

  console.log(`\n${passes} passed, ${failures} failed`);
  stopChild();
  process.exit(failures > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('FAIL smoke script crashed:', err?.message ?? err);
  stopChild();
  process.exit(1);
});
