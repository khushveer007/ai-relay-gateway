# AI Relay Gateway

## What This Is

A self-hosted AI API proxy on the Cloudflare Workers free tier that sits between coding clients (Claude Code, Codex CLI, Anthropic/OpenAI SDKs) and many upstream providers and relays. It holds an ordered pool of API keys per provider, rotates keys when one runs out of balance, is rejected, or is rate limited, and fails over to the next provider in a route. A built-in admin dashboard manages providers, keys, routes, error rules, gateway keys, and usage stats. It is built for one operator running their own gateway.

This milestone rebuilds the dashboard on React + shadcn/ui so it works fully on a phone, makes adding a provider simpler, makes "drop this key on these error codes and keep it off until I re-enable it" obvious to set up, and adds per-model pricing so usage monitoring shows cost.

## Core Value

Requests from Claude Code and Codex keep working through key rotation and provider failover, and the operator can see and control every key, rule, and dollar from any device.

## Requirements

### Validated

<!-- Inferred from the existing codebase (mapped 2026-11-13, commit 714edac). -->

- ✓ Transparent passthrough for `anthropic` (`/v1/messages`), `openai-chat` (`/v1/chat/completions`), and `openai-responses` (`/v1/responses`), plus merged `GET /v1/models` — existing
- ✓ Gateway key auth (`sk-gw-…`, stored as SHA-256 hashes), optionally bound to a route — existing
- ✓ Route resolution: key-bound route → first model-glob match → default route — existing
- ✓ Per-provider key pools with sequential or round-robin ordering — existing
- ✓ Automatic key rotation on EXHAUSTED / INVALID_KEY / RATE_LIMITED and provider failover on UPSTREAM_ERROR, capped at 40 attempts — existing
- ✓ First-SSE-event peek so relays returning HTTP 200 with `event: error` still trigger failover — existing
- ✓ Error classification by status code ranges and case-insensitive body regex, provider rules before global rules, priority ordered, with a rule tester — existing
- ✓ Key states: `active`, `exhausted` (cron rechecks via balance → 1-token test), `rate_limited` (cooldown), `invalid` (stays off until manual change), `disabled` — existing
- ✓ Balance checking: standard endpoint, custom JSON path with divisor, or none — existing
- ✓ Model mapping (exact + glob) and optional model allowlist per provider — existing
- ✓ Upstream keys encrypted at rest with AES-256-GCM; never returned from the admin API — existing
- ✓ Admin dashboard (vanilla TS + Vite): password login with HMAC session cookie, brute-force guard, CSRF via JSON content-type; views for overview, providers, routes, gateway keys, logs, settings/rules — existing
- ✓ Request logging (one INSERT via `ctx.waitUntil`) with token usage (input, output, cache read), latency, TTFB, failover trail — existing
- ✓ Stats: totals and time series by model/provider/key — existing
- ✓ Cron: clear expired cooldowns, recheck due exhausted keys, refresh stale balances, daily log cleanup — existing
- ✓ Interactive `npm run setup` provisioning and deploy — existing
- ✓ Dashboard rebuilt on React + shadcn/ui (Tailwind, Radix primitives), still built by Vite into `dist/ui` and served as Workers Static Assets — Phase 1 & Phase 2
- ✓ Every existing view and action works on the new stack: overview, providers + keys, routes, gateway keys, logs, settings, error rules, rule tester, login — Phase 1 & Phase 2
- ✓ Fully usable on a phone: every management task (add provider, paste keys, edit routes and rules, view stats and logs) works at phone widths, with no horizontal page scrolling and touch-sized controls — Phase 2
- ✓ Tables collapse into card or stacked layouts on narrow screens; dialogs become full-screen sheets or drawers on mobile — Phase 1 & Phase 2
- ✓ The add/edit provider dialog shows only the basics up front: name, base URL, and API keys — Phase 2
- ✓ Everything else (formats, key strategy, timeout, model map, allowlist, balance mode/path/field/divisor, recheck mode/interval, test model, extra headers, parse usage) sits in a collapsed "Advanced" section with sensible defaults — Phase 2
- ✓ A provider can be created by filling only the basic fields — Phase 2
- ✓ Error-rule actions are shown in plain language, e.g. "Drop key until I re-enable it", "Pause key for N min", "Mark out of balance (auto-recheck)", "Try next provider", "Return error to client", instead of raw `EXHAUSTED` / `INVALID_KEY` codes — Phase 3
- ✓ The provider dialog has a per-provider drop list: "Drop key on status codes: 403, 418", with an optional "only if message contains" text — Phase 3
- ✓ A dropped key is never retried by requests or by cron until the operator re-enables it — Phase 3
- ✓ A dropped key shows the status code, error message, and time it was dropped, with a "Re-enable" button — Phase 3
- ✓ The price table supports input, output, cache-read, and cache-write rates per million tokens. The operator can import the public catalog on demand and override individual rates — Phase 4
- ✓ Relay model names resolve through catalog matches or operator-pinned aliases. Unmatched models appear in Prices and Overview — Phase 4
- ✓ Request Logs shows the stored list-price cost or explains why cost is unavailable. Later price edits preserve stored cost, and the daily rollup preserves totals beyond raw log retention — Phase 4

### Active

