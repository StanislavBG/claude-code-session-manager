// Shared font fetch helpers for the screenshot font passes (fontSheets.ts, fontProbe.ts).
//
// One module-level cache keyed by kind, credentials and URL. Concurrent callers share one
// in-flight promise; a successful result stays cached; a failed or timed-out fetch (null) is
// dropped so the next capture retries it.

const FETCH_TIMEOUT_MS = 3000;

const cache = new Map<string, Promise<unknown>>();

function cachedFetch<T>(
  kind: string,
  url: string,
  credentials: RequestCredentials,
  read: (res: Response) => Promise<T>,
): Promise<T | null> {
  const key = `${kind}\u0000${credentials}\u0000${url}`;
  const hit = cache.get(key) as Promise<T | null> | undefined;
  if (hit) return hit;
  const p = (async (): Promise<T | null> => {
    if (typeof fetch !== 'function') return null;
    const ctl = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = setTimeout(() => ctl?.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(url, { mode: 'cors', credentials, signal: ctl?.signal });
      if (!res.ok) return null;
      return await read(res);
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  })();
  cache.set(key, p);
  void p.then((v) => {
    if (v === null && cache.get(key) === p) cache.delete(key);
  });
  return p;
}

/** fetch() `url` as bytes (cors, 3 s timeout); null on any failure. Never rejects. */
export function fetchBytesCached(url: string, credentials: RequestCredentials): Promise<ArrayBuffer | null> {
  return cachedFetch('bytes', url, credentials, (r) => r.arrayBuffer());
}

/** fetch() `url` as text (cors, credentials omitted, 3 s timeout); null on any failure. Never rejects. */
export function fetchTextCached(url: string): Promise<string | null> {
  return cachedFetch('text', url, 'omit', (r) => r.text());
}

/** Test hook: forget every cached response. */
export function resetFontFetchCacheForTests(): void {
  cache.clear();
}

export const TIMED_OUT: unique symbol = Symbol('timed-out');
export type TimedOut = typeof TIMED_OUT;

/** Resolves `p`, or TIMED_OUT once `deadline` (Date.now() ms) passes. Never rejects. */
export function beforeDeadline<T>(p: Promise<T>, deadline: number): Promise<T | TimedOut> {
  const left = deadline - Date.now();
  if (left <= 0) return Promise.resolve<T | TimedOut>(TIMED_OUT);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<TimedOut>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), left);
  });
  const settled = p.then(
    (v): T | TimedOut => v,
    (): T | TimedOut => TIMED_OUT,
  );
  return Promise.race<T | TimedOut>([settled, timeout]).finally(() => clearTimeout(timer));
}
