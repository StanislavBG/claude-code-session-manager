// Flattened screenshot — handoff README §1 "Flatten marks into a second PNG (`annotated`) on a
// canvas at send time, using the same geometry as the on-screen rendering".
//
// flattenAnnotated() draws the raw screenshot, then every mark on top of it, onto a canvas the
// size of the screenshot. Mark coordinates are viewport CSS px, so the context is scaled by the
// capture's scale (devicePixelRatio at capture time). Every shape, colour, underlay, shadow and
// text box mirrors the CSS + SVG the on-screen marks layer (MarksLayer.tsx) renders, from the
// same marks.ts geometry — so a mark in the report image sits exactly where the user drew it.
//
// No DOM is touched: the canvas is never attached, so this runs under any host page's CSP.

import {
  BOX_HALO,
  MARK_SHADOW,
  TEXT_CHIP_SHADOW,
  arrowShaftPath,
  tint,
} from './MarksLayer';
import {
  type ArrowMark,
  type BoxMark,
  type DrawMark,
  type ElementMark,
  type Mark,
  type PinMark,
  type TextMark,
  BADGE_SIZE,
  PIN_SIZE,
  STROKE_WIDTH,
  TEXT_CHIP_OFFSET_Y,
  UNDERLAY_COLOR,
  UNDERLAY_WIDTH,
  arrowHead,
  badgeBox,
  drawPath,
  pinBox,
  textColorOn,
} from './marks';
import { fonts } from './tokens';

export interface FlattenOptions {
  /** Device px per CSS px of the screenshot (CaptureResult.scale). Default 1. */
  scale?: number;
}

type Ctx = CanvasRenderingContext2D;

// ── Geometry mirrored from marksCss() (MarksLayer.tsx) ──────────────────────

/** Pin: 2 px white border, radii 14 14 14 3 (tl tr br bl). */
const PIN_BORDER = 2;
const PIN_RADII = [14, 14, 14, 3] as const;
const PIN_FONT = `700 12px ${fonts.mono}`;
const PIN_LINE = 24;

const BADGE_BORDER = 2;
const BADGE_FONT = `700 11px ${fonts.mono}`;
const BADGE_LINE = 20;

const BOX_BORDER = 2.5;
const BOX_RADIUS = 5;
/** Chromium paints a dashed border with dashes ≈ 3 × its width. */
const ELEMENT_DASH = BOX_BORDER * 3;

/** Selector chip: left x+16, bottom y−5, padding 3 7, radius 5, 500 11px/1.3 mono. */
const SEL_DX = 16;
const SEL_DY = 5;
const SEL_PAD_X = 7;
const SEL_PAD_Y = 3;
const SEL_RADIUS = 5;
const SEL_FONT_SIZE = 11;
const SEL_FONT = `500 ${SEL_FONT_SIZE}px ${fonts.mono}`;
const SEL_LINE = SEL_FONT_SIZE * 1.3;

/** Text chip: max-width 300 (border-box), padding 4 10, radius 7, 600 15px/1.35 sans. */
const TEXT_MAX_WIDTH = 300;
const TEXT_PAD_X = 10;
const TEXT_PAD_Y = 4;
const TEXT_RADIUS = 7;
const TEXT_FONT_SIZE = 15;
const TEXT_FONT = `600 ${TEXT_FONT_SIZE}px ${fonts.sans}`;
const TEXT_LINE = TEXT_FONT_SIZE * 1.35;

/** `.fw-mk-under-head` stroke width and `.fw-mk-head` stroke width. */
const UNDER_HEAD_STROKE = 5;
const HEAD_STROKE = 1.5;

// ── CSS box-shadow → canvas ─────────────────────────────────────────────────

interface Shadow {
  x: number;
  y: number;
  blur: number;
  spread: number;
  color: string;
}

/** Parses a CSS box-shadow list (`ox oy [blur [spread]] color`, comma-separated). */
export function parseBoxShadow(css: string): Shadow[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of css) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      parts.push(cur);
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) parts.push(cur);
  return parts.map((p) => {
    const color = /(rgba?\([^)]*\)|#[0-9a-f]{3,8})/i.exec(p)?.[0] ?? 'rgba(0,0,0,1)';
    const nums = p
      .replace(color, '')
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map((v) => parseFloat(v));
    return { x: nums[0] ?? 0, y: nums[1] ?? 0, blur: nums[2] ?? 0, spread: nums[3] ?? 0, color };
  });
}

const MARK_SHADOWS = parseBoxShadow(MARK_SHADOW);
const BOX_HALOS = parseBoxShadow(BOX_HALO);
const TEXT_SHADOWS = parseBoxShadow(TEXT_CHIP_SHADOW);

