// outbox — keeps a report that could not be sent in the visitor's browser and retries it
// (design README "Failure handling", session-manager-operations/design-mocks/feedback-widget/).
//
// Items live in IndexedDB `feedback-outbox` as the multipart PLAINTEXT plus its send target.
// Sealing happens at send time inside sendReport, so a retry always seals to the box's current key.
// Retries run on script load, on the window `online` event and on a timer for the next due item.
// Backoff after enqueue: 5 s, 30 s, 2 min, 10 min, 1 h — the 5th failed retry deletes the item.
// A 'rejected' result (4xx other than 408/429) deletes it at once. The clientReportId is stored
// once and never rewritten, so the relay can de-duplicate every attempt of one report.

import type { BoxKey } from './host';
import { sendReport, type SendResult } from './transport';

export const OUTBOX_DB = 'feedback-outbox';
const STORE = 'items';
const DB_VERSION = 1;

/** Delay before retry n+1, in ms. Its length is the number of retries before giving up. */
export const BACKOFF_MS: readonly number[] = [5_000, 30_000, 120_000, 600_000, 3_600_000];
export const MAX_TRIES = BACKOFF_MS.length;

export interface EnqueueInput {
  clientReportId: string;
  /** Sealed path: `fbk1_<boxId>.<fingerprint>` (or parsed). Required unless `endpoint` is set. */
  key?: string | BoxKey | null;
  /** Plain path: the site's own endpoint. */
  endpoint?: string;
  project?: string;
  relayBase?: string;
  contentType: string;
  body: Uint8Array;
}

export interface OutboxItem {
  clientReportId: string;
  key?: string | BoxKey | null;
  endpoint?: string;
  project?: string;
  relayBase?: string;
  contentType: string;
  body: Uint8Array;
  /** Retries already made (the first, pre-enqueue send is not counted). */
  tries: number;
  /** Epoch ms at which the next retry is due. */
  nextAt: number;
  createdAt: number;
}

let dbPromise: Promise<IDBDatabase> | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let running: Promise<void> | null = null;
let rerun = false;
let started = false;

function hasIdb(): boolean {
  return typeof indexedDB !== 'undefined' && indexedDB !== null;
}

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(OUTBOX_DB, DB_VERSION);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) {
        req.result.createObjectStore(STORE, { keyPath: 'clientReportId' });
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };
      resolve(db);
    };
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('feedback-outbox open blocked'));
  });
  dbPromise.catch(() => {
    dbPromise = null;
  });
  return dbPromise;
}

function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(STORE, mode);
        const req = fn(t.objectStore(STORE));
        t.oncomplete = () => resolve(req.result);
        t.onerror = () => reject(t.error ?? req.error);
        t.onabort = () => reject(t.error ?? new Error('feedback-outbox transaction aborted'));
      }),
  );
}

/** Every stored item, oldest first. */
export async function pending(): Promise<OutboxItem[]> {
  if (!hasIdb()) return [];
  const all = await tx<OutboxItem[]>('readonly', (s) => s.getAll() as IDBRequest<OutboxItem[]>);
  return all.sort((a, b) => a.createdAt - b.createdAt);
}

function put(item: OutboxItem): Promise<IDBValidKey> {
  return tx('readwrite', (s) => s.put(item));
}

function remove(clientReportId: string): Promise<undefined> {
  return tx('readwrite', (s) => s.delete(clientReportId));
}

/**
 * Store a report whose send failed (retryable). The first retry is due 5 s from now.
 * Re-enqueuing a clientReportId already held keeps its retry state. Resolves false when the
 * browser has no usable IndexedDB (private mode, storage blocked); never throws.
 */
export async function enqueue(input: EnqueueInput): Promise<boolean> {
  if (!hasIdb() || !input.clientReportId) return false;
  try {
    const existing = await tx<OutboxItem | undefined>(
      'readonly',
      (s) => s.get(input.clientReportId) as IDBRequest<OutboxItem | undefined>,
    );
    if (!existing) {
      const now = Date.now();
      const item: OutboxItem = {
        clientReportId: input.clientReportId,
        contentType: input.contentType,
        body: new Uint8Array(input.body),
        tries: 0,
        nextAt: now + BACKOFF_MS[0],
        createdAt: now,
      };
      if (input.key != null) item.key = input.key;
      if (input.endpoint) item.endpoint = input.endpoint;
      if (input.project) item.project = input.project;
      if (input.relayBase) item.relayBase = input.relayBase;
      await put(item);
    }
    await scheduleNext();
    return true;
  } catch {
    return false;
  }
}

function isOffline(): boolean {
  return typeof navigator !== 'undefined' && navigator.onLine === false;
}

async function sendItem(item: OutboxItem): Promise<SendResult> {
  return sendReport({
    key: item.key ?? null,
    endpoint: item.endpoint,
    project: item.project,
    relayBase: item.relayBase,
    clientReportId: item.clientReportId,
    multipart: { contentType: item.contentType, body: new Uint8Array(item.body) },
  });
}

async function runOnce(): Promise<void> {
  if (isOffline()) return; // the `online` event flushes; no try is spent while offline
  const items = await pending();
  for (const item of items) {
    if (item.nextAt > Date.now()) continue;
    const res = await sendItem(item);
    if (res.ok || res.kind === 'rejected') {
      await remove(item.clientReportId);
      continue;
    }
    // retryable or key_mismatch: spend a try, back off, give up after the last one.
    const tries = item.tries + 1;
    if (tries >= MAX_TRIES) {
      await remove(item.clientReportId);
    } else {
      await put({ ...item, tries, nextAt: Date.now() + BACKOFF_MS[tries] });
    }
  }
}

async function scheduleNext(): Promise<void> {
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
  const items = await pending();
  if (items.length === 0) return;
  const next = Math.min(...items.map((i) => i.nextAt));
  timer = setTimeout(
    () => {
      timer = null;
      void flush();
    },
    Math.max(0, next - Date.now()),
  );
}

/** Send every due item through sendReport, then arm the timer for the next one. Never throws. */
export function flush(): Promise<void> {
  if (!hasIdb()) return Promise.resolve();
  if (running) {
    rerun = true;
    return running;
  }
  running = (async () => {
    try {
      do {
        rerun = false;
        await runOnce();
      } while (rerun);
      await scheduleNext();
    } catch {
      /* storage failure: items stay put for the next load */
    } finally {
      running = null;
    }
  })();
  return running;
}

/** Resolves once no flush is in progress (tests and callers awaiting a quiet outbox). */
export async function idle(): Promise<void> {
  while (running) await running;
}

function onOnline(): void {
  void flush();
}

/** Arm the load-time flush and the `online` listener. Idempotent. */
export function startOutbox(): void {
  if (started || typeof window === 'undefined' || !hasIdb()) return;
  started = true;
  window.addEventListener('online', onOnline);
  void flush();
}

/** Undo startOutbox and drop the open connection (tests, teardown). */
export function stopOutbox(): void {
  started = false;
  if (typeof window !== 'undefined') window.removeEventListener('online', onOnline);
  if (timer !== null) clearTimeout(timer);
  timer = null;
  const p = dbPromise;
  dbPromise = null;
  p?.then((db) => db.close()).catch(() => {});
}

// Script load: anything a previous page left behind is retried now.
startOutbox();
