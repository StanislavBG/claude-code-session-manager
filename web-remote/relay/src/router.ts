import crypto from 'node:crypto';
import { z } from 'zod';
import WebSocket, { WebSocketServer } from 'ws';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type { BrowserConn, DeviceConn, Envelope, LeakyBucket } from './types';
import { consumeWsTicket } from './tokens';

// ── Constants ──────────────────────────────────────────────────────────────

const MAX_MSG_BYTES = 256 * 1024;                      // 256 KiB (§2.5)
const PING_INTERVAL_MS = 30_000;                       // 30 s (§2.3)
const PONG_TIMEOUT_MS = 10_000;                        // 10 s (§2.3)
const MAX_MISSED_PINGS = 3;                            // close after 3 (§2.3)
// Browser: 60 cmd/min → drain 1 per 1000 ms
const BROWSER_RATE_CAPACITY = 60;
const BROWSER_RATE_DRAIN_MS = 1000;
// Device: 100 cmd/min → drain 1 per 600 ms
const DEVICE_RATE_CAPACITY = 100;
const DEVICE_RATE_DRAIN_MS = 600;

// ── Envelope schema ────────────────────────────────────────────────────────

const envelopeSchema = z.object({
  type: z.string().min(1),
  id: z.string().uuid(),
  deviceId: z.string().optional(),
  payload: z.unknown().optional(),
  ts: z.number().int().positive(),
});

// ── Live connection registries ─────────────────────────────────────────────

const browserConns = new Map<string, BrowserConn>();  // connId → conn
const deviceConns = new Map<string, DeviceConn>();    // deviceId → conn

// ── Rate limiting (leaky bucket) ───────────────────────────────────────────

function makeBucket(capacity: number, drainRateMs: number): LeakyBucket {
  return { tokens: 0, lastCheck: Date.now(), capacity, drainRateMs };
}

/** Returns true if the command is allowed, false if rate-limited. */
export function consumeRateLimit(bucket: LeakyBucket, now = Date.now()): boolean {
  const elapsed = now - bucket.lastCheck;
  bucket.tokens = Math.max(0, bucket.tokens - elapsed / bucket.drainRateMs);
  bucket.lastCheck = now;
  if (bucket.tokens >= bucket.capacity) return false;
  bucket.tokens++;
  return true;
}

export function retryAfterMs(bucket: LeakyBucket, now = Date.now()): number {
  const excessTokens = bucket.tokens + 1 - bucket.capacity;
  return Math.ceil(Math.max(0, excessTokens) * bucket.drainRateMs);
}

// ── Routing decision (pure, testable) ─────────────────────────────────────

/**
 * Determines whether a browser connection may send commands to a device.
 * SECURITY INVARIANT: userId is derived from the authenticated session record,
 * never from the deviceId field in the message envelope (§2.2).
 */
export function canRoute(browser: Pick<BrowserConn, 'userId'>, device: Pick<DeviceConn, 'userId'>): boolean {
  return browser.userId === device.userId;
}

// ── Send helpers ───────────────────────────────────────────────────────────

function safeSend(ws: WebSocket, data: unknown): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

function sendError(ws: WebSocket, code: string, retryAfterMs?: number): void {
  const msg: Record<string, unknown> = { type: 'error', code };
  if (retryAfterMs !== undefined) msg.retryAfterMs = retryAfterMs;
  safeSend(ws, msg);
}

// ── Message routing ────────────────────────────────────────────────────────

