import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../api', () => ({
  getWsTicket: vi.fn(async () => ({ ticket: 't' })),
  RELAY_WSS_URL: 'wss://relay.test',
}));

import { RelaySocket } from '../ws';

class MockWS {
  static OPEN = 1;
  static instances: MockWS[] = [];
  readyState = 1;
  sent: Array<Record<string, unknown>> = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: ((e: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) {
    MockWS.instances.push(this);
  }
  send(s: string) {
    this.sent.push(JSON.parse(s));
  }
  close() {}
  serve(msg: unknown) {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
}

const wait = (ms = 100) => new Promise((r) => setTimeout(r, ms));
const DEVICE = 'dev-pinned';

function b64u(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}
function unb64u(s: string): Uint8Array<ArrayBuffer> {
  const p = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(p + '=='.slice(0, (4 - (p.length % 4)) % 4));
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function setup() {
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
  const enc = new TextEncoder();
  const aes = await crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: enc.encode(DEVICE), info: enc.encode('sm-e2e-v1') },
    material, { name: 'AES-GCM', length: 256 }, false, ['encrypt'],
  );
  async function box(inner: unknown, tamper = false) {
    const nonce = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aes, enc.encode(JSON.stringify(inner))));
    if (tamper) ct[0] ^= 0xff;
    return { type: 'e2e:box', id: 'b1', deviceId: DEVICE, payload: { nonce: b64u(nonce), ciphertext: b64u(ct) }, ts: Date.now() };
  }
  const readyFrame = { type: 'e2e:ready', deviceId: DEVICE, ts: Date.now() };
  const innerReady = { type: 'event:remote:ready', id: 'r1', payload: { ts: 1 }, ts: 1 };
  return { sock, ws, box, readyFrame, innerReady };
}

function spy(sock: RelaySocket) {
  const calls = { remoteReady: 0, e2eReady: 0, sas: [] as string[] };
  sock.on('event:remote:ready', () => { calls.remoteReady++; });
  sock.on('e2e:ready', () => { calls.e2eReady++; });
  sock.on('sas:pending', (e) => { calls.sas.push((e.payload as { sas: string }).sas); });
  return calls;
}

beforeEach(() => {
  MockWS.instances = [];
  vi.stubGlobal('WebSocket', MockWS);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('pinned-browser handshake ordering', () => {
  it('(a) boxed remote:ready before e2e:ready is dispatched and suppresses sas:pending', async () => {
    const { sock, ws, box, readyFrame, innerReady } = await setup();
    const calls = spy(sock);
    ws.serve(await box(innerReady));
    ws.serve(readyFrame);
    await wait();
    expect(calls.remoteReady).toBe(1);
    expect(calls.e2eReady).toBe(1);
    expect(calls.sas).toHaveLength(0);
    expect(sock.hasE2E(DEVICE)).toBe(true);
    sock.destroy();
  });

  it('(b) e2e:ready alone emits sas:pending with a 6-digit code', async () => {
    const { sock, ws, readyFrame } = await setup();
    const calls = spy(sock);
    ws.serve(readyFrame);
    await wait();
    expect(calls.sas).toHaveLength(1);
    expect(calls.sas[0]).toMatch(/^\d{6}$/);
    expect(calls.remoteReady).toBe(0);
    sock.destroy();
  });

  it('(c) a tampered held box is dropped and sas:pending still fires', async () => {
    const { sock, ws, box, readyFrame, innerReady } = await setup();
    const calls = spy(sock);
    ws.serve(await box(innerReady, true));
    ws.serve(readyFrame);
    await wait();
    expect(calls.remoteReady).toBe(0);
    expect(calls.sas).toHaveLength(1);
    sock.destroy();
  });
});
