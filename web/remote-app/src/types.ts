// ── Relay REST types ──────────────────────────────────────────────────────────

export interface MeResponse {
  userId: string;
  email: string;
}

export interface Device {
  deviceId: string;
  email: string;
  issuedAt: number;
  isOnline: boolean;
  devicePubKey?: string;
}

export interface DevicesResponse {
  devices: Device[];
}

export interface OtpResponse {
  code: string;
}

export interface ClientOtpResponse {
  code: string;
}

export interface DesktopClient {
  clientId: string;
  email: string;
  clientName: string | null;
  issuedAt: string;
  /** null = never expires (relay keeps tokens until revoked). */
  expiresAt: string | null;
}

export interface ClientsResponse {
  clients: DesktopClient[];
}

export interface WsTicketResponse {
  ticket: string;
}

// ── WebSocket envelope ────────────────────────────────────────────────────────

export interface Envelope {
  type: string;
  id: string;
  deviceId?: string;
  payload?: unknown;
  ts: number;
  relay_ts?: number;
  status?: string;
}

// ── Session model (v2 mobile) ─────────────────────────────────────────────────

export type SessionState =
  | 'idle'
  | 'thinking'
  | 'running'
  | 'awaiting-input'
  | 'error'
  | 'unknown';

export interface SessionSummary {
  tabId: string;
  summary: string;
  ofMessageId?: string;
  model?: string;          // 'claude-haiku-4-5' | 'raw'
  degraded?: string;       // 'no_api_key' | 'api_error'
  ts: number;
}

// ── App navigation state ──────────────────────────────────────────────────────

export type Screen =
  | { kind: 'login' }
  | { kind: 'connect' }    // signed in, choosing/pairing a device
  | { kind: 'cockpit' };   // paired device online — session cockpit

// ── Drill-down model (projects → sessions → transcript) ──────────────────────

export interface RemoteProject {
  cwd: string;
  title: string;
  mainTabId: string;
  counts: { proposed: number; active: number; completed: number };
}

export interface RemoteSession {
  epicId: string;
  claudeSessionId: string;
  title: string;
  status: string;
  tag?: string;
  agentType?: string;
  spawnCwd: string;
  updatedAt: number;
}

export interface ProjectSessionsResponse {
  project: RemoteProject;
  sessions: RemoteSession[];
}

export interface ChatMessage {
  role: string;
  text: string;
  ts: number;
  uuid: string;
}

export interface SessionPrd {
  slug: string;
  title: string;
  status: string;
}
