import type WebSocket from 'ws';

// ── Message envelope (§2.1) ────────────────────────────────────────────────

export interface Envelope {
  type: string;
  id: string;          // UUID v4
  deviceId?: string;   // browser→device: target; device→browser: source
  payload?: unknown;
  ts: number;          // client-generated unix ms; relay adds relay_ts
  relay_ts?: number;   // stamped by relay before forwarding
}

// ── In-process stores ──────────────────────────────────────────────────────

export interface OtpEntry {
  code: string;
  userId: string;
  email: string;
  expiresAt: number;  // unix ms
}

export interface DeviceTokenEntry {
  token: string;
  deviceId: string;
  userId: string;
  email: string;
  issuedAt: number;   // unix ms
  revoked: boolean;
}

export interface WsTicketEntry {
  userId: string;
  email: string;
  role: 'browser' | 'agent';
  deviceId?: string;  // only for agent tickets
  expiresAt: number;  // unix ms
}

// ── Rate limiting (leaky bucket) ───────────────────────────────────────────

export interface LeakyBucket {
  tokens: number;      // current fill level
  lastCheck: number;   // unix ms
  capacity: number;
  drainRateMs: number; // ms per token drained
}

// ── Live WebSocket connections ─────────────────────────────────────────────

export interface BrowserConn {
  ws: WebSocket;
  id: string;          // random connection ID
  userId: string;
  email: string;
  connectedAt: number; // unix ms
  isAlive: boolean;    // ws-level ping/pong liveness
  missedPings: number; // consecutive unanswered pings
  rateLimit: LeakyBucket;
}

export interface DeviceConn {
  ws: WebSocket;
  deviceId: string;
  userId: string;
  email: string;
  connectedAt: number;
  isAlive: boolean;
  missedPings: number;
  rateLimit: LeakyBucket;
}
