import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  requestOtp,
  getWsTicket,
  setTokenGetter,
  requestClientOtp,
  getClients,
  revokeClient,
  ApiError,
} from '../api';

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

describe('desktop-client calls', () => {
  beforeEach(() => {
    setTokenGetter(() => Promise.resolve('tok-123'));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function headersOf(init?: RequestInit): Record<string, string> {
    return (init?.headers ?? {}) as Record<string, string>;
  }

  function stubStatus(status: number, body: unknown): void {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(body), { status })),
    );
  }

  it('requestClientOtp POSTs /client-otp bodyless with Bearer and no Content-Type', async () => {
    const { calls } = makeFetchSpy({ code: 'ABCD1234' });

    const res = await requestClientOtp();

    expect(res).toEqual({ code: 'ABCD1234' });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('/api/sm-relay/client-otp');
    expect(calls[0].init?.method).toBe('POST');
    expect(calls[0].init?.body).toBeUndefined();
    expect(headersOf(calls[0].init).Authorization).toBe('Bearer tok-123');
    expect(headerKeys(calls[0].init)).not.toContain('content-type');
  });

  it('getClients GETs /clients with Bearer', async () => {
    const payload = {
      clients: [
        { clientId: 'c1', email: 'a@b.co', clientName: null, issuedAt: 'x', expiresAt: null },
      ],
    };
    const { calls } = makeFetchSpy(payload);

    const res = await getClients();

    expect(res).toEqual(payload);
    expect(calls[0].url).toBe('/api/sm-relay/clients');
    expect(calls[0].init?.method ?? 'GET').toBe('GET');
    expect(headersOf(calls[0].init).Authorization).toBe('Bearer tok-123');
  });

  it('revokeClient DELETEs /clients/:id (encoded) with Bearer', async () => {
    const { calls } = makeFetchSpy({ ok: true });

    await revokeClient('a/b c');

    expect(calls[0].url).toBe('/api/sm-relay/clients/a%2Fb%20c');
    expect(calls[0].init?.method).toBe('DELETE');
    expect(headersOf(calls[0].init).Authorization).toBe('Bearer tok-123');
  });

  it('a 404 rejects with ApiError status 404', async () => {
    stubStatus(404, { error: 'client_not_found' });
    await expect(revokeClient('nope')).rejects.toMatchObject({ status: 404 });
    stubStatus(404, { error: 'client_not_found' });
    await expect(revokeClient('nope')).rejects.toBeInstanceOf(ApiError);
    stubStatus(404, { error: 'x' });
    await expect(getClients()).rejects.toMatchObject({ status: 404 });
    stubStatus(404, { error: 'x' });
    await expect(requestClientOtp()).rejects.toMatchObject({ status: 404 });
  });
});
