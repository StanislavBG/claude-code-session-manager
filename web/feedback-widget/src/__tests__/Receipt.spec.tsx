// Receipt (handoff README §5.7) and the panel's error banner (§5.6), driven by the §2 machine.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { ERROR_BODY_REJECTED, ERROR_BODY_RETRY, ERROR_TITLE, Panel, panelCss, type PanelProps } from '../ui/Panel';
import { Receipt, receiptCss, type ReceiptProps } from '../ui/Receipt';
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
