// Keyboard map (handoff README §3) and focus & accessibility rules (§4).
//
// Three pieces, each usable on its own:
// - keyAction(): pure — (machine state, key, context) → the machine Event to dispatch, or null.
//   The Esc priority itself lives in the machine's `esc` reducer; this file only routes the key.
// - installKeys(): one window keydown listener that applies keyAction() and dispatches.
// - createFocusController(): moves focus on state transitions (active tool on open, Title after
//   Describe, popover textarea after a numbered mark, Title on the first `note` mark), traps Tab
//   inside the widget while it is open, and restores the host page's focus on close.
// Plus the reduced-motion rules (§4): reducedMotion() for values set from script and
// reducedMotionCss() for the widget-wide stylesheet.
//
// Drawing tools stay pointer-only (§4); every other path — open, pick a tool, describe, send,
// close — works from the keyboard.

import { isOpen, panelVisible, type Event, type State, type Tool } from './machine';
import { FOCUS_TITLE_DELAY_MS, shortcutChip } from './Panel';
import { AUTOFOCUS_DELAY_MS } from './Popover';
import { TOOLS } from './Toolbar';

// ── Platform label ──────────────────────────────────────────────────────────

function navPlatform(): string {
  return typeof navigator === 'undefined' ? '' : navigator.platform ?? '';
}

export function isMacPlatform(platform: string = navPlatform()): boolean {
  return /mac|iphone|ipad|ipod/i.test(platform);
}

/** §3: the Send shortcut reads "⌘↵" on macOS and "Ctrl↵" elsewhere (same rule as the panel chip). */
export function sendShortcutLabel(platform: string = navPlatform()): string {
  return shortcutChip(platform);
}

// ── Key routing (§3) ────────────────────────────────────────────────────────

export interface KeyInput {
  key: string;
  shiftKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
}

export interface KeyContext {
  /** Focus is in an input / textarea / select / contenteditable (host page or widget). */
  typing: boolean;
  /** Focus is on a button — Enter then belongs to the button's own activation. */
  onButton?: boolean;
}

const TOOL_BY_KEY: ReadonlyMap<string, Tool> = new Map(TOOLS.map((t) => [t.key.toLowerCase(), t.id]));

/** The machine event a key press maps to, or null when the key is not the widget's. */
export function keyAction(s: State, k: KeyInput, ctx: KeyContext): Event | null {
  const key = k.key;
  const lower = key.length === 1 ? key.toLowerCase() : key;
  const cmd = k.metaKey || k.ctrlKey;
  const anyMod = cmd || k.altKey;

  // Shift+F: open, idle only, never while typing, never with Ctrl/Meta/Alt.
  if (lower === 'f' && k.shiftKey && !anyMod) {
    return s.mode === 'idle' && !ctx.typing ? { type: 'open' } : null;
  }

  if (!isOpen(s)) return null;

  // Esc: the machine closes the first layer that applies
  // (discard dialog → text-label input → popover → review → close request).
  if (key === 'Escape' || key === 'Esc') return { type: 'esc' };

  // ⌘/Ctrl+Enter: Send from any field while the panel is visible.
  if (key === 'Enter' && cmd && !k.altKey) {
    return panelVisible(s) ? { type: 'send' } : null;
  }

  // Everything below: annotate only, not typing, no discard dialog.
  if (s.mode !== 'annotate' || ctx.typing || s.confirm) return null;

  if (lower === 'z' && cmd && !k.shiftKey && !k.altKey) return { type: 'undoMark' };

  if (anyMod || k.shiftKey) return null;

  if (key === 'Enter') {
    return s.config.flow === 'annotate' && !ctx.onButton ? { type: 'describe' } : null;
  }

  const tool = TOOL_BY_KEY.get(lower);
  return tool ? { type: 'setTool', tool } : null;
}

// ── Focus helpers ───────────────────────────────────────────────────────────

const TYPING_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT']);

/** True for input / textarea / select and anything inside an editable contenteditable. */
export function isTypingElement(el: Element | null | undefined): boolean {
  if (!el) return false;
  if (TYPING_TAGS.has(el.tagName)) return true;
  if ((el as HTMLElement).isContentEditable) return true;
  // jsdom (and detached nodes) lack isContentEditable: walk the attribute.
  const host = el.closest?.('[contenteditable]');
  if (!host) return false;
  const v = (host.getAttribute('contenteditable') ?? '').toLowerCase();
  return v === '' || v === 'true' || v === 'plaintext-only';
}

