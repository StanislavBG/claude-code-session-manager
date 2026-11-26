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
const { sendIfAlive, setRemoteFanout } = require('./lib/sendToRenderer.cjs');
const { claudeHome } = require('./lib/scheduler/schedulerPaths.cjs');
const { schemas } = require('./ipcSchemas.cjs');
const { makeState, confirmSas: confirmSasLogic } = require('./lib/e2eStateMachine.cjs');
const { createClientSessions, LEGACY_CLIENT_KEY } = require('./lib/feedback-remote/remoteClientSessions.cjs');

// ─── Constants ───────────────────────────────────────────────────────────────

// Hard-coded wss:// — no configuration allows plaintext downgrade (ADR §5.1).
// v2: relay is same-origin on bilko.run (ARCHITECTURE-V2-MOBILE.md §1). REST under
// /api/sm-relay; WS upgrade at /projects/session-manager/relay (covered by host CSP
// connect-src 'self').
const RELAY_HTTPS_BASE = 'https://bilko.run';
const RELAY_API_BASE = `${RELAY_HTTPS_BASE}/api/sm-relay`;
const RELAY_WSS_URL = 'wss://bilko.run/projects/session-manager/relay';

const CONFIG_PATH = path.join(claudeHome(), 'session-manager', 'web-remote.json');
const AUDIT_LOG_DIR = path.join(claudeHome(), 'session-manager', 'logs');

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
// Implemented in ./lib/feedback-remote/remoteE2eCrypto.cjs (shared with the desktop client role).
const { generateE2EKeyPair, deriveSessionKey, deriveSas, encryptBox, decryptBox } = require('./lib/feedback-remote/remoteE2eCrypto.cjs');

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
let _repairNeeded = false; // relay rejected the device token (invalid_token / 401): terminal until re-pair
let _destroyed = false; // set at app shutdown to stop reconnect loops
let _frameAssembler = null; // inbound e2e:frame reassembly (lazy; reset with all clients)
let _frameSweepTimer = null;
const FRAME_SWEEP_MS = 30_000;

// Abilities this desktop advertises in event:remote:ready; web clients only send
// boxed e2e:frame sequences to desktops listing 'e2e-frames'.
const REMOTE_CAPABILITIES = Object.freeze(['e2e-frames', 'chat-images']);

function getFrameAssembler() {
  if (!_frameAssembler) {
    const { createFrameAssembler } = require('./lib/feedback-remote/remoteFrameAssembler.cjs');
    _frameAssembler = createFrameAssembler();
  }
  return _frameAssembler;
}

function startFrameSweep() {
  stopFrameSweep();
  _frameSweepTimer = setInterval(() => { if (_frameAssembler) _frameAssembler.sweep(); }, FRAME_SWEEP_MS);
  _frameSweepTimer.unref?.();
}

function stopFrameSweep() {
  if (_frameSweepTimer) { clearInterval(_frameSweepTimer); _frameSweepTimer = null; }
}

// E2E session state — reset on each new WS connection.
// .state: 'idle' | 'pending_sas' | 'authenticated' | 'failed'
// One record per connected client (keyed by relay-stamped fromConn, else 'legacy').
// Each holds its own ECDH session key + SAS state, the browser pubkey that produced
// it, and the deviceId it arrived on (for TOFU pinning on manual SAS confirmation).
const _clients = createClientSessions();

// ─── Config helpers ───────────────────────────────────────────────────────────

function defaultConfig() {
  return { remoteEnabled: false, remoteControlEnabled: false, devices: [] };
}

// Retired desktop-to-desktop clients: drop pins that came from one (clientId is a
// string) so a leftover keypair is never auto-trusted; strip clientId from the rest.
function pruneDesktopPins(cfg) {
  if (!cfg || !Array.isArray(cfg.devices)) return cfg;
  const devices = cfg.devices.map((d) => {
    if (!d || !Array.isArray(d.verifiedPeerPubKeys)) return d;
    const verifiedPeerPubKeys = d.verifiedPeerPubKeys
      .filter((p) => !(p && typeof p === 'object' && typeof p.clientId === 'string'))
      .map((p) => {
        if (!p || typeof p !== 'object') return p;
        const { clientId: _drop, ...rest } = p;
        return rest;
      });
    return { ...d, verifiedPeerPubKeys };
  });
  return { ...cfg, devices };
}

// Delete the orphaned desktop-client files. Never throws.
function removeOrphanedClientFiles(dir) {
  for (const name of ['remote-peers.json', 'relay-client.json']) {
    try { fs.rmSync(path.join(dir, name), { force: true }); } catch { /* best effort */ }
  }
}

function loadConfigSync() {
  const now = Date.now();
  if (_configCache && now - _configCacheAt < CONFIG_CACHE_TTL_MS) {
    return _configCache;
  }
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    _configCache = pruneDesktopPins({ ...defaultConfig(), ...JSON.parse(raw) });
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
    _configCache = pruneDesktopPins({ ...defaultConfig(), ...JSON.parse(raw) });
  } catch {
    _configCache = defaultConfig();
  }
  _configCacheAt = now;
  return _configCache;
}

// Device token of the first paired device in web-remote.json, or null. Read regardless of
// remoteEnabled: website feedback (feedbackRelayClient) is a capability separate from remote
// control. Never log or return the token anywhere else.
function getLinkedDeviceToken() {
  const cfg = loadConfigSync();
  const device = (Array.isArray(cfg.devices) ? cfg.devices : []).find(
    (d) => d && typeof d.deviceToken === 'string' && d.deviceToken.length > 0,
  );
  return device ? device.deviceToken : null;
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

// Format: <ISO>  <type>  deviceId=<id>  client=<connKey|->  msgId=<uuid>  result=ok|error:<code>
// NEVER log token values or payload content.
async function auditLog(ts, type, deviceId, msgId, result, client) {
  try {
    const ymd = ts.slice(0, 10);
    const logPath = path.join(AUDIT_LOG_DIR, `remote-audit-${ymd}.log`);
    const clean = (s) => String(s ?? '').replace(/[\r\n\t]+/g, ' ').slice(0, 200);
    const line = `${ts}  ${clean(type)}  deviceId=${clean(deviceId) || '-'}  client=${clean(client && (client.key)) || '-'}  msgId=${clean(msgId) || '-'}  result=${result}\n`;
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

/**
 * One relay REST call that never throws on an HTTP status: resolves
 * { status, json } (json = parsed body or {}), or { status: 0, error } on a
 * network failure. Never logs the request (it carries the device token).
 */
function relayRequest(method, url, { body, token } = {}) {
  return new Promise((resolve) => {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') {
      resolve({ status: 0, json: {}, error: 'Only https:// allowed for relay API calls' });
      return;
    }
    const payload = body === undefined ? null : JSON.stringify(body);
    /** @type {Record<string, string | number>} */
    const headers = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    if (payload !== null) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(payload);
    }
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    const req = https.request({
      hostname: parsed.hostname,
      port: parsed.port || 443,
      path: parsed.pathname + (parsed.search || ''),
      method,
      headers,
      rejectUnauthorized: true,
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        let json = {};
        try { json = JSON.parse(data); } catch { /* non-JSON body */ }
        done({ status: res.statusCode || 0, json: json && typeof json === 'object' ? json : {} });
      });
    });
    req.on('error', (e) => done({ status: 0, json: {}, error: e?.message || 'relay request failed' }));
    req.setTimeout(15_000, () => { req.destroy(new Error('timeout')); });
    if (payload !== null) req.write(payload);
    req.end();
  });
}

/** Map a non-2xx relay reply to the renderer-facing error string. */
function relayErrorOf(r) {
  if (r.status === 404 || r.status === 405) return 'relay_unsupported';
  if (r.status === 401) return 'device_token_invalid';
  if (r.status === 429) return 'rate_limited';
  if (r.status === 0) return r.error || 'relay request failed';
  return typeof r.json?.error === 'string' && r.json.error ? r.json.error.slice(0, 200) : `HTTP ${r.status}`;
}

const isOk = (r) => r.status >= 200 && r.status < 300;

// Per-client-key time of the last e2e:rekey sent, so a burst of stale boxes yields one rekey.
const REKEY_THROTTLE_MS = 5000;
const _lastRekeyMs = new Map();

// ─── E2E state helpers ────────────────────────────────────────────────────────

// Tear down every client session (connection-level reset).
function resetE2e() {
  _lastRekeyMs.clear();
  teardownAllClients();
}

// Mark one client's session failed without touching any other client.
function failClient(client) {
  if (_frameAssembler) _frameAssembler.dropClient(client.key);
  client.e2e = makeState('failed');
  client.peerPubKey = null;
  client.deviceId = null;
}

function makeClientlessState() {
  return { e2e: makeState() };
}

function anyAuthenticated() {
  return _clients.authenticated().length > 0;
}

// Every client currently awaiting SAS confirmation.
// Service clients confirm through confirmServiceSas only (their key never becomes a device pin).
function pendingClients() {
  return _clients.values().filter((r) => r.e2e.state === 'pending_sas' && r.role !== 'service');
}

const MAX_PINNED_PEER_KEYS = 20;

// True when `pubKey` is pinned on `device` (new list, or the legacy single key — read-only compat).
function isPinnedPeerKey(device, pubKey) {
  if (!pubKey) return false;
  if (device.verifiedPeerPubKey && device.verifiedPeerPubKey === pubKey) return true;
  return Array.isArray(device.verifiedPeerPubKeys) && device.verifiedPeerPubKeys.some((p) => p && p.pubKey === pubKey);
}

