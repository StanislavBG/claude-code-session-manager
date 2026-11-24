'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const crypto = require('../remoteE2eCrypto.cjs');
const { createServiceClient, DEFAULT_RELAY_BASE, DEFAULT_WSS_URL, STATE_FILE } = require('../serviceClient.cjs');

const DEVICE_A = 'aaaaaaaa-1111-4111-8111-111111111111';
const DEVICE_B = 'bbbbbbbb-2222-4222-8222-222222222222';
const DEVICE_C = 'aaaaaaab-3333-4333-8333-333333333333';

function desktopKeys() {
  return crypto.generateE2EKeyPair();
}

/** Fake relay HTTP API. `handlers` overrides route answers. */
function makeFetch({ devices, handlers = {} } = {}) {
  const calls = [];
  let ticketN = 0;
  async function fetchImpl(url, init = {}) {
    const route = url.replace(DEFAULT_RELAY_BASE, '');
    calls.push({ at: Date.now(), url, route, method: init.method, headers: init.headers || {}, body: init.body ? JSON.parse(init.body) : undefined });
    const custom = handlers[route];
    let ans;
    if (custom) ans = custom(calls[calls.length - 1]);
    if (!ans) {
      if (route === '/client-pair') ans = { status: 200, json: { clientToken: 'tok-SECRET-123', clientId: 'cli-1' } };
      else if (route === '/client/devices') ans = { status: 200, json: { devices } };
      else if (route === '/client-ticket') ans = { status: 200, json: { ticket: `t${++ticketN}` } };
      else ans = { status: 404, json: { error: 'not found' } };
    }
    return { status: ans.status, ok: ans.status >= 200 && ans.status < 300, json: async () => ans.json };
  }
  return { fetchImpl, calls };
}

/**
 * Fake WSS + desktop peer. Each socket answers e2e:hello with plaintext e2e:ready
 * then a boxed event:remote:ready, and answers boxed cmd:mcp with boxed mcp:result.
 */
function makeWs(device, { answerMcp = true, silentHello = false } = {}) {
  const sockets = [];
  class FakeWs extends EventEmitter {
    constructor(url, opts) {
      super();
      this.url = url;
      this.opts = opts;
      this.readyState = 0;
      this.sent = [];
      this.key = null;
      sockets.push(this);
      setTimeout(() => { this.readyState = 1; this.emit('open'); }, 0);
    }
    send(text) {
      const msg = JSON.parse(text);
      this.sent.push(msg);
      if (msg.type === 'e2e:hello') {
        if (silentHello) return;
        this.key = crypto.deriveSessionKey(device.e2ePrivateKey, msg.payload.pubKey, msg.deviceId);
        this.peerPub = msg.payload.pubKey;
        this.deliver({ type: 'e2e:ready', id: msg.id, deviceId: msg.deviceId, ts: Date.now() });
        this.box({ type: 'event:remote:ready', id: 'r1', deviceId: msg.deviceId, payload: { capabilities: [] }, ts: Date.now() });
        return;
      }
      if (msg.type === 'e2e:box' && this.key) {
        const inner = JSON.parse(crypto.decryptBox(msg.payload.nonce, msg.payload.ciphertext, this.key));
        this.inner = this.inner || [];
        this.inner.push(inner);
        if (inner.type === 'cmd:mcp' && answerMcp) {
          const rpc = inner.payload;
          const result = rpc.method === 'tools/list'
            ? { tools: [{ name: 'macro_list' }] }
            : { content: [{ type: 'text', text: JSON.stringify({ echo: rpc.params }) }] };
          // An unrelated result first: matching must be by JSON-RPC id.
          this.box({ type: 'mcp:result', id: 'x', deviceId: inner.deviceId, payload: { jsonrpc: '2.0', id: 'other', result: {} }, ts: Date.now() });
          this.box({ type: 'mcp:result', id: inner.id, deviceId: inner.deviceId, payload: { jsonrpc: '2.0', id: rpc.id, result }, ts: Date.now() });
        }
      }
    }
    deliver(msg) {
      setTimeout(() => { if (this.readyState === 1) this.emit('message', Buffer.from(JSON.stringify(msg))); }, 0);
    }
    box(inner) {
      const { nonce, ciphertext } = crypto.encryptBox(JSON.stringify(inner), this.key);
      this.deliver({ type: 'e2e:box', id: inner.id, deviceId: inner.deviceId, payload: { nonce, ciphertext }, ts: Date.now() });
    }
    close(code = 1000, reason = '') {
      if (this.readyState === 3) return;
      this.readyState = 3;
      setTimeout(() => this.emit('close', code, Buffer.from(reason)), 0);
    }
    /** Server-side close. */
    serverClose(code, reason = '') { this.close(code, reason); }
  }
  FakeWs.OPEN = 1;
  return { WebSocketImpl: FakeWs, sockets };
}

