'use strict';

/**
 * webRemote.cjs — Local WebSocket agent for the web remote control channel.
 *
 * Security invariants (ARCHITECTURE.md §0, §6):
 *   - Outbound-only: opens a WS TO the relay, never listens.
 *   - OFF by default: remoteEnabled must be explicitly true in web-remote.json.
 *   - Kill switch: synchronous — drops socket + refuses all commands instantly.
 *   - Strict allowlist: 15 enumerated command types; unknown → silent drop.
 *   - Zod validation: every payload parsed before any dispatch.
 *   - Path safety: cwd/path fields go through validatePath (home-dir boundary).
 *   - Token at rest: web-remote.json written at 0600 via writeTextAtomic.
 *   - TLS mandatory: relay URL hard-coded wss://; no downgrade path.
 *   - Audit log: every dispatched command logged locally, no secret values.
 *   - E2E encryption: P-256 ECDH + AES-256-GCM; relay sees only ciphertext.
 */

const { ipcMain, app } = require('electron');
const WebSocket = require('ws');
const https = require('node:https');
const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const fsp = require('node:fs/promises');
const fs = require('node:fs');
const { writeTextAtomic, validatePath } = require('./config.cjs');
const logs = require('./logs.cjs');
const { sendIfAlive } = require('./lib/sendToRenderer.cjs');
const { schemas } = require('./ipcSchemas.cjs');

// ─── Constants ───────────────────────────────────────────────────────────────

// Hard-coded wss:// — no configuration allows plaintext downgrade (ADR §5.1).
const RELAY_HTTPS_BASE = 'https://relay.session-manager.bilko.run';
const RELAY_WSS_ORIGIN = 'wss://relay.session-manager.bilko.run';

const CONFIG_PATH = path.join(
  os.homedir(), '.claude', 'session-manager', 'web-remote.json'
);
const AUDIT_LOG_DIR = path.join(
  os.homedir(), '.claude', 'session-manager', 'logs'
);

// Reconnect backoff: init 1s, x2, cap 60s, ±20% jitter (ADR §2.4).
const BACKOFF_INIT_MS = 1_000;
const BACKOFF_MAX_MS = 60_000;
const BACKOFF_MULT = 2;

// Heartbeat (ADR §2.3)
const PING_INTERVAL_MS = 30_000;
const PONG_TIMEOUT_MS = 10_000;
const MAX_MISSED_PONGS = 3;

// Config re-read TTL: 1s so the kill-switch propagates within one second.
const CONFIG_CACHE_TTL_MS = 1_000;

// Max message size: 256 KiB (matches PRD_WRITE_MAX_BYTES, ADR §2.5).
const MSG_MAX_BYTES = 256 * 1024;

// ─── Command allowlist ───────────────────────────────────────────────────────

// Single source of truth lives in ipcSchemas.cjs — imported here so the test
// can verify the same Set without depending on Electron-linked modules.
const { ALLOWED_COMMANDS } = require('./ipcSchemas.cjs');

// ─── E2E encryption helpers (P-256 ECDH + AES-256-GCM, ADR §5.2) ────────────

/**
 * Generate a P-256 ECDH keypair. Public key is SPKI DER base64url; private key
 * is PKCS8 DER base64url. Both are stored in web-remote.json at 0600.
 */
function generateE2EKeyPair() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', {
    namedCurve: 'P-256',
    publicKeyEncoding: { type: 'spki', format: 'der' },
    privateKeyEncoding: { type: 'pkcs8', format: 'der' },
  });
  return {
    e2ePrivateKey: privateKey.toString('base64url'),
    e2ePublicKey: publicKey.toString('base64url'),
  };
}

/**
 * Derive an AES-256-GCM session key from two P-256 public keys via ECDH + HKDF.
 * @param myPrivateKeyB64  Agent's PKCS8 private key, base64url DER
 * @param peerPublicKeyB64 Browser's SPKI public key, base64url DER
 * @param deviceId         Used as HKDF salt for domain separation
 * @returns 32-byte Buffer (AES-256-GCM key)
 */
