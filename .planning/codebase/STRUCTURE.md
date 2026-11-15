---
last_mapped_commit: 714edac233d72505a98572dd49b8ebe910ba5bdc
last_mapped_at: 2026-11-13
---
# Codebase Structure

**Analysis Date:** 2026-11-13

## Directory Layout

```
gateway/
├── migrations/
│   └── 0001_init.sql                    # D1 SQLite schema initialization
├── scripts/
│   └── setup.mjs                        # Interactive provisioning & deployment script
├── src/
│   ├── worker/                          # Cloudflare Worker backend (TypeScript)
│   │   ├── index.ts                     # Hono app & Worker entry point
│   │   ├── types.ts                     # Shared domain types & interfaces
│   │   ├── balance.ts                   # Balance checking & 1-token key tests
│   │   ├── cron.ts                      # Scheduled maintenance tasks
│   │   ├── admin/                       # Admin REST API
│   │   │   ├── auth.ts                  # Password login, session cookies, brute-force guard
│   │   │   ├── routes.ts                # Admin CRUD endpoints
│   │   │   └── stats.ts                 # Aggregated metrics & time-series queries
│   │   ├── db/                          # Database & caching layer
│   │   │   ├── cache.ts                 # Per-isolate 30s config cache with version invalidation
│   │   │   ├── crypto.ts                # AES-256-GCM encryption, SHA-256, HMAC
│   │   │   └── repo.ts                  # D1 config loader & SQL builders
│   │   ├── proxy/                       # Request proxy & forwarding
│   │   │   ├── formats.ts               # Format detection, header building, model extraction
│   │   │   ├── forward.ts               # Core failover loop & response handling
│   │   │   ├── logs.ts                  # Request logging
│   │   │   ├── stream-peek.ts           # SSE stream buffering & error detection
│   │   │   └── usage.ts                 # Token usage extraction from responses
│   │   └── routing/                     # Routing & failover logic
│   │       ├── error-rules.ts           # Error classification by status & regex
│   │       ├── key-state.ts             # Key state transitions & patches
│   │       ├── model-map.ts             # Model glob matching & allowlist
│   │       ├── resolve-route.ts         # Route resolution (key-bound → model → default)
│   │       └── select-key.ts            # Key ordering (sequential/round-robin)
│   └── dashboard/                       # Admin UI (Vite + Vanilla TypeScript)
│       ├── index.html                   # SPA shell
│       ├── main.ts                      # Router, auth bootstrap, layout
│       ├── api.ts                       # Typed admin API client
│       ├── styles/
│       │   └── index.css                # Dark glassmorphic UI styles
│       ├── public/                      # Static assets
│       └── views/                       # View components
│           ├── overview.ts              # Dashboard overview & stats
│           ├── providers.ts             # Providers & keys management
│           ├── routes.ts                # Routes & failover chains
│           ├── gateway-keys.ts          # Gateway key credentials
│           ├── logs.ts                  # Request log browser
│           └── settings.ts              # Rules & global settings
├── test/
│   └── gateway.test.ts                  # Vitest unit & integration tests
├── dist/
│   └── ui/                              # Built dashboard (generated)
├── wrangler.jsonc                       # Cloudflare Worker, D1, Assets config
├── vite.config.ts                       # Vite build config (outputs to dist/ui)
├── vitest.config.ts                     # Vitest configuration
├── tsconfig.json                        # Worker TypeScript config
├── tsconfig.ui.json                     # Dashboard TypeScript config
├── package.json                         # Dependencies & scripts
└── README.md                            # Project documentation
```

## Directory Purposes

**`migrations/`:**
- Purpose: D1 SQLite schema and seed data
- Contains: SQL DDL statements
- Key files: `0001_init.sql` — defines providers, provider_keys, routes, route_providers, error_rules, gateway_keys, request_logs tables

**`scripts/`:**
- Purpose: Setup and deployment automation
- Contains: Interactive provisioning script
- Key files: `setup.mjs` — npm run setup command

**`src/worker/`:**
- Purpose: Cloudflare Worker backend application
- Contains: HTTP routing, proxy logic, database access, admin API
- Key files: `index.ts` (entry point), `types.ts` (domain model)

