'use strict';

/**
 * webRemote.cjs — Local WebSocket agent for the web remote control channel.
 *
 * Security invariants (ARCHITECTURE.md §0, §6):
 *   - Outbound-only: opens a WS TO the relay, never listens.
 *   - OFF by default: remoteEnabled must be explicitly true in web-remote.json.
 *   - Kill switch: synchronous — drops socket + refuses all commands instantly.
 *   - Strict allowlist: enumerated command types; unknown → opaque rejected response.
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
const { makeState, confirmSas: confirmSasLogic } = require('./lib/e2eStateMachine.cjs');

// ─── Constants ───────────────────────────────────────────────────────────────

// Hard-coded wss:// — no configuration allows plaintext downgrade (ADR §5.1).
// v2: relay is same-origin on bilko.run (ARCHITECTURE-V2-MOBILE.md §1). REST under
// /api/sm-relay; WS upgrade at /projects/session-manager/relay (covered by host CSP
// connect-src 'self').
const RELAY_HTTPS_BASE = 'https://bilko.run';
const RELAY_API_BASE = `${RELAY_HTTPS_BASE}/api/sm-relay`;
const RELAY_WSS_URL = 'wss://bilko.run/projects/session-manager/relay';

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
const { ALLOWED_COMMANDS, MUTATE_COMMANDS, SAS_GATED_READS } = require('./ipcSchemas.cjs');

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
 * Derive a 6-digit Short Authentication String from the ECDH shared secret.
 * Uses a separate HKDF info label ('sm-sas-v1') so the SAS is independent of
 * the session key. Both sides compute the same value; user confirms they match.
 */
function deriveSas(myPrivateKeyB64, peerPublicKeyB64, deviceId) {
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
  const salt = Buffer.from(deviceId, 'utf8');
  const info = Buffer.from('sm-sas-v1', 'utf8');
  const sasBytes = Buffer.from(crypto.hkdfSync('sha256', sharedSecret, salt, info, 3));
  const sasNum = ((sasBytes[0] << 16) | (sasBytes[1] << 8) | sasBytes[2]) % 1_000_000;
  return sasNum.toString().padStart(6, '0');
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
// .state: 'idle' | 'pending_sas' | 'authenticated' | 'failed'
let _e2e = makeState();

// ─── Config helpers ───────────────────────────────────────────────────────────

function defaultConfig() {
  return { remoteEnabled: false, remoteControlEnabled: false, devices: [] };
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
    const clean = (s) => String(s ?? '').replace(/[\r\n\t]+/g, ' ').slice(0, 200);
    const line = `${ts}  ${clean(type)}  deviceId=${clean(deviceId) || '-'}  msgId=${clean(msgId) || '-'}  result=${result}\n`;
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
    `${RELAY_API_BASE}/device-ticket`,
    '{}',
    { Authorization: `Bearer ${deviceToken}` }
  );
  if (!result.ticket) throw new Error('relay returned no ticket');
  return result.ticket;
}

// ─── E2E state helpers ────────────────────────────────────────────────────────

function resetE2e(state = 'idle') {
  _e2e = makeState(state);
}

// ─── WebSocket lifecycle ──────────────────────────────────────────────────────

