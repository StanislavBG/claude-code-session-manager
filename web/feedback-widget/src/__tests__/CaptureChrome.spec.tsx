// CaptureChrome — handoff README §5.2 (flash, frame, hint chip) + §1 "Screenshot capture"
// (frozen full-viewport backdrop, page interaction blocked) + §7 (resize keeps the capture).
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CaptureResult } from '../capture';
import {
  CaptureChrome,
  type CaptureChromeProps,
  FLASH_MS,
  HINT_COPY,
  NOTE_FIRST_HINT,
  POPOVER_ATTR,
  captureChromeCss,
} from '../ui/CaptureChrome';
import { freeArea } from '../ui/shared';
import { type Event, type State, initialState, reduce } from '../ui/machine';

let container: HTMLElement;
let mql: { matches: boolean };

function capture(over: Partial<CaptureResult> = {}): CaptureResult {
  return { png: new Blob(['x'], { type: 'image/png' }), width: 2048, height: 1536, scale: 2, ...over };
}

function state(events: Event[], config: Parameters<typeof initialState>[0] = {}): State {
  return events.reduce(reduce, initialState(config));
}

const opened = () => state([{ type: 'open' }]);

function mount(props: Partial<CaptureChromeProps> & { state: State }) {
  const dispatch = props.dispatch ?? vi.fn();
  const full: CaptureChromeProps = { capture: capture(), ...props, dispatch };
  act(() => {
    render(<CaptureChrome {...full} />, container);
  });
  return { dispatch, rerender: (p: Partial<CaptureChromeProps>) => act(() => render(<CaptureChrome {...full} {...p} />, container)) };
}

const q = (sel: string) => container.querySelector<HTMLElement>(sel);

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  mql = { matches: false };
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query.includes('reduced-motion') ? mql.matches : false,
    media: query,
    addEventListener() {},
    removeEventListener() {},
  }));
  let n = 0;
  URL.createObjectURL = vi.fn(() => `blob:test/${++n}`);
  URL.revokeObjectURL = vi.fn();
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1024 });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: 768 });
});

afterEach(() => {
  act(() => render(null, container));
  container.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('backdrop', () => {
  it('shows the screenshot full-viewport, anchored top-left, at captured CSS size', () => {
    mount({ state: opened() });
    const img = q('.fw-backdrop') as HTMLImageElement;
    expect(img).toBeTruthy();
    expect(img.tagName).toBe('IMG');
    expect(img.getAttribute('src')).toBe('blob:test/1');
    expect(img.style.width).toBe('1024px');
    expect(img.style.height).toBe('768px');
    const css = captureChromeCss();
    expect(css).toMatch(/\.fw-backdrop\{[^}]*position:absolute;[^}]*top:0;[^}]*left:0/);
    expect(css).toMatch(/\.fw-backdrop\{[^}]*max-width:none/);
  });

  it('keeps its captured size on resize (never re-captures)', () => {
    mount({ state: opened() });
    act(() => {
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: 600 });
      Object.defineProperty(window, 'innerHeight', { configurable: true, value: 400 });
      window.dispatchEvent(new window.Event('resize'));
    });
    const img = q('.fw-backdrop')!;
    expect(img.style.width).toBe('1024px');
    expect(img.style.height).toBe('768px');
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
  });

  it('renders nothing while idle and revokes the object URL on close', () => {
    const { rerender } = mount({ state: opened() });
    rerender({ state: initialState() });
    expect(container.innerHTML).toBe('');
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:test/1');
  });
});

