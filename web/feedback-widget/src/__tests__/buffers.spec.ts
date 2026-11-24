import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BUFFER_SIZE, installBuffers, sanitizeUrl, type Buffers } from '../buffers';

// Minimal stand-in XHR: open/send on the prototype (what buffers patches), events via EventTarget.
class FakeXHR extends EventTarget {
  static last: FakeXHR | null = null;
  status = 0;
  sentBody: unknown = undefined;
  openArgs: unknown[] = [];
  open(...args: unknown[]): void {
    this.openArgs = args;
  }
  send(body?: unknown): void {
    this.sentBody = body;
    FakeXHR.last = this;
  }
  finish(kind: 'load' | 'error' | 'timeout' | 'abort', status = 0): void {
    this.status = status;
    this.dispatchEvent(new Event(kind));
    this.dispatchEvent(new Event('loadend'));
  }
}

const realFetch = window.fetch;
const realXHR = globalThis.XMLHttpRequest;
const realConsoleError = console.error;

let consoleSpy: ReturnType<typeof vi.fn>;
let fetchStub: ReturnType<typeof vi.fn>;
let b: Buffers | null = null;

function install(prefixes: string[] = []): Buffers {
  b = installBuffers({ ownUrlPrefixes: prefixes });
  return b;
}

function xhr(method: string, url: string): FakeXHR {
  const x = new (globalThis.XMLHttpRequest as unknown as typeof FakeXHR)();
  (x as unknown as XMLHttpRequest).open(method, url);
  (x as unknown as XMLHttpRequest).send(null);
  return x;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-23T10:00:00.000Z'));
  consoleSpy = vi.fn();
  console.error = consoleSpy as unknown as typeof console.error;
  fetchStub = vi.fn();
  window.fetch = fetchStub as unknown as typeof fetch;
  (globalThis as { XMLHttpRequest: unknown }).XMLHttpRequest = FakeXHR;
});

afterEach(() => {
  b?.uninstall();
  b = null;
  vi.useRealTimers();
  console.error = realConsoleError;
  window.fetch = realFetch;
  (globalThis as { XMLHttpRequest: unknown }).XMLHttpRequest = realXHR;
});

describe('console buffer', () => {
  it('wraps console.error and still calls the original', () => {
    const buf = install();
    console.error('boom', 42);
    expect(consoleSpy).toHaveBeenCalledWith('boom', 42);
    const [e] = buf.consoleEntries();
    expect(e).toMatchObject({
      level: 'error',
      message: 'boom 42',
      timestamp: '2026-11-23T10:00:00.000Z',
      count: 1,
    });
    expect(e.source).toMatch(/:\d+:\d+$/);
  });

  it('uses an Error argument for message, stack and source', () => {
    const buf = install();
    const err = new Error('bad thing');
    err.stack = 'Error: bad thing\n    at doIt (https://app.example/main.js:12:34)';
    console.error(err);
    const [e] = buf.consoleEntries();
    expect(e.message).toBe('Error: bad thing');
    expect(e.stack).toBe(err.stack);
    expect(e.source).toBe('https://app.example/main.js:12:34');
  });

  it('clips message to 500 and stack to 2000 chars', () => {
    const buf = install();
    const err = new Error('x'.repeat(900));
    err.stack = 'y'.repeat(5000);
    console.error(err);
    const [e] = buf.consoleEntries();
    expect(e.message.length).toBe(500);
    expect(e.stack.length).toBe(2000);
  });

  it('records window error events with file:line:col', () => {
    const buf = install();
    const error = new Error('kaput');
    window.dispatchEvent(
      new ErrorEvent('error', {
        message: 'Uncaught Error: kaput',
        filename: 'https://app.example/app.js',
        lineno: 7,
        colno: 3,
        error,
      }),
    );
    const [e] = buf.consoleEntries();
    expect(e).toMatchObject({
      level: 'error',
      message: 'Uncaught Error: kaput',
      source: 'https://app.example/app.js:7:3',
      count: 1,
    });
    expect(e.stack).toBe(error.stack);
  });

  it('records unhandledrejection events', () => {
    const buf = install();
    const reason = new Error('nope');
    reason.stack = 'Error: nope\n    at x (https://app.example/a.js:1:2)';
    const ev = new Event('unhandledrejection') as Event & { reason: unknown };
    ev.reason = reason;
    window.dispatchEvent(ev);
    const [e] = buf.consoleEntries();
    expect(e.message).toContain('nope');
    expect(e.source).toBe('https://app.example/a.js:1:2');
  });

  it('increments count for consecutive identical messages', () => {
    const buf = install();
    console.error('same');
    console.error('same');
    console.error('same');
    console.error('other');
    console.error('same');
    expect(buf.consoleEntries().map((e) => [e.message, e.count])).toEqual([
      ['same', 3],
      ['other', 1],
      ['same', 1],
    ]);
  });

  it('keeps at most 20 entries (newest)', () => {
    const buf = install();
    for (let i = 0; i < 25; i++) console.error(`err ${i}`);
    const entries = buf.consoleEntries();
    expect(entries).toHaveLength(BUFFER_SIZE);
    expect(entries[0].message).toBe('err 5');
    expect(entries[19].message).toBe('err 24');
  });
});

