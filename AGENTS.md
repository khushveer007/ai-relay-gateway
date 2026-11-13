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
│   └── setup.mjs                  # Interactive `npm run setup` provisioning & deploy script
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
│   └── dashboard/                 # Single-page admin UI (Vite + Vanilla TypeScript)
│       ├── index.html             # Dashboard HTML shell
│       ├── main.ts                # Router, auth session bootstrap, sidebar layout
│       ├── api.ts                 # Typed admin API client, copy-button & modal helpers
│       ├── styles/index.css       # Dark glassmorphic UI styles
│       └── views/                 # Views: overview, providers, routes, gateway-keys, logs, settings
├── test/
│   └── gateway.test.ts            # Vitest unit & integration test suite
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
- `npm run dev:ui` — Start Vite dev server on `http://localhost:5173` (proxying `/api` and `/v1` to `:8787`).
- `npm run build` — Build the dashboard into `dist/ui`.
- `npm run typecheck` — Type-check both the Worker (`tsconfig.json`) and Dashboard (`tsconfig.ui.json`).
- `npm test` — Run the Vitest test suite (`test/gateway.test.ts`).
- `npm run setup` — Interactive provisioning & deployment to Cloudflare.
