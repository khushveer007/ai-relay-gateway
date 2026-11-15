# AGENTS.md — AI Relay Gateway

## Overview

**AI Relay Gateway** is a self-healing, multi-provider, multi-key AI API proxy built for **Claude Code**, **OpenAI Codex CLI**, and standard Anthropic/OpenAI SDK clients. It runs entirely on the **Cloudflare Workers free tier** (Workers + Hono + D1 SQLite + Workers Static Assets + Cron Triggers).

It sits between AI coding clients and multiple upstream providers (official Anthropic/OpenAI APIs, `new-api` / `one-api` relays, OpenRouter, etc.), holding an ordered pool of API keys per provider:
- **Transparent Format Passthrough**: Supports `anthropic` (`/v1/messages`), `openai-chat` (`/v1/chat/completions`), and `openai-responses` (`/v1/responses`), plus a merged `GET /v1/models` endpoint.
- **Automatic Key Rotation**: Rotates to the next key on a provider when a key runs out of balance (`EXHAUSTED`), is rejected (`INVALID_KEY`), or hits a rate limit (`RATE_LIMITED`).
- **Ordered Provider Failover**: Fails over to the next provider in a route's chain when all keys of the current provider are unavailable or when the relay itself fails (`UPSTREAM_ERROR`).
- **200 SSE Stream First-Event Peek**: Buffers up to the first SSE data event before committing the stream to the client so relays that return `HTTP 200` with an `event: error` payload still trigger automatic failover.

---

## Architecture & Directory Layout

