import { getWsTicket, RELAY_WSS_URL } from './api';
import type { Envelope } from './types';

type EventHandler = (envelope: Envelope) => void;
type RespHandler = (envelope: Envelope) => void;

interface PendingCmd {
  resolve: RespHandler;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

// E2E session state per device (browser-side P-256 ECDH + AES-256-GCM)
interface E2ESession {
  privateKey: CryptoKey;        // browser's ephemeral P-256 private key
  browserPubKeyB64: string;     // browser's SPKI DER public key, base64url
  devicePubKeyB64: string;      // agent's SPKI DER public key, base64url
  sessionKey: CryptoKey | null; // derived AES-256-GCM key, null until e2e:ready
}

// Command response timeout
const CMD_TIMEOUT_MS = 15_000;
// Heartbeat interval
const PING_INTERVAL_MS = 30_000;

// ── WebCrypto E2E helpers ──────────────────────────────────────────────────

function base64urlToUint8(b64: string): Uint8Array<ArrayBuffer> {
  // Pad to multiple of 4, replace URL-safe chars
  const padded = b64.replace(/-/g, '+').replace(/_/g, '/');
  const pad = (4 - (padded.length % 4)) % 4;
  const padded2 = padded + '=='.slice(0, pad);
  const binary = atob(padded2);
  const ab = new ArrayBuffer(binary.length);
  const bytes = new Uint8Array(ab);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function uint8ToBase64url(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

async function generateBrowserKeyPair(): Promise<{ privateKey: CryptoKey; publicKeyB64: string }> {
  const keyPair = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    false, // private key non-extractable — stays in WebCrypto context
    ['deriveBits'],
  );
  const spkiDer = await crypto.subtle.exportKey('spki', keyPair.publicKey) as ArrayBuffer;
  return {
    privateKey: keyPair.privateKey,
    publicKeyB64: uint8ToBase64url(new Uint8Array(spkiDer)),
  };
}

/**
 * Derive a 6-digit Short Authentication String via HKDF with a separate info label.
 * Must produce the same value as deriveSas() in webRemote.cjs when given the same
 * ECDH inputs. User manually compares both ends; mismatch = MITM detected.
 */
async function deriveE2ESas(
  myPrivateKey: CryptoKey,
  peerPublicKeyB64: string,
  deviceId: string,
): Promise<string> {
  const peerKeyDer = base64urlToUint8(peerPublicKeyB64);
  const peerPublicKey = await crypto.subtle.importKey(
    'spki',
    peerKeyDer,
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    [],
  );
  const sharedBits = await crypto.subtle.deriveBits(
    { name: 'ECDH', public: peerPublicKey },
    myPrivateKey,
    256,
  );
  const hkdfMaterial = await crypto.subtle.importKey('raw', sharedBits, 'HKDF', false, ['deriveBits']);
  const enc = new TextEncoder();
  const sasBytes = new Uint8Array(await crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: enc.encode(deviceId),
      info: enc.encode('sm-sas-v1'),
    },
    hkdfMaterial,
    24, // 3 bytes → up to 16 777 215; take mod 1 000 000 for 6-digit display
  ));
  const sasNum = ((sasBytes[0] << 16) | (sasBytes[1] << 8) | sasBytes[2]) % 1_000_000;
  return sasNum.toString().padStart(6, '0');
}

/**
 * Derive an AES-256-GCM session key via ECDH + HKDF-SHA256.
 * Must match the agent's deriveSessionKey (webRemote.cjs):
 *   salt = Buffer.from(deviceId, 'utf8')
 *   info = Buffer.from('sm-e2e-v1', 'utf8')
 */
