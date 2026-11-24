'use strict';

/**
 * serviceClient.cjs — the client an outside service (first one: Kiln) runs to
 * reach Session Manager over the bilko.run Web Remote relay. No Electron.
 *
 *   const c = createServiceClient({ stateDir, relayBase?, wssUrl?, fetchImpl?, WebSocketImpl?, onSas? });
 *   await c.pair({ code, name, device? });   // once: redeem the owner's one-time code
 *   const { sas } = await c.connect();       // resolves after e2e:ready + event:remote:ready
 *   await c.listTools(); await c.callTool(name, args, { timeoutMs });
 *   c.close(); c.state;
 *
 * - pair: POST client-pair { code, clientName } -> { clientToken, clientId }; a
 *   new static P-256 identity; GET client/devices picks the desktop (prefix of
 *   6+ chars matching one, or the only device). Everything lands in
 *   <stateDir>/service-client.json at 0600. The token is never logged or returned.
 * - connect: POST client-ticket (one-time, 30 s) -> WSS ?ticket=, e2e:hello
 *   { pubKey, role:'service', name, clientId }. Key + SAS come from
 *   remoteE2eCrypto (the same derivation the desktop runs), so the SAS shown
 *   here equals the one on the desktop. The SAS is known at e2e:ready (onSas
 *   fires) — before an unpinned service is confirmed and event:remote:ready
 *   arrives.
 * - Reconnect: any close but 4001, and e2e:rekey, retry with 1-60 s jittered
 *   backoff. 4001 or a 401 from client-ticket / client/devices is terminal
 *   (state 'revoked'). A 429 waits for the next backoff step. At most 10
 *   client-ticket requests in any 60 s window.
 * - callTool / listTools: JSON-RPC 2.0 inside a boxed cmd:mcp envelope; the
 *   boxed mcp:result is matched by JSON-RPC id.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { writeJsonAtomicSync, readJsonOrSync } = require('../util/atomicFs.cjs');
const { generateE2EKeyPair, deriveSessionKey, deriveSas, encryptBox, decryptBox } = require('./remoteE2eCrypto.cjs');

const DEFAULT_RELAY_BASE = 'https://bilko.run/api/sm-relay';
const DEFAULT_WSS_URL = 'wss://bilko.run/projects/session-manager/relay';
const STATE_FILE = 'service-client.json';
const DEFAULT_CALL_TIMEOUT_MS = 30_000;
const BACKOFF_MIN_MS = 1_000;
const BACKOFF_MAX_MS = 60_000;
const TICKET_WINDOW_MS = 60_000;
const TICKET_MAX_PER_WINDOW = 10;
const DEVICE_PREFIX_MIN = 6;
const CLIENT_NAME_MAX = 64;
const SHORT_ID_LEN = 8;

function clientError(message, code) {
  const e = new Error(message);
  if (code) e.code = code;
  return e;
}

function shortIds(devices) {
  return devices.map((d) => String(d.deviceId).slice(0, SHORT_ID_LEN)).join(', ');
}

/** device = prefix of 6+ chars matching exactly one; omitted = the only device. */
function pickDevice(devices, device) {
  const list = devices.filter((d) => d && typeof d.deviceId === 'string');
  if (device === undefined || device === null || device === '') {
    if (list.length === 1) return list[0];
    throw clientError(`choose a device (${list.length} paired): ${shortIds(list) || 'none'}`, 'device_ambiguous');
  }
  const prefix = String(device);
  if (prefix.length < DEVICE_PREFIX_MIN) {
    throw clientError(`device prefix needs ${DEVICE_PREFIX_MIN}+ chars; devices: ${shortIds(list)}`, 'device_ambiguous');
  }
  const hits = list.filter((d) => d.deviceId.startsWith(prefix));
  if (hits.length === 1) return hits[0];
  throw clientError(`device '${prefix}' matches ${hits.length} devices; devices: ${shortIds(list)}`, 'device_ambiguous');
}