```text
├── migrations/
│   └── 0001_init.sql              # D1 SQLite schema & default global error rules seed
├── scripts/
│   ├── setup.mjs                  # Interactive `npm run setup` provisioning & deploy script
│   └── smoke-dashboard.mjs        # End-to-end smoke check of the built dashboard (`--check-headers`: security headers, manifest, icons; `--check-mobile`: 360px audit)
├── src/
│   ├── worker/                    # Cloudflare Worker backend (Hono + TypeScript)
│   │   ├── index.ts               # Worker entry: /v1/* proxy, /api/admin/* (Cache-Control no-store on every response), static assets, cron
│   │   ├── types.ts               # Shared domain types (Provider, ProviderKey, Route, ErrorRule, Config)
│   │   ├── balance.ts             # Balance checking (standard, custom JSON path, none) & 1-token test
│   │   ├── cron.ts                # Scheduled maintenance (cooldowns, exhausted rechecks, log cleanup)
│   │   ├── admin/
│   │   │   ├── auth.ts            # Password login, HMAC session cookie, brute-force & CSRF guard
│   │   │   ├── routes.ts          # Admin REST CRUD (/api/admin/*), incl. POST /providers/test-connection (read-only, keyless, redacting)
│   │   │   └── stats.ts           # Aggregated D1 metrics & time-series queries
│   │   ├── db/
│   │   │   ├── cache.ts           # Per-isolate 30s config cache with version-counter invalidation
│   │   │   ├── crypto.ts          # WebCrypto AES-256-GCM key encryption, SHA-256, HMAC-SHA256
│   │   │   └── repo.ts            # Batched D1 config loader and statement builders
│   │   ├── proxy/
│   │   │   ├── formats.ts         # Format detection, header sanitization, fast regex model rewrite
│   │   │   ├── forward.ts         # Core failover loop (`handleProxy`) and `/v1/models` (`handleModels`)
│   │   │   ├── logs.ts            # Single-INSERT request logging via `ctx.waitUntil`
│   │   │   ├── stream-peek.ts     # First-SSE-event stream peeker (`peekStream`)
│   │   │   └── usage.ts           # Zero-allocation-friendly token usage tap (`UsageTap`)
│   │   └── routing/
│   │       ├── error-rules.ts     # Status code + regex error classifier (`classify`)
│   │       ├── key-state.ts       # In-memory + D1 key state transitions (`applyKeyPatch`)
│   │       ├── model-map.ts       # Exact & glob model mapping and allowlist checks
│   │       ├── resolve-route.ts   # Route resolution (key-bound → model glob → default)
│   │       └── select-key.ts      # Sequential & round-robin key ordering (`orderKeys`)
│   └── dashboard/                 # Single-page admin UI (React 19 + Tailwind 4 + shadcn/ui (Radix), built by Vite into `dist/ui`)
│       ├── index.html             # Dashboard HTML shell: manifest, apple-touch-icon and theme-color links; no third-party stylesheet
│       ├── main.tsx               # React entry: QueryClient, ErrorBoundary, mounts <App />
│       ├── App.tsx                # Session gate (Login vs. AppShell), hash route to view; strict registry of views/*-page.tsx (throws when a view id has no page file)
│       ├── lib/
│       │   ├── api.ts             # Typed admin API client (strict: a non-JSON 2xx is an ApiError), 401 handler, DTO types
│       │   ├── format.ts          # Number, money, time and token formatters, `actionLabel` (the one place that names an action)
│       │   ├── overview.ts        # Range, series bucketing/gap-fill and key label helpers
│       │   ├── guards.ts          # Pure guards, breakpoint constants and shared copy
│       │   ├── routes.ts          # Hash route ids, nav labels and bottom-bar / More slot lists
│       │   ├── queries.ts         # TanStack Query definitions (session, stats, providers, routes, gateway keys, rules, settings)
│       │   ├── provider-form.ts   # Pure add/edit provider model, validators, payload builders, test-connection reducer
│       │   ├── route-form.ts      # Pure route form model and chain helpers
│       │   ├── gateway-snippets.ts # Pure gateway key payload and Claude Code / Codex client setup snippets
│       │   ├── logs-filters.ts    # Pure log filter model, query-string builder and the in-memory filter store
│       │   ├── rule-form.ts       # Pure settings and error rule models, validators and payload builders
│       │   └── utils.ts           # `cn` (clsx + tailwind-merge)
│       ├── hooks/                 # use-session, use-hash-route, use-range, use-media-query, use-now, use-editable-focus, use-load-error-toast, use-key-actions, use-provider-actions, use-route-actions, use-gateway-key-actions, use-logs, use-settings, use-rules
│       ├── components/            # app-shell, bottom-nav, nav, login, error-boundary, page-header, page-error, confirm-dialog, field, copy-button, code-block, responsive-list, responsive-dialog, status-badge
│       │   └── ui/                # shadcn/ui style primitives (badge, button, card, chart, dialog, drawer, sheet, table, alert-dialog, dropdown-menu, native-select, switch, checkbox, collapsible, label, textarea, ...), hand-written from the installed `radix-ui`
│       ├── views/                 # One `{id}-page.tsx` per view id (overview, providers, routes, gateway-keys, logs, settings) plus `__playground.tsx` (dev-only test page)
│       │   ├── overview/          # Overview pieces: header, KPI cards, traffic chart, key matrix, attempt outcomes, provider traffic, top models
│       │   ├── providers/         # Provider cards, key rows, add/edit provider dialog, Advanced section, add keys, models, rename key
│       │   ├── routes/            # Route card and route dialog (Move up / Move down chain builder)
│       │   ├── gateway-keys/      # Gateway key card, create (copy-once reveal), edit, Client setup
│       │   ├── logs/              # Log columns and cards, filters bar (inline and drawer), request detail dialog
│       │   └── settings/          # Settings form, rule tester, error rules list, rule dialog
│       ├── assets/fonts/          # Self-hosted Inter and JetBrains Mono (latin woff2) with a provenance README; Vite hashes them into /assets/
│       ├── styles/                # globals.css (Tailwind 4 theme tokens, dark UI) and fonts.css (@font-face, font-display swap)
│       └── public/                # favicon.svg, manifest.webmanifest, icon-192/512, icon-maskable-512, apple-touch-icon (PNGs rendered from favicon.svg), and `_headers` (security headers on /* plus the immutable /assets/* cache rule)
├── components.json                # shadcn/ui CLI config (radix-nova style, `@/` alias to src/dashboard)
├── test/
│   ├── gateway.test.ts            # Vitest unit & integration test suite (Worker, incl. the add-provider tracer and test-connection cases)
│   ├── stats.test.ts              # Vitest test for stats time-series bucketing
│   ├── dashboard-lib.test.ts      # Vitest tests for dashboard `lib/` helpers (no DOM)
│   ├── provider-form.test.ts      # Provider form model: validation, payloads, edit round trip, test-connection reducer
│   ├── shell.test.ts              # Bottom bar slot lists and the phone shell rules
│   ├── overview-text.test.ts      # Overview and key reason wording helpers
│   ├── api-client.test.ts         # Strict API client and session probe
│   ├── route-form.test.ts         # Route form model and chain helpers
│   ├── gateway-snippets.test.ts   # Gateway key payload and client setup snippets
│   ├── logs-filters.test.ts       # Log filter model, query string, filter store, model line
│   ├── rule-form.test.ts          # Settings and rule models: boundaries, precision, payloads
│   └── raw-imports.d.ts           # Type shim for `?raw` SQL imports in tests
├── wrangler.jsonc                 # Cloudflare Worker, D1, Assets, and Cron configuration
├── vite.config.ts                 # Vite build config (outputs to dist/ui)
└── vitest.config.ts               # Vitest configuration
```

