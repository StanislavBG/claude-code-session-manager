// Font-file discovery + matching for faces registered through the FontFace API
// (document.fonts.add(new FontFace(...))). A FontFace never exposes its source, so the
// widget lists the font files the page fetched (Resource Timing) and matches each loaded
// face to a file by comparing glyph advance widths against a probe face built from it.
//
// No DOM access at import time. Strict-CSP rule (host.ts): no style attribute strings;
// this module only draws on an off-DOM canvas.

import {
  bytesToDataUrl,
  fontFaceRule,
  isFontBytes,
  isFontUrl,
  normalizeFamily,
  parseUnicodeRange,
  sampleCodePoints,
} from './fontCss';
import { TIMED_OUT, beforeDeadline, fetchBytesCached } from './fontFetch';

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

export type FetchBytes = (url: string) => Promise<ArrayBuffer | null>;

export interface ApiFontCssOptions {
  /** Candidate URLs never fetched (already embedded from a stylesheet). */
  exclude?: Set<string>;
  /** Wall-clock budget for the whole call (default 3000 ms). */
  budgetMs?: number;
  fetchBytes?: FetchBytes;
  measure?: Measure;
  doc?: Document;
}

const DEFAULT_BUDGET_MS = 3000;
const PROBE_PREFIX = '__smfw_probe_';

/** fetch() a font file (cors, same-origin credentials, 3 s timeout, cached on success); null on any failure. */
function defaultFetchBytes(url: string): Promise<ArrayBuffer | null> {
  return fetchBytesCached(url, 'same-origin');
}

type FaceCacheEntry = { dataUrl: string } | { missAtUrlCount: number };

/** Per page FontFace: its matched data URL, or a miss and how many font URLs were known then. */
const faceCache = new WeakMap<FontFace, FaceCacheEntry>();
let probeSeq = 0;

/** The family as the page wrote it, minus one pair of matching quotes (case kept). */
function displayFamily(name: string): string {
  const s = String(name ?? '').trim();
  if (s.length >= 2 && (s[0] === '"' || s[0] === "'") && s[s.length - 1] === s[0]) return s.slice(1, -1);
  return s;
}

function faceInfo(face: FontFace): FaceInfo {
  return {
    family: displayFamily(face.family),
    weight: String(face.weight ?? 'normal'),
    style: String(face.style ?? 'normal'),
    stretch: String(face.stretch ?? 'normal'),
    unicodeRange: String(face.unicodeRange ?? ''),
  };
}

function safeFontBytes(buf: unknown): ArrayBuffer | null {
  try {
    if (!buf || typeof (buf as ArrayBuffer).byteLength !== 'number') return null;
    return isFontBytes(buf as ArrayBuffer) ? (buf as ArrayBuffer) : null;
  } catch {
    return null;
  }
}

/**
 * @font-face CSS (data URL sources) for the page's loaded FontFace-API faces of `families`
 * (normalised names). Fetches the page's font files (Resource Timing, minus `exclude`),
 * registers each as a temporary `__smfw_probe_<n>` face, matches faces to files by glyph
 * widths (matchFaces), and always removes every probe. Respects `budgetMs` (returns what
 * matched so far) and never rejects. Writes nothing to the live page but the probes.
 */
