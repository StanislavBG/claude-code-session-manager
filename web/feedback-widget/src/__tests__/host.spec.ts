import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { HOST_ID, getReporter, init, parseKey, resetForTests, resolveConfig } from '../host';

const FP = 'AbCdEfGhIjKlMnOpQrSt_-'; // 22 base64url chars

function setWidth(w: number) {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: w });
}

function setPointers(opts: { coarse: boolean; fine: boolean }) {
  window.matchMedia = vi.fn((q: string) => ({
    matches:
      (q.includes('pointer: coarse') && opts.coarse) || (q.includes('pointer: fine') && opts.fine),
    media: q,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

// jsdom has constructable CSSStyleSheet but no adoptedStyleSheets; shim the accessor so
// host.ts takes its real (browser) path.
beforeAll(() => {
  if (!('adoptedStyleSheets' in ShadowRoot.prototype)) {
    const sheets = new WeakMap<ShadowRoot, CSSStyleSheet[]>();
    Object.defineProperty(ShadowRoot.prototype, 'adoptedStyleSheets', {
      configurable: true,
      get(this: ShadowRoot) {
        return sheets.get(this) ?? [];
      },
      set(this: ShadowRoot, v: CSSStyleSheet[]) {
        sheets.set(this, v);
      },
    });
  }
});

const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  resetForTests();
  document.body.innerHTML = '';
  delete (window as { FeedbackConfig?: unknown }).FeedbackConfig;
  delete (window as { Feedback?: unknown }).Feedback;
  setWidth(1280);
  setPointers({ coarse: false, fine: true });
});

afterEach(() => resetForTests());

describe('init()', () => {
  it('mounts the host once; a second call is a no-op', () => {
    const first = init();
    const second = init();
    expect(first).toBe(true);
    expect(second).toBe(false);
    const hosts = document.querySelectorAll(`#${HOST_ID}`);
    expect(hosts).toHaveLength(1);
    const host = hosts[0] as HTMLElement;
    expect(host.parentElement).toBe(document.body);
    expect(host.style.position).toBe('fixed');
    expect(host.style.zIndex).toBe('2147483000');
    expect(host.style.pointerEvents).toBe('none');
    expect(host.shadowRoot).not.toBeNull();
    expect(host.shadowRoot!.mode).toBe('open');
    expect(host.shadowRoot!.querySelector('style')).toBeNull();
    const sheets = host.shadowRoot!.adoptedStyleSheets;
    expect(sheets.length).toBeGreaterThan(0);
    expect(sheets[0].cssRules[0].cssText).toMatch(/:host\s*\{\s*all:\s*initial/);
    expect(typeof window.Feedback?.open).toBe('function');
    expect(typeof window.Feedback?.close).toBe('function');
  });

  it('does not render below minViewportWidth (default 640)', () => {
    setWidth(639);
    expect(init()).toBe(false);
    expect(document.getElementById(HOST_ID)).toBeNull();
  });

  it('honors a configured minViewportWidth', () => {
    setWidth(900);
    window.FeedbackConfig = { minViewportWidth: 1000 };
    expect(init()).toBe(false);
    expect(document.getElementById(HOST_ID)).toBeNull();
  });

  it('does not render on touch-only devices', () => {
    setPointers({ coarse: true, fine: false });
    expect(init()).toBe(false);
    expect(document.getElementById(HOST_ID)).toBeNull();
  });

  it('renders on hybrid devices that also have a fine pointer', () => {
    setPointers({ coarse: true, fine: true });
    expect(init()).toBe(true);
  });

  it('re-appends the host as body last child after removal', async () => {
    init();
    const host = document.getElementById(HOST_ID)!;
    host.remove();
    const other = document.createElement('main');
    document.body.appendChild(other);
    await flush();
    expect(document.body.lastElementChild).toBe(host);
  });
});

describe('parseKey()', () => {
  it('accepts fbk1_<8-char boxId>.<22-char fingerprint>', () => {
    expect(parseKey(`fbk1_7K3M9QXZ.${FP}`)).toEqual({ boxId: '7K3M9QXZ', fingerprint: FP });
  });

  it.each([
    ['', 'empty'],
    [`fbk2_7K3M9QXZ.${FP}`, 'wrong version'],
    [`fbk1_7K3M9QX.${FP}`, 'short boxId'],
    [`fbk1_7K3M9QXZZ.${FP}`, 'long boxId'],
    [`fbk1_7K3M9QXU.${FP}`, 'non-Crockford boxId'],
    [`fbk1_7K3M9QXZ.${FP.slice(1)}`, 'short fingerprint'],
    [`fbk1_7K3M9QXZ.${FP}A`, 'long fingerprint'],
    [`fbk1_7K3M9QXZ.${FP.slice(1)}=`, 'non-base64url fingerprint'],
    [`fbk1_7K3M9QXZ${FP}`, 'missing dot'],
    [` fbk1_7K3M9QXZ.${FP}`, 'surrounding whitespace'],
  ])('rejects %s (%s)', (key) => {
    expect(parseKey(key)).toBeNull();
  });

  it('rejects non-strings', () => {
    expect(parseKey(undefined)).toBeNull();
    expect(parseKey(42 as unknown as string)).toBeNull();
  });
});

describe('config', () => {
  it('script data-key / data-project win over window.FeedbackConfig', () => {
    window.FeedbackConfig = { project: 'from-config', key: 'cfg', hotkey: 'shift+g' };
    const script = document.createElement('script');
    script.dataset.key = `fbk1_7K3M9QXZ.${FP}`;
    script.dataset.project = 'from-tag';
    const cfg = resolveConfig(script);
    expect(cfg.project).toBe('from-tag');
    expect(cfg.key).toBe(`fbk1_7K3M9QXZ.${FP}`);
    expect(cfg.box).toEqual({ boxId: '7K3M9QXZ', fingerprint: FP });
    expect(cfg.hotkey).toBe('shift+g');
    expect(cfg.minViewportWidth).toBe(640);
  });

  it('falls back to window.FeedbackConfig without a script tag', () => {
    window.FeedbackConfig = { project: 'lumen' };
    const cfg = resolveConfig(null);
    expect(cfg.project).toBe('lumen');
    expect(cfg.box).toBeNull();
  });
});

describe('Feedback.identify()', () => {
  it('sets and clears the reporter', () => {
    window.FeedbackConfig = { user: { id: 'u_1', name: 'Init' } };
    init();
    expect(getReporter()).toEqual({ id: 'u_1', name: 'Init' });
    window.Feedback!.identify({ id: 'u_8841', name: 'Maya Chen', email: 'maya@lumenstays.com' });
    expect(getReporter()).toEqual({ id: 'u_8841', name: 'Maya Chen', email: 'maya@lumenstays.com' });
    window.Feedback!.identify(null);
    expect(getReporter()).toBeNull();
  });
});

describe('Feedback.identify() signed fields (exp, sig)', () => {
  it('passes exp and sig through unchanged', () => {
    init();
    window.Feedback!.identify({ id: 'u_1', exp: 1795000000, sig: 'a'.repeat(100) });
    expect(getReporter()).toEqual({ id: 'u_1', exp: 1795000000, sig: 'a'.repeat(100) });
  });

  it('keeps the old shape when exp and sig are absent', () => {
    init();
    window.Feedback!.identify({ id: 'u_1', name: 'Maya' });
    const r = getReporter()!;
    expect(r).toEqual({ id: 'u_1', name: 'Maya' });
    expect('exp' in r).toBe(false);
    expect('sig' in r).toBe(false);
  });

  it('drops a non-integer exp and its sig, leaving an unsigned reporter', () => {
    init();
    for (const exp of [1795000000.5, 0.1, Number.MAX_SAFE_INTEGER + 2]) {
      window.Feedback!.identify({ id: 'u_1', email: 'maya@lumenstays.com', exp, sig: 'a'.repeat(64) });
      const r = getReporter()!;
      expect(r).toEqual({ id: 'u_1', email: 'maya@lumenstays.com' });
      expect('exp' in r).toBe(false);
      expect('sig' in r).toBe(false);
    }
  });

  it('drops malformed exp and sig, keeping the rest', () => {
    init();
    const bad = [
      { exp: '1795000000', sig: 1 },
      { exp: Number.NaN, sig: '' },
      { exp: Number.POSITIVE_INFINITY, sig: 'a'.repeat(101) },
      { exp: null, sig: null },
    ];
    for (const b of bad) {
      window.Feedback!.identify({ id: 'u_1', ...b } as never);
      expect(getReporter()).toEqual({ id: 'u_1' });
    }
  });

  it('a lone exp/sig without an identity is still anonymous', () => {
    init();
    window.Feedback!.identify({ exp: 1795000000, sig: 'abc' } as never);
    expect(getReporter()).toBeNull();
  });

  it('reads exp and sig from FeedbackConfig.user too', () => {
    window.FeedbackConfig = { user: { id: 'u_1', exp: 1795000000, sig: 'abc' } };
    init();
    expect(getReporter()).toEqual({ id: 'u_1', exp: 1795000000, sig: 'abc' });
  });
});

describe('window.Feedback when the widget does not render', () => {
  it('exists on a touch-only page: identify stores the reporter, open/close never throw', () => {
    setPointers({ coarse: true, fine: false });
    window.FeedbackConfig = { user: { id: 'u_1' } };
    expect(init()).toBe(false);
    expect(document.getElementById(HOST_ID)).toBeNull();
    const api = window.Feedback!;
    expect(api).toBeDefined();
    expect(api.version).toBeTruthy();
    expect(getReporter()).toEqual({ id: 'u_1' });
    api.identify({ id: 'u_2', name: 'Maya' });
    expect(getReporter()).toEqual({ id: 'u_2', name: 'Maya' });
    expect(() => api.open()).not.toThrow();
    expect(() => api.close()).not.toThrow();
  });

  it('exists on a narrow page', () => {
    setWidth(320);
    expect(init()).toBe(false);
    expect(() => window.Feedback!.identify({ email: 'a@b.c' })).not.toThrow();
    expect(getReporter()).toEqual({ email: 'a@b.c' });
  });
});