function routeFromBrowser(browser: BrowserConn, envelope: Envelope): void {
  const { type, deviceId } = envelope;

  // Pass-through ping responses and pong frames
  if (type === 'pong') return; // handled by heartbeat

  if (!deviceId) {
    sendError(browser.ws, 'missing_device_id');
    return;
  }

  const device = deviceConns.get(deviceId);
  if (!device) {
    sendError(browser.ws, 'device_offline');
    return;
  }

  // SECURITY INVARIANT: userId from session, not from envelope (§2.2)
  if (!canRoute(browser, device)) {
    sendError(browser.ws, 'not_your_device');
    return;
  }

  // Check browser session rate limit
  if (!consumeRateLimit(browser.rateLimit)) {
    sendError(browser.ws, 'rate_limited', retryAfterMs(browser.rateLimit));
    return;
  }

  // Check device connection rate limit
  if (!consumeRateLimit(device.rateLimit)) {
    sendError(browser.ws, 'rate_limited', retryAfterMs(device.rateLimit));
    return;
  }

  const forwarded: Envelope = { ...envelope, relay_ts: Date.now() };
  safeSend(device.ws, forwarded);
}

function routeFromDevice(device: DeviceConn, envelope: Envelope): void {
  const { type } = envelope;
  if (type === 'pong') return;

  // Forward to all browser sessions belonging to the same user
  for (const browser of browserConns.values()) {
    if (browser.userId === device.userId) {
      const forwarded: Envelope = { ...envelope, deviceId: device.deviceId, relay_ts: Date.now() };
      safeSend(browser.ws, forwarded);
    }
  }
}

function handleMessage(
  conn: BrowserConn | DeviceConn,
  role: 'browser' | 'agent',
  raw: Buffer | ArrayBuffer | Buffer[],
): void {
  const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as ArrayBuffer);

  if (buf.byteLength > MAX_MSG_BYTES) {
    conn.ws.close(1009, 'message_too_large');
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(buf.toString('utf8'));
  } catch {
    sendError(conn.ws, 'invalid_json');
    return;
  }

  const result = envelopeSchema.safeParse(parsed);
  if (!result.success) {
    sendError(conn.ws, 'invalid_envelope');
    return;
  }

  const envelope = result.data as Envelope;

  if (role === 'browser') {
    routeFromBrowser(conn as BrowserConn, envelope);
  } else {
    routeFromDevice(conn as DeviceConn, envelope);
  }
}

// ── Heartbeat ──────────────────────────────────────────────────────────────

function setupHeartbeat(ws: WebSocket, conn: BrowserConn | DeviceConn): void {
  ws.on('pong', () => {
    conn.isAlive = true;
    conn.missedPings = 0;
  });
}

let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

function startHeartbeat(): void {
  if (heartbeatTimer) return;
  heartbeatTimer = setInterval(() => {
    const allConns: Array<BrowserConn | DeviceConn> = [
      ...browserConns.values(),
      ...deviceConns.values(),
    ];
    for (const conn of allConns) {
      if (!conn.isAlive) {
        conn.missedPings++;
        if (conn.missedPings >= MAX_MISSED_PINGS) {
          conn.ws.close(1001, 'heartbeat_timeout');
          continue;
        }
      }
      conn.isAlive = false;
      if (conn.ws.readyState === WebSocket.OPEN) {
        conn.ws.ping();
      }
    }
  }, PING_INTERVAL_MS);
}

// ── Connection registration ────────────────────────────────────────────────

function registerBrowser(ws: WebSocket, ticketData: { userId: string; email: string }): void {
  const id = crypto.randomUUID();
  const conn: BrowserConn = {
    ws,
    id,
    userId: ticketData.userId,
    email: ticketData.email,
    connectedAt: Date.now(),
    isAlive: true,
    missedPings: 0,
    rateLimit: makeBucket(BROWSER_RATE_CAPACITY, BROWSER_RATE_DRAIN_MS),
  };
  browserConns.set(id, conn);
  setupHeartbeat(ws, conn);

  safeSend(ws, { type: 'auth:ok' });

  ws.on('message', (data) => handleMessage(conn, 'browser', data as Buffer));
  ws.on('close', () => {
    browserConns.delete(id);
    if (browserConns.size === 0 && deviceConns.size === 0) stopHeartbeat();
  });
  ws.on('error', () => ws.close());

  startHeartbeat();
}

