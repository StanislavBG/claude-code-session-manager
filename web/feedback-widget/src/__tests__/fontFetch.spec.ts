import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  TIMED_OUT,
  beforeDeadline,
  fetchBytesCached,
  fetchTextCached,
  resetFontFetchCacheForTests,
} from '../fontFetch';

const BYTES = new Uint8Array([0x77, 0x4f, 0x46, 0x32]).buffer;

afterEach(() => {
  resetFontFetchCacheForTests();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function initOf(call: unknown[]): RequestInit {
  return call[1] as RequestInit;
}

describe('fetchBytesCached / fetchTextCached', () => {
  it('caches a successful response per URL and credentials', async () => {
    const fetchMock = vi.fn(async () => new Response(BYTES));
    vi.stubGlobal('fetch', fetchMock);
    const a = await fetchBytesCached('https://x.test/a.woff2', 'omit');
    const b = await fetchBytesCached('https://x.test/a.woff2', 'omit');
    expect(a?.byteLength).toBe(4);
    expect(b).toBe(a);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(initOf(fetchMock.mock.calls[0] as unknown[])).toMatchObject({ mode: 'cors', credentials: 'omit' });
    expect(initOf(fetchMock.mock.calls[0] as unknown[]).signal).toBeInstanceOf(AbortSignal);

    await fetchBytesCached('https://x.test/a.woff2', 'same-origin');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(initOf(fetchMock.mock.calls[1] as unknown[])).toMatchObject({ credentials: 'same-origin' });
  });

  it('caches text separately and fetches it with credentials omitted', async () => {
    const fetchMock = vi.fn(async () => new Response('body{}'));
    vi.stubGlobal('fetch', fetchMock);
    expect(await fetchTextCached('https://x.test/s.css')).toBe('body{}');
    expect(await fetchTextCached('https://x.test/s.css')).toBe('body{}');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(initOf(fetchMock.mock.calls[0] as unknown[])).toMatchObject({ mode: 'cors', credentials: 'omit' });
  });

  it('drops a failed fetch from the cache so the next call retries', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('cors'))
      .mockResolvedValueOnce(new Response('x', { status: 404 }))
      .mockResolvedValueOnce(new Response(BYTES));
    vi.stubGlobal('fetch', fetchMock);
    const url = 'https://x.test/f.woff2';
    expect(await fetchBytesCached(url, 'omit')).toBeNull();
    expect(await fetchBytesCached(url, 'omit')).toBeNull();
    expect((await fetchBytesCached(url, 'omit'))?.byteLength).toBe(4);
    await fetchBytesCached(url, 'omit');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('drops a timed-out fetch from the cache so the next call retries', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const url = 'https://x.test/slow.woff2';
    const first = fetchBytesCached(url, 'omit');
    await vi.advanceTimersByTimeAsync(2999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(await first).toBeNull();
    const second = fetchBytesCached(url, 'omit');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(3000);
    expect(await second).toBeNull();
  });

  it('shares one in-flight request between concurrent callers', async () => {
    let resolve!: (r: Response) => void;
    const fetchMock = vi.fn(() => new Promise<Response>((r) => (resolve = r)));
    vi.stubGlobal('fetch', fetchMock);
    const p1 = fetchBytesCached('https://x.test/c.woff2', 'omit');
    const p2 = fetchBytesCached('https://x.test/c.woff2', 'omit');
    expect(p2).toBe(p1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    resolve(new Response(BYTES));
    expect(await p1).toBe(await p2);
  });

  it('resolves null when fetch is unavailable', async () => {
    vi.stubGlobal('fetch', undefined);
    expect(await fetchTextCached('https://x.test/n.css')).toBeNull();
  });
});

describe('beforeDeadline', () => {
  it('resolves the value before the deadline, TIMED_OUT after or on rejection', async () => {
    expect(await beforeDeadline(Promise.resolve(7), Date.now() + 1000)).toBe(7);
    expect(await beforeDeadline(Promise.resolve(7), Date.now() - 1)).toBe(TIMED_OUT);
    expect(await beforeDeadline(Promise.reject(new Error('x')), Date.now() + 1000)).toBe(TIMED_OUT);
    expect(await beforeDeadline(new Promise(() => {}), Date.now() + 20)).toBe(TIMED_OUT);
  });
});