// Append a pin (never removing another client's), dedupe by pubKey, keep the newest MAX.
function addPinnedPeerKey(device, pubKey) {
  const prev = Array.isArray(device.verifiedPeerPubKeys) ? device.verifiedPeerPubKeys : [];
  const next = prev.filter((p) => p && p.pubKey !== pubKey);
  next.push({ pubKey, pinnedAt: new Date().toISOString() });
  return next.slice(-MAX_PINNED_PEER_KEYS);
}

// ─── WebSocket lifecycle ──────────────────────────────────────────────────────

// Single source of truth for the status payload shape shared by the
// broadcast push (webRemote:status) and the get-status IPC pull — both must
// report the same connected/e2e/device view of `cfg` + `_ws`/`_clients` module state.
function computeStatus(cfg) {
  const connected = _ws !== null && _ws.readyState === WebSocket.OPEN;
  const authed = _clients.authenticated()[0] || null;
  // The phone SAS prompt never shows a paired service's code (confirmServiceSas owns that).
  const pending = _clients.values().find((r) => r.e2e.state === 'pending_sas' && r.role !== 'service') || null;
  const shown = authed || pending || _clients.values()[0] || null;
  const e2eState = shown ? shown.e2e.state : 'idle';
  return {
    enabled: cfg.remoteEnabled,
    remoteControlEnabled: cfg.remoteControlEnabled ?? false,
    connected,
    linkState: _repairNeeded ? 'repair-needed' : 'ok',
    e2eActive: connected && _clients.values().some((r) => r.e2e.sessionKey !== null),
    e2eAuthenticated: connected && authed !== null,
    e2eState: connected ? e2eState : 'idle',
    pendingSas: connected && !authed && pending ? pending.e2e.pendingSas : null,
    clients: _clients.values().map((r) => ({
      key: r.key,
      state: r.e2e.state,
      pendingSas: r.e2e.state === 'pending_sas' ? r.e2e.pendingSas : null,
      ...(r.role === 'service' ? { role: 'service', pairingId: r.pendingPairingId ?? null } : {}),
    })),
    devices: (cfg.devices || []).map(({ deviceId, deviceName, issuedAt, lastConnectedAt }) => ({
      deviceId, deviceName, issuedAt, lastConnectedAt,
    })),
  };
}

function broadcastStatus() {
  if (!_window || _window.isDestroyed()) return;
  const cfg = loadConfigSync();
  sendIfAlive(_window, 'webRemote:status', computeStatus(cfg));
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
  stopFrameSweep();
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
  // Use the most recently paired credential. The relay persists device tokens in its
  // DB, but a revoked or superseded credential can still 401 forever; picking the
  // newest lets a fresh re-pair recover.
  const device = devices
    .filter((d) => d.deviceToken)
    .sort((a, b) => String(b.issuedAt || '').localeCompare(String(a.issuedAt || '')))[0];
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
    // invalid_token / 401 is final (device unpaired server-side): retrying only
    // spams the relay. Park in repair-needed until a new pair stores a fresh token.
    if (e?.message === 'invalid_token' || e?.message === 'HTTP 401') {
      cancelReconnect();
      _repairNeeded = true;
      broadcastStatus();
      return;
    }
    scheduleReconnect();
    return;
  }
  _repairNeeded = false;

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
    startFrameSweep();
    // Update lastConnectedAt without exposing token
    invalidateConfigCache(); // a pin written since the last cached read must not be overwritten
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
    stopFrameSweep();
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

  // Belt-and-suspenders liveness: the relay also runs its own protocol-level
  // ws.ping() heartbeat, independent of our app-level JSON ping/pong. Receiving
  // that frame is proof the link is alive, so reset the missed-pong counter on it
  // too. This keeps the session up even if the relay ever stops answering the
  // app-level pings (the exact failure that silently dropped sessions every ~100s
  // before the relay learned to pong). node 'ws' auto-replies to the ping itself.
  // Relay protocol pings are not guaranteed to reach the desktop through the
  // bilko.run front proxy (observed 2026-10-17: none in 120s on a live link), so
  // they must never be used as a liveness requirement.
  ws.on('ping', () => { _missedPongs = 0; });
}

async function handleTokenRevoked(deviceId) {
  teardownAllClients();
  logs.writeLine({ scope: 'webRemote', level: 'warn', message: 'token revoked', meta: { deviceId } });
  const cfg = await loadConfig();
  const devices = (cfg.devices || []).filter((d) => d.deviceId !== deviceId);
  await saveConfig({ ...cfg, remoteEnabled: false, devices });
  broadcastStatus();
  sendIfAlive(_window, 'webRemote:token-revoked', { deviceId });
}

// ─── v2 mobile: session live state push ────────────────────────────
//
// For each subscribed tab the agent tails its transcript JSONL (reusing the
// canonical classifyLine + transcriptPath from transcripts.cjs — single source of
// truth), derives a coarse state, and pushes event:session:state on change.

const SESSION_POLL_MS = 1500;
const SESSION_INIT_TAIL_BYTES = 512 * 1024; // bound the initial read

const _sessionWatchers = new Map(); // tabId → watcher

/** Push an unsolicited event to ONE client, E2E-encrypted with its key and unicast via toConn. */
function pushEventTo(client, type, payload) {
  if (!_ws || _ws.readyState !== WebSocket.OPEN) return;
  if (!client || client.e2e.state !== 'authenticated' || !client.e2e.sessionKey) return;
  const inner = { type, id: crypto.randomUUID(), payload, ts: Date.now() };
  try {
    const { nonce, ciphertext } = encryptBox(JSON.stringify(inner), client.e2e.sessionKey);
    const out = { type: 'e2e:box', id: inner.id, payload: { nonce, ciphertext }, ts: Date.now() };
    if (client.key !== LEGACY_CLIENT_KEY) out.toConn = client.key;
    _ws.send(JSON.stringify(out));
  } catch (e) {
    logs.writeLine({ scope: 'webRemote', level: 'warn', message: 'pushEvent failed', meta: { type, error: e?.message } });
  }
}

/** Authenticated clients subscribed to a tab's session state. */
function subscribersOf(tabId) {
  return _clients.authenticated().filter((c) => c.subscriptions.has(tabId));
}

/** Stop every shared session watcher that no client subscribes to any more. */
function pruneSessionWatchers() {
  for (const tabId of Array.from(_sessionWatchers.keys())) {
    if (!_clients.values().some((c) => c.subscriptions.has(tabId))) stopSessionWatch(tabId);
  }
}

/** Tear down one client (its PTY streams + subscriptions) without touching others. */
function teardownClient(key) {
  _lastRekeyMs.delete(key);
  if (_frameAssembler) _frameAssembler.dropClient(key);
  const rec = _clients.teardown(key);
  pruneSessionWatchers();
  return rec;
}

/** Tear down every client — no client keeps a PTY stream or subscription afterwards. */
function teardownAllClients() {
  _frameAssembler = null; // drops every client's partial frames
  const n = _clients.teardownAll();
  pruneSessionWatchers();
  return n;
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
    // Drop the first fragment only when offset genuinely landed mid-line —
    // i.e. the byte immediately before `start` is not '\n'. When `start`
    // sits right on a newline boundary (previous poll ended at a complete
    // line) the first split-part is already a full line and must be kept.
    let dropFirst = false;
    if (start > 0) {
      const prev = Buffer.alloc(1);
      await fd.read(prev, 0, 1, start - 1);
      dropFirst = prev[0] !== 0x0a; // 0x0a = '\n'
    }
    const len = stat.size - start;
    const buf = Buffer.alloc(len);
    await fd.read(buf, 0, len, start);
    // Shift before filter: the fragment may be an empty string (when the
    // buffer starts with '\n', completing the previous partial line). If we
    // filter(Boolean) first, the empty fragment disappears and shift() would
    // remove the first valid line instead.
    const parts = buf.toString('utf8').split('\n');
    if (dropFirst && parts.length) parts.shift();
    return { lines: parts.filter(Boolean), size: stat.size, inode: stat.ino };
  } finally {
    await fd.close();
  }
}

async function pollSessionWatcher(w) {
  // The transcript may not exist yet (new session) or may live under another
  // project/worktree encoding: re-resolve while the watched file is missing.
  // An agent-CLI (non-Claude) Epic's transcript lives under agentCliSessionStore.
  if (!fs.existsSync(w.filePath)) {
    try {
      const agentPath = require('./lib/remoteTranscriptTail.cjs').agentCliTranscriptPath(w.sessionId);
      const next = agentPath ?? require('./transcripts.cjs').transcriptPath(w.cwd, w.sessionId);
      if (next && next !== w.filePath) {
        if (!agentPath) validatePath(next);
        w.filePath = next;
        w.offset = null;
        w.inode = undefined;
      }
    } catch { /* keep the old path */ }
  }
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
  for (const line of res.lines) {
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    const events = require('./transcripts.cjs').classifyLine(obj);
    for (const ev of events) {
      const s = deriveState(ev, obj);
      if (s) nextState = s;
    }
  }

  if (nextState && nextState !== w.state) {
    w.state = nextState;
    // Guard: don't push state if SAS not yet confirmed (watcher may outlive an auth reset).
    for (const c of subscribersOf(w.tabId)) {
      pushEventTo(c, 'event:session:state', { tabId: w.tabId, state: w.state, since: Date.now() });
    }
  }
}

