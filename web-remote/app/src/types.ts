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
  devicePubKey?: string; // SPKI DER base64url — agent's E2E public key (P-256)
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

export interface PairResponse {
  deviceToken: string;
  deviceId: string;
}

// ── WebSocket envelope (ARCHITECTURE.md §2.1) ─────────────────────────────────

export interface Envelope {
  type: string;
  id: string;
  deviceId?: string;
  payload?: unknown;
  ts: number;
  relay_ts?: number;
  // Extra top-level fields used by specific event types (e.g. event:device:status)
  status?: string;
}

// ── Scheduler types ───────────────────────────────────────────────────────────

export interface PrdMeta {
  slug: string;
  title?: string;
  status?: string;
  cwd?: string;
  estimateMinutes?: number;
}

export interface SchedulerState {
  mode: 'manual' | 'on-reset' | 'when-available';
  running: boolean;
  queue: PrdMeta[];
  activeJob?: PrdMeta;
}

// ── Session types ─────────────────────────────────────────────────────────────

export interface SessionRecord {
  tabId: string;
  cwd?: string;
  startedAt?: number;
}

// ── App navigation state ──────────────────────────────────────────────────────

export type Screen =
  | { kind: 'login' }
  | { kind: 'devices' }
  | { kind: 'pairing' }
  | { kind: 'device'; deviceId: string; tab: 'terminal' | 'scheduler' | 'sessions' };