/** The focused element, descending through open shadow roots. */
export function deepActiveElement(doc: Document = document): Element | null {
  let el: Element | null = doc.activeElement;
  while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement;
  return el;
}

/** The element a key event really started on (through open shadow roots, and our own root). */
function eventOrigin(e: KeyboardEvent, root: ShadowRoot | null): Element | null {
  const first = typeof e.composedPath === 'function' ? e.composedPath()[0] : e.target;
  let el = first instanceof Element ? first : null;
  // A closed shadow root retargets to its host; ask the root what is focused instead.
  if (root && el === root.host && root.activeElement) el = root.activeElement;
  return el ?? deepActiveElement();
}

export interface InstallKeysOptions {
  /** The widget's shadow root (lets a closed root report its own focus). */
  root?: ShadowRoot | null;
  getState(): State;
  dispatch(e: Event): void;
  /** Listener target; defaults to window. */
  target?: Pick<Window, 'addEventListener' | 'removeEventListener'>;
}

/** Attaches the §3 keyboard map; returns the detach function. */
export function installKeys(opts: InstallKeysOptions): () => void {
  const target = opts.target ?? window;
  const root = opts.root ?? null;
  const onKey = (ev: globalThis.Event) => {
    const e = ev as KeyboardEvent;
    if (e.defaultPrevented || e.isComposing) return;
    const origin = eventOrigin(e, root);
    const action = keyAction(opts.getState(), e, {
      typing: isTypingElement(origin),
      onButton: origin?.tagName === 'BUTTON',
    });
    if (!action) return;
    e.preventDefault();
    opts.dispatch(action);
  };
  target.addEventListener('keydown', onKey);
  return () => target.removeEventListener('keydown', onKey);
}

// ── Focus controller (§4) ───────────────────────────────────────────────────

/** §2/§4 focus delays (ms). */
export const FOCUS_DELAYS = {
  title: FOCUS_TITLE_DELAY_MS,
  popover: AUTOFOCUS_DELAY_MS,
  noteTitle: 380,
} as const;

/** Where each focus target lives inside the widget. */
export const FOCUS_SELECTORS = {
  activeTool: '[role="toolbar"] button[aria-pressed="true"].fw-tb-tool, [role="toolbar"] .fw-tb-on',
  title: '#fw-pn-title',
  popoverText: '[data-part="popover-text"]',
} as const;

const TABBABLE =
  'button, [href], input, select, textarea, [tabindex], [contenteditable]:not([contenteditable="false"])';

/** Tab order groups (§4: toolbar → popover → panel); anything else follows, in DOM order. */
const GROUPS = ['[role="toolbar"]', '[data-part="popover"]', '.fw-panel'];

function groupRank(el: Element): number {
  for (let i = 0; i < GROUPS.length; i++) if (el.closest(GROUPS[i]!)) return i;
  return GROUPS.length;
}

function isTabbable(el: HTMLElement): boolean {
  if ((el as HTMLButtonElement).disabled) return false;
  if (el.getAttribute('tabindex') === '-1') return false;
  if (el.closest('[aria-hidden="true"], [hidden], [inert]')) return false;
  return true;
}

/** Tabbable elements inside the widget, in §4 order. */
export function tabbables(root: ParentNode): HTMLElement[] {
  const all = Array.from(root.querySelectorAll<HTMLElement>(TABBABLE)).filter(isTabbable);
  return all
    .map((el, i) => ({ el, i, g: groupRank(el) }))
    .sort((a, b) => a.g - b.g || a.i - b.i)
    .map((x) => x.el);
}

export interface FocusControllerOptions {
  /** The widget's shadow root (or container element). */
  root: ShadowRoot | HTMLElement;
  getState(): State;
  doc?: Document;
}

export interface FocusController {
  /** Call after every state change with the new state. */
  update(next: State): void;
  dispose(): void;
}

function rootActive(root: ShadowRoot | HTMLElement, doc: Document): Element | null {
  if (root instanceof ShadowRoot) return root.activeElement;
  const a = doc.activeElement;
  return a && root.contains(a) ? a : null;
}