type Radii = readonly [number, number, number, number];

/** Rounded-rect sub-path with per-corner radii (tl, tr, br, bl), clamped like CSS. */
function roundRectPath(ctx: Ctx | Path2D, x: number, y: number, w: number, h: number, r: Radii): void {
  const k = Math.min(1, w / Math.max(r[0] + r[1], 1e-9), w / Math.max(r[3] + r[2], 1e-9), h / Math.max(r[0] + r[3], 1e-9), h / Math.max(r[1] + r[2], 1e-9));
  const [tl, tr, br, bl] = r.map((v) => Math.max(0, v * k));
  ctx.moveTo(x + tl, y);
  ctx.lineTo(x + w - tr, y);
  ctx.arcTo(x + w, y, x + w, y + tr, tr);
  ctx.lineTo(x + w, y + h - br);
  ctx.arcTo(x + w, y + h, x + w - br, y + h, br);
  ctx.lineTo(x + bl, y + h);
  ctx.arcTo(x, y + h, x, y + h - bl, bl);
  ctx.lineTo(x, y + tl);
  ctx.arcTo(x, y, x + tl, y, tl);
  ctx.closePath();
}

const grow = (r: Radii, d: number): Radii => r.map((v) => Math.max(0, v + d)) as unknown as Radii;
const uniform = (v: number): Radii => [v, v, v, v];

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
  r: Radii;
}

/**
 * Paints CSS outer box-shadows for `box`, bottom layer first (CSS lists the top one first).
 * Shadows are only visible outside the box; callers paint the (opaque or haloed) box over them.
 */
function paintShadows(ctx: Ctx, box: Box, shadows: readonly Shadow[], scale: number, clipInside: boolean): void {
  for (const s of [...shadows].reverse()) {
    ctx.save();
    if (clipInside) {
      // Cut the box itself out so a translucent box shows no shadow through it.
      const clip = new Path2D();
      clip.rect(-1e5, -1e5, 2e5, 2e5);
      roundRectPath(clip, box.x, box.y, box.w, box.h, box.r);
      ctx.clip(clip, 'evenodd');
    }
    const sx = box.x - s.spread;
    const sy = box.y - s.spread;
    const sw = box.w + 2 * s.spread;
    const sh = box.h + 2 * s.spread;
    const sr = grow(box.r, s.spread);
    ctx.beginPath();
    if (s.blur === 0) {
      roundRectPath(ctx, sx + s.x, sy + s.y, sw, sh, sr);
      ctx.fillStyle = s.color;
      ctx.fill();
    } else {
      // Canvas shadow settings live in device px, untouched by the transform.
      // Draw the shape far off-canvas and throw only its shadow back into place.
      const OFF = 1e4;
      roundRectPath(ctx, sx - OFF, sy, sw, sh, sr);
      ctx.shadowColor = s.color;
      ctx.shadowBlur = s.blur * scale;
      ctx.shadowOffsetX = (s.x + OFF) * scale;
      ctx.shadowOffsetY = s.y * scale;
      ctx.fillStyle = '#000';
      ctx.fill();
    }
    ctx.restore();
  }
}

/** Fills a CSS box with `border` px of `borderColor` and a `fill` padding box. */
function paintBorderBox(ctx: Ctx, box: Box, border: number, borderColor: string, fill: string): void {
  ctx.beginPath();
  roundRectPath(ctx, box.x, box.y, box.w, box.h, box.r);
  ctx.fillStyle = borderColor;
  ctx.fill();
  ctx.beginPath();
  roundRectPath(ctx, box.x + border, box.y + border, box.w - 2 * border, box.h - 2 * border, grow(box.r, -border));
  ctx.fillStyle = fill;
  ctx.fill();
}

/**
 * Alphabetic baseline of a single text line laid out in a CSS line box starting at `top`:
 * the font's content area is centred in the line box (half-leading on both sides).
 */
function baselineIn(ctx: Ctx, top: number, lineHeight: number, sample = 'Hg'): number {
  const m = ctx.measureText(sample);
  const asc = m.fontBoundingBoxAscent ?? m.actualBoundingBoxAscent;
  const desc = m.fontBoundingBoxDescent ?? m.actualBoundingBoxDescent;
  return top + (lineHeight - (asc + desc)) / 2 + asc;
}

function centredLabel(ctx: Ctx, text: string, font: string, color: string, cx: number, top: number, line: number): void {
  ctx.font = font;
  ctx.fillStyle = color;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(text, cx, baselineIn(ctx, top, line));
}