function createServiceClient({
  stateDir,
  relayBase = DEFAULT_RELAY_BASE,
  wssUrl = DEFAULT_WSS_URL,
  fetchImpl = globalThis.fetch,
  WebSocketImpl,
  onSas,
  random = Math.random,
} = {}) {
  if (!stateDir) throw new Error('stateDir is required');
  if (!/^https:\/\//.test(relayBase)) throw new Error('relayBase must be https://');
  if (!/^wss:\/\//.test(wssUrl)) throw new Error('wssUrl must be wss://');
  const file = path.join(stateDir, STATE_FILE);
  const WS = WebSocketImpl || require('ws');

  let stored = readStored();
  let state = stored ? 'paired' : 'unpaired';
  let ws = null;
  let sessionKey = null;
  let sas = null;
  let gotReady = false;
  let gotRemoteReady = false;
  let attempt = 0;
  let timer = null;
  let rpcSeq = 0;
  const pending = new Map(); // JSON-RPC id -> { resolve, reject, timer }
  const ticketTimes = [];
  /** @type {{ resolve: Function, reject: Function, promise: Promise<any> } | null} */
  let connectWaiter = null;

  function readStored() {
    const d = readJsonOrSync(file, null);
    return d && typeof d.clientToken === 'string' && d.clientToken && typeof d.privateKey === 'string' ? d : null;
  }

  function writeStored(data) {
    fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    writeJsonAtomicSync(file, data, { mode: 0o600 });
  }

  async function request(method, route, { token, body } = {}) {
    const headers = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetchImpl(`${relayBase}${route}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let json = null;
    try { json = await res.json(); } catch { /* non-JSON body */ }
    return { status: res.status, json: json || {} };
  }

  function revoke() {
    state = 'revoked';
    clearTimeout(timer);
    timer = null;
    const err = clientError('service client revoked', 'revoked');
    rejectAll(err);
    if (ws) { const s = ws; ws = null; try { s.close(1000, 'revoked'); } catch { /* already closed */ } }
    if (connectWaiter) { connectWaiter.reject(err); connectWaiter = null; }
    return err;
  }

  async function fetchDevices(token) {
    const res = await request('GET', '/client/devices', { token });
    if (res.status === 401) throw revoke();
    if (res.status < 200 || res.status >= 300) throw clientError(res.json.error || `HTTP ${res.status}`, 'http');
    return Array.isArray(res.json.devices) ? res.json.devices : [];
  }

  async function pair({ code, name, device } = {}) {
    if (typeof name !== 'string' || !name.trim()) throw new Error('name is required');
    const clientName = name.slice(0, CLIENT_NAME_MAX);
    const res = await request('POST', '/client-pair', { body: { code: String(code ?? '').trim(), clientName } });
    if (res.status !== 200 || !res.json.clientToken) {
      throw clientError(`pair failed: ${res.json.error || `HTTP ${res.status}`}`, 'pair_failed');
    }
    const { clientToken, clientId } = res.json;
    const devices = await fetchDevices(clientToken);
    const picked = pickDevice(devices, device);
    const keys = generateE2EKeyPair();
    stored = {
      clientToken,
      clientId,
      name: clientName,
      privateKey: keys.e2ePrivateKey,
      publicKey: keys.e2ePublicKey,
      deviceId: picked.deviceId,
      devicePubKey: picked.devicePubKey,
      pairedAt: new Date().toISOString(),
    };
    writeStored(stored);
    state = 'paired';
    return { clientId, deviceId: picked.deviceId };
  }

  function rejectAll(err) {
    for (const [id, p] of pending) {
      clearTimeout(p.timer);
      pending.delete(id);
      p.reject(err);
    }
  }

  function backoffDelay() {
    const base = Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** attempt);
    attempt += 1;
    const jittered = base * (0.5 + 0.5 * random());
    return Math.min(BACKOFF_MAX_MS, Math.max(BACKOFF_MIN_MS, Math.round(jittered)));
  }

  function live() {
    return state !== 'revoked' && state !== 'closed';
  }

  function scheduleReconnect() {
    if (!live()) return;
    state = 'reconnecting';
    clearTimeout(timer);
    timer = setTimeout(() => { timer = null; openSocket(); }, backoffDelay());
  }

  /** Wait until one more client-ticket request fits the 10-per-minute window. */
  function ticketSlotWait() {
    const now = Date.now();
    while (ticketTimes.length && now - ticketTimes[0] >= TICKET_WINDOW_MS) ticketTimes.shift();
    if (ticketTimes.length < TICKET_MAX_PER_WINDOW) return 0;
    return ticketTimes[0] + TICKET_WINDOW_MS - now;
  }

  async function openSocket() {
    if (!live()) return;
    const wait = ticketSlotWait();
    if (wait > 0) {
      clearTimeout(timer);
      timer = setTimeout(() => { timer = null; openSocket(); }, wait);
      return;
    }
    state = state === 'reconnecting' ? 'reconnecting' : 'connecting';
    ticketTimes.push(Date.now());
    let res;
    try {
      res = await request('POST', '/client-ticket', { token: stored.clientToken, body: {} });
    } catch {
      scheduleReconnect();
      return;
    }
    if (!live()) return;
    if (res.status === 401) { revoke(); return; }
    if (res.status !== 200 || typeof res.json.ticket !== 'string') { scheduleReconnect(); return; }

    sessionKey = null;
    gotReady = false;
    gotRemoteReady = false;
    const socket = new WS(`${wssUrl}?ticket=${encodeURIComponent(res.json.ticket)}`, { rejectUnauthorized: true });
    ws = socket;
    socket.on('open', () => {
      if (ws !== socket) return;
      attempt = 0;
      sendHello();
    });
    socket.on('message', (data) => {
      if (ws !== socket) return;
      let msg;
      try { msg = JSON.parse(String(data)); } catch { return; }
      if (msg && typeof msg === 'object') handleMessage(msg);
    });
    socket.on('error', () => { /* a close event follows */ });
    socket.on('close', (code) => {
      if (ws !== socket) return;
      ws = null;
      sessionKey = null;
      if (code === 4001) { revoke(); return; }
      rejectAll(clientError('connection lost', 'connection_lost'));
      scheduleReconnect();
    });
  }

  function sendRaw(msg) {
    if (!ws || ws.readyState !== (WS.OPEN ?? 1)) return false;
    ws.send(JSON.stringify(msg));
    return true;
  }

  function envelope(type, payload, id = crypto.randomUUID()) {
    return { type, id, deviceId: stored.deviceId, payload, ts: Date.now() };
  }

  function sendHello() {
    sessionKey = deriveSessionKey(stored.privateKey, stored.devicePubKey, stored.deviceId);
    sas = deriveSas(stored.privateKey, stored.devicePubKey, stored.deviceId);
    gotReady = false;
    gotRemoteReady = false;
    sendRaw(envelope('e2e:hello', { pubKey: stored.publicKey, role: 'service', name: stored.name, clientId: stored.clientId }));
  }

  function sendBoxed(inner) {
    if (!sessionKey) return false;
    const { nonce, ciphertext } = encryptBox(JSON.stringify(inner), sessionKey);
    return sendRaw({ type: 'e2e:box', id: inner.id, deviceId: stored.deviceId, payload: { nonce, ciphertext }, ts: Date.now() });
  }

  function maybeReady() {
    if (!gotReady || !gotRemoteReady || state === 'ready') return;
    state = 'ready';
    attempt = 0;
    if (connectWaiter) { connectWaiter.resolve({ sas }); connectWaiter = null; }
  }

  function handleMessage(msg) {
    if (msg.deviceId !== undefined && msg.deviceId !== stored.deviceId) return;
    switch (msg.type) {
      case 'ping':
        sendRaw({ type: 'pong', id: msg.id, ts: Date.now() });
        return;
      case 'e2e:ready':
        if (gotReady) return;
        gotReady = true;
        if (typeof onSas === 'function') { try { onSas(sas); } catch { /* caller's handler */ } }
        maybeReady();
        return;
      case 'e2e:rekey': {
        rejectAll(clientError('connection lost', 'connection_lost'));
        sessionKey = null;
        gotReady = false;
        gotRemoteReady = false;
        state = 'reconnecting';
        const socket = ws;
        clearTimeout(timer);
        timer = setTimeout(() => {
          timer = null;
          if (!live()) return;
          if (ws === socket && socket) sendHello();
          else if (!ws) openSocket();
        }, backoffDelay());
        return;
      }
      case 'e2e:box': {
        if (!sessionKey || !msg.payload) return;
        const plain = decryptBox(msg.payload.nonce, msg.payload.ciphertext, sessionKey);
        if (!plain) return;
        let inner;
        try { inner = JSON.parse(plain); } catch { return; }
        if (inner && typeof inner === 'object') handleInner(inner);
        return;
      }
      default:
    }
  }

  function handleInner(inner) {
    if (inner.type === 'event:remote:ready') {
      gotRemoteReady = true;
      maybeReady();
      return;
    }
    if (inner.type === 'mcp:result') {
      const rpc = inner.payload;
      if (!rpc || typeof rpc !== 'object') return;
      const p = pending.get(rpc.id);
      if (!p) return;
      clearTimeout(p.timer);
      pending.delete(rpc.id);
      if (rpc.error) {
        const e = clientError(String(rpc.error.message || 'mcp error'), 'mcp_error');
        e.rpcCode = rpc.error.code;
        p.reject(e);
      } else {
        p.resolve(rpc.result);
      }
    }
  }

  function connect() {
    if (state === 'revoked') return Promise.reject(clientError('service client revoked', 'revoked'));
    if (!stored) return Promise.reject(clientError('service client is not paired', 'unpaired'));
    if (state === 'ready') return Promise.resolve({ sas });
    if (connectWaiter) return connectWaiter.promise;
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    connectWaiter = { resolve, reject, promise };
    state = 'connecting';
    (async () => {
      // Refresh the desktop's public key once per connect(); keep the stored one if unreachable.
      try {
        const hit = (await fetchDevices(stored.clientToken)).find((d) => d && d.deviceId === stored.deviceId);
        if (hit && typeof hit.devicePubKey === 'string' && hit.devicePubKey !== stored.devicePubKey) {
          stored = { ...stored, devicePubKey: hit.devicePubKey };
          writeStored(stored);
        }
      } catch (e) {
        if (e && e.code === 'revoked') return;
      }
      if (live()) openSocket();
    })();
    return promise;
  }

  function rpc(method, params, { timeoutMs = DEFAULT_CALL_TIMEOUT_MS } = {}) {
    if (state === 'revoked') return Promise.reject(clientError('service client revoked', 'revoked'));
    if (state === 'closed') return Promise.reject(clientError('service client closed', 'closed'));
    if (state !== 'ready') return Promise.reject(clientError(`service client not ready (${state})`, 'not_ready'));
    const id = `svc-${++rpcSeq}`;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        pending.delete(id);
        reject(clientError(`timeout after ${timeoutMs} ms waiting for ${method}`, 'timeout'));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer: t });
      const sent = sendBoxed(envelope('cmd:mcp', { jsonrpc: '2.0', id, method, params }));
      if (!sent) {
        clearTimeout(t);
        pending.delete(id);
        reject(clientError('not connected', 'connection_lost'));
      }
    });
  }

  async function listTools(opts) {
    const result = await rpc('tools/list', {}, opts);
    return Array.isArray(result?.tools) ? result.tools : [];
  }

  function callTool(name, args = {}, opts) {
    return rpc('tools/call', { name, arguments: args }, opts);
  }

  function close() {
    if (state === 'revoked') return;
    state = 'closed';
    clearTimeout(timer);
    timer = null;
    const err = clientError('service client closed', 'closed');
    rejectAll(err);
    if (connectWaiter) { connectWaiter.reject(err); connectWaiter = null; }
    if (ws) { const s = ws; ws = null; try { s.close(1000, 'closed'); } catch { /* already closed */ } }
  }

  return {
    pair,
    connect,
    listTools,
    callTool,
    close,
    get state() { return state; },
    get sas() { return sas; },
    get clientId() { return stored ? stored.clientId : null; },
    get deviceId() { return stored ? stored.deviceId : null; },
  };
}

module.exports = { createServiceClient, pickDevice, DEFAULT_RELAY_BASE, DEFAULT_WSS_URL, STATE_FILE };
