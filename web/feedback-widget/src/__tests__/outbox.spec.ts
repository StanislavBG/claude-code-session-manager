import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SendOptions, SendResult } from '../transport';

const sendReport = vi.fn<(o: SendOptions) => Promise<SendResult>>();
vi.mock('../transport', () => ({ sendReport: (o: SendOptions) => sendReport(o) }));

type Outbox = typeof import('../outbox');
let ob: Outbox;

const RETRYABLE: SendResult = { ok: false, kind: 'retryable' };
const KEY = 'fbk1_box123.AbCdEfGhIjKlMnOpQrSt_-';
const BODY = new Uint8Array([45, 45, 120, 13, 10, 104, 105]);

function setOnline(v: boolean) {
  Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => v });
}

async function loadOutbox(): Promise<Outbox> {
  vi.resetModules();
  const m = await import('../outbox');
  await m.idle();
  return m;
}

async function advance(ms: number) {
  await vi.advanceTimersByTimeAsync(ms);
  await ob.idle();
}

function input(id = 'rep-1') {
  return { clientReportId: id, key: KEY, project: 'site-a', contentType: 'multipart/form-data; boundary=x', body: BODY };
}

beforeEach(async () => {
  globalThis.indexedDB = new IDBFactory();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  vi.setSystemTime(new Date('2026-11-23T12:00:00Z'));
  setOnline(true);
  sendReport.mockReset();
  sendReport.mockResolvedValue(RETRYABLE);
  ob = await loadOutbox();
});

afterEach(() => {
  ob.stopOutbox();
  vi.useRealTimers();
});

describe('outbox', () => {
  it('enqueue stores the multipart plaintext in IndexedDB feedback-outbox', async () => {
    expect(await ob.enqueue(input())).toBe(true);
    const items = await ob.pending();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      clientReportId: 'rep-1',
      key: KEY,
      project: 'site-a',
      contentType: 'multipart/form-data; boundary=x',
      tries: 0,
      nextAt: Date.now() + 5_000,
    });
    expect(Array.from(items[0].body)).toEqual(Array.from(BODY));

    // The data really sits in the named database.
    const db = await new Promise<IDBDatabase>((res, rej) => {
      const r = indexedDB.open(ob.OUTBOX_DB);
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    expect(db.name).toBe('feedback-outbox');
    expect(Array.from(db.objectStoreNames)).toContain('items');
    db.close();
    expect(sendReport).not.toHaveBeenCalled();
  });

  it('flush sends only due items through sendReport and deletes on success', async () => {
    await ob.enqueue(input());
    await ob.flush();
    expect(sendReport).not.toHaveBeenCalled(); // not due for 5 s

    sendReport.mockResolvedValue({ ok: true, id: 'srv-1' });
    vi.setSystemTime(Date.now() + 5_000);
    await ob.flush();
    expect(sendReport).toHaveBeenCalledTimes(1);
    const o = sendReport.mock.calls[0][0];
    expect(o.key).toBe(KEY);
    expect(o.project).toBe('site-a');
    expect(o.multipart.contentType).toBe('multipart/form-data; boundary=x');
    expect(Array.from(o.multipart.body)).toEqual(Array.from(BODY));
    expect(await ob.pending()).toEqual([]);
  });

  it('plain endpoint items are retried to the endpoint', async () => {
    await ob.enqueue({ clientReportId: 'rep-p', endpoint: 'https://site.example/fb', contentType: 'multipart/form-data; boundary=y', body: BODY });
    await advance(5_000);
    expect(sendReport).toHaveBeenCalledTimes(1);
    expect(sendReport.mock.calls[0][0].endpoint).toBe('https://site.example/fb');
    expect(sendReport.mock.calls[0][0].key ?? null).toBeNull();
  });

  it('backs off 5 s, 30 s, 2 min, 10 min, 1 h and gives up after 5 tries with the same clientReportId', async () => {
    await ob.enqueue(input());
    const steps = [5_000, 30_000, 120_000, 600_000, 3_600_000];
    for (let i = 0; i < steps.length; i++) {
      await advance(steps[i] - 1);
      expect(sendReport, `retry ${i + 1} not before ${steps[i]} ms`).toHaveBeenCalledTimes(i);
      await advance(1);
      expect(sendReport, `retry ${i + 1} at ${steps[i]} ms`).toHaveBeenCalledTimes(i + 1);
      const left = await ob.pending();
      if (i < steps.length - 1) {
        expect(left).toHaveLength(1);
        expect(left[0].tries).toBe(i + 1);
        expect(left[0].clientReportId).toBe('rep-1');
      } else {
        expect(left).toEqual([]); // gave up after the 5th try
      }
    }
    expect(sendReport.mock.calls.map((c) => c[0].clientReportId)).toEqual(Array(5).fill('rep-1'));

    await advance(10 * 3_600_000);
    expect(sendReport).toHaveBeenCalledTimes(5);
  });

  it('deletes the item at once on a rejected result', async () => {
    await ob.enqueue(input());
    sendReport.mockResolvedValue({ ok: false, kind: 'rejected', status: 400 });
    await advance(5_000);
    expect(sendReport).toHaveBeenCalledTimes(1);
    expect(await ob.pending()).toEqual([]);
    await advance(3_600_000);
    expect(sendReport).toHaveBeenCalledTimes(1);
  });

  it('waits while offline and flushes on the window online event', async () => {
    setOnline(false);
    await ob.enqueue(input());
    await advance(60_000);
    expect(sendReport).not.toHaveBeenCalled();
    expect((await ob.pending())[0].tries).toBe(0); // no try spent offline

    sendReport.mockResolvedValue({ ok: true });
    setOnline(true);
    window.dispatchEvent(new Event('online'));
    await ob.idle();
    expect(sendReport).toHaveBeenCalledTimes(1);
    expect(sendReport.mock.calls[0][0].clientReportId).toBe('rep-1');
    expect(await ob.pending()).toEqual([]);
  });

  it('retries on script load what a previous page left behind', async () => {
    setOnline(false);
    await ob.enqueue(input('rep-old'));
    ob.stopOutbox();
    vi.setSystemTime(Date.now() + 10_000);
    setOnline(true);
    sendReport.mockResolvedValue({ ok: true });

    ob = await loadOutbox(); // fresh module evaluation = the next page load
    expect(sendReport).toHaveBeenCalledTimes(1);
    expect(sendReport.mock.calls[0][0].clientReportId).toBe('rep-old');
    expect(await ob.pending()).toEqual([]);
  });

  it('re-enqueueing the same clientReportId keeps one item and its retry state', async () => {
    await ob.enqueue(input());
    await advance(5_000);
    await ob.enqueue(input());
    const items = await ob.pending();
    expect(items).toHaveLength(1);
    expect(items[0].tries).toBe(1);
    expect(items[0].clientReportId).toBe('rep-1');
  });
});
