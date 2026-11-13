---
last_mapped_commit: 714edac233d72505a98572dd49b8ebe910ba5bdc
last_mapped_at: 2026-11-13
---
# Testing Patterns

**Analysis Date:** 2026-11-13

## Test Framework

**Runner:**
- Vitest 4.1.12
- Config: `vitest.config.ts`
- Workers pool: `@cloudflare/vitest-pool-workers` for D1 / Env mocking

**Assertion Library:**
- Vitest built-in `expect()` API
- No external assertion library

**Run Commands:**
```bash
npm test              # Run all tests (vitest run)
npm run typecheck     # Type-check Worker (tsconfig.json) and Dashboard (tsconfig.ui.json)
```

## Test File Organization

**Location:**
- Co-located with source: `test/gateway.test.ts` is a single integration/unit test file
- Not dispersed; all tests in one suite for this codebase size

**Naming:**
- Single test file: `gateway.test.ts`
- Matches glob: `test/**/*.test.ts` per `vitest.config.ts`

**Structure:**
```
test/
└── gateway.test.ts         # All crypto, routing, proxy, integration tests
```

## Test Structure

**Suite Organization:**
```typescript
describe('Crypto & Auth helpers', () => {
  it('encrypts and decrypts upstream keys with AES-256-GCM', async () => {
    // test body
  });
});

describe('Error Classifier', () => {
  it('classifies default error rules accurately', () => {
    // test body
  });
});

describe('Full Proxy Failover & Admin Integration', () => {
  beforeEach(async () => {
    // setup
  });
  
  it('...', () => {
    // test
  });
});
```

**Patterns:**
- Top-level `describe()` blocks group by domain: "Crypto & Auth helpers", "Error Classifier", "Key Selection & Route Resolution", "SSE Stream Peek & Token Usage Tap", "Full Proxy Failover & Admin Integration"
- Inline `it()` blocks with descriptive names
- Shared setup via `beforeEach()` in large integration suites
- Test data builders: `makeProvider()`, `makeKey()` factory functions reduce boilerplate

## Mocking

**Framework:** Vitest `vi` for mocks; no external mock library

**Patterns:**
Test factories establish mock data:
```typescript
function makeProvider(overrides: Partial<Provider> = {}): Provider {
  return {
    id: 1,
    name: 'prov-a',
    base_url: 'https://relay-a.example.com',
    formats: ['anthropic', 'openai-chat', 'openai-responses'],
    // ... defaults
    ...overrides,
  };
}

function makeKey(overrides: Partial<ProviderKey> = {}): ProviderKey {
  return {
    id: 1,
    provider_id: 1,
    alias: 'k1',
    // ... defaults
    ...overrides,
  };
}
```

In integration tests, mock D1 result rows and batch operations:
```typescript
const mockProviders: Record<string, unknown>[] = [ /* D1 row objects */ ];
const mockKeys: Record<string, unknown>[] = [ /* D1 row objects */ ];

// Mock env.DB with batch() returning rows
env = {
  DB: {
    batch: vi.fn(async (stmts) => [
      { results: mockProviders },
      { results: mockKeys },
      // ... etc
    ]),
    prepare: vi.fn((sql) => ({
      bind: vi.fn().mockReturnThis(),
      first: vi.fn(async () => mockProviders[0]),
      all: vi.fn(async () => mockProviders),
      run: vi.fn(async () => ({ success: true })),
    })),
  } as any,
  // ... other bindings
} as Env;
```

**What to Mock:**
- D1 database calls (batch, prepare, first, all)
- Crypto operations in isolation (via direct function testing)
- HTTP responses (via `streamFromChunks()` helper for SSE tests)

**What NOT to Mock:**
- Crypto utility functions themselves (tested directly with real WebCrypto)
- Error classification logic (tested against real error rules)
- Model mapping logic (tested against real provider config)
- String utilities like `extractModel()`, `replaceModel()` (tested with real JSON bodies)

## Fixtures and Factories

**Test Data:**
```typescript
const DEFAULT_RULES: ErrorRule[] = [
  {
    id: 1,
    provider_id: null,
    priority: 10,
    status_codes: '',
    body_regex: 'insufficient[_ ]?(quota|balance|credit|funds)|...',
    action: 'EXHAUSTED',
    cooldown_s: null,
    note: 'Out of balance',
    enabled: true,
  },
  // ... 8 default error rules
];
```

