// Panel, flow annotate — handoff README §5.6 (Container, Geometry "annotate", Header, Body
// Type/Title/Details, Footer) driven by the §2 machine.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'preact';
import { act } from 'preact/test-utils';
import {
  BACK_LABEL,
  DETAILS_MAX,
  EYEBROW,
  HEADLINE,
  Panel,
  TITLE_ERROR,
  TITLE_MAX,
  TYPES,
  panelCss,
  reporterView,
  sendButtonLabel,
  shortcutChip,
  titleValid,
  type PanelProps,
} from '../ui/Panel';
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
  vi.useRealTimers();
});

function run(...events: Event[]): State {
  return events.reduce(reduce, initialState());
}

const OPEN: Event = { type: 'open' };
const DESCRIBE: Event = { type: 'describe' };
const review = (title = '') => run(OPEN, { type: 'draft', title }, DESCRIBE);
const sending = () => run(OPEN, { type: 'draft', title: 'Broken' }, DESCRIBE, { type: 'send' });
const errored = () => reduce(sending(), { type: 'sendFail' });

function mount(props: Partial<PanelProps> & { state: State }) {
  act(() => {
    render(<Panel dispatch={() => {}} {...props} />, shadow as unknown as Element);
  });
  return shadow.querySelector<HTMLDivElement>('.fw-panel')!;
}

/** Mount wired to the real reducer so typing/clicking moves the machine. */
function live(start: State, extra: Partial<PanelProps> = {}) {
  let s = start;
  const events: Event[] = [];
  const dispatch = (e: Event) => {
    events.push(e);
    s = reduce(s, e);
    draw();
  };
  const draw = () =>
    act(() => {
      render(<Panel {...extra} state={s} dispatch={dispatch} />, shadow as unknown as Element);
    });
  draw();
  return { get state() { return s; }, events, redraw: draw };
}

const q = <T extends Element>(sel: string) => shadow.querySelector<T>(sel);
const title = () => q<HTMLInputElement>('#fw-pn-title')!;
const details = () => q<HTMLTextAreaElement>('#fw-pn-details')!;
const send = () => q<HTMLButtonElement>('[data-part="send"]')!;
const label = () => q('[data-part="send-label"]')!.textContent;

