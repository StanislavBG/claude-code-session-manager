import type { RelaySocket } from './ws';
import type {
  ChatMessage,
  ProjectSessionsResponse,
  RemoteProject,
  SendChatResult,
  SessionPrd,
  TranscriptPage,
} from './types';

type CommandSocket = Pick<RelaySocket, 'sendCommand'>;

export const REFUSED_MESSAGE =
  'Your computer refused this request. Confirm the 6-digit code in Session Manager (Settings → Phone remote), enable remote control for sending, or update Session Manager to the latest version.';

export class RemoteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RemoteError';
  }
}

async function call<T>(
  socket: CommandSocket,
  deviceId: string,
  type: string,
  payload?: unknown,
): Promise<T> {
  let resp;
  try {
    resp = await socket.sendCommand(type, deviceId, payload);
  } catch (e) {
    throw new RemoteError(e instanceof Error ? e.message : String(e));
  }
  const p = resp?.payload as { error?: unknown } | null | undefined;
  if (p && typeof p === 'object' && p.error) throw new RemoteError(REFUSED_MESSAGE);
  return resp.payload as T;
}

export function listProjects(socket: CommandSocket, deviceId: string) {
  return call<{ projects: RemoteProject[] }>(socket, deviceId, 'cmd:projects:list');
}

export function listProjectSessions(socket: CommandSocket, deviceId: string, cwd: string) {
  return call<ProjectSessionsResponse>(socket, deviceId, 'cmd:project:sessions', { cwd });
}

export async function getTranscript(
  socket: CommandSocket,
  deviceId: string,
  args: { cwd: string; sessionKey: string; limit?: number; before?: number },
): Promise<TranscriptPage> {
  const payload: typeof args = { ...args };
  if (payload.before === undefined) delete payload.before;
  const r = await call<{
    messages?: ChatMessage[];
    hasMore?: unknown;
    nextBefore?: unknown;
  } | null>(socket, deviceId, 'cmd:session:transcript', payload);
  return {
    messages: r?.messages ?? [],
    hasMore: r?.hasMore === true,
    nextBefore: typeof r?.nextBefore === 'number' ? r.nextBefore : null,
  };
}

export function listSessionPrds(
  socket: CommandSocket,
  deviceId: string,
  args: { cwd: string; epicId: string },
) {
  return call<{ prds: SessionPrd[] }>(socket, deviceId, 'cmd:session:prds', args);
}

export interface AppInfo {
  version: string | null;
  platform: string | null;
  hostname: string | null;
}

/** Older desktops return no hostname (or reject) — callers keep the fallback label. */
export async function getAppInfo(socket: CommandSocket, deviceId: string): Promise<AppInfo> {
  const r = await call<Partial<Record<keyof AppInfo, unknown>> | null>(socket, deviceId, 'cmd:app:info');
  const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
  return { version: str(r?.version), platform: str(r?.platform), hostname: str(r?.hostname) };
}

/** Copy shown to the phone user when the desktop refuses a send. */
export function refusalMessage(reason?: string): string {
  switch (reason) {
    case 'terminal-attached':
      return 'This session is open in Terminal mode on your computer. Switch it back to Chat there to reply from your phone.';
    case 'proposed':
      return 'This session has not started yet. Approve it on your computer first.';
    case 'not-active':
    case 'completed':
      return 'This session is completed, so it cannot take new messages. Start a new session instead.';
    case 'unknown-target':
      return 'Your computer no longer has this session open. Go back and refresh the list.';
    case 'empty-prompt':
      return 'Type a message first.';
    default:
      return 'Your computer did not accept this message.';
  }
}

/** `target` is the epicId for Epics, or mainTabId for a project's main session — never claudeSessionId. */
export async function sendChat(
  socket: CommandSocket,
  deviceId: string,
  args: { target: string; prompt: string },
): Promise<SendChatResult> {
  const r = await call<{ disposition?: string; reason?: string } | null>(
    socket,
    deviceId,
    'cmd:chat:send',
    { tabId: args.target, prompt: args.prompt },
  );
  const d = r?.disposition;
  if (d === 'refused') throw new RemoteError(refusalMessage(r?.reason));
  if (d === 'sent' || d === 'queued' || d === 'unconfirmed') {
    return { disposition: d, reason: r?.reason };
  }
  return { disposition: 'unconfirmed' };
}

