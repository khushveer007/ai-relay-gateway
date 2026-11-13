import {
  api,
  copyButtonHtml,
  esc,
  fmtAgo,
  toast,
  type GatewayKeyDTO,
  type RouteDTO,
} from '../api';

let newlyCreatedKey: { name: string; key: string } | null = null;

export async function renderGatewayKeys(root: HTMLElement): Promise<void> {
  root.innerHTML = `<div class="empty-state">Loading gateway keys…</div>`;
  const [keysRes, routesRes] = await Promise.all([
    api.get<{ keys: GatewayKeyDTO[] }>('/gateway-keys'),
    api.get<{ routes: RouteDTO[] }>('/routes'),
  ]);

  const keys = keysRes.keys;
  const routes = routesRes.routes;
  const origin = window.location.origin;
  const sampleKey = newlyCreatedKey?.key ?? 'sk-gw-your-gateway-key';

  const claudeEnvSnippet = `export ANTHROPIC_BASE_URL="${origin}"
export ANTHROPIC_AUTH_TOKEN="${sampleKey}"`;

  const claudeSettingsSnippet = JSON.stringify(
    {
      env: {
        ANTHROPIC_BASE_URL: origin,
        ANTHROPIC_AUTH_TOKEN: sampleKey,
      },
    },
    null,
    2,
  );

  const codexTomlSnippet = `model_provider = "gateway"

[model_providers.gateway]
name = "AI Relay Gateway"
base_url = "${origin}/v1"
env_key = "GATEWAY_KEY"
wire_api = "responses"`;

  root.innerHTML = `
    <header class="page-header">
      <div>
        <h1 class="page-title">Gateway Keys &amp; Client Setup</h1>
        <p class="page-subtitle">Issue <code>sk-gw-…</code> keys for Claude Code, Codex, and OpenAI/Anthropic SDK clients. Keys are stored as SHA-256 hashes.</p>
      </div>
    </header>

    ${
      newlyCreatedKey
        ? `<section class="card" style="border-color:var(--status-ok);background:hsl(152 76% 46% / 0.08)">
            <div class="card-header" style="margin-block-end:0.5rem">
              <div>
                <h2 class="card-title" style="color:var(--status-ok)">New Gateway Key Created: ${esc(newlyCreatedKey.name)}</h2>
                <p class="card-subtitle">Copy this key now — only its SHA-256 hash is stored in D1, so it will never be shown again.</p>
              </div>
              <button type="button" class="btn btn-sm btn-ghost" id="dismiss-new-key">Dismiss</button>
            </div>
            <div class="code-block-wrap">
              <pre class="code-block"><code id="new-gw-key-val">${esc(newlyCreatedKey.key)}</code></pre>
              ${copyButtonHtml('new-gw-key-val', 'Copy newly created gateway key', 'Copy Key')}
            </div>
          </section>`
        : ''
    }

    <section class="card">
      <div class="card-header">
        <div>
          <h2 class="card-title">Create Gateway Key</h2>
          <p class="card-subtitle">Optionally pin a key to a specific route, or leave it on Auto to resolve routes by model pattern.</p>
        </div>
      </div>
      <form id="new-gw-key-form" style="display:flex;gap:0.75rem;flex-wrap:wrap;align-items:flex-end">
        <div class="field" style="flex:1;min-inline-size:220px">
          <label for="gwk-name">Key Name *</label>
          <input type="text" id="gwk-name" required placeholder="e.g. Laptop Claude Code / Codex CLI" />
        </div>
        <div class="field" style="min-inline-size:240px">
          <label for="gwk-route">Pinned Route</label>
          <select id="gwk-route">
            <option value="">Auto (match by model pattern → default)</option>
            ${routes.map((r) => `<option value="${r.id}">${esc(r.name)}${r.is_default ? ' (default)' : ''}</option>`).join('')}
          </select>
        </div>
        <button type="submit" class="btn btn-primary" id="gwk-submit">+ Generate Key</button>
      </form>
    </section>

    <section class="card">
      <div class="card-header">
        <div>
          <h2 class="card-title">Issued Gateway Keys (${keys.length})</h2>
        </div>
      </div>
      ${
        keys.length === 0
          ? `<div class="empty-state">No gateway keys created yet. Generate one above to start sending requests through the proxy.</div>`
          : `<div tabindex="0" role="region" aria-label="Issued gateway keys" class="table-wrapper">
              <table>
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Key Prefix</th>
                    <th>Route Binding</th>
                    <th>Status</th>
                    <th>Created</th>
                    <th style="text-align:end">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  ${keys
                    .map((k) => {
                      return `<tr>
                        <th>${esc(k.name)}</th>
                        <td><code class="tag">${esc(k.key_prefix)}…</code></td>
                        <td>
                          <select data-gwk-route="${k.id}" data-gwk-name="${esc(k.name)}" data-gwk-enabled="${k.enabled}" style="max-inline-size:220px;padding:0.28rem 0.5rem;font-size:0.8rem">
                            <option value="" ${k.route_id === null ? 'selected' : ''}>Auto (model pattern)</option>
                            ${routes
                              .map(
                                (r) =>
                                  `<option value="${r.id}" ${k.route_id === r.id ? 'selected' : ''}>${esc(r.name)}</option>`,
                              )
                              .join('')}
                          </select>
                        </td>
                        <td>
                          ${
                            k.enabled
                              ? `<span class="pill pill-active"><span class="pill-dot"></span>active</span>`
                              : `<span class="pill pill-disabled"><span class="pill-dot"></span>disabled</span>`
                          }
                        </td>
                        <td>${fmtAgo(k.created_at)}</td>
                        <td style="text-align:end">
                          <div style="display:inline-flex;gap:0.35rem">
                            <button type="button" class="btn btn-sm" data-gwk-toggle="${k.id}" data-gwk-name="${esc(k.name)}" data-gwk-route-id="${k.route_id ?? ''}" data-next-enabled="${!k.enabled}">
                              ${k.enabled ? 'Disable' : 'Enable'}
                            </button>
                            <button type="button" class="btn btn-sm btn-danger" data-gwk-del="${k.id}" data-gwk-name="${esc(k.name)}">Revoke</button>
                          </div>
                        </td>
                      </tr>`;
                    })
                    .join('')}
                </tbody>
              </table>
            </div>`
      }
    </section>

    <div class="grid-2">
      <section class="card">
        <div class="card-header">
          <div>
            <h2 class="card-title">Claude Code Setup</h2>
            <p class="card-subtitle">Shell environment variables or <code>~/.claude/settings.json</code></p>
          </div>
        </div>
        <div style="display:flex;flex-direction:column;gap:0.85rem">
          <div class="code-block-wrap">
            <pre class="code-block"><code id="snip-claude-env">${esc(claudeEnvSnippet)}</code></pre>
            ${copyButtonHtml('snip-claude-env', 'Copy Claude Code shell exports')}
          </div>
          <div class="code-block-wrap">
            <pre class="code-block"><code id="snip-claude-json">${esc(claudeSettingsSnippet)}</code></pre>
            ${copyButtonHtml('snip-claude-json', 'Copy Claude Code settings.json')}
          </div>
        </div>
      </section>

      <section class="card">
        <div class="card-header">
          <div>
            <h2 class="card-title">Codex CLI Setup</h2>
            <p class="card-subtitle">Add to <code>~/.codex/config.toml</code> and set <code>export GATEWAY_KEY="${esc(sampleKey)}"</code></p>
          </div>
        </div>
        <div class="code-block-wrap">
          <pre class="code-block"><code id="snip-codex-toml">${esc(codexTomlSnippet)}</code></pre>
          ${copyButtonHtml('snip-codex-toml', 'Copy Codex config.toml')}
        </div>
      </section>
    </div>
  `;

  root.querySelector('#dismiss-new-key')?.addEventListener('click', () => {
    newlyCreatedKey = null;
    renderGatewayKeys(root);
  });

  root.querySelector('#new-gw-key-form')?.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const btn = document.getElementById('gwk-submit') as HTMLButtonElement;
    btn.disabled = true;
    try {
      const name = (document.getElementById('gwk-name') as HTMLInputElement).value.trim();
      const routeVal = (document.getElementById('gwk-route') as HTMLSelectElement).value;
      const res = await api.post<{ key: string }>('/gateway-keys', {
        name,
        route_id: routeVal ? Number(routeVal) : null,
      });
      newlyCreatedKey = { name, key: res.key };
      toast('Gateway key created', 'ok');
      await renderGatewayKeys(root);
    } catch (e) {
      toast((e as Error).message, 'error');
      btn.disabled = false;
    }
  });

  root.querySelectorAll<HTMLSelectElement>('select[data-gwk-route]').forEach((sel) => {
    sel.addEventListener('change', async () => {
      const id = Number(sel.dataset.gwkRoute);
      const name = sel.dataset.gwkName!;
      const enabled = sel.dataset.gwkEnabled === 'true';
      try {
        await api.put(`/gateway-keys/${id}`, {
          name,
          route_id: sel.value ? Number(sel.value) : null,
          enabled,
        });
        toast('Route binding updated', 'ok');
      } catch (e) {
        toast((e as Error).message, 'error');
      }
    });
  });

  root.querySelectorAll<HTMLButtonElement>('button[data-gwk-toggle]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = Number(btn.dataset.gwkToggle);
      const name = btn.dataset.gwkName!;
      const routeId = btn.dataset.gwkRouteId ? Number(btn.dataset.gwkRouteId) : null;
      const enabled = btn.dataset.nextEnabled === 'true';
      btn.disabled = true;
      try {
        await api.put(`/gateway-keys/${id}`, { name, route_id: routeId, enabled });
        await renderGatewayKeys(root);
      } catch (e) {
        toast((e as Error).message, 'error');
        btn.disabled = false;
      }
    });
  });

  root.querySelectorAll<HTMLButtonElement>('button[data-gwk-del]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = Number(btn.dataset.gwkDel);
      const name = btn.dataset.gwkName!;
      if (!confirm(`Revoke gateway key "${name}" immediately?`)) return;
      btn.disabled = true;
      try {
        await api.del(`/gateway-keys/${id}`);
        toast('Gateway key revoked', 'ok');
        await renderGatewayKeys(root);
      } catch (e) {
        toast((e as Error).message, 'error');
        btn.disabled = false;
      }
    });
  });
}
