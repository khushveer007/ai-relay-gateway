---
last_mapped_commit: 714edac233d72505a98572dd49b8ebe910ba5bdc
last_mapped_at: 2026-11-13
---
# Technology Stack

**Analysis Date:** 2026-11-13

## Languages

**Primary:**
- TypeScript ES2022 - All source code (Worker backend and dashboard frontend)

**Runtime Target:**
- ES2022 standard JavaScript compiled to WebAssembly + V8

## Runtime

**Environment:**
- Cloudflare Workers (serverless edge compute)
- Compatibility date: 2025-10-01

**Package Manager:**
- npm
- Lockfile: `package-lock.json` (present)

## Frameworks

**Core:**
- Hono 4.13.18 - Web framework for Worker routing and middleware

**Frontend:**
- Vanilla TypeScript - Single-page admin dashboard UI (no React/Vue)
- Vite 8.3.8 - Build tool and dev server

**Testing:**
- Vitest 4.1.12 - Unit and integration test runner
- @cloudflare/vitest-pool-workers 0.23.0 - Cloudflare Workers test environment

**Build/Dev:**
- Wrangler 4.161.0 - Cloudflare CLI for local dev, deployment, database migrations
- TypeScript 7.0.2 - Compiler and type checking
- esbuild 0.28.x - Bundler used by Wrangler
- workerd - Cloudflare Workers local runtime

## Key Dependencies

**Critical:**
- hono 4.13.18 - Lightweight web framework for routing, middleware, cookie parsing

**Infrastructure:**
- @cloudflare/workers-types 5.20261112.1 - TypeScript types for Workers APIs (D1, KV, Fetcher)
- No production npm dependencies beyond Hono (minimizes bundle size on free tier)

## Configuration

**Environment:**
- Runtime secrets configured via `wrangler.jsonc`:
  - `ADMIN_PASSWORD` - Dashboard login password
  - `ENCRYPTION_KEY` - AES-256-GCM key for encrypting upstream API keys at rest
  - `SESSION_SECRET` - HMAC-SHA256 key for signing session cookies

**Build:**
- `tsconfig.json` - Worker TypeScript configuration (ES2022, strict mode, moduleResolution: Bundler)
- `tsconfig.ui.json` - Dashboard TypeScript configuration
- `vite.config.ts` - Vite build config (outputs to `dist/ui`, proxies `/api` and `/v1` during dev)
- `vitest.config.ts` - Test runner configuration
- `wrangler.jsonc` - Cloudflare Worker config with D1 database binding, static assets, cron triggers

## Database

**Cloudflare D1 SQLite:**
- `database_id` `52bf23b0-e922-4603-a8b4-a681d5d0b635`
- Schema: `migrations/0001_init.sql`
- Tables: `providers`, `provider_keys`, `routes`, `route_providers`, `error_rules`, `gateway_keys`, `request_logs`
- Binding in Worker: `env.DB`
- Accessed via `D1Database` API (batch queries for efficiency)

## Cryptography

**WebCrypto (native in Workers, zero CPU cost):**
- SHA-256 - Gateway key hashing (`key_hash` in database)
- AES-256-GCM - Upstream API key encryption (stored as `key_enc` in database)
- HMAC-SHA256 - Session token signing

**Implementation:**
- `src/worker/db/crypto.ts` - All crypto functions built on native `crypto.subtle` API

## Static Assets

**Serving:**
- Vite-built dashboard UI (`dist/ui/`) served as Cloudflare Workers static assets
- Binding: `ASSETS` (Fetcher type)
- SPA fallback: requests to unknown paths serve `index.html`
- Bypass rules: `/v1/*` and `/api/*` routes always hit Worker first

## Platform Requirements

**Development:**
- Node.js (for npm, TypeScript, Vite, Wrangler)
- `npm` package manager
- Cloudflare account with Workers enabled (free tier supported)

**Production:**
- Cloudflare Workers free tier (10 ms CPU budget per request, 50 subrequests max)
- Cloudflare D1 SQLite (free tier: 100 MB storage, 1M writes/day)
- Cloudflare Cron Triggers (free tier: 2 cron schedules)

---

*Stack analysis: 2026-11-13*
