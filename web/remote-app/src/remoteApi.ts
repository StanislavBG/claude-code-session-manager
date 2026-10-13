import type { RelaySocket } from './ws';
import type {
  ChatMessage,
  ProjectSessionsResponse,
  RemoteProject,
  SessionPrd,
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

export function getTranscript(
  socket: CommandSocket,
  deviceId: string,
  args: { cwd: string; sessionKey: string; limit?: number },
) {
  return call<{ messages: ChatMessage[] }>(socket, deviceId, 'cmd:session:transcript', args);
}

export function listSessionPrds(
  socket: CommandSocket,
  deviceId: string,
  args: { cwd: string; epicId: string },
) {
  return call<{ prds: SessionPrd[] }>(socket, deviceId, 'cmd:session:prds', args);
}

/** `target` is the epicId for Epics, or mainTabId for a project's main session — never claudeSessionId. */
export function sendChat(
  socket: CommandSocket,
  deviceId: string,
  args: { target: string; prompt: string },
) {
  return call<unknown>(socket, deviceId, 'cmd:chat:send', {
    tabId: args.target,
    prompt: args.prompt,
  });
}
