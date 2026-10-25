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