function broadcastStatus() {
  if (!_window || _window.isDestroyed()) return;
  const cfg = loadConfigSync();
  const connected = _ws !== null && _ws.readyState === WebSocket.OPEN;
  sendIfAlive(_window, 'webRemote:status', {
    enabled: cfg.remoteEnabled,
    remoteControlEnabled: cfg.remoteControlEnabled ?? false,
    connected,
    e2eActive: connected && _e2e.sessionKey !== null,
    e2eAuthenticated: connected && _e2e.state === 'authenticated',
    e2eState: connected ? _e2e.state : 'idle',
    pendingSas: connected && _e2e.state === 'pending_sas' ? _e2e.pendingSas : null,
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
  resetE2e();
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
    ws = new WebSocket(`${RELAY_WSS_URL}?ticket=${encodeURIComponent(ticket)}`, {
      rejectUnauthorized: true, // verify relay TLS cert
    });
  } catch (e) {
    logs.writeLine({ scope: 'webRemote', level: 'warn', message: 'ws create failed', meta: { error: e?.message } });
    scheduleReconnect();
    return;
  }

  _ws = ws;
  _missedPongs = 0;
  resetE2e(); // reset E2E state on new connection

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
    // v2: begin pushing the live session list once connected.
    // Reset diff-guard so the new client always receives a full session-list push.
    _lastSessionListJson = null;
    startSessionListPush();
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
    stopAllSessionWatches();
    resetE2e();
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

// ─── v2 mobile: session live state + summary push ────────────────────────────
//
// For each subscribed tab the agent tails its transcript JSONL (reusing the
// canonical classifyLine + transcriptPath from transcripts.cjs — single source of
// truth), derives a coarse state, and pushes event:session:state on change.
// The last completed assistant turn drives the Haiku summary (see maybeSummarize).

const SESSION_POLL_MS = 1500;
const SESSION_LIST_PUSH_MS = 5000;
const SESSION_INIT_TAIL_BYTES = 512 * 1024; // bound the initial read

const _sessionWatchers = new Map(); // tabId → watcher
let _sessionListTimer = null;
let _lastSessionListJson = null; // diff-guard: skip push when snapshot unchanged

/** Push an unsolicited event to the browser(s). Encrypts when an E2E key is active. */
function pushEvent(type, payload) {
  if (!_ws || _ws.readyState !== WebSocket.OPEN) return;
  const inner = { type, id: crypto.randomUUID(), payload, ts: Date.now() };
  try {
    if (_e2e.sessionKey) {
      const { nonce, ciphertext } = encryptBox(JSON.stringify(inner), _e2e.sessionKey);
      _ws.send(JSON.stringify({ type: 'e2e:box', id: inner.id, payload: { nonce, ciphertext }, ts: Date.now() }));
    } else {
      _ws.send(JSON.stringify(inner));
    }
  } catch (e) {
    logs.writeLine({ scope: 'webRemote', level: 'warn', message: 'pushEvent failed', meta: { type, error: e?.message } });
  }
}

/** Extract concatenated text from an assistant transcript line, or '' if none. */
function extractAssistantText(raw) {
  const msg = raw?.message || raw;
  const content = msg?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n').trim();
}

/** Map a classified transcript event to a coarse session state. */
function deriveState(ev, raw) {
  // API/usage errors surface as a flagged message line.
  if (raw?.isApiErrorMessage || raw?.level === 'error') return 'error';
  switch (ev.kind) {
    case 'tool_use':
    case 'agent_spawn':
      return 'running';        // model invoked a tool, awaiting result
    case 'tool_result':
      return 'thinking';       // tool finished, model resuming
    case 'user':
      return 'thinking';       // input submitted, model will respond
    case 'assistant':
      return 'idle';           // assistant text turn complete → user's turn
    default:
      return null;             // usage/todo/plan/etc. — no state change
  }
}

async function tailLines(filePath, fromOffset) {
  const stat = await fsp.stat(filePath).catch(() => null);
  if (!stat) return { lines: [], size: 0, inode: undefined };
  let start = fromOffset;
  if (start == null || start > stat.size) start = Math.max(0, stat.size - SESSION_INIT_TAIL_BYTES);
  if (stat.size <= start) return { lines: [], size: stat.size, inode: stat.ino };
  const fd = await fsp.open(filePath, 'r');
  try {
    const len = stat.size - start;
    const buf = Buffer.alloc(len);
    await fd.read(buf, 0, len, start);
    const parts = buf.toString('utf8').split('\n').filter(Boolean);
    // If we started mid-file, the first fragment may be a partial line — drop it.
    if (start > 0 && parts.length) parts.shift();
    return { lines: parts, size: stat.size, inode: stat.ino };
  } finally {
    await fd.close();
  }
}

async function pollSessionWatcher(w) {
  let res;
  try {
    res = await tailLines(w.filePath, w.offset);
  } catch { return; }
  // Inode change = file replaced; restart from a bounded tail.
  if (w.inode !== undefined && res.inode !== undefined && res.inode !== w.inode) {
    w.offset = Math.max(0, res.size - SESSION_INIT_TAIL_BYTES);
    w.inode = res.inode;
    return;
  }
  w.offset = res.size;
  w.inode = res.inode;

  let nextState = null;
  let newAssistantText = null;
  let newMsgId = null;
  for (const line of res.lines) {
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    const ev = require('./transcripts.cjs').classifyLine(obj);
    if (!ev) continue;
    const s = deriveState(ev, obj);
    if (s) nextState = s;
    if (ev.kind === 'assistant') {
      const text = extractAssistantText(obj);
      if (text) { newAssistantText = text; newMsgId = obj.uuid || obj.message?.id || `${w.tabId}:${res.size}`; }
    }
  }

  if (nextState && nextState !== w.state) {
    w.state = nextState;
    // Guard: don't push state if SAS not yet confirmed (watcher may outlive an auth reset).
    if (_e2e.state === 'authenticated') {
      pushEvent('event:session:state', { tabId: w.tabId, state: w.state, since: Date.now() });
    }
  }
  if (newAssistantText && newMsgId !== w.lastMsgId) {
    w.lastAssistantText = newAssistantText;
    w.lastMsgId = newMsgId;
  }
  // Summarize only a COMPLETED turn (state idle) — not assistant text mid-turn that
  // is followed by a tool call. Cache by msgId so re-subscribe doesn't re-bill.
  if (w.state === 'idle' && w.lastAssistantText && w.lastMsgId !== w.summarizedMsgId) {
    w.summarizedMsgId = w.lastMsgId;
    maybeSummarize(w).catch(() => {});
  }
}

function startSessionWatch(tabId, cwd) {
  if (_sessionWatchers.has(tabId)) return;
  const filePath = require('./transcripts.cjs').transcriptPath(cwd, tabId);
  // Defense in depth: the schema restricts tabId charset, but re-validate the
  // FINAL joined path against the home-dir boundary (validatePath resolves
  // symlinks + rejects escapes) before any fs read. Throws → dispatch drops it.
  validatePath(filePath);
  const w = {
    tabId, cwd, filePath,
    offset: null,       // null → first poll reads a bounded tail then tracks EOF
    inode: undefined,
    state: 'idle',
    lastAssistantText: null,
    lastMsgId: null,
    summarizedMsgId: null,
    timer: null,
  };
  _sessionWatchers.set(tabId, w);
  // Prime once immediately (captures current state + last assistant turn), then poll.
  pollSessionWatcher(w).catch(() => {});
  w.timer = setInterval(() => pollSessionWatcher(w).catch(() => {}), SESSION_POLL_MS);
  if (typeof w.timer.unref === 'function') w.timer.unref();
}

function stopSessionWatch(tabId) {
  const w = _sessionWatchers.get(tabId);
  if (!w) return;
  if (w.timer) clearInterval(w.timer);
  _sessionWatchers.delete(tabId);
}

function stopAllSessionWatches() {
  for (const tabId of Array.from(_sessionWatchers.keys())) stopSessionWatch(tabId);
  if (_sessionListTimer) { clearInterval(_sessionListTimer); _sessionListTimer = null; }
}

/** Push the current session list (reuses sessionsStore — the canonical source). */
async function pushSessionList() {
  try {
    // Honor the kill switch: when remote is disabled, push nothing (the project
    // list = cwds/titles is sensitive). dispatchEnvelope already blocks cmd:*;
    // this stops the unsolicited background push too.
    const cfg = await loadConfig();
    if (!cfg.remoteEnabled) return;
    // Don't push before SAS is confirmed — session cwds/titles are sensitive user data.
    // A relay that completes e2e:hello before the user confirms the SAS would otherwise
    // receive the full session list immediately (same threat SAS_GATED_READS blocks for
    // cmd:sessions:load). Guard here so _lastSessionListJson is not poisoned either.
    if (_e2e.state !== 'authenticated') return;
    const sessionsStore = require('./sessionsStore.cjs');
    const data = await sessionsStore.load();
    // Normalize persisted tabs → SessionMeta. tabId === claudeSessionId so it
    // matches the transcript JSONL name used by cmd:session:subscribe.
    const sessions = (data?.tabs ?? []).map((t) => ({
      tabId: t.claudeSessionId,
      cwd: t.cwd,
      title: t.label || t.cwd,
      state: _sessionWatchers.get(t.claudeSessionId)?.state ?? null,
    }));
    const payload = { sessions, activeTabId: data?.activeTabId ?? null };
    const json = JSON.stringify(payload);
    if (json === _lastSessionListJson) return;
    _lastSessionListJson = json;
    pushEvent('event:session:list', payload);
  } catch (e) {
    logs.writeLine({ scope: 'webRemote', level: 'warn', message: 'pushSessionList failed', meta: { error: e?.message } });
  }
}

function startSessionListPush() {
  if (_sessionListTimer) return;
  pushSessionList().catch(() => {});
  _sessionListTimer = setInterval(() => pushSessionList().catch(() => {}), SESSION_LIST_PUSH_MS);
  if (typeof _sessionListTimer.unref === 'function') _sessionListTimer.unref();
}

// ─── SM-V2-03: mobile summary via Claude Haiku 4.5 ───────────────────────────

const SUMMARY_MIN_CHARS = 280;       // below this, push raw — not worth an API call
const SUMMARY_MODEL = 'claude-haiku-4-5';
const SUMMARY_MAX_INPUT_CHARS = 24_000; // cap the turn text sent to Haiku (~6k tokens)
const SUMMARY_SYSTEM =
  'Summarize this Claude Code assistant turn for a phone screen in 2 sentences max, ' +
  'followed by an optional list of up to 3 short action items. Plain text only — no ' +
  'markdown headers, no code blocks. Lead with what was done or decided.';

let _anthropicKeyCache = null; // memoized found key only (string); null = re-resolve

/** Resolve the Anthropic API key: env → web-remote.json → null (degrade to raw).
 *  Only a FOUND key is cached — if absent we re-resolve each call (cheap, loadConfig
 *  is TTL-cached) so adding the key to web-remote.json later takes effect without a restart. */
async function resolveAnthropicKey() {
  if (_anthropicKeyCache) return _anthropicKeyCache;
  const fromEnv = process.env.ANTHROPIC_API_KEY;
  if (fromEnv && fromEnv.trim()) { _anthropicKeyCache = fromEnv.trim(); return _anthropicKeyCache; }
  try {
    const cfg = await loadConfig();
    const k = cfg.anthropicApiKey;
    if (typeof k === 'string' && k.trim()) { _anthropicKeyCache = k.trim(); return _anthropicKeyCache; }
  } catch { /* fall through to null → re-resolve next time */ }
  return null;
}

/** POST to the Anthropic Messages API. Returns the first text block, or throws. */
function anthropicSummarize(apiKey, text) {
  const body = JSON.stringify({
    model: SUMMARY_MODEL,
    max_tokens: 320,
    system: SUMMARY_SYSTEM,
    messages: [{ role: 'user', content: text.slice(0, SUMMARY_MAX_INPUT_CHARS) }],
  });
  return new Promise((resolve, reject) => {
    const req = https.request('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-length': Buffer.byteLength(body),
      },
      timeout: 20_000,
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error(`anthropic HTTP ${res.statusCode}`));
        }
        try {
          const json = JSON.parse(data);
          const block = Array.isArray(json.content) ? json.content.find((b) => b.type === 'text') : null;
          if (!block?.text) return reject(new Error('no text in response'));
          resolve(block.text.trim());
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('anthropic request timed out')));
    req.end(body);
  });
}

