import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';

vi.mock('../api', () => ({
  getWsTicket: vi.fn(async () => ({ ticket: 't' })),
  RELAY_WSS_URL: 'wss://relay.test',
}));

import { RelaySocket } from '../ws';

const req = createRequire(import.meta.url);
const desktop = req('../../../../src/main/lib/feedback-remote/remoteIpcDispatch.cjs') as {
  joinFrames: (frames: { seq: number; total: number; data: string }[]) => unknown;
};

class MockWS {
  static OPEN = 1;
  static instances: MockWS[] = [];
  readyState = 1;
  raw: string[] = [];
  sent: Array<Record<string, unknown>> = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: ((e: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) {
    MockWS.instances.push(this);
  }
  send(s: string) {
    this.raw.push(s);
    this.sent.push(JSON.parse(s));
  }
  close() {}
  serve(msg: unknown) {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
}

const wait = (ms = 50) => new Promise((r) => setTimeout(r, ms));
const DEVICE = 'dev-frames';
const enc = new TextEncoder();

function b64u(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}
function unb64u(s: string): Uint8Array<ArrayBuffer> {
  const p = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(p + '=='.slice(0, (4 - (p.length % 4)) % 4));
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

type Inner = { type: string; id: string; deviceId?: string; payload?: unknown; ts: number };

async function setup(opts: { capabilities?: unknown; held?: boolean; key?: boolean } = {}) {
  const { capabilities = ['e2e-frames'], held = false, key = true } = opts;
  const device = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const devicePub = b64u(new Uint8Array(await crypto.subtle.exportKey('spki', device.publicKey)));
  const sock = new RelaySocket();
  await sock.connect();
  const ws = MockWS.instances[MockWS.instances.length - 1];
  ws.serve({ type: 'auth:ok', id: '', ts: 1 });
  await wait(20);
  await sock.initiateE2E(DEVICE, devicePub);
  const hello = ws.sent.find((m) => m.type === 'e2e:hello')!;
  const browserPub = (hello.payload as { pubKey: string }).pubKey;
  const browserKey = await crypto.subtle.importKey(
    'spki', unb64u(browserPub), { name: 'ECDH', namedCurve: 'P-256' }, false, [],
  );
  const bits = await crypto.subtle.deriveBits({ name: 'ECDH', public: browserKey }, device.privateKey, 256);
  const material = await crypto.subtle.importKey('raw', bits, 'HKDF', false, ['deriveKey']);
  const aes = await crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: enc.encode(DEVICE), info: enc.encode('sm-e2e-v1') },
    material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'],
  );
  async function box(inner: unknown) {
    const nonce = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aes, enc.encode(JSON.stringify(inner))));
    return { type: 'e2e:box', id: crypto.randomUUID(), deviceId: DEVICE, payload: { nonce: b64u(nonce), ciphertext: b64u(ct) }, ts: Date.now() };
  }
  async function open(outer: Record<string, unknown>): Promise<Inner> {
    const p = outer.payload as { nonce: string; ciphertext: string };
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64u(p.nonce) }, aes, unb64u(p.ciphertext));
    return JSON.parse(new TextDecoder().decode(pt)) as Inner;
  }
  if (key) {
    const ready = await box({ type: 'event:remote:ready', id: 'r1', payload: { ts: 1, capabilities }, ts: 1 });
    if (held) {
      ws.serve(ready);
      ws.serve({ type: 'e2e:ready', deviceId: DEVICE, ts: Date.now() });
    } else {
      ws.serve({ type: 'e2e:ready', deviceId: DEVICE, ts: Date.now() });
      await wait(30);
      ws.serve(ready);
    }
    await wait(60);
  }
  ws.sent.length = 0;
  ws.raw.length = 0;
  return { sock, ws, open, box };
}