describe('flash', () => {
  it('animates white .9 -> 0 over 500 ms ease-out, then unmounts', () => {
    vi.useFakeTimers();
    mount({ state: opened() });
    const flash = q('.fw-flash')!;
    expect(flash).toBeTruthy();
    expect(flash.classList.contains('fw-flash--reduced')).toBe(false);
    const css = captureChromeCss();
    expect(css).toContain('@keyframes fw-flash{from{opacity:.9}to{opacity:0}}');
    expect(css).toMatch(/\.fw-flash\{[^}]*background:#ffffff;[^}]*pointer-events:none;[^}]*animation:fw-flash 500ms ease-out forwards/);
    expect(FLASH_MS).toBe(500);
    act(() => {
      vi.advanceTimersByTime(FLASH_MS);
    });
    expect(q('.fw-flash')).toBeNull();
  });

  it('starts at .3 with prefers-reduced-motion', () => {
    mql.matches = true;
    mount({ state: opened() });
    expect(q('.fw-flash')!.classList.contains('fw-flash--reduced')).toBe(true);
    expect(captureChromeCss()).toContain('@keyframes fw-flash-reduced{from{opacity:.3}to{opacity:0}}');
    expect(captureChromeCss()).toMatch(/\.fw-flash--reduced\{animation-name:fw-flash-reduced\}/);
  });

  it('flashes again for a new capture (next open)', () => {
    vi.useFakeTimers();
    const { rerender } = mount({ state: opened() });
    act(() => {
      vi.advanceTimersByTime(FLASH_MS);
    });
    expect(q('.fw-flash')).toBeNull();
    rerender({ capture: capture() });
    expect(q('.fw-flash')).toBeTruthy();
  });
});

describe('frame', () => {
  it('is a full-viewport inset 3px #a83818 box-shadow with pointer-events none', () => {
    mount({ state: opened() });
    expect(q('.fw-frame')).toBeTruthy();
    expect(captureChromeCss()).toMatch(/\.fw-frame\{[^}]*inset:0;[^}]*pointer-events:none;[^}]*box-shadow:inset 0 0 0 3px #a83818/);
  });

  it.each<[string, Event[], Parameters<typeof initialState>[0], boolean]>([
    ['annotate', [{ type: 'open' }], {}, true],
    ['review', [{ type: 'open' }, { type: 'describe' }], {}, true],
    ['sending', [{ type: 'open' }, { type: 'describe' }, { type: 'draft', title: 'abc' }, { type: 'send' }], {}, true],
    ['error', [{ type: 'open' }, { type: 'describe' }, { type: 'draft', title: 'abc' }, { type: 'send' }, { type: 'sendFail' }], {}, true],
    ['sent', [{ type: 'open' }, { type: 'describe' }, { type: 'draft', title: 'abc' }, { type: 'send' }, { type: 'sendOk' }], {}, false],
    ['folding', [{ type: 'open' }, { type: 'describe' }, { type: 'draft', title: 'abc' }, { type: 'send' }, { type: 'sendOk' }], { success: 'fold' }, false],
  ])('in %s → visible=%s', (_name, events, config, visible) => {
    mount({ state: state(events, config) });
    expect(!!q('.fw-frame')).toBe(visible);
  });
});

describe('capture surface', () => {
  it('swallows pointer events so the page never sees them', () => {
    const pageSpy = vi.fn();
    document.addEventListener('pointerdown', pageSpy);
    document.addEventListener('click', pageSpy);
    mount({ state: opened() });
    const surface = q('.fw-surface')!;
    expect(captureChromeCss()).toMatch(/\.fw-surface\{[^}]*position:fixed;[^}]*inset:0;[^}]*pointer-events:auto/);
    surface.dispatchEvent(new window.MouseEvent('pointerdown', { bubbles: true, cancelable: true }));
    surface.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(pageSpy).not.toHaveBeenCalled();
    document.removeEventListener('pointerdown', pageSpy);
    document.removeEventListener('click', pageSpy);
  });

  it('calls preventDefault on wheel and touchmove', () => {
    mount({ state: opened() });
    const surface = q('.fw-surface')!;
    const wheel = new window.Event('wheel', { bubbles: true, cancelable: true });
    const touch = new window.Event('touchmove', { bubbles: true, cancelable: true });
    surface.dispatchEvent(wheel);
    surface.dispatchEvent(touch);
    expect(wheel.defaultPrevented).toBe(true);
    expect(touch.defaultPrevented).toBe(true);
  });

  it('lets clicks reach children (the marks layer) when no popover is open', () => {
    const child = vi.fn();
    act(() =>
      render(
        <CaptureChrome state={opened()} dispatch={vi.fn()} capture={capture()}>
          <div class="marks" onClick={child} />
        </CaptureChrome>,
        container,
      ),
    );
    q('.marks')!.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(child).toHaveBeenCalledTimes(1);
  });

  it('with a popover open, a click only closes the popover', () => {
    const child = vi.fn();
    const dispatch = vi.fn();
    const s = state([{ type: 'open' }, { type: 'addMark', id: 'm1' }, { type: 'popover', id: 'm1' }]);
    act(() =>
      render(
        <CaptureChrome state={s} dispatch={dispatch} capture={capture()}>
          <div class="marks" onPointerDown={child} onClick={child} />
          <div {...{ [POPOVER_ATTR]: '' }}>
            <button class="in-popover" onClick={child} />
          </div>
        </CaptureChrome>,
        container,
      ),
    );
    const marks = q('.marks')!;
    marks.dispatchEvent(new window.MouseEvent('pointerdown', { bubbles: true, cancelable: true }));
    marks.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(child).not.toHaveBeenCalled();
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith({ type: 'popover', id: null });

    // Clicks inside the popover itself still work.
    q('.in-popover')!.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(child).toHaveBeenCalledTimes(1);
  });
});

