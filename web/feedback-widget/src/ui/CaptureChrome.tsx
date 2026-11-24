// Capture chrome — handoff README §5.2 "Capture feedback" (flash, frame, hint chip) and §1
// "Screenshot capture": while the widget is open the frozen screenshot is a full-viewport
// backdrop under the marks layer, and the capture surface blocks the page underneath
// (swallows pointer events, preventDefault on wheel/touchmove). §7: on resize the backdrop
// keeps its captured size, anchored top-left — never re-captured.
//
// Strict-CSP rule (DESIGN_SPEC.md §"Decided changes" 3): static styles live in one
// constructed stylesheet adopted into the shadow root; per-render values (backdrop size, hint
// position) are CSSOM property writes via Preact's style object — never a style attribute.

import type { ComponentChildren } from 'preact';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { CaptureResult } from '../capture';
import { type Event, type State, type Tool, frameVisible, hintVisible, isOpen } from './machine';
import { type PanelSide, adoptInto, freeArea } from './shared';
import { colors, fonts } from './tokens';

/** Flash duration (§5.2: opacity .9 → 0 over 500 ms ease-out). */
export const FLASH_MS = 500;
/** Mark-comment popovers carry this attribute; clicks inside one are never intercepted. */
export const POPOVER_ATTR = 'data-fw-popover';

/** §5.2 tool hint copy. */
export const HINT_COPY: Readonly<Record<Tool, string>> = {
  pin: 'Click anywhere to drop a numbered pin',
  element: 'Hover an element, click to select it',
  box: 'Drag to box an area',
  arrow: 'Drag to point at something',
  draw: 'Draw freely',
  text: 'Click to place a text label',
};
/** §5.2: flow `note` with no marks yet. */
export const NOTE_FIRST_HINT = 'Mark the spot first — your note opens beside it';

export type ToolbarPlacement = 'dock' | 'rail' | 'corner';

export function hintText(s: State): string {
  if (s.config.flow === 'note' && s.marks.length === 0) return NOTE_FIRST_HINT;
  return HINT_COPY[s.tool];
}

export function captureChromeCss(): string {
  return [
    `.fw-surface{position:fixed;inset:0;pointer-events:auto;overflow:hidden;touch-action:none;overscroll-behavior:contain}`,
    `.fw-backdrop{position:absolute;top:0;left:0;max-width:none;max-height:none;pointer-events:none;user-select:none;-webkit-user-drag:none}`,
    `.fw-frame{position:fixed;inset:0;z-index:5;pointer-events:none;box-shadow:inset 0 0 0 3px ${colors.accent}}`,
    `.fw-hint{position:fixed;z-index:20;display:flex;align-items:center;white-space:nowrap;border-radius:999px;background:${colors.ink};padding:7px 8px 7px 12px;gap:10px;box-shadow:0 10px 24px -10px rgba(26,22,18,.6);pointer-events:none;transform:translateX(-50%)}`,
    `.fw-hint-label{display:flex;align-items:center;gap:6px;font:500 10.5px ${fonts.mono};letter-spacing:.08em;text-transform:uppercase;color:${colors.amber}}`,
    `.fw-hint-dot{width:7px;height:7px;border-radius:50%;background:${colors.accent};box-shadow:0 0 0 2px rgba(244,185,66,.55)}`,
    `.fw-hint-text{font:500 12.5px ${fonts.sans};color:${colors.paper}}`,
    `.fw-hint-esc{font:500 10.5px ${fonts.mono};padding:2px 6px;border-radius:5px;background:rgba(245,240,230,.12);color:${colors['rule-strong']}}`,
    `@keyframes fw-flash{from{opacity:.9}to{opacity:0}}`,
    `@keyframes fw-flash-reduced{from{opacity:.3}to{opacity:0}}`,
    `.fw-flash{position:fixed;inset:0;z-index:70;background:#ffffff;pointer-events:none;opacity:0;animation:fw-flash ${FLASH_MS}ms ease-out forwards}`,
    `.fw-flash--reduced{animation-name:fw-flash-reduced}`,
  ].join('\n');
}

let sheetCache: CSSStyleSheet | null = null;

function captureChromeSheet(): CSSStyleSheet | null {
  if (sheetCache) return sheetCache;
  if (typeof CSSStyleSheet !== 'function') return null;
  try {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(captureChromeCss());
    sheetCache = sheet;
  } catch {
    return null;
  }
  return sheetCache;
}

