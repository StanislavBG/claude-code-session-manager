// Mark model + shared geometry — handoff README §5.4 "Marks".
// The on-screen mark layer and the flattened PNG both draw from these functions, so a
// mark looks identical in the live overlay and in the image a report carries.
// Every coordinate is viewport CSS px at capture time.

import { colors } from './tokens';

/** The four mark colours (toolbar swatches, §5.3). Rust is the default. */
export const MARK_COLORS = {
  rust: colors.accent,
  amber: colors.amber,
  green: colors.green,
  ink: colors.ink,
} as const;

export type MarkColorName = keyof typeof MARK_COLORS;
export type MarkColor = (typeof MARK_COLORS)[MarkColorName];

export const DEFAULT_MARK_COLOR: MarkColor = MARK_COLORS.rust;

/** Text colour on a mark colour (§5.4). */
export function textColorOn(markColor: MarkColor): string {
  switch (markColor) {
    case MARK_COLORS.rust:
      return '#fff8ef';
    case MARK_COLORS.amber:
      return '#1a1612';
    case MARK_COLORS.green:
    case MARK_COLORS.ink:
      return '#f5f0e6';
  }
}

export interface Point {
  x: number;
  y: number;
}

interface MarkBase {
  id: string;
  color: MarkColor;
  /** Number badge 1…k; set by number() on pins, boxes and elements only. */
  n?: number;
}

/** Click point = the pin's tip (its bottom-left corner). */
export interface PinMark extends MarkBase {
  kind: 'pin';
  x: number;
  y: number;
  comment?: string;
}