Shared constant error rules for all tests; builders for variable data:
```typescript
makeProvider({ id: 10, key_strategy: 'sequential' })
makeKey({ id: 1, priority: 0, status: 'exhausted' })
```

**Location:**
- Top-level fixtures in `test/gateway.test.ts` (not extracted to separate files)
- Factory functions inline above first test that uses them

## Coverage

**Requirements:** Not enforced; no coverage threshold detected

**View Coverage:**
```bash
# Vitest supports --coverage flag (requires @vitest/coverage)
npm test -- --coverage
```

No coverage reporting configured in package.json; developers run manually if needed.

## Test Types

**Unit Tests:**
- Crypto helpers: encrypt/decrypt round-trips, HMAC signing, constant-time comparison
- Error classification: status code ranges, regex body matching, priority ordering
- Model mapping: glob matching, allowlist checking
- Key selection: sequential vs round-robin ordering, skipping unusable keys
- Format detection: path → format inference
- String utilities: JSON rewriting without full parse, error extraction from bodies

**Integration Tests:**
- Full proxy failover: authenticate → route resolve → provider/key selection → upstream request → failure → retry on next key
- Admin routes: login, session validation, config mutations (create/update provider, key, route)
- Request logging: log entry capture and async write via `ctx.waitUntil()`
- SSE stream peeking: buffer first data event, detect error events in 200 response, preserve exact bytes on re-emit
- Token usage extraction: parse Anthropic and OpenAI formats across message_start/delta/final events

**E2E Tests:**
- Not used; integration tests serve as functional end-to-end coverage

## Common Patterns

**Async Testing:**
```typescript
it('encrypts and decrypts upstream keys with AES-256-GCM', async () => {
  const secret = 'test-encryption-secret-32-bytes!!';
  const plain = 'sk-ant-api03-super-secret-upstream-key';
  const ct1 = await encrypt(plain, secret);
  const ct2 = await encrypt(plain, secret);
  expect(ct1).not.toBe(ct2); // random IV
  expect(await decrypt(ct1, secret)).toBe(plain);
  expect(await decrypt(ct2, secret)).toBe(plain);
});
```

- Mark with `async`, `await` on async functions
- Vitest auto-waits for Promise resolution

**Error Testing:**
```typescript
it('validates input and throws HttpError', () => {
  expect(() => {
    idParam('not-a-number');
  }).toThrow();
  
  expect(() => {
    str(undefined, 'name', { required: true });
  }).toThrow(/required/);
});
```

- Use `expect(() => { }).toThrow()` for sync errors
- Catch error class via `toThrow(pattern)`

**Stream Testing:**
```typescript
function streamFromChunks(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(c) {
      for (const ch of chunks) c.enqueue(enc.encode(ch));
      c.close();
    },
  });
}

it('peeks split SSE chunks and preserves exact bytes on re-emit', async () => {
  const chunks = [': keepalive\n\n', 'event: message_start\ndata: ...', ...];
  const peek = await peekStream(streamFromChunks(chunks));
  expect(peek.kind).toBe('content');
  
  // Rebuild stream and validate
  let reassembled = dec.decode(peek.head, { stream: true });
  while (true) {
    const r = await peek.reader.read();
    if (r.done) break;
    reassembled += dec.decode(r.value, { stream: true });
  }
  expect(reassembled).toBe(chunks.join(''));
});
```

- Helpers to construct streams from chunks for testing
- Use `ReadableStreamDefaultController.enqueue()` to emit chunks
- Test re-emission to verify buffering doesn't lose bytes

**Data Assertion:**
```typescript
expect(tap1.usage).toEqual({ input: 420, output: 85, cache: 100 });
expect(orderKeys(seqProv, keys, now).map((k) => k.id)).toEqual([3, 4]);
```

- `toEqual()` for deep object/array comparison
- `.map()` to extract comparison fields

## Test Execution Context

**Cloudflare Workers Environment:**
- Tests run via `@cloudflare/vitest-pool-workers`
- No explicit Worker environment setup in test file; pool handles it
- `ExecutionContext` mocked as needed for async logging tests

**D1 Mocking:**
- `env.DB` provided as test fixture
- Mock `batch()` for multi-statement atomic writes
- Mock `prepare().bind().first()` for single-row queries
- Mock `prepare().bind().all()` for multi-row queries

---

*Testing analysis: 2026-11-13*
