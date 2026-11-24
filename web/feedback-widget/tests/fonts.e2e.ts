import { expect, test, type ConsoleMessage, type Page } from '@playwright/test';

// captureViewport must draw page text in the page's own font for every way a page can load
// one (fixtures/fonts.html ?mode=). Each capture is compared with page.screenshot() of the
// same viewport over the button and paragraph regions.

// LCD (subpixel) text puts colored fringes on every glyph edge of page.screenshot(); a
// capture is always grayscale-antialiased (canvas from an SVG image), so those fringes alone
// exceed the threshold. Grayscale text on both sides leaves only the font to compare.
test.use({ launchOptions: { args: ['--disable-lcd-text'] } });

const VIEWPORT = { width: 800, height: 600 };
const CHANNEL_DELTA = 64;
const MAX_DIFF_SHARE = 0.03;
const WAIT_MS = 10_000;
const REGIONS = ['signin', 'para'] as const;

type Region = (typeof REGIONS)[number];

interface Result {
  error: string | null;
  scale: number;
  /** Share of region pixels differing by more than CHANNEL_DELTA in any channel. */
  diff: Record<Region, number>;
}

async function openFixture(page: Page, query: string): Promise<void> {
  await page.goto(`/fonts.html?${query}`);
  await page.waitForFunction(
    () => {
      const w = window as unknown as { __fontsReady?: boolean; __fontsError?: string };
      if (w.__fontsError) throw new Error(w.__fontsError);
      return w.__fontsReady === true;
    },
    null,
    { timeout: WAIT_MS },
  );
}

/** Captures the current page and diffs its regions against `reference` (PNG, same viewport). */
async function captureAndDiff(page: Page, reference: Buffer): Promise<Result> {
  return page.evaluate(
    async ({ refB64, regions, delta }) => {
      const cap = (window as unknown as { __capture: (o: object) => Promise<any> }).__capture;
      const r = await cap({});
      const bytes = Uint8Array.from(atob(refB64), (c) => c.charCodeAt(0));
      const [got, want] = await Promise.all([
        createImageBitmap(r.png),
        createImageBitmap(new Blob([bytes], { type: 'image/png' })),
      ]);
      const pixels = (bmp: ImageBitmap) => {
        const c = document.createElement('canvas');
        c.width = want.width;
        c.height = want.height;
        const ctx = c.getContext('2d', { willReadFrequently: true })!;
        ctx.drawImage(bmp, 0, 0, want.width, want.height);
        return ctx;
      };
      const a = pixels(got);
      const b = pixels(want);
      const diff: Record<string, number> = {};
      for (const id of regions) {
        const box = document.getElementById(id)!.getBoundingClientRect();
        const x = Math.floor(box.left);
        const y = Math.floor(box.top);
        const w = Math.ceil(box.right) - x;
        const h = Math.ceil(box.bottom) - y;
        const da = a.getImageData(x, y, w, h).data;
        const db = b.getImageData(x, y, w, h).data;
        let off = 0;
        for (let i = 0; i < da.length; i += 4) {
          if (
            Math.abs(da[i] - db[i]) > delta ||
            Math.abs(da[i + 1] - db[i + 1]) > delta ||
            Math.abs(da[i + 2] - db[i + 2]) > delta ||
            Math.abs(da[i + 3] - db[i + 3]) > delta
          ) {
            off++;
          }
        }
        diff[id] = off / (w * h);
      }
      return { error: r.error ?? null, scale: r.scale, diff: diff as Record<'signin' | 'para', number> };
    },
    { refB64: reference.toString('base64'), regions: [...REGIONS], delta: CHANNEL_DELTA },
  );
}

test.describe('captureViewport embeds the page font', () => {
  test.use({ viewport: VIEWPORT, deviceScaleFactor: 1 });

  for (const mode of ['stylesheet', 'api', 'api-sliced', 'cross-origin', 'adopted']) {
    test(`${mode}: capture matches the page screenshot`, async ({ page }) => {
      const warnings: string[] = [];
      page.on('console', (m: ConsoleMessage) => {
        if (m.type() === 'warning') warnings.push(m.text());
      });
      await openFixture(page, `mode=${mode}`);
      const reference = await page.screenshot();
      const r = await captureAndDiff(page, reference);
      expect(r.error).toBeNull();
      expect(r.scale).toBe(1);
      for (const id of REGIONS) {
        expect(r.diff[id], `${mode} ${id} differing-pixel share`).toBeLessThan(MAX_DIFF_SHARE);
      }
      expect(warnings.filter((w) => w.includes('screenshot fonts not embedded'))).toEqual([]);
    });
  }

  test('the comparison catches a fallback font', async ({ page }) => {
    // Reference: the page drawn in its declared font.
    await openFixture(page, 'mode=stylesheet');
    const reference = await page.screenshot();
    // Same page, text drawn in an undeclared family (falls back to the generic).
    await openFixture(page, `mode=stylesheet&family=${encodeURIComponent('FW Undeclared')}`);
    const r = await captureAndDiff(page, reference);
    expect(r.error).toBeNull();
    for (const id of REGIONS) {
      expect(r.diff[id], `fallback ${id} differing-pixel share`).toBeGreaterThan(MAX_DIFF_SHARE);
    }
  });

  test('data-url: captures without error and warns naming the family', async ({ page }) => {
    const warnings: string[] = [];
    page.on('console', (m: ConsoleMessage) => {
      if (m.type() === 'warning') warnings.push(m.text());
    });
    await openFixture(page, 'mode=data-url');
    const reference = await page.screenshot();
    const r = await captureAndDiff(page, reference);
    expect(r.error).toBeNull();
    const hits = warnings.filter((w) => w.includes('screenshot fonts not embedded'));
    expect(hits).toHaveLength(1);
    expect(hits[0].toLowerCase()).toContain('fw test data');
  });
});