function deriveSessionKey(myPrivateKeyB64, peerPublicKeyB64, deviceId) {
  const myPrivKey = crypto.createPrivateKey({
    key: Buffer.from(myPrivateKeyB64, 'base64url'),
    format: 'der',
    type: 'pkcs8',
  });
  const peerPubKey = crypto.createPublicKey({
    key: Buffer.from(peerPublicKeyB64, 'base64url'),
    format: 'der',
    type: 'spki',
  });
  const sharedSecret = crypto.diffieHellman({ privateKey: myPrivKey, publicKey: peerPubKey });
  // HKDF: salt = deviceId bytes for domain separation, info = fixed protocol label.
  const salt = Buffer.from(deviceId, 'utf8');
  const info = Buffer.from('sm-e2e-v1', 'utf8');
  return Buffer.from(crypto.hkdfSync('sha256', sharedSecret, salt, info, 32));
}

/**
 * Encrypt a plaintext JSON string into an AES-256-GCM box.
 * @returns { nonce: base64url, ciphertext: base64url } — the nonce is 12 random bytes
 */
function encryptBox(plaintext, sessionKey) {
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', sessionKey, nonce);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag(); // 16-byte GCM authentication tag
  return {
    nonce: nonce.toString('base64url'),
    // Append the GCM tag to the ciphertext so decryptBox can locate it.
    ciphertext: Buffer.concat([encrypted, tag]).toString('base64url'),
  };
}

/**
 * Decrypt an AES-256-GCM box produced by encryptBox (or the browser's equivalent).
 * @returns Decrypted UTF-8 string, or null if authentication fails.
 */
function decryptBox(nonceB64, ciphertextB64, sessionKey) {
  try {
    const nonce = Buffer.from(nonceB64, 'base64url');
    const data = Buffer.from(ciphertextB64, 'base64url');
    if (data.length < 16) return null; // too short to contain tag
    const tag = data.subarray(data.length - 16);
    const ciphertext = data.subarray(0, data.length - 16);
    const decipher = crypto.createDecipheriv('aes-256-gcm', sessionKey, nonce);
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
    return plain;
  } catch {
    return null; // authentication failed — drop the message
  }
}

// ─── Module state ────────────────────────────────────────────────────────────

let _window = null;
let _ws = null;
let _reconnectTimer = null;
let _backoffMs = BACKOFF_INIT_MS;
let _pingTimer = null;
let _pongTimer = null;
let _missedPongs = 0;
let _configCache = null;
let _configCacheAt = 0;
let _destroyed = false; // set at app shutdown to stop reconnect loops

// E2E session state — reset on each new WS connection.
let _e2eSessionKey = null; // Buffer | null

// ─── Config helpers ───────────────────────────────────────────────────────────

function defaultConfig() {
  return { remoteEnabled: false, devices: [] };
}

function loadConfigSync() {
  const now = Date.now();
  if (_configCache && now - _configCacheAt < CONFIG_CACHE_TTL_MS) {
    return _configCache;
  }
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    _configCache = { ...defaultConfig(), ...JSON.parse(raw) };
  } catch {
    _configCache = defaultConfig();
  }
  _configCacheAt = now;
  return _configCache;
}

async function loadConfig() {
  const now = Date.now();
  if (_configCache && now - _configCacheAt < CONFIG_CACHE_TTL_MS) {
    return _configCache;
  }
  try {
    const raw = await fsp.readFile(CONFIG_PATH, 'utf8');
    _configCache = { ...defaultConfig(), ...JSON.parse(raw) };
  } catch {
    _configCache = defaultConfig();
  }
  _configCacheAt = now;
  return _configCache;
}

function invalidateConfigCache() {
  _configCacheAt = 0;
  _configCache = null;
}

// Writes the config atomically at mode 0600 (ADR §4 — equivalent to ~/.ssh/id_rsa).
async function saveConfig(data) {
  const pretty = JSON.stringify(data, null, 2) + '\n';
  await writeTextAtomic(CONFIG_PATH, pretty, { mode: 0o600 });
  invalidateConfigCache();
}

// ─── Audit log ────────────────────────────────────────────────────────────────

