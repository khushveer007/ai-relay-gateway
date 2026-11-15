import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api, setUnauthorizedHandler } from '../src/dashboard/lib/api';

// The client talks to fetch only, so a stubbed fetch is enough; no DOM is needed.
function stubFetch(body: string | null, status: number) {
  const fn = vi.fn(async () => new Response(body, { status }));
  vi.stubGlobal('fetch', fn);
  return fn;
}

// Resolves to the rejection, or null when the call unexpectedly resolved.
const rejection = (p: Promise<unknown>): Promise<ApiError | null> => p.then(() => null, (e: ApiError) => e);

let unauthorized: ReturnType<typeof vi.fn<() => void>>;

beforeEach(() => {
  unauthorized = vi.fn<() => void>();
  setUnauthorizedHandler(unauthorized);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('api client response handling (WR-06, D-34)', () => {
  it('a 200 with a JSON body resolves to the parsed value', async () => {
    stubFetch('{"a":1}', 200);
    await expect(api.get('/x')).resolves.toEqual({ a: 1 });
  });

  it('a 200 whose body is not JSON rejects with Invalid response from the gateway.', async () => {
    stubFetch('<html>', 200);
    const err = await rejection(api.get('/x'));
    expect(err?.message).toBe('Invalid response from the gateway.');
    expect(err?.status).toBe(200);
    expect(err).toBeInstanceOf(ApiError);
  });

  it('a 204 with an empty body resolves to an empty object', async () => {
    stubFetch(null, 204);
    await expect(api.post('/x', {})).resolves.toEqual({});
  });

  it('a 200 with an empty body (not 204) rejects with the same error', async () => {
    stubFetch('', 200);
    const err = await rejection(api.get('/x'));
    expect(err?.message).toBe('Invalid response from the gateway.');
    expect(err?.status).toBe(200);
  });

  it('a 500 with a plain body rejects with HTTP 500; with a JSON error it uses that message', async () => {
    stubFetch('oops', 500);
    await expect(api.get('/x')).rejects.toMatchObject({ status: 500, message: 'HTTP 500' });
    stubFetch('{"error":"boom"}', 500);
    await expect(api.get('/x')).rejects.toMatchObject({ status: 500, message: 'boom' });
  });

  it('a 401 on a normal path calls the unauthorized handler once and rejects with ApiError 401', async () => {
    stubFetch('{"error":"unauthorized"}', 401);
    const err = await api.get('/providers').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 401, message: 'unauthorized' });
    expect(unauthorized).toHaveBeenCalledTimes(1);
  });

  it('a 401 on /session or /login never calls the unauthorized handler', async () => {
    stubFetch('{"error":"unauthorized"}', 401);
    await expect(api.get('/session')).rejects.toMatchObject({ status: 401 });
    stubFetch('{"error":"wrong password"}', 401);
    await expect(api.post('/login', { password: 'x' })).rejects.toMatchObject({ status: 401, message: 'wrong password' });
    expect(unauthorized).not.toHaveBeenCalled();
  });

  it('every non-GET call sends content-type application/json and a JSON body', async () => {
    const fn = stubFetch('{"ok":true}', 200);
    await api.post('/a', { n: 1 });
    await api.put('/b', { n: 2 });
    await api.del('/c');
    const calls = fn.mock.calls as unknown as Array<[string, RequestInit]>;
    expect(calls).toHaveLength(3);
    for (const [, init] of calls) {
      expect((init.headers as Record<string, string>)['content-type']).toBe('application/json');
      expect(() => JSON.parse(String(init.body))).not.toThrow();
    }
    expect(JSON.parse(String(calls[0][1].body))).toEqual({ n: 1 });
  });
});
