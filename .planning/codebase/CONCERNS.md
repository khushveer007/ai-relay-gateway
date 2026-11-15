---
last_mapped_commit: 714edac233d72505a98572dd49b8ebe910ba5bdc
last_mapped_at: 2026-11-13
---
# Codebase Concerns

**Analysis Date:** 2026-11-13

## Tech Debt

### Unbounded Crypto Key Caches

- Issue: `aesKeyCache` and `hmacKeyCache` in `src/worker/db/crypto.ts` (lines 28, 61) are per-isolate, never evicted, and grow unbounded with each unique encryption secret used.
- Files: `src/worker/db/crypto.ts`
- Impact: Over a long-running isolate lifetime or with many different encryption scenarios, memory usage grows monotonically until the isolate is recycled.
- Fix approach: Add a simple size-based eviction (e.g., clear when cache exceeds 100 entries) or use `WeakMap` for key storage.

### Unbounded Decrypted Key Memoization

- Issue: `plainKeys` cache in `src/worker/db/cache.ts` (line 58-68) memoizes decrypted upstream API keys indefinitely. Clears only when size exceeds 500.
- Files: `src/worker/db/cache.ts`
- Impact: At high request rates, decrypted keys accumulate in memory until the 500-item threshold. Each cached key is a decrypted secret in RAM.
- Fix approach: Use TTL-based eviction (e.g., 5-minute lifetime) instead of size-only eviction, or use per-key LRU.

### Isolated Brute-Force Protection is Bypassable

- Issue: Login brute-force tracking in `src/worker/admin/auth.ts` (lines 10-24) is per-isolate. Cloudflare Workers route requests across multiple isolates.
- Files: `src/worker/admin/auth.ts`
- Impact: Attackers can distribute login attempts across different isolates to bypass the 10-attempt-per-15-minutes limit per IP.
- Fix approach: Move brute-force tracking to D1 (durable storage) or use Cloudflare Workers KV instead of in-memory map.

### Unbounded Failure Map Growth

- Issue: The `failures` map in `src/worker/admin/auth.ts` (line 24) clears only when size exceeds 5000 entries.
- Files: `src/worker/admin/auth.ts`
- Impact: Under a sustained distributed attack, the map could grow to 5000+ IPs before clearing, consuming memory unnecessarily.
- Fix approach: Add time-based expiration: if an entry's `until` time has passed during a lookup, remove it before checking size.

## Known Bugs

### Decryption Failures Penalize Valid Keys

- Symptoms: If `ENCRYPTION_KEY` is changed or corrupted, all existing keys fail to decrypt and are marked as `INVALID_KEY` without recovery path.
- Files: `src/worker/proxy/forward.ts` (lines 117-123)
- Trigger: Rotate `ENCRYPTION_KEY` in environment variables without re-encrypting all stored keys.
- Workaround: Maintain the old `ENCRYPTION_KEY` during transition, re-encrypt keys with new key, then update env var. No automated tooling for this exists.

### Model Extraction Regex False Positives

- Symptoms: If a request body contains a field with an escaped quote like `"field_model": "value\"with\"quotes"`, the regex could match inside the string value instead of the actual model field.
- Files: `src/worker/proxy/formats.ts` (line 93, regex `MODEL_RE`)
- Trigger: Client sends a JSON field with escaped quotes in a value that contains the substring `"model":"...`.
- Workaround: None. This is a fundamental limitation of regex-based JSON parsing. Unlikely to occur in practice but theoretically possible.

## Security Considerations

### User-Supplied Error Regexes Can Cause ReDoS

- Risk: Admin users can configure error classification rules with arbitrary regexes in `error_rules.table.body_regex`. Catastrophic backtracking patterns like `(a+)+$` can timeout the entire request.
- Files: `src/worker/routing/error-rules.ts` (lines 31-41, compile function)
- Current mitigation: Regexes are compiled with `'i'` flag (case-insensitive) and cached. Invalid regexes are caught and silently ignored.
- Recommendations: (1) Add a timeout to regex execution (use a regex library with step limits or validate patterns server-side). (2) Validate regex complexity before storing (reject known ReDoS patterns). (3) Log and alert when a regex fails to compile.

