---
last_mapped_commit: 714edac233d72505a98572dd49b8ebe910ba5bdc
last_mapped_at: 2026-11-13
---
# Coding Conventions

**Analysis Date:** 2026-11-13

## Naming Patterns

**Files:**
- Lowercase kebab-case for filenames: `error-rules.ts`, `stream-peek.ts`, `key-state.ts`
- Module structure mirrors domain: `worker/routing/`, `worker/proxy/`, `worker/admin/db/`
- Public modules export a single responsibility: `formats.ts` exports format utilities, `crypto.ts` exports crypto helpers

**Functions:**
- camelCase for function names: `detectFormat()`, `extractModel()`, `buildUpstreamUrl()`
- Descriptive verbs as prefixes: `extract*`, `build*`, `classify()`, `verify*`, `create*`, `order*`
- Private helper functions use lower camelCase without underscore: `toB64()`, `fromB64()`, `toHex()`, `compile()`
- Selector/checker functions use `is*`, `has*`, `looks*`: `isUsable()`, `looksLikeJsonError()`, `supportsModel()`

**Variables:**
- camelCase for all local/module variables: `maxAttempts`, `upstreamBody`, `lastFailure`, `apiKey`
- Underscore for database column names (reflected in DTO): `provider_id`, `status_reason`, `key_hint`, `models_fetched_at`
- Maps/collections: descriptive plural names: `keysByProvider`, `gatewayKeysByHash`, `providers`, `routes`
- Const collections: ALL_CAPS: `ALL_FORMATS`, `ALL_ACTIONS`, `DROP_REQUEST_HEADERS`, `ACTIVE_PATCH`

**Types:**
- PascalCase for interfaces and types: `Provider`, `ProviderKey`, `Route`, `ErrorRule`, `Classification`
- Union types use PascalCase: `Format`, `Action`, `KeyStatus`
- DTO suffix for API transport types: `ProviderDTO`, `ProviderKeyDTO`, `RouteDTO`, `ErrorRuleDTO`
- Result/Response wrapper types: `Classification`, `PeekResult`

**Constants:**
- Module-level constants in ALL_CAPS: `SESSION_TTL_S`, `MAX_FAILS`, `HARD_ATTEMPT_CAP`, `WINDOW_MS`
- Private regex caches named with lowercase prefix: `regexCache`, `aesKeyCache`, `hmacKeyCache`

## Code Style

**Formatting:**
- No linting/prettier config detected; inferred patterns from source:
  - 2 spaces for indentation
  - No trailing semicolons (ES modules style)
  - Max line ~120 characters (observed in long function signatures)
  - Imports organized by source type

**Linting:**
- TypeScript strict mode enabled: `"strict": true` in `tsconfig.json`
- No index access safety: `"noUncheckedIndexedAccess": false`
- Compiled to ES2022 with no emitted declarations

## Import Organization

**Order:**
1. Standard library / type definitions: `import type { ... } from 'hono'`
2. Local type imports: `import type { Provider, ProviderKey, ... } from '../types'`
3. Local function imports: `import { detectFormat, ... } from './formats'`
4. Local default exports: `import worker from '../worker/index'`

**Path Aliases:**
- No path aliases configured; uses relative paths: `../db/cache`, `../routing/error-rules`
- Short paths for same-directory utilities: `./formats`, `./logs`

**Patterns:**
- Type imports use explicit `import type { ... }` syntax
- Mix of named and default exports (see `src/worker/admin/routes.ts` exports class and router)

## Error Handling

**Patterns:**
- Custom `HttpError` class for HTTP responses: `class HttpError extends Error { constructor(public status: number, message: string) }`
- Factory function for common errors: `const bad = (msg: string) => new HttpError(400, msg)`
- Catch-all `catch { }` blocks that log silently or rethrow categorized: `} catch { /* not JSON */ }`
- Error classification via enums: `Classification.action` is one of `'EXHAUSTED' | 'INVALID_KEY' | 'RATE_LIMITED' | 'UPSTREAM_ERROR' | 'CLIENT_ERROR'`
- Reason extraction from error bodies with fallback: `extractReason()` parses JSON, SSE, or plain text and returns first 300 chars

**Validation:**
- Throws `HttpError(400, msg)` for input validation failure
- `str(v, field, opts)` validates strings with required/max length checks
- `num(v, field, min, max, fallback)` validates numbers with range checks
- Returns `null` for optional missing fields; throws for required violations

## Logging

**Framework:** No explicit logging library; uses `console` implicitly (referenced in worker logs)

**Patterns:**
- Single-insert request logging: `writeLog(env, log)` via `ctx.waitUntil()`
- Log entry structure: `LogEntry` includes `model`, `status`, `error`, `latency_ms`, `attempts`, `route_id`, `gateway_key_id`
- Async logging queued in execution context to not block response

## Comments

**When to Comment:**
- JSDoc/TSDoc for public functions with complex logic or unclear parameters
- Inline comments for non-obvious algorithmic choices (e.g., "random IV", "fast regex model rewrite")
- No comments for trivial code; let names speak

**JSDoc/TSDoc:**
```typescript
/**
 * Classifies an upstream failure.
 * @param status HTTP status; 0 = network error / timeout; 200 = error found inside a 2xx body or stream
 */
export function classify(
  rules: ErrorRule[],
  providerId: number,
  status: number,
  body: string,
  retryAfter?: string | null,
): Classification
```

- Param/return descriptions for non-obvious parameters
- Inline comments above non-obvious logic blocks

## Function Design

**Size:**
- Favor small, single-responsibility functions
- Longest observed: `handleProxy()` at 363 lines (core failover loop; acceptable for critical path)
- Typical utility: 30–80 lines

**Parameters:**
- Avoid long parameter lists; group related params into objects
- Example: `buildUpstreamHeaders(incoming: Headers, format: Format, apiKey: string, extra?: Record<string, string>)`
- Optional params documented in JSDoc

**Return Values:**
- Single return type (no overloads unless necessary)
- Union types for multiple outcomes: `authenticate()` returns `{ config: Config; gk: GatewayKey } | Response`
- Explicit `null` for optional results; avoid `undefined` in public APIs

## Module Design

**Exports:**
- Each module exports one primary responsibility
- `formats.ts` exports 8 utilities (all format-related)
- `crypto.ts` exports 6 utilities (all crypto-related)
- Single default export only in `index.ts` (worker entry, admin router)

**Barrel Files:**
- No barrel re-export files (`index.ts` patterns); each module imports directly from source
- Workers constraint: minimize top-level computation

**Scope:**
- Private helpers: module-level functions without `export`
- Public API: explicit `export` keyword
- No hoisting via function declarations; use `const` for all functions

---

*Convention analysis: 2026-11-13*