// Format: <ISO>  <type>  deviceId=<id>  msgId=<uuid>  result=ok|error:<code>
// NEVER log token values or payload content.
async function auditLog(ts, type, deviceId, msgId, result) {
  try {
    const ymd = ts.slice(0, 10);
    const logPath = path.join(AUDIT_LOG_DIR, `remote-audit-${ymd}.log`);
    const line = `${ts}  ${type}  deviceId=${deviceId || '-'}  msgId=${msgId || '-'}  result=${result}\n`;
    const handle = await fsp.open(logPath, 'a', 0o600);
    try {
      await handle.write(line);
    } finally {
      await handle.close();
    }
  } catch (e) {
    logs.writeLine({
      scope: 'webRemote', level: 'warn',
      message: 'audit log write failed', meta: { error: e?.message },
    });
  }
}

// ─── HTTPS helpers ────────────────────────────────────────────────────────────

function httpsPost(url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') {
      reject(new Error('Only https:// allowed for relay API calls'));
      return;
    }
    const req = https.request({
      hostname: parsed.hostname,
      port: parsed.port || 443,
      path: parsed.pathname + (parsed.search || ''),
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        ...headers,
      },
      rejectUnauthorized: true, // verify relay TLS cert
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(JSON.parse(data)); } catch { resolve({}); }
        } else {
          let errMsg = `HTTP ${res.statusCode}`;
          try { errMsg = JSON.parse(data).error || errMsg; } catch { /* */ }
          reject(new Error(errMsg));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(15_000, () => { req.destroy(new Error('timeout')); });
    req.write(body);
    req.end();
  });
}

// POST /api/device-ticket to exchange device-token for a one-time WS ticket.
async function getDeviceTicket(deviceToken) {
  const result = await httpsPost(
    `${RELAY_HTTPS_BASE}/api/device-ticket`,
    '{}',
    { Authorization: `Bearer ${deviceToken}` }
  );
  if (!result.ticket) throw new Error('relay returned no ticket');
  return result.ticket;
}

// ─── WebSocket lifecycle ──────────────────────────────────────────────────────

function broadcastStatus() {
  if (!_window || _window.isDestroyed()) return;
  const cfg = loadConfigSync();
  const connected = _ws !== null && _ws.readyState === WebSocket.OPEN;
  sendIfAlive(_window, 'webRemote:status', {
    enabled: cfg.remoteEnabled,
    connected,
    e2eActive: connected && _e2eSessionKey !== null,
    devices: (cfg.devices || []).map(({ deviceId, deviceName, issuedAt, lastConnectedAt }) => ({
      deviceId, deviceName, issuedAt, lastConnectedAt,
    })),
  });
}

function stopHeartbeat() {
  if (_pingTimer) { clearInterval(_pingTimer); _pingTimer = null; }
  if (_pongTimer) { clearTimeout(_pongTimer); _pongTimer = null; }
}

function startHeartbeat() {
  stopHeartbeat();
  _pingTimer = setInterval(() => {
    if (!_ws || _ws.readyState !== WebSocket.OPEN) { stopHeartbeat(); return; }
    const pingId = crypto.randomUUID();
    _ws.send(JSON.stringify({ type: 'ping', id: pingId, ts: Date.now() }));
    _pongTimer = setTimeout(() => {
      _missedPongs++;
      logs.writeLine({
        scope: 'webRemote', level: 'warn',
        message: 'missed pong', meta: { missed: _missedPongs },
      });
      if (_missedPongs >= MAX_MISSED_PONGS) {
        logs.writeLine({ scope: 'webRemote', level: 'warn', message: 'closing after missed pongs' });
        _ws?.terminate();
      }
    }, PONG_TIMEOUT_MS);
  }, PING_INTERVAL_MS);
}

function cancelReconnect() {
  if (_reconnectTimer) { clearTimeout(_reconnectTimer); _reconnectTimer = null; }
}

// Full jitter: delay = random(0, min(cap, base * mult^n))
function nextBackoffMs() {
  const raw = Math.min(_backoffMs, BACKOFF_MAX_MS);
  const jitter = 0.8 + Math.random() * 0.4; // ±20%
  const next = Math.floor(raw * jitter);
  _backoffMs = Math.min(_backoffMs * BACKOFF_MULT, BACKOFF_MAX_MS);
  return next;
}

