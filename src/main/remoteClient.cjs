'use strict';

// Desktop-to-desktop remote: the CLIENT role. Drives a paired Session Manager
// agent (webRemote.cjs) over the relay using the same envelope protocol the
// phone app speaks (web/remote-app/src/ws.ts). No Electron imports — IPC wiring
// lives elsewhere.

const crypto = require('node:crypto');
const path = require('node:path');
const { claudeHome } = require('./lib/schedulerPaths.cjs');
const { writeJsonAtomicSync, readJsonOrSync } = require('./lib/atomicFs.cjs');
const { generateE2EKeyPair, deriveSessionKey, deriveSas, encryptBox, decryptBox } = require('./lib/remoteE2eCrypto.cjs');
const { ALLOWED_COMMANDS } = require('./ipcSchemas.cjs');

// Hard-coded wss:// — same relay URL as webRemote.cjs, no plaintext downgrade.
const RELAY_WSS_URL = 'wss://bilko.run/projects/session-manager/relay';
const SEND_TIMEOUT_MS = 15_000;
const WS_OPEN = 1;

/** Default relay auth: the bilko.run relay has no desktop-client auth yet. */
const defaultRelayAuth = {
  async getBrowserTicket() { throw new Error('relay_client_auth_unavailable'); },
  async getDevicePubKey() { throw new Error('relay_client_auth_unavailable'); },
};

function defaultWsFactory(url) {
  const WebSocket = require('ws');
  return new WebSocket(url, { rejectUnauthorized: true });
}

function defaultConfigPath() {
  return path.join(claudeHome(), 'session-manager', 'remote-peers.json');
}