function startSessionWatch(tabId, cwd, sessionId = tabId) {
  if (_sessionWatchers.has(tabId)) return;
  const claudePath = require('./transcripts.cjs').transcriptPath(cwd, sessionId);
  // Defense in depth: the schema restricts tabId charset, but re-validate the
  // FINAL joined path against the home-dir boundary (validatePath resolves
  // symlinks + rejects escapes) before any fs read. Throws → dispatch drops it.
  validatePath(claudePath);
  // Agent-CLI Epics: the store builds this path from a UUID-validated id under
  // its own state root (never throws — a bad id resolves to null).
  const filePath = require('./lib/remoteTranscriptTail.cjs').agentCliTranscriptPath(sessionId) ?? claudePath;
  const w = {
    tabId, cwd, sessionId, filePath,
    offset: null,       // null → first poll reads a bounded tail then tracks EOF
    inode: undefined,
    state: 'idle',
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
}

/**
 * Shared finish-up for any path that transitions a client's e2e state into 'authenticated'
 * (manual SAS confirmation or pinned-key auto-trust): log, broadcast the new
 * status, and tell that one client it may start requesting (event:remote:ready).
 */
function finalizeE2eAuthenticated(logMessage, client) {
  logs.writeLine({ scope: 'webRemote', level: 'info', message: logMessage });
  broadcastStatus();
  if (client && loadConfigSync().remoteEnabled) pushEventTo(client, 'event:remote:ready', { ts: Date.now(), capabilities: [...REMOTE_CAPABILITIES] });
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

  // Relay notice that a browser closed: tear down only that client. Never a command.
  if (type === 'event:client:disconnected') {
    const key = _clients.clientKeyOf({ fromConn: envelope.fromConn ?? payload?.fromConn });
    if (key !== LEGACY_CLIENT_KEY) {
      const reason = envelope.reason ?? payload?.reason;
      const rec = teardownClient(key);
      await auditLog(new Date().toISOString(), 'client:disconnected', device.deviceId, id,
        `reason=${String(reason ?? '-').replace(/[^\w:.-]/g, '_').slice(0, 40)}`, rec || { key });
      broadcastStatus();
    }
    return;
  }

  // Per-client E2E record, keyed by the relay-stamped fromConn (else 'legacy').
  const client = _clients.getOrCreate(_clients.clientKeyOf(envelope));

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
      await auditLog(new Date().toISOString(), 'e2e:hello', device.deviceId, undefined, 'error:invalid_peer_key', client);
      failClient(client); // surface key-validation failure to UI — user must reconnect
      broadcastStatus();
      return;
    }
    // Paired service (e.g. Kiln): handled before the phone TOFU branch so a
    // service key never lands in a device's verifiedPeerPubKeys.
    if (payload?.role === 'service') {
      await handleServiceHello(envelope, device, client, browserPubKey);
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
        failClient(client);
        logs.writeLine({ scope: 'webRemote', level: 'warn', message: 'E2E SAS derivation failed — session marked failed', meta: { error: sasErr?.message } });
        broadcastStatus();
        return;
      }
      client.peerPubKey = browserPubKey;
      client.deviceId = device.deviceId;
      client.role = null; // a phone hello on this connection drops any service identity
      client.service = null;
      client.pendingPairingId = null;
      // TOFU pinning: if this exact (deviceId, browserPubKey) pair was already
      // manually SAS-confirmed once, skip pending_sas and auto-authenticate — the
      // user already verified this browser. A different/first-seen pubKey always
      // falls through to the manual pending_sas flow below, unchanged.
      // Read pins from the CURRENT config: `device` is the connect-time snapshot and
      // never sees pins that webRemote:confirm-sas wrote afterwards.
      const live = ((await loadConfig()).devices || []).find((d) => d.deviceId === device.deviceId) || device;
      if (isPinnedPeerKey(live, browserPubKey)) {
        client.e2e = makeState('authenticated', sessionKey, null);
        // ORDER IS A CONTRACT: the boxed event:remote:ready (sent inside
        // finalizeE2eAuthenticated) deliberately goes out BEFORE the plaintext e2e:ready
        // below. web/remote-app/src/ws.ts holds boxes that arrive before e2e:ready and
        // decides on sas:pending only after draining them, so the early remote:ready
        // skips the SAS prompt. Reordering brings back a flash of "confirm the 6-digit
        // code". Pinned by src/main/__tests__/web-remote-pinned-ready-order.test.cjs.
        finalizeE2eAuthenticated('E2E session auto-authenticated — pinned browser key matched', client);
        respond(id, undefined, 'e2e:ready', client);
        return;
      }
      client.e2e = makeState('pending_sas', sessionKey, pendingSas);
      logs.writeLine({ scope: 'webRemote', level: 'info', message: 'E2E session key established — SAS pending confirmation' });
      broadcastStatus();
      // Acknowledge with e2e:ready (unencrypted — session just started)
      respond(id, undefined, 'e2e:ready', client);
    } catch (e) {
      logs.writeLine({ scope: 'webRemote', level: 'warn', message: 'E2E key derivation failed', meta: { error: e?.message } });
      failClient(client);
      broadcastStatus();
    }
    return;
  }

  // ── Decrypt e2e:box messages ──────────────────────────────────────────────
  if (type === 'e2e:box') {
    if (!client.e2e.sessionKey) {
      logs.writeLine({ scope: 'webRemote', level: 'warn', message: 'e2e:box received but no session key — dropping' });
      const now = Date.now();
      if (now - (_lastRekeyMs.get(client.key) || 0) >= REKEY_THROTTLE_MS) {
        _lastRekeyMs.set(client.key, now);
        respond(id, { reason: 'no_session' }, 'e2e:rekey', client);
      }
      return;
    }
    const { nonce, ciphertext } = payload || {};
    if (!nonce || !ciphertext) return;
    const plaintext = decryptBox(nonce, ciphertext, client.e2e.sessionKey);
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
    if (inner && typeof inner === 'object' && inner.type === 'e2e:frame') {
      await handleFrame(inner, device, client);
      return;
    }
    // Dispatch as if it arrived unencrypted
    await dispatchEnvelope(inner, device, client);
    return;
  }

  // Only dispatch cmd:* type messages
  if (!type.startsWith('cmd:')) return;
  // After E2E is established, reject plaintext commands — a malicious relay cannot
  // silently downgrade the session by stripping e2e:hello (PENTEST.md §H1).
  if (client.e2e.sessionKey) {
    logs.writeLine({ scope: 'webRemote', level: 'warn', message: 'plaintext cmd rejected — e2e session active' });
    return;
  }
  await dispatchEnvelope(envelope, device, client);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * One decrypted e2e:frame slice of a browser→desktop message too large for the relay's
 * 256 KB cap. Only authenticated clients of an enabled remote are buffered; a completed
 * message goes through the normal dispatchEnvelope gates.
 */
async function handleFrame(inner, device, client) {
  if (client.e2e.state !== 'authenticated') return;
  if (!(await loadConfig()).remoteEnabled) {
    if (_frameAssembler) _frameAssembler.dropClient(client.key); // kill switch: free any partial
    return;
  }
  const payload = inner.payload;
  const result = getFrameAssembler().accept(client.key, payload);
  if (result.status === 'complete') {
    await dispatchEnvelope(result.envelope, device, client);
    return;
  }
  if (result.status !== 'refused') return;
  const msgId = payload && typeof payload.msgId === 'string' && UUID_RE.test(payload.msgId) ? payload.msgId : undefined;
  await auditLog(new Date().toISOString(), 'e2e:frame', device.deviceId, msgId, `refused:${result.reason}`, client);
  if (msgId) respond(msgId, { error: 'rejected' }, undefined, client);
}

const IPC_INVOKE_MAX_CALLS = 50;
let _ipcDispatcher = null;

/** Install the shared renderer-handler dispatcher (built in index.cjs). */
function setIpcDispatcher(dispatcher) {
  _ipcDispatcher = dispatcher;
}

/** Encrypt + unicast one ipc:result frame to the calling client (never plaintext). */
function sendIpcResult(callId, frame, client) {
  if (!_ws || _ws.readyState !== WebSocket.OPEN) return;
  if (!client || !client.e2e.sessionKey) return;
  try {
    const inner = { type: 'ipc:result', id: callId, seq: frame.seq, total: frame.total, data: frame.data, ts: Date.now() };
    const { nonce, ciphertext } = encryptBox(JSON.stringify(inner), client.e2e.sessionKey);
    // The relay's envelope schema requires a UUID `id` and DROPS anything else (invalid_envelope), so the
    // outer id is always a fresh UUID. Batched replies are keyed `<uuid>.<n>`; that key rides inside the box.
    const out = { type: 'e2e:box', id: crypto.randomUUID(), payload: { nonce, ciphertext }, ts: Date.now() };
    if (client.key !== LEGACY_CLIENT_KEY) out.toConn = client.key;
    _ws.send(JSON.stringify(out));
  } catch (e) {
    logs.writeLine({ scope: 'webRemote', level: 'warn', message: 'ipc:result send failed', meta: { error: e?.message } });
  }
}

