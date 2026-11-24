// Viewport screenshot for the feedback widget (design-mocks/feedback-widget/README.md
// §"Screenshot capture"). Runs on open, BEFORE any widget UI is visible:
//   - rasterises the visible viewport (innerWidth × innerHeight at the current scroll
//     position) with modern-screenshot — never getDisplayMedia (it prompts);
//   - collects extra font CSS first, then hides the widget host only while rasterising;
//   - paints input[type=password] and [data-feedback-mask] as solid #1a1612 boxes;
//   - never rejects: a failure or timeout yields a same-size #ede6d6 placeholder + `error`.
//
// Strict-CSP rule (host.ts): only CSSOM property writes, never a style attribute string.

import { domToCanvas } from 'modern-screenshot';
import { HOST_ID } from './host';
import { normalizeFamily, splitFamilyList } from './fontCss';
import { TIMED_OUT, beforeDeadline } from './fontFetch';
import { apiFontCss } from './fontProbe';
import { coveredFamilies, declaredFontUrls, sheetFontCss } from './fontSheets';

export const MASK_COLOR = '#1a1612';
export const PLACEHOLDER_COLOR = '#ede6d6';
export const CAPTURE_TIMEOUT_MS = 8000;
export const MASK_SELECTOR = 'input[type=password], [data-feedback-mask]';
const MAX_ERROR_CHARS = 200;
/** Font-embedding step's budget inside CAPTURE_TIMEOUT_MS (leaves 5 s for modern-screenshot). */
export const FONT_BUDGET_MS = 3000;
const SVG_NS = 'http://www.w3.org/2000/svg';

export interface CaptureOptions {
  /** The widget's host element; hidden while rasterising. Defaults to #feedback-widget-host. */
  hostEl?: HTMLElement | null;
  /** Overall budget for the rasteriser; defaults to 8 s. */
  timeoutMs?: number;
}

export interface CaptureResult {
  png: Blob;
  width: number;
  height: number;
  scale: number;
  error?: string;
}

function errorText(err: unknown): string {
  const raw = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  return raw.length > MAX_ERROR_CHARS ? `${raw.slice(0, MAX_ERROR_CHARS - 1)}…` : raw;
}

function makeCanvas(width: number, height: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = width;
  c.height = height;
  return c;
}

function toPng(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    try {
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('canvas.toBlob returned null'))), 'image/png');
    } catch (err) {
      reject(err);
    }
  });
}

async function placeholder(width: number, height: number): Promise<Blob> {
  try {
    const c = makeCanvas(width, height);
    const ctx = c.getContext('2d');
    if (ctx) {
      ctx.fillStyle = PLACEHOLDER_COLOR;
      ctx.fillRect(0, 0, width, height);
    }
    return await toPng(c);
  } catch {
    // Last resort — the open must still proceed.
    return new Blob([], { type: 'image/png' });
  }
}