function scheduleReconnect() {
  if (_destroyed) return;
  cancelReconnect();
  const delay = nextBackoffMs();
  logs.writeLine({
    scope: 'webRemote', level: 'info',
    message: 'reconnect scheduled', meta: { delayMs: delay },
  });
  _reconnectTimer = setTimeout(() => {
    _reconnectTimer = null;
    connect().catch((e) => {
      logs.writeLine({ scope: 'webRemote', level: 'warn', message: 'connect failed', meta: { error: e?.message } });
    });
  }, delay);
}

async function disconnect() {
  cancelReconnect();
  stopHeartbeat();
  _e2eSessionKey = null;
  if (_ws) {
    const ws = _ws;
    _ws = null;
    try { ws.terminate(); } catch { /* already closed */ }
  }
  broadcastStatus();
}

async function connect() {
  if (_destroyed) return;

  const cfg = await loadConfig();
  if (!cfg.remoteEnabled) return;

  const devices = cfg.devices || [];
  const device = devices.find((d) => d.deviceToken);
  if (!device) {
    logs.writeLine({ scope: 'webRemote', level: 'info', message: 'no paired device; not connecting' });
    return;
  }

  // Step 1: get a single-use WS ticket via the device token.
  let ticket;
  try {
    ticket = await getDeviceTicket(device.deviceToken);
  } catch (e) {
    logs.writeLine({
      scope: 'webRemote', level: 'warn',
      message: 'device ticket request failed', meta: { error: e?.message },
    });
    scheduleReconnect();
    return;
  }

  // Step 2: open WSS connection with the ticket.
  let ws;
  try {
    ws = new WebSocket(`${RELAY_WSS_ORIGIN}/ws?ticket=${encodeURIComponent(ticket)}`, {
      rejectUnauthorized: true, // verify relay TLS cert
    });
  } catch (e) {
    logs.writeLine({ scope: 'webRemote', level: 'warn', message: 'ws create failed', meta: { error: e?.message } });
    scheduleReconnect();
    return;
  }

  _ws = ws;
  _missedPongs = 0;
  _e2eSessionKey = null; // reset session key on new connection

  ws.on('open', () => {
    logs.writeLine({ scope: 'webRemote', level: 'info', message: 'connected to relay' });
    _backoffMs = BACKOFF_INIT_MS;
    _missedPongs = 0;
    startHeartbeat();
    // Update lastConnectedAt without exposing token
    loadConfig().then(async (c) => {
      const devs = (c.devices || []).map((d) =>
        d.deviceId === device.deviceId
          ? { ...d, lastConnectedAt: new Date().toISOString() }
          : d
      );
      await saveConfig({ ...c, devices: devs });
      broadcastStatus();
    }).catch(() => {});
    broadcastStatus();
  });

  ws.on('message', (raw) => {
    if (raw.length > MSG_MAX_BYTES) {
      logs.writeLine({ scope: 'webRemote', level: 'warn', message: 'oversized message dropped' });
      return;
    }
    handleMessage(raw.toString(), device).catch((e) => {
      logs.writeLine({ scope: 'webRemote', level: 'warn', message: 'handleMessage error', meta: { error: e?.message } });
    });
  });

  ws.on('close', (code) => {
    stopHeartbeat();
    _e2eSessionKey = null;
    if (_ws === ws) _ws = null;
    logs.writeLine({ scope: 'webRemote', level: 'info', message: 'ws closed', meta: { code } });
    broadcastStatus();

    if (code === 4001) {
      // Token revoked by relay — stop reconnecting, clear token (ADR §4.1).
      handleTokenRevoked(device.deviceId).catch(() => {});
      return;
    }

    if (!_destroyed) scheduleReconnect();
  });

  ws.on('error', (e) => {
    logs.writeLine({ scope: 'webRemote', level: 'warn', message: 'ws error', meta: { error: e?.message } });
  });
}

