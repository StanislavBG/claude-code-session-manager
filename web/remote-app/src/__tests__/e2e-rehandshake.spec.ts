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

const hellos = (w: MockWS, deviceId?: string) =>
  w.sent.filter((m) => m.type === 'e2e:hello' && (!deviceId || m.deviceId === deviceId));
const flush = () => new Promise((r) => setTimeout(r, 20));

type Internals = { e2eSessions: Map<string, { sessionKey: unknown; browserPubKeyB64: string }> };

async function setup() {
  const sock = new RelaySocket();
  await sock.connect();
  const ws = MockWS.instances[MockWS.instances.length - 1];
  ws.serve({ type: 'auth:ok', id: '', ts: 1 });
  await flush();
  await sock.initiateE2E('dev1', 'PUB1');
  await sock.initiateE2E('dev2', 'PUB2');
  const sessions = (sock as unknown as Internals).e2eSessions;
  for (const s of sessions.values()) s.sessionKey = {} as CryptoKey;
  return { sock, ws, sessions };
}

beforeEach(() => {
  MockWS.instances = [];
  vi.stubGlobal('WebSocket', MockWS);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('E2E re-handshake', () => {
  it('close then auth:ok re-sends e2e:hello with the SAME pubKey', async () => {
    const { sock, ws, sessions } = await setup();
    const pub1 = sessions.get('dev1')!.browserPubKeyB64;
    expect(sock.hasE2E('dev1')).toBe(true);

    vi.useFakeTimers();
    ws.onclose?.({ code: 1006 });
    expect(sock.hasE2E('dev1')).toBe(false);
    expect(sock.hasE2E('dev2')).toBe(false);
    await vi.advanceTimersByTimeAsync(5_000);
    vi.useRealTimers();
    const ws2 = MockWS.instances[MockWS.instances.length - 1];
    expect(ws2).not.toBe(ws);
    ws2.serve({ type: 'auth:ok', id: '', ts: 2 });
    await flush();
    const h = hellos(ws2, 'dev1');
    expect(h).toHaveLength(1);
    expect((h[0].payload as { pubKey: string }).pubKey).toBe(pub1);
    sock.destroy();
  });

  it('rejects in-flight commands immediately on close', async () => {
    const { sock, ws } = await setup();
    const p = sock.sendCommand('x', 'dev1');
    const assertion = expect(p).rejects.toThrow(/connection lost/);
    ws.onclose?.({ code: 4001 });
    await assertion;
    sock.destroy();
  });

  it('e2e:rekey triggers a fresh hello; without deviceId it is ignored', async () => {
    const { sock, ws, sessions } = await setup();
    const pub = sessions.get('dev1')!.browserPubKeyB64;
    const before = hellos(ws).length;
    ws.serve({ type: 'e2e:rekey', id: 'r0', payload: { reason: 'no_session' }, ts: 1 });
    await flush();
    expect(hellos(ws)).toHaveLength(before);
    expect(sock.hasE2E('dev1')).toBe(true);

    ws.serve({ type: 'e2e:rekey', id: 'r1', deviceId: 'dev1', payload: { reason: 'no_session' }, ts: 1 });
    await flush();
    expect(sock.hasE2E('dev1')).toBe(false);
    expect(sock.hasE2E('dev2')).toBe(true);
    const h = hellos(ws, 'dev1');
    expect(h).toHaveLength(2);
    expect((h[1].payload as { pubKey: string }).pubKey).toBe(pub);
    sock.destroy();
  });

  it('resetE2E(deviceId) clears only that device; no id clears all', async () => {
    const { sock } = await setup();
    sock.resetE2E('dev1');
    expect(sock.hasE2E('dev1')).toBe(false);
    expect(sock.hasE2E('dev2')).toBe(true);
    sock.resetE2E();
    expect(sock.hasE2E('dev2')).toBe(false);
    sock.destroy();
  });
});
