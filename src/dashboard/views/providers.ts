import {
  api,
  esc,
  fmtAgo,
  fmtBalance,
  openModal,
  statusPill,
  toast,
  type Format,
  type ProviderDTO,
} from '../api';

function mapToLines(map: Record<string, string>): string {
  return Object.entries(map)
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
}

function linesToMap(text: string): Record<string, string> {
  const trimmed = text.trim();
  if (!trimmed) return {};
  if (trimmed.startsWith('{')) {
    return JSON.parse(trimmed);
  }
  const out: Record<string, string> = {};
  for (const raw of trimmed.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const sep = line.includes('=') ? '=' : line.includes(':') ? ':' : null;
    if (!sep) continue;
    const idx = line.indexOf(sep);
    const k = line.slice(0, idx).trim();
    const v = line.slice(idx + 1).trim();
    if (k && v) out[k] = v;
  }
  return out;
}

export async function renderProviders(root: HTMLElement): Promise<void> {
  root.innerHTML = `<div class="empty-state">Loading providers and keys…</div>`;
  const { providers } = await api.get<{ providers: ProviderDTO[] }>('/providers');

  root.innerHTML = `
    <header class="page-header">
      <div>
        <h1 class="page-title">Providers &amp; Keys</h1>
        <p class="page-subtitle">Configure upstream AI relays, bulk-import encrypted API keys, fetch models, and manage key rotation priority.</p>
      </div>
      <div class="header-actions">
        <button type="button" class="btn btn-primary" id="btn-new-provider">+ Add Provider</button>
      </div>
    </header>

    ${
      providers.length === 0
        ? `<div class="card empty-state">
            <p style="margin:0 0 0.75rem;font-size:1rem;color:var(--text-primary)">No upstream providers configured yet</p>
            <p style="margin:0 0 1.25rem">Add an Anthropic, OpenAI, or compatible relay (new-api / one-api) and paste your API keys.</p>
            <button type="button" class="btn btn-primary" id="btn-empty-new-provider">+ Add First Provider</button>
          </div>`
        : `<div style="display:flex;flex-direction:column;gap:1.25rem">
            ${providers.map((p) => renderProviderCard(p)).join('')}
          </div>`
    }

    <dialog id="provider-dialog" closedby="any" aria-labelledby="provider-dialog-title">
      <form id="provider-form" method="dialog">
        <div class="dialog-header">
          <h2 id="provider-dialog-title">Add Provider</h2>
          <button type="button" class="btn btn-sm btn-ghost" data-close-dialog="provider-dialog" aria-label="Close">✕</button>
        </div>
        <div class="dialog-body" id="provider-dialog-body"></div>
        <div class="dialog-footer">
          <button type="button" class="btn" data-close-dialog="provider-dialog">Cancel</button>
          <button type="submit" class="btn btn-primary" id="provider-submit-btn">Save Provider</button>
        </div>
      </form>
    </dialog>

    <dialog id="keys-dialog" closedby="any" aria-labelledby="keys-dialog-title">
      <form id="keys-form" method="dialog">
        <div class="dialog-header">
          <h2 id="keys-dialog-title">Add API Keys</h2>
          <button type="button" class="btn btn-sm btn-ghost" data-close-dialog="keys-dialog" aria-label="Close">✕</button>
        </div>
        <div class="dialog-body">
          <input type="hidden" id="keys-provider-id" />
          <div class="field">
            <label for="keys-bulk-input">API Keys (one per line, or comma/space-separated)</label>
            <textarea id="keys-bulk-input" rows="6" placeholder="sk-ant-...\nsk-proj-..." required autofocus></textarea>
            <span class="field-hint">Keys are encrypted at rest with AES-256-GCM. Duplicate keys for this provider are skipped automatically.</span>
          </div>
          <div class="field">
            <label for="keys-alias-prefix">Alias prefix (optional)</label>
            <input type="text" id="keys-alias-prefix" placeholder="e.g. Account" />
          </div>
        </div>
        <div class="dialog-footer">
          <button type="button" class="btn" data-close-dialog="keys-dialog">Cancel</button>
          <button type="submit" class="btn btn-primary" id="keys-submit-btn">Add Keys</button>
        </div>
      </form>
    </dialog>

    <dialog id="models-dialog" closedby="any" aria-labelledby="models-dialog-title">
      <div class="dialog-header">
        <h2 id="models-dialog-title">Provider Models</h2>
        <button type="button" class="btn btn-sm btn-ghost" data-close-dialog="models-dialog" aria-label="Close">✕</button>
      </div>
      <div class="dialog-body" id="models-dialog-body"></div>
      <div class="dialog-footer">
        <button type="button" class="btn" data-close-dialog="models-dialog">Close</button>
      </div>
    </dialog>
  `;

  const byId = new Map(providers.map((p) => [p.id, p]));

  root.querySelectorAll<HTMLButtonElement>('[data-close-dialog]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const dlg = document.getElementById(btn.dataset.closeDialog!) as HTMLDialogElement | null;
      dlg?.close();
    });
  });

  const openProviderModal = (existing?: ProviderDTO) => {
    const dlg = document.getElementById('provider-dialog') as HTMLDialogElement;
    const title = document.getElementById('provider-dialog-title')!;
    const body = document.getElementById('provider-dialog-body')!;
    title.textContent = existing ? `Edit Provider: ${existing.name}` : 'Add Provider';

    const fmts = new Set<Format>(existing?.formats ?? ['anthropic', 'openai-chat', 'openai-responses']);
    body.innerHTML = `
      <input type="hidden" id="pf-id" value="${existing ? existing.id : ''}" />
      <div class="field-row">
        <div class="field">
          <label for="pf-name">Provider Name *</label>
          <input type="text" id="pf-name" required value="${esc(existing?.name ?? '')}" placeholder="e.g. OpenAI Official / Relay A" autofocus />
        </div>
        <div class="field">
          <label for="pf-url">Base URL *</label>
          <input type="url" id="pf-url" required value="${esc(existing?.base_url ?? '')}" placeholder="https://api.anthropic.com" />
        </div>
      </div>

      <div class="field">
        <span class="field-label">Supported Wire Formats (transparent passthrough)</span>
        <div style="display:flex;gap:1.1rem;flex-wrap:wrap;padding-block:0.2rem">
          <label class="checkbox-row">
            <input type="checkbox" name="pf-format" value="anthropic" ${fmts.has('anthropic') ? 'checked' : ''} />
            <span><code>anthropic</code> (/v1/messages)</span>
          </label>
          <label class="checkbox-row">
            <input type="checkbox" name="pf-format" value="openai-chat" ${fmts.has('openai-chat') ? 'checked' : ''} />
            <span><code>openai-chat</code> (/v1/chat/completions)</span>
          </label>
          <label class="checkbox-row">
            <input type="checkbox" name="pf-format" value="openai-responses" ${fmts.has('openai-responses') ? 'checked' : ''} />
            <span><code>openai-responses</code> (/v1/responses)</span>
          </label>
        </div>
      </div>

      <div class="field-row">
        <div class="field">
          <label for="pf-strategy">Key Selection Strategy</label>
          <select id="pf-strategy">
            <option value="sequential" ${existing?.key_strategy !== 'round_robin' ? 'selected' : ''}>Sequential (drain #1 before #2)</option>
            <option value="round_robin" ${existing?.key_strategy === 'round_robin' ? 'selected' : ''}>Round-Robin (spread across active keys)</option>
          </select>
        </div>
        <div class="field">
          <label for="pf-timeout">Response Header Timeout (ms)</label>
          <input type="number" id="pf-timeout" min="1000" max="300000" value="${existing?.timeout_ms ?? 60000}" />
        </div>
      </div>

      <div class="field">
        <label for="pf-model-map">Model Mapping (optional, <code>client-pattern=upstream-model</code> per line)</label>
        <textarea id="pf-model-map" rows="3" placeholder="claude-3-7-sonnet-*=claude-3-7-sonnet-20250219\ngpt-5=gpt-4.1">${esc(
          existing ? mapToLines(existing.model_map) : '',
        )}</textarea>
        <label class="checkbox-row" style="margin-block-start:0.25rem">
          <input type="checkbox" id="pf-allowlist" ${existing?.model_allowlist ? 'checked' : ''} />
          <span>Strict model allow-list (only route models present in fetched <code>/v1/models</code> or Model Mapping)</span>
        </label>
      </div>

      <div class="field-row">
        <div class="field">
          <label for="pf-balance-mode">Balance Query Mode</label>
          <select id="pf-balance-mode">
            <option value="standard" ${(existing?.balance_mode ?? 'standard') === 'standard' ? 'selected' : ''}>Standard (/v1/dashboard/billing/*)</option>
            <option value="custom" ${existing?.balance_mode === 'custom' ? 'selected' : ''}>Custom JSON Endpoint</option>
            <option value="none" ${existing?.balance_mode === 'none' ? 'selected' : ''}>None (N/A)</option>
          </select>
        </div>
        <div class="field">
          <label for="pf-recheck-mode">Exhausted Key Re-check Mode</label>
          <select id="pf-recheck-mode">
            <option value="auto" ${(existing?.recheck_mode ?? 'auto') === 'auto' ? 'selected' : ''}>Auto (Balance → 1-token test)</option>
            <option value="balance" ${existing?.recheck_mode === 'balance' ? 'selected' : ''}>Balance endpoint only</option>
            <option value="manual" ${existing?.recheck_mode === 'manual' ? 'selected' : ''}>Manual re-enable only</option>
          </select>
        </div>
      </div>

      <div class="field-row" id="pf-custom-balance-row">
        <div class="field">
          <label for="pf-balance-path">Custom Balance Path</label>
          <input type="text" id="pf-balance-path" value="${esc(existing?.balance_path ?? '')}" placeholder="/api/usage/token" />
        </div>
        <div class="field">
          <label for="pf-balance-field">JSON Field Path</label>
          <input type="text" id="pf-balance-field" value="${esc(existing?.balance_field ?? '')}" placeholder="data.total_available" />
        </div>
        <div class="field">
          <label for="pf-balance-divisor">Divisor</label>
          <input type="number" step="any" id="pf-balance-divisor" value="${existing?.balance_divisor ?? 1}" placeholder="500000" />
        </div>
      </div>

      <div class="field-row">
        <div class="field">
          <label for="pf-recheck-hours">Re-check Interval (hours)</label>
          <input type="number" step="0.25" min="0.25" max="720" id="pf-recheck-hours" value="${existing?.recheck_hours ?? 6}" />
        </div>
        <div class="field">
          <label for="pf-test-model">Test Model (for 1-token health check)</label>
          <input type="text" id="pf-test-model" value="${esc(existing?.test_model ?? '')}" placeholder="Auto-picked from models if blank" />
        </div>
      </div>

      <div class="field">
        <label for="pf-extra-headers">Extra Upstream Headers (optional, <code>Header=Value</code> per line)</label>
        <textarea id="pf-extra-headers" rows="2" placeholder="HTTP-Referer=https://example.com">${esc(
          existing ? mapToLines(existing.extra_headers) : '',
        )}</textarea>
      </div>

      <div style="display:flex;gap:1.5rem;flex-wrap:wrap">
        <label class="checkbox-row">
          <input type="checkbox" id="pf-parse-usage" ${existing?.parse_usage !== false ? 'checked' : ''} />
          <span>Parse token usage from responses</span>
        </label>
        <label class="checkbox-row">
          <input type="checkbox" id="pf-enabled" ${existing?.enabled !== false ? 'checked' : ''} />
          <span>Provider enabled</span>
        </label>
        ${
          !existing
            ? `<label class="checkbox-row">
                <input type="checkbox" id="pf-add-default" checked />
                <span>Append to <code>default</code> route automatically</span>
              </label>`
            : ''
        }
      </div>

      ${
        !existing
          ? `<div class="field" style="border-block-start:1px solid var(--border-subtle);padding-block-start:0.85rem">
              <label for="pf-initial-keys">Initial API Keys (optional, one per line)</label>
              <textarea id="pf-initial-keys" rows="4" placeholder="sk-..."></textarea>
              <span class="field-hint">If provided, the gateway will also auto-fetch <code>/v1/models</code> using the first key.</span>
            </div>`
          : ''
      }
    `;

    openModal(dlg);
  };

  root.querySelector('#btn-new-provider')?.addEventListener('click', () => openProviderModal());
  root.querySelector('#btn-empty-new-provider')?.addEventListener('click', () => openProviderModal());

  root.querySelector('#provider-form')?.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const btn = document.getElementById('provider-submit-btn') as HTMLButtonElement;
    btn.disabled = true;
    try {
      const idVal = (document.getElementById('pf-id') as HTMLInputElement).value;
      const formats = [...root.querySelectorAll<HTMLInputElement>('input[name="pf-format"]:checked')].map(
        (el) => el.value as Format,
      );
      const payload: Record<string, unknown> = {
        name: (document.getElementById('pf-name') as HTMLInputElement).value,
        base_url: (document.getElementById('pf-url') as HTMLInputElement).value,
        formats,
        key_strategy: (document.getElementById('pf-strategy') as HTMLSelectElement).value,
        timeout_ms: Number((document.getElementById('pf-timeout') as HTMLInputElement).value),
        model_map: linesToMap((document.getElementById('pf-model-map') as HTMLTextAreaElement).value),
        model_allowlist: (document.getElementById('pf-allowlist') as HTMLInputElement).checked,
        balance_mode: (document.getElementById('pf-balance-mode') as HTMLSelectElement).value,
        balance_path: (document.getElementById('pf-balance-path') as HTMLInputElement).value || null,
        balance_field: (document.getElementById('pf-balance-field') as HTMLInputElement).value || null,
        balance_divisor: Number((document.getElementById('pf-balance-divisor') as HTMLInputElement).value || 1),
        recheck_mode: (document.getElementById('pf-recheck-mode') as HTMLSelectElement).value,
        recheck_hours: Number((document.getElementById('pf-recheck-hours') as HTMLInputElement).value || 6),
        test_model: (document.getElementById('pf-test-model') as HTMLInputElement).value || null,
        extra_headers: linesToMap((document.getElementById('pf-extra-headers') as HTMLTextAreaElement).value),
        parse_usage: (document.getElementById('pf-parse-usage') as HTMLInputElement).checked,
        enabled: (document.getElementById('pf-enabled') as HTMLInputElement).checked,
      };

      if (idVal) {
        await api.put(`/providers/${idVal}`, payload);
        toast('Provider updated', 'ok');
      } else {
        payload.add_to_default = (document.getElementById('pf-add-default') as HTMLInputElement)?.checked ?? true;
        payload.keys = (document.getElementById('pf-initial-keys') as HTMLTextAreaElement)?.value ?? '';
        const res = await api.post<{ keys: { added: number }; models: string[] | null; models_error: string | null }>(
          '/providers',
          payload,
        );
        const modelMsg = res.models ? `, fetched ${res.models.length} models` : res.models_error ? ` (models: ${res.models_error})` : '';
        toast(`Provider created (${res.keys.added} keys added${modelMsg})`, 'ok');
      }
      (document.getElementById('provider-dialog') as HTMLDialogElement).close();
      await renderProviders(root);
    } catch (e) {
      toast((e as Error).message, 'error');
      btn.disabled = false;
    }
  });

  // Wire provider card buttons
  root.querySelectorAll<HTMLButtonElement>('[data-edit-provider]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const p = byId.get(Number(btn.dataset.editProvider));
      if (p) openProviderModal(p);
    });
  });

  root.querySelectorAll<HTMLButtonElement>('[data-delete-provider]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const p = byId.get(Number(btn.dataset.deleteProvider));
      if (!p || !confirm(`Delete provider "${p.name}" and all ${p.keys.length} of its keys?`)) return;
      btn.disabled = true;
      try {
        await api.del(`/providers/${p.id}`);
        toast(`Deleted provider ${p.name}`, 'ok');
        await renderProviders(root);
      } catch (e) {
        toast((e as Error).message, 'error');
        btn.disabled = false;
      }
    });
  });

  root.querySelectorAll<HTMLButtonElement>('[data-add-keys]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const p = byId.get(Number(btn.dataset.addKeys));
      if (!p) return;
      (document.getElementById('keys-provider-id') as HTMLInputElement).value = String(p.id);
      document.getElementById('keys-dialog-title')!.textContent = `Add API Keys to ${p.name}`;
      (document.getElementById('keys-bulk-input') as HTMLTextAreaElement).value = '';
      (document.getElementById('keys-alias-prefix') as HTMLInputElement).value = '';
      openModal(document.getElementById('keys-dialog') as HTMLDialogElement);
    });
  });

  root.querySelector('#keys-form')?.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const btn = document.getElementById('keys-submit-btn') as HTMLButtonElement;
    btn.disabled = true;
    try {
      const pid = (document.getElementById('keys-provider-id') as HTMLInputElement).value;
      const keys = (document.getElementById('keys-bulk-input') as HTMLTextAreaElement).value;
      const alias_prefix = (document.getElementById('keys-alias-prefix') as HTMLInputElement).value;
      const res = await api.post<{ added: number; duplicates: number }>(`/providers/${pid}/keys`, {
        keys,
        alias_prefix: alias_prefix || undefined,
      });
      toast(`Added ${res.added} keys (${res.duplicates} duplicates skipped)`, 'ok');
      (document.getElementById('keys-dialog') as HTMLDialogElement).close();
      await renderProviders(root);
    } catch (e) {
      toast((e as Error).message, 'error');
      btn.disabled = false;
    }
  });

  root.querySelectorAll<HTMLButtonElement>('[data-fetch-models]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const pid = Number(btn.dataset.fetchModels);
      btn.disabled = true;
      btn.textContent = 'Fetching…';
      try {
        const res = await api.post<{ models: string[] }>(`/providers/${pid}/fetch-models`);
        toast(`Fetched ${res.models.length} models from /v1/models`, 'ok');
        await renderProviders(root);
      } catch (e) {
        toast((e as Error).message, 'error');
        btn.disabled = false;
        btn.textContent = '↻ Fetch Models';
      }
    });
  });

  root.querySelectorAll<HTMLButtonElement>('[data-show-models]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const p = byId.get(Number(btn.dataset.showModels));
      if (!p) return;
      document.getElementById('models-dialog-title')!.textContent = `${p.name} — Models (${p.models.length})`;
      const mapEntries = Object.entries(p.model_map);
      document.getElementById('models-dialog-body')!.innerHTML = `
        ${
          mapEntries.length > 0
            ? `<div>
                <div class="field-label" style="margin-block-end:0.4rem">Configured Model Map (${mapEntries.length})</div>
                <div style="display:flex;flex-wrap:wrap;gap:0.4rem">
                  ${mapEntries.map(([k, v]) => `<span class="tag tag-accent">${esc(k)} → ${esc(v)}</span>`).join('')}
                </div>
              </div>`
            : ''
        }
        <div>
          <div class="field-label" style="margin-block-end:0.4rem">
            Fetched from <code>/v1/models</code> ${p.models_fetched_at ? `(${fmtAgo(p.models_fetched_at)})` : ''}
          </div>
          ${
            p.models.length === 0
              ? `<p class="field-hint">No models fetched yet. Click "Fetch Models" on the provider card.</p>`
              : `<div style="display:flex;flex-wrap:wrap;gap:0.35rem;max-block-size:320px;overflow-y:auto">
                  ${p.models.map((m) => `<span class="tag">${esc(m)}</span>`).join('')}
                </div>`
          }
        </div>
      `;
      openModal(document.getElementById('models-dialog') as HTMLDialogElement);
    });
  });

  root.querySelectorAll<HTMLButtonElement>('[data-check-balances]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const pid = Number(btn.dataset.checkBalances);
      btn.disabled = true;
      btn.textContent = 'Checking…';
      try {
        const res = await api.post<{ results: Array<{ balance: number | null }> }>(`/providers/${pid}/check-balances`);
        const okCount = res.results.filter((r) => r.balance !== null).length;
        toast(`Checked ${res.results.length} keys (${okCount} returned a balance)`, 'ok');
        await renderProviders(root);
      } catch (e) {
        toast((e as Error).message, 'error');
        btn.disabled = false;
        btn.textContent = '$ Check Balances';
      }
    });
  });

  // Key actions
  root.querySelectorAll<HTMLButtonElement>('[data-key-toggle]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = Number(btn.dataset.keyToggle);
      const nextStatus = btn.dataset.nextStatus as 'active' | 'disabled';
      btn.disabled = true;
      try {
        await api.put(`/keys/${id}`, { status: nextStatus });
        toast(`Key marked ${nextStatus}`, 'ok');
        await renderProviders(root);
      } catch (e) {
        toast((e as Error).message, 'error');
        btn.disabled = false;
      }
    });
  });

  root.querySelectorAll<HTMLButtonElement>('[data-key-test]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = Number(btn.dataset.keyTest);
      btn.disabled = true;
      btn.textContent = '…';
      try {
        const r = await api.post<{ ok: boolean; message: string; ms: number }>(`/keys/${id}/test`);
        toast(`${r.message} (${r.ms} ms)`, r.ok ? 'ok' : 'error');
        await renderProviders(root);
      } catch (e) {
        toast((e as Error).message, 'error');
        btn.disabled = false;
        btn.textContent = 'Test';
      }
    });
  });

  root.querySelectorAll<HTMLButtonElement>('[data-key-recheck]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = Number(btn.dataset.keyRecheck);
      btn.disabled = true;
      try {
        const r = await api.post<{ result: string; detail: string }>(`/keys/${id}/recheck`);
        toast(`${r.result}: ${r.detail}`, r.result === 'reactivated' ? 'ok' : 'info');
        await renderProviders(root);
      } catch (e) {
        toast((e as Error).message, 'error');
        btn.disabled = false;
      }
    });
  });

  root.querySelectorAll<HTMLButtonElement>('[data-key-alias]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = Number(btn.dataset.keyAlias);
      const current = btn.dataset.currentAlias ?? '';
      const next = prompt('Key alias:', current);
      if (next === null) return;
      try {
        await api.put(`/keys/${id}`, { alias: next });
        await renderProviders(root);
      } catch (e) {
        toast((e as Error).message, 'error');
      }
    });
  });

  root.querySelectorAll<HTMLButtonElement>('[data-key-del]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = Number(btn.dataset.keyDel);
      if (!confirm('Delete this API key?')) return;
      btn.disabled = true;
      try {
        await api.del(`/keys/${id}`);
        toast('Key deleted', 'ok');
        await renderProviders(root);
      } catch (e) {
        toast((e as Error).message, 'error');
        btn.disabled = false;
      }
    });
  });

  root.querySelectorAll<HTMLButtonElement>('[data-key-move]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const pid = Number(btn.dataset.providerId);
      const kid = Number(btn.dataset.keyId);
      const dir = Number(btn.dataset.keyMove);
      const p = byId.get(pid);
      if (!p) return;
      const ids = p.keys.map((k) => k.id);
      const idx = ids.indexOf(kid);
      const targetIdx = idx + dir;
      if (idx < 0 || targetIdx < 0 || targetIdx >= ids.length) return;
      [ids[idx], ids[targetIdx]] = [ids[targetIdx], ids[idx]];
      btn.disabled = true;
      try {
        await api.post(`/providers/${pid}/keys/reorder`, { ids });
        await renderProviders(root);
      } catch (e) {
        toast((e as Error).message, 'error');
        btn.disabled = false;
      }
    });
  });
}

