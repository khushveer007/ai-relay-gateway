import {
  actionPill,
  api,
  esc,
  fmtAgo,
  fmtTime,
  fmtTokens,
  type GatewayKeyDTO,
  type LogRowDTO,
  type ProviderDTO,
  type RouteDTO,
} from '../api';

interface LogFilters {
  provider_id: string;
  gateway_key_id: string;
  status: string;
  model: string;
}

const filters: LogFilters = {
  provider_id: '',
  gateway_key_id: '',
  status: '',
  model: '',
};

export async function renderLogs(root: HTMLElement): Promise<void> {
  root.innerHTML = `<div class="empty-state">Loading request logs…</div>`;

  const [provRes, gwkRes, routesRes] = await Promise.all([
    api.get<{ providers: ProviderDTO[] }>('/providers'),
    api.get<{ keys: GatewayKeyDTO[] }>('/gateway-keys'),
    api.get<{ routes: RouteDTO[] }>('/routes'),
  ]);

  const providers = provRes.providers;
  const provMap = new Map(providers.map((p) => [p.id, p]));
  const keyMap = new Map<number, string>();
  for (const p of providers) {
    for (const k of p.keys) keyMap.set(k.id, k.alias || k.key_hint);
  }
  const gwkMap = new Map(gwkRes.keys.map((k) => [k.id, k]));
  const routeMap = new Map(routesRes.routes.map((r) => [r.id, r]));

  let logs: LogRowDTO[] = [];
  let nextBefore: number | null = null;
  const expanded = new Set<number>();

  async function loadPage(append = false): Promise<void> {
    const params = new URLSearchParams({ limit: '50' });
    if (filters.provider_id) params.set('provider_id', filters.provider_id);
    if (filters.gateway_key_id) params.set('gateway_key_id', filters.gateway_key_id);
    if (filters.status) params.set('status', filters.status);
    if (filters.model) params.set('model', filters.model);
    if (append && nextBefore) params.set('before', String(nextBefore));

    const res = await api.get<{ logs: LogRowDTO[]; next_before: number | null }>(`/logs?${params.toString()}`);
    logs = append ? [...logs, ...res.logs] : res.logs;
    nextBefore = res.next_before;
    drawTable();
  }

  root.innerHTML = `
    <header class="page-header">
      <div>
        <h1 class="page-title">Request Logs</h1>
        <p class="page-subtitle">Click any row to inspect the full step-by-step failover trail across keys and providers.</p>
      </div>
      <div class="header-actions">
        <button type="button" class="btn" id="logs-refresh">↻ Refresh</button>
      </div>
    </header>

    <section class="card" style="padding:1rem 1.25rem">
      <form id="logs-filter-form" style="display:flex;gap:0.75rem;flex-wrap:wrap;align-items:flex-end">
        <div class="field" style="min-inline-size:170px">
          <label for="lf-provider">Provider</label>
          <select id="lf-provider">
            <option value="">All Providers</option>
            ${providers.map((p) => `<option value="${p.id}" ${filters.provider_id === String(p.id) ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}
          </select>
        </div>
        <div class="field" style="min-inline-size:170px">
          <label for="lf-gwk">Gateway Key</label>
          <select id="lf-gwk">
            <option value="">All Gateway Keys</option>
            ${gwkRes.keys.map((k) => `<option value="${k.id}" ${filters.gateway_key_id === String(k.id) ? 'selected' : ''}>${esc(k.name)}</option>`).join('')}
          </select>
        </div>
        <div class="field" style="min-inline-size:160px">
          <label for="lf-status">Status</label>
          <select id="lf-status">
            <option value="" ${filters.status === '' ? 'selected' : ''}>All Requests</option>
            <option value="ok" ${filters.status === 'ok' ? 'selected' : ''}>2xx OK</option>
            <option value="failover" ${filters.status === 'failover' ? 'selected' : ''}>Had Failovers (&gt;0)</option>
            <option value="error" ${filters.status === 'error' ? 'selected' : ''}>Failed (non-2xx)</option>
          </select>
        </div>
        <div class="field" style="flex:1;min-inline-size:180px">
          <label for="lf-model">Model Filter</label>
          <input type="search" id="lf-model" value="${esc(filters.model)}" placeholder="e.g. claude-3-7 or gpt-4" />
        </div>
        <button type="submit" class="btn btn-primary">Filter</button>
      </form>
    </section>

    <div id="logs-table-host"></div>
  `;

  function drawTable(): void {
    const host = document.getElementById('logs-table-host')!;
    if (logs.length === 0) {
      host.innerHTML = `<div class="card empty-state">No request logs match the current filters.</div>`;
      return;
    }

    host.innerHTML = `
      <div tabindex="0" role="region" aria-label="Request logs" class="table-wrapper">
        <table>
          <thead>
            <tr>
              <th>Time</th>
              <th>Format</th>
              <th>Model</th>
              <th>Route → Provider / Key</th>
              <th>Status</th>
              <th>TTFB / Total</th>
              <th>Tokens (In / Out / Cache)</th>
              <th>Attempts</th>
            </tr>
          </thead>
          <tbody>
            ${logs
              .map((l) => {
                const isOk = l.status >= 200 && l.status < 300;
                const prov = l.provider_id ? provMap.get(l.provider_id) : null;
                const keyLabel = l.key_id ? keyMap.get(l.key_id) ?? `#${l.key_id}` : '—';
                const route = l.route_id ? routeMap.get(l.route_id)?.name ?? `#${l.route_id}` : '—';
                const gwk = l.gateway_key_id ? gwkMap.get(l.gateway_key_id)?.name : null;
                const isExp = expanded.has(l.id);
                const modelCell =
                  l.upstream_model && l.upstream_model !== l.model
                    ? `${esc(l.model ?? '—')} <span style="color:var(--text-muted)">→ ${esc(l.upstream_model)}</span>`
                    : esc(l.model ?? l.path);

                const mainRow = `<tr data-log-row="${l.id}" style="cursor:pointer">
                  <td class="mono" title="${esc(new Date(l.ts).toISOString())}">
                    ${fmtTime(l.ts)} <span style="color:var(--text-muted);font-size:0.72rem">(${fmtAgo(l.ts)})</span>
                  </td>
                  <td>
                    <span class="tag tag-cyan">${esc(l.format)}</span>
                    ${l.stream ? `<span class="tag">SSE</span>` : ''}
                  </td>
                  <td class="mono">${modelCell}</td>
                  <td>
                    <span class="tag">${esc(route)}</span>
                    ${prov ? `→ <strong>${esc(prov.name)}</strong> <code class="tag">${esc(keyLabel)}</code>` : ''}
                    ${gwk ? `<span class="field-hint">(${esc(gwk)})</span>` : ''}
                  </td>
                  <td>
                    <span class="pill ${isOk ? 'pill-ok' : 'pill-danger'}">${l.status || 'ERR'}</span>
                  </td>
                  <td class="mono">
                    ${l.ttfb_ms !== null ? `${l.ttfb_ms} ms` : '—'} / ${l.latency_ms ?? 0} ms
                  </td>
                  <td class="mono">
                    ${fmtTokens(l.input_tokens)} / ${fmtTokens(l.output_tokens)}${
                      l.cache_tokens ? ` <span style="color:var(--accent-cyan)">(${fmtTokens(l.cache_tokens)}⚡)</span>` : ''
                    }
                  </td>
                  <td>
                    <span class="pill ${l.failovers > 0 ? 'pill-warn' : 'pill-neutral'}">
                      ${l.attempts.length || 1} ${l.failovers > 0 ? `(${l.failovers} failover)` : ''} ▾
                    </span>
                  </td>
                </tr>`;

                if (!isExp) return mainRow;

                const trailHtml =
                  l.attempts.length === 0
                    ? `<div class="attempt-item">No upstream attempts recorded (${esc(l.error ?? 'rejected before upstream')})</div>`
                    : l.attempts
                        .map(
                          (a, idx) => `<div class="attempt-item">
                            <span style="color:var(--text-muted)">#${idx + 1}</span>
                            <strong>${esc(a.provider)}</strong>
                            <code class="tag">${esc(a.key)}</code>
                            <span style="color:var(--text-secondary)">model=${esc(a.model)}</span>
                            <span class="pill ${a.status >= 200 && a.status < 300 && a.action === 'OK' ? 'pill-ok' : 'pill-danger'}">HTTP ${a.status || 'ERR'}</span>
                            ${actionPill(a.action)}
                            <span>${a.ms} ms</span>
                            ${a.reason ? `<span style="color:var(--text-secondary)">— ${esc(a.reason)}</span>` : ''}
                          </div>`,
                        )
                        .join('');

                const detailRow = `<tr>
                  <td colspan="8" style="background:var(--bg-base);padding:0.75rem 1rem">
                    <div class="attempt-trail">
                      <div style="font-size:0.75rem;color:var(--text-secondary);margin-block-end:0.2rem">
                        Path: <code>${esc(l.path)}</code> ${l.error ? `· Error: <span style="color:var(--status-danger)">${esc(l.error)}</span>` : ''}
                      </div>
                      ${trailHtml}
                    </div>
                  </td>
                </tr>`;

                return mainRow + detailRow;
              })
              .join('')}
          </tbody>
        </table>
      </div>
      ${
        nextBefore
          ? `<div style="display:flex;justify-content:center;margin-block-start:1rem">
              <button type="button" class="btn" id="logs-load-more">Load older logs</button>
            </div>`
          : ''
      }
    `;

    host.querySelectorAll<HTMLTableRowElement>('tr[data-log-row]').forEach((row) => {
      row.addEventListener('click', () => {
        const id = Number(row.dataset.logRow);
        if (expanded.has(id)) expanded.delete(id);
        else expanded.add(id);
        drawTable();
      });
    });

    host.querySelector('#logs-load-more')?.addEventListener('click', () => loadPage(true));
  }

  root.querySelector('#logs-refresh')?.addEventListener('click', () => loadPage(false));

  root.querySelector('#logs-filter-form')?.addEventListener('submit', (ev) => {
    ev.preventDefault();
    filters.provider_id = (document.getElementById('lf-provider') as HTMLSelectElement).value;
    filters.gateway_key_id = (document.getElementById('lf-gwk') as HTMLSelectElement).value;
    filters.status = (document.getElementById('lf-status') as HTMLSelectElement).value;
    filters.model = (document.getElementById('lf-model') as HTMLInputElement).value.trim();
    loadPage(false);
  });

  await loadPage(false);
}
