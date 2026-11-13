import {
  actionPill,
  api,
  esc,
  openModal,
  toast,
  type Action,
  type ErrorRuleDTO,
  type ProviderDTO,
  type SettingsDTO,
} from '../api';

export async function renderSettings(root: HTMLElement): Promise<void> {
  root.innerHTML = `<div class="empty-state">Loading settings and error rules…</div>`;

  const [settings, rulesRes, provRes] = await Promise.all([
    api.get<SettingsDTO>('/settings'),
    api.get<{ rules: ErrorRuleDTO[]; actions: Action[] }>('/rules'),
    api.get<{ providers: ProviderDTO[] }>('/providers'),
  ]);

  const rules = rulesRes.rules;
  const actions = rulesRes.actions;
  const providers = provRes.providers;
  const provMap = new Map(providers.map((p) => [p.id, p]));
  const ruleMap = new Map(rules.map((r) => [r.id, r]));

  root.innerHTML = `
    <header class="page-header">
      <div>
        <h1 class="page-title">Settings &amp; Error Classification Rules</h1>
        <p class="page-subtitle">Configure global retry budgets, log retention, and regex/status rules that decide when to rotate keys or switch providers.</p>
      </div>
      <div class="header-actions">
        <button type="button" class="btn btn-primary" id="btn-new-rule">+ Add Error Rule</button>
      </div>
    </header>

    <div class="grid-2">
      <section class="card">
        <div class="card-header">
          <div>
            <h2 class="card-title">Gateway Limits &amp; Maintenance</h2>
            <p class="card-subtitle">Config version #${settings.config_version}</p>
          </div>
        </div>
        <form id="settings-form" style="display:flex;flex-direction:column;gap:0.9rem">
          <div class="field-row">
            <div class="field">
              <label for="st-max-attempts">Max Attempts per Request (1–40)</label>
              <input type="number" id="st-max-attempts" min="1" max="40" value="${settings.max_attempts}" required />
              <span class="field-hint">Caps total key + provider failovers per client call (Cloudflare Free limit is 50 subrequests).</span>
            </div>
            <div class="field">
              <label for="st-retention">Log Retention (days, 1–90)</label>
              <input type="number" id="st-retention" min="1" max="90" value="${settings.log_retention_days}" required />
              <span class="field-hint">Daily 03:00 UTC cron purges older rows from D1.</span>
            </div>
          </div>
          <div class="field">
            <label for="st-balance-hours">Active Key Balance Refresh Interval (hours)</label>
            <input type="number" step="0.5" min="0.5" max="168" id="st-balance-hours" value="${settings.balance_refresh_hours}" required />
          </div>
          <div>
            <button type="submit" class="btn btn-primary" id="st-save-btn">Save Settings</button>
          </div>
        </form>
      </section>

      <section class="card">
        <div class="card-header">
          <div>
            <h2 class="card-title">Dry-Run Classifier Tester</h2>
            <p class="card-subtitle">Test how the gateway classifies an upstream HTTP status and response body</p>
          </div>
        </div>
        <form id="rule-test-form" style="display:flex;flex-direction:column;gap:0.75rem">
          <div class="field-row">
            <div class="field">
              <label for="rt-provider">Provider Scope</label>
              <select id="rt-provider">
                <option value="0">Global rules only</option>
                ${providers.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join('')}
              </select>
            </div>
            <div class="field">
              <label for="rt-status">HTTP Status</label>
              <input type="number" id="rt-status" value="429" min="0" max="599" />
            </div>
            <div class="field">
              <label for="rt-retry">Retry-After Header</label>
              <input type="text" id="rt-retry" placeholder="optional, e.g. 30" />
            </div>
          </div>
          <div class="field">
            <label for="rt-body">Sample Upstream Error Body</label>
            <textarea id="rt-body" rows="3">{"error":{"message":"You exceeded your current quota, please check your plan and billing details."}}</textarea>
          </div>
          <div style="display:flex;align-items:center;gap:0.85rem;flex-wrap:wrap">
            <button type="submit" class="btn">Classify Sample</button>
            <div id="rt-result" style="font-size:0.84rem"></div>
          </div>
        </form>
      </section>
    </div>

    <section class="card">
      <div class="card-header">
        <div>
          <h2 class="card-title">Error Classification Rules (${rules.length})</h2>
          <p class="card-subtitle">
            Per-provider rules always run before global rules, ordered by ascending <code>priority</code>.
            Actions: <code>EXHAUSTED</code> / <code>INVALID_KEY</code> / <code>RATE_LIMITED</code> rotate to the next key; <code>UPSTREAM_ERROR</code> switches to the next provider; <code>CLIENT_ERROR</code> returns immediately to the client.
          </p>
        </div>
      </div>

      <div tabindex="0" role="region" aria-label="Error classification rules" class="table-wrapper">
        <table>
          <thead>
            <tr>
              <th>Scope</th>
              <th>Priority</th>
              <th>HTTP Statuses</th>
              <th>Body Regex (case-insensitive)</th>
              <th>Action</th>
              <th>Note</th>
              <th style="text-align:end">Actions</th>
            </tr>
          </thead>
          <tbody>
            ${rules
              .map((r) => {
                const scope = r.provider_id ? provMap.get(r.provider_id)?.name ?? `Provider #${r.provider_id}` : 'Global';
                return `<tr style="${r.enabled ? '' : 'opacity:0.5'}">
                  <td>
                    <span class="tag ${r.provider_id ? 'tag-accent' : ''}">${esc(scope)}</span>
                  </td>
                  <td class="mono">${r.priority}</td>
                  <td class="mono">${esc(r.status_codes || 'any')}</td>
                  <td class="mono" style="max-inline-size:320px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(
                    r.body_regex ?? '',
                  )}">
                    ${r.body_regex ? `<code>${esc(r.body_regex)}</code>` : '<span style="color:var(--text-muted)">any body</span>'}
                  </td>
                  <td>
                    ${actionPill(r.action)}
                    ${r.action === 'RATE_LIMITED' && r.cooldown_s ? `<span class="mono" style="font-size:0.74rem;color:var(--text-secondary)">${r.cooldown_s}s</span>` : ''}
                  </td>
                  <td style="color:var(--text-secondary)">${esc(r.note ?? '')}</td>
                  <td style="text-align:end">
                    <div style="display:inline-flex;gap:0.35rem">
                      <button type="button" class="btn btn-sm" data-edit-rule="${r.id}">Edit</button>
                      <button type="button" class="btn btn-sm btn-danger" data-del-rule="${r.id}">✕</button>
                    </div>
                  </td>
                </tr>`;
              })
              .join('')}
          </tbody>
        </table>
      </div>
    </section>

    <dialog id="rule-dialog" closedby="any" aria-labelledby="rule-dialog-title">
      <form id="rule-form" method="dialog">
        <div class="dialog-header">
          <h2 id="rule-dialog-title">Add Error Rule</h2>
          <button type="button" class="btn btn-sm btn-ghost" data-close-rule-dialog aria-label="Close">✕</button>
        </div>
        <div class="dialog-body" id="rule-dialog-body"></div>
        <div class="dialog-footer">
          <button type="button" class="btn" data-close-rule-dialog>Cancel</button>
          <button type="submit" class="btn btn-primary" id="rule-submit-btn">Save Rule</button>
        </div>
      </form>
    </dialog>
  `;

  root.querySelector('#settings-form')?.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const btn = document.getElementById('st-save-btn') as HTMLButtonElement;
    btn.disabled = true;
    try {
      await api.put('/settings', {
        max_attempts: Number((document.getElementById('st-max-attempts') as HTMLInputElement).value),
        log_retention_days: Number((document.getElementById('st-retention') as HTMLInputElement).value),
        balance_refresh_hours: Number((document.getElementById('st-balance-hours') as HTMLInputElement).value),
      });
      toast('Settings saved', 'ok');
      await renderSettings(root);
    } catch (e) {
      toast((e as Error).message, 'error');
      btn.disabled = false;
    }
  });

  root.querySelector('#rule-test-form')?.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const out = document.getElementById('rt-result')!;
    out.textContent = 'Classifying…';
    try {
      const res = await api.post<{ action: Action; ruleId: number | null; cooldownS: number | null; reason: string }>(
        '/rules/test',
        {
          provider_id: Number((document.getElementById('rt-provider') as HTMLSelectElement).value),
          status: Number((document.getElementById('rt-status') as HTMLInputElement).value),
          retry_after: (document.getElementById('rt-retry') as HTMLInputElement).value || null,
          body: (document.getElementById('rt-body') as HTMLTextAreaElement).value,
        },
      );
      out.innerHTML = `${actionPill(res.action)} <span class="mono">${
        res.ruleId ? `(matched rule #${res.ruleId})` : '(fallback rule)'
      }${res.cooldownS ? ` cooldown=${res.cooldownS}s` : ''}</span> — ${esc(res.reason)}`;
    } catch (e) {
      out.textContent = (e as Error).message;
    }
  });

  const openRuleModal = (existing?: ErrorRuleDTO) => {
    const dlg = document.getElementById('rule-dialog') as HTMLDialogElement;
    document.getElementById('rule-dialog-title')!.textContent = existing ? `Edit Rule #${existing.id}` : 'Add Error Rule';
    document.getElementById('rule-dialog-body')!.innerHTML = `
      <input type="hidden" id="erf-id" value="${existing ? existing.id : ''}" />
      <div class="field-row">
        <div class="field">
          <label for="erf-provider">Scope</label>
          <select id="erf-provider">
            <option value="">Global (all providers)</option>
            ${providers
              .map(
                (p) =>
                  `<option value="${p.id}" ${existing?.provider_id === p.id ? 'selected' : ''}>Provider: ${esc(p.name)}</option>`,
              )
              .join('')}
          </select>
        </div>
        <div class="field">
          <label for="erf-priority">Priority (lower runs first)</label>
          <input type="number" id="erf-priority" min="0" max="100000" value="${existing?.priority ?? 25}" required />
        </div>
      </div>

      <div class="field-row">
        <div class="field">
          <label for="erf-status">HTTP Status Filter (blank = any, including 200 SSE)</label>
          <input type="text" id="erf-status" value="${esc(existing?.status_codes ?? '')}" placeholder="e.g. 402 or 401,403 or 500-599" />
        </div>
        <div class="field">
          <label for="erf-action">Action *</label>
          <select id="erf-action">
            ${actions
              .map((a) => `<option value="${a}" ${existing?.action === a ? 'selected' : ''}>${a}</option>`)
              .join('')}
          </select>
        </div>
        <div class="field">
          <label for="erf-cooldown">Cooldown (sec, RATE_LIMITED only)</label>
          <input type="number" id="erf-cooldown" min="1" max="604800" value="${existing?.cooldown_s ?? 60}" />
        </div>
      </div>

      <div class="field">
        <label for="erf-regex">Body Regex (case-insensitive, blank = match any body)</label>
        <textarea id="erf-regex" rows="3" placeholder="insufficient_quota|余额不足">${esc(existing?.body_regex ?? '')}</textarea>
      </div>

      <div class="field">
        <label for="erf-note">Note / Description</label>
        <input type="text" id="erf-note" value="${esc(existing?.note ?? '')}" placeholder="Why this rule exists" />
      </div>

      <label class="checkbox-row">
        <input type="checkbox" id="erf-enabled" ${existing?.enabled !== false ? 'checked' : ''} />
        <span>Rule enabled</span>
      </label>
    `;
    openModal(dlg);
  };

  root.querySelectorAll<HTMLButtonElement>('[data-close-rule-dialog]').forEach((btn) => {
    btn.addEventListener('click', () => (document.getElementById('rule-dialog') as HTMLDialogElement).close());
  });

  root.querySelector('#btn-new-rule')?.addEventListener('click', () => openRuleModal());

  root.querySelectorAll<HTMLButtonElement>('[data-edit-rule]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const r = ruleMap.get(Number(btn.dataset.editRule));
      if (r) openRuleModal(r);
    });
  });

  root.querySelectorAll<HTMLButtonElement>('[data-del-rule]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = Number(btn.dataset.delRule);
      if (!confirm('Delete this error rule?')) return;
      btn.disabled = true;
      try {
        await api.del(`/rules/${id}`);
        toast('Rule deleted', 'ok');
        await renderSettings(root);
      } catch (e) {
        toast((e as Error).message, 'error');
        btn.disabled = false;
      }
    });
  });

  root.querySelector('#rule-form')?.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const btn = document.getElementById('rule-submit-btn') as HTMLButtonElement;
    btn.disabled = true;
    try {
      const id = (document.getElementById('erf-id') as HTMLInputElement).value;
      const provVal = (document.getElementById('erf-provider') as HTMLSelectElement).value;
      const payload = {
        provider_id: provVal ? Number(provVal) : null,
        priority: Number((document.getElementById('erf-priority') as HTMLInputElement).value),
        status_codes: (document.getElementById('erf-status') as HTMLInputElement).value,
        action: (document.getElementById('erf-action') as HTMLSelectElement).value,
        cooldown_s: Number((document.getElementById('erf-cooldown') as HTMLInputElement).value || 60),
        body_regex: (document.getElementById('erf-regex') as HTMLTextAreaElement).value || null,
        note: (document.getElementById('erf-note') as HTMLInputElement).value || null,
        enabled: (document.getElementById('erf-enabled') as HTMLInputElement).checked,
      };
      if (id) {
        await api.put(`/rules/${id}`, payload);
        toast('Error rule updated', 'ok');
      } else {
        await api.post('/rules', payload);
        toast('Error rule created', 'ok');
      }
      (document.getElementById('rule-dialog') as HTMLDialogElement).close();
      await renderSettings(root);
    } catch (e) {
      toast((e as Error).message, 'error');
      btn.disabled = false;
    }
  });
}