---

## Key Design Constraints & Conventions

1. **Cloudflare Free-Tier CPU Budget (10 ms)**:
   - Avoid `JSON.parse` on large request bodies (Claude Code bodies can exceed 1 MB). Use `extractModel` and `replaceModel` in `src/worker/proxy/formats.ts` which operate via targeted regex on the first `"model"` field.
   - Stream usage extraction (`src/worker/proxy/usage.ts`) checks `chunk.indexOf('_tokens"')` before running regexes so content chunks cost almost zero CPU.
2. **D1 Read/Write Minimization**:
   - Full routing config is loaded in a single `env.DB.batch(...)` call and cached in isolate memory for 30 seconds (`src/worker/db/cache.ts`), checking only `config_version` on refresh.
   - Every admin mutation or key-state change increments `config_version` via `bumpVersionStmt(env.DB)`.
   - On the happy path, a proxied request performs **zero** synchronous D1 writes and queues a single `INSERT INTO request_logs` in `ctx.waitUntil(...)`.
3. **Security**:
   - Upstream API keys are encrypted at rest in `provider_keys.key_enc` using AES-256-GCM derived from `env.ENCRYPTION_KEY`. Never return `key_enc` or plaintext upstream keys from `/api/admin/*`.
   - Client gateway keys (`sk-gw-…`) are stored only as SHA-256 hex digests in `gateway_keys.key_hash`.
   - All non-`GET` requests to `/api/admin/*` must carry `Content-Type: application/json` (enforced in `src/worker/admin/auth.ts`).
   - Every `/api/admin/*` response carries `Cache-Control: no-store` (set in `src/worker/index.ts`, because `_headers` cannot reach Worker responses). `POST /api/admin/providers/test-connection` is read-only: it writes nothing, never returns a key or a model list, and redacts echoed keys.
   - The dashboard is served with `X-Content-Type-Options`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer` and a CSP from `src/dashboard/public/_headers`; keep the `/assets/*` immutable cache rule the only `Cache-Control` rule there. No service worker and no offline cache: a stale key status on a control panel is dangerous.

---

## Development Commands

- `npm run dev` — Build the dashboard UI and start `wrangler dev` on `http://localhost:8787`.
- `npm run dev:ui` — Start Vite dev server on `http://localhost:5173` (proxying `/api` and `/v1` to `:8787`). It also serves the dev-only primitive test page at `#/__playground`; that page is absent from the production build, so `npm run dev` never shows it.
- `npm run build` — Build the dashboard into `dist/ui`.
- `npm run typecheck` — Type-check both the Worker (`tsconfig.json`) and Dashboard (`tsconfig.ui.json`).
- `npm test` — Run the Vitest test suite (`gateway`, `stats`, `dashboard-lib`, `provider-form`, `shell`, `overview-text`, `api-client`, `route-form`, `gateway-snippets`, `logs-filters` and `rule-form` tests under `test/`).
- `node scripts/smoke-dashboard.mjs` — Run the end-to-end smoke check of the built dashboard against a local Worker (it starts `wrangler dev` when none is running, and refuses a Worker that is already running unless `SMOKE_ALLOW_REUSE=1` is set, since it creates and deletes data). It includes a provider round trip (Test connection, then create and delete a provider). Add `--check-headers` to also verify the security headers, the immutable asset cache, the manifest and icons, that no Google font host is named, and `no-store` on admin JSON. Add `--check-mobile` to drive headless Chromium at 360x800 over every page and its main dialog, on the existing local data and again after seeding (it talks only to `127.0.0.1:8787` and removes what it seeded): it fails on sideways page scroll, a tap target under 44px, an input not at 16px, or two overlapping targets.
- `npm run setup` — Interactive provisioning & deployment to Cloudflare.