### Encryption Key Rotation Lacks Tooling

- Risk: If `ENCRYPTION_KEY` is exposed, an attacker with access to D1 can decrypt all stored upstream API keys. There's no automated way to rotate the key and re-encrypt all keys in-place.
- Files: `src/worker/db/crypto.ts`, `src/worker/db/repo.ts`
- Current mitigation: Keys are encrypted at rest with AES-256-GCM.
- Recommendations: (1) Build a CLI command to re-encrypt all keys with a new secret. (2) Implement key versioning in the schema (store which key version was used for each encryption). (3) Support seamless key rotation by keeping both old and new keys active during transition.

### Gateway Key Prefix Stored in Plaintext

- Risk: In `migrations/0001_init.sql` (line 79), `key_prefix` is stored as plaintext (e.g., "sk-gw-"). If a gateway key hash is exposed, the prefix could help an attacker guess the full key.
- Files: `migrations/0001_init.sql`
- Current mitigation: Only the hash is exposed via API responses; the prefix is display-only in the dashboard.
- Recommendations: Hash the prefix as well or omit it entirely. If display purposes require it, generate it on-the-fly from the hash.

### Admin API Lacks Rate Limiting After Login

- Risk: After a successful admin login, there's no rate limiting on mutations (POST/PUT/DELETE to `/api/admin/*`). A compromised session token could spam operations.
- Files: `src/worker/admin/routes.ts` (all mutation endpoints)
- Current mitigation: Requests require a valid session cookie (`SameSite=Strict`, `HttpOnly`).
- Recommendations: Add per-session or per-IP rate limiting on admin mutations (e.g., 100 requests per minute).

### Request Body Read Lacks Size Limit

- Risk: In `src/worker/proxy/forward.ts` (line 62), the body is read with `await req.text()` with no maximum size. Claude Code bodies can exceed 1 MB.
- Files: `src/worker/proxy/forward.ts`
- Current mitigation: Cloudflare Workers have a 100 MB subrequest body limit.
- Recommendations: Add an explicit size check (e.g., reject bodies > 10 MB) to provide clear error messages and prevent memory exhaustion.

## Performance Bottlenecks

### Stream Peek Buffer Can Accumulate Unbounded

- Problem: In `src/worker/proxy/stream-peek.ts` (lines 51-85), if an SSE stream sends only comments/pings (no data events), the peek buffer accumulates up to `MAX_PEEK_BYTES` (8192). For a slow relay sending tiny chunks slowly, this wastes memory and CPU.
- Files: `src/worker/proxy/stream-peek.ts`
- Cause: The loop reads chunks until it finds a complete data event or reaches 8 KB. If a relay never sends a data event, all 8 KB are buffered.
- Improvement path: (1) Add a timeout to the peek loop (fail fast if no data event within N seconds). (2) Reduce `MAX_PEEK_BYTES` or add a chunk count limit. (3) Implement a streaming classifier that detects errors without buffering.

### Cron Balance Refresh Can Stall

- Problem: In `src/worker/cron.ts` (lines 103-109), balance checks are made sequentially and synchronously. Each `checkBalance()` call can take 15+ seconds (making 2 HTTP requests to the upstream). If many keys need checking and cron times out (30-second limit), balances won't be refreshed.
- Files: `src/worker/cron.ts`, `src/worker/balance.ts`
- Cause: No parallelization or timeout on individual balance checks.
- Improvement path: (1) Parallelize balance checks with `Promise.all()` but limit concurrency to 3-4. (2) Add timeout to each balance check (e.g., 5 seconds). (3) Prioritize older keys (stale balance data first).

### Config Cache 30-Second Staleness