let stateDir;
beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'svc-client-'));
});
afterEach(() => {
  vi.useRealTimers();
  fs.rmSync(stateDir, { recursive: true, force: true });
});

async function pairedClient({ devices, ws, fetchOpts = {}, random = () => 0.5 } = {}) {
  const f = makeFetch({ devices, ...fetchOpts });
  const client = createServiceClient({ stateDir, fetchImpl: f.fetchImpl, WebSocketImpl: ws.WebSocketImpl, random });
  await client.pair({ code: 'abc123', name: 'Kiln' });
  return { client, f };
}

describe('serviceClient defaults', () => {
  it('uses the bilko.run relay endpoints', () => {
    expect(DEFAULT_RELAY_BASE).toBe('https://bilko.run/api/sm-relay');
    expect(DEFAULT_WSS_URL).toBe('wss://bilko.run/projects/session-manager/relay');
  });
});

describe('pair', () => {
  it('stores token, clientId and a P-256 key at 0600 and never logs the token', async () => {
    const dk = desktopKeys();
    const spy = vi.spyOn(console, 'log');
    const spyW = vi.spyOn(console, 'warn');
    const spyE = vi.spyOn(console, 'error');
    const f = makeFetch({ devices: [{ deviceId: DEVICE_A, devicePubKey: dk.e2ePublicKey }] });
    const client = createServiceClient({ stateDir, fetchImpl: f.fetchImpl, WebSocketImpl: makeWs(dk).WebSocketImpl });
    const res = await client.pair({ code: 'abc123', name: 'Kiln' });
    expect(res).toMatchObject({ clientId: 'cli-1', deviceId: DEVICE_A });
    expect(JSON.stringify(res)).not.toContain('tok-SECRET-123');

    const pairCall = f.calls.find((c) => c.route === '/client-pair');
    expect(pairCall.method).toBe('POST');
    expect(pairCall.body).toEqual({ code: 'abc123', clientName: 'Kiln' });
    const devCall = f.calls.find((c) => c.route === '/client/devices');
    expect(devCall.headers.Authorization).toBe('Bearer tok-SECRET-123');

    const file = path.join(stateDir, STATE_FILE);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(stored.clientToken).toBe('tok-SECRET-123');
    expect(stored.clientId).toBe('cli-1');
    expect(stored.deviceId).toBe(DEVICE_A);
    // A real P-256 PKCS8 key usable with the shared crypto.
    expect(() => crypto.deriveSas(stored.privateKey, dk.e2ePublicKey, DEVICE_A)).not.toThrow();
    for (const s of [spy, spyW, spyE]) {
      for (const call of s.mock.calls) expect(JSON.stringify(call)).not.toContain('tok-SECRET-123');
      s.mockRestore();
    }
  });

  it('picks the single device when device is omitted', async () => {
    const dk = desktopKeys();
    const { client } = await pairedClient({ devices: [{ deviceId: DEVICE_B, devicePubKey: dk.e2ePublicKey }], ws: makeWs(dk) });
    expect(client.state).toBe('paired');
  });

  it('picks by a 6+ char prefix matching exactly one device', async () => {
    const dk = desktopKeys();
    const devices = [{ deviceId: DEVICE_A, devicePubKey: dk.e2ePublicKey }, { deviceId: DEVICE_B, devicePubKey: 'x' }];
    const f = makeFetch({ devices });
    const client = createServiceClient({ stateDir, fetchImpl: f.fetchImpl, WebSocketImpl: makeWs(dk).WebSocketImpl });
    const res = await client.pair({ code: 'c', name: 'Kiln', device: 'bbbbbb' });
    expect(res.deviceId).toBe(DEVICE_B);
  });

  it('rejects an ambiguous prefix, a short prefix, or several devices with no pick, listing short ids', async () => {
    const dk = desktopKeys();
    const devices = [
      { deviceId: DEVICE_A, devicePubKey: dk.e2ePublicKey },
      { deviceId: DEVICE_B, devicePubKey: 'x' },
      { deviceId: DEVICE_C, devicePubKey: 'y' },
    ];
    for (const device of ['aaaaaa', undefined, 'aaaa', 'ffffff']) {
      const f = makeFetch({ devices });
      const client = createServiceClient({ stateDir, fetchImpl: f.fetchImpl, WebSocketImpl: makeWs(dk).WebSocketImpl });
      await expect(client.pair({ code: 'c', name: 'Kiln', device })).rejects.toThrow(/aaaaaaaa.*bbbbbbbb.*aaaaaaab/);
    }
  });
});

