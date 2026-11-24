// Console & network buffering (design-mocks/feedback-widget/README.md §"Console & network
// buffering"). Installed when the script executes so a report can show what broke before the
// reporter opened the widget. Framework-free; the report builder reads the exported entries.
//
// Privacy rules: network entries never carry headers or bodies, query values are masked, and
// the widget's own requests (relay + configured endpoint) are never recorded.

export const BUFFER_SIZE = 20;
export const MAX_MESSAGE = 500;
export const MAX_STACK = 2000;
export const MASK = '…';

export interface ConsoleEntry {
  level: 'error';
  message: string;
  stack: string;
  /** 'file:line:col', '' when unknown. */
  source: string;
  /** ISO 8601. */
  timestamp: string;
  count: number;
}

export type NetworkStatus = number | 'network-error' | 'timeout';

export interface NetworkEntry {
  method: string;
  url: string;
  status: NetworkStatus;
  durationMs: number;
  /** ISO 8601. */
  timestamp: string;
}

export interface InstallBuffersOptions {
  /** Requests whose URL starts with one of these are never recorded. */
  ownUrlPrefixes?: ReadonlyArray<string | null | undefined>;
}

export interface Buffers {
  consoleEntries(): ConsoleEntry[];
  networkEntries(): NetworkEntry[];
  uninstall(): void;
}

function clip(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) : s;
}

function nowIso(): string {
  return new Date().toISOString();
}

function push<T>(buf: T[], entry: T): void {
  buf.push(entry);
  if (buf.length > BUFFER_SIZE) buf.splice(0, buf.length - BUFFER_SIZE);
}

function stringifyArg(arg: unknown): string {
  if (typeof arg === 'string') return arg;
  if (arg instanceof Error) return arg.message ? `${arg.name}: ${arg.message}` : arg.name;
  if (arg === undefined) return 'undefined';
  if (typeof arg === 'function') return `[function ${arg.name || 'anonymous'}]`;
  if (typeof arg === 'object' && arg !== null) {
    try {
      return JSON.stringify(arg) ?? String(arg);
    } catch {
      return Object.prototype.toString.call(arg);
    }
  }
  return String(arg);
}

const FRAME_RE = /((?:[a-z][a-z0-9+.-]*:\/\/|\/)[^\s()]*?):(\d+):(\d+)\)?\s*$/i;

/** First 'file:line:col' frame in a stack, skipping `skip` frames. */
export function sourceFromStack(stack: string | undefined, skip = 0): string {
  if (!stack) return '';
  let seen = 0;
  for (const line of stack.split('\n')) {
    const m = FRAME_RE.exec(line.trim());
    if (!m) continue;
    if (seen++ < skip) continue;
    return `${m[1]}:${m[2]}:${m[3]}`;
  }
  return '';
}

