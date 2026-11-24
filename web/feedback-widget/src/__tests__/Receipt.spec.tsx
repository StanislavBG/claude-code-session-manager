// Receipt (handoff README §5.7) and the panel's error banner (§5.6), driven by the §2 machine;
// plus the toast (delayed POST + Undo) and fold (shrink → ping) success variants through App.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'preact';
import { act } from 'preact/test-utils';
import type { CaptureResult } from '../capture';
import { resolveConfig, type FeedbackConfigInput } from '../host';
import type { SendOptions, SendResult } from '../transport';
import { mountApp, type AppServices, type MountedApp } from '../ui/App';
import { ERROR_BODY_REJECTED, ERROR_BODY_RETRY, ERROR_TITLE, Panel, panelCss, type PanelProps } from '../ui/Panel';
import { Receipt, receiptCss, successCss, toastLine, type ReceiptProps } from '../ui/Receipt';
import { initialState, reduce, type Event, type State } from '../ui/machine';

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

let host: HTMLDivElement;
let shadow: ShadowRoot;

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  shadow = host.attachShadow({ mode: 'open' });
});

afterEach(() => {
  act(() => render(null, shadow as unknown as Element));
  host.remove();
});

const q = <T extends Element = HTMLElement>(sel: string) => shadow.querySelector<T>(sel);
const text = (sel: string) => q(sel)?.textContent ?? null;

function run(...events: Event[]): State {
  return events.reduce(reduce, initialState());
}

const sending = (): State =>
  run(
    { type: 'open' },
    { type: 'addMark', id: 'm1' },
    { type: 'addMark', id: 'm2' },
    { type: 'draft', title: 'Book button does nothing' },
    { type: 'describe' },
    { type: 'send' },
  );

const BASE: ReceiptProps = {
  id: 'FB-2048',
  user: { name: 'Maya Chen', email: 'maya@example.com' },
  typeLabel: 'Bug',
  title: 'Book button does nothing',
  screenshot: { width: 1280, height: 800, marks: 4 },
  console: { count: 2, on: true },
  network: { count: 1, on: true },
  onSendAnother: () => {},
  onDone: () => {},
};

function mountReceipt(p: Partial<ReceiptProps> = {}) {
  act(() => render(<Receipt {...BASE} {...p} />, shadow as unknown as Element));
}

function rows(): Record<string, string> {
  const out: Record<string, string> = {};
  shadow.querySelectorAll<HTMLElement>('.fw-rc-row').forEach((r) => {
    out[r.querySelector('.fw-rc-k')!.textContent!] = r.querySelector('.fw-rc-v')!.textContent!;
  });
  return out;
}

/** Mount the Panel wired to the real reducer. */
function live(start: State, extra: Partial<PanelProps> = {}) {
  let s = start;
  const events: Event[] = [];
  const dispatch = (e: Event) => {
    events.push(e);
    s = reduce(s, e);
    draw();
  };
  const draw = () => act(() => render(<Panel {...extra} state={s} dispatch={dispatch} />, shadow as unknown as Element));
  draw();
  return {
    get state() {
      return s;
    },
    events,
  };
}

