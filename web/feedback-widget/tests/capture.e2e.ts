import { expect, test, type Page } from '@playwright/test';

const VIEWPORT = { width: 801, height: 601 };
const SCROLL_Y = 500;

interface Probe {
  width: number;
  height: number;
  scale: number;
  error: string | null;
  type: string;
  pngWidth: number;
  pngHeight: number;
  hostDisplayAfter: string;
  rects: Record<string, { x: number; y: number; w: number; h: number }>;
  pixels: Record<string, [number, number, number, number]>;
}

/** Runs captureViewport in the page, decodes the PNG and samples pixels at rect centres. */
async function capture(page: Page, opts: { timeoutMs?: number } = {}): Promise<Probe> {
  await page.goto('/capture.html');
  await page.evaluate((y) => window.scrollTo(0, y), SCROLL_Y);
  return page.evaluate(async ({ timeoutMs }) => {
    const hostEl = document.getElementById('feedback-widget-host')!;
    const cap = (window as unknown as { __capture: (o: object) => Promise<any> }).__capture;
    const r = await cap({ hostEl, timeoutMs });
    const bmp = await createImageBitmap(r.png);
    const c = document.createElement('canvas');
    c.width = bmp.width;
    c.height = bmp.height;
    const ctx = c.getContext('2d')!;
    ctx.drawImage(bmp, 0, 0);
    const rects: Probe['rects'] = {};
    const pixels: Probe['pixels'] = {};
    for (const id of ['pw', 'masked', 'feedback-widget-host', 'plain', 'fixedbar']) {
      const b = document.getElementById(id)!.getBoundingClientRect();
      rects[id] = { x: b.left, y: b.top, w: b.width, h: b.height };
      const px = Math.floor((b.left + b.width / 2) * r.scale);
      const py = Math.floor((b.top + b.height / 2) * r.scale);
      pixels[id] = Array.from(ctx.getImageData(px, py, 1, 1).data) as Probe['pixels'][string];
    }
    return {
      width: r.width,
      height: r.height,
      scale: r.scale,
      error: r.error ?? null,
      type: r.png.type,
      pngWidth: bmp.width,
      pngHeight: bmp.height,
      hostDisplayAfter: hostEl.style.display,
      rects,
      pixels,
    };
  }, opts);
}

const MASK = [0x1a, 0x16, 0x12, 255];
const PLACEHOLDER = [0xed, 0xe6, 0xd6, 255];

test.describe('captureViewport at dpr 1', () => {
  test.use({ viewport: VIEWPORT, deviceScaleFactor: 1 });

  test('viewport-sized PNG, masks painted, host absent and restored', async ({ page }) => {
    const r = await capture(page);
    expect(r.error).toBeNull();
    expect(r.type).toBe('image/png');
    expect(r.scale).toBe(1);
    expect([r.width, r.height]).toEqual([VIEWPORT.width, VIEWPORT.height]);
    expect([r.pngWidth, r.pngHeight]).toEqual([VIEWPORT.width, VIEWPORT.height]);
    // The fixture is scrolled: masked targets are inside the viewport, above the fold offset.
    expect(r.rects.pw.y).toBeGreaterThan(0);
    expect(r.rects.pw.y).toBeLessThan(VIEWPORT.height);
    expect(r.pixels.pw).toEqual(MASK);
    expect(r.pixels.masked).toEqual(MASK);
    // Host is a solid #00ff00 box on the live page; in the image the white page shows through.
    expect(r.pixels['feedback-widget-host']).toEqual([255, 255, 255, 255]);
    expect(r.hostDisplayAfter).toBe('');
    // Scrolled content lands where it is on screen (unscrolled, this spot is white spacer).
    expect(r.rects.plain.y + r.rects.plain.h).toBeLessThan(VIEWPORT.height);
    expect(r.pixels.plain).toEqual([0x33, 0x66, 0xcc, 255]);
    // position:fixed elements stay pinned to the viewport, not the document top.
    expect(r.pixels.fixedbar).toEqual([0xcc, 0x22, 0x00, 255]);
  });

  test('a timeout returns a same-size #ede6d6 placeholder with error set', async ({ page }) => {
    const r = await capture(page, { timeoutMs: 1 });
    expect(r.error).toBeTruthy();
    expect(r.error!.length).toBeLessThanOrEqual(200);
    expect([r.pngWidth, r.pngHeight]).toEqual([VIEWPORT.width, VIEWPORT.height]);
    expect(r.pixels.plain).toEqual(PLACEHOLDER);
    expect(r.hostDisplayAfter).toBe('');
  });
});

test.describe('captureViewport at dpr 3', () => {
  test.use({ viewport: VIEWPORT, deviceScaleFactor: 3 });

  test('scale caps at 2 and size is round(inner * scale)', async ({ page }) => {
    const r = await capture(page);
    expect(r.error).toBeNull();
    expect(r.scale).toBe(2);
    expect([r.pngWidth, r.pngHeight]).toEqual([VIEWPORT.width * 2, VIEWPORT.height * 2]);
    expect(r.pixels.pw).toEqual(MASK);
    expect(r.pixels.masked).toEqual(MASK);
    expect(r.pixels['feedback-widget-host']).toEqual([255, 255, 255, 255]);
  });
});
