import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initialState, reduce, type Event, type State } from '../ui/machine';
import {
  FLASH_OPACITY,
  FLASH_OPACITY_REDUCED,
  FOCUS_DELAYS,
  REDUCED_FADE_MAX_MS,
  createFocusController,
  installKeys,
  isMacPlatform,
  isTypingElement,
  keyAction,
  reducedMotion,
  reducedMotionCss,
  sendShortcutLabel,
  tabbables,
  type KeyInput,
} from '../ui/keys';

// ── helpers ─────────────────────────────────────────────────────────────────

function run(s: State, ...events: Event[]): State {
  return events.reduce(reduce, s);
}
const idle = (flow: 'annotate' | 'docked' | 'note' = 'annotate') => initialState({ flow });
const annotate = (flow: 'annotate' | 'docked' | 'note' = 'annotate') => run(idle(flow), { type: 'open' });
const review = () => run(annotate(), { type: 'describe' });

function k(key: string, mods: Partial<KeyInput> = {}): KeyInput {
  return { key, shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, ...mods };
}

// ── Shift+F ─────────────────────────────────────────────────────────────────

describe('Shift+F', () => {
  it('opens in idle', () => {
    expect(keyAction(idle(), k('F', { shiftKey: true }), { typing: false })).toEqual({ type: 'open' });
    expect(keyAction(idle(), k('f', { shiftKey: true }), { typing: false })).toEqual({ type: 'open' });
  });
  it('needs Shift', () => {
    expect(keyAction(idle(), k('f'), { typing: false })).toBeNull();
  });
  it('never while typing in the host page', () => {
    expect(keyAction(idle(), k('F', { shiftKey: true }), { typing: true })).toBeNull();
  });
  it.each(['ctrlKey', 'metaKey', 'altKey'] as const)('never with %s', (mod) => {
    expect(keyAction(idle(), k('F', { shiftKey: true, [mod]: true }), { typing: false })).toBeNull();
  });
  it('only in idle', () => {
    expect(keyAction(annotate(), k('F', { shiftKey: true }), { typing: false })).toBeNull();
    expect(keyAction(review(), k('F', { shiftKey: true }), { typing: false })).toBeNull();
  });
});

describe('isTypingElement', () => {
  it.each(['input', 'textarea', 'select'])('%s is typing', (tag) => {
    expect(isTypingElement(document.createElement(tag))).toBe(true);
  });
  it('contenteditable (and its descendants) is typing', () => {
    const div = document.createElement('div');
    div.setAttribute('contenteditable', 'true');
    const span = document.createElement('span');
    div.appendChild(span);
    document.body.appendChild(div);
    expect(isTypingElement(div)).toBe(true);
    expect(isTypingElement(span)).toBe(true);
    div.setAttribute('contenteditable', 'false');
    expect(isTypingElement(span)).toBe(false);
    div.remove();
  });
  it('buttons, divs and null are not', () => {
    expect(isTypingElement(document.createElement('button'))).toBe(false);
    expect(isTypingElement(document.createElement('div'))).toBe(false);
    expect(isTypingElement(null)).toBe(false);
  });
});

// ── Esc order ───────────────────────────────────────────────────────────────

describe('Esc', () => {
  it('maps to the machine esc event whenever the widget is open', () => {
    expect(keyAction(annotate(), k('Escape'), { typing: true })).toEqual({ type: 'esc' });
    expect(keyAction(idle(), k('Escape'), { typing: false })).toBeNull();
  });

  it('closes the first that applies: discard dialog → text input → popover → review → close request', () => {
    let s = run(annotate(), { type: 'addMark', id: 'm1' }, { type: 'describe' }, { type: 'closeRequest' });
    // Arrange every layer at once: review + confirm + textEdit + popover.
    s = { ...s, textEdit: true, popover: 'm1' };
    const esc = (x: State) => reduce(x, keyAction(x, k('Escape'), { typing: false })!);

    expect(s.confirm).toBe(true);
    s = esc(s);
    expect(s.confirm).toBe(false);
    expect(s.textEdit).toBe(true);
    s = esc(s);
    expect(s.textEdit).toBe(false);
    expect(s.popover).toBe('m1');
    s = esc(s);
    expect(s.popover).toBeNull();
    expect(s.mode).toBe('review');
    s = esc(s);
    expect(s.mode).toBe('annotate');
    s = esc(s);
    expect(s.confirm).toBe(true); // close request with content → discard dialog
  });

  it('close request with nothing to lose goes straight to idle', () => {
    const s = annotate();
    expect(reduce(s, keyAction(s, k('Escape'), { typing: false })!).mode).toBe('idle');
  });
});

