import { api, esc, openModal, toast, type ProviderDTO, type RouteDTO } from '../api';

export async function renderRoutes(root: HTMLElement): Promise<void> {
  root.innerHTML = `<div class="empty-state">Loading routes…</div>`;
  const [routesRes, provRes] = await Promise.all([
    api.get<{ routes: RouteDTO[] }>('/routes'),
    api.get<{ providers: ProviderDTO[] }>('/providers'),
  ]);

  const routes = routesRes.routes;
  const providers = provRes.providers;
  const provById = new Map(providers.map((p) => [p.id, p]));
  const routeById = new Map(routes.map((r) => [r.id, r]));

  root.innerHTML = `
    <header class="page-header">
      <div>
        <h1 class="page-title">Routes &amp; Failover Chains</h1>
        <p class="page-subtitle">
          Resolution order: <strong>1.</strong> Route pinned to the Gateway Key → <strong>2.</strong> First route matching the request model glob → <strong>3.</strong> The <code>default</code> route.
        </p>
      </div>
      <div class="header-actions">
        <button type="button" class="btn btn-primary" id="btn-new-route">+ New Route</button>
      </div>
    </header>

    <div style="display:flex;flex-direction:column;gap:1rem">
      ${routes
        .map((r) => {
          const chainHtml =
            r.provider_ids.length === 0
              ? `<span class="field-hint">No providers in chain — click Edit to add providers.</span>`
              : r.provider_ids
                  .map((pid, idx) => {
                    const p = provById.get(pid);
                    const activeKeys = p ? p.keys.filter((k) => k.status === 'active').length : 0;
                    const totalKeys = p ? p.keys.length : 0;
                    const node = `<span class="route-node">
                      <span class="mono" style="color:var(--text-muted)">#${idx + 1}</span>
                      <span>${esc(p?.name ?? `Provider #${pid}`)}</span>
                      <span class="tag">${activeKeys}/${totalKeys} keys</span>
                    </span>`;
                    return idx === 0 ? node : `<span class="route-arrow">→</span>${node}`;
                  })
                  .join('');

          return `
            <section class="card">
              <div class="card-header">
                <div style="display:flex;align-items:center;gap:0.65rem;flex-wrap:wrap">
                  <h2 class="card-title" style="font-size:1.08rem">${esc(r.name)}</h2>
                  ${
                    r.is_default
                      ? `<span class="pill pill-ok">Default Fallback Route</span>`
                      : `<span class="tag">position: ${r.position}</span>`
                  }
                  ${
                    r.model_patterns.length > 0
                      ? r.model_patterns.map((pat) => `<span class="tag tag-accent">model: ${esc(pat)}</span>`).join('')
                      : !r.is_default
                        ? `<span class="tag">key-bound only (no model globs)</span>`
                        : ''
                  }
                </div>
                <div style="display:flex;gap:0.45rem">
                  <button type="button" class="btn btn-sm" data-edit-route="${r.id}">Edit Chain</button>
                  ${
                    !r.is_default
                      ? `<button type="button" class="btn btn-sm btn-danger" data-del-route="${r.id}">Delete</button>`
                      : ''
                  }
                </div>
              </div>
              <div class="route-chain">${chainHtml}</div>
            </section>
          `;
        })
        .join('')}
    </div>

    <dialog id="route-dialog" closedby="any" aria-labelledby="route-dialog-title">
      <form id="route-form" method="dialog">
        <div class="dialog-header">
          <h2 id="route-dialog-title">Edit Route</h2>
          <button type="button" class="btn btn-sm btn-ghost" data-close-route-dialog aria-label="Close">✕</button>
        </div>
        <div class="dialog-body" id="route-dialog-body"></div>
        <div class="dialog-footer">
          <button type="button" class="btn" data-close-route-dialog>Cancel</button>
          <button type="submit" class="btn btn-primary" id="route-submit-btn">Save Route</button>
        </div>
      </form>
    </dialog>
  `;

  let selectedChain: number[] = [];

  const renderChainEditor = () => {
    const container = document.getElementById('rf-chain-list');
    const addSelect = document.getElementById('rf-add-provider') as HTMLSelectElement | null;
    if (!container || !addSelect) return;

    const remaining = providers.filter((p) => !selectedChain.includes(p.id));
    addSelect.innerHTML =
      `<option value="">+ Add a provider to the failover chain…</option>` +
      remaining.map((p) => `<option value="${p.id}">${esc(p.name)} (${p.formats.join(', ')})</option>`).join('');

    if (selectedChain.length === 0) {
      container.innerHTML = `<div class="field-hint" style="padding:0.65rem;border:1px dashed var(--border-strong);border-radius:var(--radius-sm)">No providers in this chain yet. Pick one from the dropdown below.</div>`;
      return;
    }

    container.innerHTML = selectedChain
      .map((pid, i) => {
        const p = provById.get(pid);
        return `
          <div style="display:flex;align-items:center;justify-content:space-between;gap:0.6rem;padding:0.5rem 0.75rem;background:var(--bg-elevated);border:1px solid var(--border-subtle);border-radius:var(--radius-sm)">
            <div style="display:flex;align-items:center;gap:0.6rem">
              <span class="mono" style="color:var(--text-muted)">#${i + 1}</span>
              <strong>${esc(p?.name ?? `#${pid}`)}</strong>
              <span class="field-hint">${esc(p?.formats.join(', ') ?? '')}</span>
            </div>
            <div style="display:flex;gap:0.25rem">
              <button type="button" class="btn btn-sm btn-ghost" data-chain-move="-1" data-chain-idx="${i}" ${i === 0 ? 'disabled' : ''}>↑</button>
              <button type="button" class="btn btn-sm btn-ghost" data-chain-move="1" data-chain-idx="${i}" ${i === selectedChain.length - 1 ? 'disabled' : ''}>↓</button>
              <button type="button" class="btn btn-sm btn-danger" data-chain-remove="${i}">Remove</button>
            </div>
          </div>
        `;
      })
      .join('');

    container.querySelectorAll<HTMLButtonElement>('[data-chain-move]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const idx = Number(btn.dataset.chainIdx);
        const dir = Number(btn.dataset.chainMove);
        const next = idx + dir;
        if (next < 0 || next >= selectedChain.length) return;
        [selectedChain[idx], selectedChain[next]] = [selectedChain[next], selectedChain[idx]];
        renderChainEditor();
      });
    });

    container.querySelectorAll<HTMLButtonElement>('[data-chain-remove]').forEach((btn) => {
      btn.addEventListener('click', () => {
        selectedChain.splice(Number(btn.dataset.chainRemove), 1);
        renderChainEditor();
      });
    });
  };

  const openRouteModal = (existing?: RouteDTO) => {
    const dlg = document.getElementById('route-dialog') as HTMLDialogElement;
    document.getElementById('route-dialog-title')!.textContent = existing ? `Edit Route: ${existing.name}` : 'New Route';
    selectedChain = existing ? [...existing.provider_ids] : providers.map((p) => p.id);

    document.getElementById('route-dialog-body')!.innerHTML = `
      <input type="hidden" id="rf-id" value="${existing ? existing.id : ''}" />
      <div class="field-row">
        <div class="field">
          <label for="rf-name">Route Name *</label>
          <input type="text" id="rf-name" required value="${esc(existing?.name ?? '')}" ${existing?.is_default ? 'readonly' : 'autofocus'} placeholder="e.g. anthropic-tier" />
        </div>
        <div class="field">
          <label for="rf-pos">Priority Position (lower matches first)</label>
          <input type="number" id="rf-pos" min="0" max="100000" value="${existing?.position ?? 10}" />
        </div>
      </div>

      <div class="field">
        <label for="rf-patterns">Model Glob Patterns (comma or newline separated)</label>
        <input type="text" id="rf-patterns" value="${esc(existing?.model_patterns.join(', ') ?? '')}" placeholder="claude-*, sonnet-*" ${existing?.is_default ? 'disabled' : ''} />
        <span class="field-hint">Case-insensitive globs with <code>*</code> and <code>?</code>. Leave empty if this route is only selected via a pinned Gateway Key.</span>
      </div>

      <div class="field">
        <span class="field-label">Provider Failover Chain (tried in order from #1 down)</span>
        <div id="rf-chain-list" style="display:flex;flex-direction:column;gap:0.4rem"></div>
        <select id="rf-add-provider" style="margin-block-start:0.35rem"></select>
      </div>
    `;

    renderChainEditor();

    document.getElementById('rf-add-provider')?.addEventListener('change', (ev) => {
      const sel = ev.target as HTMLSelectElement;
      const pid = Number(sel.value);
      if (pid && !selectedChain.includes(pid)) {
        selectedChain.push(pid);
        renderChainEditor();
      }
    });

    openModal(dlg);
  };

  root.querySelectorAll<HTMLButtonElement>('[data-close-route-dialog]').forEach((btn) => {
    btn.addEventListener('click', () => (document.getElementById('route-dialog') as HTMLDialogElement).close());
  });

  root.querySelector('#btn-new-route')?.addEventListener('click', () => openRouteModal());

  root.querySelectorAll<HTMLButtonElement>('[data-edit-route]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const r = routeById.get(Number(btn.dataset.editRoute));
      if (r) openRouteModal(r);
    });
  });

  root.querySelectorAll<HTMLButtonElement>('[data-del-route]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const r = routeById.get(Number(btn.dataset.delRoute));
      if (!r || !confirm(`Delete route "${r.name}"?`)) return;
      btn.disabled = true;
      try {
        await api.del(`/routes/${r.id}`);
        toast(`Route "${r.name}" deleted`, 'ok');
        await renderRoutes(root);
      } catch (e) {
        toast((e as Error).message, 'error');
        btn.disabled = false;
      }
    });
  });

  root.querySelector('#route-form')?.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const btn = document.getElementById('route-submit-btn') as HTMLButtonElement;
    btn.disabled = true;
    try {
      const id = (document.getElementById('rf-id') as HTMLInputElement).value;
      const name = (document.getElementById('rf-name') as HTMLInputElement).value;
      const position = Number((document.getElementById('rf-pos') as HTMLInputElement).value || 0);
      const rawPatterns = (document.getElementById('rf-patterns') as HTMLInputElement).value;
      const model_patterns = rawPatterns
        .split(/[\n,]+/)
        .map((s) => s.trim())
        .filter(Boolean);

      const payload = {
        name,
        position,
        model_patterns,
        provider_ids: selectedChain,
      };

      if (id) {
        await api.put(`/routes/${id}`, payload);
        toast('Route updated', 'ok');
      } else {
        await api.post('/routes', payload);
        toast('Route created', 'ok');
      }
      (document.getElementById('route-dialog') as HTMLDialogElement).close();
      await renderRoutes(root);
    } catch (e) {
      toast((e as Error).message, 'error');
      btn.disabled = false;
    }
  });
}
