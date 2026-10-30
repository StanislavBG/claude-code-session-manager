import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  fetchAssetBytes,
  fetchAssetManifest,
  listenEvents,
  listenResults,
  type AssetFile,
  type FrameSocket,
} from '../remoteApi';

export const IFRAME_SANDBOX = 'allow-scripts allow-popups allow-forms allow-modals allow-downloads';
export const FLUSH_MS = 50;
export const MAX_CALLS_PER_ENVELOPE = 50;
/** The relay rate-limits browsers to ~1 message/second. */
export const MIN_SEND_GAP_MS = 1000;

// ── IndexedDB cache keyed by sha256 ─────────────────────────────────────────

const DB_NAME = 'sm-remote-assets';
const STORE = 'blobs';

function openDb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') return resolve(null);
    try {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch { resolve(null); }
  });
}

async function cacheGet(sha: string): Promise<Uint8Array | null> {
  const db = await openDb();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const req = db.transaction(STORE).objectStore(STORE).get(sha);
      req.onsuccess = () => resolve(req.result instanceof Uint8Array ? req.result : null);
      req.onerror = () => resolve(null);
    } catch { resolve(null); }
  });
}

async function cachePut(sha: string, bytes: Uint8Array): Promise<void> {
  const db = await openDb();
  if (!db) return;
  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(bytes, sha);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    } catch { resolve(); }
  });
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', bytes as unknown as BufferSource);
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
}

export class HashMismatchError extends Error {
  constructor(public file: string) {
    super(`asset ${file} failed integrity check`);
    this.name = 'HashMismatchError';
  }
}

async function loadVerified(socket: FrameSocket, deviceId: string, f: AssetFile): Promise<Uint8Array> {
  const cached = await cacheGet(f.sha256);
  if (cached && (await sha256Hex(cached)) === f.sha256) return cached;
  const bytes = await fetchAssetBytes(socket, deviceId, f.name);
  if ((await sha256Hex(bytes)) !== f.sha256) throw new HashMismatchError(f.name);
  await cachePut(f.sha256, bytes);
  return bytes;
}