async function handleTokenRevoked(deviceId) {
  logs.writeLine({ scope: 'webRemote', level: 'warn', message: 'token revoked', meta: { deviceId } });
  const cfg = await loadConfig();
  const devices = (cfg.devices || []).filter((d) => d.deviceId !== deviceId);
  await saveConfig({ ...cfg, remoteEnabled: false, devices });
  broadcastStatus();
  sendIfAlive(_window, 'webRemote:token-revoked', { deviceId });
}

// ─── Message handling & command dispatch ─────────────────────────────────────

async function handleMessage(raw, device) {
  let envelope;
  try {
    envelope = JSON.parse(raw);
  } catch {
    return; // malformed JSON — drop silently
  }

  const { type, id, payload } = envelope;
  if (typeof type !== 'string') return;

  // Handle relay control messages
  if (type === 'pong') {
    if (_pongTimer) { clearTimeout(_pongTimer); _pongTimer = null; }
    _missedPongs = 0;
    return;
  }
  if (type === 'ping') {
    if (_ws && _ws.readyState === WebSocket.OPEN) {
      _ws.send(JSON.stringify({ type: 'pong', id, ts: Date.now() }));
    }
    return;
  }
  if (type === 'auth:ok') {
    logs.writeLine({ scope: 'webRemote', level: 'info', message: 'auth:ok from relay' });
    return;
  }
  if (type === 'error') {
    const code = envelope.code || payload?.code;
    if (code === 'token_revoked') {
      const ws = _ws;
      _ws = null;
      try { ws?.terminate(); } catch { /* */ }
      handleTokenRevoked(device.deviceId).catch(() => {});
    }
    return;
  }

  // ── E2E key exchange ───────────────────────────────────────────────────────
  // Browser sends e2e:hello with its ephemeral P-256 public key (SPKI base64url).
  // We compute the shared session key and acknowledge.
  if (type === 'e2e:hello') {
    const browserPubKey = payload?.pubKey;
    if (!browserPubKey || typeof browserPubKey !== 'string') {
      logs.writeLine({ scope: 'webRemote', level: 'warn', message: 'e2e:hello missing pubKey' });
      return;
    }
    // P-256 SPKI DER is 91 bytes → base64url ~122 chars; reject out-of-range blobs
    // before they reach crypto.createPublicKey (malformed input throws and is caught,
    // but repeated bad keys force plaintext fallback via the keep-e2e enforcement above).
    const PUB_KEY_RE = /^[A-Za-z0-9+/=_-]+$/;
    if (browserPubKey.length < 80 || browserPubKey.length > 256 || !PUB_KEY_RE.test(browserPubKey)) {
      logs.writeLine({ scope: 'webRemote', level: 'warn', message: 'e2e:hello invalid pubKey format' });
      return;
    }
    if (!device.e2ePrivateKey) {
      logs.writeLine({ scope: 'webRemote', level: 'warn', message: 'e2e:hello but no device private key — skipping E2E' });
      return;
    }
    try {
      _e2eSessionKey = deriveSessionKey(device.e2ePrivateKey, browserPubKey, device.deviceId);
      logs.writeLine({ scope: 'webRemote', level: 'info', message: 'E2E session key established' });
      broadcastStatus();
      // Acknowledge with e2e:ready (unencrypted — session just started)
      respond(id, undefined, 'e2e:ready');
    } catch (e) {
      logs.writeLine({ scope: 'webRemote', level: 'warn', message: 'E2E key derivation failed', meta: { error: e?.message } });
      _e2eSessionKey = null;
    }
    return;
  }

  // ── Decrypt e2e:box messages ──────────────────────────────────────────────
  if (type === 'e2e:box') {
    if (!_e2eSessionKey) {
      logs.writeLine({ scope: 'webRemote', level: 'warn', message: 'e2e:box received but no session key — dropping' });
      return;
    }
    const { nonce, ciphertext } = payload || {};
    if (!nonce || !ciphertext) return;
    const plaintext = decryptBox(nonce, ciphertext, _e2eSessionKey);
    if (!plaintext) {
      logs.writeLine({ scope: 'webRemote', level: 'warn', message: 'e2e:box decryption failed (auth tag mismatch)' });
      return;
    }
    // Replace envelope with the decrypted inner command and continue dispatch.
    let inner;
    try {
      inner = JSON.parse(plaintext);
    } catch {
      return;
    }
    // Dispatch as if it arrived unencrypted
    await dispatchEnvelope(inner, device);
    return;
  }

  // Only dispatch cmd:* type messages
  if (!type.startsWith('cmd:')) return;
  // After E2E is established, reject plaintext commands — a malicious relay cannot
  // silently downgrade the session by stripping e2e:hello (PENTEST.md §H1).
  if (_e2eSessionKey) {
    logs.writeLine({ scope: 'webRemote', level: 'warn', message: 'plaintext cmd rejected — e2e session active' });
    return;
  }
  await dispatchEnvelope(envelope, device);
}