async function deriveE2ESessionKey(
  myPrivateKey: CryptoKey,
  peerPublicKeyB64: string,
  deviceId: string,
): Promise<CryptoKey> {
  const peerKeyDer = base64urlToUint8(peerPublicKeyB64);
  const peerPublicKey = await crypto.subtle.importKey(
    'spki',
    peerKeyDer,
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    [],
  );

  // ECDH → 256 bits of shared secret (x-coordinate of shared point)
  const sharedBits = await crypto.subtle.deriveBits(
    { name: 'ECDH', public: peerPublicKey },
    myPrivateKey,
    256,
  );

  // Import shared secret as HKDF key material
  const hkdfMaterial = await crypto.subtle.importKey(
    'raw',
    sharedBits,
    'HKDF',
    false,
    ['deriveKey'],
  );

  // HKDF-SHA256 → AES-256-GCM session key
  const enc = new TextEncoder();
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: enc.encode(deviceId),   // matches agent: Buffer.from(deviceId, 'utf8')
      info: enc.encode('sm-e2e-v1'), // matches agent: Buffer.from('sm-e2e-v1', 'utf8')
    },
    hkdfMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/**
 * Encrypt plaintext JSON string → { nonce, ciphertext } (both base64url).
 * WebCrypto AES-GCM appends the 16-byte auth tag to the output automatically.
 * Compatible with the agent's encryptBox/decryptBox in webRemote.cjs.
 */
async function encryptBox(
  plaintext: string,
  sessionKey: CryptoKey,
): Promise<{ nonce: string; ciphertext: string }> {
  const enc = new TextEncoder();
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce },
    sessionKey,
    enc.encode(plaintext),
  );
  return {
    nonce: uint8ToBase64url(nonce),
    ciphertext: uint8ToBase64url(new Uint8Array(encrypted)), // includes GCM auth tag
  };
}

/**
 * Decrypt an AES-256-GCM box. Returns null on auth failure or malformed input.
 * The ciphertext includes the 16-byte GCM auth tag appended at the end
 * (matching the agent's encryptBox format and WebCrypto's decrypt expectation).
 */
async function decryptBox(
  nonceB64: string,
  ciphertextB64: string,
  sessionKey: CryptoKey,
): Promise<string | null> {
  try {
    const nonce = base64urlToUint8(nonceB64);
    const data = base64urlToUint8(ciphertextB64);
    const decrypted = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: nonce },
      sessionKey,
      data,
    );
    return new TextDecoder().decode(decrypted);
  } catch {
    return null; // authentication tag mismatch or malformed input
  }
}