export function createFocusController(opts: FocusControllerOptions): FocusController {
  const { root } = opts;
  const doc = opts.doc ?? document;
  let prev: State = opts.getState();
  let restoreTo: HTMLElement | null = null;
  const timers = new Set<ReturnType<typeof setTimeout>>();

  const clearTimers = () => {
    for (const t of timers) clearTimeout(t);
    timers.clear();
  };

  const focusLater = (selector: string, ms: number) => {
    const t = setTimeout(() => {
      timers.delete(t);
      if (!isOpen(opts.getState())) return;
      root.querySelector<HTMLElement>(selector)?.focus({ preventScroll: true });
    }, ms);
    timers.add(t);
  };

  const update = (next: State) => {
    const was = prev;
    prev = next;
    const opened = (!isOpen(was) && isOpen(next)) || (isOpen(next) && next.session !== was.session);

    if (opened) {
      if (!isOpen(was)) {
        const active = deepActiveElement(doc);
        restoreTo = active instanceof HTMLElement && !root.contains(active) && active !== (root as ShadowRoot).host ? active : null;
      }
      focusLater(FOCUS_SELECTORS.activeTool, 0);
    }

    if (isOpen(was) && !isOpen(next)) {
      clearTimers();
      const target = restoreTo;
      restoreTo = null;
      if (target?.isConnected) target.focus({ preventScroll: true });
      return;
    }

    if (was.mode !== 'review' && next.mode === 'review' && next.config.flow === 'annotate') {
      focusLater(FOCUS_SELECTORS.title, FOCUS_DELAYS.title);
    }

    const added = next.marks.length > was.marks.length && next.session === was.session;
    if (added) {
      const newest = next.marks[next.marks.length - 1]!.id;
      if (next.popover === newest) focusLater(FOCUS_SELECTORS.popoverText, FOCUS_DELAYS.popover);
      if (next.config.flow === 'note' && was.marks.length === 0) {
        focusLater(FOCUS_SELECTORS.title, FOCUS_DELAYS.noteTitle);
      }
    }
  };

  const onKey = (ev: globalThis.Event) => {
    const e = ev as KeyboardEvent;
    if (e.key !== 'Tab' || e.altKey || e.ctrlKey || e.metaKey) return;
    if (!isOpen(opts.getState())) return;
    const list = tabbables(root);
    if (list.length === 0) return;
    const active = rootActive(root, doc);
    const i = active ? list.indexOf(active as HTMLElement) : -1;
    const n = list.length;
    const next = i === -1 ? (e.shiftKey ? n - 1 : 0) : (i + (e.shiftKey ? -1 : 1) + n) % n;
    e.preventDefault();
    list[next]!.focus({ preventScroll: true });
  };

  doc.addEventListener('keydown', onKey, true);
  return {
    update,
    dispose() {
      clearTimers();
      doc.removeEventListener('keydown', onKey, true);
    },
  };
}

// ── Reduced motion (§4) ─────────────────────────────────────────────────────

export const REDUCED_FADE_MAX_MS = 150;
/** §5.2 flash peak opacity, and its reduced-motion cap. */
export const FLASH_OPACITY = 0.9;
export const FLASH_OPACITY_REDUCED = 0.3;

export function prefersReducedMotion(): boolean {
  try {
    return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

export interface MotionSpec {
  durationMs: number;
  /** Starting transform of an enter/exit motion (translate/scale). */
  transform?: string;
  flashOpacity?: number;
}

/** §4 for values set from script: no translate/scale, fades ≤ 150 ms, flash ≤ .3. */
export function reducedMotion<T extends MotionSpec>(spec: T, reduced: boolean = prefersReducedMotion()): T {
  if (!reduced) return spec;
  const out: T = { ...spec, durationMs: Math.min(spec.durationMs, REDUCED_FADE_MAX_MS) };
  if (spec.transform !== undefined) out.transform = 'none';
  if (spec.flashOpacity !== undefined) out.flashOpacity = Math.min(spec.flashOpacity, FLASH_OPACITY_REDUCED);
  return out;
}

/**
 * Widget-wide reduced-motion sheet: caps every transition/animation at 150 ms, drops the
 * individual translate/scale properties, and swaps the capture flash to its .3 keyframes.
 * Transform-based motion is dropped per component (each component sheet resets its own
 * hidden-state transform), since a blanket `transform:none` would also undo static centring.
 */
export function reducedMotionCss(): string {
  return (
    `@media (prefers-reduced-motion:reduce){` +
    `*,*::before,*::after{transition-duration:${REDUCED_FADE_MAX_MS}ms!important;` +
    `animation-duration:${REDUCED_FADE_MAX_MS}ms!important;translate:none!important;scale:none!important}` +
    `.fw-flash{animation-name:fw-flash-reduced!important}}`
  );
}