describe('fetch buffer', () => {
  it('records HTTP >= 400 with method, sanitized url, status, duration', async () => {
    const buf = install();
    fetchStub.mockImplementation(
      () => new Promise((r) => setTimeout(() => r({ status: 503 } as Response), 150)),
    );
    const p = window.fetch('https://api.example/v1/items?q=secret&page=2', { method: 'post' });
    await vi.advanceTimersByTimeAsync(150);
    await p;
    expect(buf.networkEntries()).toEqual([
      {
        method: 'POST',
        url: 'https://api.example/v1/items?q=…&page=…',
        status: 503,
        durationMs: 150,
        timestamp: '2026-11-23T10:00:00.150Z',
      },
    ]);
  });

  it('ignores successful responses', async () => {
    const buf = install();
    fetchStub.mockResolvedValue({ status: 200 } as Response);
    await window.fetch('https://api.example/ok');
    fetchStub.mockResolvedValue({ status: 399 } as Response);
    await window.fetch('https://api.example/ok');
    expect(buf.networkEntries()).toEqual([]);
  });

  it('records network errors and timeouts, ignores aborts', async () => {
    const buf = install();
    fetchStub.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await expect(window.fetch('https://api.example/a')).rejects.toThrow('Failed to fetch');
    fetchStub.mockRejectedValueOnce(new DOMException('timed out', 'TimeoutError'));
    await expect(window.fetch('https://api.example/b')).rejects.toThrow();
    fetchStub.mockRejectedValueOnce(new DOMException('aborted', 'AbortError'));
    await expect(window.fetch('https://api.example/c')).rejects.toThrow();
    expect(buf.networkEntries().map((e) => [e.url, e.status])).toEqual([
      ['https://api.example/a', 'network-error'],
      ['https://api.example/b', 'timeout'],
    ]);
  });

  it('treats an abort whose signal reason is TimeoutError as a timeout', async () => {
    const buf = install();
    const ctrl = new AbortController();
    ctrl.abort(new DOMException('t', 'TimeoutError'));
    fetchStub.mockRejectedValueOnce(new DOMException('aborted', 'AbortError'));
    await expect(window.fetch('https://api.example/t', { signal: ctrl.signal })).rejects.toThrow();
    expect(buf.networkEntries().map((e) => e.status)).toEqual(['timeout']);
  });

  it('never reads headers or bodies', async () => {
    const buf = install();
    const init = {
      method: 'PUT',
      get headers(): HeadersInit {
        throw new Error('headers read');
      },
      get body(): BodyInit {
        throw new Error('body read');
      },
    } as RequestInit;
    const res = {
      status: 500,
      get headers(): Headers {
        throw new Error('response headers read');
      },
      text: () => {
        throw new Error('response body read');
      },
    } as unknown as Response;
    fetchStub.mockResolvedValue(res);
    await window.fetch('https://api.example/x', init);
    const [e] = buf.networkEntries();
    expect(Object.keys(e).sort()).toEqual(['durationMs', 'method', 'status', 'timestamp', 'url']);
    expect(e.method).toBe('PUT');
  });

  it('skips requests matching an ownUrlPrefixes entry', async () => {
    const buf = install(['https://bilko.run/api/sm-relay', 'https://feedback.example/v1']);
    fetchStub.mockResolvedValue({ status: 500 } as Response);
    await window.fetch('https://bilko.run/api/sm-relay/boxes/X');
    await window.fetch('https://feedback.example/v1/reports?x=1');
    await window.fetch('https://other.example/v1');
    expect(buf.networkEntries().map((e) => e.url)).toEqual(['https://other.example/v1']);
  });

  it('keeps at most 20 entries', async () => {
    const buf = install();
    fetchStub.mockResolvedValue({ status: 404 } as Response);
    for (let i = 0; i < 23; i++) await window.fetch(`https://api.example/${i}`);
    const entries = buf.networkEntries();
    expect(entries).toHaveLength(BUFFER_SIZE);
    expect(entries[0].url).toBe('https://api.example/3');
  });
});