describe('a popover opened by the current gesture', () => {
  it('survives the same gesture\'s pointerup, mouseup and click', () => {
    const child = vi.fn();
    const dispatch = vi.fn();
    const closed = state([{ type: 'open' }, { type: 'addMark', id: 'm1' }]);
    const opened = state([{ type: 'open' }, { type: 'addMark', id: 'm1' }, { type: 'popover', id: 'm1' }]);
    const tree = (st: ReturnType<typeof state>) => (
      <CaptureChrome state={st} dispatch={dispatch} capture={capture()}>
        <div class="marks" onClick={child} />
      </CaptureChrome>
    );
    act(() => render(tree(closed), container));
    const marks = q('.marks')!;
    const fire = (type: string) => marks.dispatchEvent(new window.MouseEvent(type, { bubbles: true, cancelable: true }));
    fire('pointerdown');
    act(() => render(tree(opened), container)); // pointerdown opened the popover
    fire('pointerup');
    fire('mouseup');
    fire('click');
    expect(dispatch).not.toHaveBeenCalled();
    expect(child).toHaveBeenCalledTimes(1);
    // The next gesture, with the popover still open, only closes it.
    fire('pointerdown');
    fire('click');
    expect(dispatch).toHaveBeenCalledWith({ type: 'popover', id: null });
    expect(child).toHaveBeenCalledTimes(1);
  });
});

