// @vitest-environment jsdom
'use strict';
const { PLAYER_BRIDGE_SCRIPT, injectPlayerBridge } = require('../playerBridge.cjs');
const { validateDemoVideoHtml, injectCsp } = require('../../feedback-remote/projectHomeAdminRoutes.cjs');

function makeDemo() {
  const d = {
    duration: 30, t: 0, playing: false, muted: false,
    scenes: [{ start: 0, title: 'Intro' }, { t: 10, label: 'Middle' }],
    play: vi.fn(() => { d.playing = true; }),
    pause: vi.fn(() => { d.playing = false; }),
    restart: vi.fn(() => { d.t = 0; d.playing = true; }),
    seek: vi.fn((t) => { d.t = t; }),
    setMuted: vi.fn((m) => { d.muted = m; }),
    getTime: () => d.t,
  };
  return d;
}

function send(data) {
  const source = { postMessage: vi.fn() };
  const ev = new window.Event('message');
  ev.data = data;
  Object.defineProperty(ev, 'source', { value: source });
  window.dispatchEvent(ev);
  return source.postMessage;
}

describe('playerBridge', () => {
  let demo;
  let listeners = [];
  beforeEach(() => {
    listeners.forEach((l) => window.removeEventListener('message', l));
    listeners = [];
    const orig = window.addEventListener.bind(window);
    window.addEventListener = (type, fn, ...rest) => {
      if (type === 'message') listeners.push(fn);
      return orig(type, fn, ...rest);
    };
    vi.useFakeTimers();
    document.body.innerHTML = '<video></video><audio></audio>';
    demo = makeDemo();
    window.smDemo = demo;
    // Test-only: run the bridge source in this jsdom window.
    window.eval(PLAYER_BRIDGE_SCRIPT.replace(/^<script[^>]*>|<\/script>$/g, ''));
  });
  afterEach(() => { vi.useRealTimers(); });

  it('hello reports state with normalized scenes', () => {
    const pm = send({ smPlayer: 1, cmd: 'hello' });
    expect(pm).toHaveBeenCalledTimes(1);
    const [msg, origin] = pm.mock.calls[0];
    expect(origin).toBe('*');
    expect(msg).toEqual({
      smPlayer: 1, type: 'state', duration: 30, t: 0, playing: false, muted: false,
      scenes: [{ t: 0, label: 'Intro' }, { t: 10, label: 'Middle' }],
    });
  });

  it('ignores messages without smPlayer:1', () => {
    expect(send({ cmd: 'play' })).not.toHaveBeenCalled();
    expect(send('play')).not.toHaveBeenCalled();
    expect(demo.play).not.toHaveBeenCalled();
  });

  it('play starts, ticks every 250ms, pause clears the interval', () => {
    const pm = send({ smPlayer: 1, cmd: 'play' });
    expect(demo.play).toHaveBeenCalled();
    expect(pm.mock.calls[0][0].playing).toBe(true);
    demo.t = 1;
    vi.advanceTimersByTime(250);
    expect(pm).toHaveBeenCalledTimes(2);
    expect(pm.mock.calls[1][0].t).toBe(1);
    vi.advanceTimersByTime(500);
    expect(pm).toHaveBeenCalledTimes(4);
    const pm2 = send({ smPlayer: 1, cmd: 'pause' });
    expect(demo.pause).toHaveBeenCalled();
    expect(pm2.mock.calls[0][0].playing).toBe(false);
    vi.advanceTimersByTime(1000);
    expect(pm).toHaveBeenCalledTimes(4);
  });

  it('interval stops when playback ends', () => {
    const pm = send({ smPlayer: 1, cmd: 'play' });
    demo.t = 30; demo.playing = false;
    vi.advanceTimersByTime(250);
    const n = pm.mock.calls.length;
    expect(pm.mock.calls[n - 1][0].playing).toBe(false);
    vi.advanceTimersByTime(1000);
    expect(pm).toHaveBeenCalledTimes(n);
  });

  it('restart and seek', () => {
    demo.t = 12;
    const pm = send({ smPlayer: 1, cmd: 'restart' });
    expect(demo.restart).toHaveBeenCalled();
    expect(pm.mock.calls[0][0].t).toBe(0);
    const pm2 = send({ smPlayer: 1, cmd: 'seek', t: 10 });
    expect(demo.seek).toHaveBeenCalledWith(10);
    expect(pm2.mock.calls[0][0].t).toBe(10);
  });

  it('mute / unmute hit media elements and smDemo.setMuted', () => {
    const pm = send({ smPlayer: 1, cmd: 'mute' });
    expect(document.querySelector('video').muted).toBe(true);
    expect(document.querySelector('audio').muted).toBe(true);
    expect(demo.setMuted).toHaveBeenCalledWith(true);
    expect(pm.mock.calls[0][0].muted).toBe(true);
    const pm2 = send({ smPlayer: 1, cmd: 'unmute' });
    expect(document.querySelector('video').muted).toBe(false);
    expect(demo.setMuted).toHaveBeenCalledWith(false);
    expect(pm2.mock.calls[0][0].muted).toBe(false);
  });
});

describe('injectPlayerBridge', () => {
  const sample = '<!DOCTYPE html><html><head><meta name="sm-demo-duration" content="30"></head><body><p>hi</p></body></html>';

  it('inserts right after the CSP meta and is idempotent', () => {
    const once = injectPlayerBridge(injectCsp(sample));
    const csp = once.indexOf('Content-Security-Policy');
    const cspEnd = once.indexOf('>', csp) + 1;
    expect(once.slice(cspEnd).startsWith('<script data-sm-player-bridge')).toBe(true);
    const twice = injectPlayerBridge(once);
    expect(twice).toBe(once);
    expect(twice.split('data-sm-player-bridge').length - 1).toBe(1);
  });

  it('passes validateDemoVideoHtml with the bridge injected', () => {
    expect(validateDemoVideoHtml(injectPlayerBridge(injectCsp(sample)))).toBeNull();
  });
});
