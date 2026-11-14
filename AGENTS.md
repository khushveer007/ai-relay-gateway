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
│   └── smoke-dashboard.mjs        # End-to-end smoke check of the built dashboard (`--check-headers` verifies dist/ui/_headers)
├── src/
│   ├── worker/                    # Cloudflare Worker backend (Hono + TypeScript)
│   │   ├── index.ts               # Worker entry: /v1/* proxy, /api/admin/*, static assets, cron
│   │   ├── types.ts               # Shared domain types (Provider, ProviderKey, Route, ErrorRule, Config)
│   │   ├── balance.ts             # Balance checking (standard, custom JSON path, none) & 1-token test
│   │   ├── cron.ts                # Scheduled maintenance (cooldowns, exhausted rechecks, log cleanup)
│   │   ├── admin/
│   │   │   ├── auth.ts            # Password login, HMAC session cookie, brute-force & CSRF guard
│   │   │   ├── routes.ts          # Admin REST CRUD (/api/admin/*)
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
│       ├── index.html             # Dashboard HTML shell
│       ├── main.tsx               # React entry: QueryClient, ErrorBoundary, mounts <App />
│       ├── App.tsx                # Session gate (Login vs. AppShell), hash route to view
│       ├── lib/
│       │   ├── api.ts             # Typed admin API client, ApiError, 401 handler, DTO types
│       │   ├── format.ts          # Number, money, time and token formatters
│       │   ├── overview.ts        # Range, series bucketing/gap-fill and key label helpers
│       │   ├── guards.ts          # Pure guards, breakpoint constants and shared copy
│       │   ├── routes.ts          # Hash route ids and nav labels
│       │   ├── queries.ts         # TanStack Query definitions (stats, providers)
│       │   └── utils.ts           # `cn` (clsx + tailwind-merge)
│       ├── hooks/                 # use-session, use-hash-route, use-range, use-media-query, use-now, use-key-actions
│       ├── components/            # app-shell, nav, login, error-boundary, responsive-list, responsive-dialog, status-badge
│       │   └── ui/                # shadcn/ui primitives (badge, button, card, chart, dialog, drawer, sheet, table, ...)
│       ├── views/                 # overview-page.tsx, next-phase.tsx (placeholder for pages rebuilt in Phase 2), __playground.tsx (dev-only test page)
│       │   └── overview/          # Overview pieces: header, KPI cards, traffic chart, key matrix, attempt outcomes, provider traffic, top models
│       ├── styles/globals.css     # Tailwind 4 theme tokens and dark UI styles
│       └── public/                # favicon.svg and `_headers` (immutable cache rule for hashed assets)
├── components.json                # shadcn/ui CLI config (radix-nova style, `@/` alias to src/dashboard)
├── test/
│   ├── gateway.test.ts            # Vitest unit & integration test suite (Worker)
│   ├── stats.test.ts              # Vitest test for stats time-series bucketing
│   ├── dashboard-lib.test.ts      # Vitest tests for dashboard `lib/` helpers (no DOM)
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

---

## Development Commands

- `npm run dev` — Build the dashboard UI and start `wrangler dev` on `http://localhost:8787`.
- `npm run dev:ui` — Start Vite dev server on `http://localhost:5173` (proxying `/api` and `/v1` to `:8787`). It also serves the dev-only primitive test page at `#/__playground`; that page is absent from the production build, so `npm run dev` never shows it.
- `npm run build` — Build the dashboard into `dist/ui`.
- `npm run typecheck` — Type-check both the Worker (`tsconfig.json`) and Dashboard (`tsconfig.ui.json`).
- `npm test` — Run the Vitest test suite (`test/gateway.test.ts`, `test/stats.test.ts`, `test/dashboard-lib.test.ts`).
- `node scripts/smoke-dashboard.mjs` — Run the end-to-end smoke check of the built dashboard (add `--check-headers` to also verify `dist/ui/_headers`).
- `npm run setup` — Interactive provisioning & deployment to Cloudflare.