// ── Desktop-served renderer transport (asset:* / ipc:*) ─────────────────────

export interface FrameSocket {
  on: RelaySocket['on'];
  sendEnvelope: RelaySocket['sendEnvelope'];
}

export interface Frame { seq: number; total: number; data: string }

/** Accumulates ordered chunk frames under a key; returns the parsed value once complete. */
export class FrameJoiner {
  private parts = new Map<string, Frame[]>();
  push(key: string, f: Frame): { value: unknown } | null {
    if (f.seq === 0) this.parts.set(key, []);
    const arr = this.parts.get(key);
    if (!arr) return null;
    arr.push(f);
    if (arr.length < f.total) return null;
    this.parts.delete(key);
    try {
      return { value: JSON.parse(arr.sort((a, b) => a.seq - b.seq).map((x) => x.data).join('')) };
    } catch {
      return { value: { ok: false, error: 'bad-frames' } };
    }
  }
}

function frameOf(m: { seq?: unknown; total?: unknown; data?: unknown }): Frame | null {
  if (typeof m.seq !== 'number' || typeof m.total !== 'number' || typeof m.data !== 'string') return null;
  return { seq: m.seq, total: m.total, data: m.data };
}

/** Subscribe to chunked ipc:result frames; `onValue(id, value)` fires per complete reply. */
export function listenResults(socket: FrameSocket, onValue: (id: string, value: unknown) => void): () => void {
  const joiner = new FrameJoiner();
  return socket.on('ipc:result', (env) => {
    const f = frameOf(env as unknown as Record<string, unknown>);
    if (!f || typeof env.id !== 'string') return;
    const done = joiner.push(env.id, f);
    if (done) onValue(env.id, done.value);
  });
}

/** Subscribe to chunked ipc:event frames; `onEvent(channel, payload)` fires per complete event. */
export function listenEvents(socket: FrameSocket, onEvent: (channel: string, payload: unknown) => void): () => void {
  const joiner = new FrameJoiner();
  return socket.on('ipc:event', (env) => {
    const m = env as unknown as Record<string, unknown>;
    const f = frameOf(m);
    if (!f || typeof m.channel !== 'string') return;
    const done = joiner.push(m.channel, f);
    if (done) onEvent(m.channel, done.value);
  });
}

async function requestFramed(
  socket: FrameSocket,
  deviceId: string,
  type: string,
  payload?: unknown,
  timeoutMs = 15_000,
): Promise<unknown> {
  const id = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    let off = () => {};
    const timer = setTimeout(() => { off(); reject(new RemoteError(`timeout waiting for ${type}`)); }, timeoutMs);
    off = listenResults(socket, (rid, value) => {
      if (rid !== id) return;
      clearTimeout(timer);
      off();
      resolve(value);
    });
    socket.sendEnvelope(type, deviceId, payload, id).then((sent) => {
      if (!sent) { clearTimeout(timer); off(); reject(new RemoteError('not connected')); }
    }, (e) => { clearTimeout(timer); off(); reject(new RemoteError(e instanceof Error ? e.message : String(e))); });
  });
}

export interface AssetFile { name: string; size: number; sha256: string; type: string }
export interface AssetManifest { available: boolean; version: string | null; files: AssetFile[] }

export async function fetchAssetManifest(socket: FrameSocket, deviceId: string): Promise<AssetManifest> {
  const r = (await requestFramed(socket, deviceId, 'asset:manifest')) as { ok?: boolean; result?: Partial<AssetManifest> } | null;
  if (!r?.ok || !r.result) throw new RemoteError('asset manifest refused');
  return {
    available: r.result.available === true,
    version: typeof r.result.version === 'string' ? r.result.version : null,
    files: Array.isArray(r.result.files) ? r.result.files : [],
  };
}

/** Returns the raw bytes of one asset (sha256 verification is the caller's job). */
export async function fetchAssetBytes(socket: FrameSocket, deviceId: string, name: string): Promise<Uint8Array> {
  const r = (await requestFramed(socket, deviceId, 'asset:get', { name })) as
    { ok?: boolean; result?: { data?: string } } | null;
  if (!r?.ok || typeof r.result?.data !== 'string') throw new RemoteError(`asset ${name} refused`);
  const bin = atob(r.result.data);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