/**
 * Produce a mobile summary of the watcher's last completed assistant turn and push it.
 * Short turns are pushed raw (no API call). If no API key is configured, degrades to
 * the raw message so core remote control is never blocked. Cost: Haiku in+out per
 * completed turn per subscribed tab (~$1/$5 per 1M tokens).
 */
async function maybeSummarize(w) {
  // Guard: don't push summaries (session transcript content) before SAS confirmed.
  if (_e2e.state !== 'authenticated') return;
  const text = w.lastAssistantText;
  if (!text) return;
  const ofMessageId = w.lastMsgId;

  if (text.length < SUMMARY_MIN_CHARS) {
    pushEvent('event:session:summary', { tabId: w.tabId, summary: text, ofMessageId, model: 'raw', ts: Date.now() });
    return;
  }

  const apiKey = await resolveAnthropicKey();
  if (!apiKey) {
    // Degrade gracefully: push a trimmed raw message + a hint flag the app can surface.
    pushEvent('event:session:summary', {
      tabId: w.tabId, summary: text.slice(0, 600), ofMessageId, model: 'raw', degraded: 'no_api_key', ts: Date.now(),
    });
    return;
  }

  try {
    const summary = await anthropicSummarize(apiKey, text);
    pushEvent('event:session:summary', { tabId: w.tabId, summary, ofMessageId, model: SUMMARY_MODEL, ts: Date.now() });
  } catch (e) {
    logs.writeLine({ scope: 'webRemote', level: 'warn', message: 'summary failed; pushing raw', meta: { error: e?.message } });
    pushEvent('event:session:summary', { tabId: w.tabId, summary: text.slice(0, 600), ofMessageId, model: 'raw', degraded: 'api_error', ts: Date.now() });
  }
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
    // Explicit P-256 curve validation — do not rely on Node's implicit throw.
    // Rejects wrong-curve keys (e.g. P-384), malformed DER, and the all-zero
    // identity point. Must happen before deriveSessionKey so a bad key drops
    // the session here, not silently in a crypto catch-all below.
    try {
      const derBytes = Buffer.from(browserPubKey, 'base64url');
      const importedPub = crypto.createPublicKey({ key: derBytes, format: 'der', type: 'spki' });
      if (importedPub.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
        throw new Error(`wrong curve: ${importedPub.asymmetricKeyDetails?.namedCurve}`);
      }
      // P-256 SPKI DER is always 91 bytes; raw EC point (04 || x || y) starts at offset 26.
      // Defense-in-depth: reject the identity point (x=0, y=0) explicitly even though
      // Node's ECDH would also reject it — P-256 is a prime-order group, so the identity
      // is the only low-order point.
      if (derBytes.length === 91) {
        const x = derBytes.subarray(27, 59);
        const y = derBytes.subarray(59, 91);
        if (x.every((b) => b === 0) && y.every((b) => b === 0)) {
          throw new Error('identity point rejected');
        }
      }
    } catch (e) {
      logs.writeLine({ scope: 'webRemote', level: 'warn', message: 'e2e:hello peer key validation failed — session dropped', meta: { error: e?.message } });
      await auditLog(new Date().toISOString(), 'e2e:hello', device.deviceId, undefined, 'error:invalid_peer_key');
      resetE2e('failed'); // surface key-validation failure to UI — user must reconnect
      broadcastStatus();
      return;
    }
    try {
      const sessionKey = deriveSessionKey(device.e2ePrivateKey, browserPubKey, device.deviceId);
      let pendingSas;
      try {
        pendingSas = deriveSas(device.e2ePrivateKey, browserPubKey, device.deviceId);
      } catch (sasErr) {
        // SAS derivation failed — session cannot be verified by the user.
        // Mark failed so confirm-sas returns ok:false and the UI prompts retry.
        resetE2e('failed');
        logs.writeLine({ scope: 'webRemote', level: 'warn', message: 'E2E SAS derivation failed — session marked failed', meta: { error: sasErr?.message } });
        broadcastStatus();
        return;
      }
      _e2e = makeState('pending_sas', sessionKey, pendingSas);
      logs.writeLine({ scope: 'webRemote', level: 'info', message: 'E2E session key established — SAS pending confirmation' });
      broadcastStatus();
      // Acknowledge with e2e:ready (unencrypted — session just started)
      respond(id, undefined, 'e2e:ready');
    } catch (e) {
      logs.writeLine({ scope: 'webRemote', level: 'warn', message: 'E2E key derivation failed', meta: { error: e?.message } });
      resetE2e('failed');
      broadcastStatus();
    }
    return;
  }

  // ── Decrypt e2e:box messages ──────────────────────────────────────────────
  if (type === 'e2e:box') {
    if (!_e2e.sessionKey) {
      logs.writeLine({ scope: 'webRemote', level: 'warn', message: 'e2e:box received but no session key — dropping' });
      return;
    }
    const { nonce, ciphertext } = payload || {};
    if (!nonce || !ciphertext) return;
    const plaintext = decryptBox(nonce, ciphertext, _e2e.sessionKey);
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
  if (_e2e.sessionKey) {
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
    respond(id, { error: 'rejected' }); // opaque — reason stays in audit log only
    return;
  }

  // Allowlist check — reject unknown cmd:* types with opaque error (oracle prevention)
  if (!ALLOWED_COMMANDS.has(type)) {
    await auditLog(ts, type, device.deviceId, id, 'error:not_allowed');
    respond(id, { error: 'rejected' });
    return;
  }

  // MUTATE tier gate — write/exec commands require remoteControlEnabled=true (default false)
  if (MUTATE_COMMANDS.has(type) && !cfg.remoteControlEnabled) {
    await auditLog(ts, type, device.deviceId, id, 'error:not_allowed');
    respond(id, { error: 'rejected' }); // opaque — reason stays in audit log only
    return;
  }

  // E2E auth gate — MUTATE and sensitive READ commands are blocked until the
  // user confirms the SAS on the desktop. This prevents a compromised relay
  // from exfiltrating session lists, PRDs, run logs, or transcript summaries
  // by completing the ECDH handshake without the user's knowledge.
  if ((MUTATE_COMMANDS.has(type) || SAS_GATED_READS.has(type)) && _e2e.state !== 'authenticated') {
    await auditLog(ts, type, device.deviceId, id, 'error:e2e_not_authenticated');
    respond(id, { error: 'rejected' }); // opaque — reason stays in audit log only
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
    result = { error: 'rejected' }; // opaque on-wire — reason stays in audit log only
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
    if (_e2e.sessionKey && !typeOverride) {
      const { nonce, ciphertext } = encryptBox(JSON.stringify(inner), _e2e.sessionKey);
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

    // v2 mobile: start/stop pushing live state + summary for a session.
    'cmd:session:subscribe': async (payload) => {
      const parsed = schemas.sessionSubscribe.parse(payload);
      validatePath(parsed.cwd); // home-dir boundary before any fs access
      startSessionWatch(parsed.tabId, parsed.cwd);
      return { ok: true };
    },

    'cmd:session:unsubscribe': async (payload) => {
      const parsed = schemas.ptyTabId.parse(payload);
      stopSessionWatch(parsed.tabId);
      return { ok: true };
    },
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
    response = await httpsPost(`${RELAY_API_BASE}/pair`, body);
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
    const connected = _ws !== null && _ws.readyState === WebSocket.OPEN;
    return {
      enabled: cfg.remoteEnabled,
      remoteControlEnabled: cfg.remoteControlEnabled ?? false,
      connected,
      e2eActive: connected && _e2e.sessionKey !== null,
      e2eAuthenticated: connected && _e2e.state === 'authenticated',
      e2eState: connected ? _e2e.state : 'idle',
      pendingSas: connected && _e2e.state === 'pending_sas' ? _e2e.pendingSas : null,
      devices: (cfg.devices || []).map(({ deviceId, deviceName, issuedAt, lastConnectedAt }) => ({
        deviceId, deviceName, issuedAt, lastConnectedAt,
      })),
    };
  });

  // User confirmed that the SAS shown on both desktop and browser match.
  // Returns ok:false if the session is not in the pending_sas state (e.g. key
  // missing, already failed, already authenticated, or reconnected).
  ipcMain.handle('webRemote:confirm-sas', async () => {
    const { ok, error, next } = confirmSasLogic(_e2e);
    if (!ok) {
      logs.writeLine({ scope: 'webRemote', level: 'warn', message: 'confirm-sas rejected — wrong state', meta: { state: _e2e.state, error } });
      return { ok: false, error };
    }
    _e2e = next;
    logs.writeLine({ scope: 'webRemote', level: 'info', message: 'E2E session authenticated — SAS confirmed by user' });
    broadcastStatus();
    // Flush the session list immediately — the push loop was suppressed while
    // state !== 'authenticated', so the mobile app would otherwise wait up to
    // SESSION_LIST_PUSH_MS for the first useful data.
    _lastSessionListJson = null;
    pushSessionList().catch(() => {});
    return { ok: true };
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

  ipcMain.handle('webRemote:enable-control', async () => {
    const cfg = await loadConfig();
    await saveConfig({ ...cfg, remoteControlEnabled: true });
    broadcastStatus();
    return { ok: true };
  });

  ipcMain.handle('webRemote:disable-control', async () => {
    const cfg = await loadConfig();
    await saveConfig({ ...cfg, remoteControlEnabled: false });
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
  resetE2e();
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