**`src/worker/admin/`:**
- Purpose: Admin REST API for configuration management
- Contains: CRUD endpoints, authentication, metrics
- Key files: `routes.ts` (endpoints), `auth.ts` (password & session), `stats.ts` (metrics)

**`src/worker/db/`:**
- Purpose: Database abstraction and caching
- Contains: D1 config loading, in-memory caching, encryption/decryption
- Key files: `cache.ts` (30s per-isolate cache), `crypto.ts` (AES-GCM, SHA-256), `repo.ts` (SQL builders)

**`src/worker/proxy/`:**
- Purpose: HTTP proxy and request forwarding
- Contains: Request translation, failover loops, stream handling, logging
- Key files: `forward.ts` (main failover logic), `stream-peek.ts` (SSE error detection), `formats.ts` (wire format handling)

**`src/worker/routing/`:**
- Purpose: Route resolution, key selection, and error classification
- Contains: Model matching, key ordering, error rule matching, state transitions
- Key files: `resolve-route.ts` (route lookup), `select-key.ts` (key ordering), `error-rules.ts` (error classification)

**`src/dashboard/`:**
- Purpose: Single-page admin UI
- Contains: Views for providers, routes, keys, logs, settings
- Key files: `main.ts` (router), `api.ts` (API client), `views/` (view components)

**`test/`:**
- Purpose: Unit and integration tests
- Contains: Vitest test suite
- Key files: `gateway.test.ts`

## Key File Locations

**Entry Points:**
- `src/worker/index.ts` — Worker entry point; routes to `/v1/*` (proxy), `/api/admin/*` (admin), static assets (dashboard)
- `src/worker/proxy/forward.ts` — Primary proxy handler; implements failover loop and response handling
- `src/dashboard/main.ts` — Dashboard SPA router and layout

**Configuration:**
- `wrangler.jsonc` — Cloudflare Worker config, D1 database, Assets, Cron triggers
- `vite.config.ts` — Vite build for dashboard UI
- `vitest.config.ts` — Vitest test runner config

**Core Logic:**
- `src/worker/types.ts` — Domain types (Provider, ProviderKey, Route, Config, etc.)
- `src/worker/proxy/forward.ts` — Failover loop, request forwarding, stream handling
- `src/worker/routing/resolve-route.ts` — Route resolution algorithm
- `src/worker/routing/error-rules.ts` — Error classification by status & regex
- `src/worker/db/cache.ts` — Per-isolate config cache with version-based invalidation

**Admin API:**
- `src/worker/admin/routes.ts` — REST CRUD endpoints for all entities
- `src/worker/admin/auth.ts` — Password authentication, session management
- `src/worker/admin/stats.ts` — Metrics and time-series queries

**Testing:**
- `test/gateway.test.ts` — Vitest unit & integration tests

## Naming Conventions

**Files:**
- Source files: camelCase (e.g., `forward.ts`, `resolve-route.ts`, `stream-peek.ts`)
- Index files: `index.ts` at directory roots
- Tests: co-located with source, named `*.test.ts`

**Directories:**
- kebab-case for multi-word directories: `route-providers`, `gateway-keys`, `admin/`, `db/`, `proxy/`, `routing/`, `views/`, `styles/`
- Single-word: lowercase (e.g., `src/`, `migrations/`, `scripts/`, `test/`, `dist/`)

**Functions & Exports:**
- camelCase: `getConfig()`, `extractModel()`, `resolveRoute()`, `classifyError()`
- Internal helpers (not exported): same camelCase, sometimes prefixed with `_` or in a private scope

**Types & Interfaces:**
- PascalCase: `Provider`, `ProviderKey`, `Route`, `Config`, `Attempt`, `PeekResult`, `Format`, `Action`, `KeyStatus`

**Constants:**
- UPPER_SNAKE_CASE: `ALL_FORMATS`, `ALL_ACTIONS`, `ACTIVE_PATCH`, `HARD_ATTEMPT_CAP`, `MAX_PEEK_BYTES`, `CHECK_MS`
- Config constants: `DROP_REQUEST_HEADERS` (Set), `regexCache` (Map)

