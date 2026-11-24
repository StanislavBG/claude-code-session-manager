// Viewport screenshot for the feedback widget (design-mocks/feedback-widget/README.md
// §"Screenshot capture"). Runs on open, BEFORE any widget UI is visible:
//   - rasterises the visible viewport (innerWidth × innerHeight at the current scroll
//     position) with modern-screenshot — never getDisplayMedia (it prompts);
//   - hides the widget host element for the duration and restores it after;
//   - paints input[type=password] and [data-feedback-mask] as solid #1a1612 boxes;
//   - never rejects: a failure or timeout yields a same-size #ede6d6 placeholder + `error`.
//
// Strict-CSP rule (host.ts): only CSSOM property writes, never a style attribute string.

import { domToCanvas } from 'modern-screenshot';
import { HOST_ID } from './host';

export const MASK_COLOR = '#1a1612';
export const PLACEHOLDER_COLOR = '#ede6d6';
export const CAPTURE_TIMEOUT_MS = 8000;
export const MASK_SELECTOR = 'input[type=password], [data-feedback-mask]';
const MAX_ERROR_CHARS = 200;

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

async function rasterise(
  vw: number,
  vh: number,
  scale: number,
  hostEl: HTMLElement | null,
): Promise<HTMLCanvasElement> {
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
  try {
    if (hostEl) hostEl.style.setProperty('display', 'none', 'important');
    const masks = maskRects(hostEl);
    const raw = await withTimeout(rasterise(vw, vh, scale, hostEl), timeoutMs);

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