describe('hint chip', () => {
  it('matches §5.2: dot, SCREENSHOT label, tool hint, Esc chip', () => {
    mount({ state: opened() });
    const hint = q('.fw-hint')!;
    expect(hint.children).toHaveLength(3);
    const label = hint.querySelector('.fw-hint-label')!;
    expect(label.querySelector('.fw-hint-dot')).toBeTruthy();
    expect(label.textContent).toBe('Screenshot');
    expect(hint.querySelector('.fw-hint-text')!.textContent).toBe('Click anywhere to drop a numbered pin');
    expect(hint.querySelector('.fw-hint-esc')!.textContent).toBe('Esc');
    const css = captureChromeCss();
    expect(css).toMatch(/\.fw-hint\{[^}]*border-radius:999px;[^}]*background:#1a1612;[^}]*padding:7px 8px 7px 12px;[^}]*gap:10px;[^}]*box-shadow:0 10px 24px -10px rgba\(26,22,18,\.6\);[^}]*pointer-events:none;[^}]*transform:translateX\(-50%\)/);
    expect(css).toMatch(/\.fw-hint-dot\{[^}]*width:7px;[^}]*height:7px;[^}]*background:#a83818;[^}]*box-shadow:0 0 0 2px rgba\(244,185,66,\.55\)/);
    expect(css).toMatch(/\.fw-hint-label\{[^}]*font:500 10\.5px[^}]*letter-spacing:\.08em;[^}]*text-transform:uppercase;[^}]*color:#f4b942/);
    expect(css).toMatch(/\.fw-hint-text\{[^}]*font:500 12\.5px[^}]*color:#f5f0e6/);
    expect(css).toMatch(/\.fw-hint-esc\{[^}]*font:500 10\.5px[^}]*padding:2px 6px;[^}]*border-radius:5px;[^}]*background:rgba\(245,240,230,\.12\);[^}]*color:#c9bfa9/);
  });

  it.each([
    ['pin', 'Click anywhere to drop a numbered pin'],
    ['element', 'Hover an element, click to select it'],
    ['box', 'Drag to box an area'],
    ['arrow', 'Drag to point at something'],
    ['draw', 'Draw freely'],
    ['text', 'Click to place a text label'],
  ] as const)('tool %s → "%s"', (tool, copy) => {
    expect(HINT_COPY[tool]).toBe(copy);
    mount({ state: state([{ type: 'open' }, { type: 'setTool', tool }]) });
    expect(q('.fw-hint-text')!.textContent).toBe(copy);
  });

  it('flow note with no marks shows the mark-first copy', () => {
    mount({ state: state([{ type: 'open' }], { flow: 'note' }) });
    expect(q('.fw-hint-text')!.textContent).toBe(NOTE_FIRST_HINT);
    expect(NOTE_FIRST_HINT).toBe('Mark the spot first — your note opens beside it');
  });

  it('is centred on the free area at top 80 for the dock toolbar', () => {
    mount({ state: opened() });
    const hint = q('.fw-hint')!;
    expect(hint.style.left).toBe('512px');
    expect(hint.style.top).toBe('80px');
  });

  it('excludes the docked panel column from the free area', () => {
    expect(freeArea(1024, 'docked', 'right')).toEqual({ x0: 0, x1: 612 });
    expect(freeArea(1024, 'docked', 'left')).toEqual({ x0: 412, x1: 1024 });
    expect(freeArea(1024, 'annotate', 'right')).toEqual({ x0: 0, x1: 1024 });
    mount({ state: state([{ type: 'open' }], { flow: 'docked' }), panelSide: 'left' });
    expect(q('.fw-hint')!.style.left).toBe('718px');
  });

  it('uses top 16 for rail/corner toolbars and recentres on resize', () => {
    mount({ state: opened(), toolbar: 'dock' });
    expect(q('.fw-hint')!.style.top).toBe('80px');
    mount({ state: opened(), toolbar: 'corner' });
    expect(q('.fw-hint')!.style.top).toBe('16px');
    mount({ state: opened(), toolbar: 'rail' });
    expect(q('.fw-hint')!.style.top).toBe('16px');
    act(() => {
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: 800 });
      window.dispatchEvent(new window.Event('resize'));
    });
    expect(q('.fw-hint')!.style.left).toBe('400px');
  });

  it('is visible only in annotate', () => {
    mount({ state: state([{ type: 'open' }, { type: 'describe' }]) });
    expect(q('.fw-hint')).toBeNull();
    mount({ state: state([{ type: 'open' }, { type: 'describe' }, { type: 'draft', title: 'abc' }, { type: 'send' }]) });
    expect(q('.fw-hint')).toBeNull();
  });

  it('is hidden while the discard dialog is open', () => {
    const s = state([{ type: 'open' }, { type: 'addMark', id: 'm1' }, { type: 'closeRequest' }]);
    expect(s.confirm).toBe(true);
    mount({ state: s });
    expect(q('.fw-hint')).toBeNull();
    expect(q('.fw-frame')).toBeTruthy();
  });
});

describe('styles', () => {
  it('adopts its constructed sheet into the shadow root (no style elements)', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = host.attachShadow({ mode: 'open' });
    let adopted: CSSStyleSheet[] = [];
    Object.defineProperty(root, 'adoptedStyleSheets', {
      configurable: true,
      get: () => adopted,
      set: (v: CSSStyleSheet[]) => (adopted = v),
    });
    const mountPoint = document.createElement('div');
    root.appendChild(mountPoint);
    act(() => render(<CaptureChrome state={opened()} dispatch={vi.fn()} capture={capture()} />, mountPoint));
    expect(adopted).toHaveLength(1);
    expect(root.querySelector('style')).toBeNull();
    act(() => render(null, mountPoint));
    host.remove();
  });
});