async function dispatchEnvelope(envelope, device) {
  const { type, id, payload } = envelope;
  if (typeof type !== 'string' || !type.startsWith('cmd:')) return;

  const ts = new Date().toISOString();

  // Kill switch — re-reads config with 1s TTL
  const cfg = await loadConfig();
  if (!cfg.remoteEnabled) {
    await auditLog(ts, type, device.deviceId, id, 'error:disabled');
    respond(id, { error: 'disabled' });
    return;
  }

  // Allowlist check — unknown types are dropped without error feedback (ADR §6.2)
  if (!ALLOWED_COMMANDS.has(type)) {
    await auditLog(ts, type, device.deviceId, id, 'error:not_allowed');
    return;
  }

  // Dispatch
  let result;
  try {
    result = await dispatchCommand(type, payload ?? {});
    await auditLog(ts, type, device.deviceId, id, 'ok');
  } catch (e) {
    const code = e?.name === 'ZodError' ? 'schema_invalid' : 'dispatch_error';
    await auditLog(ts, type, device.deviceId, id, `error:${code}`);
    result = { error: code }; // never leak internal error messages to the remote caller
  }

  respond(id, result);
}

function respond(msgId, payload, typeOverride) {
  if (!_ws || _ws.readyState !== WebSocket.OPEN) return;
  const responseType = typeOverride || (msgId ? `resp:${msgId}` : undefined);
  if (!responseType) return;

  const inner = {
    type: responseType,
    id: msgId,
    payload,
    ts: Date.now(),
  };

  try {
    // Encrypt the response if a session key is active.
    if (_e2eSessionKey && !typeOverride) {
      const { nonce, ciphertext } = encryptBox(JSON.stringify(inner), _e2eSessionKey);
      _ws.send(JSON.stringify({
        type: 'e2e:box',
        id: msgId,
        payload: { nonce, ciphertext },
        ts: Date.now(),
      }));
    } else {
      _ws.send(JSON.stringify(inner));
    }
  } catch (e) {
    logs.writeLine({ scope: 'webRemote', level: 'warn', message: 'respond send failed', meta: { error: e?.message } });
  }
}

// Lazy-loaded dispatch map — avoids circular require at module load time.
let _dispatchMap = null;