/** Batched ipc:invoke — each call runs through the shared dispatcher (same handlers as the renderer). */
async function dispatchIpcInvoke(envelope, device, client) {
  const { id, payload } = envelope;
  const ts = new Date().toISOString();
  const calls = payload && Array.isArray(payload.calls) ? payload.calls : null;
  const valid = calls && calls.length >= 1 && calls.length <= IPC_INVOKE_MAX_CALLS &&
    calls.every((c) => c && typeof c === 'object' && typeof c.channel === 'string' && c.channel.length > 0 &&
      c.channel.length <= 200 && (c.args === undefined || Array.isArray(c.args)));
  if (!valid || typeof id !== 'string' || !id || !_ipcDispatcher) {
    await auditLog(ts, 'ipc:invoke', device.deviceId, id, 'error:rejected', client);
    respond(id, { error: 'rejected' }, undefined, client);
    return;
  }
  const { chunkFrames } = require('./lib/feedback-remote/remoteIpcDispatch.cjs');
  for (let i = 0; i < calls.length; i++) {
    const { channel, args } = calls[i];
    let out;
    let audit;
    try {
      const r = await _ipcDispatcher.invoke(client, channel, args ?? []);
      if (r.ok) { out = { ok: true, result: r.result }; audit = 'ok'; }
      else { out = { ok: false, error: 'rejected' }; audit = `refused:${r.reason}`; }
    } catch (e) {
      out = { ok: false, error: 'rejected' };
      audit = 'refused:dispatch_error';
    }
    let chunked = chunkFrames(out);
    if (!chunked.ok) {
      chunked = chunkFrames({ ok: false, error: 'rejected' });
      if (out.ok) audit = 'refused:too_large';
    }
    await auditLog(ts, `ipc:${channel}`, device.deviceId, id, audit, client);
    for (const frame of chunked.frames) sendIpcResult(`${id}.${i}`, frame, client);
  }
}

/** asset:manifest / asset:get — E2E-authenticated only; reply is chunked ipc:result-style frames, unicast. */
async function dispatchAsset(envelope, device, client) {
  const { type, id, payload } = envelope;
  const ts = new Date().toISOString();
  if (typeof id !== 'string' || !id || client.e2e.state !== 'authenticated' || !client.e2e.sessionKey) {
    await auditLog(ts, type, device.deviceId, id, 'refused:e2e_not_authenticated', client);
    respond(id, { error: 'rejected' }, undefined, client);
    return;
  }
  const { chunkFrames } = require('./lib/feedback-remote/remoteIpcDispatch.cjs');
  const assets = require('./lib/feedback-remote/remoteAssets.cjs');
  let out;
  let audit = 'ok';
  try {
    if (type === 'asset:manifest') out = { ok: true, result: assets.assetManifest() };
    else {
      const r = assets.readAsset(payload && payload.name);
      if (r.ok) out = { ok: true, result: r };
      else { out = { ok: false, error: 'rejected' }; audit = `refused:${r.error}`; }
    }
  } catch {
    out = { ok: false, error: 'rejected' };
    audit = 'refused:asset_error';
  }
  let chunked = chunkFrames(out);
  if (!chunked.ok) { chunked = chunkFrames({ ok: false, error: 'rejected' }); audit = 'refused:too_large'; }
  await auditLog(ts, type, device.deviceId, id, audit, client);
  for (const frame of chunked.frames) sendIpcResult(id, frame, client);
}

// ─── ipc:subscribe push fanout ─────────────────────────────────────
// Mirrors sendIfAlive pushes to E2E-authenticated browser clients that subscribed.

const IPC_SUBSCRIBE_MAX_CHANNELS = 50;

/** True iff the apiSurface lists `channel` as a push (on / on-dynamic) with remote not deny. */
function isPushableChannel(channel) {
  if (typeof channel !== 'string' || channel.length === 0 || channel.length > 200) return false;
  const surface = require('../preload/apiSurface.cjs');
  return surface.some((r) => {
    if (r.remote === 'deny') return false;
    if (r.kind === 'on') return r.channel === channel;
    if (r.kind === 'on-dynamic') {
      const prefix = r.channel.endsWith('*') ? r.channel.slice(0, -1) : r.channel;
      return channel.length > prefix.length && channel.startsWith(prefix);
    }
    return false;
  });
}

function handleIpcSubscribe(envelope, client, subscribe) {
  const channels = envelope.payload && Array.isArray(envelope.payload.channels) ? envelope.payload.channels : [];
  if (!client.pushChannels) client.pushChannels = new Set();
  for (const ch of channels.slice(0, IPC_SUBSCRIBE_MAX_CHANNELS)) {
    if (subscribe) { if (isPushableChannel(ch)) client.pushChannels.add(ch); }
    else client.pushChannels.delete(ch);
  }
}

/** Encrypt + unicast one ipc:event frame to one subscribed client. */
function sendIpcEvent(client, channel, frame) {
  if (!_ws || _ws.readyState !== WebSocket.OPEN) return;
  if (!client.e2e.sessionKey) return;
  const inner = { type: 'ipc:event', id: crypto.randomUUID(), channel, seq: frame.seq, total: frame.total, data: frame.data, ts: Date.now() };
  const { nonce, ciphertext } = encryptBox(JSON.stringify(inner), client.e2e.sessionKey);
  const out = { type: 'e2e:box', id: inner.id, payload: { nonce, ciphertext }, ts: Date.now() };
  if (client.key !== LEGACY_CLIENT_KEY) out.toConn = client.key;
  _ws.send(JSON.stringify(out));
}

function fanoutIpcEvent(channel, payload) {
  const targets = _clients.authenticated().filter((c) => c.pushChannels && c.pushChannels.has(channel));
  if (targets.length === 0) return;
  const { chunkFrames } = require('./lib/feedback-remote/remoteIpcDispatch.cjs');
  const chunked = chunkFrames(payload);
  if (!chunked.ok) return;
  for (const client of targets) {
    try {
      for (const frame of chunked.frames) sendIpcEvent(client, channel, frame);
    } catch (e) {
      logs.writeLine({ scope: 'webRemote', level: 'warn', message: 'ipc:event send failed', meta: { error: e?.message } });
    }
  }
}

// ─── Paired services (servicePairings.cjs + serviceMcpSession.cjs) ───────────
// A service connects through the relay like the phone, says role:'service' in
// its e2e:hello, and may only send boxed cmd:mcp (MCP JSON-RPC 2.0), answered
// over adminHttp.invoke. It never gets phone commands, ipc:*, asset:* or pins.

let _serviceInvoker = null;
let _serviceStore = null;

/** Install the in-process admin route caller (localAdminHttp invoke), bound in index.cjs. */
function setServiceInvoker(fn) {
  _serviceInvoker = typeof fn === 'function' ? fn : null;
}

/** The paired-services store (one per process; remote-services.json under claudeHome). */
function getServiceStore() {
  if (!_serviceStore) {
    const { createServicePairings } = require('./lib/feedback-remote/servicePairings.cjs');
    _serviceStore = createServicePairings();
  }
  return _serviceStore;
}

/** Relay client ids are UUIDs only; anything else is dropped. */
function relayClientIdOf(v) {
  return typeof v === 'string' && UUID_RE.test(v) ? v.toLowerCase() : null;
}

/** Audit-safe token (tool or method names come from the caller). */
function auditToken(v) {
  return String(v ?? '-').replace(/[^\w:.-]/g, '_').slice(0, 64) || '-';
}

/** Drop a client's service identity + key and mark it failed. */
function failServiceClient(client) {
  failClient(client);
  client.role = null;
  client.service = null;
  client.pendingPairingId = null;
  client.relayClientId = null;
}

async function handleServiceHello(envelope, device, client, peerPubKey) {
  const { id, payload } = envelope;
  const ts = new Date().toISOString();
  if (client.key === LEGACY_CLIENT_KEY) {
    // A service must be relay-stamped: replies are unicast to its connection.
    await auditLog(ts, 'service:unpaired', device.deviceId, id, 'refused:no_conn', client);
    failServiceClient(client);
    broadcastStatus();
    return;
  }
  const store = getServiceStore();
  let sessionKey;
  let sas;
  try {
    sessionKey = deriveSessionKey(device.e2ePrivateKey, peerPubKey, device.deviceId);
    sas = deriveSas(device.e2ePrivateKey, peerPubKey, device.deviceId);
  } catch (e) {
    logs.writeLine({ scope: 'webRemote', level: 'warn', message: 'service E2E key derivation failed', meta: { error: e?.message } });
    await auditLog(ts, 'service:hello', device.deviceId, id, 'error:key_derivation', client);
    failServiceClient(client);
    broadcastStatus();
    return;
  }
  const relayClientId = relayClientIdOf(payload?.clientId);

  const pinned = store.findByPubKey(peerPubKey);
  if (pinned) {
    client.role = 'service';
    client.service = pinned;
    client.pendingPairingId = null;
    client.relayClientId = relayClientId;
    client.peerPubKey = peerPubKey;
    client.deviceId = device.deviceId;
    client.e2e = makeState('authenticated', sessionKey, null);
    store.touchLastSeen(pinned.serviceId).catch(() => {});
    await auditLog(ts, 'service:hello', device.deviceId, id, `ok:service=${auditToken(pinned.serviceId)}`, client);
    finalizeE2eAuthenticated('paired service authenticated — pinned key matched', client);
    respond(id, undefined, 'e2e:ready', client);
    return;
  }

  const pending = store.listPending();
  const wanted = typeof payload?.pairingId === 'string' ? payload.pairingId : null;
  const pairing = wanted
    ? pending.find((p) => p.pairingId === wanted) || null
    : pending.slice().sort((a, b) => b.createdAt - a.createdAt)[0] || null;
  if (!pairing) {
    await auditLog(ts, 'service:unpaired', device.deviceId, id, 'refused', client);
    failServiceClient(client);
    broadcastStatus();
    return;
  }
  client.role = 'service';
  client.service = null;
  client.pendingPairingId = pairing.pairingId;
  client.relayClientId = relayClientId;
  client.peerPubKey = peerPubKey;
  client.deviceId = device.deviceId;
  client.e2e = makeState('pending_sas', sessionKey, sas);
  await auditLog(ts, 'service:hello', device.deviceId, id, 'pending_sas', client);
  logs.writeLine({ scope: 'webRemote', level: 'info', message: 'paired service key established — SAS pending confirmation' });
  broadcastStatus();
  respond(id, undefined, 'e2e:ready', client);
}

