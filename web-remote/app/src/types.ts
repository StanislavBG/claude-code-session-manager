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

export interface SessionMeta {
  tabId: string;           // === claudeSessionId (transcript lookup key)
  cwd?: string;
  title?: string;
  state?: SessionState | null;
}

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