function getDispatchMap() {
  if (_dispatchMap) return _dispatchMap;

  const { manager: ptyManager } = require('./pty.cjs');
  const sessionsStore = require('./sessionsStore.cjs');
  const scheduler = require('./scheduler.cjs');
  const { remote: histRemote } = require('./historyAggregator.cjs');

  _dispatchMap = {
    'cmd:sessions:load': async () =>
      sessionsStore.load(),

    'cmd:sessions:save': async (payload) => {
      const parsed = schemas.sessionsPayload.parse(payload);
      return sessionsStore.save(parsed);
    },

    'cmd:pty:spawn': async (payload) => {
      const parsed = schemas.ptySpawn.parse(payload);
      // Path safety — validatePath rejects anything outside home dir.
      validatePath(parsed.cwd);
      // Strip startupCommand: it is ignored by pty.cjs today, but passing a
      // remotely-controlled 8 KiB string to spawn is a landmine if pty.cjs
      // ever uses it. Remote callers have no legitimate need for it.
      const { startupCommand: _ignored, ...safePayload } = parsed;
      return ptyManager.spawn(safePayload);
    },

    'cmd:pty:write': async (payload) => {
      const parsed = schemas.ptyWrite.parse(payload);
      ptyManager.write(parsed);
      return { ok: true };
    },

    'cmd:pty:resize': async (payload) => {
      const parsed = schemas.ptyResize.parse(payload);
      ptyManager.resize(parsed);
      return { ok: true };
    },

    'cmd:pty:kill': async (payload) => {
      const parsed = schemas.ptyTabId.parse(payload);
      ptyManager.kill(parsed.tabId);
      return { ok: true };
    },

    'cmd:schedule:state': async () =>
      scheduler.remote.getState(),

    'cmd:schedule:read-prd': async (payload) => {
      const parsed = schemas.scheduleSlug.parse(payload);
      return scheduler.remote.readPrd(parsed.slug);
    },

    'cmd:schedule:read-log': async (payload) => {
      const parsed = schemas.scheduleReadLog.parse(payload);
      return scheduler.remote.readLog(parsed.slug, parsed.runId);
    },

    'cmd:schedule:write-prd': async (payload) => {
      const parsed = schemas.scheduleWritePrd.parse(payload);
      return scheduler.remote.writePrd(parsed.slug, parsed.body);
    },

    'cmd:schedule:reset-job': async (payload) => {
      const parsed = schemas.scheduleSlug.parse(payload);
      return scheduler.remote.resetJob(parsed.slug);
    },

    'cmd:schedule:run-now': async () =>
      scheduler.remote.runNow(),

    'cmd:schedule:set-config': async (payload) => {
      const parsed = schemas.setConfigSchema.default({}).parse(payload ?? {});
      return scheduler.remote.setConfig(parsed);
    },

    'cmd:history:aggregate': async (payload) => {
      const parsed = schemas.historyAggregate.parse(payload);
      return histRemote.aggregate(parsed);
    },

    'cmd:app:version': async () =>
      app.getVersion(),
  };

  return _dispatchMap;
}

async function dispatchCommand(type, payload) {
  const map = getDispatchMap();
  const handler = map[type];
  if (!handler) throw new Error(`no handler for ${type}`);
  return handler(payload);
}

// ─── Pairing ─────────────────────────────────────────────────────────────────

async function pair(otp) {
  const deviceId = crypto.randomUUID();

  // Generate E2E keypair at pair time — public key is sent to relay and stored
  // alongside the device token so the browser can do key agreement.
  const { e2ePrivateKey, e2ePublicKey } = generateE2EKeyPair();

  const body = JSON.stringify({
    code: otp.trim().toUpperCase(),
    deviceId,
    devicePubKey: e2ePublicKey,
  });

  let response;
  try {
    response = await httpsPost(`${RELAY_HTTPS_BASE}/pair`, body);
  } catch (e) {
    return { ok: false, error: e?.message || 'pairing request failed' };
  }

  if (!response.deviceToken || !response.deviceId) {
    return { ok: false, error: 'relay returned no device token' };
  }

  const cfg = await loadConfig();
  const devices = cfg.devices || [];
  devices.push({
    deviceId: response.deviceId,
    deviceToken: response.deviceToken, // stored only on disk at 0600
    // Private key stored at 0600 — same security model as device token.
    e2ePrivateKey,
    e2ePublicKey,
    deviceName: `Device (paired ${new Date().toISOString().slice(0, 10)})`,
    issuedAt: new Date().toISOString(),
    lastConnectedAt: null,
  });

  await saveConfig({ ...cfg, devices });

  if (cfg.remoteEnabled) {
    connect().catch(() => {});
  }

  // Return only non-secret fields to the renderer
  return { ok: true, deviceId: response.deviceId };
}

async function revokeDevice(deviceId) {
  invalidateConfigCache();
  const cfg = await loadConfig();
  const devices = (cfg.devices || []).filter((d) => d.deviceId !== deviceId);
  await saveConfig({ ...cfg, devices });

  // If the active connection is for this device, disconnect
  if (_ws && _ws.readyState === WebSocket.OPEN) {
    await disconnect();
    // Reconnect to a different device if any remain
    if (devices.length > 0 && cfg.remoteEnabled) {
      connect().catch(() => {});
    }
  }

  broadcastStatus();
  return { ok: true };
}