/**
 * Owner confirmed a pending service's SAS: check it against that client's own
 * SAS, then pin the key via store.confirmPending. Returns { ok, service } or { ok:false, error }.
 */
async function confirmServiceSas(pairingId, sas, { via } = {}) {
  const target = _clients.values().find((c) => c.role === 'service' && c.pendingPairingId === pairingId) || null;
  if (!target) return { ok: false, error: 'no_pending_service' };
  if (target.e2e.state !== 'pending_sas' || typeof target.e2e.pendingSas !== 'string') return { ok: false, error: 'wrong_state' };
  const expected = Buffer.from(target.e2e.pendingSas, 'utf8');
  const given = Buffer.from(String(sas ?? ''), 'utf8');
  if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) {
    await auditLog(new Date().toISOString(), 'service:confirm-sas', target.deviceId, undefined, 'refused:sas_mismatch', target);
    return { ok: false, error: 'sas_mismatch' };
  }
  let service;
  try {
    service = await getServiceStore().confirmPending(pairingId, target.peerPubKey, { relayClientId: target.relayClientId });
  } catch (e) {
    await auditLog(new Date().toISOString(), 'service:confirm-sas', target.deviceId, undefined, 'error:confirm_failed', target);
    return { ok: false, error: e?.message ?? 'confirm_failed' };
  }
  // The client may have disconnected while the store write ran.
  if (_clients.get(target.key) !== target || target.e2e.state !== 'pending_sas') return { ok: false, error: 'client_gone' };
  target.e2e = confirmSasLogic(target.e2e).next;
  target.service = service;
  target.pendingPairingId = null;
  await auditLog(new Date().toISOString(), 'service:confirm-sas', target.deviceId, undefined, `${via === 'local' ? 'ok:paired-locally:' : 'ok:'}service=${auditToken(service.serviceId)}`, target);
  finalizeE2eAuthenticated('paired service authenticated — SAS confirmed by owner', target);
  return { ok: true, service };
}

// ─── Paired services: renderer IPC (pair start / list / revoke) ─────────────

const CLIENT_OTP_TTL_MS = 5 * 60 * 1000;
const CLIENT_OTP_RE = /^[A-Z0-9]{8}$/i;

/** The paired device (first with a token) whose token authorizes relay client calls, or null. */
async function pairedDevice() {
  const cfg = await loadConfig();
  return (Array.isArray(cfg.devices) ? cfg.devices : []).find(
    (d) => d && typeof d.deviceToken === 'string' && d.deviceToken.length > 0,
  ) || null;
}

/** A service as the renderer may see it: no pinned key. */
function redactService(s) {
  if (!s) return s;
  const { pubKey: _omit, ...rest } = s;
  return { ...rest, projectRoot: typeof rest.projectRoot === 'string' ? rest.projectRoot : null };
}

const PROJECT_ROOT_ERROR = 'projectRoot must be an existing folder in your home folder';

/** True when p is an absolute path to an existing directory inside the home folder. */
function isProjectRootOk(p) {
  if (typeof p !== 'string' || p.length === 0 || p.includes('\0') || !path.isAbsolute(p)) return false;
  try {
    // Resolve symlinks on both sides so a link inside home that points outside is refused.
    const real = fs.realpathSync(p);
    const rel = path.relative(fs.realpathSync(os.homedir()), real);
    if (rel === '' || rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) return false;
    return fs.statSync(real).isDirectory();
  } catch {
    return false;
  }
}

function logRelayFailure(op, r) {
  logs.writeLine({
    scope: 'webRemote', level: 'warn', message: `relay ${op} failed`,
    meta: { status: r.status, error: relayErrorOf(r) },
  });
}

async function startPairing({ name, homeCwd, scope, projectRoot }, pairedVia) {
  const device = await pairedDevice();
  if (!device) return { ok: false, error: 'no_paired_device' };
  const { SERVICE_TOOL_NAMES } = require('./lib/feedback-remote/servicePairings.cjs');
  // Refuse bad input before spending one of the account's hourly relay codes.
  if (!path.isAbsolute(homeCwd)) return { ok: false, error: 'homeCwd must be an absolute path' };
  const unknown = scope.find((t) => !SERVICE_TOOL_NAMES.includes(t));
  if (unknown) return { ok: false, error: `scope names an unknown tool: ${unknown}` };
  const wantsProjectCreate = scope.includes('project_create');
  if (wantsProjectCreate && !isProjectRootOk(projectRoot)) return { ok: false, error: PROJECT_ROOT_ERROR };

  const r = await relayRequest('POST', `${RELAY_API_BASE}/client-otp`, { body: {}, token: device.deviceToken });
  if (!isOk(r)) {
    logRelayFailure('client-otp', r);
    return { ok: false, error: relayErrorOf(r) };
  }
  const code = r.json?.code;
  if (typeof code !== 'string' || !CLIENT_OTP_RE.test(code)) return { ok: false, error: 'relay returned no code' };
  const codeExpiresAt = Date.now() + CLIENT_OTP_TTL_MS;
  let pairingId;
  try {
    ({ pairingId } = await getServiceStore().createPending({
      name, homeCwd, scope, projectRoot: wantsProjectCreate ? projectRoot : undefined, pairedVia,
    }));
  } catch (e) {
    return { ok: false, error: e?.message || 'pending pairing failed' };
  }
  await auditLog(new Date().toISOString(), 'service:pair-start', device.deviceId, undefined, pairedVia === 'local' ? 'ok:paired-locally' : 'ok', null);
  return { ok: true, code, pairingId, codeExpiresAt, deviceId: device.deviceId };
}

function servicePairStart(input) {
  return startPairing(input, 'window');
}

/** Same-machine pairing without the window: refused while Web remote is off. */
async function servicePairStartLocal(input) {
  if ((await loadConfig()).remoteEnabled !== true) return { ok: false, error: 'web_remote_off' };
  return startPairing(input, 'local');
}

/** Confirms ONLY a 'local' pending pairing; the SAS check in confirmServiceSas still applies. */
async function confirmServiceSasLocal(pairingId, sas) {
  if ((await loadConfig()).remoteEnabled !== true) return { ok: false, error: 'web_remote_off' };
  const pending = getServiceStore().listPending().find((p) => p.pairingId === pairingId);
  if (!pending || pending.pairedVia !== 'local') return { ok: false, error: 'not_local_pairing' };
  return confirmServiceSas(pairingId, sas, { via: 'local' });
}

async function servicesList() {
  const store = getServiceStore();
  const services = store.list().map(redactService);
  const pending = store.listPending().map(redactService);
  const known = new Set(services.map((s) => s.relayClientId).filter(Boolean));
  const device = await pairedDevice();
  if (!device) return { ok: true, services, pending, relayOrphans: [], relayError: 'no_paired_device' };
  const r = await relayRequest('GET', `${RELAY_API_BASE}/clients`, { token: device.deviceToken });
  if (!isOk(r)) {
    logRelayFailure('clients list', r);
    return { ok: true, services, pending, relayOrphans: [], relayError: relayErrorOf(r) };
  }
  const raw = Array.isArray(r.json) ? r.json : Array.isArray(r.json?.clients) ? r.json.clients : [];
  const relayOrphans = raw
    .filter((c) => c && typeof c.clientId === 'string' && !known.has(c.clientId.toLowerCase()))
    .map((c) => ({
      clientId: c.clientId,
      clientName: typeof c.clientName === 'string' ? c.clientName : '',
      issuedAt: typeof c.issuedAt === 'string' || typeof c.issuedAt === 'number' ? c.issuedAt : null,
    }));
  return { ok: true, services, pending, relayOrphans };
}

/** DELETE one relay client. 404 client_not_found counts as gone. */
async function deleteRelayClient(clientId, token) {
  const r = await relayRequest('DELETE', `${RELAY_API_BASE}/clients/${encodeURIComponent(clientId)}`, { token });
  if (isOk(r) || (r.status === 404 && r.json?.error === 'client_not_found')) return { ok: true };
  logRelayFailure('client delete', r);
  return { ok: false, error: relayErrorOf(r) };
}

async function serviceRevoke(serviceId) {
  const store = getServiceStore();
  const svc = store.list().find((s) => s.serviceId === serviceId);
  if (!svc) return { ok: false, error: 'no_such_service' };
  await store.revoke(serviceId);
  for (const c of _clients.values()) {
    if (c.role === 'service' && (c.service?.serviceId === serviceId || (c.peerPubKey && c.peerPubKey === svc.pubKey))) {
      teardownClient(c.key);
    }
  }
  broadcastStatus();
  let relayRevoked = false;
  const device = svc.relayClientId ? await pairedDevice() : null;
  if (svc.relayClientId && device) {
    relayRevoked = (await deleteRelayClient(svc.relayClientId, device.deviceToken)).ok;
  }
  await auditLog(new Date().toISOString(), 'service:revoke', device?.deviceId, undefined, `ok:service=${auditToken(serviceId)}`, null);
  return { ok: true, relayRevoked };
}

/**
 * Owner denied a pending pairing: drop it from the store and fail + tear down
 * any service client waiting on it, so a later hello for it is refused.
 */
async function servicePairCancel(pairingId) {
  const cancelled = await getServiceStore().cancelPending(pairingId);
  let dropped = 0;
  for (const c of _clients.values()) {
    if (c.role === 'service' && c.pendingPairingId === pairingId) {
      failServiceClient(c);
      teardownClient(c.key);
      dropped += 1;
    }
  }
  if (dropped > 0) broadcastStatus();
  const device = await pairedDevice();
  await auditLog(new Date().toISOString(), 'service:pair-cancelled', device?.deviceId || '-', undefined,
    cancelled ? `ok:dropped=${dropped}` : `noop:dropped=${dropped}`, null);
  return { ok: true, cancelled, dropped };
}