// ── tools, undo, Enter ──────────────────────────────────────────────────────

describe('tool keys', () => {
  it.each([
    ['p', 'pin'],
    ['e', 'element'],
    ['r', 'box'],
    ['a', 'arrow'],
    ['d', 'draw'],
    ['t', 'text'],
    ['P', 'pin'],
    ['T', 'text'],
  ])('%s picks %s in annotate', (key, tool) => {
    expect(keyAction(annotate(), k(key), { typing: false })).toEqual({ type: 'setTool', tool });
  });
  it('not while typing, not outside annotate, not with modifiers or the dialog open', () => {
    expect(keyAction(annotate(), k('p'), { typing: true })).toBeNull();
    expect(keyAction(review(), k('p'), { typing: false })).toBeNull();
    expect(keyAction(idle(), k('p'), { typing: false })).toBeNull();
    expect(keyAction(annotate(), k('p', { ctrlKey: true }), { typing: false })).toBeNull();
    expect(keyAction(annotate(), k('p', { metaKey: true }), { typing: false })).toBeNull();
    expect(keyAction(annotate(), k('p', { altKey: true }), { typing: false })).toBeNull();
    const confirm = run(annotate(), { type: 'addMark', id: 'm' }, { type: 'closeRequest' });
    expect(keyAction(confirm, k('p'), { typing: false })).toBeNull();
  });
});

describe('undo', () => {
  it('⌘Z and Ctrl+Z undo in annotate', () => {
    expect(keyAction(annotate(), k('z', { metaKey: true }), { typing: false })).toEqual({ type: 'undoMark' });
    expect(keyAction(annotate(), k('z', { ctrlKey: true }), { typing: false })).toEqual({ type: 'undoMark' });
    expect(keyAction(annotate(), k('Z', { ctrlKey: true }), { typing: false })).toEqual({ type: 'undoMark' });
  });
  it('not while typing, without the modifier, with Shift, or outside annotate', () => {
    expect(keyAction(annotate(), k('z', { metaKey: true }), { typing: true })).toBeNull();
    expect(keyAction(annotate(), k('z'), { typing: false })).toBeNull();
    expect(keyAction(annotate(), k('z', { metaKey: true, shiftKey: true }), { typing: false })).toBeNull();
    expect(keyAction(review(), k('z', { ctrlKey: true }), { typing: false })).toBeNull();
  });
});

describe('Enter → Describe', () => {
  it('in annotate, flow annotate, not typing', () => {
    expect(keyAction(annotate(), k('Enter'), { typing: false })).toEqual({ type: 'describe' });
  });
  it('not while typing, not in other flows, not with Shift', () => {
    expect(keyAction(annotate(), k('Enter'), { typing: true })).toBeNull();
    expect(keyAction(annotate('docked'), k('Enter'), { typing: false })).toBeNull();
    expect(keyAction(annotate('note'), k('Enter'), { typing: false })).toBeNull();
    expect(keyAction(annotate(), k('Enter', { shiftKey: true }), { typing: false })).toBeNull();
  });
  it('leaves Enter on a focused button to the button', () => {
    expect(keyAction(annotate(), k('Enter'), { typing: false, onButton: true })).toBeNull();
  });
});

describe('⌘/Ctrl+Enter → Send', () => {
  it('sends while the panel is visible, even while typing', () => {
    expect(keyAction(review(), k('Enter', { metaKey: true }), { typing: true })).toEqual({ type: 'send' });
    expect(keyAction(review(), k('Enter', { ctrlKey: true }), { typing: false })).toEqual({ type: 'send' });
    expect(keyAction(annotate('docked'), k('Enter', { ctrlKey: true }), { typing: true })).toEqual({ type: 'send' });
  });
  it('does nothing while the panel is hidden', () => {
    expect(keyAction(annotate(), k('Enter', { ctrlKey: true }), { typing: false })).toBeNull();
    expect(keyAction(annotate('note'), k('Enter', { ctrlKey: true }), { typing: false })).toBeNull();
    expect(keyAction(idle(), k('Enter', { metaKey: true }), { typing: false })).toBeNull();
  });
});

