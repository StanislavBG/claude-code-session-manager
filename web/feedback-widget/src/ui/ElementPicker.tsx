// Element picker — handoff README §5.4 "Element" and "Element-pick hover": while the `element`
// tool is armed, the pointer hit-tests the LIVE page under the frozen screenshot
// (document.elementFromPoint with every widget layer made transparent to hit-testing), outlines
// the element it finds with a selector chip, and a click adds an Element mark whose rect is the
// element's getBoundingClientRect() and which carries describeElement()'s record for the report.
//
// MarksLayer renders the committed Element mark (dashed border + selector chip) and ignores
// pointer input while this tool is armed; this component owns the hover and the click.
//
// Strict-CSP rule (DESIGN_SPEC.md "Decided changes" 3): static styles live in one constructed
// stylesheet adopted into the shadow root; per-hover values are CSSOM writes via Preact's
// style object — never a style attribute or <style>.

import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { HOST_ID } from '../host';
import { type ElementDescription, MIN_SIZE, describeElement } from '../selector';
import type { ElementMark, MarkColor } from './marks';
import { colors, fonts } from './tokens';

// ── Constants (§5.4 "Element-pick hover") ──────────────────────────────────

export const PICK_OUTLINE_COLOR = colors.accent; // #a83818
export const PICK_FILL = 'rgba(168,56,24,.08)';
/** Below this element top (px) the label chip goes under the element instead of above it. */
export const CHIP_FLIP_TOP = 34;
/** Gap between the element edge and the label chip. */
export const CHIP_GAP = 6;
export const PICK_CTA = 'click to select';
/** Set on the widget host for the duration of one hit-test: every widget layer stops hit-testing. */
export const HIT_TEST_ATTR = 'data-fw-hit-test';

/** An Element mark plus the describeElement() record the report carries (`marks[].element`). */
export type PickedElementMark = ElementMark & { element: ElementDescription };

export interface PickRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** `W×H`, rounded to whole px. */
export function dimLabel(r: Pick<PickRect, 'w' | 'h'>): string {
  return `${Math.round(r.w)}×${Math.round(r.h)}`;
}

/** Label chip placement: above the element (translated up by its own height), or below it when top < 34. */
export function chipPlacement(r: PickRect): { top: number; above: boolean } {
  if (r.y < CHIP_FLIP_TOP) return { top: r.y + r.h + CHIP_GAP, above: false };
  return { top: r.y - CHIP_GAP, above: true };
}

// ── Styles ──────────────────────────────────────────────────────────────────

export function pickerCss(): string {
  return [
    `:host([${HIT_TEST_ATTR}]),:host([${HIT_TEST_ATTR}]) *{pointer-events:none !important}`,
    `.fw-pick{position:absolute;inset:0;pointer-events:none}`,
    `.fw-pick-hit{position:absolute;inset:0;z-index:6;pointer-events:auto;cursor:crosshair;touch-action:none}`,
    `.fw-pick-outline{position:absolute;z-index:8;pointer-events:none;box-sizing:border-box;` +
      `border:2px solid ${PICK_OUTLINE_COLOR};background:${PICK_FILL};border-radius:3px}`,
    `.fw-pick-chip{position:absolute;z-index:8;pointer-events:none;display:flex;align-items:center;gap:8px;` +
      `padding:4px 8px;border-radius:5px;background:${colors.ink};color:${colors.paper};` +
      `font:500 11.5px/1.3 ${fonts.mono};white-space:nowrap}`,
    `.fw-pick-chip.fw-pick-above{transform:translateY(-100%)}`,
    `.fw-pick-sel{color:${colors.amber}}`,
    `.fw-pick-dim{color:${colors['rule-strong']}}`,
    `.fw-pick-cta{color:${colors.paper}}`,
  ].join('\n');
}

let sheetCache: CSSStyleSheet | null = null;

export function pickerSheet(): CSSStyleSheet | null {
  if (sheetCache) return sheetCache;
  if (typeof CSSStyleSheet !== 'function') return null;
  try {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(pickerCss());
    sheetCache = sheet;
  } catch {
    return null;
  }
  return sheetCache;
}

function adoptInto(node: Node): void {
  const root = node.getRootNode() as (ShadowRoot | Document) & { adoptedStyleSheets?: CSSStyleSheet[] };
  if (!root || !('adoptedStyleSheets' in root) || !Array.isArray(root.adoptedStyleSheets)) return;
  const sheet = pickerSheet();
  if (!sheet || root.adoptedStyleSheets.includes(sheet)) return;
  try {
    root.adoptedStyleSheets = [...root.adoptedStyleSheets, sheet];
  } catch {
    // Sheet from another realm — the host adopts it instead.
  }
}

// ── Hit-testing ─────────────────────────────────────────────────────────────

/** The widget host for a node inside the widget's shadow tree, else the page's host by id. */
function widgetHost(from: Node | null, doc: Document): Element | null {
  const root = from?.getRootNode();
  if (root && root instanceof ShadowRoot) return root.host;
  return doc.getElementById(HOST_ID);
}

/**
 * The live page element at viewport point (x, y), or null. Widget layers are excluded from the
 * hit-test (the host gets {@link HIT_TEST_ATTR}, which the adopted sheet turns into
 * `pointer-events:none` on everything in the shadow tree); the widget host, `html`, `body` and
 * elements under 4×4 are ignored.
 */
