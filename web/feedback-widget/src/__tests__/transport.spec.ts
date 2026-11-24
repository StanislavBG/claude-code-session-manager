// transport: a status-0 POST is always retryable, even when the public key route answers.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const FP = 'AbCdEfGhIjKlMnOpQrSt_-';
vi.mock('../seal', () => ({
  keyFingerprint: async () => FP,
  sealEnvelope: async () => new Uint8Array([1, 2, 3]),
}));

import { classifyStatus, sendReport } from '../transport';

type Outcome = 'error' | 'timeout' | 'abort' | { status: number; body?: string };
let outcome: Outcome = 'error';
let progressBytes = 0;
const posts: string[] = [];

class FakeXhr {
  status = 0;
  responseText = '';
  timeout = 0;
  upload: { onprogress?: (e: { loaded: number; total: number; lengthComputable: boolean }) => void } = {};
  onload?: () => void;
  onerror?: () => void;
  onabort?: () => void;
  ontimeout?: () => void;
  private url = '';
  open(_m: string, url: string) {
    this.url = url;
  }
  setRequestHeader() {}
  send() {
    posts.push(this.url);
    queueMicrotask(() => {
      if (progressBytes > 0) this.upload.onprogress?.({ loaded: progressBytes, total: 3, lengthComputable: true });
      if (outcome === 'error') this.onerror?.();
      else if (outcome === 'timeout') this.ontimeout?.();
      else if (outcome === 'abort') this.onabort?.();
      else {
        this.status = outcome.status;
        this.responseText = outcome.body ?? '';
        this.onload?.();
      }
    });
  }
}

const fetchMock = vi.fn(async () => new Response(JSON.stringify({ publicKey: 'pk' }), { status: 200 }));

beforeEach(() => {
  outcome = 'error';
  progressBytes = 0;
  posts.length = 0;
  fetchMock.mockClear();
  vi.stubGlobal('XMLHttpRequest', FakeXhr);
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => vi.unstubAllGlobals());

const send = () =>
  sendReport({
    key: `fbk1_ABCDEFGH.${FP}`,
    clientReportId: 'rep-1',
    multipart: { contentType: 'multipart/form-data; boundary=x', body: new Uint8Array([45, 45]) },
  });

describe('sendReport status 0', () => {
  it('is retryable when the POST fails before any upload while the key route is reachable', async () => {
    expect(await send()).toEqual({ ok: false, kind: 'retryable' });
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatch(/\/boxes\/ABCDEFGH\/envelopes$/);
  });

  it.each(['timeout', 'abort'] as const)('is retryable on %s', async (o) => {
    outcome = o;
    expect(await send()).toEqual({ ok: false, kind: 'retryable' });
  });

  it('is retryable after partial upload', async () => {
    progressBytes = 2;
    expect(await send()).toEqual({ ok: false, kind: 'retryable' });
  });

  it('still rejects a real 4xx and accepts a 2xx', async () => {
    outcome = { status: 403, body: '{}' };
    expect(await send()).toEqual({ ok: false, kind: 'rejected', status: 403 });
    outcome = { status: 201, body: '{"id":"r1"}' };
    expect(await send()).toEqual({ ok: true, id: 'r1' });
  });

  it('plain endpoint status 0 is retryable', async () => {
    const r = await sendReport({
      endpoint: 'https://site.example/feedback',
      clientReportId: 'rep-2',
      multipart: { contentType: 'multipart/form-data; boundary=x', body: new Uint8Array([45]) },
    });
    expect(r).toEqual({ ok: false, kind: 'retryable' });
  });

  it('classifyStatus(0) is retryable', () => {
    expect(classifyStatus(0, '')).toEqual({ ok: false, kind: 'retryable' });
  });
});
