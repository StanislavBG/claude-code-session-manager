// Marks layer — handoff README §5.4 "Marks": draws every mark on the frozen screenshot and
// creates pins, boxes, arrows, drawings and text labels from pointer input. All geometry
// (thresholds, smoothing, arrow head, pin/badge boxes) comes from marks.ts, so the live layer
// and the flattened PNG agree. Element marks are rendered here; picking an element (the
// `element` tool's hover + selector) belongs to the element picker, so this layer ignores
// pointer input while that tool is armed.
//
// Strict-CSP rule (DESIGN_SPEC.md "Decided changes" 3): static styles live in one constructed
// stylesheet adopted into the root node; per-mark values (position, size, colour, ring) are
// CSSOM property writes through Preact's style object — never a style attribute or <style>.
//
// The layer is controlled: the parent owns `marks` (useMarks() below is the stock owner, and
// mirrors add/remove/undo into the state machine when given its dispatch).

import { useCallback, useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { Event, Tool } from './machine';
import {
  type ArrowMark,
  type BoxMark,
  type ElementMark,
  type Mark,
  type MarkColor,
  type PinMark,
  type Point,
  type TextMark,
  UNDERLAY_COLOR,
  UNDERLAY_WIDTH,
  STROKE_WIDTH,
  TEXT_CHIP_OFFSET_Y,
  arrowCommits,
  arrowHead,
  badgeBox,
  boxCommits,
  drawCommits,
  drawPath,
  number,
  pinBox,
  rectFromDrag,
  sampleDrawPoint,
  textColorOn,
} from './marks';
import { colors, fonts } from './tokens';
import { Popover, isCommentMark } from './Popover';

// ── Constants (§5.4) ────────────────────────────────────────────────────────

export const MARK_SHADOW = '0 2px 6px rgba(26,22,18,.35)';
export const HIGHLIGHT_RING = '0 0 0 4px rgba(244,185,66,.75), 0 2px 6px rgba(26,22,18,.35)';
export const BOX_HALO = '0 0 0 1px rgba(255,255,255,.75)';
export const TEXT_CHIP_SHADOW = '0 0 0 2px #fff, 0 3px 8px rgba(26,22,18,.3)';
export const TEXT_INPUT_WIDTH = 240;
/** The input's 2 px border sits outside the chip's box, so its text lines up with the chip. */
export const TEXT_INPUT_OFFSET_Y = TEXT_CHIP_OFFSET_Y + 2;
/** The shaft runs 2 px into the head so no seam shows between them. */
const SHAFT_OVERLAP = 2;

/** `rgba(r,g,b,a)` for a `#rrggbb` mark colour. */
export function tint(hex: string, alpha: number): string {
  const v = parseInt(hex.slice(1), 16);
  return `rgba(${(v >> 16) & 255},${(v >> 8) & 255},${v & 255},${alpha})`;
}

/** Shaft path of an arrow: from the tail to 2 px past the head's base. */
export function arrowShaftPath(m: Pick<ArrowMark, 'x1' | 'y1' | 'x2' | 'y2'>): string {
  const head = arrowHead(m.x1, m.y1, m.x2, m.y2);
  const L = Math.hypot(m.x2 - m.x1, m.y2 - m.y1) || 1;
  const ux = (m.x2 - m.x1) / L;
  const uy = (m.y2 - m.y1) / L;
  const r = (v: number) => Math.round(v * 100) / 100;
  return `M${r(m.x1)} ${r(m.y1)} L${r(head.base.x + ux * SHAFT_OVERLAP)} ${r(head.base.y + uy * SHAFT_OVERLAP)}`;
}

// ── Styles ──────────────────────────────────────────────────────────────────

export function marksCss(): string {
  return [
    `.fw-marks{position:absolute;inset:0}`,
    `.fw-marks-hit{position:absolute;inset:0;z-index:6;touch-action:none;cursor:crosshair}`,
    `.fw-marks-hit.fw-marks-off{pointer-events:none;cursor:default}`,
    `.fw-marks-ink{position:absolute;inset:0;z-index:7;pointer-events:none}`,
    `.fw-mk-svg{position:absolute;left:0;top:0;overflow:visible}`,
    `.fw-mk-under{fill:none;stroke:${UNDERLAY_COLOR};stroke-width:${UNDERLAY_WIDTH};stroke-linecap:round;stroke-linejoin:round}`,
    `.fw-mk-under-head{fill:${UNDERLAY_COLOR};stroke:${UNDERLAY_COLOR};stroke-width:5;stroke-linejoin:round}`,
    `.fw-mk-line{fill:none;stroke-width:${STROKE_WIDTH};stroke-linecap:round;stroke-linejoin:round}`,
    `.fw-mk-head{stroke-width:1.5;stroke-linejoin:round}`,
    `.fw-mk-pin{position:absolute;box-sizing:border-box;width:28px;height:28px;padding:0;border:2px solid #fff;` +
      `border-radius:14px 14px 14px 3px;font:700 12px/24px ${fonts.mono};text-align:center;` +
      `pointer-events:auto;cursor:pointer}`,
    `.fw-mk-box{position:absolute;box-sizing:border-box;border-radius:5px;border-width:2.5px;border-style:solid;box-shadow:${BOX_HALO}}`,
    `.fw-mk-box.fw-mk-element{border-style:dashed}`,
    `.fw-mk-badge{position:absolute;box-sizing:border-box;width:24px;height:24px;padding:0;border:2px solid #fff;` +
      `border-radius:50%;font:700 11px/20px ${fonts.mono};text-align:center;pointer-events:auto;cursor:pointer}`,
    `.fw-mk-sel{position:absolute;transform:translateY(-100%);padding:3px 7px;border-radius:5px;` +
      `font:500 11px/1.3 ${fonts.mono};white-space:nowrap}`,
    `.fw-mk-text{position:absolute;max-width:300px;padding:4px 10px;border-radius:7px;` +
      `font:600 15px/1.35 ${fonts.sans};box-shadow:${TEXT_CHIP_SHADOW};white-space:pre-wrap;overflow-wrap:anywhere}`,
    `.fw-mk-input{position:absolute;z-index:9;box-sizing:border-box;width:${TEXT_INPUT_WIDTH}px;padding:4px 10px;` +
      `border-radius:7px;border-width:2px;border-style:dashed;background:#fff;font:600 15px/1.35 ${fonts.sans};outline:none}`,
    `.fw-mk-input::placeholder{color:${colors['ink-4']}}`,
    `.fw-mk-pin:focus-visible,.fw-mk-badge:focus-visible{outline:2px solid ${colors.amber};outline-offset:2px}`,
  ].join('\n');
}

let sheetCache: CSSStyleSheet | null = null;

export function marksSheet(): CSSStyleSheet | null {
  if (sheetCache) return sheetCache;
  if (typeof CSSStyleSheet !== 'function') return null;
  try {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(marksCss());
    sheetCache = sheet;
  } catch {
    return null;
  }
  return sheetCache;
}

function adoptInto(node: Node): void {
  const root = node.getRootNode() as (ShadowRoot | Document) & { adoptedStyleSheets?: CSSStyleSheet[] };
  if (!root || !('adoptedStyleSheets' in root) || !Array.isArray(root.adoptedStyleSheets)) return;
  const sheet = marksSheet();
  if (!sheet || root.adoptedStyleSheets.includes(sheet)) return;
  try {
    root.adoptedStyleSheets = [...root.adoptedStyleSheets, sheet];
  } catch {
    // Sheet from another realm — the host adopts it instead.
  }
}

const px = (v: number) => `${v}px`;

// ── Mark state owner ────────────────────────────────────────────────────────

export interface MarksApi {
  marks: readonly Mark[];
  /** Appends a mark and renumbers. */
  add(mark: Mark): void;
  /** Deletes a mark and renumbers the rest. */
  remove(id: string): void;
  /** Undo: removes the last mark (of any kind). */
  undo(): void;
  /** Replaces one mark's fields (e.g. a comment); numbering is kept. */
  update(id: string, patch: Partial<Mark>): void;
  clear(): void;
}

/** Owns mark geometry; mirrors add/remove/undo into the machine when given its dispatch. */
export function useMarks(dispatch?: (e: Event) => void): MarksApi {
  const [marks, setMarks] = useState<readonly Mark[]>([]);
  const live = useRef(marks);
  live.current = marks;
  const set = (next: readonly Mark[]) => {
    live.current = next;
    setMarks(next);
  };
  const add = useCallback(
    (mark: Mark) => {
      set(number([...live.current, mark]));
      dispatch?.({ type: 'addMark', id: mark.id });
    },
    [dispatch],
  );
  const remove = useCallback(
    (id: string) => {
      if (!live.current.some((m) => m.id === id)) return;
      set(number(live.current.filter((m) => m.id !== id)));
      dispatch?.({ type: 'removeMark', id });
    },
    [dispatch],
  );
  const undo = useCallback(() => {
    if (live.current.length === 0) return;
    set(number(live.current.slice(0, -1)));
    dispatch?.({ type: 'undoMark' });
  }, [dispatch]);
  const update = useCallback((id: string, patch: Partial<Mark>) => {
    set(live.current.map((m) => (m.id === id ? ({ ...m, ...patch, id: m.id, kind: m.kind } as Mark) : m)));
  }, []);
  const clear = useCallback(() => set([]), []);
  return { marks, add, remove, undo, update, clear };
}

// ── Rendering ───────────────────────────────────────────────────────────────

interface Hot {
  hot: (id: string) => boolean;
  onOpen?: (id: string) => void;
}

function openHandlers(id: string, h: Hot) {
  return {
    onPointerDown: (e: PointerEvent) => e.stopPropagation(),
    onClick: (e: MouseEvent) => {
      e.stopPropagation();
      h.onOpen?.(id);
    },
  };
}

function PinView({ m, h }: { m: PinMark; h: Hot }) {
  const b = pinBox(m.x, m.y);
  return (
    <button
      type="button"
      class="fw-mk-pin"
      data-mark-id={m.id}
      data-mark-kind="pin"
      data-hot={h.hot(m.id) ? 'true' : undefined}
      aria-label={`Pin ${m.n ?? ''}`.trim()}
      style={{
        left: px(b.x),
        top: px(b.y),
        background: m.color,
        color: textColorOn(m.color),
        boxShadow: h.hot(m.id) ? HIGHLIGHT_RING : MARK_SHADOW,
      }}
      {...openHandlers(m.id, h)}
    >
      {m.n}
    </button>
  );
}

function BoxView({ m, h }: { m: BoxMark | ElementMark; h: Hot }) {
  const badge = badgeBox(m.x, m.y);
  const fg = textColorOn(m.color);
  return (
    <>
      <div
        class={m.kind === 'element' ? 'fw-mk-box fw-mk-element' : 'fw-mk-box'}
        data-mark-id={m.id}
        data-mark-kind={m.kind}
        style={{
          left: px(m.x),
          top: px(m.y),
          width: px(m.w),
          height: px(m.h),
          borderColor: m.color,
          background: tint(m.color, 0.1),
        }}
      />
      {m.kind === 'element' && (
        <div class="fw-mk-sel" style={{ left: px(m.x + 16), top: px(m.y - 5), background: m.color, color: fg }}>
          {m.selector}
        </div>
      )}
      {m.n !== undefined && (
        <button
          type="button"
          class="fw-mk-badge"
          data-badge-for={m.id}
          data-hot={h.hot(m.id) ? 'true' : undefined}
          aria-label={m.kind === 'element' ? `Element ${m.n}` : `Box ${m.n}`}
          style={{
            left: px(badge.x),
            top: px(badge.y),
            background: m.color,
            color: fg,
            boxShadow: h.hot(m.id) ? HIGHLIGHT_RING : MARK_SHADOW,
          }}
          {...openHandlers(m.id, h)}
        >
          {m.n}
        </button>
      )}
    </>
  );
}

function ArrowView({ m }: { m: Pick<ArrowMark, 'x1' | 'y1' | 'x2' | 'y2' | 'color'> & { id?: string } }) {
  const shaft = arrowShaftPath(m);
  const head = arrowHead(m.x1, m.y1, m.x2, m.y2).path;
  return (
    <svg class="fw-mk-svg" width="1" height="1" data-mark-id={m.id} data-mark-kind="arrow" aria-hidden="true">
      <path class="fw-mk-under" d={shaft} />
      <path class="fw-mk-under-head" d={head} />
      <path class="fw-mk-line" d={shaft} style={{ stroke: m.color }} />
      <path class="fw-mk-head" d={head} style={{ fill: m.color, stroke: m.color }} />
    </svg>
  );
}

function DrawView({ points, color, id }: { points: readonly Point[]; color: MarkColor; id?: string }) {
  const d = drawPath(points);
  return (
    <svg class="fw-mk-svg" width="1" height="1" data-mark-id={id} data-mark-kind="draw" aria-hidden="true">
      <path class="fw-mk-under" d={d} />
      <path class="fw-mk-line" d={d} style={{ stroke: color }} />
    </svg>
  );
}

function TextView({ m }: { m: TextMark }) {
  return (
    <div
      class="fw-mk-text"
      data-mark-id={m.id}
      data-mark-kind="text"
      style={{ left: px(m.x), top: px(m.y - TEXT_CHIP_OFFSET_Y), background: m.color, color: textColorOn(m.color) }}
    >
      {m.text}
    </div>
  );
}

function MarkView({ m, h }: { m: Mark; h: Hot }) {
  switch (m.kind) {
    case 'pin':
      return <PinView m={m} h={h} />;
    case 'box':
    case 'element':
      return <BoxView m={m} h={h} />;
    case 'arrow':
      return <ArrowView m={m} />;
    case 'draw':
      return <DrawView points={m.points} color={m.color} id={m.id} />;
    case 'text':
      return <TextView m={m} />;
  }
}

// ── Component ───────────────────────────────────────────────────────────────

/** §5.5 comment popover hook-up: when given, the layer opens, renders and closes the popover. */
export interface PopoverHookup {
  /** Open (an id) or close (null) the popover; the owner stores it as `popoverId`. */
  onChange(id: string | null): void;
  onComment(id: string, value: string): void;
  onDelete(id: string): void;
  /** Skip the open after the next created mark (the first mark in flow `note`). */
  skipOpenOnCreate?: boolean;
  /** Capture-surface size; defaults to the window's inner size. */
  W?: number;
  H?: number;
}

export interface MarksLayerProps {
  marks: readonly Mark[];
  tool: Tool;
  color: MarkColor;
  /** Accept pointer input (annotate mode, no dialog). Default true. */
  enabled?: boolean;
  /** Open popover's mark id — its badge gets the highlight ring. */
  popoverId?: string | null;
  /** Mark whose panel row is hovered — its badge gets the highlight ring. */
  hoveredId?: string | null;
  /** A finished mark (already past its threshold). The owner appends + renumbers it. */
  onCreate(mark: Mark): void;
  /** A pin or number badge was clicked (re-opens its comment popover, §5.5). */
  onOpen?(id: string): void;
  /** Comment popover (§5.5); omit to leave opening/closing to the owner. */
  popover?: PopoverHookup;
  onTextEdit?(on: boolean): void;
  onDrawing?(on: boolean): void;
  /** Mark id factory; defaults to a per-page counter. */
  newId?(): string;
}

type Drag =
  | { kind: 'box' | 'arrow'; pointerId: number; color: MarkColor; x0: number; y0: number; x1: number; y1: number }
  | { kind: 'draw'; pointerId: number; color: MarkColor; points: Point[] };

interface TextEdit {
  x: number;
  y: number;
  color: MarkColor;
  value: string;
}

let idSeq = 0;
function defaultId(): string {
  idSeq += 1;
  return `m${Date.now().toString(36)}${idSeq.toString(36)}`;
}

export function MarksLayer(props: MarksLayerProps) {
  const { marks, enabled = true, popoverId = null, hoveredId = null } = props;
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [drag, setDragState] = useState<Drag | null>(null);
  const dragRef = useRef<Drag | null>(null);
  const [text, setTextState] = useState<TextEdit | null>(null);
  const textRef = useRef<TextEdit | null>(null);
  const live = useRef(props);
  live.current = props;

  const setDrag = (d: Drag | null) => {
    const was = dragRef.current !== null;
    dragRef.current = d;
    setDragState(d);
    if (was !== (d !== null)) live.current.onDrawing?.(d !== null);
  };
  const setText = (t: TextEdit | null) => {
    const was = textRef.current !== null;
    textRef.current = t;
    setTextState(t);
    if (was !== (t !== null)) live.current.onTextEdit?.(t !== null);
  };

  useLayoutEffect(() => {
    if (rootRef.current) adoptInto(rootRef.current);
  }, []);

  const textOpen = text !== null;
  useLayoutEffect(() => {
    if (textOpen) inputRef.current?.focus({ preventScroll: true });
  }, [textOpen]);

  const id = () => (live.current.newId ?? defaultId)();

  /** Appends a finished mark; numbered marks open their comment popover (§5.5). */
  const create = (mark: Mark) => {
    live.current.onCreate(mark);
    const pop = live.current.popover;
    if (pop && isCommentMark(mark) && !pop.skipOpenOnCreate) pop.onChange(mark.id);
  };

  const local = (e: { clientX: number; clientY: number }): Point => {
    const r = rootRef.current?.getBoundingClientRect();
    return { x: e.clientX - (r?.left ?? 0), y: e.clientY - (r?.top ?? 0) };
  };

  /** Enter / blur / a click elsewhere: commit the label; empty text is discarded. */
  const commitText = () => {
    const t = textRef.current;
    if (!t) return;
    setText(null);
    const value = t.value.trim();
    if (value) live.current.onCreate({ id: id(), kind: 'text', color: t.color, x: t.x, y: t.y, text: value });
  };
  const cancelText = () => {
    if (textRef.current) setText(null);
  };

  const onDown = (e: PointerEvent) => {
    if (e.button !== 0 || live.current.enabled === false) return;
    if (textRef.current) {
      commitText();
      return;
    }
    // §5.5: a click on the surface while the popover is open only closes it.
    if (live.current.popover && live.current.popoverId != null) {
      live.current.popover.onChange(null);
      return;
    }
    const p = local(e);
    const col = live.current.color;
    switch (live.current.tool) {
      case 'pin':
        create({ id: id(), kind: 'pin', color: col, x: p.x, y: p.y });
        return;
      case 'text':
        setText({ x: p.x, y: p.y, color: col, value: '' });
        return;
      case 'box':
      case 'arrow':
      case 'draw': {
        try {
          (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        } catch {
          // Synthetic pointer — moves still arrive while over the layer.
        }
        const k = live.current.tool;
        setDrag(
          k === 'draw'
            ? { kind: 'draw', pointerId: e.pointerId, color: col, points: [p] }
            : { kind: k as 'box' | 'arrow', pointerId: e.pointerId, color: col, x0: p.x, y0: p.y, x1: p.x, y1: p.y },
        );
        return;
      }
      case 'element':
        // The element picker owns this tool.
        return;
    }
  };

  const onMove = (e: PointerEvent) => {
    const d = dragRef.current;
    if (!d || e.pointerId !== d.pointerId) return;
    const p = local(e);
    if (d.kind === 'draw') {
      const points = sampleDrawPoint(d.points, p);
      if (points.length !== d.points.length) setDrag({ ...d, points });
    } else {
      setDrag({ ...d, x1: p.x, y1: p.y });
    }
  };

  const onUp = (e: PointerEvent) => {
    const d = dragRef.current;
    if (!d || e.pointerId !== d.pointerId) return;
    const el = e.currentTarget as HTMLElement;
    try {
      if (el.hasPointerCapture?.(e.pointerId)) el.releasePointerCapture(e.pointerId);
    } catch {
      // Already released.
    }
    setDrag(null);
    if (e.type === 'pointercancel') return;
    let mark: Mark | null = null;
    if (d.kind === 'draw') {
      if (drawCommits(d.points)) mark = { id: id(), kind: 'draw', color: d.color, points: d.points };
    } else if (d.kind === 'box') {
      const r = rectFromDrag(d.x0, d.y0, d.x1, d.y1);
      if (boxCommits(r.w, r.h)) mark = { id: id(), kind: 'box', color: d.color, ...r };
    } else if (arrowCommits(d.x0, d.y0, d.x1, d.y1)) {
      mark = { id: id(), kind: 'arrow', color: d.color, x1: d.x0, y1: d.y0, x2: d.x1, y2: d.y1 };
    }
    if (mark) create(mark);
  };

  const onTextKey = (e: KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      commitText();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      cancelText();
    }
  };

  const hot: Hot = {
    hot: (mid) => mid === popoverId || mid === hoveredId,
    onOpen: (mid) => {
      live.current.onOpen?.(mid);
      live.current.popover?.onChange(mid);
    },
  };
  const popMark = props.popover && popoverId != null ? marks.find((m) => m.id === popoverId) : undefined;

  return (
    <div ref={rootRef} class="fw-marks" data-part="marks">
      <div
        class={enabled ? 'fw-marks-hit' : 'fw-marks-hit fw-marks-off'}
        data-part="marks-hit"
        onPointerDown={enabled ? onDown : undefined}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
      />
      <div class="fw-marks-ink">
        {marks.map((m) => (
          <MarkView key={m.id} m={m} h={hot} />
        ))}
        {drag && <DragPreview d={drag} />}
      </div>
      {text && (
        <input
          ref={inputRef}
          class="fw-mk-input"
          data-part="text-input"
          type="text"
          placeholder="Type a label…"
          aria-label="Text label"
          value={text.value}
          style={{
            left: px(text.x),
            top: px(text.y - TEXT_INPUT_OFFSET_Y),
            borderColor: text.color,
            color: text.color,
          }}
          onInput={(e) => {
            const t = textRef.current;
            if (t) setText({ ...t, value: (e.currentTarget as HTMLInputElement).value });
          }}
          onKeyDown={onTextKey}
          onBlur={commitText}
          onPointerDown={(e) => e.stopPropagation()}
        />
      )}
      {props.popover && popMark && isCommentMark(popMark) && (
        <Popover
          mark={popMark}
          W={props.popover.W ?? window.innerWidth}
          H={props.popover.H ?? window.innerHeight}
          onComment={props.popover.onComment}
          onDelete={(mid) => {
            props.popover?.onDelete(mid);
            props.popover?.onChange(null);
          }}
          onClose={() => props.popover?.onChange(null)}
        />
      )}
    </div>
  );
}

function DragPreview({ d }: { d: Drag }) {
  if (d.kind === 'draw') return <DrawView points={d.points} color={d.color} id="preview" />;
  if (d.kind === 'arrow') {
    return <ArrowView m={{ id: 'preview', x1: d.x0, y1: d.y0, x2: d.x1, y2: d.y1, color: d.color }} />;
  }
  const r = rectFromDrag(d.x0, d.y0, d.x1, d.y1);
  return (
    <div
      class="fw-mk-box"
      data-mark-id="preview"
      data-mark-kind="box"
      style={{
        left: px(r.x),
        top: px(r.y),
        width: px(r.w),
        height: px(r.h),
        borderColor: d.color,
        background: tint(d.color, 0.1),
      }}
    />
  );
}
