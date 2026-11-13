import {
  actionPill,
  api,
  esc,
  fmtAgo,
  fmtBalance,
  fmtNum,
  fmtTokens,
  statusPill,
  toast,
  type ProviderDTO,
  type StatsDTO,
} from '../api';

let currentRange: '1h' | '24h' | '7d' = '24h';

export async function renderOverview(root: HTMLElement): Promise<void> {
  root.innerHTML = `<div class="empty-state">Loading gateway overview…</div>`;

  const [stats, provRes] = await Promise.all([
    api.get<StatsDTO>(`/stats?range=${currentRange}`),
    api.get<{ providers: ProviderDTO[] }>('/providers'),
  ]);

  const providers = provRes.providers;
  const provMap = new Map(providers.map((p) => [p.id, p]));
  const keyUsageMap = new Map(stats.by_key.map((k) => [k.key_id, k]));

  const totalReqs = Number(stats.totals.requests ?? 0);
  const okReqs = Number(stats.totals.ok ?? 0);
  const failovers = Number(stats.totals.failovered ?? 0);
  const successRate = totalReqs > 0 ? ((okReqs / totalReqs) * 100).toFixed(1) : '100.0';
  const totalIn = Number(stats.totals.input_tokens ?? 0);
  const totalOut = Number(stats.totals.output_tokens ?? 0);
  const totalCache = Number(stats.totals.cache_tokens ?? 0);

  const allKeys = providers.flatMap((p) => p.keys.map((k) => ({ provider: p, key: k })));
  const activeKeyCount = allKeys.filter((x) => x.key.status === 'active').length;

  const maxBucketReq = Math.max(1, ...stats.series.map((s) => Number(s.requests)));

  root.innerHTML = `
    <header class="page-header">
      <div>
        <h1 class="page-title">Overview</h1>
        <p class="page-subtitle">Real-time health, failover activity, and token throughput across your providers.</p>
      </div>
      <div class="header-actions">
        <div class="segmented" role="group" aria-label="Time range">
          <button type="button" data-range="1h" aria-pressed="${currentRange === '1h'}">Last 1h</button>
          <button type="button" data-range="24h" aria-pressed="${currentRange === '24h'}">Last 24h</button>
          <button type="button" data-range="7d" aria-pressed="${currentRange === '7d'}">Last 7d</button>
        </div>
        <button type="button" class="btn" id="ov-refresh">↻ Refresh</button>
      </div>
    </header>

    <section class="kpi-grid">
      <div class="kpi-card">
        <div class="kpi-label">
          <span>Requests (${esc(currentRange)})</span>
          <span class="pill pill-ok">${esc(successRate)}% OK</span>
        </div>
        <div class="kpi-value">${fmtNum(totalReqs)}</div>
        <div class="kpi-sub">${fmtNum(okReqs)} succeeded · ${fmtNum(totalReqs - okReqs)} failed</div>
      </div>

      <div class="kpi-card">
        <div class="kpi-label">
          <span>Automatic Failovers</span>
          <span class="tag tag-accent">Self-healing</span>
        </div>
        <div class="kpi-value">${fmtNum(failovers)}</div>
        <div class="kpi-sub">Requests recovered via key/provider rotation</div>
      </div>

      <div class="kpi-card">
        <div class="kpi-label">
          <span>Tokens Processed</span>
          <span class="tag tag-cyan">Out: ${fmtTokens(totalOut)}</span>
        </div>
        <div class="kpi-value">${fmtTokens(totalIn + totalOut)}</div>
        <div class="kpi-sub">In: ${fmtTokens(totalIn)} · Cache read: ${fmtTokens(totalCache)}</div>
      </div>

      <div class="kpi-card">
        <div class="kpi-label">
          <span>Healthy Keys</span>
          <span class="tag">${providers.filter((p) => p.enabled).length}/${providers.length} providers</span>
        </div>
        <div class="kpi-value">${activeKeyCount} / ${allKeys.length}</div>
        <div class="kpi-sub">Avg TTFB: ${stats.totals.avg_ttfb ? `${stats.totals.avg_ttfb} ms` : '—'} · Total: ${
          stats.totals.avg_latency ? `${stats.totals.avg_latency} ms` : '—'
        }</div>
      </div>
    </section>

    <div class="grid-2">
      <section class="card">
        <div class="card-header">
          <div>
            <h2 class="card-title">Traffic &amp; Errors</h2>
            <p class="card-subtitle">Requests per time bucket over the last ${esc(currentRange)}</p>
          </div>
        </div>
        ${
          stats.series.length === 0
            ? `<div class="empty-state">No requests recorded in this window yet.</div>`
            : `<div class="chart-bars">
                ${stats.series
                  .map((b) => {
                    const reqs = Number(b.requests);
                    const errs = Number(b.errors);
                    const ok = Math.max(0, reqs - errs);
                    const okH = Math.round((ok / maxBucketReq) * 100);
                    const errH = Math.round((errs / maxBucketReq) * 100);
                    const ts = new Date(Number(b.bucket)).toLocaleString([], {
                      month: 'short',
                      day: 'numeric',
                      hour: '2-digit',
                      minute: '2-digit',
                    });
                    return `<div class="chart-bar-col" title="${esc(ts)}: ${reqs} reqs (${errs} errors, ${b.failovers} failovers)">
                      ${errs > 0 ? `<div class="chart-bar-err" style="block-size:${Math.max(4, errH)}%"></div>` : ''}
                      ${ok > 0 ? `<div class="chart-bar-ok" style="block-size:${Math.max(4, okH)}%"></div>` : ''}
                    </div>`;
                  })
                  .join('')}
              </div>`
        }
      </section>

      <section class="card">
        <div class="card-header">
          <div>
            <h2 class="card-title">Attempt Outcomes</h2>
            <p class="card-subtitle">Classification of upstream attempts (${esc(currentRange)})</p>
          </div>
        </div>
        ${
          stats.actions.length === 0
            ? `<div class="empty-state">No upstream attempts recorded in this window.</div>`
            : `<div tabindex="0" role="region" aria-label="Attempt outcomes" class="table-wrapper">
                <table>
                  <thead>
                    <tr>
                      <th>Outcome Action</th>
                      <th>Attempts</th>
                    </tr>
                  </thead>
                  <tbody>
                    ${stats.actions
                      .map(
                        (a) => `<tr>
                          <td>${actionPill(a.action)}</td>
                          <td class="mono">${fmtNum(a.count)}</td>
                        </tr>`,
                      )
                      .join('')}
                  </tbody>
                </table>
              </div>`
        }
      </section>
    </div>

    <section class="card">
      <div class="card-header">
        <div>
          <h2 class="card-title">Key Health Matrix</h2>
          <p class="card-subtitle">Live status of every upstream API key across all providers</p>
        </div>
      </div>
      ${
        allKeys.length === 0
          ? `<div class="empty-state">No API keys configured yet. Go to <strong>Providers &amp; Keys</strong> to add your first relay provider.</div>`
          : `<div tabindex="0" role="region" aria-label="Key health matrix" class="table-wrapper">
              <table>
                <thead>
                  <tr>
                    <th>Provider</th>
                    <th>Key</th>
                    <th>Status</th>
                    <th>Balance</th>
                    <th>Reqs (${esc(currentRange)})</th>
                    <th>Last Used</th>
                    <th>Detail / Cooldown</th>
                    <th>Quick Action</th>
                  </tr>
                </thead>
                <tbody>
                  ${allKeys
                    .map(({ provider, key }) => {
                      const u = keyUsageMap.get(key.id);
                      let detail = key.status_reason ? esc(key.status_reason) : 'Healthy';
                      if (key.status === 'rate_limited' && key.cooldown_until) {
                        detail += ` · cools down ${fmtAgo(key.cooldown_until)}`;
                      } else if (key.status === 'exhausted' && key.next_recheck_at) {
                        detail += ` · recheck ${fmtAgo(key.next_recheck_at)}`;
                      }
                      return `<tr>
                        <th>${esc(provider.name)}</th>
                        <td class="mono">${esc(key.alias ? `${key.alias} (${key.key_hint})` : key.key_hint)}</td>
                        <td>${statusPill(key.status)}</td>
                        <td class="mono">${fmtBalance(key.balance)}</td>
                        <td class="mono">${fmtNum(u?.requests ?? 0)}</td>
                        <td>${fmtAgo(u?.last_used)}</td>
                        <td style="max-inline-size:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(
                          key.status_reason ?? '',
                        )}">${detail}</td>
                        <td>
                          <div style="display:flex;gap:0.35rem">
                            ${
                              key.status !== 'active'
                                ? `<button type="button" class="btn btn-sm" data-enable-key="${key.id}">Enable</button>`
                                : ''
                            }
                            <button type="button" class="btn btn-sm" data-test-key="${key.id}">Test</button>
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
            <h2 class="card-title">Traffic by Provider</h2>
          </div>
        </div>
        ${
          stats.by_provider.length === 0
            ? `<div class="empty-state">No provider traffic in this window.</div>`
            : `<div tabindex="0" role="region" aria-label="Traffic by provider" class="table-wrapper">
                <table>
                  <thead>
                    <tr>
                      <th>Provider</th>
                      <th>Requests</th>
                      <th>Success</th>
                      <th>Tokens (In / Out)</th>
                      <th>Avg TTFB</th>
                    </tr>
                  </thead>
                  <tbody>
                    ${stats.by_provider
                      .map((row) => {
                        const p = provMap.get(row.provider_id);
                        return `<tr>
                          <th>${esc(p?.name ?? `#${row.provider_id}`)}</th>
                          <td class="mono">${fmtNum(row.requests)}</td>
                          <td class="mono">${fmtNum(row.ok)}</td>
                          <td class="mono">${fmtTokens(row.input_tokens)} / ${fmtTokens(row.output_tokens)}</td>
                          <td class="mono">${row.avg_ttfb ? `${row.avg_ttfb} ms` : '—'}</td>
                        </tr>`;
                      })
                      .join('')}
                  </tbody>
                </table>
              </div>`
        }
      </section>

      <section class="card">
        <div class="card-header">
          <div>
            <h2 class="card-title">Top Models</h2>
          </div>
        </div>
        ${
          stats.by_model.length === 0
            ? `<div class="empty-state">No model traffic in this window.</div>`
            : `<div tabindex="0" role="region" aria-label="Top models" class="table-wrapper">
                <table>
                  <thead>
                    <tr>
                      <th>Model</th>
                      <th>Requests</th>
                      <th>Input Tokens</th>
                      <th>Output Tokens</th>
                    </tr>
                  </thead>
                  <tbody>
                    ${stats.by_model
                      .map(
                        (m) => `<tr>
                          <th class="mono">${esc(m.model)}</th>
                          <td class="mono">${fmtNum(m.requests)}</td>
                          <td class="mono">${fmtTokens(m.input_tokens)}</td>
                          <td class="mono">${fmtTokens(m.output_tokens)}</td>
                        </tr>`,
                      )
                      .join('')}
                  </tbody>
                </table>
              </div>`
        }
      </section>
    </div>
  `;

  root.querySelectorAll<HTMLButtonElement>('button[data-range]').forEach((btn) => {
    btn.addEventListener('click', () => {
      currentRange = btn.dataset.range as '1h' | '24h' | '7d';
      renderOverview(root);
    });
  });

  root.querySelector('#ov-refresh')?.addEventListener('click', () => renderOverview(root));

  root.querySelectorAll<HTMLButtonElement>('button[data-enable-key]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = Number(btn.dataset.enableKey);
      btn.disabled = true;
      try {
        await api.put(`/keys/${id}`, { status: 'active' });
        toast('Key re-enabled', 'ok');
        await renderOverview(root);
      } catch (e) {
        toast((e as Error).message, 'error');
        btn.disabled = false;
      }
    });
  });

  root.querySelectorAll<HTMLButtonElement>('button[data-test-key]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = Number(btn.dataset.testKey);
      btn.disabled = true;
      btn.textContent = 'Testing…';
      try {
        const res = await api.post<{ ok: boolean; message: string; ms: number }>(`/keys/${id}/test`);
        toast(`${res.message} (${res.ms} ms)`, res.ok ? 'ok' : 'error');
        await renderOverview(root);
      } catch (e) {
        toast((e as Error).message, 'error');
        btn.disabled = false;
        btn.textContent = 'Test';
      }
    });
  });
}