// ── Marks ───────────────────────────────────────────────────────────────────

function drawPin(ctx: Ctx, m: PinMark, scale: number): void {
  const b = pinBox(m.x, m.y);
  const box: Box = { ...b, r: PIN_RADII };
  paintShadows(ctx, box, MARK_SHADOWS, scale, false);
  paintBorderBox(ctx, box, PIN_BORDER, '#fff', m.color);
  if (m.n !== undefined) {
    centredLabel(ctx, String(m.n), PIN_FONT, textColorOn(m.color), b.x + PIN_SIZE / 2, b.y + PIN_BORDER, PIN_LINE);
  }
}

function drawBadge(ctx: Ctx, m: BoxMark | ElementMark, scale: number): void {
  if (m.n === undefined) return;
  const b = badgeBox(m.x, m.y);
  const box: Box = { ...b, r: uniform(BADGE_SIZE / 2) };
  paintShadows(ctx, box, MARK_SHADOWS, scale, false);
  paintBorderBox(ctx, box, BADGE_BORDER, '#fff', m.color);
  centredLabel(ctx, String(m.n), BADGE_FONT, textColorOn(m.color), b.x + BADGE_SIZE / 2, b.y + BADGE_BORDER, BADGE_LINE);
}

function drawBox(ctx: Ctx, m: BoxMark | ElementMark, scale: number): void {
  const box: Box = { x: m.x, y: m.y, w: m.w, h: m.h, r: uniform(BOX_RADIUS) };
  // 1 px white halo outside the border box, then the 10 % tint (background-clip: border-box).
  paintShadows(ctx, box, BOX_HALOS, scale, true);
  ctx.beginPath();
  roundRectPath(ctx, box.x, box.y, box.w, box.h, box.r);
  ctx.fillStyle = tint(m.color, 0.1);
  ctx.fill();
  if (m.kind === 'element') {
    // Dashed border: stroke along the border's centre line.
    const h = BOX_BORDER / 2;
    ctx.save();
    ctx.beginPath();
    roundRectPath(ctx, box.x + h, box.y + h, box.w - BOX_BORDER, box.h - BOX_BORDER, grow(box.r, -h));
    ctx.setLineDash([ELEMENT_DASH, ELEMENT_DASH]);
    ctx.lineWidth = BOX_BORDER;
    ctx.strokeStyle = m.color;
    ctx.stroke();
    ctx.restore();
  } else {
    const ring = new Path2D();
    roundRectPath(ring, box.x, box.y, box.w, box.h, box.r);
    roundRectPath(ring, box.x + BOX_BORDER, box.y + BOX_BORDER, box.w - 2 * BOX_BORDER, box.h - 2 * BOX_BORDER, grow(box.r, -BOX_BORDER));
    ctx.fillStyle = m.color;
    ctx.fill(ring, 'evenodd');
  }
  if (m.kind === 'element') drawSelectorChip(ctx, m);
  drawBadge(ctx, m, scale);
}

function drawSelectorChip(ctx: Ctx, m: ElementMark): void {
  ctx.font = SEL_FONT;
  const w = ctx.measureText(m.selector).width + 2 * SEL_PAD_X;
  const h = SEL_LINE + 2 * SEL_PAD_Y;
  const x = m.x + SEL_DX;
  const y = m.y - SEL_DY - h; // translateY(-100%)
  ctx.beginPath();
  roundRectPath(ctx, x, y, w, h, uniform(SEL_RADIUS));
  ctx.fillStyle = m.color;
  ctx.fill();
  ctx.fillStyle = textColorOn(m.color);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(m.selector, x + SEL_PAD_X, baselineIn(ctx, y + SEL_PAD_Y, SEL_LINE));
}

function strokeUnderlaid(ctx: Ctx, path: Path2D, color: string): void {
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.lineWidth = UNDERLAY_WIDTH;
  ctx.strokeStyle = UNDERLAY_COLOR;
  ctx.stroke(path);
  ctx.lineWidth = STROKE_WIDTH;
  ctx.strokeStyle = color;
  ctx.stroke(path);
}

function drawArrow(ctx: Ctx, m: ArrowMark): void {
  const shaft = new Path2D(arrowShaftPath(m));
  const head = new Path2D(arrowHead(m.x1, m.y1, m.x2, m.y2).path);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  // Same paint order as the SVG: shaft underlay, head underlay, shaft, head.
  ctx.lineWidth = UNDERLAY_WIDTH;
  ctx.strokeStyle = UNDERLAY_COLOR;
  ctx.stroke(shaft);
  ctx.fillStyle = UNDERLAY_COLOR;
  ctx.fill(head);
  ctx.lineCap = 'butt';
  ctx.lineWidth = UNDER_HEAD_STROKE;
  ctx.stroke(head);
  ctx.lineCap = 'round';
  ctx.lineWidth = STROKE_WIDTH;
  ctx.strokeStyle = m.color;
  ctx.stroke(shaft);
  ctx.fillStyle = m.color;
  ctx.fill(head);
  ctx.lineCap = 'butt';
  ctx.lineWidth = HEAD_STROKE;
  ctx.stroke(head);
}

