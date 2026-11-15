---
last_mapped_commit: 714edac233d72505a98572dd49b8ebe910ba5bdc
last_mapped_at: 2026-11-13
---
# External Integrations

**Analysis Date:** 2026-11-13

## APIs & External Services

**Upstream AI Providers:**
- Anthropic API (`https://api.anthropic.com`) - Supports `/v1/messages` format
  - Protocol: OpenAI-compatible HTTP with Bearer token auth
  - Wire format: `anthropic`
  - SDK: None (raw HTTP via Workers `fetch`)
  - Auth: `Authorization: Bearer sk-...` + `x-api-key` header
  
- OpenAI API (`https://api.openai.com`) - Supports `/v1/chat/completions`, `/v1/responses`
  - Protocol: OpenAI Chat Completions API
  - Wire formats: `openai-chat`, `openai-responses`
  - SDK: None (raw HTTP via Workers `fetch`)
  - Auth: `Authorization: Bearer sk-...` header

- Relay Services (new-api, one-api, OpenRouter) - Custom base URLs
  - Protocol: OpenAI-compatible HTTP relay with Bearer token auth
  - Wire formats: `anthropic`, `openai-chat`, `openai-responses` (configurable per provider)
  - SDK: None (raw HTTP via Workers `fetch`)
  - Auth: `Authorization: Bearer ...` + custom headers
  - Balance checking: Standard `/api/usage` endpoint or custom JSON path (e.g., `/api/user/self`)

## Data Storage

**Databases:**
- Cloudflare D1 SQLite
  - Connection: Bound to `env.DB` in Worker
  - Database ID: `52bf23b0-e922-4603-a8b4-a681d5d0b635`
  - Client: D1 API via `env.DB.batch()` and statement builders
  - Usage: Configuration (providers, routes, error rules, gateway keys), request logs, key states

**File Storage:**
- Cloudflare Workers Static Assets
  - Service: Built-in asset binding (`ASSETS`)
  - Storage: Worker deployment bundle (Vite-built dashboard UI)
  - Serving: Single-page application from `/` root

**Caching:**
- In-isolate memory cache (30 seconds)
  - Location: `src/worker/db/cache.ts`
  - Purpose: Configuration cache with version-counter invalidation
  - No external cache service used

## Authentication & Identity

**Gateway Authentication (Client → Gateway):**
- Bearer Token Auth
  - Header: `Authorization: Bearer sk-gw-...` or `x-api-key: sk-gw-...`
  - Implementation: `src/worker/proxy/formats.ts` (`extractClientToken`)
  - Storage: SHA-256 hex digest in `gateway_keys.key_hash` table
  - Validation: `src/worker/proxy/forward.ts` (`authenticate` function)

**Session Authentication (Dashboard):**
- Custom HMAC-Signed Cookies
  - Cookie name: `gw_session`
  - Format: `{expiration}.{HMAC-SHA256}`
  - TTL: 7 days
  - Implementation: `src/worker/admin/auth.ts`
  - Security: `SameSite=Strict`, `HttpOnly`, `Secure` flags

**Upstream Authentication (Gateway → Provider):**
- Bearer Token Auth
  - Format: `Authorization: Bearer {encrypted-key}`
  - Encryption: AES-256-GCM (stored at rest in `provider_keys.key_enc`)
  - Decryption on use: `src/worker/db/cache.ts` (`plainKey`)
  - Implementation: `src/worker/proxy/formats.ts` (`buildUpstreamHeaders`)

## Secrets Management

**Encryption:**
- Algorithm: AES-256-GCM (WebCrypto native)
- Key derivation: SHA-256(env.ENCRYPTION_KEY)
- Encrypted field: `provider_keys.key_enc` (base64(iv || ciphertext+tag))
- Implementation: `src/worker/db/crypto.ts`

**Environment Variables (Cloudflare Secrets):**
- `ADMIN_PASSWORD` - Admin dashboard login password (plaintext comparison with `safeEqual`)
- `ENCRYPTION_KEY` - Secret for AES-GCM key derivation
- `SESSION_SECRET` - Secret for HMAC-SHA256 session token signing
- Note: Never returned via `/api/admin/*` endpoints

## Monitoring & Observability