describe('connect', () => {
  it('sends a hello with role service + clientId, and the SAS equals the desktop derivation', async () => {
    const dk = desktopKeys();
    const ws = makeWs(dk);
    const { client, f } = await pairedClient({ devices: [{ deviceId: DEVICE_A, devicePubKey: dk.e2ePublicKey }], ws });
    const { sas } = await client.connect();
    expect(client.state).toBe('ready');

    const ticketCall = f.calls.find((c) => c.route === '/client-ticket');
    expect(ticketCall.method).toBe('POST');
    expect(ticketCall.headers.Authorization).toBe('Bearer tok-SECRET-123');

    const sock = ws.sockets[0];
    expect(sock.url).toBe(`${DEFAULT_WSS_URL}?ticket=t1`);
    expect(sock.opts).toMatchObject({ rejectUnauthorized: true });
    const hello = sock.sent.find((m) => m.type === 'e2e:hello');
    expect(hello.deviceId).toBe(DEVICE_A);
    expect(hello.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(typeof hello.ts).toBe('number');
    expect(hello.payload).toEqual({ pubKey: expect.any(String), role: 'service', name: 'Kiln', clientId: 'cli-1' });

    const desktopSas = crypto.deriveSas(dk.e2ePrivateKey, hello.payload.pubKey, DEVICE_A);
    expect(sas).toBe(desktopSas);
    expect(client.sas).toBe(desktopSas);
    client.close();
  });

  it('keeps a static identity across clients built on the same stateDir', async () => {
    const dk = desktopKeys();
    const ws = makeWs(dk);
    const { client } = await pairedClient({ devices: [{ deviceId: DEVICE_A, devicePubKey: dk.e2ePublicKey }], ws });
    await client.connect();
    client.close();
    const f2 = makeFetch({ devices: [{ deviceId: DEVICE_A, devicePubKey: dk.e2ePublicKey }] });
    const again = createServiceClient({ stateDir, fetchImpl: f2.fetchImpl, WebSocketImpl: ws.WebSocketImpl });
    await again.connect();
    const [h1, h2] = ws.sockets.map((s) => s.sent.find((m) => m.type === 'e2e:hello').payload.pubKey);
    expect(h1).toBe(h2);
    again.close();
  });
});

describe('MCP calls', () => {
  it('round-trips tools/list and tools/call through boxed cmd:mcp', async () => {
    const dk = desktopKeys();
    const ws = makeWs(dk);
    const { client } = await pairedClient({ devices: [{ deviceId: DEVICE_A, devicePubKey: dk.e2ePublicKey }], ws });
    await client.connect();
    const tools = await client.listTools();
    expect(tools).toEqual([{ name: 'macro_list' }]);
    const res = await client.callTool('macro_list', { cwd: '/x' });
    expect(JSON.parse(res.content[0].text)).toEqual({ echo: { name: 'macro_list', arguments: { cwd: '/x' } } });

    const sock = ws.sockets[0];
    // Nothing but hello/ping goes out in plaintext; commands are boxed.
    expect(sock.sent.filter((m) => m.type.startsWith('cmd:'))).toEqual([]);
    const cmd = sock.inner.filter((m) => m.type === 'cmd:mcp')[1];
    expect(cmd).toMatchObject({ deviceId: DEVICE_A, payload: { jsonrpc: '2.0', method: 'tools/call' } });
    expect(cmd.id).toMatch(/^[0-9a-f-]{36}$/);
    const box = sock.sent.filter((m) => m.type === 'e2e:box')[1];
    expect(box).toMatchObject({ deviceId: DEVICE_A, payload: { nonce: expect.any(String), ciphertext: expect.any(String) } });
    client.close();
  });

  it('rejects after timeoutMs when no result arrives', async () => {
    const dk = desktopKeys();
    const ws = makeWs(dk, { answerMcp: false });
    const { client } = await pairedClient({ devices: [{ deviceId: DEVICE_A, devicePubKey: dk.e2ePublicKey }], ws });
    await client.connect();
    await expect(client.callTool('macro_list', {}, { timeoutMs: 30 })).rejects.toThrow(/timeout/);
    client.close();
  });

  it('rejects pending calls on close', async () => {
    const dk = desktopKeys();
    const ws = makeWs(dk, { answerMcp: false });
    const { client } = await pairedClient({ devices: [{ deviceId: DEVICE_A, devicePubKey: dk.e2ePublicKey }], ws });
    await client.connect();
    const p = client.callTool('macro_list', {});
    client.close();
    await expect(p).rejects.toThrow(/closed/);
    expect(client.state).toBe('closed');
  });
});

describe('reconnect', () => {
  it('reconnects after a normal close with 1-60 s jittered backoff and re-hellos', async () => {
    const dk = desktopKeys();
    const ws = makeWs(dk);
    const { client, f } = await pairedClient({ devices: [{ deviceId: DEVICE_A, devicePubKey: dk.e2ePublicKey }], ws, random: () => 0 });
    await client.connect();
    vi.useFakeTimers();
    ws.sockets[0].serverClose(1000);
    await vi.advanceTimersByTimeAsync(10);
    expect(client.state).toBe('reconnecting');
    await vi.advanceTimersByTimeAsync(900);
    expect(ws.sockets.length).toBe(1); // backoff never below 1 s
    await vi.advanceTimersByTimeAsync(200);
    await vi.advanceTimersByTimeAsync(50);
    expect(ws.sockets.length).toBe(2);
    expect(ws.sockets[1].sent.some((m) => m.type === 'e2e:hello')).toBe(true);
    expect(client.state).toBe('ready');
    expect(f.calls.filter((c) => c.route === '/client-ticket').length).toBe(2);
    client.close();
  });

  it('e2e:rekey drops the session, rejects pending calls, and re-hellos', async () => {
    const dk = desktopKeys();
    const ws = makeWs(dk, { answerMcp: false });
    const { client } = await pairedClient({ devices: [{ deviceId: DEVICE_A, devicePubKey: dk.e2ePublicKey }], ws, random: () => 0 });
    await client.connect();
    vi.useFakeTimers();
    const p = client.callTool('macro_list', {});
    const caught = p.catch((e) => e);
    ws.sockets[0].deliver({ type: 'e2e:rekey', id: 'k', deviceId: DEVICE_A, payload: { reason: 'no_session' }, ts: Date.now() });
    await vi.advanceTimersByTimeAsync(10);
    expect((await caught).message).toMatch(/connection lost/);
    await vi.advanceTimersByTimeAsync(1500);
    const hellos = ws.sockets.flatMap((s) => s.sent.filter((m) => m.type === 'e2e:hello'));
    expect(hellos.length).toBe(2);
    expect(client.state).toBe('ready');
    client.close();
  });

  it('caps backoff at 60 s', async () => {
    const dk = desktopKeys();
    const ws = makeWs(dk);
    const fetchOpts = { handlers: { '/client-ticket': () => ({ status: 503, json: { error: 'down' } }) } };
    const f = makeFetch({ devices: [{ deviceId: DEVICE_A, devicePubKey: dk.e2ePublicKey }], ...fetchOpts });
    const client = createServiceClient({ stateDir, fetchImpl: f.fetchImpl, WebSocketImpl: ws.WebSocketImpl, random: () => 0.999 });
    await client.pair({ code: 'c', name: 'Kiln' });
    vi.useFakeTimers();
    const p = client.connect();
    p.catch(() => {});
    const delays = [];
    let last = Date.now();
    let seen = 1;
    for (let i = 0; i < 20 * 61; i++) {
      await vi.advanceTimersByTimeAsync(1000);
      const n = f.calls.filter((c) => c.route === '/client-ticket').length;
      if (n > seen) { delays.push(Date.now() - last); last = Date.now(); seen = n; }
      if (delays.length >= 9) break;
    }
    expect(Math.max(...delays)).toBeLessThanOrEqual(61_000);
    expect(Math.min(...delays)).toBeGreaterThanOrEqual(1000);
    expect(delays[delays.length - 1]).toBeGreaterThanOrEqual(59_000);
    client.close();
  });
});

describe('revocation and rate limits', () => {
  it('close code 4001 is terminal: state revoked, no reconnect, pending calls rejected', async () => {
    const dk = desktopKeys();
    const ws = makeWs(dk, { answerMcp: false });
    const { client } = await pairedClient({ devices: [{ deviceId: DEVICE_A, devicePubKey: dk.e2ePublicKey }], ws });
    await client.connect();
    vi.useFakeTimers();
    const p = client.callTool('macro_list', {});
    const caught = p.catch((e) => e);
    ws.sockets[0].serverClose(4001, 'token_revoked');
    await vi.advanceTimersByTimeAsync(10);
    expect(client.state).toBe('revoked');
    expect((await caught).message).toMatch(/revoked/);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(ws.sockets.length).toBe(1);
    await expect(client.callTool('macro_list', {})).rejects.toThrow(/revoked/);
  });

  it('a 401 invalid_token from client-ticket is terminal', async () => {
    const dk = desktopKeys();
    const ws = makeWs(dk);
    const fetchOpts = { handlers: { '/client-ticket': () => ({ status: 401, json: { error: 'invalid_token' } }) } };
    const { client, f } = await pairedClient({ devices: [{ deviceId: DEVICE_A, devicePubKey: dk.e2ePublicKey }], ws, fetchOpts });
    await expect(client.connect()).rejects.toThrow(/revoked/);
    expect(client.state).toBe('revoked');
    expect(ws.sockets.length).toBe(0);
    expect(f.calls.filter((c) => c.route === '/client-ticket').length).toBe(1);
  });

  it('a 401 invalid_token from client/devices is terminal', async () => {
    const dk = desktopKeys();
    const ws = makeWs(dk);
    const fetchOpts = { handlers: { '/client/devices': () => ({ status: 401, json: { error: 'invalid_token' } }) } };
    const f = makeFetch({ devices: [], ...fetchOpts });
    const client = createServiceClient({ stateDir, fetchImpl: f.fetchImpl, WebSocketImpl: ws.WebSocketImpl });
    await expect(client.pair({ code: 'c', name: 'Kiln' })).rejects.toThrow(/revoked/);
    expect(client.state).toBe('revoked');
  });

  it('a 429 waits for the next backoff step, then connects', async () => {
    const dk = desktopKeys();
    const ws = makeWs(dk);
    let n = 0;
    const fetchOpts = { handlers: { '/client-ticket': () => (++n === 1 ? { status: 429, json: { error: 'rate_limited' } } : null) } };
    const { client, f } = await pairedClient({ devices: [{ deviceId: DEVICE_A, devicePubKey: dk.e2ePublicKey }], ws, fetchOpts, random: () => 0 });
    vi.useFakeTimers();
    const p = client.connect();
    await vi.advanceTimersByTimeAsync(500);
    expect(f.calls.filter((c) => c.route === '/client-ticket').length).toBe(1);
    expect(ws.sockets.length).toBe(0);
    await vi.advanceTimersByTimeAsync(700);
    const { sas } = await p;
    expect(sas).toMatch(/^\d{6}$/);
    expect(f.calls.filter((c) => c.route === '/client-ticket').length).toBe(2);
    client.close();
  });

  it('never sends more than 10 client-ticket requests a minute', async () => {
    const dk = desktopKeys();
    // Every socket closes right after opening, before any hello answer.
    const ws = makeWs(dk, { silentHello: true });
    const { client, f } = await pairedClient({ devices: [{ deviceId: DEVICE_A, devicePubKey: dk.e2ePublicKey }], ws, random: () => 0 });
    vi.useFakeTimers();
    const origOn = ws.WebSocketImpl.prototype.emit;
    ws.WebSocketImpl.prototype.emit = function (ev, ...args) {
      const r = origOn.call(this, ev, ...args);
      if (ev === 'open') this.serverClose(1000);
      return r;
    };
    const p = client.connect();
    p.catch(() => {});
    // Opening resets the backoff, so only the ticket limit spaces these requests.
    for (let t = 0; t < 180_000; t += 250) await vi.advanceTimersByTimeAsync(250);
    const stamps = f.calls.filter((c) => c.route === '/client-ticket').map((c) => c.at);
    expect(stamps.length).toBeGreaterThan(10);
    for (let i = 10; i < stamps.length; i++) {
      expect(stamps[i] - stamps[i - 10]).toBeGreaterThanOrEqual(60_000);
    }
    ws.WebSocketImpl.prototype.emit = origOn;
    client.close();
  });
});