function registerDevice(
  ws: WebSocket,
  ticketData: { userId: string; email: string; deviceId: string },
): void {
  const conn: DeviceConn = {
    ws,
    deviceId: ticketData.deviceId,
    userId: ticketData.userId,
    email: ticketData.email,
    connectedAt: Date.now(),
    isAlive: true,
    missedPings: 0,
    rateLimit: makeBucket(DEVICE_RATE_CAPACITY, DEVICE_RATE_DRAIN_MS),
  };
  deviceConns.set(ticketData.deviceId, conn);
  setupHeartbeat(ws, conn);

  safeSend(ws, { type: 'auth:ok', deviceId: ticketData.deviceId });

  // Notify all browser sessions for this user that the device is connected
  for (const browser of browserConns.values()) {
    if (browser.userId === ticketData.userId) {
      safeSend(browser.ws, {
        type: 'event:device:status',
        deviceId: ticketData.deviceId,
        status: 'connected',
        ts: Date.now(),
      });
    }
  }

  ws.on('message', (data) => handleMessage(conn, 'agent', data as Buffer));
  ws.on('close', () => {
    deviceConns.delete(ticketData.deviceId);
    // Notify browsers of disconnect
    for (const browser of browserConns.values()) {
      if (browser.userId === ticketData.userId) {
        safeSend(browser.ws, {
          type: 'event:device:status',
          deviceId: ticketData.deviceId,
          status: 'disconnected',
          ts: Date.now(),
        });
      }
    }
    if (browserConns.size === 0 && deviceConns.size === 0) stopHeartbeat();
  });
  ws.on('error', () => ws.close());

  startHeartbeat();
}

// ── Session eviction (called from auth.ts on logout) ──────────────────────

/**
 * Close all active browser WS connections for the given userId.
 * Called on POST /api/logout so stale browser tabs stop receiving PTY events.
 */
export function closeSessionsForUser(userId: string): void {
  for (const [id, conn] of browserConns) {
    if (conn.userId === userId && conn.ws.readyState === WebSocket.OPEN) {
      conn.ws.close(1000, 'logged_out');
      browserConns.delete(id);
    }
  }
}

// ── Online status query (called from auth.ts) ──────────────────────────────

/** Returns true if the given device has an open, authenticated WS connection. */
export function isDeviceOnline(deviceId: string): boolean {
  const conn = deviceConns.get(deviceId);
  return conn !== undefined && conn.ws.readyState === WebSocket.OPEN;
}

// ── Revocation callback (called from auth.ts) ──────────────────────────────

/** Close an active device WS connection after token revocation. */
export function notifyDeviceRevoked(deviceId: string): void {
  const conn = deviceConns.get(deviceId);
  if (conn && conn.ws.readyState === WebSocket.OPEN) {
    // 4001 = token revoked; agent must not reconnect (§4.1)
    conn.ws.close(4001, 'token_revoked');
  }
}

// ── WebSocket server ───────────────────────────────────────────────────────

let wss: WebSocketServer | null = null;

export function createWsServer(): WebSocketServer {
  wss = new WebSocketServer({ noServer: true });
  wss.on('connection', (_ws, _req) => {
    // Handled inside handleUpgrade — this event is never used directly
  });
  return wss;
}

export function handleUpgrade(
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
): void {
  if (!wss) throw new Error('WS server not created');

  const reqUrl = req.url ?? '';
  let ticket: string | null = null;
  try {
    const u = new URL(reqUrl, 'http://localhost');
    if (u.pathname !== '/ws') {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    ticket = u.searchParams.get('ticket');
  } catch {
    socket.destroy();
    return;
  }

  if (!ticket) {
    socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }

  const ticketData = consumeWsTicket(ticket);
  if (!ticketData) {
    socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket as import('node:net').Socket, head, (ws) => {
    if (ticketData.role === 'browser') {
      registerBrowser(ws, ticketData);
    } else {
      if (!ticketData.deviceId) {
        ws.close(1011, 'missing_device_id');
        return;
      }
      registerDevice(ws, { ...ticketData, deviceId: ticketData.deviceId });
    }
  });
}

function stopHeartbeat(): void {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

// Exported for testing
export { browserConns, deviceConns };
