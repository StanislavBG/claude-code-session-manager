// Entry wiring: index.ts mounts App inside host.ts's shadow root and wires window.Feedback.
import { afterAll, describe, expect, it } from 'vitest';
import { resetForTests } from '../host';

afterAll(() => resetForTests());

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

describe('index', () => {
  it('mounts the launcher in the host shadow root and wires window.Feedback', async () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1280 });
    window.FeedbackConfig = { key: 'fbk1_ABCDEFGH.AAAAAAAAAAAAAAAAAAAAAA', user: { name: 'Ada' } };
    await import('../index');
    await new Promise((r) => setTimeout(r, 0));
    const host = document.getElementById('feedback-widget-host')!;
    expect(host).not.toBeNull();
    expect(host.shadowRoot!.querySelector('.fw-launcher')).not.toBeNull();
    const api = window.Feedback!;
    expect(typeof api.open).toBe('function');
    expect(typeof api.close).toBe('function');
    expect(api.version).toBeTruthy();
    api.identify({ name: 'Grace' });
    const { getReporter } = await import('../host');
    expect(getReporter()).toEqual({ name: 'Grace' });
  });
});