**Database:**
- Tables: snake_case: `providers`, `provider_keys`, `routes`, `route_providers`, `error_rules`, `gateway_keys`, `request_logs`, `config_version_counter`
- Columns: snake_case: `id`, `provider_id`, `key_enc`, `key_hash`, `status_reason`, `cooldown_until`, `next_recheck_at`

## Where to Add New Code

**New Feature (e.g., new failover strategy):**
- Primary code: `src/worker/routing/` (e.g., new file `src/worker/routing/new-strategy.ts`)
- Tests: `test/gateway.test.ts` with new test suite
- Admin API: Add endpoint in `src/worker/admin/routes.ts` if user-configurable
- Database: Add columns/tables to `migrations/0001_init.sql` if persistent state needed

**New API Endpoint (e.g., analytics):**
- Implementation: `src/worker/admin/routes.ts` — add route handler
- If complex: Create new file `src/worker/admin/analytics.ts` and import into `routes.ts`
- Database queries: `src/worker/db/repo.ts` — add SQL builder functions
- Admin UI: `src/dashboard/views/new-view.ts` — create view component, register in `src/dashboard/main.ts`

**New Dashboard View:**
- Implementation: `src/dashboard/views/my-view.ts` — export `renderMyView(container: HTMLElement, api: AdminApi): Promise<void>`
- Add to sidebar navigation: `src/dashboard/main.ts` — add entry to `NAV_ITEMS` and route in `renderAppShell()`
- Styles: `src/dashboard/styles/index.css` — add scoped styles or use existing CSS classes (`.card`, `.btn`, `.field`, etc.)

**New Utility (crypto, parsing, etc.):**
- Reusable helpers: `src/worker/proxy/formats.ts` (for wire format helpers) or create new utility file
- Cryptography: `src/worker/db/crypto.ts`
- Database builders: `src/worker/db/repo.ts`

**New Test:**
- Location: `test/gateway.test.ts` — add new `describe()` block or test case to existing suite
- Use Vitest `describe()`, `it()`, `expect()`, `beforeEach()`, `afterEach()`
- Mock `env: Env` object with `DB`, `ADMIN_PASSWORD`, `ENCRYPTION_KEY`, `SESSION_SECRET`

## Special Directories

**`dist/ui/`:**
- Purpose: Built dashboard assets (output of `npm run build` and Vite)
- Generated: Yes
- Committed: No (in `.gitignore`)
- Deployed to: Cloudflare Workers Static Assets binding

**`.wrangler/`:**
- Purpose: Wrangler CLI state and cache
- Generated: Yes
- Committed: No
- Managed by: Wrangler CLI

**`.planning/codebase/`:**
- Purpose: Codebase documentation for GSD tools
- Contains: ARCHITECTURE.md, STRUCTURE.md, and other analysis documents
- Generated: By `/gsd-map-codebase` skill
- Committed: Yes

## Build & Development Workflow

**Development:**
- `npm run dev` — Build dashboard and start `wrangler dev` on `http://localhost:8787`
- `npm run dev:ui` — Start Vite dev server on `http://localhost:5173` (proxying `/api` and `/v1` to `:8787`)

**Testing:**
- `npm test` — Run Vitest suite

**Building:**
- `npm run build` — Build dashboard into `dist/ui/`
- `npm run typecheck` — Type-check Worker and Dashboard

**Deployment:**
- `npm run setup` — Interactive provisioning and deployment to Cloudflare

## Configuration Files

**wrangler.jsonc:**
- Defines Worker name, compatibility date, D1 database binding, Assets binding, Cron triggers
- Environment variables: `ADMIN_PASSWORD`, `ENCRYPTION_KEY`, `SESSION_SECRET`

**tsconfig.json:**
- TypeScript config for Worker (strict mode, ES2020 target, type checking)

**tsconfig.ui.json:**
- TypeScript config for Dashboard (DOM types, ES2020 target)

**vitest.config.ts:**
- Test runner configuration; imports from `wrangler.toml`

**vite.config.ts:**
- Dashboard build configuration; outputs to `dist/ui/`

---

*Structure analysis: 2026-11-13*