beforeEach(() => {
  MockWS.instances = [];
  vi.stubGlobal('WebSocket', MockWS);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const big = (n: number) => 'x'.repeat(n);

async function rejoinAll(ws: MockWS, open: (o: Record<string, unknown>) => Promise<Inner>) {
  const inners = await Promise.all(ws.sent.map((o) => open(o)));
  for (const f of inners) expect(f.type).toBe('e2e:frame');
  const frames = inners.map((f) => {
    const p = f.payload as { msgId: string; seq: number; total: number; data: string };
    return { ...p, id: f.id, deviceId: f.deviceId };
  });
  return frames;
}

describe('RelaySocket framed send', () => {
  it('records capabilities from event:remote:ready (normal and held paths); cleared on reset/close', async () => {
    const a = await setup();
    expect(a.sock.hasCapability(DEVICE, 'e2e-frames')).toBe(true);
    expect(a.sock.hasCapability(DEVICE, 'nope')).toBe(false);
    a.sock.resetE2E(DEVICE);
    expect(a.sock.hasCapability(DEVICE, 'e2e-frames')).toBe(false);
    a.sock.destroy();

    MockWS.instances = [];
    const b = await setup({ held: true });
    expect(b.sock.hasCapability(DEVICE, 'e2e-frames')).toBe(true);
    b.ws.onclose?.({ code: 4001 });
    expect(b.sock.hasCapability(DEVICE, 'e2e-frames')).toBe(false);
    b.sock.destroy();

    MockWS.instances = [];
    const c = await setup({ capabilities: ['x'.repeat(65), 'e2e-frames'] });
    expect(c.sock.hasCapability(DEVICE, 'x'.repeat(65))).toBe(false);
    expect(c.sock.hasCapability(DEVICE, 'e2e-frames')).toBe(true);
    c.sock.destroy();
  });

  it('clears capabilities on e2e:rekey', async () => {
    const { sock, ws } = await setup();
    ws.serve({ type: 'e2e:rekey', id: 'r', deviceId: DEVICE, payload: {}, ts: 1 });
    await wait(20);
    expect(sock.hasCapability(DEVICE, 'e2e-frames')).toBe(false);
    sock.destroy();
  });

  it('a small command leaves as exactly one e2e:box', async () => {
    const { sock, ws, open } = await setup();
    const p = sock.sendCommand('cmd:small', DEVICE, { a: 1 });
    p.catch(() => undefined);
    await wait(30);
    expect(ws.sent).toHaveLength(1);
    expect(ws.sent[0].type).toBe('e2e:box');
    const inner = await open(ws.sent[0]);
    expect(inner.type).toBe('cmd:small');
    expect(ws.sent[0].id).toBe(inner.id);
    sock.destroy();
  });

  it('a 600 KB command is framed into ≥4 boxes ≤ 256 KiB that rejoin to the inner envelope', async () => {
    const { sock, ws, open, box } = await setup();
    const payload = { blob: big(600_000) };
    const p = sock.sendCommand('cmd:big', DEVICE, payload);
    await wait(150);
    expect(ws.sent.length).toBeGreaterThanOrEqual(4);
    for (const r of ws.raw) expect(enc.encode(r).length).toBeLessThanOrEqual(262144);
    for (const o of ws.sent) expect(o.type).toBe('e2e:box');
    const outerIds = new Set(ws.sent.map((o) => o.id));
    expect(outerIds.size).toBe(ws.sent.length);
    const frames = await rejoinAll(ws, open);
    frames.forEach((f, i) => expect(f.seq).toBe(i));
    const innerIds = new Set(frames.map((f) => f.id));
    expect(innerIds.size).toBe(frames.length);
    for (const f of frames) expect(f.deviceId).toBe(DEVICE);
    const msgId = frames[0].msgId;
    for (const f of frames) expect(f.msgId).toBe(msgId);
    const joined = desktop.joinFrames(frames) as Inner;
    expect(joined).toMatchObject({ type: 'cmd:big', id: msgId, deviceId: DEVICE, payload });
    // resp:<inner.id> still resolves it
    ws.serve(await box({ type: `resp:${msgId}`, id: 'x', payload: { ok: true }, ts: 1 }));
    await expect(p).resolves.toMatchObject({ payload: { ok: true } });
    sock.destroy();
  });

  it('sendEnvelope frames the same way', async () => {
    const { sock, ws, open } = await setup();
    const id = crypto.randomUUID();
    const sent = await sock.sendEnvelope('ipc:invoke', DEVICE, { blob: big(400_000) }, id);
    expect(sent).toBe(true);
    expect(ws.sent.length).toBeGreaterThanOrEqual(3);
    for (const r of ws.raw) expect(enc.encode(r).length).toBeLessThanOrEqual(262144);
    const frames = await rejoinAll(ws, open);
    expect(frames[0].msgId).toBe(id);
    expect(desktop.joinFrames(frames)).toMatchObject({ type: 'ipc:invoke', id, deviceId: DEVICE });
    sock.destroy();
  });

  it('refuses without the e2e-frames capability, sending nothing', async () => {
    const { sock, ws } = await setup({ capabilities: [] });
    await expect(sock.sendCommand('cmd:big', DEVICE, { blob: big(300_000) })).rejects.toThrow(/^Message too large/);
    await expect(sock.sendEnvelope('ipc:x', DEVICE, { blob: big(300_000) })).rejects.toThrow(/^Message too large/);
    expect(ws.sent).toHaveLength(0);
    sock.destroy();
  });

  it('refuses on the plaintext path (no session key), sending nothing', async () => {
    const { sock, ws } = await setup({ key: false });
    await expect(sock.sendCommand('cmd:big', DEVICE, { blob: big(300_000) })).rejects.toThrow(/^Message too large/);
    await expect(sock.sendEnvelope('ipc:x', DEVICE, { blob: big(300_000) })).rejects.toThrow(/^Message too large/);
    expect(ws.sent).toHaveLength(0);
    sock.destroy();
  });

  it('refuses over 25 MiB, sending nothing', async () => {
    const { sock, ws } = await setup();
    await expect(sock.sendCommand('cmd:big', DEVICE, { blob: big(25 * 1024 * 1024 + 1) })).rejects.toThrow(/^Message too large/);
    expect(ws.sent).toHaveLength(0);
    sock.destroy();
  });

  it('refuses over 200 frames (escape-heavy, under 25 MiB), sending nothing', async () => {
    const { sock, ws } = await setup();
    // Each '"' serializes to \" (2 bytes) that cost 3 escaped bytes → ~120 KB of JSON per frame.
    await expect(sock.sendCommand('cmd:big', DEVICE, { blob: '"'.repeat(12_200_000) })).rejects.toThrow(/^Message too large/);
    expect(ws.sent).toHaveLength(0);
    sock.destroy();
  }, 60_000);
});
