import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../api', () => ({
  getWsTicket: vi.fn(async () => ({ ticket: 't' })),
  RELAY_WSS_URL: 'wss://relay.test',
}));

import { RelaySocket } from '../ws';
import type { SendBudget } from '../frames';


class MockWS {
  static OPEN = 1;
  static instances: MockWS[] = [];
  /** bufferedAmount each send() leaves behind (a test drains it by setting bufferedAmount = 0). */
  static bufferAfterSend = 0;
  readyState = 1;
  bufferedAmount = 0;
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
    this.bufferedAmount = MockWS.bufferAfterSend;
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
  MockWS.bufferAfterSend = 0;
  vi.stubGlobal('WebSocket', MockWS);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const big = (n: number) => 'x'.repeat(n);
// ~400 KB → 3 frames
const BLOB = { blob: big(400_000) };
const FRAMES = 3;

// WebCrypto settles outside fake timers; setImmediate is left real so these ticks do too.
const tick = () => new Promise<void>((r) => setImmediate(r));
// Bounded by real elapsed time, not a tick count: under CPU load AES-GCM can need far more ticks.
// performance.now() is real (fake() fakes Date, not performance), so never read Date here.
async function until(cond: () => boolean, label: string, timeoutMs = 10_000) {
  const start = performance.now();
  while (performance.now() - start < timeoutMs) {
    if (cond()) return;
    await tick();
  }
  if (cond()) return;
  throw new Error(`until: ${label}`);
}
function track<T>(p: Promise<T>) {
  const s: { done: boolean; value?: T; error?: Error } = { done: false };
  p.then((v) => { s.done = true; s.value = v; }, (e: Error) => { s.done = true; s.error = e; });
  return s;
}
const fake = () => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
const budgetOf = (sock: RelaySocket) => (sock as unknown as { sendBudget: SendBudget }).sendBudget;
const pendingOf = (sock: RelaySocket) => (sock as unknown as { pending: Map<string, unknown> }).pending;

describe('sendRaw choke point', () => {
  it('refuses (false, nothing sent) any serialized message over 258048 bytes; accepts exactly 258048', async () => {
    const { sock, ws } = await setup();
    const base = JSON.stringify({ type: 'x', payload: '' }).length;
    expect(sock.sendRaw({ type: 'x', payload: big(258048 - base + 1) })).toBe(false);
    expect(ws.sent).toHaveLength(0);
    // multi-byte: 'é' is 2 UTF-8 bytes — the limit is bytes, not chars
    expect(sock.sendRaw({ type: 'x', payload: 'é'.repeat(130_000) })).toBe(false);
    expect(ws.sent).toHaveLength(0);
    expect(sock.sendRaw({ type: 'x', payload: big(258048 - base) })).toBe(true);
    expect(enc.encode(ws.raw[0]).length).toBe(258048);
    sock.destroy();
  });

  it('notes every non-ping message in SendBudget, never a ping', async () => {
    const { sock, ws } = await setup();
    const note = vi.spyOn(budgetOf(sock), 'note');
    expect(sock.sendRaw({ type: 'ping', id: 'p', ts: 1 })).toBe(true);
    expect(note).not.toHaveBeenCalled();
    expect(sock.sendRaw({ type: 'pong', id: 'p', ts: 1 })).toBe(true);
    expect(note).toHaveBeenCalledTimes(1);
    const p = sock.sendCommand('cmd:small', DEVICE, { a: 1 });
    p.catch(() => undefined);
    await until(() => ws.sent.length === 3, 'small box sent');
    expect(note).toHaveBeenCalledTimes(2);
    // an oversized refusal is not noted
    sock.sendRaw({ type: 'x', payload: big(300_000) });
    expect(note).toHaveBeenCalledTimes(2);
    sock.destroy();
  });

  it('framed frames are counted once, by take(), not again by note()', async () => {
    const { sock, ws } = await setup();
    const budget = budgetOf(sock);
    const note = vi.spyOn(budget, 'note');
    const take = vi.spyOn(budget, 'take');
    await expect(sock.sendEnvelope('ipc:invoke', DEVICE, BLOB)).resolves.toBe(true);
    expect(ws.sent).toHaveLength(FRAMES);
    expect(take).toHaveBeenCalledTimes(FRAMES);
    expect(note).not.toHaveBeenCalled();
    sock.destroy();
  });
});

describe('framed send waits for the socket buffer to drain', () => {
  it('holds each frame after the first until bufferedAmount is 0', async () => {
    const { sock, ws } = await setup();
    fake();
    MockWS.bufferAfterSend = 4096;
    const s = track(sock.sendEnvelope('ipc:invoke', DEVICE, BLOB));
    await until(() => ws.sent.length === 1, 'first frame');
    for (let i = 0; i < 20; i++) {
      await vi.advanceTimersByTimeAsync(50);
      await tick();
    }
    expect(ws.sent).toHaveLength(1);
    expect(s.done).toBe(false);
    ws.bufferedAmount = 0;
    await vi.advanceTimersByTimeAsync(50);
    await until(() => ws.sent.length === 2, 'second frame after drain');
    ws.bufferedAmount = 0;
    await vi.advanceTimersByTimeAsync(50);
    await until(() => s.done, 'settled');
    expect(s.value).toBe(true);
    expect(ws.sent).toHaveLength(FRAMES);
    sock.destroy();
  });

  it("rejects 'Upload stalled' after 200 checks at 50 ms and sends no further frames", async () => {
    const { sock, ws } = await setup();
    fake();
    MockWS.bufferAfterSend = 4096;
    // 4 frames → 12 s deadline, so the 200 × 50 ms stall bound is what fires
    const s = track(sock.sendCommand('cmd:big', DEVICE, { blob: big(700_000) }));
    await until(() => ws.sent.length === 1, 'first frame');
    await vi.advanceTimersByTimeAsync(150 * 50);
    await tick();
    expect(s.done).toBe(false);
    await vi.advanceTimersByTimeAsync(50 * 50);
    await until(() => s.done, 'settled');
    expect(s.error?.message).toMatch(/^Upload stalled/);
    expect(pendingOf(sock).size).toBe(0);
    ws.bufferedAmount = 0;
    await vi.advanceTimersByTimeAsync(60_000);
    for (let i = 0; i < 20; i++) await tick();
    expect(ws.sent).toHaveLength(1);
    sock.destroy();
  });
});

describe('relay error envelope aborts an in-flight framed send', () => {
  for (const code of ['rate_limited', 'device_offline']) {
    it(`'${code}' rejects 'Upload interrupted', drops the pending entry, sends nothing more`, async () => {
      const { sock, ws } = await setup();
      fake();
      MockWS.bufferAfterSend = 4096;
      const s = track(sock.sendCommand('cmd:big', DEVICE, BLOB));
      await until(() => ws.sent.length === 1, 'first frame');
      expect(pendingOf(sock).size).toBe(1);
      ws.serve({ type: 'error', id: crypto.randomUUID(), code, retryAfterMs: 1000, ts: Date.now() });
      await until(() => s.done, 'settled');
      expect(s.error?.message).toMatch(/^Upload interrupted/);
      expect(s.error?.message).toContain(code);
      expect(pendingOf(sock).size).toBe(0);
      ws.bufferedAmount = 0;
      MockWS.bufferAfterSend = 0;
      await vi.advanceTimersByTimeAsync(60_000);
      for (let i = 0; i < 20; i++) await tick();
      expect(ws.sent).toHaveLength(1);
      sock.destroy();
    });
  }

  it('an error envelope with no framed send in flight leaves commands alone', async () => {
    const { sock, ws } = await setup();
    const p = sock.sendCommand('cmd:small', DEVICE, { a: 1 });
    p.catch(() => undefined);
    await until(() => ws.sent.length === 1, 'small sent');
    ws.serve({ type: 'error', id: crypto.randomUUID(), code: 'rate_limited', ts: Date.now() });
    for (let i = 0; i < 10; i++) await tick();
    expect(pendingOf(sock).size).toBe(1);
    sock.destroy();
  });
});

describe('framed send deadline', () => {
  it("rejects 'Upload timed out' at total × 3000 ms and sends no further frames", async () => {
    const { sock, ws } = await setup();
    fake();
    const budget = budgetOf(sock);
    const realTake = budget.take.bind(budget);
    let calls = 0;
    vi.spyOn(budget, 'take').mockImplementation(() => (++calls === 1 ? realTake() : new Promise<void>(() => undefined)));
    const s = track(sock.sendCommand('cmd:big', DEVICE, BLOB));
    await until(() => ws.sent.length === 1, 'first frame');
    await vi.advanceTimersByTimeAsync(FRAMES * 3000 - 50);
    for (let i = 0; i < 10; i++) await tick();
    expect(s.done).toBe(false);
    await vi.advanceTimersByTimeAsync(50);
    await until(() => s.done, 'settled');
    expect(s.error?.message).toMatch(/^Upload timed out/);
    expect(pendingOf(sock).size).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    for (let i = 0; i < 20; i++) await tick();
    expect(ws.sent).toHaveLength(1);
    sock.destroy();
  });
});
