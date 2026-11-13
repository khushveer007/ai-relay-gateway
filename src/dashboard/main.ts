import { api, copyButtonHtml, esc, initGlobalInteractions, setUnauthorizedHandler, toast } from './api';
import { renderGatewayKeys } from './views/gateway-keys';
import { renderLogs } from './views/logs';
import { renderOverview } from './views/overview';
import { renderProviders } from './views/providers';
import { renderRoutes } from './views/routes';
import { renderSettings } from './views/settings';

type ViewId = 'overview' | 'providers' | 'routes' | 'gateway-keys' | 'logs' | 'settings';

const NAV_ITEMS: Array<{ id: ViewId; label: string; icon: string }> = [
  { id: 'overview', label: 'Overview', icon: '◈' },
  { id: 'providers', label: 'Providers & Keys', icon: '⚡' },
  { id: 'routes', label: 'Routes & Chains', icon: '⇄' },
  { id: 'gateway-keys', label: 'Gateway Keys', icon: '🔑' },
  { id: 'logs', label: 'Request Logs', icon: '▤' },
  { id: 'settings', label: 'Rules & Settings', icon: '⚙' },
];

const appEl = document.getElementById('app')!;

function currentViewFromHash(): ViewId {
  const h = window.location.hash.replace(/^#\/?/, '') as ViewId;
  return NAV_ITEMS.some((n) => n.id === h) ? h : 'overview';
}

function renderLogin(errorMsg?: string): void {
  appEl.innerHTML = `
    <div class="login-screen">
      <form class="login-card" id="login-form">
        <div class="brand" style="padding:0">
          <div class="brand-icon">⇄</div>
          <div>
            <div class="brand-title" style="font-size:1.1rem">AI Relay Gateway</div>
            <div class="brand-sub">Multi-provider key rotation &amp; failover</div>
          </div>
        </div>
        ${
          errorMsg
            ? `<div style="padding:0.6rem 0.75rem;border-radius:var(--radius-sm);background:var(--status-danger-bg);color:var(--status-danger);font-size:0.82rem">${esc(
                errorMsg,
              )}</div>`
            : ''
        }
        <div class="field">
          <label for="login-password">Admin Password</label>
          <input type="password" id="login-password" name="password" autocomplete="current-password" required autofocus placeholder="Enter ADMIN_PASSWORD" />
        </div>
        <button type="submit" class="btn btn-primary" id="login-btn" style="inline-size:100%">Sign In to Dashboard</button>
      </form>
    </div>
  `;

  document.getElementById('login-form')?.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const btn = document.getElementById('login-btn') as HTMLButtonElement;
    const pw = (document.getElementById('login-password') as HTMLInputElement).value;
    btn.disabled = true;
    btn.textContent = 'Signing in…';
    try {
      await api.post('/login', { password: pw });
      renderAppShell();
    } catch (e) {
      renderLogin((e as Error).message);
    }
  });
}

function renderAppShell(): void {
  const origin = window.location.origin;
  appEl.innerHTML = `
    <div class="shell">
      <aside class="sidebar">
        <div class="brand">
          <div class="brand-icon">⇄</div>
          <div>
            <div class="brand-title">AI Relay Gateway</div>
            <div class="brand-sub">Cloudflare Workers</div>
          </div>
        </div>

        <nav aria-label="Dashboard navigation" style="flex:1;display:flex">
          <ul class="nav-list">
            ${NAV_ITEMS.map(
              (item) => `<li>
                <button type="button" class="nav-btn" data-nav="${item.id}">
                  <span class="nav-btn-left">
                    <span aria-hidden="true">${item.icon}</span>
                    <span>${esc(item.label)}</span>
                  </span>
                </button>
              </li>`,
            ).join('')}
          </ul>
        </nav>

        <div class="sidebar-footer">
          <div class="endpoint-box">
            <div style="display:flex;align-items:center;justify-content:space-between;margin-block-end:0.2rem">
              <span class="endpoint-box-label">Proxy Base URL</span>
              ${copyButtonHtml('sidebar-proxy-url', 'Copy proxy base URL', 'Copy')}
            </div>
            <div class="endpoint-box-url" id="sidebar-proxy-url">${esc(origin)}</div>
          </div>
          <button type="button" class="btn btn-sm btn-ghost" id="btn-logout" style="justify-content:flex-start">↪ Sign out</button>
        </div>
      </aside>

      <main class="main-content" id="view-root"></main>
    </div>
  `;

  appEl.querySelectorAll<HTMLButtonElement>('button[data-nav]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const target = btn.dataset.nav as ViewId;
      window.location.hash = target;
    });
  });

  document.getElementById('btn-logout')?.addEventListener('click', async () => {
    await api.post('/logout').catch(() => {});
    renderLogin();
  });

  navigateTo(currentViewFromHash());
}

async function navigateTo(view: ViewId): Promise<void> {
  const root = document.getElementById('view-root');
  if (!root) return;

  appEl.querySelectorAll<HTMLButtonElement>('button[data-nav]').forEach((btn) => {
    if (btn.dataset.nav === view) btn.setAttribute('aria-current', 'page');
    else btn.removeAttribute('aria-current');
  });

  try {
    switch (view) {
      case 'overview':
        await renderOverview(root);
        break;
      case 'providers':
        await renderProviders(root);
        break;
      case 'routes':
        await renderRoutes(root);
        break;
      case 'gateway-keys':
        await renderGatewayKeys(root);
        break;
      case 'logs':
        await renderLogs(root);
        break;
      case 'settings':
        await renderSettings(root);
        break;
    }
  } catch (e) {
    toast((e as Error).message, 'error');
  }
}

async function boot(): Promise<void> {
  initGlobalInteractions();
  setUnauthorizedHandler(() => renderLogin('Please sign in to continue.'));
  window.addEventListener('hashchange', () => {
    if (document.getElementById('view-root')) {
      navigateTo(currentViewFromHash());
    }
  });

  try {
    await api.get('/session');
    renderAppShell();
  } catch {
    renderLogin();
  }
}

boot();