- Problem: The config cache in `src/worker/db/cache.ts` (line 11) has a 30-second TTL. During a security incident (e.g., disabling a key), the change takes up to 30 seconds to propagate across all isolates.
- Files: `src/worker/db/cache.ts`
- Cause: Balancing D1 read costs vs. fresh config data.
- Improvement path: (1) Reduce TTL to 5-10 seconds. (2) Implement invalidation webhooks or Workers KV pubsub. (3) For critical operations (disabling a key), force immediate invalidation.

### Regex Compilation Cache Can Grow Unbounded

- Problem: In `src/worker/routing/error-rules.ts` (line 29), `regexCache` clears when size exceeds 200. With many unique error rule regexes, this causes frequent clears and recompilation.
- Files: `src/worker/routing/error-rules.ts`
- Cause: No LRU eviction; clears entire cache when threshold hit.
- Improvement path: Use LRU eviction instead of clear-all (e.g., remove oldest 50 entries when hitting 200).

## Fragile Areas

### Stream-to-Client Response is Complex and Hard to Modify

- Files: `src/worker/proxy/forward.ts` (lines 261-328, `streamToClient` function)
- Why fragile: The function manages a `ReadableStream` with pull-based backpressure, usage tapping, logging promises, and error handling. The finish logic (line 281-288) must handle early close, errors, and stream completion. Any change to timing or ordering risks dropping logs or hanging streams.
- Safe modification: (1) Add comprehensive tests for stream cancellation, errors, and early close. (2) Use structured concurrency (e.g., AbortController) for the logging promise. (3) Add timeout to stream reading (fail if no data for N seconds).
- Test coverage: Needs more integration tests for stream scenarios.

### Admin Routes File is Large and Monolithic

- Files: `src/worker/admin/routes.ts` (624 lines)
- Why fragile: Single file contains all CRUD logic for providers, keys, routes, rules, gateway keys, and settings. No clear separation of concerns. Changes to one entity can accidentally affect another.
- Safe modification: (1) Split into separate route modules (e.g., `admin/routes/providers.ts`, `admin/routes/keys.ts`). (2) Extract common validation logic into a shared module. (3) Add route-level tests for each entity.
- Test coverage: Gaps in admin CRUD operations.

### Key-State Transitions Lack Atomicity

- Files: `src/worker/routing/key-state.ts`, `src/worker/db/cache.ts`, `src/worker/proxy/forward.ts` (lines 188, 214)
- Why fragile: Key-state changes happen in multiple places (forward.ts for failures, cron.ts for rechecks, admin routes for manual changes). The `patchCachedKey` function (cache.ts line 47-56) mutates in-memory config, but if the D1 write fails, the in-memory state is inconsistent.
- Safe modification: (1) Ensure all `applyKeyPatch` calls handle failures. (2) Add validation that in-memory state matches D1 before proceeding. (3) Use transactions where possible.
- Test coverage: Missing tests for concurrent key-state updates.

### Error Classification Rules Are Hard to Debug

- Files: `src/worker/routing/error-rules.ts` (lines 44-87, classify function)
- Why fragile: Rules are evaluated in priority order with regex matching. If a rule doesn't match as expected, it's hard to diagnose why. The admin UI shows rule definitions but not a "test this rule against sample error" tool.
- Safe modification: (1) Build a rule tester in the admin UI (show which rule matched for a given status/body). (2) Add debug logging (off by default). (3) Log all rule evaluations for failed requests.
- Test coverage: Unit tests cover individual functions but not full rule chains.

## Scaling Limits

### Cloudflare Workers 10ms Free-Tier CPU Budget

- Current capacity: 10 ms per request (free tier).
- Limit: Complex request paths (many providers/keys, regex-heavy error rules) can exhaust CPU before reaching the upstream.
- Scaling path: (1) Optimize hot paths (model extraction, error classification regexes). (2) Pre-compile regexes (done, but cache is limited). (3) Move expensive operations to cron (e.g., pre-warm config cache). (4) Use Workers Unbound CPU for higher throughput (paid tier).

