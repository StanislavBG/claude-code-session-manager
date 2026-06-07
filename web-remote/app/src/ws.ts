import { getWsTicket, WSS_URL } from './api';
import type { Envelope } from './types';

type EventHandler = (envelope: Envelope) => void;
type RespHandler = (envelope: Envelope) => void;

interface PendingCmd {
  resolve: RespHandler;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

// Command response timeout
const CMD_TIMEOUT_MS = 15_000;
// Heartbeat interval
const PING_INTERVAL_MS = 30_000;

export class RelaySocket {
  private ws: WebSocket | null = null;
  private listeners = new Map<string, Set<EventHandler>>();
  private pending = new Map<string, PendingCmd>();
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private destroyed = false;

  // Reconnect state
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private backoffMs = 1_000;
  private authFailures = 0;
  private static readonly MAX_AUTH_FAILURES = 3;

  constructor(private readonly onStatusChange?: (connected: boolean) => void) {}

  async connect(): Promise<void> {
    if (this.destroyed) return;
    try {
      let ticket: string;
      try {
        ({ ticket } = await getWsTicket());
        this.authFailures = 0; // reset on successful ticket fetch
      } catch (e) {
        this.authFailures++;
        // Stop retrying after repeated auth failures to avoid hammering a
        // 401 endpoint (e.g. session expired)
        if (this.authFailures >= RelaySocket.MAX_AUTH_FAILURES) {
          this.onStatusChange?.(false);
          this.emit('auth:fail', { type: 'auth:fail', id: '', ts: Date.now() });
          return;
        }
        throw e;
      }
      const url = `${WSS_URL}/ws?ticket=${encodeURIComponent(ticket)}`;
      const socket = new WebSocket(url);
      this.ws = socket;

      socket.onopen = () => {
        this.backoffMs = 1_000;
      };

      socket.onmessage = (evt) => {
        let msg: Envelope;
        try {
          msg = JSON.parse(evt.data as string) as Envelope;
        } catch {
          return;
        }
        this.dispatch(msg);
      };

      socket.onclose = (evt) => {
        this.ws = null;
        this.stopPing();
        this.onStatusChange?.(false);
        // 4001 = token revoked; don't reconnect
        if (evt.code === 4001 || this.destroyed) return;
        this.scheduleReconnect();
      };

      socket.onerror = () => {
        socket.close();
      };
    } catch {
      if (!this.destroyed) this.scheduleReconnect();
    }
  }

  private dispatch(msg: Envelope): void {
    const { type } = msg;

    if (type === 'auth:ok') {
      this.onStatusChange?.(true);
      this.startPing();
      this.emit('auth:ok', msg);
      return;
    }

    if (type === 'auth:fail') {
      this.ws?.close(1008, 'auth_fail');
      return;
    }

    // Response to a command: type is "resp:<uuid>"
    if (type.startsWith('resp:')) {
      const id = type.slice(5);
      const pending = this.pending.get(id);
      if (pending) {
        clearTimeout(pending.timer);
        this.pending.delete(id);
        pending.resolve(msg);
      }
      return;
    }

    // Relay-level pong — reset server heartbeat tracking
    if (type === 'ping') {
      this.sendRaw({ type: 'pong', id: msg.id, ts: Date.now() });
      return;
    }

    this.emit(type, msg);
  }

  on(type: string, handler: EventHandler): () => void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(handler);
    return () => set!.delete(handler);
  }

  private emit(type: string, msg: Envelope): void {
    const set = this.listeners.get(type);
    if (set) {
      for (const handler of set) handler(msg);
    }
    // Wildcard listeners
    const all = this.listeners.get('*');
    if (all) {
      for (const handler of all) handler(msg);
    }
  }

  sendCommand(
    type: string,
    deviceId: string,
    payload?: unknown,
  ): Promise<Envelope> {
    const id = crypto.randomUUID();
    const envelope: Envelope = { type, id, deviceId, payload, ts: Date.now() };

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`timeout waiting for resp:${id}`));
      }, CMD_TIMEOUT_MS);

      this.pending.set(id, { resolve, reject, timer });

      if (!this.sendRaw(envelope)) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new Error('not connected'));
      }
    });
  }

  sendRaw(msg: unknown): boolean {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
      return true;
    }
    return false;
  }

  private startPing(): void {
    this.stopPing();
    this.pingTimer = setInterval(() => {
      this.sendRaw({ type: 'ping', id: crypto.randomUUID(), ts: Date.now() });
    }, PING_INTERVAL_MS);
  }

  private stopPing(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    const jitter = 1 + (Math.random() * 0.4 - 0.2);
    const delay = Math.min(this.backoffMs * jitter, 60_000);
    this.backoffMs = Math.min(this.backoffMs * 2, 60_000);
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      await this.connect();
    }, delay);
  }

  get isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  destroy(): void {
    this.destroyed = true;
    this.stopPing();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    for (const { timer, reject } of this.pending.values()) {
      clearTimeout(timer);
      reject(new Error('socket destroyed'));
    }
    this.pending.clear();
    this.ws?.close();
  }
}