**Error Tracking:**
- Error classification system (status code + body regex matching)
- Implementation: `src/worker/routing/error-rules.ts`
- Actions: `EXHAUSTED`, `INVALID_KEY`, `RATE_LIMITED`, `UPSTREAM_ERROR`, `CLIENT_ERROR`
- No external APM (Sentry, Datadog, etc.)

**Logs:**
- Request logging: Single D1 `INSERT INTO request_logs` per successful request
- Queued via `ctx.waitUntil()` (non-blocking)
- Fields: timestamp, gateway_key_id, route_id, format, model, provider_id, status, latency_ms, token counts
- Implementation: `src/worker/proxy/logs.ts`
- Retention: Configurable (default pruning via cron job)
- Observability: Cloudflare Workers observability enabled in `wrangler.jsonc`

**Metrics:**
- Admin API stats endpoint: `GET /api/admin/stats`
- Queries: Aggregated D1 metrics + time-series requests per route
- Implementation: `src/worker/admin/stats.ts`

## CI/CD & Deployment

**Hosting:**
- Cloudflare Workers
- Edge deployment to 200+ global PoPs

**Deployment:**
- Manual: `npm run deploy` (builds UI, migrates DB, deploys via Wrangler)
- Setup: `npm run setup` - Interactive provisioning script (`scripts/setup.mjs`)
- Database migrations: Wrangler D1 CLI (`wrangler d1 migrations apply DB --remote`)

**Development:**
- Local dev: `wrangler dev` (port 8787) + optional `vite` for UI hot reload (port 5173)
- Database migrations (local): `wrangler d1 migrations apply DB --local`

## Webhooks & Callbacks

**Incoming:**
- None (gateway is a proxy, not a webhook receiver)

**Outgoing:**
- None (gateway relays requests, does not initiate external callbacks)

## Key Rotation & Failover

**Upstream Key Management:**
- Sequential or round-robin key ordering per provider (configurable)
- Automatic key rotation on state transitions:
  - `EXHAUSTED` - Move to next key (balance = 0)
  - `INVALID_KEY` - Move to next key (401 Unauthorized from upstream)
  - `RATE_LIMITED` - Cooldown period, then re-check
- Implementation: `src/worker/routing/select-key.ts`, `src/worker/routing/key-state.ts`

**Provider Failover:**
- Ordered provider list per route
- Fails over on upstream HTTP errors or 200 SSE with `event: error` payload
- 40-attempt hard cap (Workers free tier limits 50 subrequests per invocation)
- First-SSE-event stream peek (buffer up to first data event before committing to client)
- Implementation: `src/worker/proxy/forward.ts` (failover loop), `src/worker/proxy/stream-peek.ts`

## Balance Checking

**Balance Modes:**
- `standard` - OpenAI-style: `subscription.hard_limit_usd - usage.total_usage / 100`
  - Providers: OpenAI, new-api, one-api, OpenRouter
- `custom` - Any JSON endpoint + field path + divisor
  - Example: new-api `/api/usage/token` → `data.total_available / 500000`
- `none` - Relay offers no balance endpoint (skip checks)

**Re-Check Strategies:**
- `auto` - Check balance, then run 1-token test request if needed
- `balance` - Check balance only
- `manual` - Skip automatic re-checks
- Implementation: `src/worker/balance.ts` (`checkBalance`, `testKey`)

## Scheduled Maintenance

**Cron Triggers (via Cloudflare):**
- `*/15 * * * *` - Re-check exhausted keys, refresh balances, clear cooldowns
- `0 3 * * *` - Delete request logs older than retention period
- Implementation: `src/worker/cron.ts`

## Request Format Support

**Wire Formats:**
- `anthropic` - Anthropic API format (`/v1/messages`)
  - Header: `anthropic-version: 2023-06-01`
  - Auth: Both `Authorization: Bearer` and `x-api-key` headers
- `openai-chat` - OpenAI Chat Completions (`/v1/chat/completions`)
  - Auth: `Authorization: Bearer` header
- `openai-responses` - OpenAI Responses API (`/v1/responses`)
  - Auth: `Authorization: Bearer` header

**Model Translation:**
- Per-provider model mapping (e.g., `claude-3-sonnet` → `claude-3-5-sonnet-20241022`)
- Glob patterns supported (e.g., `claude-*`)
- Model allowlist per provider (only serve configured models)
- Implementation: `src/worker/routing/model-map.ts`

---

*Integration audit: 2026-11-13*