/**
 * Panic / revoke-all: immediately disconnect the relay WS, clear all device
 * entries from web-remote.json, and set remoteEnabled = false.
 * This is the local-side "kill everything" action (ADR §4.1).
 */
async function revokeAllDevices() {
  const cfg = await loadConfig();
  const revokedCount = (cfg.devices || []).length;
  await saveConfig({ ...cfg, remoteEnabled: false, devices: [] });
  await disconnect(); // tears down WS + clears session key
  broadcastStatus();
  sendIfAlive(_window, 'webRemote:revoked-all', { revokedCount });
  return { ok: true };
}

// ─── IPC handlers ─────────────────────────────────────────────────────────────

function registerRemoteHandlers() {
  const { validated } = require('./ipcSchemas.cjs');

  // Returns current status without tokens — safe to expose to renderer.
  ipcMain.handle('webRemote:get-status', async () => {
    const cfg = await loadConfig();
    return {
      enabled: cfg.remoteEnabled,
      connected: _ws !== null && _ws.readyState === WebSocket.OPEN,
      e2eActive: _ws !== null && _ws.readyState === WebSocket.OPEN && _e2eSessionKey !== null,
      devices: (cfg.devices || []).map(({ deviceId, deviceName, issuedAt, lastConnectedAt }) => ({
        deviceId, deviceName, issuedAt, lastConnectedAt,
      })),
    };
  });

  ipcMain.handle('webRemote:enable', async () => {
    const cfg = await loadConfig();
    await saveConfig({ ...cfg, remoteEnabled: true });
    connect().catch(() => {});
    broadcastStatus();
    return { ok: true };
  });

  ipcMain.handle('webRemote:disable', async () => {
    const cfg = await loadConfig();
    await saveConfig({ ...cfg, remoteEnabled: false });
    await disconnect();
    broadcastStatus();
    return { ok: true };
  });

  ipcMain.handle('webRemote:pair', validated(schemas.webRemotePair, async ({ otp }) => {
    return pair(otp);
  }));

  ipcMain.handle('webRemote:revoke-device', validated(schemas.webRemoteRevokeDevice, async ({ deviceId }) => {
    return revokeDevice(deviceId);
  }));

  // Panic button: revoke all devices, disable remote, disconnect immediately.
  ipcMain.handle('webRemote:revoke-all', async () => {
    return revokeAllDevices();
  });

  ipcMain.handle('webRemote:audit-tail', validated(schemas.webRemoteAuditTail, async ({ lines }) => {
    const lineCount = lines || 50;
    const ymd = new Date().toISOString().slice(0, 10);
    const logPath = path.join(AUDIT_LOG_DIR, `remote-audit-${ymd}.log`);
    try {
      const text = await fsp.readFile(logPath, 'utf8');
      const all = text.split('\n').filter(Boolean);
      return { ok: true, lines: all.slice(-lineCount) };
    } catch (e) {
      if (e?.code === 'ENOENT') return { ok: true, lines: [] };
      return { ok: false, error: e?.message };
    }
  }));
}

// ─── Module lifecycle ────────────────────────────────────────────────────────

function attachWindow(w) {
  _window = w;
}

async function init() {
  await fsp.mkdir(AUDIT_LOG_DIR, { recursive: true });
  const cfg = await loadConfig();
  if (cfg.remoteEnabled && (cfg.devices || []).some((d) => d.deviceToken)) {
    connect().catch((e) => {
      logs.writeLine({ scope: 'webRemote', level: 'warn', message: 'init connect failed', meta: { error: e?.message } });
    });
  }
}

function destroy() {
  _destroyed = true;
  cancelReconnect();
  _e2eSessionKey = null;
  if (_ws) {
    try { _ws.terminate(); } catch { /* */ }
    _ws = null;
  }
  stopHeartbeat();
}

module.exports = {
  attachWindow,
  registerRemoteHandlers,
  init,
  destroy,
};