function type(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  act(() => {
    el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('container, geometry, transition (§5.6)', () => {
  const css = panelCss();
  it('corner card: right 20, bottom 20, width 380, max-height H−40, column, body scrolls', () => {
    const rule = css.split('\n').find((l) => l.startsWith('.fw-panel{'))!;
    for (const d of [
      'position:fixed', 'z-index:30', 'right:20px', 'bottom:20px', 'width:380px', 'max-height:calc(100vh - 40px)',
      'flex-direction:column', 'overflow:hidden', 'background:#f5f0e6', 'border:1px solid #d4ccb8', 'border-radius:14px',
      'box-shadow:0 1px 0 rgba(42,36,28,.05), 0 24px 60px -18px rgba(26,22,18,.5)', 'transform-origin:right bottom',
      'opacity 280ms cubic-bezier(.2,.8,.2,1)', 'transform 400ms cubic-bezier(.2,.8,.2,1)', 'visibility 400ms',
    ]) expect(rule).toContain(d);
    expect(css).toMatch(/\.fw-pn-body\{[^}]*flex:1 1 auto;min-height:0;overflow-y:auto/);
    expect(css).toMatch(/\.fw-pn-foot\{flex:none/);
    expect(css).toMatch(/\.fw-pn-head\{flex:none/);
  });

  it('enters from translateY(16px) scale(.98), opacity 0; mini → left 20, origin left bottom', () => {
    expect(css).toContain('.fw-panel--hidden{opacity:0;visibility:hidden;transform:translateY(16px) scale(.98)');
    expect(css).toContain('.fw-panel--mini{right:auto;left:20px;transform-origin:left bottom}');
    expect(mount({ state: review(), mini: true }).className).toContain('fw-panel--mini');
  });

  it('is hidden in annotate/idle and shown in review, sending, error', () => {
    expect(mount({ state: initialState() }).className).toContain('fw-panel--hidden');
    expect(mount({ state: run(OPEN) }).getAttribute('aria-hidden')).toBe('true');
    for (const s of [review(), sending(), errored()]) {
      const el = mount({ state: s });
      expect(el.className).not.toContain('fw-panel--hidden');
      expect(el.getAttribute('aria-hidden')).toBeNull();
    }
  });

  it('adopts its stylesheet into the shadow root', () => {
    mount({ state: review() });
    expect(shadow.adoptedStyleSheets.length).toBeGreaterThan(0);
  });
});

describe('header', () => {
  it('eyebrow + headline copy', () => {
    mount({ state: review() });
    expect(q('.fw-pn-eyebrow')!.textContent).toBe(EYEBROW);
    expect(EYEBROW).toBe('Step 2 of 2 · Describe');
    expect(q('.fw-pn-headline')!.textContent).toBe(HEADLINE);
    expect(HEADLINE).toBe('Describe what you marked');
  });

  it('← Marks shows in review and error only, and goes back to annotate', () => {
    mount({ state: sending() });
    expect(q('[data-part="back"]')).toBeNull();
    mount({ state: errored() });
    expect(q('[data-part="back"]')!.textContent).toBe(BACK_LABEL);
    const p = live(review());
    expect(q('[data-part="back"]')!.textContent).toBe('← Marks');
    act(() => q<HTMLButtonElement>('[data-part="back"]')!.click());
    expect(p.state.mode).toBe('annotate');
  });

  it('close dispatches closeRequest', () => {
    const p = live(review());
    act(() => q<HTMLButtonElement>('[data-part="close"]')!.click());
    expect(p.events).toContainEqual({ type: 'closeRequest' });
    expect(p.state.mode).toBe('idle');
  });
});

describe('type segmented control', () => {
  it('Bug, Feature request, Other with dots; Bug selected by default', () => {
    mount({ state: review() });
    const segs = [...shadow.querySelectorAll<HTMLButtonElement>('.fw-pn-segbtn')];
    expect(segs.map((b) => b.textContent)).toEqual(['Bug', 'Feature request', 'Other']);
    expect(segs.map((b) => b.getAttribute('aria-checked'))).toEqual(['true', 'false', 'false']);
    segs.forEach((b) => expect(b.querySelector('.fw-pn-dot')).not.toBeNull());
    const css = panelCss();
    expect(css).toContain('.fw-pn-dot--bug{background:#a83818}');
    expect(css).toContain('.fw-pn-dot--feature{background:#f4b942}');
    expect(css).toContain('.fw-pn-dot--other{background:#9c937f}');
  });

  it('placeholders follow the selected type', () => {
    const onType = vi.fn();
    live(review(), { onType });
    const expected = {
      bug: ['e.g. Book button does nothing', 'What did you do, what happened, and what did you expect?'],
      feature: ['e.g. Let me save a stay for later', 'What are you trying to do, and what would make it easier?'],
      other: ['One-line summary', 'Anything else we should know?'],
    } as const;
    expect([title().placeholder, details().placeholder]).toEqual(expected.bug);
    for (const t of TYPES) {
      act(() => q<HTMLButtonElement>(`[data-type="${t.id}"]`)!.click());
      expect(q(`[data-type="${t.id}"]`)!.getAttribute('aria-checked')).toBe('true');
      expect([title().placeholder, details().placeholder]).toEqual(expected[t.id]);
      expect(onType).toHaveBeenLastCalledWith(t.id);
    }
  });

  it('controlled reportType wins', () => {
    mount({ state: review(), reportType: 'other' });
    expect(title().placeholder).toBe('One-line summary');
  });
});

describe('title + details validation', () => {
  it('titleValid: trimmed 3–120', () => {
    expect(titleValid('')).toBe(false);
    expect(titleValid('  ab  ')).toBe(false);
    expect(titleValid(' abc ')).toBe(true);
    expect(titleValid('x'.repeat(TITLE_MAX))).toBe(true);
    expect(titleValid('x'.repeat(TITLE_MAX + 1))).toBe(false);
  });

  it('input limits: title max 120, details max 5000 and 4 rows', () => {
    mount({ state: review() });
    expect(title().maxLength).toBe(120);
    expect(details().maxLength).toBe(DETAILS_MAX);
    expect(DETAILS_MAX).toBe(5000);
    expect(details().rows).toBe(4);
    expect(details().required).toBe(false);
    expect(q('.fw-pn-opt')!.textContent).toBe('optional');
  });

  it('Send with a short title shows the error and focuses Title; typing a valid title clears it', () => {
    const p = live(review('  ab '));
    expect(q('.fw-pn-error')).toBeNull();
    act(() => send().click());
    expect(p.state.mode).toBe('review');
    expect(q('.fw-pn-error')!.textContent).toBe(TITLE_ERROR);
    expect(TITLE_ERROR).toBe('Add a short title so the team can find this.');
    expect(title().getAttribute('aria-invalid')).toBe('true');
    expect(shadow.activeElement).toBe(title());
    type(title(), 'Book button');
    expect(q('.fw-pn-error')).toBeNull();
    act(() => send().click());
    expect(p.state.mode).toBe('sending');
  });

  it('typing details dispatches draft body', () => {
    const p = live(review('Broken'));
    type(details(), 'steps');
    expect(p.state.draft.body).toBe('steps');
  });

  it('focuses Title 420 ms after Describe', () => {
    vi.useFakeTimers();
    const before = run(OPEN, { type: 'draft', title: 'x' });
    mount({ state: before });
    const s = reduce(before, DESCRIBE);
    act(() => render(<Panel state={s} dispatch={() => {}} />, shadow as unknown as Element));
    expect(shadow.activeElement).not.toBe(title());
    act(() => {
      vi.advanceTimersByTime(419);
    });
    expect(shadow.activeElement).not.toBe(title());
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(shadow.activeElement).toBe(title());
  });
});

describe('send button', () => {
  it('labels: Send feedback → Sending… n% → Retry now', () => {
    expect(sendButtonLabel('review', 0)).toBe('Send feedback');
    expect(sendButtonLabel('sending', 41.6)).toBe('Sending… 42%');
    expect(sendButtonLabel('error', 50)).toBe('Retry now');
    mount({ state: review('Broken') });
    expect(label()).toBe('Send feedback');
    mount({ state: sending(), progress: 37 });
    expect(label()).toBe('Sending… 37%');
    mount({ state: errored() });
    expect(label()).toBe('Retry now');
  });

  it('opacity .55 while the title is invalid, but still clickable', () => {
    expect(panelCss()).toContain('.fw-pn-send--invalid{opacity:.55}');
    const onDispatch = vi.fn();
    mount({ state: review('ab'), dispatch: onDispatch });
    expect(send().className).toContain('fw-pn-send--invalid');
    expect(send().disabled).toBe(false);
    act(() => send().click());
    expect(onDispatch).toHaveBeenCalledWith({ type: 'send' });
    mount({ state: review('Broken') });
    expect(send().className).not.toContain('fw-pn-send--invalid');
  });

  it('shortcut chip per platform', () => {
    expect(shortcutChip('MacIntel')).toBe('⌘↵');
    expect(shortcutChip('Win32')).toBe('Ctrl↵');
    mount({ state: review(), platform: 'MacIntel' });
    expect(q('.fw-pn-key')!.textContent).toBe('⌘↵');
  });

  it('3 px progress bar at upload % only while sending', () => {
    expect(panelCss()).toMatch(/\.fw-pn-progress\{position:absolute;top:0;left:0;height:3px;[^}]*background:#a83818/);
    mount({ state: review('Broken'), progress: 20 });
    expect(q('[data-part="progress"]')).toBeNull();
    mount({ state: sending(), progress: 64 });
    expect(q<HTMLDivElement>('[data-part="progress"]')!.style.width).toBe('64%');
    mount({ state: errored(), progress: 64 });
    expect(q('[data-part="progress"]')).toBeNull();
  });

  it('every input is disabled while sending, and enabled again on error', () => {
    mount({ state: sending(), progress: 10 });
    const controls = [...shadow.querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLTextAreaElement>('button, input, textarea')];
    expect(controls.length).toBeGreaterThanOrEqual(6);
    controls.forEach((c) => expect(c.disabled).toBe(true));
    mount({ state: errored() });
    [...shadow.querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLTextAreaElement>('button, input, textarea')].forEach((c) =>
      expect(c.disabled).toBe(false),
    );
  });
});

describe('reporter footer', () => {
  it('anonymous: ?, Anonymous, not signed in', () => {
    mount({ state: review(), user: null });
    expect(q('[data-part="avatar"]')!.textContent).toBe('?');
    expect(q('[data-part="name"]')!.textContent).toBe('Anonymous');
    expect(q('[data-part="sub"]')!.textContent).toBe('not signed in');
    expect(reporterView(undefined)).toEqual({ initials: '?', name: 'Anonymous', sub: 'not signed in' });
    expect(reporterView({})).toEqual({ initials: '?', name: 'Anonymous', sub: 'not signed in' });
  });

  it('signed in: initials + name + from site login', () => {
    mount({ state: review(), user: { id: 'u1', name: 'Maya Lindqvist' } });
    expect(q('[data-part="avatar"]')!.textContent).toBe('ML');
    expect(q('[data-part="name"]')!.textContent).toBe('Maya Lindqvist');
    expect(q('[data-part="sub"]')!.textContent).toBe('from site login');
    expect(reporterView({ name: 'Cher' }).initials).toBe('CH');
    expect(reporterView({ email: 'jo.doe@example.com' })).toEqual({ initials: 'JD', name: 'jo.doe@example.com', sub: 'from site login' });
  });
});