const base = (p: string) => p.split(/[?#]/)[0].split('/').pop() ?? p;
const dec = new TextDecoder();

/**
 * Fixed inline bootstrap. The frame has an opaque origin, so it cannot load a parent-origin
 * blob: URL; instead the parent posts the verified script text and the frame appends it.
 */
export const BOOTSTRAP = `<script>(function(){
function announce(){parent.postMessage({type:'sm-boot-ready'},'*');}
if(document.readyState!=='loading'){announce();}else{document.addEventListener('DOMContentLoaded',announce);}
function onBoot(e){
if(e.source!==parent||!e.data||e.data.type!=='sm-boot'||!Array.isArray(e.data.scripts))return;
window.removeEventListener('message',onBoot);
e.data.scripts.forEach(function(s){
var el=document.createElement('script');
if(s.module)el.type='module';
el.textContent=s.code;
document.head.appendChild(el);
});
}
window.addEventListener('message',onBoot);
})();</script>`;

export interface BootScript { module: boolean; code: string }

/** Build the sandboxed document: CSS inlined, external scripts removed, bootstrap inserted. */
export function buildSrcDoc(html: string, css: Map<string, string>): string {
  let out = html.replace(/<link\b[^>]*rel=["']stylesheet["'][^>]*>/gi, (tag) => {
    const href = /href=["']([^"']+)["']/i.exec(tag)?.[1];
    const c = href ? css.get(base(href)) : undefined;
    return c === undefined ? '' : `<style>${c.replace(/<\/style/gi, '<\\/style')}</style>`;
  });
  out = out.replace(/<script\b[^>]*\bsrc=["'][^"']+["'][^>]*>\s*<\/script>/gi, '');
  if (/<\/head>/i.test(out)) return out.replace(/<\/head>/i, () => `${BOOTSTRAP}</head>`);
  if (/<body\b[^>]*>/i.test(out)) return out.replace(/<body\b[^>]*>/i, (m) => `${m}${BOOTSTRAP}`);
  return BOOTSTRAP + out;
}

// ── sm-ipc bridge ───────────────────────────────────────────────────────────

interface QueuedCall { id: unknown; channel: string; args: unknown[] }
interface Outbound { type: string; payload: unknown; id?: string }

/** Batches iframe sm-ipc traffic into ipc:* envelopes and routes replies/events back. */
export class IpcBridge {
  private calls: QueuedCall[] = [];
  private subAdd = new Set<string>();
  private subDel = new Set<string>();
  private subs = new Set<string>();
  private outbound: Outbound[] = [];
  private envs = new Map<string, unknown[]>();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private pumpTimer: ReturnType<typeof setTimeout> | null = null;
  private lastSend = -Infinity;
  private offs: Array<() => void> = [];
  private disposed = false;

  constructor(
    private socket: FrameSocket,
    private deviceId: string,
    private post: (msg: unknown) => void,
  ) {
    this.offs.push(
      listenResults(socket, (id, value) => this.onResult(id, value)),
      listenEvents(socket, (channel, payload) => this.post({ type: 'sm-ipc-event', channel, args: [payload] })),
      // A rekeyed session has lost its server-side subscriptions — replay them.
      socket.on('e2e:ready', () => {
        for (const c of this.subs) this.subAdd.add(c);
        this.scheduleFlush();
      }),
    );
  }

  /** Raw `message` event data from the iframe (source already verified by the caller). */
  handle(data: unknown): void {
    if (this.disposed || !data || typeof data !== 'object') return;
    const m = data as { type?: unknown; id?: unknown; channel?: unknown; args?: unknown };
    if (typeof m.channel !== 'string' || !m.channel) return;
    if (m.type === 'sm-ipc') {
      this.calls.push({ id: m.id, channel: m.channel, args: Array.isArray(m.args) ? m.args : [] });
    } else if (m.type === 'sm-ipc-subscribe') {
      this.subs.add(m.channel);
      this.subDel.delete(m.channel);
      this.subAdd.add(m.channel);
    } else if (m.type === 'sm-ipc-unsubscribe') {
      this.subs.delete(m.channel);
      this.subAdd.delete(m.channel);
      this.subDel.add(m.channel);
    } else return;
    this.scheduleFlush();
  }

  dispose(): void {
    this.disposed = true;
    if (this.flushTimer) clearTimeout(this.flushTimer);
    if (this.pumpTimer) clearTimeout(this.pumpTimer);
    for (const off of this.offs) off();
  }

  private scheduleFlush(): void {
    if (this.flushTimer || this.disposed) return;
    this.flushTimer = setTimeout(() => { this.flushTimer = null; this.flush(); }, FLUSH_MS);
  }

  private flush(): void {
    if (this.subAdd.size) this.outbound.push({ type: 'ipc:subscribe', payload: { channels: [...this.subAdd] } });
    if (this.subDel.size) this.outbound.push({ type: 'ipc:unsubscribe', payload: { channels: [...this.subDel] } });
    this.subAdd.clear();
    this.subDel.clear();
    while (this.calls.length) {
      const batch = this.calls.splice(0, MAX_CALLS_PER_ENVELOPE);
      const id = crypto.randomUUID();
      this.envs.set(id, batch.map((c) => c.id));
      this.outbound.push({
        id,
        type: 'ipc:invoke',
        payload: { calls: batch.map((c) => ({ channel: c.channel, args: c.args })) },
      });
    }
    this.pump();
  }

  private pump(): void {
    if (this.pumpTimer || this.disposed) return;
    const next = this.outbound[0];
    if (!next) return;
    const wait = this.lastSend + MIN_SEND_GAP_MS - Date.now();
    if (wait > 0) {
      this.pumpTimer = setTimeout(() => { this.pumpTimer = null; this.pump(); }, wait);
      return;
    }
    this.outbound.shift();
    this.lastSend = Date.now();
    this.socket.sendEnvelope(next.type, this.deviceId, next.payload, next.id).then(
      (sent) => { if (!sent && next.id) this.failEnv(next.id, 'not connected'); },
      (e) => { if (next.id) this.failEnv(next.id, e instanceof Error ? e.message : String(e)); },
    );
    this.pump();
  }

  private failEnv(envId: string, error: string): void {
    const ids = this.envs.get(envId);
    this.envs.delete(envId);
    ids?.forEach((id) => this.post({ type: 'sm-ipc-result', id, error }));
  }

  private onResult(resultId: string, value: unknown): void {
    const dot = resultId.lastIndexOf('.');
    if (dot < 0) return;
    const ids = this.envs.get(resultId.slice(0, dot));
    if (!ids) return;
    const idx = Number(resultId.slice(dot + 1));
    if (!Number.isInteger(idx) || idx < 0 || idx >= ids.length) return;
    const v = value as { ok?: boolean; result?: unknown; error?: unknown } | null;
    if (v?.ok) this.post({ type: 'sm-ipc-result', id: ids[idx], result: v.result });
    else this.post({ type: 'sm-ipc-result', id: ids[idx], error: typeof v?.error === 'string' ? v.error : 'rejected' });
    if (idx === ids.length - 1) this.envs.delete(resultId.slice(0, dot));
  }
}

// ── component ───────────────────────────────────────────────────────────────

type State =
  | { kind: 'loading' }
  | { kind: 'fallback' }
  | { kind: 'refused'; file: string }
  | { kind: 'ready'; srcDoc: string };

interface Props {
  socket: FrameSocket | null;
  deviceId: string;
  /** Drill-down shown when the desktop reports available:false (or predates asset:*). */
  fallback: ReactNode;
}

export default function RemoteRenderer({ socket, deviceId, fallback }: Props) {
  const capable = !!socket && typeof socket.sendEnvelope === 'function' && typeof socket.on === 'function';
  const [state, setState] = useState<State>(capable ? { kind: 'loading' } : { kind: 'fallback' });
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const scriptsRef = useRef<BootScript[]>([]);

  useEffect(() => {
    if (!capable || !socket) { setState({ kind: 'fallback' }); return; }
    let cancelled = false;
    scriptsRef.current = [];
    setState({ kind: 'loading' });
    (async () => {
      try {
        const manifest = await fetchAssetManifest(socket, deviceId);
        if (cancelled) return;
        const index = manifest.files.find((f) => f.name === 'index.html');
        if (!manifest.available || !index) { setState({ kind: 'fallback' }); return; }
        const html = dec.decode(await loadVerified(socket, deviceId, index));
        const byName = new Map(manifest.files.map((f) => [f.name, f]));
        const css = new Map<string, string>();
        for (const m of html.matchAll(/<link\b[^>]*rel=["']stylesheet["'][^>]*href=["']([^"']+)["']|<link\b[^>]*href=["']([^"']+)["'][^>]*rel=["']stylesheet["']/gi)) {
          const name = base(m[1] ?? m[2]);
          const f = byName.get(name);
          if (f) css.set(name, dec.decode(await loadVerified(socket, deviceId, f)));
        }
        const boot: BootScript[] = [];
        for (const m of html.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi)) {
          const name = base(m[1]);
          const f = byName.get(name);
          if (!f) continue;
          const bytes = await loadVerified(socket, deviceId, f);
          boot.push({ module: /type=["']module["']/i.test(m[0]), code: dec.decode(bytes) });
        }
        if (cancelled) return;
        scriptsRef.current = boot;
        setState({ kind: 'ready', srcDoc: buildSrcDoc(html, css) });
      } catch (e) {
        if (cancelled) return;
        if (e instanceof Error && e.name === 'HashMismatchError') setState({ kind: 'refused', file: (e as HashMismatchError).file });
        else setState({ kind: 'fallback' });
      }
    })();
    return () => { cancelled = true; };
  }, [socket, deviceId, capable]);

  const srcDoc = state.kind === 'ready' ? state.srcDoc : null;
  useEffect(() => {
    if (!srcDoc || !socket) return;
    const bridge = new IpcBridge(socket, deviceId, (msg) => iframeRef.current?.contentWindow?.postMessage(msg, '*'));
    const onMessage = (e: MessageEvent) => {
      const win = iframeRef.current?.contentWindow;
      if (!win || e.source !== win) return;
      if (e.data && (e.data as { type?: unknown }).type === 'sm-boot-ready') {
        win.postMessage({ type: 'sm-boot', scripts: scriptsRef.current }, '*');
        return;
      }
      bridge.handle(e.data);
    };
    window.addEventListener('message', onMessage);
    return () => { window.removeEventListener('message', onMessage); bridge.dispose(); };
  }, [srcDoc, socket, deviceId]);

  if (state.kind === 'fallback') return <>{fallback}</>;
  if (state.kind === 'refused') {
    return (
      <div role="alert" data-testid="renderer-refused" className="flex-1 flex items-center justify-center text-sm px-6 text-center">
        Refused to load your computer's interface: {state.file} failed its integrity check.
      </div>
    );
  }
  if (state.kind === 'loading') {
    return (
      <div data-testid="renderer-loading" className="flex-1 flex items-center justify-center text-ink-mute text-sm font-serif italic">
        Loading your computer's interface…
      </div>
    );
  }
  return (
    <iframe
      key={deviceId}
      ref={iframeRef}
      data-testid="remote-renderer"
      title="Session Manager"
      sandbox={IFRAME_SANDBOX}
      srcDoc={state.srcDoc}
      className="flex-1 w-full border-0"
    />
  );
}