export interface BoxMark extends MarkBase {
  kind: 'box';
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Rect = the element's getBoundingClientRect(). */
export interface ElementMark extends MarkBase {
  kind: 'element';
  x: number;
  y: number;
  w: number;
  h: number;
  selector: string;
}

export interface ArrowMark extends MarkBase {
  kind: 'arrow';
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface DrawMark extends MarkBase {
  kind: 'draw';
  points: Point[];
}

/** (x, y) = the click point; the rendered chip's top is y − 15. */
export interface TextMark extends MarkBase {
  kind: 'text';
  x: number;
  y: number;
  text: string;
}

export type Mark = PinMark | BoxMark | ElementMark | ArrowMark | DrawMark | TextMark;
export type MarkKind = Mark['kind'];

export const NUMBERED_KINDS: readonly MarkKind[] = ['pin', 'box', 'element'];

export function isNumbered(mark: Mark): boolean {
  return NUMBERED_KINDS.includes(mark.kind);
}

/**
 * Numbers pins, boxes and elements 1…k in array (= creation) order. Call it again after a
 * delete to renumber. Arrows, drawings and text get no number. Returns new objects.
 */
export function number(marks: readonly Mark[]): Mark[] {
  let n = 0;
  return marks.map((m) => {
    if (isNumbered(m)) return { ...m, n: ++n };
    const { n: _drop, ...rest } = m;
    void _drop;
    return rest as Mark;
  });
}

// --- Creation thresholds -------------------------------------------------------------

export const MIN_BOX = 8;
export const MIN_ARROW_LENGTH = 14;
export const MIN_DRAW_POINTS = 3;
export const DRAW_SAMPLE_DISTANCE = 2.5;

/** Normalises a drag (any direction) to a top-left rect. */
export function rectFromDrag(x1: number, y1: number, x2: number, y2: number) {
  return { x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1) };
}

/** A box commits only if it is at least 8×8. */
export function boxCommits(w: number, h: number): boolean {
  return Math.abs(w) >= MIN_BOX && Math.abs(h) >= MIN_BOX;
}

export function arrowLength(x1: number, y1: number, x2: number, y2: number): number {
  return Math.hypot(x2 - x1, y2 - y1);
}

/** An arrow commits only if its length is at least 14. */
export function arrowCommits(x1: number, y1: number, x2: number, y2: number): boolean {
  return arrowLength(x1, y1, x2, y2) >= MIN_ARROW_LENGTH;
}

/** A pointer move is sampled only when it is more than 2.5 px from the last sample. */
export function shouldSample(last: Point | undefined, next: Point): boolean {
  if (!last) return true;
  return Math.hypot(next.x - last.x, next.y - last.y) > DRAW_SAMPLE_DISTANCE;
}

/** Appends `next` to a stroke if shouldSample allows it; returns the (maybe new) array. */
export function sampleDrawPoint(points: readonly Point[], next: Point): Point[] {
  return shouldSample(points[points.length - 1], next) ? [...points, next] : [...points];
}

/** A drawing commits only with at least 3 points. */
export function drawCommits(points: readonly Point[]): boolean {
  return points.length >= MIN_DRAW_POINTS;
}

// --- Paths ---------------------------------------------------------------------------

/** Formats a coordinate for an SVG path: at most 2 decimals, no trailing zeros. */
function f(v: number): string {
  const r = Math.round(v * 100) / 100;
  return String(Object.is(r, -0) ? 0 : r);
}

/**
 * Quadratic-midpoint smoothing: M p0, then for each interior point a Q with the point as
 * control and the midpoint to the next point as end, then L to the last point.
 */
export function drawPath(points: readonly Point[]): string {
  if (points.length === 0) return '';
  const [p0] = points;
  if (points.length === 1) return `M${f(p0.x)} ${f(p0.y)}`;
  let d = `M${f(p0.x)} ${f(p0.y)}`;
  for (let i = 1; i < points.length - 1; i++) {
    const p = points[i];
    const q = points[i + 1];
    d += ` Q${f(p.x)} ${f(p.y)} ${f((p.x + q.x) / 2)} ${f((p.y + q.y) / 2)}`;
  }
  const last = points[points.length - 1];
  d += ` L${f(last.x)} ${f(last.y)}`;
  return d;
}

export const ARROW_HEAD_MAX = 18;
export const ARROW_HEAD_RATIO = 0.45;
export const ARROW_HEAD_HALF_WIDTH_RATIO = 0.62;

export interface ArrowHead {
  /** Head length: min(18, 0.45·L). */
  length: number;
  /** Half-width: 0.62 × head length. */
  halfWidth: number;
  /** Tip = (x2, y2). */
  tip: Point;
  /** Centre of the head's base — where the shaft should end. */
  base: Point;
  /** The two base corners of the filled triangle. */
  left: Point;
  right: Point;
  /** SVG path of the filled triangle. */
  path: string;
}

export function arrowHead(x1: number, y1: number, x2: number, y2: number): ArrowHead {
  const L = arrowLength(x1, y1, x2, y2);
  const length = Math.min(ARROW_HEAD_MAX, ARROW_HEAD_RATIO * L);
  const halfWidth = ARROW_HEAD_HALF_WIDTH_RATIO * length;
  const ux = L === 0 ? 0 : (x2 - x1) / L;
  const uy = L === 0 ? 0 : (y2 - y1) / L;
  const base = { x: x2 - ux * length, y: y2 - uy * length };
  // Perpendicular (-uy, ux).
  const left = { x: base.x - uy * halfWidth, y: base.y + ux * halfWidth };
  const right = { x: base.x + uy * halfWidth, y: base.y - ux * halfWidth };
  const tip = { x: x2, y: y2 };
  const path = `M${f(tip.x)} ${f(tip.y)} L${f(left.x)} ${f(left.y)} L${f(right.x)} ${f(right.y)} Z`;
  return { length, halfWidth, tip, base, left, right, path };
}

// --- Shared layout constants (§5.4) --------------------------------------------------

export const PIN_SIZE = 28;
/** Pin box top-left: the click point is the bottom-left tip. */
export function pinBox(x: number, y: number) {
  return { x, y: y - PIN_SIZE, w: PIN_SIZE, h: PIN_SIZE };
}

export const BADGE_SIZE = 24;
/** Box/element number badge: 24 px circle centred on the rect's top-left corner. */
export function badgeBox(x: number, y: number) {
  return { x: x - BADGE_SIZE / 2, y: y - BADGE_SIZE / 2, w: BADGE_SIZE, h: BADGE_SIZE };
}

export const STROKE_WIDTH = 4;
export const UNDERLAY_WIDTH = 8;
export const UNDERLAY_COLOR = 'rgba(255,255,255,.85)';
export const TEXT_CHIP_OFFSET_Y = 15;