/** origin + path, every query value replaced by '…' (keys kept), fragment dropped. */
export function sanitizeUrl(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw, typeof location !== 'undefined' ? location.href : undefined);
  } catch {
    return clip(raw.split(/[?#]/)[0], MAX_MESSAGE);
  }
  const base = u.origin && u.origin !== 'null' ? u.origin + u.pathname : `${u.protocol}${u.pathname}`;
  const query = u.search.replace(/^\?/, '');
  if (!query) return base;
  const masked = query
    .split('&')
    .filter((p) => p !== '')
    .map((p) => `${p.split('=')[0]}=${MASK}`)
    .join('&');
  return masked ? `${base}?${masked}` : base;
}

function absolute(raw: string): string {
  try {
    return new URL(raw, typeof location !== 'undefined' ? location.href : undefined).href;
  } catch {
    return raw;
  }
}

export function installBuffers(options: InstallBuffersOptions = {}): Buffers {
  const prefixes = (options.ownUrlPrefixes ?? []).filter(
    (p): p is string => typeof p === 'string' && p.length > 0,
  );
  const consoleBuf: ConsoleEntry[] = [];
  const networkBuf: NetworkEntry[] = [];

  const isOwn = (raw: string): boolean => {
    const abs = absolute(raw);
    return prefixes.some((p) => raw.startsWith(p) || abs.startsWith(p));
  };

  const recordConsole = (message: string, stack: string, source: string): void => {
    const msg = clip(message, MAX_MESSAGE);
    const last = consoleBuf[consoleBuf.length - 1];
    if (last && last.message === msg) {
      last.count += 1;
      return;
    }
    push(consoleBuf, {
      level: 'error',
      message: msg,
      stack: clip(stack, MAX_STACK),
      source,
      timestamp: nowIso(),
      count: 1,
    });
  };

  const recordNetwork = (method: string, url: string, status: NetworkStatus, start: number) => {
    push(networkBuf, {
      method: (method || 'GET').toUpperCase(),
      url: sanitizeUrl(url),
      status,
      durationMs: Math.max(0, Date.now() - start),
      timestamp: nowIso(),
    });
  };

  // ---- console.error ----
  const origConsoleError = console.error;
  const wrappedConsoleError = function (this: unknown, ...args: unknown[]): void {
    try {
      const err = args.find((a): a is Error => a instanceof Error);
      const message = args.map(stringifyArg).join(' ');
      const stack = err?.stack ?? new Error().stack ?? '';
      // A captured stack's first frame is this wrapper; an Error arg's stack is its own.
      const source = sourceFromStack(stack, err ? 0 : 1);
      recordConsole(message, err ? stack : stripHeader(stack, 1), source);
    } catch {
      // Buffering must never break the host page's logging.
    }
    return origConsoleError.apply(this ?? console, args);
  };
  console.error = wrappedConsoleError;

  // ---- window error / unhandledrejection ----
  const onError = (ev: Event): void => {
    const e = ev as ErrorEvent;
    const err = e.error instanceof Error ? e.error : null;
    const message = e.message || (err ? stringifyArg(err) : 'Script error');
    const source = e.filename ? `${e.filename}:${e.lineno ?? 0}:${e.colno ?? 0}` : sourceFromStack(err?.stack);
    recordConsole(message, err?.stack ?? '', source);
  };
  const onRejection = (ev: Event): void => {
    const reason = (ev as PromiseRejectionEvent).reason;
    const err = reason instanceof Error ? reason : null;
    const message = `Unhandled rejection: ${stringifyArg(reason)}`;
    recordConsole(message, err?.stack ?? '', sourceFromStack(err?.stack));
  };
  window.addEventListener('error', onError);
  window.addEventListener('unhandledrejection', onRejection);

  // ---- fetch ----
  const origFetch = typeof window.fetch === 'function' ? window.fetch : undefined;
  let wrappedFetch: typeof fetch | undefined;
  if (origFetch) {
    wrappedFetch = function (this: unknown, input: RequestInfo | URL, init?: RequestInit) {
      let url = '';
      let method = 'GET';
      let signal: AbortSignal | null | undefined;
      try {
        if (typeof input === 'string') url = input;
        else if (input instanceof URL) url = input.href;
        else if (input && typeof (input as Request).url === 'string') {
          url = (input as Request).url;
          method = (input as Request).method || method;
          signal = (input as Request).signal;
        }
        if (init?.method) method = init.method;
        if (init?.signal) signal = init.signal;
      } catch {
        // fall through with defaults
      }
      const start = Date.now();
      const p = origFetch.call(this ?? window, input, init);
      if (!url || isOwn(url)) return p;
      return p.then(
        (res) => {
          if (res && typeof res.status === 'number' && res.status >= 400) {
            recordNetwork(method, url, res.status, start);
          }
          return res;
        },
        (err: unknown) => {
          const name = (err as { name?: unknown } | null)?.name;
          const reasonName = (signal?.reason as { name?: unknown } | undefined)?.name;
          if (name === 'TimeoutError' || (name === 'AbortError' && reasonName === 'TimeoutError')) {
            recordNetwork(method, url, 'timeout', start);
          } else if (name !== 'AbortError') {
            recordNetwork(method, url, 'network-error', start);
          }
          throw err;
        },
      );
    } as typeof fetch;
    window.fetch = wrappedFetch;
  }

  // ---- XMLHttpRequest ----
  const XHR = typeof XMLHttpRequest === 'function' ? XMLHttpRequest : undefined;
  const proto = XHR?.prototype;
  const origOpen = proto?.open;
  const origSend = proto?.send;
  const meta = new WeakMap<XMLHttpRequest, { method: string; url: string }>();
  let wrappedOpen: XMLHttpRequest['open'] | undefined;
  let wrappedSend: XMLHttpRequest['send'] | undefined;
  if (proto && origOpen && origSend) {
    wrappedOpen = function (this: XMLHttpRequest, method: string, url: string | URL, ...rest: unknown[]) {
      try {
        meta.set(this, { method: String(method), url: url instanceof URL ? url.href : String(url) });
      } catch {
        // ignore
      }
      return (origOpen as (...a: unknown[]) => void).call(this, method, url, ...rest);
    } as XMLHttpRequest['open'];
    wrappedSend = function (this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null) {
      const m = meta.get(this);
      if (m && !isOwn(m.url)) {
        const start = Date.now();
        let outcome: NetworkStatus | 'abort' | null = null;
        const xhr = this;
        const onErr = () => (outcome = 'network-error');
        const onTimeout = () => (outcome = 'timeout');
        const onAbort = () => (outcome = 'abort');
        const onLoadEnd = () => {
          xhr.removeEventListener('error', onErr);
          xhr.removeEventListener('timeout', onTimeout);
          xhr.removeEventListener('abort', onAbort);
          xhr.removeEventListener('loadend', onLoadEnd);
          if (outcome === 'abort') return;
          if (outcome === 'network-error' || outcome === 'timeout') {
            recordNetwork(m.method, m.url, outcome, start);
          } else if (xhr.status >= 400) {
            recordNetwork(m.method, m.url, xhr.status, start);
          }
        };
        xhr.addEventListener('error', onErr);
        xhr.addEventListener('timeout', onTimeout);
        xhr.addEventListener('abort', onAbort);
        xhr.addEventListener('loadend', onLoadEnd);
      }
      return origSend.call(this, body);
    };
    proto.open = wrappedOpen;
    proto.send = wrappedSend;
  }

  let installed = true;
  return {
    consoleEntries: () => consoleBuf.map((e) => ({ ...e })),
    networkEntries: () => networkBuf.map((e) => ({ ...e })),
    uninstall() {
      if (!installed) return;
      installed = false;
      if (console.error === wrappedConsoleError) console.error = origConsoleError;
      window.removeEventListener('error', onError);
      window.removeEventListener('unhandledrejection', onRejection);
      if (origFetch && window.fetch === wrappedFetch) window.fetch = origFetch;
      if (proto && origOpen && origSend) {
        if (proto.open === wrappedOpen) proto.open = origOpen;
        if (proto.send === wrappedSend) proto.send = origSend;
      }
    },
  };
}

/** Drop the 'Error' header line and the first `frames` frame lines of a captured stack. */
function stripHeader(stack: string, frames: number): string {
  const lines = stack.split('\n');
  let i = 0;
  if (lines[0] && !FRAME_RE.test(lines[0].trim())) i = 1;
  return lines.slice(i + frames).join('\n');
}