function prefersReducedMotion(): boolean {
  try {
    return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

/** Pointer-ish events the surface keeps from the host page. */
const SWALLOWED = [
  'pointerdown', 'pointerup', 'pointermove', 'pointerover', 'pointerout', 'pointerenter', 'pointerleave',
  'mousedown', 'mouseup', 'mousemove', 'mouseover', 'mouseout', 'click', 'dblclick', 'auxclick',
  'contextmenu', 'touchstart', 'touchend', 'touchcancel',
] as const;
/** Gesture events intercepted (capture phase) while a popover is open. */
const GESTURE = ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'touchstart', 'touchend', 'click'] as const;

export interface CaptureChromeProps {
  state: State;
  dispatch: (e: Event) => void;
  /** The capture taken on open; null while it is still in flight. */
  capture: CaptureResult | null;
  /** Toolbar placement (§5.3); sets the hint's top. Default dock. */
  toolbar?: ToolbarPlacement;
  /** Side of the docked panel (flow `docked` only). Default right. */
  panelSide?: PanelSide;
  /** The marks layer and anything else that sits on the frozen screenshot. */
  children?: ComponentChildren;
}

export function CaptureChrome(props: CaptureChromeProps) {
  const { state, capture, toolbar = 'dock', panelSide = 'right', children } = props;
  const open = isOpen(state);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const live = useRef({ popover: state.popover, dispatch: props.dispatch });
  live.current = { popover: state.popover, dispatch: props.dispatch };

  const [src, setSrc] = useState<string | null>(null);
  const [flashKey, setFlashKey] = useState(0);
  const [flashing, setFlashing] = useState<false | 'full' | 'reduced'>(false);
  const [vw, setVw] = useState(() => (typeof window !== 'undefined' ? window.innerWidth : 0));

  const shown = open ? capture : null;

  // Backdrop object URL, revoked when the capture changes or the widget closes.
  useEffect(() => {
    if (!shown || typeof URL.createObjectURL !== 'function') {
      setSrc(null);
      return;
    }
    const url = URL.createObjectURL(shown.png);
    setSrc(url);
    return () => URL.revokeObjectURL?.(url);
  }, [shown]);

  // Flash once per new capture.
  useEffect(() => {
    if (!shown) {
      setFlashing(false);
      return;
    }
    setFlashKey((k) => k + 1);
    setFlashing(prefersReducedMotion() ? 'reduced' : 'full');
    const t = setTimeout(() => setFlashing(false), FLASH_MS);
    return () => clearTimeout(t);
  }, [shown]);

  // Track the viewport width (hint centring only — the backdrop keeps its captured size).
  useEffect(() => {
    if (!open) return;
    const onResize = () => setVw(window.innerWidth);
    onResize();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [open]);

  useLayoutEffect(() => {
    if (open) adoptInto(surfaceRef.current, captureChromeSheet());
  }, [open]);

  // Block the page: swallow pointer events, stop scrolling; close an open popover on a
  // click outside it without letting that click reach the marks layer.
  useEffect(() => {
    const el = surfaceRef.current;
    if (!open || !el) return;
    let closing = false;
    // Whether a popover was already open when the current gesture's pointerdown arrived. A
    // popover the gesture itself opened (pin, box, element creation) must survive its trailing
    // pointerup / mouseup / click. null = no pointerdown seen (a bare click).
    let openAtDown: boolean | null = null;
    const stop = (e: globalThis.Event) => e.stopPropagation();
    const noScroll = (e: globalThis.Event) => e.preventDefault();
    const intercept = (e: globalThis.Event) => {
      const target = e.target instanceof Element ? e.target : null;
      if (target?.closest(`[${POPOVER_ATTR}]`)) return;
      if (e.type === 'pointerdown' || e.type === 'touchstart') openAtDown = live.current.popover !== null;
      const openedByGesture = openAtDown === false && !closing;
      if (e.type === 'click') {
        const wasOpenedByGesture = openedByGesture;
        openAtDown = null;
        if (wasOpenedByGesture) return;
      } else if (openedByGesture) {
        return;
      }
      const popoverOpen = live.current.popover !== null;
      const starts = e.type === 'pointerdown' || (e.type === 'click' && !closing);
      if (e.type === 'pointerdown') closing = false;
      if (!popoverOpen && !closing) return;
      e.stopPropagation();
      e.preventDefault();
      if (starts && popoverOpen) {
        closing = e.type !== 'click';
        live.current.dispatch({ type: 'popover', id: null });
      } else if (e.type === 'click') {
        closing = false;
      }
    };
    for (const t of SWALLOWED) el.addEventListener(t, stop);
    for (const t of GESTURE) el.addEventListener(t, intercept, true);
    el.addEventListener('wheel', noScroll, { passive: false });
    el.addEventListener('touchmove', noScroll, { passive: false });
    return () => {
      for (const t of SWALLOWED) el.removeEventListener(t, stop);
      for (const t of GESTURE) el.removeEventListener(t, intercept, true);
      el.removeEventListener('wheel', noScroll);
      el.removeEventListener('touchmove', noScroll);
    };
  }, [open]);

  if (!open) return null;

  const area = freeArea(vw, state.config.flow, panelSide);
  const hintLeft = (area.x0 + area.x1) / 2;
  const hintTop = toolbar === 'dock' ? 80 : 16;

  return (
    <>
      <div ref={surfaceRef} class="fw-surface">
        {shown && src ? (
          <img
            class="fw-backdrop"
            src={src}
            alt=""
            draggable={false}
            style={{ width: `${shown.width / shown.scale}px`, height: `${shown.height / shown.scale}px` }}
          />
        ) : null}
        {children}
      </div>
      {frameVisible(state) ? <div class="fw-frame" aria-hidden="true" /> : null}
      {hintVisible(state) ? (
        <div class="fw-hint" aria-hidden="true" style={{ left: `${hintLeft}px`, top: `${hintTop}px` }}>
          <span class="fw-hint-label">
            <span class="fw-hint-dot" />
            Screenshot
          </span>
          <span class="fw-hint-text">{hintText(state)}</span>
          <span class="fw-hint-esc">Esc</span>
        </div>
      ) : null}
      {flashing ? (
        <div key={flashKey} class={flashing === 'reduced' ? 'fw-flash fw-flash--reduced' : 'fw-flash'} aria-hidden="true" />
      ) : null}
    </>
  );
}
