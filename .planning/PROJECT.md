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

### Active

**Dashboard revamp (lands first; later features are built on it)**
- [ ] Dashboard rebuilt on React + shadcn/ui (Tailwind, Radix primitives), still built by Vite into `dist/ui` and served as Workers Static Assets
- [ ] Every existing view and action works on the new stack: overview, providers + keys, routes, gateway keys, logs, settings, error rules, rule tester, login
- [ ] Fully usable on a phone: every management task (add provider, paste keys, edit routes and rules, view stats and logs) works at phone widths, with no horizontal page scrolling and touch-sized controls
- [ ] Tables collapse into card or stacked layouts on narrow screens; dialogs become full-screen sheets or drawers on mobile

**Simpler add-provider dialog**
- [ ] The add/edit provider dialog shows only the basics up front: name, base URL, and API keys
- [ ] Everything else (formats, key strategy, timeout, model map, allowlist, balance mode/path/field/divisor, recheck mode/interval, test model, extra headers, parse usage) sits in a collapsed "Advanced" section with sensible defaults
- [ ] A provider can be created by filling only the basic fields

**Clear key-drop rules**
- [ ] Error-rule actions are shown in plain language, e.g. "Drop key until I re-enable it", "Pause key for N min", "Mark out of balance (auto-recheck)", "Try next provider", "Return error to client", instead of raw `EXHAUSTED` / `INVALID_KEY` codes
- [ ] The provider dialog has a per-provider drop list: "Drop key on status codes: 403, 418", with an optional "only if message contains" text
- [ ] A dropped key is never retried by requests or by cron until the operator re-enables it
- [ ] A dropped key shows the status code, error message, and time it was dropped, with a "Re-enable" button

**Per-model pricing and cost monitoring**
- [ ] Every model has input, output, cache-read, and cache-write prices per million tokens
- [ ] Prices auto-fill from a public price dataset (e.g. LiteLLM or OpenRouter), and the operator can override any model by hand
- [ ] Relay model names that don't match exactly resolve through fuzzy/family matching (e.g. `claude-sonnet-4-5-20250929-thinking` → `claude-sonnet-4-5`); models still unmatched are listed as unpriced
- [ ] Cost uses official list prices
- [ ] Each request log stores its cost at the time it ran, so later price edits don't change past totals
- [ ] Dashboard shows cost: totals for today / 7 days / 30 days with a trend chart, a breakdown by model and by provider, a breakdown per gateway key, and per-request cost in the logs

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
- **Current dashboard:** Vanilla TypeScript SPA in `src/dashboard/` (about 2,700 lines of TS across `main.ts`, `api.ts`, and six views, plus about 970 lines of hand-written dark glassmorphic CSS). The provider dialog in `src/dashboard/views/providers.ts` has about 18 fields with no grouping. The typed admin API client in `api.ts` can be carried over.
- **Existing drop behavior:** The engine already supports a "stays off" state. `INVALID_KEY` sets `status = 'invalid'` with no `next_recheck_at`, and cron only rechecks `exhausted` keys. Default global rules map 401 and invalid-token messages to `INVALID_KEY`, 402 and balance messages to `EXHAUSTED` (auto-recheck), and 403 to a 10-minute `RATE_LIMITED` cooldown. The operator's problem is that the rules UI doesn't make this clear or quick to set up, so the work is mostly UX plus a per-provider drop list on top of the existing `error_rules` table.
- **Usage data available for pricing:** `src/worker/proxy/usage.ts` extracts `input_tokens`, `output_tokens`, and cache read tokens (`cache_read_input_tokens` / `cached_tokens`). It does not capture Anthropic `cache_creation_input_tokens` today, so cache-write pricing needs that extraction added. `request_logs` has `model` and `upstream_model`; pricing should key off the upstream model the provider actually served.
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
| Key-drop work is mainly UX over existing `error_rules` + `invalid` state | Engine already keeps `invalid` keys off until manual re-enable; the gap is clarity and quick setup | — Pending |
| Per-provider drop list (status codes + optional message match) | Common case shouldn't need the global rules page | — Pending |
| Cost = official list price | Simple, comparable across providers | — Pending |
| Prices auto-filled from a public dataset with manual override | Covers hundreds of models without hand entry; overrides handle gaps | — Pending |
| Fuzzy/family matching for relay model names before marking unpriced | Relay names carry dates and suffixes that never match exactly | — Pending |
| Freeze cost per request at log time | Editing a price later must not rewrite history | — Pending |
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
*Last updated: 2026-11-13 after initialization*