/** Mask rectangles in CSS px, viewport-relative, measured from the live DOM. */
function maskRects(hostEl: HTMLElement | null): DOMRect[] {
  const out: DOMRect[] = [];
  document.querySelectorAll(MASK_SELECTOR).forEach((el) => {
    if (hostEl && hostEl.contains(el)) return;
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) out.push(r);
  });
  return out;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`capture timed out after ${ms} ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

/**
 * Normalised families the page draws with: the computed font-family of the parent of every
 * non-whitespace text node under `root`, plus every input, textarea, select and button.
 * Anything inside `hostEl` is skipped. Generic families are dropped (splitFamilyList).
 */
export function usedFamilies(root: Element, hostEl: HTMLElement | null): Set<string> {
  const out = new Set<string>();
  const seen = new Set<Element>();
  const add = (el: Element | null) => {
    if (!el || seen.has(el)) return;
    seen.add(el);
    if (hostEl && hostEl.contains(el)) return;
    try {
      const value = el.ownerDocument.defaultView?.getComputedStyle(el).fontFamily ?? '';
      for (const f of splitFamilyList(value)) out.add(f);
    } catch {
      // detached or exotic node — skip it
    }
  };
  try {
    const doc = root.ownerDocument;
    const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (!n.nodeValue || !n.nodeValue.trim()) continue;
      add(n.parentElement);
    }
    root.querySelectorAll('input, textarea, select, button').forEach((el) => add(el));
  } catch {
    // never throw from capture
  }
  return out;
}

/** Families with at least one face in document.fonts (normalised). */
function fontSetFamilies(): Set<string> {
  const out = new Set<string>();
  try {
    document.fonts?.forEach((f) => {
      try {
        out.add(normalizeFamily(f.family));
      } catch {
        // broken face — skip
      }
    });
  } catch {
    // no FontFaceSet
  }
  return out;
}

const warnedFontSets = new Set<string>();

/** Test hook: forget which missing-font sets were already warned about. */
export function resetFontWarningsForTests(): void {
  warnedFontSets.clear();
}

function warnMissing(missing: string[]): void {
  if (!missing.length) return;
  const key = missing.join(', ');
  if (warnedFontSets.has(key)) return;
  warnedFontSets.add(key);
  try {
    // console.warn, never console.error: the widget's buffers record errors into reports.
    console.warn(
      `[feedback-widget] screenshot fonts not embedded: ${key}. Declare them with @font-face in a stylesheet the page can read.`,
    );
  } catch {
    // console unavailable
  }
}

/**
 * @font-face CSS for the families the page uses that no readable stylesheet declares
 * (modern-screenshot cannot see them): sheetFontCss first, then apiFontCss for the rest.
 * `missing` = families still unresolved, sorted. Never rejects; resolves within `budgetMs`.
 */
export async function extraFontCss(
  hostEl: HTMLElement | null,
  budgetMs: number = FONT_BUDGET_MS,
): Promise<{ cssText: string; missing: string[] }> {
  const deadline = Date.now() + Math.max(0, budgetMs);
  const parts: string[] = [];
  let left = new Set<string>();
  try {
    const covered = coveredFamilies();
    const inFontSet = fontSetFamilies();
    for (const f of usedFamilies(document.documentElement, hostEl)) {
      if (!covered.has(f) && inFontSet.has(f)) left.add(f);
    }
    if (!left.size) return { cssText: '', missing: [] };

    const exclude = new Set<string>();
    try {
      for (const u of declaredFontUrls()) exclude.add(u);
    } catch {
      // unreadable sheets — nothing to exclude
    }

    const sheet = await beforeDeadline(Promise.resolve().then(() => sheetFontCss(new Set(left))), deadline);
    if (sheet !== TIMED_OUT) {
      if (sheet.cssText) parts.push(sheet.cssText);
      left = new Set([...left].filter((f) => !sheet.families.has(f)));
      for (const u of sheet.urls) exclude.add(u);
    }

    const remaining = deadline - Date.now();
    if (left.size && remaining > 0) {
      const api = await beforeDeadline(
        Promise.resolve().then(() => apiFontCss(new Set(left), { exclude, budgetMs: remaining })),
        deadline,
      );
      if (api !== TIMED_OUT) {
        if (api.cssText) parts.push(api.cssText);
        left = new Set([...left].filter((f) => !api.families.has(f)));
      }
    }
  } catch {
    // fall through with what we have
  }
  const missing = [...left].sort();
  warnMissing(missing);
  return { cssText: parts.join('\n'), missing };
}

async function rasterise(
  vw: number,
  vh: number,
  scale: number,
  hostEl: HTMLElement | null,
  fontCss: string,
): Promise<HTMLCanvasElement> {
  // Read after the font step, so a scroll during it is not lost.
  const sx = window.scrollX;
  const sy = window.scrollY;
  const root = document.documentElement;
  // Size the clone to the viewport and shift it by the scroll offset, so the SVG
  // foreignObject window shows exactly what is on screen.
  const raw = await domToCanvas(root, {
    width: vw,
    height: vh,
    scale,
    style: { transform: `translate(${-sx}px, ${-sy}px)`, transformOrigin: '0 0' },
    filter: (node) => node !== hostEl,
    onCloneEachNode: (cloned) => {
      // The translated root becomes the containing block for fixed elements; move them
      // back so they sit where the viewport shows them.
      if ((sx || sy) && cloned instanceof HTMLElement && cloned.style.position === 'fixed') {
        cloned.style.translate = `${sx}px ${sy}px`;
      }
    },
    // Fonts modern-screenshot cannot read go into the serialized SVG — never the page DOM.
    ...(fontCss
      ? {
          onCreateForeignObjectSvg: (svg: SVGSVGElement) => {
            const style = svg.ownerDocument.createElementNS(SVG_NS, 'style');
            style.appendChild(svg.ownerDocument.createTextNode(fontCss));
            svg.insertBefore(style, svg.firstChild);
          },
        }
      : {}),
  });
  return raw;
}

/**
 * Rasterise the visible viewport to a PNG. Never rejects.
 * width/height = round(innerWidth × scale) × round(innerHeight × scale), scale = min(dpr, 2).
 */
export async function captureViewport(opts: CaptureOptions = {}): Promise<CaptureResult> {
  const scale = Math.min(window.devicePixelRatio || 1, 2);
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const width = Math.round(vw * scale);
  const height = Math.round(vh * scale);
  const hostEl = opts.hostEl ?? document.getElementById(HOST_ID);
  const timeoutMs = opts.timeoutMs ?? CAPTURE_TIMEOUT_MS;

  const prevDisplay = hostEl ? hostEl.style.getPropertyValue('display') : '';
  const prevPriority = hostEl ? hostEl.style.getPropertyPriority('display') : '';
  // One budget for the whole call: font step (widget still visible) then rasterise (widget
  // hidden only for this step). A late font step after a timeout never hides the host.
  let timedOut = false;
  const work = async (): Promise<{ raw: HTMLCanvasElement; masks: DOMRect[] }> => {
    const { cssText } = await extraFontCss(hostEl);
    if (timedOut) throw new Error('capture timed out');
    if (hostEl) hostEl.style.setProperty('display', 'none', 'important');
    const masks = maskRects(hostEl);
    const raw = await rasterise(vw, vh, scale, hostEl, cssText);
    return { raw, masks };
  };
  try {
    const { raw, masks } = await withTimeout(work(), timeoutMs).catch((err: unknown) => {
      timedOut = true;
      throw err;
    });

    const out = makeCanvas(width, height);
    const ctx = out.getContext('2d');
    if (!ctx) throw new Error('2d canvas context unavailable');
    ctx.drawImage(raw, 0, 0, width, height);
    ctx.fillStyle = MASK_COLOR;
    for (const r of masks) {
      const x = Math.floor(r.left * scale);
      const y = Math.floor(r.top * scale);
      ctx.fillRect(x, y, Math.ceil(r.right * scale) - x, Math.ceil(r.bottom * scale) - y);
    }
    const png = await toPng(out);
    return { png, width, height, scale };
  } catch (err) {
    return { png: await placeholder(width, height), width, height, scale, error: errorText(err) };
  } finally {
    if (hostEl) {
      if (prevDisplay) hostEl.style.setProperty('display', prevDisplay, prevPriority);
      else hostEl.style.removeProperty('display');
    }
  }
}