function drawStroke(ctx: Ctx, m: DrawMark): void {
  strokeUnderlaid(ctx, new Path2D(drawPath(m.points)), m.color);
}

/** pre-wrap + overflow-wrap:anywhere line breaking inside `max` px. */
export function wrapText(measure: (s: string) => number, text: string, max: number): string[] {
  const out: string[] = [];
  for (const para of text.split('\n')) {
    let line = '';
    for (const word of para.split(/(?<= )/)) {
      if (measure(line + word.trimEnd()) <= max) {
        line += word;
        continue;
      }
      if (line) {
        out.push(line);
        line = '';
      }
      // A word wider than the box breaks anywhere.
      for (const ch of word) {
        if (line && measure(line + ch) > max && ch !== ' ') {
          out.push(line);
          line = '';
        }
        line += ch;
      }
    }
    out.push(line);
  }
  return out;
}

function drawText(ctx: Ctx, m: TextMark, scale: number): void {
  ctx.font = TEXT_FONT;
  const maxContent = TEXT_MAX_WIDTH - 2 * TEXT_PAD_X;
  const measure = (s: string) => ctx.measureText(s).width;
  const lines = wrapText(measure, m.text, maxContent);
  const contentW = Math.min(maxContent, Math.max(...lines.map((l) => measure(l.trimEnd()))));
  const box: Box = {
    x: m.x,
    y: m.y - TEXT_CHIP_OFFSET_Y,
    w: contentW + 2 * TEXT_PAD_X,
    h: lines.length * TEXT_LINE + 2 * TEXT_PAD_Y,
    r: uniform(TEXT_RADIUS),
  };
  paintShadows(ctx, box, TEXT_SHADOWS, scale, false);
  ctx.beginPath();
  roundRectPath(ctx, box.x, box.y, box.w, box.h, box.r);
  ctx.fillStyle = m.color;
  ctx.fill();
  ctx.font = TEXT_FONT;
  ctx.fillStyle = textColorOn(m.color);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  lines.forEach((line, i) => {
    const top = box.y + TEXT_PAD_Y + i * TEXT_LINE;
    ctx.fillText(line, box.x + TEXT_PAD_X, baselineIn(ctx, top, TEXT_LINE));
  });
}

/** Draws one mark in CSS px onto a context already scaled to the screenshot. */
export function drawMark(ctx: Ctx, m: Mark, scale = 1): void {
  ctx.save();
  switch (m.kind) {
    case 'pin':
      drawPin(ctx, m, scale);
      break;
    case 'box':
    case 'element':
      drawBox(ctx, m, scale);
      break;
    case 'arrow':
      drawArrow(ctx, m);
      break;
    case 'draw':
      drawStroke(ctx, m);
      break;
    case 'text':
      drawText(ctx, m, scale);
      break;
  }
  ctx.restore();
}

// ── Entry point ─────────────────────────────────────────────────────────────

async function decode(png: Blob): Promise<CanvasImageSource & { width: number; height: number }> {
  if (typeof createImageBitmap === 'function') return createImageBitmap(png);
  const url = URL.createObjectURL(png);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return img;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function toPng(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('canvas.toBlob returned null'))), 'image/png');
  });
}

/**
 * The report's `annotated` PNG: the screenshot (at its own pixel size) with every mark drawn
 * in, in array order (= the on-screen stacking order).
 */
export async function flattenAnnotated(
  screenshotPng: Blob,
  marks: readonly Mark[],
  options: FlattenOptions = {},
): Promise<Blob> {
  const scale = options.scale && options.scale > 0 ? options.scale : 1;
  const image = await decode(screenshotPng);
  const canvas = document.createElement('canvas');
  canvas.width = image.width;
  canvas.height = image.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2d canvas context unavailable');
  ctx.drawImage(image, 0, 0);
  if ('close' in image && typeof image.close === 'function') image.close();
  // Text must use the same faces as the on-screen marks.
  if (typeof document !== 'undefined' && document.fonts?.ready) await document.fonts.ready;
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  for (const m of marks) drawMark(ctx, m, scale);
  return toPng(canvas);
}