async function relayClientRevoke(clientId) {
  const device = await pairedDevice();
  if (!device) return { ok: false, error: 'no_paired_device' };
  return deleteRelayClient(clientId, device.deviceToken);
}

/** Drop every locally paired service (revoke-all). Logs, never throws. */
async function clearLocalServices() {
  try {
    const store = getServiceStore();
    for (const s of store.list()) await store.revoke(s.serviceId);
  } catch (e) {
    logs.writeLine({ scope: 'webRemote', level: 'warn', message: 'failed to clear paired services', meta: { error: e?.message } });
  }
}

/** Encrypt + unicast one boxed mcp:result to a service client (never plaintext). */
function sendMcpResult(client, msgId, response) {
  if (!_ws || _ws.readyState !== WebSocket.OPEN) return;
  if (!client.e2e.sessionKey) return;
  try {
    const inner = { type: 'mcp:result', id: msgId, payload: response, ts: Date.now() };
    const { nonce, ciphertext } = encryptBox(JSON.stringify(inner), client.e2e.sessionKey);
    const out = { type: 'e2e:box', id: crypto.randomUUID(), payload: { nonce, ciphertext }, ts: Date.now() };
    if (client.key !== LEGACY_CLIENT_KEY) out.toConn = client.key;
    _ws.send(JSON.stringify(out));
  } catch (e) {
    logs.writeLine({ scope: 'webRemote', level: 'warn', message: 'mcp:result send failed', meta: { error: e?.message } });
  }
}

// Leave room for the box envelope (base64 + nonce) under the relay's message cap.
const MCP_RESULT_MAX_BYTES = Math.floor(MSG_MAX_BYTES * 0.7);

async function dispatchServiceEnvelope(envelope, device, client) {
  const { type, id, payload } = envelope;
  const ts = new Date().toISOString();
  const auditType = typeof type === 'string' ? type : 'service:unknown';
  const reject = async (result) => {
    await auditLog(ts, auditType, device.deviceId, id, result, client);
    respond(id, { error: 'rejected' }, undefined, client); // opaque — reason stays in audit log only
  };
  if (client.role !== 'service') return reject('error:not_service');
  if (type !== 'cmd:mcp') return reject('refused:service_not_allowed');
  if (!(await loadConfig()).remoteEnabled) return reject('error:disabled');
  if (client.e2e.state !== 'authenticated' || !client.e2e.sessionKey) return reject('error:e2e_not_authenticated');
  // Re-read the pin each call so a revoke takes effect at once.
  const store = getServiceStore();
  const service = client.peerPubKey ? store.findByPubKey(client.peerPubKey) : null;
  if (!service) {
    await reject('refused:service_revoked');
    teardownClient(client.key);
    broadcastStatus();
    return;
  }
  client.service = service;
  const invoke = _serviceInvoker || (async () => { throw new Error('service invoker not installed'); });
  let outcome;
  try {
    outcome = await handleServiceMcp(payload, { service, invoke, store });
  } catch (e) {
    return reject('error:dispatch_error');
  }
  let response = outcome.response;
  let audit = outcome.audit;
  if (response && Buffer.byteLength(JSON.stringify(response), 'utf8') > MCP_RESULT_MAX_BYTES) {
    response = { jsonrpc: '2.0', id: response.id ?? null, error: { code: -32603, message: 'response too large for the relay' } };
    if (audit) audit = { ...audit, result: 'error:too_large' };
  }
  // One audit line per tool call: tool + result, never argument values.
  if (audit) await auditLog(ts, `mcp:${auditToken(audit.tool)}`, device.deviceId, id, auditToken(audit.result), client);
  if (response) sendMcpResult(client, id, response);
}

function handleServiceMcp(msg, deps) {
  return require('./lib/feedback-remote/serviceMcpSession.cjs').handleServiceMcp(msg, deps);
}

async function dispatchEnvelope(envelope, device, client) {
  const { type, id, payload } = envelope;
  // A paired service may send only cmd:mcp; a non-service client may never send it.
  if (client.role === 'service' || type === 'cmd:mcp') {
    await dispatchServiceEnvelope(envelope, device, client);
    return;
  }
  if (type === 'ipc:subscribe' || type === 'ipc:unsubscribe') {
    if (client.e2e.state === 'authenticated') handleIpcSubscribe(envelope, client, type === 'ipc:subscribe');
    return;
  }
  if (type === 'ipc:invoke') {
    await dispatchIpcInvoke(envelope, device, client);
    return;
  }
  if (type === 'asset:manifest' || type === 'asset:get') {
    await dispatchAsset(envelope, device, client);
    return;
  }
  if (typeof type !== 'string' || !type.startsWith('cmd:')) return;

  const ts = new Date().toISOString();

  // Kill switch — re-reads config with 1s TTL
  const cfg = await loadConfig();
  if (!cfg.remoteEnabled) {
    await auditLog(ts, type, device.deviceId, id, 'error:disabled', client);
    respond(id, { error: 'rejected' }, undefined, client); // opaque — reason stays in audit log only
    return;
  }

  // Allowlist check — reject unknown cmd:* types with opaque error (oracle prevention)
  if (!ALLOWED_COMMANDS.has(type)) {
    await auditLog(ts, type, device.deviceId, id, 'error:not_allowed', client);
    respond(id, { error: 'rejected' }, undefined, client);
    return;
  }

  // MUTATE tier gate — write/exec commands require remoteControlEnabled=true (default false)
  if (MUTATE_COMMANDS.has(type) && !cfg.remoteControlEnabled) {
    await auditLog(ts, type, device.deviceId, id, 'error:not_allowed', client);
    respond(id, { error: 'rejected' }, undefined, client); // opaque — reason stays in audit log only
    return;
  }

  // E2E auth gate — MUTATE and sensitive READ commands are blocked until the
  // user confirms the SAS on the desktop. This prevents a compromised relay
  // from exfiltrating session lists, PRDs, run logs, or transcript summaries
  // by completing the ECDH handshake without the user's knowledge.
  if ((MUTATE_COMMANDS.has(type) || SAS_GATED_READS.has(type)) && client.e2e.state !== 'authenticated') {
    await auditLog(ts, type, device.deviceId, id, 'error:e2e_not_authenticated', client);
    respond(id, { error: 'rejected' }, undefined, client); // opaque — reason stays in audit log only
    return;
  }

  // Dispatch
  let result;
  try {
    result = await dispatchCommand(type, payload ?? {}, client);
    await auditLog(ts, type, device.deviceId, id, auditResultFor(result), client);
  } catch (e) {
    const code = e?.name === 'ZodError' ? 'schema_invalid' : 'dispatch_error';
    await auditLog(ts, type, device.deviceId, id, `error:${code}`, client);
    result = { error: 'rejected' }; // opaque on-wire — reason stays in audit log only
  }

  respond(id, result, undefined, client);
}

/** Audit result string for a handler result: structured refusals log as refused[:reason]. */
function auditResultFor(result) {
  if (result && result.ok === false && typeof result.disposition === 'string') {
    return typeof result.reason === 'string' && result.reason ? `refused:${result.reason}` : 'refused';
  }
  return 'ok';
}

function respond(msgId, payload, typeOverride, client) {
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
    // Encrypt with the requesting client's key; unicast via toConn for relay-stamped clients.
    const out = client && client.e2e.sessionKey && !typeOverride
      ? (() => {
          const { nonce, ciphertext } = encryptBox(JSON.stringify(inner), client.e2e.sessionKey);
          return { type: 'e2e:box', id: msgId, payload: { nonce, ciphertext }, ts: Date.now() };
        })()
      : inner;
    if (client && client.key !== LEGACY_CLIENT_KEY) out.toConn = client.key;
    _ws.send(JSON.stringify(out));
  } catch (e) {
    logs.writeLine({ scope: 'webRemote', level: 'warn', message: 'respond send failed', meta: { error: e?.message } });
  }
}

// A 'project-video' macro is a background Video tool run only from the desktop's
// Project Home ▸ Video — the phone remote neither lists nor starts one.
function isRemoteMacro(macro) {
  return macro.surface !== 'project-video';
}

// Lazy-loaded dispatch map — avoids circular require at module load time.
let _dispatchMap = null;

