// Panel, flow annotate — handoff README §5.6 (Container, Geometry "annotate", Header, Body
// Type/Title/Details, Footer) driven by the §2 machine.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { useState } from 'preact/hooks';
import {
  BACK_LABEL,
  DETAILS_MAX,
  DOCKED_HEADLINE,
  EYEBROW,
  HEADLINE,
  SWAP_TITLE,
  dockedEyebrow,
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
import { initialState, reduce, toolbarVisible, type Event, type State } from '../ui/machine';
import { CaptureChrome } from '../ui/CaptureChrome';
import { PANEL_COLUMN, freeArea, type PanelSide } from '../ui/shared';
import { Toolbar } from '../ui/Toolbar';
import { DEFAULT_MARK_COLOR, number, type Mark } from '../ui/marks';
import { NOTE_FIRST_HINT, hintText } from '../ui/CaptureChrome';
import {
  NOTE_DETAILS_ROWS,
  NOTE_FOCUS_TITLE_DELAY_MS,
  NOTE_WIDTH,
  markOpensPopover,
  noteAnchorBox,
  noteEyebrow,
  noteGeometry,
} from '../ui/Panel';
import { PanelContext, SUMMARY_HIDE, SUMMARY_REVIEW, summaryLine, type PanelContextProps } from '../ui/PanelContext';
import { MarksLayer } from '../ui/MarksLayer';
import type { ConsoleEntry, NetworkEntry } from '../buffers';

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

// ── Flow docked (§5.6 "docked — side panel", Swap side; §5.3 Free area) ─────────────────────

const dockedRun = (...events: Event[]): State => events.reduce(reduce, initialState({ flow: 'docked' }));
const dockedOpen = () => dockedRun(OPEN);
const dockedSending = () => dockedRun(OPEN, { type: 'draft', title: 'Broken' }, { type: 'send' });

describe('flow docked — geometry', () => {
  const css = panelCss();
  it('side panel: top 16, bottom 16, right 16, width 380; left 16 after a swap', () => {
    const base = css.split('\n').find((l) => l.startsWith('.fw-panel{'))!;
    expect(base).toContain('width:380px');
    expect(css).toContain('.fw-panel--docked{top:16px;bottom:16px;right:16px;left:auto;max-height:none;');
    expect(css).toContain('.fw-panel--docked.fw-panel--left{right:auto;left:16px;');
  });

  it('enters from translateX(+24px) on the right, translateX(-24px) on the left', () => {
    expect(css).toContain('.fw-panel--docked.fw-panel--hidden{transform:translateX(24px)}');
    expect(css).toContain('.fw-panel--docked.fw-panel--left.fw-panel--hidden{transform:translateX(-24px)}');
    // Reduced motion drops the slide for both sides.
    const reduced = css.slice(css.indexOf('@media (prefers-reduced-motion:reduce)'));
    expect(reduced).toContain('.fw-panel--docked.fw-panel--hidden');
    expect(reduced).toContain('.fw-panel--docked.fw-panel--left.fw-panel--hidden{transform:none}');
  });

  it('is visible from open onward (annotate, sending, error), hidden when idle', () => {
    expect(mount({ state: initialState({ flow: 'docked' }) }).className).toContain('fw-panel--hidden');
    const el = mount({ state: dockedOpen() });
    expect(el.className).toContain('fw-panel--docked');
    expect(el.className).not.toContain('fw-panel--hidden');
    expect(el.dataset.side).toBe('right');
    expect(mount({ state: dockedSending() }).className).not.toContain('fw-panel--hidden');
    expect(mount({ state: reduce(dockedSending(), { type: 'sendFail' }) }).className).not.toContain('fw-panel--hidden');
  });

  it('ignores the mini launcher (that only moves the annotate corner card)', () => {
    const el = mount({ state: dockedOpen(), mini: true });
    expect(el.className).not.toContain('fw-panel--mini');
  });

  it('controlled side=left renders on the left', () => {
    const el = mount({ state: dockedOpen(), side: 'left' });
    expect(el.className).toContain('fw-panel--left');
    expect(el.dataset.side).toBe('left');
  });
});

describe('flow docked — header', () => {
  it("eyebrow 'Feedback · {hostname}', headline \"What's going on?\"", () => {
    mount({ state: dockedOpen(), hostname: 'stays.example.com' });
    expect(q('.fw-pn-eyebrow')!.textContent).toBe('Feedback · stays.example.com');
    expect(dockedEyebrow('a.b')).toBe('Feedback · a.b');
    expect(q('.fw-pn-headline')!.textContent).toBe(DOCKED_HEADLINE);
    expect(DOCKED_HEADLINE).toBe("What's going on?");
  });

  it('hostname defaults to location.hostname', () => {
    mount({ state: dockedOpen() });
    expect(q('.fw-pn-eyebrow')!.textContent).toBe(`Feedback · ${location.hostname}`);
  });

  it('no ← Marks in docked, even in error', () => {
    mount({ state: reduce(dockedSending(), { type: 'sendFail' }) });
    expect(q('[data-part="back"]')).toBeNull();
  });

  it('annotate flow has no swap button', () => {
    mount({ state: review() });
    expect(q('[data-part="swap"]')).toBeNull();
  });
});

describe('flow docked — swap side', () => {
  it('30×30 button titled "Move panel to the other side", ⇄ icon 17, hover #e3dcc8', () => {
    mount({ state: dockedOpen() });
    const b = q<HTMLButtonElement>('[data-part="swap"]')!;
    expect(b.title).toBe(SWAP_TITLE);
    expect(SWAP_TITLE).toBe('Move panel to the other side');
    const css = panelCss();
    expect(css).toMatch(/\.fw-pn-swap\{[^}]*width:30px;height:30px;[^}]*color:#5d5648/);
    expect(css).toContain('.fw-pn-swap:hover{background:#e3dcc8}');
    expect(css).toMatch(/\.fw-pn-swap svg\{width:17px;height:17px/);
  });

  it('moves the panel to the other side and back, resetting the toolbar position each time', () => {
    const onSwap = vi.fn();
    const p = live(dockedRun(OPEN, { type: 'moveToolbar', pos: { x: 40, y: 12 } }), { onSwap });
    expect(p.state.toolbarPos).toEqual({ x: 40, y: 12 });
    act(() => q<HTMLButtonElement>('[data-part="swap"]')!.click());
    expect(q('.fw-panel')!.className).toContain('fw-panel--left');
    expect(onSwap).toHaveBeenLastCalledWith('left');
    expect(p.events).toContainEqual({ type: 'moveToolbar', pos: null });
    expect(p.state.toolbarPos).toBeNull();
    act(() => q<HTMLButtonElement>('[data-part="swap"]')!.click());
    expect(q('.fw-panel')!.className).not.toContain('fw-panel--left');
    expect(onSwap).toHaveBeenLastCalledWith('right');
  });

  it('is hidden while sending and back on error', () => {
    mount({ state: dockedSending() });
    expect(q('[data-part="swap"]')).toBeNull();
    mount({ state: reduce(dockedSending(), { type: 'sendFail' }) });
    expect(q('[data-part="swap"]')).not.toBeNull();
  });
});

describe('flow docked — free area (§5.3)', () => {
  it('excludes the 412 px panel column on the panel side', () => {
    expect(PANEL_COLUMN).toBe(412);
    expect(freeArea(1280, 'docked', 'right')).toEqual({ x0: 0, x1: 868 });
    expect(freeArea(1280, 'docked', 'left')).toEqual({ x0: 412, x1: 1280 });
    expect(freeArea(1280, 'annotate', 'left')).toEqual({ x0: 0, x1: 1280 });
  });

  /** App's wiring in miniature: one panel side shared by Panel, Toolbar and the hint chip. */
  function Docked({ start }: { start: State }) {
    const [s, setS] = useState(start);
    const [side, setSide] = useState<PanelSide>('right');
    const dispatch = (e: Event) => setS((cur) => reduce(cur, e));
    return (
      <>
        <CaptureChrome state={s} dispatch={dispatch} capture={null} panelSide={side} />
        <Toolbar
          visible={toolbarVisible(s)}
          tool={s.tool}
          color={DEFAULT_MARK_COLOR}
          offset={s.toolbarPos}
          flow={s.config.flow}
          panelSide={side}
          viewportWidth={window.innerWidth}
          viewportHeight={window.innerHeight}
          onTool={() => {}}
          onColor={() => {}}
          onUndo={() => {}}
          onDescribe={() => {}}
          onClose={() => {}}
          onMove={(pos) => dispatch({ type: 'moveToolbar', pos })}
        />
        <Panel state={s} dispatch={dispatch} side={side} onSwap={setSide} hostname="h" />
      </>
    );
  }

  it('toolbar and hint centre on the free area, and follow a swap', () => {
    const W = window.innerWidth;
    act(() => render(<Docked start={dockedRun(OPEN, { type: 'moveToolbar', pos: { x: 30, y: 5 } })} />, shadow as unknown as Element));
    const tb = () => q<HTMLDivElement>('.fw-tb')!;
    const hint = () => q<HTMLDivElement>('.fw-hint')!;
    // Dragged toolbar: offset applied on top of the free-area centre.
    expect(tb().style.left).toBe(`${(W - PANEL_COLUMN) / 2 + 30}px`);
    expect(hint().style.left).toBe(`${(W - PANEL_COLUMN) / 2}px`);
    act(() => q<HTMLButtonElement>('[data-part="swap"]')!.click());
    // Swapped left: free area [412, W]; toolbar back at rest.
    expect(tb().style.left).toBe(`${(PANEL_COLUMN + W) / 2}px`);
    expect(tb().style.top).toBe('16px');
    expect(hint().style.left).toBe(`${(PANEL_COLUMN + W) / 2}px`);
  });
});

// ── Flow note (§5.6 "note — anchored note", "Compact summary"; §4 focus; §5.2 hint; §5.5) ──

describe('flow note — geometry', () => {
  const W = 1280;
  const H = 800;
  const box = (x: number, y: number, w = 40, h = 40) => ({ x, y, w, h });

  it('sits right of the anchor (anchor.right + 18) when it fits', () => {
    const g = noteGeometry(box(100, 100), W, H);
    expect(g.left).toBe(158);
    expect(g.side).toBe('right');
  });

  it('flips to anchor.left − 358 near the right edge', () => {
    const g = noteGeometry(box(1000, 100), W, H);
    expect(g.left).toBe(1000 - 358);
    expect(g.side).toBe('left');
  });

  it('clamps to [16, W − 356] at both edges', () => {
    // Flipped and still off the left edge (narrow viewport).
    expect(noteGeometry(box(200, 100), 500, H).left).toBe(16);
    // Right of anchor fits by the overflow test but is clamped to W − 356.
    expect(noteGeometry(box(0, 100, 0, 0), 400, H).left).toBeLessThanOrEqual(400 - 356);
    expect(noteGeometry(box(0, 100, 0, 0), 400, H).left).toBeGreaterThanOrEqual(16);
    // Anchor at the very left: right side, untouched.
    expect(noteGeometry(box(0, 100, 10, 10), W, H).left).toBe(28);
    // Anchor at the very right edge: flipped, within the clamp.
    const g = noteGeometry(box(W - 10, 100, 10, 10), W, H);
    expect(g.left).toBe(W - 10 - 358);
    expect(g.left).toBeLessThanOrEqual(W - 356);
  });

  it('top-half anchor → top = max(16, cy − 170), no bottom', () => {
    expect(noteGeometry(box(100, 280), W, H)).toMatchObject({ top: 300 - 170, bottom: null });
    // Near the top edge: clamped to 16.
    expect(noteGeometry(box(100, 0, 20, 20), W, H)).toMatchObject({ top: 16, bottom: null });
    // Exactly at H/2 stays top-anchored.
    expect(noteGeometry(box(100, H / 2 - 20), W, H)).toMatchObject({ top: H / 2 - 170, bottom: null });
  });

  it('bottom-half anchor → bottom = max(16, H − cy − 170), grows upward', () => {
    expect(noteGeometry(box(100, 480), W, H)).toMatchObject({ top: null, bottom: H - 500 - 170 });
    // Near the bottom edge: clamped to 16.
    expect(noteGeometry(box(100, H - 20, 20, 20), W, H)).toMatchObject({ top: null, bottom: 16 });
  });

  it('max-height is H − 32; no anchor → centred 40 px box', () => {
    expect(noteGeometry(box(100, 100), W, H).maxHeight).toBe(H - 32);
    expect(noteGeometry(null, W, H)).toMatchObject({ left: W / 2 + 20 + 18, top: H / 2 - 170 });
  });

  it('anchors on the pin head, element rect and drawn extent', () => {
    expect(noteAnchorBox({ id: 'a', kind: 'pin', x: 50, y: 100, color: DEFAULT_MARK_COLOR })).toEqual({ x: 50, y: 72, w: 28, h: 28 });
    expect(noteAnchorBox({ id: 'b', kind: 'element', x: 1, y: 2, w: 3, h: 4, selector: 'a', color: DEFAULT_MARK_COLOR })).toEqual({ x: 1, y: 2, w: 3, h: 4 });
    expect(noteAnchorBox({ id: 'c', kind: 'draw', points: [{ x: 5, y: 9 }, { x: 15, y: 3 }], color: DEFAULT_MARK_COLOR })).toEqual({ x: 5, y: 3, w: 10, h: 6 });
    expect(noteAnchorBox({ id: 'd', kind: 'arrow', x1: 30, y1: 10, x2: 10, y2: 40, color: DEFAULT_MARK_COLOR })).toEqual({ x: 10, y: 10, w: 20, h: 30 });
  });

  it('CSS: width 340, max-height H−32, enters from translateY(8px) scale(.97); reduced motion drops it', () => {
    const css = panelCss();
    expect(NOTE_WIDTH).toBe(340);
    expect(css).toMatch(/\.fw-panel--note\{[^}]*width:340px;max-height:calc\(100vh - 32px\)/);
    expect(css).toContain('.fw-panel--note.fw-panel--hidden{transform:translateY(8px) scale(.97)}');
    expect(css).toMatch(/@media \(prefers-reduced-motion:reduce\)\{.*\.fw-panel--note\.fw-panel--hidden.*transform:none/s);
  });
});

const PIN: Mark = { id: 'p1', kind: 'pin', x: 100, y: 128, color: DEFAULT_MARK_COLOR };
const ELEMENT: Mark = { id: 'e1', kind: 'element', x: 900, y: 600, w: 80, h: 40, selector: 'button.book', color: DEFAULT_MARK_COLOR };
const ARROW: Mark = { id: 'a1', kind: 'arrow', x1: 10, y1: 10, x2: 60, y2: 60, color: DEFAULT_MARK_COLOR };

const noteRun = (...events: Event[]) => events.reduce(reduce, initialState({ flow: 'note' }));

describe('flow note — panel', () => {
  const VIEW = { width: 1280, height: 800 };

  it('is hidden before any mark and shown once one exists', () => {
    expect(mount({ state: noteRun(OPEN), viewport: VIEW }).className).toContain('fw-panel--hidden');
    const el = mount({ state: noteRun(OPEN, { type: 'addMark', id: 'p1' }), marks: number([PIN]), viewport: VIEW });
    expect(el.className).toContain('fw-panel--note');
    expect(el.className).not.toContain('fw-panel--hidden');
  });

  it('positions beside the first mark through the CSSOM (top half → top; bottom half → bottom)', () => {
    let el = mount({ state: noteRun(OPEN, { type: 'addMark', id: 'p1' }), marks: number([PIN]), viewport: VIEW });
    // Pin head 100,100 28×28 → left 146, cy 114 → top 16.
    expect(el.style.left).toBe('146px');
    expect(el.style.top).toBe('16px');
    expect(el.style.bottom).toBe('auto');
    expect(el.style.maxHeight).toBe('768px');
    expect(el.dataset.side).toBe('right');
    el = mount({ state: noteRun(OPEN, { type: 'addMark', id: 'e1' }), marks: number([ELEMENT]), viewport: VIEW });
    // Element right 980 + 18 + 340 > 1264 → flip to 900 − 358 = 542; cy 620 → bottom 800 − 620 − 170 = 16 (max).
    expect(el.style.left).toBe('542px');
    expect(el.style.top).toBe('auto');
    expect(el.style.bottom).toBe('16px');
    expect(el.dataset.side).toBe('left');
    expect(el.getAttribute('style') ?? '').not.toMatch(/url|expression/);
  });

  it('eyebrow: "Note on mark 1 · {selector}", "Note on mark 1" for a pin, "Your note" if unnumbered; no headline', () => {
    expect(noteEyebrow(number([ELEMENT])[0])).toBe('Note on mark 1 · button.book');
    expect(noteEyebrow(number([PIN])[0])).toBe('Note on mark 1');
    expect(noteEyebrow(ARROW)).toBe('Your note');
    expect(noteEyebrow(undefined)).toBe('Your note');
    mount({ state: noteRun(OPEN, { type: 'addMark', id: 'e1' }), marks: number([ELEMENT]), viewport: VIEW });
    expect(q('[data-part="eyebrow"]')!.textContent).toBe('Note on mark 1 · button.book');
    expect(q('[data-part="headline"]')).toBeNull();
  });

  it('details textarea has 3 rows (4 in the other flows)', () => {
    expect(NOTE_DETAILS_ROWS).toBe(3);
    mount({ state: noteRun(OPEN, { type: 'addMark', id: 'p1' }), marks: number([PIN]), viewport: VIEW });
    expect(details().rows).toBe(3);
    mount({ state: review() });
    expect(details().rows).toBe(4);
  });

  it('focuses Title 380 ms after the first mark', () => {
    vi.useFakeTimers();
    let s = noteRun(OPEN);
    mount({ state: s, viewport: VIEW });
    s = reduce(s, { type: 'addMark', id: 'p1' });
    mount({ state: s, marks: number([PIN]), viewport: VIEW });
    expect(NOTE_FOCUS_TITLE_DELAY_MS).toBe(380);
    act(() => { vi.advanceTimersByTime(379); });
    expect(shadow.activeElement).not.toBe(title());
    act(() => { vi.advanceTimersByTime(1); });
    expect(shadow.activeElement).toBe(title());
  });

  it('a second mark does not re-focus Title', () => {
    vi.useFakeTimers();
    let s = noteRun(OPEN, { type: 'addMark', id: 'p1' });
    mount({ state: s, marks: number([PIN]), viewport: VIEW });
    s = reduce(s, { type: 'addMark', id: 'e1' });
    mount({ state: s, marks: number([PIN, ELEMENT]), viewport: VIEW });
    act(() => { vi.advanceTimersByTime(1000); });
    expect(shadow.activeElement).not.toBe(title());
  });

  it('flow annotate keeps the corner card (no inline geometry)', () => {
    const el = mount({ state: review(), marks: number([PIN]), viewport: VIEW });
    expect(el.className).not.toContain('fw-panel--note');
    expect(el.style.left).toBe('');
  });
});

describe('flow note — compact summary', () => {
  const con: ConsoleEntry[] = [
    { level: 'error', message: 'a', source: 'x.js:1:1', count: 1 } as ConsoleEntry,
    { level: 'error', message: 'b', source: 'x.js:2:1', count: 1 } as ConsoleEntry,
  ];
  const net: NetworkEntry[] = [{ method: 'POST', url: '/api', status: 502, durationMs: 300 } as NetworkEntry];

  function ctx(over: Partial<PanelContextProps> = {}) {
    const onSwitch = vi.fn();
    const props: PanelContextProps = {
      marks: number([PIN, ELEMENT, ARROW]),
      onNote: () => {},
      onRemove: () => {},
      screenshot: { width: 1280, height: 800 },
      pageUrl: 'https://x.test/',
      console: con,
      network: net,
      switches: { console: true, network: true },
      onSwitch,
      compact: true,
      ...over,
    };
    act(() => render(<PanelContext {...props} />, shadow as unknown as Element));
    return onSwitch;
  }

  it('summary line copy', () => {
    expect(summaryLine(3, { count: 2, on: true }, { count: 1, on: true })).toBe(
      'Screenshot + 3 marks · 2 console errors · 1 failed request',
    );
    expect(summaryLine(1, { count: 2, on: false }, { count: 0, on: false })).toBe('Screenshot + 1 mark · no console · no network');
  });

  it('replaces the Marks / Attached sections with one row + Review', () => {
    ctx();
    expect(q('[data-section="marks"]')).toBeNull();
    expect(q('[data-section="attached"]')).toBeNull();
    expect(q('[data-part="summary-line"]')!.textContent).toBe('Screenshot + 3 marks · 2 console errors · 1 failed request');
    expect(q('[data-part="summary-label"]')!.textContent).toBe(SUMMARY_REVIEW);
    expect(q('[data-part="summary-body"]')).toBeNull();
  });

  it('Review expands to the console and network switch rows; Hide collapses', () => {
    const onSwitch = ctx();
    const toggle = q<HTMLButtonElement>('[data-part="summary-toggle"]')!;
    act(() => toggle.click());
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(q('[data-part="summary-label"]')!.textContent).toBe(SUMMARY_HIDE);
    const body = q('[data-part="summary-body"]')!;
    expect(body.querySelector('[data-row="console"] [data-part="value"]')!.textContent).toBe('2 console errors');
    expect(body.querySelector('[data-row="network"] [data-part="value"]')!.textContent).toBe('1 failed request');
    const sw = body.querySelector<HTMLButtonElement>('[data-switch="console"]')!;
    expect(sw.getAttribute('role')).toBe('switch');
    expect(sw.getAttribute('aria-checked')).toBe('true');
    act(() => sw.click());
    expect(onSwitch).toHaveBeenCalledWith('console', false);
    act(() => toggle.click());
    expect(q('[data-part="summary-body"]')).toBeNull();
  });

  it('off switches show the not-sent copy in the rows and "no console" in the summary', () => {
    ctx({ switches: { console: false, network: true } });
    act(() => q<HTMLButtonElement>('[data-part="summary-toggle"]')!.click());
    expect(q('[data-part="summary-line"]')!.textContent).toBe('Screenshot + 3 marks · no console · 1 failed request');
    expect(q('[data-row="console"] [data-part="value"]')!.textContent).toBe('Console errors — not sent');
    expect(q('[data-row="console"]')!.className).toContain('fw-pc-srow--off');
  });

  it('full sections stay for the other flows', () => {
    ctx({ compact: false });
    expect(q('[data-section="marks"]')).not.toBeNull();
    expect(q('[data-part="summary"]')).toBeNull();
  });
});

describe('flow note — first-mark rules', () => {
  it('the hint before any mark reads the mark-first copy', () => {
    const s = noteRun(OPEN);
    expect(hintText(s)).toBe('Mark the spot first — your note opens beside it');
    expect(NOTE_FIRST_HINT).toBe('Mark the spot first — your note opens beside it');
    act(() =>
      render(
        <CaptureChrome state={s} dispatch={() => {}} capture={null} />,
        shadow as unknown as Element,
      ),
    );
    expect(q('.fw-hint-text')!.textContent).toBe(NOTE_FIRST_HINT);
    // Once a mark exists the tool hint returns.
    expect(hintText(reduce(s, { type: 'addMark', id: 'p1' }))).not.toBe(NOTE_FIRST_HINT);
  });

  it('the first mark in flow note opens no popover; later marks and other flows do', () => {
    expect(markOpensPopover('note', 0)).toBe(false);
    expect(markOpensPopover('note', 1)).toBe(true);
    expect(markOpensPopover('annotate', 0)).toBe(true);
    expect(markOpensPopover('docked', 0)).toBe(true);
  });

  it('MarksLayer with that rule: a first pin creates the mark without opening the popover', () => {
    const onChange = vi.fn();
    const created: Mark[] = [];
    const container = document.createElement('div');
    document.body.appendChild(container);
    act(() =>
      render(
        <MarksLayer
          marks={created}
          tool="pin"
          color={DEFAULT_MARK_COLOR}
          onCreate={(m) => created.push(m)}
          onOpen={() => {}}
          onTextEdit={() => {}}
          onDrawing={() => {}}
          newId={() => 'n1'}
          popover={{ onChange, onComment: () => {}, onDelete: () => {}, skipOpenOnCreate: !markOpensPopover('note', 0), W: 1280, H: 800 }}
        />,
        container,
      ),
    );
    const hit = container.querySelector('[data-part="marks-hit"]')!;
    act(() => {
      hit.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, clientX: 40, clientY: 40, pointerId: 1, button: 0 }));
      hit.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, clientX: 40, clientY: 40, pointerId: 1, button: 0 }));
    });
    expect(created.map((m) => m.kind)).toEqual(['pin']);
    expect(onChange).not.toHaveBeenCalled();
    act(() => render(null, container));
    container.remove();
  });
});