function renderProviderCard(p: ProviderDTO): string {
  const activeCount = p.keys.filter((k) => k.status === 'active').length;
  return `
    <article class="provider-card">
      <div class="provider-card-top">
        <div>
          <div style="display:flex;align-items:center;gap:0.6rem;flex-wrap:wrap">
            <h2 style="margin:0;font-size:1.1rem">${esc(p.name)}</h2>
            ${p.enabled ? `<span class="pill pill-active">enabled</span>` : `<span class="pill pill-disabled">disabled</span>`}
            <span class="mono" style="color:var(--text-secondary)">${esc(p.base_url)}</span>
          </div>
          <div class="provider-meta">
            ${p.formats.map((f) => `<span class="tag tag-cyan">${esc(f)}</span>`).join('')}
            <span class="tag">strategy: ${esc(p.key_strategy)}</span>
            <span class="tag">recheck: ${esc(p.recheck_mode)} (${p.recheck_hours}h)</span>
            <span class="tag">balance: ${esc(p.balance_mode)}</span>
            ${p.routes.length ? `<span class="tag tag-accent">routes: ${esc(p.routes.join(', '))}</span>` : ''}
          </div>
        </div>
        <div style="display:flex;gap:0.45rem;flex-wrap:wrap">
          <button type="button" class="btn btn-sm btn-primary" data-add-keys="${p.id}">+ Add Keys</button>
          <button type="button" class="btn btn-sm" data-fetch-models="${p.id}">↻ Fetch Models</button>
          <button type="button" class="btn btn-sm" data-show-models="${p.id}">Models (${p.models.length})</button>
          ${p.balance_mode !== 'none' ? `<button type="button" class="btn btn-sm" data-check-balances="${p.id}">$ Check Balances</button>` : ''}
          <button type="button" class="btn btn-sm" data-edit-provider="${p.id}">Edit</button>
          <button type="button" class="btn btn-sm btn-danger" data-delete-provider="${p.id}">Delete</button>
        </div>
      </div>

      ${
        p.keys.length === 0
          ? `<div class="empty-state" style="padding:1.4rem">No API keys added to ${esc(p.name)} yet.</div>`
          : `<div tabindex="0" role="region" aria-label="Keys for ${esc(p.name)}" class="table-wrapper" style="border:0;border-radius:0">
              <table>
                <thead>
                  <tr>
                    <th style="inline-size:70px">Priority</th>
                    <th>Alias / Key Hint</th>
                    <th>Status (${activeCount}/${p.keys.length} active)</th>
                    <th>Balance</th>
                    <th>Status Reason / Schedule</th>
                    <th style="text-align:end">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  ${p.keys
                    .map((k, idx) => {
                      let info = k.status_reason ? esc(k.status_reason) : '—';
                      if (k.status === 'rate_limited' && k.cooldown_until) {
                        info += ` (until ${fmtAgo(k.cooldown_until)})`;
                      } else if (k.status === 'exhausted' && k.next_recheck_at) {
                        info += ` (recheck ${fmtAgo(k.next_recheck_at)})`;
                      }
                      return `<tr>
                        <td>
                          <div style="display:inline-flex;align-items:center;gap:0.2rem">
                            <span class="mono" style="min-inline-size:1.4rem">#${idx + 1}</span>
                            <button type="button" class="btn btn-sm btn-ghost" data-key-move="-1" data-provider-id="${p.id}" data-key-id="${k.id}" ${idx === 0 ? 'disabled' : ''} aria-label="Move key up">↑</button>
                            <button type="button" class="btn btn-sm btn-ghost" data-key-move="1" data-provider-id="${p.id}" data-key-id="${k.id}" ${idx === p.keys.length - 1 ? 'disabled' : ''} aria-label="Move key down">↓</button>
                          </div>
                        </td>
                        <td>
                          <div style="display:flex;align-items:center;gap:0.45rem">
                            <span style="font-weight:500">${esc(k.alias || '—')}</span>
                            <code class="tag">${esc(k.key_hint)}</code>
                            <button type="button" class="btn btn-sm btn-ghost" data-key-alias="${k.id}" data-current-alias="${esc(k.alias)}" aria-label="Rename key">✎</button>
                          </div>
                        </td>
                        <td>${statusPill(k.status)}</td>
                        <td class="mono" title="${k.balance_checked_at ? `Checked ${fmtAgo(k.balance_checked_at)}` : ''}">${fmtBalance(k.balance)}</td>
                        <td style="max-inline-size:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(k.status_reason ?? '')}">${info}</td>
                        <td style="text-align:end">
                          <div style="display:inline-flex;gap:0.35rem;flex-wrap:wrap;justify-content:flex-end">
                            <button type="button" class="btn btn-sm" data-key-test="${k.id}">Test</button>
                            ${k.status === 'exhausted' ? `<button type="button" class="btn btn-sm" data-key-recheck="${k.id}">Recheck</button>` : ''}
                            ${
                              k.status === 'active'
                                ? `<button type="button" class="btn btn-sm" data-key-toggle="${k.id}" data-next-status="disabled">Disable</button>`
                                : `<button type="button" class="btn btn-sm" data-key-toggle="${k.id}" data-next-status="active">Enable</button>`
                            }
                            <button type="button" class="btn btn-sm btn-danger" data-key-del="${k.id}" aria-label="Delete key">✕</button>
                          </div>
                        </td>
                      </tr>`;
                    })
                    .join('')}
                </tbody>
              </table>
            </div>`
      }
    </article>
  `;
}