describe('shortcut label', () => {
  it('⌘↵ on macOS, Ctrl↵ elsewhere', () => {
    expect(sendShortcutLabel('MacIntel')).toBe('⌘↵');
    expect(sendShortcutLabel('iPhone')).toBe('⌘↵');
    expect(sendShortcutLabel('Win32')).toBe('Ctrl↵');
    expect(sendShortcutLabel('Linux x86_64')).toBe('Ctrl↵');
    expect(sendShortcutLabel('')).toBe('Ctrl↵');
    expect(isMacPlatform('MacIntel')).toBe(true);
    expect(isMacPlatform('Win32')).toBe(false);
  });
});

// ── installKeys (DOM wiring) ────────────────────────────────────────────────

describe('installKeys', () => {
  let state: State;
  let dispatch: ReturnType<typeof vi.fn<(e: Event) => void>>;
  let dispose: () => void;
  let host: HTMLElement;
  let root: ShadowRoot;

  beforeEach(() => {
    state = idle();
    dispatch = vi.fn((e: Event) => {
      state = reduce(state, e);
    });
    host = document.createElement('div');
    document.body.appendChild(host);
    root = host.attachShadow({ mode: 'open' });
    dispose = installKeys({ root, getState: () => state, dispatch });
  });
  afterEach(() => {
    dispose();
    host.remove();
    document.body.innerHTML = '';
  });

  const press = (target: EventTarget, key: string, mods: Partial<KeyInput> = {}) => {
    const ev = new KeyboardEvent('keydown', { key, bubbles: true, composed: true, cancelable: true, ...mods });
    target.dispatchEvent(ev);
    return ev;
  };

  it('Shift+F on the page opens and is prevented', () => {
    const ev = press(document.body, 'F', { shiftKey: true });
    expect(dispatch).toHaveBeenCalledWith({ type: 'open' });
    expect(ev.defaultPrevented).toBe(true);
    expect(state.mode).toBe('annotate');
  });

  it('Shift+F inside a host-page input is ignored', () => {
    const input = document.createElement('input');
    document.body.appendChild(input);
    press(input, 'F', { shiftKey: true });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('Shift+F inside host contenteditable is ignored', () => {
    const div = document.createElement('div');
    div.setAttribute('contenteditable', '');
    document.body.appendChild(div);
    press(div, 'F', { shiftKey: true });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('typing inside the widget shadow root counts as typing (keys ignored), ⌘↵ still sends', () => {
    state = run(state, { type: 'open' }, { type: 'describe' }, { type: 'draft', title: 'Broken' });
    const ta = document.createElement('textarea');
    root.appendChild(ta);
    press(ta, 'p');
    expect(dispatch).not.toHaveBeenCalled();
    const ev = press(ta, 'Enter', { metaKey: true });
    expect(dispatch).toHaveBeenCalledWith({ type: 'send' });
    expect(ev.defaultPrevented).toBe(true);
    expect(state.mode).toBe('sending');
  });

  it('tool keys, undo, Enter and Esc dispatch through the listener', () => {
    press(document.body, 'F', { shiftKey: true });
    press(document.body, 'r');
    expect(state.tool).toBe('box');
    state = reduce(state, { type: 'addMark', id: 'm1' });
    press(document.body, 'z', { ctrlKey: true });
    expect(state.marks).toHaveLength(0);
    press(document.body, 'Enter');
    expect(state.mode).toBe('review');
    press(document.body, 'Escape');
    expect(state.mode).toBe('annotate');
  });

  it('Enter on a focused widget button is left to the button', () => {
    state = reduce(state, { type: 'open' });
    const btn = document.createElement('button');
    root.appendChild(btn);
    btn.focus();
    const ev = press(btn, 'Enter');
    expect(dispatch).not.toHaveBeenCalled();
    expect(ev.defaultPrevented).toBe(false);
  });

  it('unhandled keys are not prevented; dispose detaches', () => {
    const ev = press(document.body, 'x');
    expect(ev.defaultPrevented).toBe(false);
    dispose();
    press(document.body, 'F', { shiftKey: true });
    expect(dispatch).not.toHaveBeenCalled();
    dispose = () => {};
  });
});

// ── Focus ───────────────────────────────────────────────────────────────────

describe('focus controller', () => {
  let host: HTMLElement;
  let root: ShadowRoot;
  let outside: HTMLButtonElement;

  function mountWidget() {
    root.innerHTML = `
      <div class="fw-panel" role="region">
        <button data-part="close">x</button>
        <input id="fw-pn-title" class="fw-pn-input" />
        <button class="fw-pn-send">Send</button>
      </div>
      <div class="fw-tb" role="toolbar">
        <button class="fw-tb-tool" aria-pressed="false" aria-label="Pin"></button>
        <button class="fw-tb-tool fw-tb-on" aria-pressed="true" aria-label="Box"></button>
        <button data-part="close">x</button>
      </div>
      <div data-part="popover" class="fw-pop">
        <textarea data-part="popover-text"></textarea>
        <button data-part="popover-save">Save</button>
      </div>
      <div aria-hidden="true"><button id="hidden">h</button></div>
      <button disabled id="dis">d</button>
      <button tabindex="-1" id="neg">n</button>`;
  }
  const q = <T extends Element = HTMLElement>(sel: string) => root.querySelector(sel) as unknown as T;

  beforeEach(() => {
    vi.useFakeTimers();
    outside = document.createElement('button');
    outside.textContent = 'host page';
    document.body.appendChild(outside);
    host = document.createElement('div');
    document.body.appendChild(host);
    root = host.attachShadow({ mode: 'open' });
    mountWidget();
  });
  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  it('delays come from the handoff', () => {
    expect(FOCUS_DELAYS).toEqual({ title: 420, popover: 40, noteTitle: 380 });
  });

  it('tabbables: toolbar → popover → panel, skipping disabled, tabindex -1 and aria-hidden', () => {
    const list = tabbables(root);
    expect(list.map((el) => el.getAttribute('aria-label') ?? el.getAttribute('data-part') ?? el.className ?? el.id)).toEqual([
      'Pin',
      'Box',
      'close',
      'popover-text',
      'popover-save',
      'close',
      'fw-pn-input',
      'fw-pn-send',
    ]);
  });

  it('on open focuses the active tool; on close restores the previous focus', () => {
    outside.focus();
    let s = idle();
    const fc = createFocusController({ root, getState: () => s });
    s = reduce(s, { type: 'open' });
    fc.update(s);
    vi.runAllTimers();
    expect(root.activeElement).toBe(q('.fw-tb-on'));
    s = reduce(s, { type: 'closeRequest' });
    fc.update(s);
    expect(document.activeElement).toBe(outside);
    fc.dispose();
  });

  it('focuses Title 420 ms after entering review (not before)', () => {
    let s = annotate();
    const fc = createFocusController({ root, getState: () => s });
    fc.update(s);
    s = reduce(s, { type: 'describe' });
    fc.update(s);
    vi.advanceTimersByTime(419);
    expect(root.activeElement).not.toBe(q('#fw-pn-title'));
    vi.advanceTimersByTime(1);
    expect(root.activeElement).toBe(q('#fw-pn-title'));
    fc.dispose();
  });

  it('focuses the popover textarea 40 ms after a numbered mark', () => {
    let s = annotate();
    const fc = createFocusController({ root, getState: () => s });
    fc.update(s);
    s = run(s, { type: 'addMark', id: 'm1' }, { type: 'popover', id: 'm1' });
    fc.update(s);
    vi.advanceTimersByTime(39);
    expect(root.activeElement).not.toBe(q('[data-part="popover-text"]'));
    vi.advanceTimersByTime(1);
    expect(root.activeElement).toBe(q('[data-part="popover-text"]'));
    fc.dispose();
  });

  it('a mark without a popover (arrow/draw) does not move focus', () => {
    let s = annotate();
    const fc = createFocusController({ root, getState: () => s });
    fc.update(s);
    vi.runAllTimers();
    const before = root.activeElement;
    s = reduce(s, { type: 'addMark', id: 'a1' });
    fc.update(s);
    vi.runAllTimers();
    expect(root.activeElement).toBe(before);
    fc.dispose();
  });

  it('flow note: first mark focuses Title after 380 ms', () => {
    let s = annotate('note');
    const fc = createFocusController({ root, getState: () => s });
    fc.update(s);
    s = reduce(s, { type: 'addMark', id: 'a1' });
    fc.update(s);
    vi.advanceTimersByTime(379);
    expect(root.activeElement).not.toBe(q('#fw-pn-title'));
    vi.advanceTimersByTime(1);
    expect(root.activeElement).toBe(q('#fw-pn-title'));
    fc.dispose();
  });

  it('a pending focus is cancelled when the widget closes', () => {
    outside.focus();
    let s = idle();
    const fc = createFocusController({ root, getState: () => s });
    s = run(s, { type: 'open' }, { type: 'describe' });
    fc.update(s);
    s = reduce(s, { type: 'esc' });
    s = reduce(s, { type: 'esc' });
    expect(s.mode).toBe('idle');
    fc.update(s);
    vi.runAllTimers();
    expect(document.activeElement).toBe(outside);
    fc.dispose();
  });

  describe('Tab trap', () => {
    const tab = (shift = false) => {
      const ev = new KeyboardEvent('keydown', { key: 'Tab', shiftKey: shift, bubbles: true, composed: true, cancelable: true });
      (root.activeElement ?? document.activeElement ?? document.body).dispatchEvent(ev);
      return ev;
    };

    it('wraps last → first and first → last while open', () => {
      let s = annotate();
      const fc = createFocusController({ root, getState: () => s });
      const list = tabbables(root);
      list[list.length - 1]!.focus();
      let ev = tab();
      expect(ev.defaultPrevented).toBe(true);
      expect(root.activeElement).toBe(list[0]);
      ev = tab(true);
      expect(ev.defaultPrevented).toBe(true);
      expect(root.activeElement).toBe(list[list.length - 1]);
      fc.dispose();
    });

    it('moves through the widget in toolbar → popover → panel order', () => {
      let s = annotate();
      const fc = createFocusController({ root, getState: () => s });
      const list = tabbables(root);
      list[0]!.focus();
      for (let i = 1; i < list.length; i++) {
        tab();
        expect(root.activeElement).toBe(list[i]);
      }
      fc.dispose();
    });

    it('pulls focus back in from the host page', () => {
      let s = annotate();
      const fc = createFocusController({ root, getState: () => s });
      outside.focus();
      const ev = tab();
      expect(ev.defaultPrevented).toBe(true);
      expect(root.activeElement).toBe(tabbables(root)[0]);
      fc.dispose();
    });

    it('does nothing while idle', () => {
      let s = idle();
      const fc = createFocusController({ root, getState: () => s });
      outside.focus();
      const ev = tab();
      expect(ev.defaultPrevented).toBe(false);
      expect(document.activeElement).toBe(outside);
      fc.dispose();
    });
  });
});

// ── Reduced motion ──────────────────────────────────────────────────────────

describe('prefers-reduced-motion', () => {
  it('drops translate/scale, caps fades at 150 ms', () => {
    expect(REDUCED_FADE_MAX_MS).toBe(150);
    expect(reducedMotion({ durationMs: 350, transform: 'translateY(12px) scale(.96)' }, true)).toEqual({
      durationMs: 150,
      transform: 'none',
    });
    expect(reducedMotion({ durationMs: 100, transform: 'translateX(-50%)' }, true)).toEqual({ durationMs: 100, transform: 'none' });
    expect(reducedMotion({ durationMs: 350, transform: 'scale(.9)' }, false)).toEqual({
      durationMs: 350,
      transform: 'scale(.9)',
    });
  });
  it('flash peaks at .3 instead of .9', () => {
    expect(FLASH_OPACITY).toBe(0.9);
    expect(FLASH_OPACITY_REDUCED).toBe(0.3);
    expect(reducedMotion({ durationMs: 500, flashOpacity: FLASH_OPACITY }, true).flashOpacity).toBe(0.3);
    expect(reducedMotion({ durationMs: 500, flashOpacity: FLASH_OPACITY }, false).flashOpacity).toBe(0.9);
  });
  it('the widget-wide sheet caps durations and the flash under the media query', () => {
    const css = reducedMotionCss();
    expect(css.startsWith('@media (prefers-reduced-motion:reduce){')).toBe(true);
    expect(css).toContain('transition-duration:150ms!important');
    expect(css).toContain('animation-duration:150ms!important');
    expect(css).toContain('translate:none!important');
    expect(css).toContain('scale:none!important');
    expect(css).toContain('.fw-flash{animation-name:fw-flash-reduced!important}');
  });
});