function getDispatchMap() {
  if (_dispatchMap) return _dispatchMap;

  const sessionsStore = require('./sessionsStore.cjs');
  const chatRunner = require('./chatRunner.cjs');

  _dispatchMap = {
    'cmd:projects:list': async () => {
      const { readActiveIndex } = require('./lib/epic/epicMint.cjs');
      const { listRemoteProjects } = require('./lib/remoteDrilldown.cjs');
      const data = await sessionsStore.load();
      return { projects: listRemoteProjects(data?.tabs ?? [], readActiveIndex) };
    },

    'cmd:project:sessions': async (payload) => {
      const parsed = schemas.remoteProjectSessions.parse(payload);
      const { readActiveIndex } = require('./lib/epic/epicMint.cjs');
      const { listRemoteProjectSessions } = require('./lib/remoteDrilldown.cjs');
      const data = await sessionsStore.load();
      const result = listRemoteProjectSessions(data?.tabs ?? [], readActiveIndex, parsed.cwd);
      if (!result) throw new Error('cwd is not an open project');
      return result;
    },

    // cwd must be exactly an open tab's cwd; sessionKey is the tab's main id or
    // an Epic id / claudeSessionId from that project's active index.
    'cmd:session:transcript': async (payload) => {
      const parsed = schemas.remoteSessionTranscript.parse(payload);
      const { readActiveIndex } = require('./lib/epic/epicMint.cjs');
      const { resolveEpicTranscriptPath } = require('./lib/epic/epicTranscriptPath.cjs');
      const { readRecentChatMessages, buildRemoteConversation } = require('./lib/remoteTranscriptTail.cjs');
      const { listExchanges } = require('./exchanges.cjs');
      const data = await sessionsStore.load();
      const tab = (data?.tabs ?? []).find((t) => t && t.cwd === parsed.cwd);
      if (!tab) throw new Error('cwd is not an open project');
      validatePath(parsed.cwd);
      const limit = parsed.limit ?? 10;
      const before = parsed.before ?? 0;
      let filePath = null;
      let sessionId = null;
      if (parsed.sessionKey === tab.id || parsed.sessionKey === tab.sessionId) {
        sessionId = tab.sessionId || parsed.sessionKey;
        filePath = require('./transcripts.cjs').transcriptPath(parsed.cwd, sessionId);
      } else {
        const sessions = readActiveIndex(parsed.cwd)?.sessions ?? {};
        const epic = Object.values(sessions).find(
          (e) => e && (e.id === parsed.sessionKey || e.claudeSessionId === parsed.sessionKey),
        );
        if (epic && epic.claudeSessionId) {
          sessionId = epic.claudeSessionId;
          filePath = resolveEpicTranscriptPath({ cwd: parsed.cwd, claudeSessionId: sessionId }).path;
        }
      }
      if (!filePath || !sessionId) return { messages: [], hasMore: false, nextBefore: null };
      validatePath(filePath);
      const exchanges = await listExchanges({ cwd: parsed.cwd, sessionId, limit: limit + 1, offset: before });
      const tail = before === 0 ? await readRecentChatMessages(filePath, { limit: 30, claudeSessionId: sessionId }) : [];
      return buildRemoteConversation({ exchanges, tail, limit, before });
    },

    'cmd:session:prds': async (payload) => {
      const parsed = schemas.remoteSessionPrds.parse(payload);
      const { readActiveIndex } = require('./lib/epic/epicMint.cjs');
      const data = await sessionsStore.load();
      const tab = (data?.tabs ?? []).find((t) => t && t.cwd === parsed.cwd);
      if (!tab) throw new Error('cwd is not an open project');
      validatePath(parsed.cwd);
      const sessions = readActiveIndex(parsed.cwd)?.sessions ?? {};
      const known = Object.values(sessions).some((e) => e && e.id === parsed.epicId) || !!sessions[parsed.epicId];
      if (!known) throw new Error('unknown epic');
      const all = await require('./scheduler.cjs').listPrdsInternal();
      const prds = all
        .filter((e) => e && e.epicId === parsed.epicId)
        .map((e) => ({ slug: e.slug, title: e.title, status: e.status ?? null, archived: !!e.archived, ...(e.cancelled === true ? { cancelled: true } : {}) }))
        .sort((a, b) => Number(a.archived) - Number(b.archived) || String(a.slug).localeCompare(String(b.slug)))
        .slice(0, 50);
      return { prds };
    },

    // Web app's multi-desktop picker (SAS-gated: hostname identifies the machine).
    'cmd:app:info': async () =>
      ({ version: app.getVersion(), platform: process.platform, hostname: os.hostname() }),

    // v2 mobile: start/stop pushing live state for a session.
    'cmd:session:subscribe': async (payload, reqClient) => {
      const client = reqClient || _clients.getOrCreate(LEGACY_CLIENT_KEY);
      const parsed = schemas.sessionSubscribe.parse(payload);
      validatePath(parsed.cwd); // home-dir boundary before any fs access
      // The phone's Main row passes the tab `id`, but the transcript is keyed by the tab's `sessionId`.
      const { tabs } = await require('./sessionsStore.cjs').load();
      const tab = (Array.isArray(tabs) ? tabs : []).find((t) => t && t.id === parsed.tabId && t.cwd === parsed.cwd);
      startSessionWatch(parsed.tabId, parsed.cwd, tab?.sessionId || parsed.tabId);
      client.subscriptions.add(parsed.tabId);
      return { ok: true };
    },

    'cmd:session:unsubscribe': async (payload, reqClient) => {
      const client = reqClient || _clients.getOrCreate(LEGACY_CLIENT_KEY);
      const parsed = schemas.ptyTabId.parse(payload);
      client.subscriptions.delete(parsed.tabId);
      pruneSessionWatchers();
      return { ok: true };
    },

    // Push a prompt into an open tab's chat queue from the paired phone
    // client — in-process call, no admin HTTP hop needed since webRemote
    // already runs inside the Electron main process (PRD 753).
    'cmd:chat:send': async (payload) => {
      const result = schemas.remoteChatSend.safeParse(payload);
      if (!result.success) {
        const issues = result.error.issues;
        if (issues.length > 0 && issues.every((i) => i.path[0] === 'images')) {
          return { ok: false, disposition: 'refused', reason: 'attachment-invalid' };
        }
        throw result.error;
      }
      const parsed = result.data;
      const { readActiveIndex } = require('./lib/epic/epicMint.cjs');
      const data = await sessionsStore.load();
      const tabs = data?.tabs ?? [];
      const outcome = (r) => ({
        ok: r.disposition !== 'refused',
        disposition: r.disposition,
        ...(r.reason ? { reason: r.reason } : {}),
      });
      // 1. Resolve the target BEFORE writing anything: an open tab, or an ACTIVE
      //    Epic (by id or claudeSessionId) of an open project. Anything else is a
      //    structured refusal.
      let target = null;
      const openTab = tabs.find((t) => t && (t.sessionId === parsed.tabId || t.id === parsed.tabId));
      if (openTab) {
        target = { id: parsed.tabId, extra: undefined, projectCwd: openTab.cwd };
      } else {
        for (const tab of tabs) {
          const sessions = Object.values(readActiveIndex(tab.cwd)?.sessions ?? {});
          const epic = sessions.find((e) => e && (e.id === parsed.tabId || e.claudeSessionId === parsed.tabId));
          if (!epic) continue;
          if (epic.status !== 'active' || !epic.claudeSessionId) {
            return { ok: false, disposition: 'refused', reason: epic.status === 'proposed' ? 'proposed' : 'not-active' };
          }
          target = {
            id: epic.id,
            extra: { sessionId: epic.claudeSessionId, cwd: epic.cwd || tab.cwd },
            projectCwd: tab.cwd,
          };
          break;
        }
      }
      if (!target) return { ok: false, disposition: 'refused', reason: 'unknown-target' };

      const enqueue = (prompt) => (target.extra
        ? chatRunner.enqueueExternalPrompt(target.id, prompt, { ...target.extra, relay: 'web-remote' })
        : chatRunner.enqueueExternalPrompt(target.id, prompt, { relay: 'web-remote' }));

      const images = parsed.images ?? [];
      if (images.length === 0) return outcome(await enqueue(parsed.prompt));

      // 2. Save images under the owning open tab's project (never logged: no
      //    image data or names reach the audit trail).
      const { saveChatImages, composeAttachedPrompt, removeSavedAttachments } = require('./lib/epic/epicAttachments.cjs');
      // projectCwd is an open tab's cwd: register it with the write boundary
      // (as promptSessionsIpc does) so the save never depends on a pty having spawned.
      require('./config.cjs').addAllowedRoot(validatePath(target.projectCwd));
      const saved = await saveChatImages({ projectCwd: target.projectCwd, images });
      if (!saved.ok) return { ok: false, disposition: 'refused', reason: 'attachment-invalid' };

      // 3. Enqueue; only a definite refusal removes the files ('unconfirmed' may
      //    still land, so its files stay).
      let r;
      try {
        r = await enqueue(composeAttachedPrompt(parsed.prompt, saved.paths));
      } catch (err) {
        await removeSavedAttachments(target.projectCwd, saved.paths);
        throw err;
      }
      if (r.disposition === 'refused') await removeSavedAttachments(target.projectCwd, saved.paths);
      return { ...outcome(r), attachments: saved.names };
    },

    'cmd:session:options': async () => {
      const { EpicTagSchema } = require('./lib/promptSessionSchema.cjs');
      const agentLibrary = require('./agentLibrary.cjs');
      const macroLibrary = require('./lib/persona-macro/macroLibrary.cjs');
      const { tabs } = await sessionsStore.load();
      const personas = await agentLibrary.listPersonas();
      return {
        projects: tabs.map((t) => ({ cwd: t.cwd, title: t.label })),
        agents: personas.map((a) => ({ name: a.name, description: a.description })),
        tags: EpicTagSchema.options,
        macros: (await macroLibrary.listMacros()).filter(isRemoteMacro),
        macroInputs: true,
      };
    },

    // Input boundary: cwd must be exactly an open tab's cwd and agentName a
    // listed persona, checked before the payload goes anywhere near the fs.
    'cmd:session:create': async (payload) => {
      const parsed = schemas.remoteSessionCreate.parse(payload);
      const agentLibrary = require('./agentLibrary.cjs');
      const { tabs } = await sessionsStore.load();
      if (!tabs.some((t) => t.cwd === parsed.cwd)) throw new Error('cwd is not an open project');
      const personas = await agentLibrary.listPersonas();
      if (!personas.some((a) => a.name === parsed.agentName)) throw new Error('unknown agent');
      let prompt = parsed.prompt;
      let macroId;
      if (parsed.macroId) {
        const macroLibrary = require('./lib/persona-macro/macroLibrary.cjs');
        const macros = await macroLibrary.listMacros();
        const macro = macros.find((m) => m.id === parsed.macroId);
        if (!macro || !isRemoteMacro(macro) || !macroLibrary.macroVisibleIn(macro, parsed.cwd)) {
          throw new Error('unknown macro');
        }
        const result = macroLibrary.renderMacroPrompt(parsed.prompt, macro.inputs, parsed.inputs ?? {});
        if (!result.ok) throw new Error(result.error);
        prompt = result.prompt;
        macroId = macro.id;
      }
      chatRunner.requestExternalNewSession({
        cwd: parsed.cwd,
        agentName: parsed.agentName,
        tag: parsed.tag,
        title: parsed.title,
        prompt,
        ...(macroId ? { macroId } : {}),
      });
      return { ok: true };
    },
  };

  return _dispatchMap;
}

