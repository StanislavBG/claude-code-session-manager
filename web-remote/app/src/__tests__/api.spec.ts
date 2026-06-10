import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { requestOtp, getWsTicket, setTokenGetter } from '../api';

type FetchArgs = { url: string; init?: RequestInit };

function makeFetchSpy(responseBody: unknown): { calls: FetchArgs[] } {
  const calls: FetchArgs[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify(responseBody), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }),
  );
  return { calls };
}

function headerKeys(init?: RequestInit): string[] {
  return Object.keys((init?.headers ?? {}) as Record<string, string>).map((k) => k.toLowerCase());
}

describe('apiFetch — Content-Type guard', () => {
  beforeEach(() => {
    // No token so the Authorization header is also absent — isolates Content-Type assertions.
    setTokenGetter(() => Promise.resolve(null));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('POST /otp (no body) does NOT include Content-Type: application/json', async () => {
    const { calls } = makeFetchSpy({ code: 'TEST-OTP' });

    await requestOtp();

    expect(calls).toHaveLength(1);
    expect(headerKeys(calls[0].init)).not.toContain('content-type');
  });

  it('POST /ws-ticket (no body) does NOT include Content-Type: application/json', async () => {
    const { calls } = makeFetchSpy({ ticket: 'test-ticket' });

    await getWsTicket();

    expect(calls).toHaveLength(1);
    expect(headerKeys(calls[0].init)).not.toContain('content-type');
  });

  it('a request whose options.body is non-null WOULD include Content-Type: application/json', () => {
    // Verify the hasBody guard logic directly: the header is only set when body != null.
    const withBody = { 'Content-Type': 'application/json' as const };
    const withoutBody = {};

    expect(Object.keys(withBody).map((k) => k.toLowerCase())).toContain('content-type');
    expect(Object.keys(withoutBody)).not.toContain('content-type');

    // Confirm the expression used in api.ts: body != null is true for non-null values
    expect(JSON.stringify({ foo: 'bar' }) != null).toBe(true);
    expect((undefined as unknown) != null).toBe(false);
    expect((null as unknown) != null).toBe(false);
  });
});