export async function apiFontCss(
  families: Set<string>,
  opts: ApiFontCssOptions = {},
): Promise<{ cssText: string; families: Set<string> }> {
  const rules: string[] = [];
  const matchedFamilies = new Set<string>();
  const probes: FontFace[] = [];
  let doc: Document | undefined;
  const emit = (face: FontFace, dataUrl: string) => {
    const info = faceInfo(face);
    rules.push(
      fontFaceRule(
        {
          family: info.family,
          weight: info.weight,
          style: info.style,
          stretch: info.stretch,
          unicodeRange: info.unicodeRange,
          featureSettings: face.featureSettings,
        },
        dataUrl,
      ),
    );
    matchedFamilies.add(normalizeFamily(info.family));
  };
  const result = () => ({ cssText: rules.join('\n'), families: matchedFamilies });

  try {
    const deadline = Date.now() + Math.max(0, opts.budgetMs ?? DEFAULT_BUDGET_MS);
    if (!families || families.size === 0) return result();
    doc = opts.doc ?? (typeof document !== 'undefined' ? document : undefined);
    const fontSet = doc?.fonts;
    if (!fontSet) return result();

    const faces: FontFace[] = [];
    fontSet.forEach((f) => {
      try {
        if (f.status === 'loaded' && families.has(normalizeFamily(f.family))) faces.push(f);
      } catch {
        // a broken face object — skip it
      }
    });
    if (!faces.length) return result();

    const urls = fontResourceUrls();
    const pending: FontFace[] = [];
    for (const f of faces) {
      const cached = faceCache.get(f);
      if (cached && 'dataUrl' in cached) emit(f, cached.dataUrl);
      else if (cached && cached.missAtUrlCount >= urls.length) continue;
      else pending.push(f);
    }
    if (!pending.length) return result();

    const exclude = opts.exclude ?? new Set<string>();
    const candidateUrls = urls.filter((u) => !exclude.has(u));
    const missAll = () => {
      for (const f of pending) faceCache.set(f, { missAtUrlCount: urls.length });
    };
    if (!candidateUrls.length) {
      missAll();
      return result();
    }

    const fetchBytes = opts.fetchBytes ?? defaultFetchBytes;
    const fetched = await beforeDeadline(
      Promise.all(
        candidateUrls.map(async (url) => {
          try {
            return safeFontBytes(await fetchBytes(url));
          } catch {
            return null;
          }
        }),
      ),
      deadline,
    );
    if (fetched === TIMED_OUT) return result();
    const files = candidateUrls
      .map((url, i) => ({ url, bytes: fetched[i] }))
      .filter((c): c is { url: string; bytes: ArrayBuffer } => c.bytes !== null);
    if (!files.length) {
      missAll();
      return result();
    }
    const bytesByUrl = new Map(files.map((c) => [c.url, c.bytes]));
    const measure = opts.measure ?? canvasMeasurer(doc);

    /** Builds, loads and registers one probe per file; null when the budget ran out. */
    const registerProbes = async (
      list: Array<{ url: string; bytes: ArrayBuffer }>,
      descriptors?: FontFaceDescriptors,
    ): Promise<Array<{ url: string; probeFamily: string }> | null> => {
      const built: Array<{ url: string; probeFamily: string; face: FontFace }> = [];
      for (const c of list) {
        const probeFamily = `${PROBE_PREFIX}${probeSeq++}`;
        try {
          built.push({ url: c.url, probeFamily, face: new FontFace(probeFamily, c.bytes, descriptors) });
        } catch {
          // invalid descriptors or bytes — skip this candidate
        }
      }
      const loaded = await beforeDeadline(
        Promise.all(built.map((b) => b.face.load().then(() => true, () => false))),
        deadline,
      );
      if (loaded === TIMED_OUT) return null;
      const ready: Array<{ url: string; probeFamily: string }> = [];
      built.forEach((b, i) => {
        if (!loaded[i]) return;
        try {
          fontSet.add(b.face);
          probes.push(b.face);
          ready.push({ url: b.url, probeFamily: b.probeFamily });
        } catch {
          // add refused — skip
        }
      });
      return ready;
    };

    const infos = new Map<FaceInfo, FontFace>();
    for (const f of pending) infos.set(faceInfo(f), f);
    // One file can back several faces (a variable font registered per weight): encode once.
    const dataUrlByUrl = new Map<string, string>();
    const record = (info: FaceInfo, url: string) => {
      const f = infos.get(info);
      const bytes = bytesByUrl.get(url);
      if (!f || !bytes) return;
      let dataUrl = dataUrlByUrl.get(url);
      if (dataUrl === undefined) {
        dataUrl = bytesToDataUrl(bytes);
        dataUrlByUrl.set(url, dataUrl);
      }
      faceCache.set(f, { dataUrl });
      emit(f, dataUrl);
    };

    // Pass 1: default probe descriptors.
    const firstProbes = await registerProbes(files);
    if (!firstProbes) return result();
    const first = matchFaces([...infos.keys()], firstProbes, measure);
    for (const [info, url] of first) record(info, url);
    if (Date.now() >= deadline) return result();

    // Pass 2 (variable fonts): unmatched faces vs every fetched file — a file pass 1 matched
    // may still back another face (one variable file, several weights). Probes copy the
    // face's weight, style and stretch so the file renders at the same axis position.
    const unmatched = [...infos.keys()].filter((info) => !first.has(info));
    const missed: FaceInfo[] = [];
    for (const info of unmatched) {
      if (Date.now() >= deadline) return result();
      const f = infos.get(info)!;
      const probesFor = await registerProbes(files, {
        weight: String(f.weight ?? 'normal'),
        style: String(f.style ?? 'normal'),
        stretch: String(f.stretch ?? 'normal'),
      });
      if (!probesFor) return result();
      const url = matchFaces([info], probesFor, measure).get(info);
      if (url) record(info, url);
      else missed.push(info);
    }
    for (const info of missed) {
      const f = infos.get(info);
      if (f) faceCache.set(f, { missAtUrlCount: urls.length });
    }
    return result();
  } catch {
    return result();
  } finally {
    for (const p of probes) {
      try {
        doc?.fonts?.delete(p);
      } catch {
        // already gone
      }
    }
  }
}