async function dispatchCommand(type, payload, client) {
  const map = getDispatchMap();
  const handler = map[type];
  if (!handler) throw new Error(`no handler for ${type}`);
  return handler(payload, client);
}

// ─── Pairing ─────────────────────────────────────────────────────────────────

async function pair(otp) {
  const cfg = await loadConfig();
  // Re-pairing an existing machine keeps its identity (deviceId, E2E keypair, pinned
  // phone keys) so the relay row is replaced in place and no new SAS is needed.
  // Explicit revocation empties cfg.devices, which forces a fresh identity.
  const prev = (cfg.devices || [])
    .filter((d) => d.deviceId && d.e2ePrivateKey && d.e2ePublicKey)
    .sort((a, b) => String(b.issuedAt || '').localeCompare(String(a.issuedAt || '')))[0];

  const deviceId = prev ? prev.deviceId : crypto.randomUUID();
  // E2E public key is sent to relay and stored alongside the device token so the
  // browser can do key agreement.
  const { e2ePrivateKey, e2ePublicKey } = prev
    ? { e2ePrivateKey: prev.e2ePrivateKey, e2ePublicKey: prev.e2ePublicKey }
    : generateE2EKeyPair();

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

  // A desktop only ever connects to the relay as ONE device; all of the user's
  // browsers route to it (the relay isolates by email, not per-credential). So keep
  // only the newly paired credential — accumulating stale entries is pure cruft that
  // would otherwise shadow this one and trap reconnection on a dead token.
  const now = new Date().toISOString();
  // Pins are only carried onto a deviceId the relay confirmed.
  const reused = prev && response.deviceId === deviceId;
  const devices = [reused
    ? { ...prev, deviceId, deviceToken: response.deviceToken, issuedAt: now, lastConnectedAt: null }
    : {
        deviceId: response.deviceId,
        deviceToken: response.deviceToken, // stored only on disk at 0600
        // Private key stored at 0600 — same security model as device token.
        e2ePrivateKey,
        e2ePublicKey,
        deviceName: `Device (paired ${now.slice(0, 10)})`,
        issuedAt: now,
        lastConnectedAt: null,
        // Set once a browser's SAS is manually confirmed; TOFU-pinned for auto-trust
        // on future reconnects from the same (deviceId, browserPubKey) pair.
        verifiedPeerPubKey: null,
        verifiedPeerPubKeys: [],
      }];

  await saveConfig({ ...cfg, devices });
  _repairNeeded = false;

  if (cfg.remoteEnabled) {
    connect().catch(() => {});
  }

  // Return only non-secret fields to the renderer
  return { ok: true, deviceId: response.deviceId };
}

async function revokeDevice(deviceId) {
  teardownAllClients();
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
  teardownAllClients();
  const cfg = await loadConfig();
  const revokedCount = (cfg.devices || []).length;
  await saveConfig({ ...cfg, remoteEnabled: false, devices: [] });
  await clearLocalServices(); // a paired service rides the device; it goes too
  await disconnect(); // tears down WS + clears session key
  broadcastStatus();
  sendIfAlive(_window, 'webRemote:revoked-all', { revokedCount });
  return { ok: true };
}

// ─── IPC handlers ─────────────────────────────────────────────────────────────

function registerRemoteHandlers() {
  setRemoteFanout(fanoutIpcEvent);
  removeOrphanedClientFiles(path.join(claudeHome(), 'session-manager'));
  const { validated } = require('./ipcSchemas.cjs');

  // Returns current status without tokens — safe to expose to renderer.
  ipcMain.handle('webRemote:get-status', async () => {
    const cfg = await loadConfig();
    return computeStatus(cfg);
  });

  // User confirmed that the SAS shown on both desktop and browser match.
  // Returns ok:false if the session is not in the pending_sas state (e.g. key
  // missing, already failed, already authenticated, or reconnected).
  ipcMain.handle('webRemote:confirm-sas', validated(schemas.webRemoteConfirmSas, async (arg) => {
    const clientKey = arg?.clientKey;
    let target;
    if (clientKey !== undefined) {
      const found = _clients.get(clientKey);
      target = found && found.role !== 'service' ? found : makeClientlessState();
    } else {
      const pending = pendingClients();
      if (pending.length > 1) {
        logs.writeLine({ scope: 'webRemote', level: 'warn', message: 'confirm-sas rejected — multiple clients pending', meta: { pending: pending.length } });
        return { ok: false, error: 'ambiguous_pending_sas' };
      }
      target = pending[0] || _clients.get(LEGACY_CLIENT_KEY) || makeClientlessState();
    }
    const { ok, error, next } = confirmSasLogic(target.e2e);
    if (!ok) {
      logs.writeLine({ scope: 'webRemote', level: 'warn', message: 'confirm-sas rejected — wrong state', meta: { state: target.e2e.state, error } });
      return { ok: false, error };
    }
    target.e2e = next;
    // Pin this browser's pubkey to the device so future reconnects with the same
    // key auto-authenticate (see e2e:hello above). Appends; other clients' pins stay.
    if (target.peerPubKey && target.deviceId) {
      try {
        const cfg = await loadConfig();
        const devices = (cfg.devices || []).map((d) =>
          d.deviceId === target.deviceId
            ? { ...d, verifiedPeerPubKeys: addPinnedPeerKey(d, target.peerPubKey) }
            : d
        );
        await saveConfig({ ...cfg, devices });
      } catch (e) {
        logs.writeLine({ scope: 'webRemote', level: 'warn', message: 'failed to persist pinned peer pubkey', meta: { error: e?.message } });
      }
    }
    finalizeE2eAuthenticated('E2E session authenticated — SAS confirmed by user', target);
    return { ok: true };
  }));

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
    teardownAllClients(); // no client keeps a PTY stream once control is off
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

  // Paired services: list (no keys/tokens) + relay orphans, start, confirm, revoke.
  ipcMain.handle('webRemote:services-list', async () => servicesList());

  ipcMain.handle('webRemote:service-pair-start', validated(schemas.webRemoteServicePairStart, async (arg) => {
    return servicePairStart(arg);
  }));

  ipcMain.handle('webRemote:service-confirm-sas', validated(schemas.webRemoteServiceConfirmSas, async ({ pairingId, sas }) => {
    const r = await confirmServiceSas(pairingId, sas);
    return r.ok ? { ok: true, service: redactService(r.service) } : r;
  }));

  ipcMain.handle('webRemote:service-pair-cancel', validated(schemas.webRemoteServicePairCancel, async ({ pairingId }) => {
    return servicePairCancel(pairingId);
  }));

  ipcMain.handle('webRemote:service-revoke', validated(schemas.webRemoteServiceRevoke, async ({ serviceId }) => {
    return serviceRevoke(serviceId);
  }));

  ipcMain.handle('webRemote:relay-client-revoke', validated(schemas.webRemoteRelayClientRevoke, async ({ clientId }) => {
    return relayClientRevoke(clientId);
  }));

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
  stopFrameSweep();
}

module.exports = {
  REMOTE_CAPABILITIES,
  loadConfig,
  getLinkedDeviceToken,
  setIpcDispatcher,
  setServiceInvoker,
  getServiceStore,
  confirmServiceSas,
  servicePairStartLocal,
  confirmServiceSasLocal,
  servicePairCancel,
  attachWindow,
  registerRemoteHandlers,
  init,
  destroy,
  // Test-only internals — not part of the IPC surface. Lets unit tests drive
  // e2e:hello / SAS-pinning transitions without a real relay WS connection.
  _internal: {
    handleMessage,
    resetE2e,
    getE2eState: (clientKey = LEGACY_CLIENT_KEY) => (_clients.get(clientKey) || { e2e: makeState() }).e2e,
  },
  __test: {
    pruneDesktopPins,
    removeOrphanedClientFiles,
    getDispatchMap,
    auditResultFor,
    startSessionWatch,
    pollSessionWatcher,
    getSessionWatcher: (tabId) => _sessionWatchers.get(tabId),
    stopAllSessionWatches,
    setWs: (ws) => { _ws = ws; },
    connect,
    hasReconnectTimer: () => _reconnectTimer !== null,
    cancelReconnect,
    invalidateConfigCache,
    fanoutIpcEvent,
    setE2eAuthenticated: (key, clientKey = LEGACY_CLIENT_KEY) => {
      _clients.getOrCreate(clientKey).e2e = makeState('authenticated', key, null);
    },
    setConfigCache: (cfg) => { _configCache = { ...defaultConfig(), ...cfg }; _configCacheAt = Date.now(); },
    finalizeE2eAuthenticated,
    getClient: (clientKey = LEGACY_CLIENT_KEY) => _clients.getOrCreate(clientKey),
    revokeAllDevices,
    pair,
    setServiceStore: (store) => { _serviceStore = store; },
  },
};