export function elementAt(x: number, y: number, from: Node | null = null, doc: Document = document): Element | null {
  const host = widgetHost(from, doc);
  let el: Element | null;
  if (host) {
    host.setAttribute(HIT_TEST_ATTR, '');
    try {
      el = doc.elementFromPoint(x, y);
    } finally {
      host.removeAttribute(HIT_TEST_ATTR);
    }
  } else {
    el = doc.elementFromPoint(x, y);
  }
  if (!el) return null;
  if (host && (el === host || host.contains(el))) return null;
  if (el.id === HOST_ID) return null;
  const tag = el.tagName.toLowerCase();
  if (tag === 'html' || tag === 'body') return null;
  const r = el.getBoundingClientRect();
  if (r.width < MIN_SIZE || r.height < MIN_SIZE) return null;
  return el;
}

// ── Component ───────────────────────────────────────────────────────────────

export interface ElementPickerProps {
  /** True while the `element` tool is armed and the marks layer accepts input. */
  active: boolean;
  color: MarkColor;
  /** A picked element. The owner appends + renumbers it (MarksLayer renders it). */
  onCreate(mark: PickedElementMark): void;
  /** The hovered page element (or null) — mirrors into the machine's `hover` flag. */
  onHover?(el: Element | null): void;
  /** Mark id factory; defaults to a per-page counter. */
  newId?(): string;
}

interface Hover {
  el: Element;
  rect: PickRect;
  selector: string;
}

let idSeq = 0;
function defaultId(): string {
  idSeq += 1;
  return `e${Date.now().toString(36)}${idSeq.toString(36)}`;
}

const px = (v: number) => `${v}px`;

export function ElementPicker(props: ElementPickerProps) {
  const { active } = props;
  const rootRef = useRef<HTMLDivElement>(null);
  const [hover, setHoverState] = useState<Hover | null>(null);
  const hoverRef = useRef<Hover | null>(null);
  const live = useRef(props);
  live.current = props;

  const setHover = (h: Hover | null) => {
    const prev = hoverRef.current;
    hoverRef.current = h;
    setHoverState(h);
    if ((prev?.el ?? null) !== (h?.el ?? null)) live.current.onHover?.(h?.el ?? null);
  };

  useLayoutEffect(() => {
    if (active && rootRef.current) adoptInto(rootRef.current);
  }, [active]);

  useEffect(() => {
    if (!active && hoverRef.current) setHover(null);
  }, [active]);

  /** Origin of the picker's box in the viewport (the capture surface is fixed at 0,0). */
  const origin = () => {
    const r = rootRef.current?.getBoundingClientRect();
    return { x: r?.left ?? 0, y: r?.top ?? 0 };
  };

  const hitAt = (e: { clientX: number; clientY: number }): Hover | null => {
    const el = elementAt(e.clientX, e.clientY, rootRef.current);
    if (!el) return null;
    const b = el.getBoundingClientRect();
    const o = origin();
    const rect = { x: b.left - o.x, y: b.top - o.y, w: b.width, h: b.height };
    const prev = hoverRef.current;
    if (prev && prev.el === el) return { ...prev, rect };
    const desc = describeElement(el);
    return desc ? { el, rect, selector: desc.selector } : null;
  };

  const onMove = (e: PointerEvent) => {
    setHover(hitAt(e));
  };

  const onLeave = () => setHover(null);

  const onClick = (e: MouseEvent) => {
    if (e.button !== 0) return;
    const el = elementAt(e.clientX, e.clientY, rootRef.current);
    if (!el) return;
    const desc = describeElement(el);
    if (!desc) return;
    const b = el.getBoundingClientRect();
    const o = origin();
    const p = live.current;
    p.onCreate({
      id: (p.newId ?? defaultId)(),
      kind: 'element',
      color: p.color,
      x: b.left - o.x,
      y: b.top - o.y,
      w: b.width,
      h: b.height,
      selector: desc.selector,
      element: desc,
    });
  };

  if (!active) return null;

  const chip = hover ? chipPlacement(hover.rect) : null;
  return (
    <div ref={rootRef} class="fw-pick" data-part="element-picker">
      <div
        class="fw-pick-hit"
        data-part="pick-hit"
        onPointerMove={onMove}
        onPointerLeave={onLeave}
        onClick={onClick}
      />
      {hover && chip && (
        <>
          <div
            class="fw-pick-outline"
            data-part="pick-outline"
            style={{ left: px(hover.rect.x), top: px(hover.rect.y), width: px(hover.rect.w), height: px(hover.rect.h) }}
          />
          <div
            class={chip.above ? 'fw-pick-chip fw-pick-above' : 'fw-pick-chip'}
            data-part="pick-chip"
            data-placement={chip.above ? 'above' : 'below'}
            style={{ left: px(hover.rect.x), top: px(chip.top) }}
          >
            <span class="fw-pick-sel">{hover.selector}</span>
            <span class="fw-pick-dim">{dimLabel(hover.rect)}</span>
            <span class="fw-pick-cta">{PICK_CTA}</span>
          </div>
        </>
      )}
    </div>
  );
}