function createRemoteClient({ relayAuth = defaultRelayAuth, wsFactory = defaultWsFactory, configPath } = {}) {
  const file = configPath || defaultConfigPath();
  /** @type {Map<string, any>} peerId -> runtime state */
  const runtime = new Map();
  /** @type {Map<string, Set<Function>>} */
  const subscribers = new Map();

  function loadPeers() {
    const data = readJsonOrSync(file, { peers: [] });
    return Array.isArray(data?.peers) ? data.peers : [];
  }
  function savePeers(peers) {
    writeJsonAtomicSync(file, { peers }, { mode: 0o600 });
  }
  function getPeer(peerId) {
    return loadPeers().find((p) => p.peerId === peerId) || null;
  }
  function updatePeer(peerId, patch) {
    const peers = loadPeers();
    const i = peers.findIndex((p) => p.peerId === peerId);
    if (i < 0) return;
    peers[i] = { ...peers[i], ...patch };
    savePeers(peers);
  }

  function rt(peerId) {
    let s = runtime.get(peerId);
    if (!s) {
      s = {
        status: 'idle', reason: null, sas: null, ws: null, sessionKey: null,
        devicePubKey: null, pending: new Map(), attempt: 0,
      };
      runtime.set(peerId, s);
    }
    return s;
  }

  function failPending(s, err) {
    for (const p of s.pending.values()) { clearTimeout(p.timer); p.reject(err); }
    s.pending.clear();
  }

  function fail(peerId, reason) {
    const s = rt(peerId);
    s.status = 'failed';
    s.reason = reason;
    s.sessionKey = null;
    s.sas = null;
    failPending(s, new Error(reason));
    const ws = s.ws;
    s.ws = null;
    try { ws?.close(); } catch { /* already closed */ }
  }

  function addPeer({ peerId, deviceId, machineName }) {
    if (!peerId || !deviceId) throw new Error('peerId and deviceId required');
    const peers = loadPeers();
    const existing = peers.find((p) => p.peerId === peerId);
    if (existing) return existing;
    const kp = generateE2EKeyPair();
    const peer = {
      peerId,
      deviceId,
      machineName: machineName || '',
      pairedAt: new Date().toISOString(),
      clientPrivateKey: kp.e2ePrivateKey,
      clientPublicKey: kp.e2ePublicKey,
      verifiedDevicePubKey: null,
    };
    peers.push(peer);
    savePeers(peers);
    return peer;
  }

  function listPeers() {
    // Never expose the private key to callers.
    return loadPeers().map(({ clientPrivateKey, ...rest }) => rest);
  }

  function getStatus(peerId) {
    const s = rt(peerId);
    return { status: s.status, reason: s.reason, sas: s.sas };
  }

  function rawSend(ws, msg) {
    ws.send(JSON.stringify(msg));
  }

  function handleInner(peerId, s, inner) {
    if (!inner || typeof inner.type !== 'string') return;
    if (inner.type.startsWith('resp:')) {
      const p = s.pending.get(inner.id);
      if (!p) return;
      s.pending.delete(inner.id);
      clearTimeout(p.timer);
      p.resolve(inner.payload);
      return;
    }
    if (inner.type.startsWith('event:')) {
      for (const cb of subscribers.get(peerId) || []) {
        try { cb(inner); } catch { /* subscriber errors never break the socket */ }
      }
    }
  }

  function handleMessage(peerId, s, peer, raw) {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (!msg || typeof msg.type !== 'string') return;

    if (msg.type === 'ping') {
      if (s.ws && s.ws.readyState === WS_OPEN) rawSend(s.ws, { type: 'pong', id: msg.id, ts: Date.now() });
      return;
    }
    if (msg.type === 'error') {
      const code = msg.code || msg.payload?.code;
      if (code === 'token_revoked') fail(peerId, 'token_revoked');
      return;
    }
    if (msg.type === 'auth:ok') {
      // Relay accepted the ticket: start the E2E handshake.
      rawSend(s.ws, {
        type: 'e2e:hello',
        id: crypto.randomUUID(),
        deviceId: peer.deviceId,
        payload: { pubKey: peer.clientPublicKey },
        ts: Date.now(),
      });
      return;
    }
    if (msg.type === 'e2e:ready') {
      if (s.sessionKey) return;
      try {
        s.sessionKey = deriveSessionKey(peer.clientPrivateKey, s.devicePubKey, peer.deviceId);
        s.sas = deriveSas(peer.clientPrivateKey, s.devicePubKey, peer.deviceId);
      } catch {
        fail(peerId, 'e2e_derivation_failed');
        return;
      }
      s.status = peer.verifiedDevicePubKey && peer.verifiedDevicePubKey === s.devicePubKey
        ? 'authenticated'
        : 'pending_sas';
      return;
    }
    if (msg.type === 'e2e:box') {
      if (!s.sessionKey) return;
      const { nonce, ciphertext } = msg.payload || {};
      if (!nonce || !ciphertext) return;
      const plain = decryptBox(nonce, ciphertext, s.sessionKey);
      if (!plain) return;
      let inner;
      try { inner = JSON.parse(plain); } catch { return; }
      handleInner(peerId, s, inner);
    }
  }

  async function connect(peerId) {
    const peer = getPeer(peerId);
    if (!peer) throw new Error('unknown_peer');
    const s = rt(peerId);
    const attempt = ++s.attempt;
    try { s.ws?.close(); } catch { /* already closed */ }
    s.ws = null;
    s.sessionKey = null;
    s.sas = null;
    s.reason = null;
    s.status = 'connecting';

    let ticket;
    let devicePubKey;
    try {
      ticket = await relayAuth.getBrowserTicket(peer);
      devicePubKey = await relayAuth.getDevicePubKey(peer.deviceId);
    } catch (e) {
      fail(peerId, e?.message || 'relay_auth_failed');
      return getStatus(peerId);
    }
    if (attempt !== s.attempt) return getStatus(peerId); // superseded or removed
    if (!ticket || !devicePubKey) {
      fail(peerId, 'relay_auth_failed');
      return getStatus(peerId);
    }
    // TOFU: a changed device key after pinning fails closed, before any socket opens.
    if (peer.verifiedDevicePubKey && peer.verifiedDevicePubKey !== devicePubKey) {
      fail(peerId, 'device_key_changed');
      return getStatus(peerId);
    }
    s.devicePubKey = devicePubKey;

    let ws;
    try {
      ws = wsFactory(`${RELAY_WSS_URL}?ticket=${encodeURIComponent(ticket)}`);
    } catch {
      fail(peerId, 'ws_create_failed');
      return getStatus(peerId);
    }
    s.ws = ws;
    ws.on('message', (data) => { if (s.ws === ws) handleMessage(peerId, s, peer, data); });
    ws.on('close', () => {
      if (s.ws !== ws) return;
      s.ws = null;
      s.sessionKey = null;
      failPending(s, new Error('connection_closed'));
      if (s.status !== 'failed') { s.status = 'idle'; s.sas = null; }
    });
    ws.on('error', () => { if (s.ws === ws) fail(peerId, 'ws_error'); });
    return getStatus(peerId);
  }

  function confirmSas(peerId) {
    const s = rt(peerId);
    if (s.status !== 'pending_sas' || !s.devicePubKey) return { ok: false, reason: 'not_pending_sas' };
    updatePeer(peerId, { verifiedDevicePubKey: s.devicePubKey });
    s.status = 'authenticated';
    return { ok: true };
  }

  function send(peerId, type, payload) {
    if (typeof type !== 'string' || !ALLOWED_COMMANDS.has(type)) {
      return Promise.reject(new Error('command_not_allowed'));
    }
    const s = rt(peerId);
    if (!s.ws || s.ws.readyState !== WS_OPEN || !s.sessionKey) {
      return Promise.reject(new Error('not_connected'));
    }
    const id = crypto.randomUUID();
    const peer = getPeer(peerId);
    if (!peer) return Promise.reject(new Error('unknown_peer'));
    const inner = { type, id, payload: payload ?? {}, ts: Date.now() };
    const { nonce, ciphertext } = encryptBox(JSON.stringify(inner), s.sessionKey);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        s.pending.delete(id);
        reject(new Error('timeout'));
      }, SEND_TIMEOUT_MS);
      s.pending.set(id, { resolve, reject, timer });
      try {
        rawSend(s.ws, { type: 'e2e:box', id, deviceId: peer.deviceId, payload: { nonce, ciphertext }, ts: Date.now() });
      } catch (e) {
        s.pending.delete(id);
        clearTimeout(timer);
        reject(e);
      }
    });
  }

  function onEvent(peerId, cb) {
    let set = subscribers.get(peerId);
    if (!set) { set = new Set(); subscribers.set(peerId, set); }
    set.add(cb);
    return () => { set.delete(cb); };
  }

  function removePeer(peerId) {
    const s = runtime.get(peerId);
    if (s) {
      s.attempt++;
      failPending(s, new Error('peer_removed'));
      try { s.ws?.close(); } catch { /* already closed */ }
      runtime.delete(peerId);
    }
    subscribers.delete(peerId);
    savePeers(loadPeers().filter((p) => p.peerId !== peerId));
  }

  return { addPeer, listPeers, connect, confirmSas, getStatus, send, onEvent, removePeer };
}

const remoteClient = createRemoteClient();

module.exports = { createRemoteClient, remoteClient, SEND_TIMEOUT_MS };