// ── RelaySocket ────────────────────────────────────────────────────────────

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

  // E2E sessions: deviceId → session state
  private e2eSessions = new Map<string, E2ESession>();

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
      const url = `${RELAY_WSS_URL}?ticket=${encodeURIComponent(ticket)}`;
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
        this.dispatchAsync(msg).catch((e) => {
          console.warn('[relay] dispatchAsync error', e);
        });
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

  /**
   * Initiate E2E key exchange with a specific device.
   * Generates an ephemeral P-256 keypair, stores state, and sends e2e:hello
   * if the WS is currently connected.
   *
   * Called by the app when navigating to a device view or when the device
   * comes online (event:device:status). After a successful e2e:ready response,
   * all commands sent via sendCommand to this deviceId are encrypted.
   */
  async initiateE2E(deviceId: string, devicePubKeyB64: string): Promise<void> {
    if (!devicePubKeyB64) return;

    // Re-use existing session if already established
    const existing = this.e2eSessions.get(deviceId);
    if (existing?.sessionKey) return;

    try {
      const { privateKey, publicKeyB64 } = await generateBrowserKeyPair();
      const session: E2ESession = {
        privateKey,
        browserPubKeyB64: publicKeyB64,
        devicePubKeyB64,
        sessionKey: null,
      };
      this.e2eSessions.set(deviceId, session);

      // Send hello immediately if connected; if not, auth:ok handler sends it
      if (this.isConnected) {
        this.sendRaw({
          type: 'e2e:hello',
          id: crypto.randomUUID(),
          deviceId,
          payload: { pubKey: publicKeyB64 },
          ts: Date.now(),
        });
      }
    } catch (e) {
      console.warn('[relay] E2E init failed', e);
    }
  }

  /** True if E2E session key is established for the given device. */
  hasE2E(deviceId: string): boolean {
    return this.e2eSessions.get(deviceId)?.sessionKey != null;
  }

  private async dispatchAsync(msg: Envelope): Promise<void> {
    const { type } = msg;

    // ── E2E decryption ─────────────────────────────────────────────────────
    // e2e:box: decrypt inner command/response and re-dispatch
    if (type === 'e2e:box') {
      const deviceId = msg.deviceId;
      if (!deviceId) return;
      const session = this.e2eSessions.get(deviceId);
      if (!session?.sessionKey) return;
      const p = msg.payload as { nonce?: string; ciphertext?: string } | undefined;
      if (!p?.nonce || !p.ciphertext) return;
      const plaintext = await decryptBox(p.nonce, p.ciphertext, session.sessionKey);
      if (!plaintext) {
        console.warn('[relay] e2e:box decryption failed (auth tag mismatch)');
        return;
      }
      let inner: Envelope;
      try { inner = JSON.parse(plaintext) as Envelope; } catch { return; }
      await this.dispatchAsync(inner);
      return;
    }

    // e2e:ready: derive session key and SAS using the device's stored public key
    if (type === 'e2e:ready') {
      const deviceId = msg.deviceId;
      if (!deviceId) return;
      const session = this.e2eSessions.get(deviceId);
      if (!session || session.sessionKey) return;
      try {
        session.sessionKey = await deriveE2ESessionKey(
          session.privateKey,
          session.devicePubKeyB64,
          deviceId,
        );
        this.emit('e2e:ready', { ...msg, deviceId });
        // Compute SAS for user verification — emitted as an internal event so
        // App.tsx can display it alongside the desktop's SAS for manual comparison.
        try {
          const sas = await deriveE2ESas(session.privateKey, session.devicePubKeyB64, deviceId);
          this.emit('sas:pending', {
            type: 'sas:pending',
            id: '',
            deviceId,
            payload: { sas },
            ts: Date.now(),
          });
        } catch (e) {
          console.warn('[relay] SAS derivation failed', e);
        }
      } catch (e) {
        console.warn('[relay] E2E session key derivation failed', e);
        this.e2eSessions.delete(deviceId);
      }
      return;
    }

    // ── Standard dispatch ──────────────────────────────────────────────────
    if (type === 'auth:ok') {
      this.onStatusChange?.(true);
      this.startPing();
      this.emit('auth:ok', msg);

      // Re-send e2e:hello for any pending sessions (device was online when
      // we reconnected but we had to regenerate the ticket)
      for (const [deviceId, session] of this.e2eSessions) {
        if (!session.sessionKey) {
          this.sendRaw({
            type: 'e2e:hello',
            id: crypto.randomUUID(),
            deviceId,
            payload: { pubKey: session.browserPubKeyB64 },
            ts: Date.now(),
          });
        }
      }
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

  async sendCommand(
    type: string,
    deviceId: string,
    payload?: unknown,
  ): Promise<Envelope> {
    const id = crypto.randomUUID();
    const inner: Envelope = { type, id, deviceId, payload, ts: Date.now() };

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`timeout waiting for resp:${id}`));
      }, CMD_TIMEOUT_MS);

      this.pending.set(id, { resolve, reject, timer });

      const session = this.e2eSessions.get(deviceId);
      if (session?.sessionKey) {
        // Encrypt the inner command — relay sees only opaque bytes
        encryptBox(JSON.stringify(inner), session.sessionKey)
          .then(({ nonce, ciphertext }) => {
            const sent = this.sendRaw({
              type: 'e2e:box',
              id,           // echoed so relay can correlate, outer id ≠ inner id
              deviceId,
              payload: { nonce, ciphertext },
              ts: Date.now(),
            });
            if (!sent) {
              clearTimeout(timer);
              this.pending.delete(id);
              reject(new Error('not connected'));
            }
          })
          .catch((e) => {
            clearTimeout(timer);
            this.pending.delete(id);
            reject(e);
          });
      } else {
        // Plaintext fallback: no E2E session established yet
        if (!this.sendRaw(inner)) {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(new Error('not connected'));
        }
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
    this.e2eSessions.clear();
    this.listeners.clear();
    this.ws?.close();
  }
}