describe('Receipt (§5.7)', () => {
  it('with a reporter: check, RECEIVED · id, first-name headline, quote body', () => {
    mountReceipt();
    expect(q('[data-part="check"] svg')).not.toBeNull();
    expect(text('[data-part="received"]')).toBe('Received · FB-2048');
    expect(text('[data-part="headline"]')).toBe("Thanks, Maya — it's with the team.");
    expect(text('[data-part="body"]')).toBe('Quote FB-2048 if you follow up. Nothing else to do.');
  });

  it('without a reporter: "Thanks — it\'s with the team." and From = Anonymous', () => {
    mountReceipt({ user: null });
    expect(text('[data-part="headline"]')).toBe("Thanks — it's with the team.");
    expect(rows().From).toBe('Anonymous');
  });

  it('dotted-leader rows Type, Title, Screenshot, Console, Network, From in order', () => {
    mountReceipt();
    expect(Object.keys(rows())).toEqual(['Type', 'Title', 'Screenshot', 'Console', 'Network', 'From']);
    expect(rows()).toEqual({
      Type: 'Bug',
      Title: 'Book button does nothing',
      Screenshot: '1280×800 · 4 marks',
      Console: '2 errors',
      Network: '1 failed request',
      From: 'Maya Chen',
    });
    expect(shadow.querySelectorAll('.fw-rc-leader')).toHaveLength(6);
  });

  it('switched-off console / network read "not sent"', () => {
    mountReceipt({ console: { count: 2, on: false }, network: { count: 1, on: false } });
    expect(rows().Console).toBe('not sent');
    expect(rows().Network).toBe('not sent');
  });

  it('no id returned: every id text is hidden', () => {
    mountReceipt({ id: null });
    expect(text('[data-part="received"]')).toBe('Received');
    expect(text('[data-part="body"]')).toBe('Nothing else to do.');
    expect(q('[data-part="receipt"]')!.textContent).not.toMatch(/FB-|·\s*$|Quote/);
    expect(text('[data-part="received"]')).not.toContain('·');
  });

  it('Send another / Done fire their callbacks', () => {
    const calls: string[] = [];
    mountReceipt({ onSendAnother: () => calls.push('another'), onDone: () => calls.push('done') });
    expect(text('[data-part="send-another"]')).toBe('Send another');
    expect(text('[data-part="done"]')).toBe('Done');
    act(() => q<HTMLButtonElement>('[data-part="send-another"]')!.click());
    act(() => q<HTMLButtonElement>('[data-part="done"]')!.click());
    expect(calls).toEqual(['another', 'done']);
  });

  it('styles: green check + eyebrow, serif 24 headline, dotted leader, 62% value, buttons', () => {
    const css = receiptCss();
    expect(css).toMatch(/\.fw-rc-check\{[^}]*width:28px;height:28px;[^}]*background:#2e5a3e/);
    expect(css).toMatch(/\.fw-rc-eyebrow\{[^}]*font-size:11px;letter-spacing:\.1em;text-transform:uppercase;color:#2e5a3e/);
    expect(css).toMatch(/\.fw-rc-headline\{[^}]*font-weight:600;font-size:24px;line-height:1\.2/);
    expect(css).toMatch(/\.fw-rc-top\{[^}]*padding:24px 22px 18px;border-bottom:1px dashed #9c937f/);
    expect(css).toMatch(/\.fw-rc-leader\{[^}]*border-bottom:1px dotted #9c937f/);
    expect(css).toMatch(/\.fw-rc-v\{[^}]*max-width:62%;[^}]*text-overflow:ellipsis/);
    expect(css).toMatch(/\.fw-rc-done\{[^}]*background:#1a1612;color:#f5f0e6/);
    expect(css).toMatch(/\.fw-rc-again\{[^}]*border:1px solid #d4ccb8/);
    // Folded into the panel's one constructed sheet (strict CSP).
    expect(panelCss()).toContain(css);
  });
});

describe('Panel in `sent` (receipt variant)', () => {
  const sent = () => reduce(sending(), { type: 'sendOk', id: 'FB-2048' });
  const attached: PanelProps['attached'] = {
    width: 1280,
    height: 800,
    console: { count: 2, on: true },
    network: { count: 0, on: false },
  };

  it('replaces the panel contents with the receipt', () => {
    live(sent(), { user: { name: 'Maya Chen' }, attached });
    expect(q('[data-part="receipt"]')).not.toBeNull();
    expect(q('.fw-pn-head')).toBeNull();
    expect(q('.fw-pn-body')).toBeNull();
    expect(q('.fw-pn-foot')).toBeNull();
    expect(text('[data-part="received"]')).toBe('Received · FB-2048');
    expect(text('[data-part="headline"]')).toBe("Thanks, Maya — it's with the team.");
    expect(rows()).toEqual({
      Type: 'Bug',
      Title: 'Book button does nothing',
      Screenshot: '1280×800 · 2 marks',
      Console: '2 errors',
      Network: 'not sent',
      From: 'Maya Chen',
    });
  });

  it('hides the id when sendOk carried none', () => {
    live(reduce(sending(), { type: 'sendOk' }), { attached });
    expect(text('[data-part="received"]')).toBe('Received');
    expect(text('[data-part="body"]')).toBe('Nothing else to do.');
    expect(text('[data-part="headline"]')).toBe("Thanks — it's with the team.");
  });

  it('Done → idle; Send another → reopens', () => {
    const a = live(sent(), { attached });
    act(() => q<HTMLButtonElement>('[data-part="done"]')!.click());
    expect(a.events).toEqual([{ type: 'done' }]);
    expect(a.state.mode).toBe('idle');

    const b = live(sent(), { attached });
    act(() => q<HTMLButtonElement>('[data-part="send-another"]')!.click());
    expect(b.events).toEqual([{ type: 'sendAnother' }]);
    expect(b.state.mode).toBe('annotate');
  });
});

describe('Error banner (§5.6)', () => {
  it('retryable failure: offline copy, Send reads "Retry now"', () => {
    live(reduce(sending(), { type: 'sendFail' }));
    expect(q('[data-part="error-banner"]')).not.toBeNull();
    expect(text('[data-part="error-title"]')).toBe("Couldn't reach the feedback server");
    expect(ERROR_TITLE).toBe("Couldn't reach the feedback server");
    expect(text('[data-part="error-body"]')).toBe(
      'Nothing is lost — this report is saved in your browser and will retry on its own.',
    );
    expect(ERROR_BODY_RETRY).toBe(text('[data-part="error-body"]'));
    expect(text('[data-part="send-label"]')).toBe('Retry now');
  });

  it('rejected (4xx): "The feedback server didn\'t accept this report."', () => {
    live(reduce(sending(), { type: 'sendFail', rejected: true }));
    expect(text('[data-part="error-body"]')).toBe("The feedback server didn't accept this report.");
    expect(ERROR_BODY_REJECTED).toBe(text('[data-part="error-body"]'));
    expect(text('[data-part="send-label"]')).toBe('Retry now');
  });

  it('Retry now dispatches send → sending, and the banner goes away', () => {
    const p = live(reduce(sending(), { type: 'sendFail' }));
    act(() => q<HTMLButtonElement>('[data-part="send"]')!.click());
    expect(p.events).toEqual([{ type: 'send' }]);
    expect(p.state.mode).toBe('sending');
    expect(q('[data-part="error-banner"]')).toBeNull();
  });

  it('no banner outside error mode', () => {
    live(sending());
    expect(q('[data-part="error-banner"]')).toBeNull();
  });

  it('styles: tinted rust box, 22 px "!" circle, 600 14 title, 400 13/1.45 body', () => {
    const css = panelCss();
    expect(css).toMatch(/\.fw-pn-banner\{[^}]*padding:12px;border-radius:9px;[^}]*background:rgba\(168,56,24,\.08\);border:1px solid rgba\(168,56,24,\.35\)/);
    expect(css).toMatch(/\.fw-pn-bang\{[^}]*width:22px;height:22px;[^}]*background:#a83818/);
    expect(css).toMatch(/\.fw-pn-bantitle\{font-weight:600;font-size:14px/);
    expect(css).toMatch(/\.fw-pn-banbody\{font-weight:400;font-size:13px;line-height:1\.45;color:#3a342b/);
  });
});

// ── Success variants through the real App (fake timers) ─────────────────────

describe('success variants (§5.7 toast / fold, receipt default)', () => {
  const KEY = 'fbk1_ABCDEFGH.AAAAAAAAAAAAAAAAAAAAAA';
  let app: MountedApp | null = null;
  let sent: SendOptions[];
  let sendResults: SendResult[];
  let animations: { el: Element; keyframes: Keyframe[]; options: KeyframeAnimationOptions }[];
  const realRect = Element.prototype.getBoundingClientRect;

  function services(): Partial<AppServices> {
    let ids = 0;
    return {
      capture: async () => {
        const r: CaptureResult = { png: new Blob([new Uint8Array([1])], { type: 'image/png' }), width: 800, height: 600, scale: 1 };
        return r;
      },
      flatten: async (png) => png,
      multipart: async (report) => ({
        body: new TextEncoder().encode(JSON.stringify(report)) as Uint8Array<ArrayBuffer>,
        contentType: 'multipart/form-data; boundary=test',
      }),
      send: async (o) => {
        sent.push(o);
        return sendResults.shift() ?? { ok: true, id: 'FB-2048' };
      },
      enqueue: async () => true,
      newId: () => `cid-${++ids}`,
    };
  }

  const tick = async (ms = 0) => {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  };

  async function mountWith(cfg: Partial<FeedbackConfigInput>) {
    window.FeedbackConfig = { key: KEY, project: 'demo', ...cfg };
    const config = resolveConfig(null);
    await act(async () => {
      app = mountApp({ config, hostEl: host, shadow, buffers: null, user: { name: 'Maya Chen' }, services: services() });
    });
    await tick();
  }

  const click = async (sel: string) => {
    await act(async () => {
      q(sel)!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await tick();
  };

  async function openAndSend(flow: 'annotate' | 'docked' = 'annotate', title = 'Button broken') {
    await act(async () => app!.open());
    await tick(10);
    if (flow === 'annotate') await click('[data-part="describe"]');
    const input = q<HTMLInputElement>('#fw-pn-title')!;
    await act(async () => {
      input.value = title;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await click('[data-part="send"]');
  }

  beforeEach(() => {
    vi.useFakeTimers();
    sent = [];
    sendResults = [];
    animations = [];
    (HTMLElement.prototype as { animate?: unknown }).animate = function (
      this: Element,
      keyframes: Keyframe[],
      options: KeyframeAnimationOptions,
    ) {
      animations.push({ el: this, keyframes, options });
      return { cancel() {} } as unknown as Animation;
    };
    Element.prototype.getBoundingClientRect = function (this: Element) {
      if (this.classList.contains('fw-launcher')) return new DOMRect(1000, 700, 52, 52);
      if (this.classList.contains('fw-panel')) return new DOMRect(600, 100, 380, 560);
      return realRect.call(this);
    };
  });

  afterEach(async () => {
    await act(async () => app?.unmount());
    app = null;
    vi.useRealTimers();
    delete (HTMLElement.prototype as { animate?: unknown }).animate;
    Element.prototype.getBoundingClientRect = realRect;
    delete window.FeedbackConfig;
  });

  it('receipt stays the default: POST at once, receipt in the panel, no toast', async () => {
    await mountWith({});
    await openAndSend();
    expect(sent).toHaveLength(1);
    expect(q('[data-part="receipt"]')).not.toBeNull();
    expect(q('[data-part="toast"]')).toBeNull();
    expect(q('[data-part="ping-bubble"]')).toBeNull();
  });

  it('toast: shows at once, POST waits 6 s, the id fills in, auto-dismiss at 6.2 s', async () => {
    await mountWith({ success: 'toast' });
    await openAndSend();
    expect(q('[data-part="toast"]')).not.toBeNull();
    expect(q('.fw-panel')).toBeNull();
    expect(q('[data-part="toast-check"] svg')).not.toBeNull();
    expect(text('[data-part="toast-title"]')).toBe('Feedback sent');
    expect(text('[data-part="toast-line"]')).toBe('thanks, Maya');
    expect(text('[data-part="undo"]')).toBe('Undo');
    expect(q('[data-part="countdown"]')).not.toBeNull();
    expect(q('[data-part="toast"]')!.className).toContain('fw-anchor--corner');

    await tick(5990);
    expect(sent).toHaveLength(0);
    await tick(10);
    expect(sent).toHaveLength(1);
    expect(sent[0].clientReportId).toBe('cid-1');
    expect(text('[data-part="toast-line"]')).toBe('FB-2048 · thanks, Maya');

    await tick(190);
    expect(q('[data-part="toast"]')).not.toBeNull();
    await tick(10);
    expect(q('[data-part="toast"]')).toBeNull();
    expect(sent).toHaveLength(1);
  });

  it('toast Undo (flow annotate): no request is sent, back to review with the draft intact', async () => {
    await mountWith({ success: 'toast' });
    await openAndSend('annotate', 'Book button does nothing');
    await tick(3000);
    await click('[data-part="undo"]');
    expect(q('[data-part="toast"]')).toBeNull();
    expect(q<HTMLInputElement>('#fw-pn-title')!.value).toBe('Book button does nothing');
    expect(q('.fw-tb')!.className).toContain('fw-tb-hidden'); // review: toolbar hidden
    expect(q('.fw-panel')!.className).not.toContain('fw-panel--hidden');
    await tick(20000);
    expect(sent).toHaveLength(0);

    // Sending again starts a fresh 6 s window with the same report id.
    await click('[data-part="send"]');
    await tick(6000);
    expect(sent).toHaveLength(1);
    expect(sent[0].clientReportId).toBe('cid-1');
  });

  it('toast Undo (other flows): back to annotate with the draft intact', async () => {
    await mountWith({ success: 'toast', flow: 'docked' });
    await openAndSend('docked', 'Docked title');
    await click('[data-part="undo"]');
    expect(q('.fw-tb')!.className).not.toContain('fw-tb-hidden'); // annotate: toolbar is back
    expect(q<HTMLInputElement>('#fw-pn-title')!.value).toBe('Docked title');
    await tick(20000);
    expect(sent).toHaveLength(0);
  });

  it('toast styles: 320 px ink card, 26 px green check, amber Undo, 6 s linear countdown', () => {
    const css = successCss();
    expect(css).toMatch(/\.fw-toast\{[^}]*width:320px;border-radius:12px;[^}]*background:#1a1612;[^}]*box-shadow:0 16px 40px -12px rgba\(26,22,18,\.65\)/);
    expect(css).toMatch(/\.fw-toast-row\{[^}]*gap:12px;padding:12px 10px 12px 14px/);
    expect(css).toMatch(/\.fw-toast-check\{[^}]*width:26px;height:26px;[^}]*background:#2e5a3e/);
    expect(css).toMatch(/\.fw-toast-title\{font-weight:600;font-size:14px/);
    expect(css).toMatch(/\.fw-toast-line\{[^}]*font-size:11px;[^}]*color:#c9bfa9/);
    expect(css).toMatch(/\.fw-toast-undo\{[^}]*color:#f4b942;[^}]*font-weight:600;font-size:13px/);
    expect(css).toMatch(/\.fw-toast-undo:hover\{background:rgba\(245,240,230,\.1\)\}/);
    expect(css).toMatch(/\.fw-toast-track\{height:3px;background:rgba\(245,240,230,\.1\)\}/);
    expect(css).toMatch(/\.fw-toast-fill\{[^}]*background:#f4b942;[^}]*animation:fw-toast-count 6000ms linear forwards/);
    expect(css).toMatch(/\.fw-ping-bubble\{[^}]*height:40px;padding:0 14px;[^}]*border-radius:10px;background:#2e5a3e;color:#f5f0e6;[^}]*font-weight:600;font-size:13px/);
    expect(css).toMatch(/\.fw-ping-id\{[^}]*font-size:11\.5px;color:#d6e3d9/);
    expect(toastLine(null, null)).toBe('thanks');
    expect(toastLine('FB-1', { name: 'Maya Chen' })).toBe('FB-1 · thanks, Maya');
  });

  it('fold: panel shrinks into the launcher centre over 450 ms, then a 3.6 s green ping + bubble', async () => {
    await mountWith({ success: 'fold' });
    await openAndSend();
    expect(sent).toHaveLength(1); // fold POSTs immediately

    // Folding: the panel is still mounted and animating; the launcher is up as the target.
    const panel = q('.fw-panel');
    expect(panel).not.toBeNull();
    expect(q('.fw-launcher')).not.toBeNull();
    expect(animations).toHaveLength(1);
    const a = animations[0];
    expect(a.el).toBe(panel);
    expect(a.options).toMatchObject({ duration: 450, easing: 'cubic-bezier(.5,0,.75,0)', fill: 'forwards' });
    // Launcher centre (1026, 726) relative to the panel's box (600, 100).
    expect(a.keyframes[0]).toMatchObject({ transformOrigin: '426px 626px', transform: 'scale(1)', opacity: 1 });
    expect(a.keyframes[1]).toMatchObject({ transformOrigin: '426px 626px', transform: 'scale(.06)', opacity: 0 });
    expect(q('.fw-launcher--ping')).toBeNull();

    await tick(470);
    expect(q('.fw-panel')).not.toBeNull();
    await tick(10);
    expect(q('.fw-panel')).toBeNull();
    expect(q('.fw-launcher--ping')).not.toBeNull();
    expect(q('.fw-launcher path')!.getAttribute('d')).toBe('M5 12.5l4.5 4.5L19 7.5');
    expect(text('[data-part="ping-bubble"]')).toBe('Sent FB-2048 — thank you');
    expect(text('.fw-ping-id')).toBe('FB-2048');
    expect(q('[data-part="ping-bubble"]')!.className).toContain('fw-anchor--corner');

    await tick(3590);
    expect(q('.fw-launcher--ping')).not.toBeNull();
    await tick(10);
    expect(q('.fw-launcher--ping')).toBeNull();
    expect(q('[data-part="ping-bubble"]')).toBeNull();
  });
});