describe('XMLHttpRequest buffer', () => {
  it('records status >= 400 with duration; ignores success', async () => {
    const buf = install();
    const x = xhr('get', 'https://api.example/data?token=abc');
    vi.advanceTimersByTime(80);
    x.finish('load', 404);
    xhr('GET', 'https://api.example/fine').finish('load', 200);
    expect(buf.networkEntries()).toEqual([
      {
        method: 'GET',
        url: 'https://api.example/data?token=…',
        status: 404,
        durationMs: 80,
        timestamp: '2026-11-23T10:00:00.080Z',
      },
    ]);
  });

  it('records network-error and timeout, ignores abort', () => {
    const buf = install();
    xhr('POST', 'https://api.example/e').finish('error');
    xhr('POST', 'https://api.example/t').finish('timeout');
    xhr('POST', 'https://api.example/a').finish('abort');
    expect(buf.networkEntries().map((e) => [e.url, e.status])).toEqual([
      ['https://api.example/e', 'network-error'],
      ['https://api.example/t', 'timeout'],
    ]);
  });

  it('passes the body through without recording it and skips own requests', () => {
    const buf = install(['https://feedback.example/v1']);
    const x = new (globalThis.XMLHttpRequest as unknown as typeof FakeXHR)();
    (x as unknown as XMLHttpRequest).open('POST', 'https://feedback.example/v1/reports');
    (x as unknown as XMLHttpRequest).send('secret-body');
    expect(x.sentBody).toBe('secret-body');
    x.finish('load', 500);
    expect(buf.networkEntries()).toEqual([]);
  });
});

describe('sanitizeUrl', () => {
  it('keeps origin + path, masks every query value, drops the fragment', () => {
    expect(sanitizeUrl('https://a.example/p/q?x=1&y=&z#frag')).toBe(
      'https://a.example/p/q?x=…&y=…&z=…',
    );
    expect(sanitizeUrl('https://a.example/p')).toBe('https://a.example/p');
    expect(sanitizeUrl('/rel/path?k=v')).toBe(`${location.origin}/rel/path?k=…`);
  });
});

describe('uninstall', () => {
  it('restores console.error, fetch, XHR and stops listening', async () => {
    const proto = FakeXHR.prototype;
    const open = proto.open;
    const send = proto.send;
    const buf = install();
    expect(console.error).not.toBe(consoleSpy);
    expect(window.fetch).not.toBe(fetchStub);
    expect(proto.open).not.toBe(open);
    expect(proto.send).not.toBe(send);
    buf.uninstall();
    b = null;
    expect(console.error).toBe(consoleSpy);
    expect(window.fetch).toBe(fetchStub);
    expect(proto.open).toBe(open);
    expect(proto.send).toBe(send);
    window.dispatchEvent(new ErrorEvent('error', { message: 'after' }));
    console.error('after');
    expect(buf.consoleEntries()).toEqual([]);
  });
});
