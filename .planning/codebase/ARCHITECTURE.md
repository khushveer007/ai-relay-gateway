---
last_mapped_commit: 714edac233d72505a98572dd49b8ebe910ba5bdc
last_mapped_at: 2026-11-13
---
<!-- refreshed: 2026-11-13 -->
# Architecture

**Analysis Date:** 2026-11-13

## System Overview

```text
┌─────────────────────────────────────────────────────────────────────────┐
│                         HTTP Request Layer                              │
│  (CORS, Format Detection, Authentication)                               │
│                      `src/worker/index.ts`                              │
├──────────────────┬──────────────────────┬──────────────────────────────┤
│  Proxy `/v1/*`   │  Admin API `/api/*`  │  Static Assets / SPA         │
│ `proxy/forward`  │  `admin/routes`      │  (Dashboard UI)              │
└────────┬─────────┴──────────────┬───────┴──────────────────────────────┘
         │                        │
         ▼                        ▼
┌────────────────────────────────────────────────────────────────────────┐
│              Routing & State Management Layer                          │
│  Route Resolution → Key Selection → Error Classification              │
│  `routing/{resolve-route, select-key, error-rules, key-state}`        │
├────────────────────┬───────────────────┬────────────────────────────┤
│ Route Lookup       │ Key Filtering     │ Error Classification       │
│ Model Matching    │ Key Ordering      │ Retry Logic                │
└────────┬───────────┴───────────┬───────┴────────────┬────────────────┘
         │                       │                     │
         └───────────┬───────────┴─────────────────────┘
                     ▼
┌────────────────────────────────────────────────────────────────────────┐
│                    Proxy Execution Layer                               │
│  Request Forwarding, Stream Peeking, Usage Extraction                 │
│  `proxy/{forward, stream-peek, usage, logs}`                          │
└────────────────────────┬───────────────────────────────────────────────┘
                         │
         ┌───────────────┴──────────────┐
         ▼                              ▼
┌─────────────────────┐      ┌──────────────────────┐
│  Upstream Provider  │      │  Config & Auth Cache │
│  (Anthropic/OpenAI │      │  Per-Isolate 30s TTL │
│   new-api, etc)    │      │  `db/cache.ts`       │
└─────────────────────┘      └──────────┬───────────┘
                                        │
                                        ▼
                         ┌──────────────────────────┐
                         │   D1 SQLite Database     │
                         │  Providers, Keys, Routes │
                         │  Error Rules, Logs       │
                         │  `db/repo.ts`            │
                         └──────────────────────────┘
```

## Component Responsibilities

| Component | Responsibility | File |
|-----------|----------------|------|
| **Worker Router** | HTTP routing, CORS, format detection | `src/worker/index.ts` |
| **Proxy Forwarder** | Request/response translation, failover loop | `src/worker/proxy/forward.ts` |
| **Route Resolver** | Route lookup by gateway key or model pattern | `src/worker/routing/resolve-route.ts` |
| **Key Selector** | Order available keys by strategy (sequential/round-robin) | `src/worker/routing/select-key.ts` |
| **Error Classifier** | Match HTTP status & body regex against error rules | `src/worker/routing/error-rules.ts` |
| **Key State Manager** | Track key exhaustion, rate limits, cooldowns | `src/worker/routing/key-state.ts` |
| **Stream Peeker** | Buffer first SSE event to detect relay errors | `src/worker/proxy/stream-peek.ts` |
| **Usage Extractor** | Parse token usage from response body | `src/worker/proxy/usage.ts` |
| **Config Cache** | 30s per-isolate cache with version-based invalidation | `src/worker/db/cache.ts` |
| **Encryption** | AES-256-GCM for upstream keys, SHA-256 for gateway keys | `src/worker/db/crypto.ts` |
| **Admin Routes** | REST CRUD for providers, routes, keys, rules | `src/worker/admin/routes.ts` |
| **Admin Auth** | Password login, HMAC session cookies, brute-force guard | `src/worker/admin/auth.ts` |
| **Dashboard UI** | SPA configuration interface (routes, providers, logs) | `src/dashboard/` |

## Pattern Overview

**Overall:** Multi-provider API gateway with automatic failover and key rotation.

**Key Characteristics:**
- **Stateless per-request**: Each request independently selects providers, keys, and falls back through a candidate list.
- **Ordered failover chains**: Routes bind multiple providers in order; when one provider is exhausted, the next is tried.
- **Key-state tracking**: Keys are marked as `active`, `exhausted`, `rate_limited`, `invalid`, or `disabled` based on error responses.
- **Transparent format passthrough**: The gateway accepts requests in any of three formats (`anthropic`, `openai-chat`, `openai-responses`) and forwards transparently to the upstream provider.
- **Minimal D1 on happy path**: Config is cached per-isolate for 30s. The only D1 write on a successful request is a log INSERT queued in `ctx.waitUntil()`, not blocking the response.

## Layers

**HTTP & Routing Layer:**
- Purpose: Accept client requests, authenticate via gateway keys, resolve the appropriate route based on model or gateway-key binding.
- Location: `src/worker/index.ts`, `src/worker/proxy/forward.ts`, `src/worker/routing/resolve-route.ts`
- Contains: Hono app setup, format detection, authentication, route selection
- Depends on: Config cache, gateway key hashes
- Used by: Client SDK requests

**Provider Selection & Key Ordering Layer:**
- Purpose: Given a route, filter providers by format/model support, then order keys within each provider by strategy.
- Location: `src/worker/routing/select-key.ts`, `src/worker/routing/model-map.ts`
- Contains: Key filtering (usable vs. cooldown/exhausted), sequential/round-robin ordering
- Depends on: Provider configuration, key state
- Used by: Failover loop in `forward.ts`

**Proxy Execution & Failover Layer:**
- Purpose: Send requests to upstream providers, handle responses, classify errors, and decide whether to retry with another key or provider.
- Location: `src/worker/proxy/forward.ts`, `src/worker/proxy/stream-peek.ts`, `src/worker/proxy/usage.ts`
- Contains: Request building, timeout management, stream peeking, usage extraction, failover loop
- Depends on: Error classification, key state transitions
- Used by: HTTP layer to fulfill requests

**Error Classification & State Transition Layer:**
- Purpose: Parse upstream error responses, match against configurable error rules, and determine the action (EXHAUSTED, RATE_LIMITED, INVALID_KEY, etc.).
- Location: `src/worker/routing/error-rules.ts`, `src/worker/routing/key-state.ts`
- Contains: Regex-based error rule matching, status code ranges, state transition patches
- Depends on: Error rules from config
- Used by: Failover loop to decide key/provider fate

**Config & Caching Layer:**
- Purpose: Load full configuration from D1 on startup/invalidation, cache it per-isolate for 30s, and support instant in-memory updates on this isolate.
- Location: `src/worker/db/cache.ts`, `src/worker/db/repo.ts`
- Contains: Config version checking, parser functions, memoized key decryption
- Depends on: D1 database
- Used by: All other layers

**Encryption & Crypto Layer:**
- Purpose: Encrypt upstream API keys at rest using AES-256-GCM, hash gateway keys to SHA-256, derive encryption keys from ENCRYPTION_KEY env var.
- Location: `src/worker/db/crypto.ts`
- Contains: WebCrypto AES-256-GCM, SHA-256, HMAC-SHA256, key derivation
- Depends on: None (uses native WebCrypto API)
- Used by: Cache layer (decryption), Admin auth (session verification)

**Admin API Layer:**
- Purpose: Provide REST endpoints for managing providers, routes, keys, error rules, and gateway credentials.
- Location: `src/worker/admin/routes.ts`, `src/worker/admin/auth.ts`, `src/worker/admin/stats.ts`
- Contains: CRUD operations, password authentication, request logging, aggregated metrics
- Depends on: Database, encryption, key state management
- Used by: Dashboard UI via API calls

**Dashboard Layer:**
- Purpose: Single-page UI for viewing and configuring the gateway.
- Location: `src/dashboard/main.ts`, `src/dashboard/views/`, `src/dashboard/styles/`
- Contains: Router, login form, views for providers/routes/keys/logs, modal dialogs
- Depends on: Admin API
- Used by: Gateway administrators

## Data Flow

### Primary Request Path

1. **Receive Request** (`src/worker/index.ts:22-23`) — HTTP request arrives at Hono app.
2. **Authenticate** (`src/worker/proxy/forward.ts:34-47`) — Extract gateway key from Authorization or x-api-key header, hash it, and look up in config.
3. **Detect Format** (`src/worker/proxy/forward.ts:53`) — Determine wire format from path (`/v1/messages` → `anthropic`, `/v1/chat/completions` → `openai-chat`, etc.).
4. **Extract Model** (`src/worker/proxy/forward.ts:63`) — Parse model name from request body (or null for GET requests).
5. **Resolve Route** (`src/worker/proxy/forward.ts:74`, `src/worker/routing/resolve-route.ts`) — 
   - Check if gateway key is bound to a specific route.
   - Else, find the first non-default route whose model patterns match.
   - Else, use the default route.
6. **Filter Providers** (`src/worker/proxy/forward.ts:80-82`) — Collect providers from route that are enabled, support the format, and have models matching the request.
7. **Failover Loop** (`src/worker/proxy/forward.ts:94-250`) — For each provider and its ordered keys:
   - Build upstream request with translated model, API key, and forwarded headers.
   - Send fetch to upstream with timeout.
   - Check response status & body.
8. **Stream Peeking** (`src/worker/proxy/forward.ts:149-159`) — If response is `200` with `text/event-stream`:
   - Buffer the first SSE event to detect error-event markers.
   - If it's an error, treat as failure and fail over.
   - If content, stream it to the client immediately.
9. **Success** (`src/worker/proxy/forward.ts:184-189`) — Return response to client; queue key-state update if key was previously non-active.
10. **Failure Handling** (`src/worker/proxy/forward.ts:192-250`) — On error:
    - Classify the error via `classify(...)` (regex + status code matching).
    - Compute state patch via `patchForAction(...)`.
    - Apply patch in-memory and queue D1 update.
    - Continue to next key or provider.
11. **Log & Return** (`src/worker/proxy/forward.ts:70`) — Queue request log entry in `ctx.waitUntil()` (does not block response).

### Stream Response Path

1. Stream response arrives from upstream with `200` and `text/event-stream`.
2. `peekStream()` reads chunks until first complete SSE event with `data:` line.
3. Parse event to detect `event: error` or `{"error": …}` markers.
4. If error detected, cancel stream and fail over (no data sent to client yet).
5. If content detected, wrap buffered head in a `ReadableStream`, re-emit buffered bytes, then pipe the rest of the upstream stream.

### Error Classification & Retry

1. Upstream returns non-2xx or stream contains error marker.
2. Extract response body (or stream head text).
3. `classify(config.rules, provider_id, status, body, retry_after_header)`:
   - Iterate error rules in priority order.
   - Match provider_id (null = global rule).
   - Check status code range.
   - Check body regex (if provided).
   - Return action (EXHAUSTED, RATE_LIMITED, INVALID_KEY, UPSTREAM_ERROR, CLIENT_ERROR).
4. `patchForAction(provider, action, reason, cooldown)`:
   - For EXHAUSTED: mark key exhausted, schedule recheck in `provider.recheck_hours`.
   - For RATE_LIMITED: mark rate_limited, set cooldown until now + cooldown_s.
   - For INVALID_KEY: mark invalid (no recheck).
   - For others: return null (no state change).
5. Apply patch in-memory and to D1 (queued in `ctx.waitUntil()`).
6. If not CLIENT_ERROR, continue to next key.

**State Management:**
- Key state is stored in the config as part of each `ProviderKey`.
- On each request, `isUsable(key)` checks if the key is `active` or past its `cooldown_until` time.
- When a key's state changes, `config_version` is incremented; other isolates re-fetch within ~30s.
- In this isolate, in-memory cache is invalidated immediately so next request sees the update.

## Key Abstractions

**Route:**
- Purpose: Bind a set of model patterns to an ordered list of providers.
- Examples: `src/worker/types.ts:58-65`, migrations schema `routes` table
- Pattern: Routes are resolved by model glob match (first match wins), with a default route as fallback.

**ErrorRule:**
- Purpose: Match upstream errors by status code and body regex, triggering actions (key state changes, cooldowns).
- Examples: `src/worker/types.ts:67-77`, migrations schema `error_rules` table
- Pattern: Rules are prioritized; first match determines the action and optional cooldown duration.

**Config:**
- Purpose: In-memory snapshot of the full gateway state: providers, keys, routes, rules, gateway keys, settings.
- Examples: `src/worker/types.ts:96-104`
- Pattern: Loaded once per 30s per isolate; version-based invalidation; critical for zero-D1-on-happy-path design.

**Attempt:**
- Purpose: Track a single key/provider attempt within a request (for logging and debugging).
- Examples: `src/worker/types.ts:106-116`
- Pattern: Every attempt record includes provider_id, key_id, model, HTTP status, action taken, and elapsed time.

**PeekResult:**
- Purpose: Result of buffering the first SSE event to detect errors on `200` responses from relays.
- Examples: `src/worker/proxy/stream-peek.ts:7-13`
- Pattern: If the first complete data event contains an error marker (`event: error` or `{"error": …}`), the stream is treated as failed and can still be failed over; otherwise, buffered bytes are replayed to the client.

## Entry Points

**Worker Fetch Handler:**
- Location: `src/worker/index.ts:35-40`
- Triggers: HTTP request from client
- Responsibilities: Route to `/v1/*` (proxy), `/api/admin/*` (admin), or static assets (dashboard)

**Worker Scheduled Handler:**
- Location: `src/worker/index.ts:37-39`
- Triggers: Cron job (configured in `wrangler.jsonc`)
- Responsibilities: Run maintenance tasks (cool-downs, exhausted key rechecks, log cleanup)

**handleProxy:**
- Location: `src/worker/proxy/forward.ts:49`
- Triggers: Any request to `/v1/*`
- Responsibilities: Main request proxy logic; authentication, routing, failover, response handling

**handleModels:**
- Location: `src/worker/proxy/forward.ts` (referenced in index.ts)
- Triggers: GET `/v1/models`
- Responsibilities: Aggregate and merge the `models` list from all providers

**Admin Hono Routes:**
- Location: `src/worker/admin/routes.ts`
- Triggers: Requests to `/api/admin/*`
- Responsibilities: CRUD operations for providers, keys, routes, rules, gateway keys, settings

## Architectural Constraints

- **CPU Budget (10 ms)**: Cloudflare free-tier Workers have a hard 10ms CPU limit. Avoid parsing large request bodies. Use targeted regex in `extractModel` / `replaceModel` instead of full JSON parse.
- **Subrequest Limit (50)**: Each Worker invocation can make up to 50 subrequests. The gateway caps attempts at 40 to leave headroom for D1 calls and logging.
- **D1 Read/Write Minimization**: The happy path does zero synchronous D1 writes. Config is loaded once per 30s and cached. Admin mutations bump `config_version` to trigger refresh in other isolates. Logging is queued in `ctx.waitUntil()`.
- **Config Version Invalidation**: Every admin mutation and key-state change increments `config_version` in the database. Other isolates check the version on the next request and reload if it changed.
- **Global State in Isolate**: Per-isolate mutable state includes `cached: Config`, `checkedAt: number`, and `plainKeys: Map<string, string>`. This allows instant in-memory updates in the isolate where a mutation happened, while other isolates see the change within ~30s.
- **Circular Dependencies**: None known. Modules import in a clean DAG: types ← indexes → admin, proxy, routing, db ← index.ts.
- **Key Decryption Memoization**: Decrypted upstream keys are memoized by ciphertext to avoid repeated AES-GCM operations (expensive). Cache is cleared when size exceeds 500 entries.

## Anti-Patterns

### Synchronous D1 Writes on Every Request

**What happens:** Naively writing key-state changes to D1 synchronously in the request path.
**Why it's wrong:** This consumes CPU budget, adds latency, and hits D1 rate limits at scale.
**Do this instead:** Queue writes in `ctx.waitUntil()` so they execute after the response is sent. In this isolate, apply changes in-memory immediately via `patchCachedKey()`.

### Parsing Large Request Bodies

**What happens:** Calling `req.json()` or `JSON.parse(body)` on the full request body to extract the model.
**Why it's wrong:** Request bodies can exceed 1 MB (e.g., Claude Code context). Parsing exhausts CPU budget.
**Do this instead:** Use targeted regex on the first `"model"` field via `extractModel()` in `src/worker/proxy/formats.ts`.

### Blocking on Config Refresh

**What happens:** Fetching the full config from D1 every request to ensure freshness.
**Why it's wrong:** Excessive D1 calls and latency.
**Do this instead:** Cache config per-isolate for 30s, checking only the version counter to decide if reload is needed.

### Trusting Relay HTTP 200 Responses

**What happens:** Assuming that any `200` response from an upstream relay is valid content.
**Why it's wrong:** Some relays (e.g., `one-api`) send `HTTP 200` with `event: error` SSE events or bare JSON error objects.
**Do this instead:** Use `peekStream()` to buffer the first complete SSE event before committing the stream to the client. If it's an error marker, fail over.

## Error Handling

**Strategy:** Classify errors via regex + status code rules, apply key-state patches, and attempt failover to the next key or provider.

**Patterns:**
- **Upstream HTTP Error (4xx/5xx)**: Classify via error rules; apply patch; retry if not CLIENT_ERROR.
- **Timeout (after `provider.timeout_ms`)**: Abort fetch; classify as UPSTREAM_ERROR; retry.
- **Fetch Network Error**: Classify as UPSTREAM_ERROR; retry.
- **SSE Stream with Error Event**: Peek stream; detect error marker; cancel and retry.
- **Exhausted Attempts**: Return the last failure as the response (with error action and reason).

## Cross-Cutting Concerns

**Logging:** Every request is logged to `request_logs` table via a single INSERT queued in `ctx.waitUntil()`. Logs include gateway key ID, route ID, format, model, provider, key, HTTP status, stream flag, latency, TTFB, token usage, and error reason.

**Validation:** Admin endpoints validate input via typed helpers (`str()`, `num()`, `arr()`) that coerce and truncate. Error rules validate regex syntax. Model patterns support glob syntax.

**Authentication:** Gateway requests authenticate via SHA-256 hashed API keys (`sk-gw-…`). Admin requests use a password and HMAC session cookies with brute-force protection.

---

*Architecture analysis: 2026-11-13*