### D1 Batch Operation Limits

- Current capacity: Free tier has limits on batch operations (exact limits not documented in Cloudflare docs).
- Limit: Each request can spawn up to HARD_ATTEMPT_CAP (40) subrequests. If multiple key patches happen concurrently (e.g., 10 keys marked EXHAUSTED), each spawns a D1 batch call. Total could exceed limits.
- Scaling path: (1) Batch key-state updates into a single D1 call. (2) Defer non-critical writes (e.g., balance updates) to cron. (3) Monitor D1 error rates and alert on limits.

### Request Log Retention

- Current capacity: Logs are kept for 7 days by default (set in `migrations/0001_init.sql` seed). Cron cleanup runs daily.
- Limit: High-volume gateways could accumulate millions of log rows. D1 insert performance degrades as table grows.
- Scaling path: (1) Increase cleanup frequency or reduce retention window. (2) Archive old logs to external storage (e.g., Cloudflare R2) before deletion. (3) Add table partitioning if D1 supports it.

## Dependencies at Risk

### No Version Pinning in package.json

- Risk: Dependencies use caret (`^`) or tilde (`~`) version ranges. A minor update could introduce breaking changes or security issues.
- Impact: `npm install` might pull different versions than development environment.
- Migration plan: (1) Pin all dependencies to exact versions (`npm ci` instead of `npm install`). (2) Use a dependency update bot (e.g., Dependabot) with automated PR testing.

## Missing Critical Features

### No Automated Encryption Key Rotation

- Problem: Upstream API keys are encrypted at rest, but there's no tooling to rotate the encryption key itself. If the key is compromised, all keys must be manually re-encrypted or re-added.
- Blocks: Secure key rotation workflows, compliance requirements.

### No Audit Logging

- Problem: Admin mutations (create/update/delete providers, keys, routes) are not logged. There's no trail of who made what changes and when.
- Blocks: Compliance, debugging incidents, security investigations.

### No Webhook or Real-Time Alerting

- Problem: When a key is marked EXHAUSTED or INVALID, there's no alert. Admins must check the dashboard or logs manually.
- Blocks: Proactive incident response, automated remediation.

### No Schema Validation or OpenAPI

- Problem: The admin API accepts arbitrary JSON. There's no OpenAPI spec or schema validation to guide clients.
- Blocks: Client library generation, type safety.

## Test Coverage Gaps

### Stream Error Scenarios

- What's not tested: Stream early close, stream errors mid-transmission, stream timeout.
- Files: `src/worker/proxy/stream-peek.ts`, `src/worker/proxy/forward.ts` (streamToClient)
- Risk: Stream handling bugs could silently drop logs or leave connections hanging.
- Priority: High

### Concurrent Key-State Updates

- What's not tested: Multiple requests updating the same key status concurrently; race conditions between in-memory cache and D1.
- Files: `src/worker/db/cache.ts`, `src/worker/routing/key-state.ts`
- Risk: Keys could enter inconsistent state.
- Priority: High

### Admin CRUD Operations

- What's not tested: Creating/updating/deleting providers, routes, rules, gateway keys; validation edge cases.
- Files: `src/worker/admin/routes.ts`
- Risk: Admin mutations could corrupt config or violate constraints.
- Priority: Medium

### Error Rule Classification

- What's not tested: Full classification chain with multiple rules; regex edge cases; provider-specific vs. global rules.
- Files: `src/worker/routing/error-rules.ts`
- Risk: Misclassification of errors could cause incorrect failover behavior.
- Priority: Medium

### Balance Checking and Recheck Logic

- What's not tested: Balance refresh during concurrent requests; timeout handling; error recovery.
- Files: `src/worker/balance.ts`, `src/worker/cron.ts`
- Risk: Balance data could become stale; rechecks could fail silently.
- Priority: Medium

---

*Concerns audit: 2026-11-13*
