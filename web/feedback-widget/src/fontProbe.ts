// Font-file discovery + matching for faces registered through the FontFace API
// (document.fonts.add(new FontFace(...))). A FontFace never exposes its source, so the
// widget lists the font files the page fetched (Resource Timing) and matches each loaded
// face to a file by comparing glyph advance widths against a probe face built from it.
//
// No DOM access at import time. Strict-CSP rule (host.ts): no style attribute strings;
// this module only draws on an off-DOM canvas.

import { isFontUrl, parseUnicodeRange, sampleCodePoints } from './fontCss';

const seenFontUrls = new Set<string>();
let watching = false;

/** Starts (once) a buffered Resource Timing observer recording font URLs. Never throws. */
export function watchFontResources(): void {
  if (watching) return;
  try {
    if (typeof PerformanceObserver === 'undefined' || !PerformanceObserver) return;
    const observer = new PerformanceObserver((list) => {
      try {
        for (const entry of list.getEntries()) {
          if (isFontUrl(entry.name)) seenFontUrls.add(entry.name);
        }
      } catch {
        // never let an observer callback throw into the page
      }
    });
    observer.observe({ type: 'resource', buffered: true });
    watching = true;
  } catch {
    // unsupported entry type or a broken polyfill — discovery falls back to getEntriesByType
  }
}

/** Observed font URLs plus the current Resource Timing buffer's, deduplicated, first-seen order. */
export function fontResourceUrls(): string[] {
  const out = new Set<string>(seenFontUrls);
  try {
    if (typeof performance !== 'undefined' && typeof performance.getEntriesByType === 'function') {
      for (const entry of performance.getEntriesByType('resource')) {
        if (isFontUrl(entry.name)) out.add(entry.name);
      }
    }
  } catch {
    // buffer unavailable — the observed set alone
  }
  return [...out];
}

export type FaceInfo = {
  family: string;
  weight: string;
  style: string;
  stretch: string;
  unicodeRange: string;
};

export type Measure = (font: string, cp: number) => number | null;

const PROBE_PX = 64;
const TOLERANCE = 0.01;
const MIN_SAMPLES = 3;

function quoteFamily(name: string): string {
  return `"${name.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function firstToken(v: string | undefined, fallback: string): string {
  const t = String(v ?? '').trim().split(/\s+/)[0];
  return t || fallback;
}

/** 'oblique 10deg 20deg' → 'oblique 10deg' (the shorthand takes one angle). */
function styleValue(v: string | undefined): string {
  const parts = String(v ?? '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return 'normal';
  return parts.slice(0, 2).join(' ');
}

const STRETCH_KEYWORDS: Array<[number, string]> = [
  [50, 'ultra-condensed'],
  [62.5, 'extra-condensed'],
  [75, 'condensed'],
  [87.5, 'semi-condensed'],
  [100, 'normal'],
  [112.5, 'semi-expanded'],
  [125, 'expanded'],
  [150, 'extra-expanded'],
  [200, 'ultra-expanded'],
];

/** The font shorthand only takes stretch keywords: map a percentage to the nearest one. */
function stretchValue(v: string | undefined): string {
  const t = firstToken(v, 'normal');
  const m = /^(\d+(?:\.\d+)?)%$/.exec(t);
  if (!m) return t;
  const pct = parseFloat(m[1]);
  let best = STRETCH_KEYWORDS[0];
  for (const kw of STRETCH_KEYWORDS) {
    if (Math.abs(kw[0] - pct) < Math.abs(best[0] - pct)) best = kw;
  }
  return best[1];
}

function faceFont(face: FaceInfo): string {
  return `${styleValue(face.style)} ${firstToken(face.weight, 'normal')} ${stretchValue(face.stretch)} ${PROBE_PX}px ${quoteFamily(face.family)}`;
}

function probeFont(probeFamily: string): string {
  return `${PROBE_PX}px ${quoteFamily(probeFamily)}`;
}

function safeMeasure(measure: Measure, font: string, cp: number): number | null {
  try {
    const w = measure(font, cp);
    return typeof w === 'number' && Number.isFinite(w) ? w : null;
  } catch {
    return null;
  }
}

/**
 * Maps each face to the url of the first candidate whose probe face draws the face's sample
 * glyphs with identical advance widths (≥3 comparable samples, all within 0.01, no glyph
 * present on one side only). Unmatched faces are absent from the result.
 */
export function matchFaces(
  faces: FaceInfo[],
  candidates: Array<{ url: string; probeFamily: string }>,
  measure: Measure,
): Map<FaceInfo, string> {
  const out = new Map<FaceInfo, string>();
  const probeCache = new Map<string, Map<number, number | null>>();
  const probeWidth = (family: string, cp: number): number | null => {
    let row = probeCache.get(family);
    if (!row) probeCache.set(family, (row = new Map()));
    if (!row.has(cp)) row.set(cp, safeMeasure(measure, probeFont(family), cp));
    return row.get(cp) ?? null;
  };
  for (const face of faces) {
    const samples = sampleCodePoints(parseUnicodeRange(face.unicodeRange ?? ''));
    if (samples.length < MIN_SAMPLES) continue;
    const font = faceFont(face);
    const faceWidths = samples.map((cp) => safeMeasure(measure, font, cp));
    if (faceWidths.filter((w) => w !== null).length < MIN_SAMPLES) continue;
    for (const cand of candidates) {
      let comparable = 0;
      let ok = true;
      for (let i = 0; i < samples.length; i++) {
        const a = faceWidths[i];
        const b = probeWidth(cand.probeFamily, samples[i]);
        if (a === null && b === null) continue;
        if (a === null || b === null || Math.abs(a - b) > TOLERANCE) {
          ok = false;
          break;
        }
        comparable++;
      }
      if (ok && comparable >= MIN_SAMPLES) {
        out.set(face, cand.url);
        break;
      }
    }
  }
  return out;
}

/**
 * A Measure on a 2D canvas: the glyph is measured with the font followed by ', monospace'
 * and by ', serif'; differing widths mean it fell back (null), else the width.
 */
export function canvasMeasurer(doc: Document = document): Measure {
  let ctx: CanvasRenderingContext2D | null = null;
  try {
    ctx = doc.createElement('canvas').getContext('2d');
  } catch {
    ctx = null;
  }
  return (font, cp) => {
    if (!ctx) return null;
    try {
      const text = String.fromCodePoint(cp);
      ctx.font = `${font}, monospace`;
      const mono = ctx.measureText(text).width;
      ctx.font = `${font}, serif`;
      const serif = ctx.measureText(text).width;
      return mono === serif ? mono : null;
    } catch {
      return null;
    }
  };
}
