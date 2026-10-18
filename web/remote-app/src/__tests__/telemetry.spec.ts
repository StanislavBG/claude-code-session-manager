import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { APP, track, trackFlow, trackScreen } from '../telemetry';

function setBeacon(value: unknown) {
  Object.defineProperty(navigator, 'sendBeacon', { value, configurable: true });
}

async function decode(call: unknown[]) {
  const blob = call[1] as Blob;
  const text = await new Promise<string>((resolve, reject) => {
    const r = new FileReader(); // jsdom's Blob has no .text()
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsText(blob);
  });
  return JSON.parse(text);
}

describe('telemetry', () => {
  let beacon: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    beacon = vi.fn(() => true);
    setBeacon(beacon);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends the beacon payload with json Blob type and default path', async () => {
    track('hello', { a: 1 });
    expect(beacon).toHaveBeenCalledTimes(1);
    expect(beacon.mock.calls[0][0]).toBe('/api/telemetry/event');
    const blob = beacon.mock.calls[0][1] as Blob;
    expect(blob.type).toBe('application/json');
    const body = await decode(beacon.mock.calls[0]);
    expect(APP).toBe('session-manager');
    expect(body.batch).toHaveLength(1);
    expect(body.batch[0]).toMatchObject({ app: 'session-manager', name: 'hello' });
    expect(typeof body.batch[0].ts).toBe('number');
    expect(body.batch[0].props).toEqual({ a: 1, path: location.pathname });
  });

  it('keeps a caller-set path', async () => {
    track('x', { path: '/custom' });
    expect((await decode(beacon.mock.calls[0])).batch[0].props.path).toBe('/custom');
  });

  it('redacts PII keys', async () => {
    track('x', { email: 'a@b.c', apiKey: 'k', Password: 'p', ok: 1 });
    const props = (await decode(beacon.mock.calls[0])).batch[0].props;
    expect(props.email).toBe('[redacted]');
    expect(props.apiKey).toBe('[redacted]');
    expect(props.Password).toBe('[redacted]');
    expect(props.ok).toBe(1);
  });

  it('trackFlow sends flow.step and drops invalid names', async () => {
    trackFlow('pair', 'start', { n: 1 });
    const e = (await decode(beacon.mock.calls[0])).batch[0];
    expect(e.name).toBe('pair.start');
    expect(e.props).toMatchObject({ n: 1, flow: 'pair', step: 'start' });
    trackFlow('Bad', 'start');
    trackFlow('pair', '-no');
    trackFlow('pair', 'a'.repeat(41));
    expect(beacon).toHaveBeenCalledTimes(1);
  });

  it('trackScreen sends screen_view and drops invalid screens', async () => {
    trackScreen('home');
    const e = (await decode(beacon.mock.calls[0])).batch[0];
    expect(e.name).toBe('screen_view');
    expect(e.props.screen).toBe('home');
    trackScreen('Not Valid');
    expect(beacon).toHaveBeenCalledTimes(1);
  });

  it('falls back to fetch when sendBeacon returns false', () => {
    beacon.mockReturnValue(false);
    const f = vi.fn(() => Promise.reject(new Error('net')));
    vi.stubGlobal('fetch', f);
    track('x');
    expect(f).toHaveBeenCalledTimes(1);
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/telemetry/event');
    expect(init).toMatchObject({
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      keepalive: true,
      credentials: 'same-origin',
    });
    expect(typeof init.body).toBe('string');
  });

  it('does not throw when sendBeacon throws', () => {
    setBeacon(() => {
      throw new Error('boom');
    });
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response())));
    expect(() => track('x')).not.toThrow();
  });

  it('does not throw on unserializable props', () => {
    const a: Record<string, unknown> = {};
    a.self = a;
    expect(() => track('x', a)).not.toThrow();
  });
});