**Per-model pricing and cost monitoring**
- [ ] Refresh catalog prices daily for models seen in logs and let the operator backfill retained requests with missing cost
- [ ] Dashboard shows cost totals for today, 7 days, and 30 days, with a trend chart and breakdowns by model, provider, and gateway key

### Out of Scope

- Per-provider price multipliers or "actual spend" costing — operator chose list price only; keeps cost comparable across providers
- Recalculating historical cost when prices change — cost is frozen per request by choice
- A guided multi-step wizard or provider-type presets for adding providers — operator chose basic + collapsed advanced instead
- Changes to the proxy hot path beyond what pricing and drop rules need — the failover engine is the validated core and stays as is
- Items from `.planning/codebase/CONCERNS.md` (distributed brute-force tracking, audit log, alerting/webhooks, encryption key rotation tooling, ReDoS guarding, admin rate limiting, body size limit) — not requested for this milestone; tracked there for later
- Multi-user or role-based admin access — single operator
- Paid-tier Cloudflare features — must stay on the free tier

## Context

- **Existing system:** Brownfield. Full codebase map lives in `.planning/codebase/` (ARCHITECTURE, STACK, STRUCTURE, CONVENTIONS, INTEGRATIONS, TESTING, CONCERNS), mapped at commit `714edac`.
- **Current dashboard:** React and shadcn/ui in `src/dashboard/`, built with Vite and served as Workers Static Assets. The responsive provider dialog exposes the basics first, with Advanced and Drop keys sections.
- **Key-drop behavior:** The gateway reuses the `invalid` state for dropped keys and stores the first drop's status code, message, and time. A provider's drop list takes precedence over global rules. Test reports the result while the key stays dropped. Re-enable returns it to rotation.
- **Usage and cost capture:** `src/worker/proxy/usage.ts` extracts input, output, cache-read, and cache-write tokens. The serving attempt fixes the price using its upstream model and configuration snapshot. `request_logs` stores cost and price provenance, and the daily rollup preserves totals after raw log cleanup.
- **Primary clients:** Claude Code and OpenAI Codex CLI, often through `new-api` / `one-api` relays whose model names carry suffixes and dates.
- **Operator:** One person running their own gateway, wanting full management from a phone as well as desktop.

## Constraints

- **Platform**: Cloudflare Workers free tier (Workers + Hono + D1 + Static Assets + Cron) — the project's reason to exist is running free
- **CPU budget**: 10 ms per request — cost calculation on the proxy path must be a cached lookup, not a parse or a network call; price dataset fetching happens in cron or admin actions, never per request
- **D1 usage**: Zero synchronous D1 writes on the happy path; cost is written in the same single `request_logs` INSERT queued in `ctx.waitUntil`
- **Config caching**: Price table, if it's part of routing config, must load in the existing single `env.DB.batch(...)` and respect `config_version` invalidation
- **Security**: Never return `key_enc` or plaintext upstream keys from `/api/admin/*`; all non-GET admin requests keep requiring `Content-Type: application/json`
- **Schema changes**: Additive D1 migrations (new `migrations/000N_*.sql`) so existing deployments upgrade in place without data loss
- **Bundle**: Dashboard ships as static assets; React + shadcn adds client bundle weight but none to the Worker bundle
- **Tests**: `npm run typecheck` and `npm test` stay green

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Rebuild dashboard on React + shadcn/ui | Mature, accessible components (Radix), responsive patterns, largest ecosystem; components live in the repo | — Pending |
| Revamp first, then build features on the new UI | Avoids building the provider dialog, rules UI, and cost views twice | — Pending |
| Provider dialog = basics + collapsed Advanced | Smallest change that removes the wall of 18 fields | — Pending |
| Reuse `error_rules` and the `invalid` state for key drop | Keep dropped keys out of rotation until the operator re-enables them | Phase 3 verified the D1 and in-memory guards and report-only Test |
| Per-provider drop list (status codes + optional message match) | Common case shouldn't need the global rules page | Phase 3 verified provider-level editing and precedence over global rules |
| Cost = official list price | Simple, comparable across providers | Phase 4 verified frozen list-price cost across the supported formats |
| Prices filled from a public dataset with manual override | The catalog supplies baseline rates and overrides handle gaps | Phase 4 verified on-demand LiteLLM import and field overrides. Daily refresh is in Phase 5 |
| Match relay model names and allow exact alias pins | Relay names can carry dates and suffixes or require an operator choice | Phase 4 verified catalog matches, pins, and unpriced models |
| Freeze cost per request at log time | Preserve historical totals through later price edits | Phase 4 verified price and alias edits preserve the original request cost and provenance |
| Full mobile parity (all management tasks) | Operator wants to manage everything from a phone | — Pending |

## Evolution

This document evolves at phase transitions and milestone boundaries.

**After each phase transition** (via `/gsd-transition`):
1. Requirements invalidated? → Move to Out of Scope with reason
2. Requirements validated? → Move to Validated with phase reference
3. New requirements emerged? → Add to Active
4. Decisions to log? → Add to Key Decisions
5. "What This Is" still accurate? → Update if drifted

**After each milestone** (via `/gsd-complete-milestone`):
1. Full review of all sections
2. Core Value check — still the right priority?
3. Audit Out of Scope — reasons still valid?
4. Update Context with current state

---
*Last updated: 2026-11-26 after Phase 4*
