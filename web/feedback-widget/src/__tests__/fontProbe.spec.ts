import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FaceInfo } from '../fontProbe';

type FontProbe = typeof import('../fontProbe');

async function freshModule(): Promise<FontProbe> {
  vi.resetModules();
  return import('../fontProbe');
}

function face(over: Partial<FaceInfo> & { family: string }): FaceInfo {
  return { weight: '400', style: 'normal', stretch: 'normal', unicodeRange: 'U+0-10FFFF', ...over };
}

/**
 * Fake measurer: `fonts` maps a CSS font string to a glyph-width table (cp → width).
 * Unknown fonts or code points missing from the table measure null (fell back).
 */
function fakeMeasure(fonts: Record<string, (cp: number) => number | null>) {
  const calls: string[] = [];
  const measure = (font: string, cp: number): number | null => {
    calls.push(font);
    const f = fonts[font];
    return f ? f(cp) : null;
  };
  return { measure, calls };
}

const widthsA = (cp: number) => 10 + (cp % 7);
const widthsB = (cp: number) => 11 + (cp % 5);
const widthsC = (cp: number) => 9 + (cp % 3) * 2;

describe('matchFaces', () => {
  it('maps static weights of one family to their own files', async () => {
    const { matchFaces } = await freshModule();
    const regular = face({ family: 'Brand', weight: '400' });
    const bold = face({ family: 'Brand', weight: '700' });
    const { measure } = fakeMeasure({
      'normal 400 normal 64px "Brand"': widthsA,
      'normal 700 normal 64px "Brand"': widthsB,
      '64px "probe-0"': widthsB,
      '64px "probe-1"': widthsA,
    });
    const out = matchFaces(
      [regular, bold],
      [
        { url: 'https://x.test/bold.woff2', probeFamily: 'probe-0' },
        { url: 'https://x.test/regular.woff2', probeFamily: 'probe-1' },
      ],
      measure,
    );
    expect(out.get(regular)).toBe('https://x.test/regular.woff2');
    expect(out.get(bold)).toBe('https://x.test/bold.woff2');
  });

  it('uses the first value of a weight range and keeps an italic style', async () => {
    const { matchFaces } = await freshModule();
    const italic = face({ family: 'Brand', weight: '100 900', style: 'italic' });
    const { measure, calls } = fakeMeasure({
      'italic 100 normal 64px "Brand"': widthsC,
      '64px "p-up"': widthsA,
      '64px "p-it"': widthsC,
    });
    const out = matchFaces(
      [italic],
      [
        { url: 'u-upright', probeFamily: 'p-up' },
        { url: 'u-italic', probeFamily: 'p-it' },
      ],
      measure,
    );
    expect(out.get(italic)).toBe('u-italic');
    expect(calls).toContain('italic 100 normal 64px "Brand"');
  });

  it('maps two unicode-range slices of one family to different files', async () => {
    const { matchFaces } = await freshModule();
    const latin = face({ family: 'Slice', unicodeRange: 'U+0-FF' });
    const cyr = face({ family: 'Slice', unicodeRange: 'U+400-45F' });
    const inLatin = (cp: number) => cp <= 0xff;
    const inCyr = (cp: number) => cp >= 0x400 && cp <= 0x45f;
    // The page face only draws glyphs the browser routes to the slice covering cp, so the
    // family-level font answers for both slices.
    const { measure } = fakeMeasure({
      'normal 400 normal 64px "Slice"': (cp) => (inLatin(cp) ? widthsA(cp) : inCyr(cp) ? widthsB(cp) : null),
      '64px "p-cyr"': (cp) => (inCyr(cp) ? widthsB(cp) : null),
      '64px "p-lat"': (cp) => (inLatin(cp) ? widthsA(cp) : null),
    });
    const out = matchFaces(
      [latin, cyr],
      [
        { url: 'cyrillic.woff2', probeFamily: 'p-cyr' },
        { url: 'latin.woff2', probeFamily: 'p-lat' },
      ],
      measure,
    );
    expect(out.get(latin)).toBe('latin.woff2');
    expect(out.get(cyr)).toBe('cyrillic.woff2');
  });

  it('rejects a candidate missing some of the glyphs (null on one side only)', async () => {
    const { matchFaces } = await freshModule();
    const f = face({ family: 'Gap' });
    const { measure } = fakeMeasure({
      'normal 400 normal 64px "Gap"': widthsA,
      // Equal on every glyph it has, but lacks 'C' (a sampled code point).
      '64px "p-gap"': (cp) => (cp === 0x43 ? null : widthsA(cp)),
      '64px "p-full"': widthsA,
    });
    const out = matchFaces(
      [f],
      [
        { url: 'partial.woff2', probeFamily: 'p-gap' },
        { url: 'full.woff2', probeFamily: 'p-full' },
      ],
      measure,
    );
    expect(out.get(f)).toBe('full.woff2');

    const only = matchFaces([f], [{ url: 'partial.woff2', probeFamily: 'p-gap' }], measure);
    expect(only.has(f)).toBe(false);
  });

  it('rejects widths differing by more than 0.01 and accepts within 0.01', async () => {
    const { matchFaces } = await freshModule();
    const f = face({ family: 'Tol' });
    const { measure } = fakeMeasure({
      'normal 400 normal 64px "Tol"': widthsA,
      '64px "p-off"': (cp) => widthsA(cp) + 0.02,
      '64px "p-near"': (cp) => widthsA(cp) + 0.005,
    });
    const out = matchFaces(
      [f],
      [
        { url: 'off', probeFamily: 'p-off' },
        { url: 'near', probeFamily: 'p-near' },
      ],
      measure,
    );
    expect(out.get(f)).toBe('near');
  });

  it('first matching candidate in input order wins', async () => {
    const { matchFaces } = await freshModule();
    const f = face({ family: 'Dup' });
    const { measure } = fakeMeasure({
      'normal 400 normal 64px "Dup"': widthsA,
      '64px "p1"': widthsA,
      '64px "p2"': widthsA,
    });
    const out = matchFaces(
      [f],
      [
        { url: 'first', probeFamily: 'p1' },
        { url: 'second', probeFamily: 'p2' },
      ],
      measure,
    );
    expect(out.get(f)).toBe('first');
  });

  it('leaves a face unmatched with fewer than 3 comparable samples', async () => {
    const { matchFaces } = await freshModule();
    const f = face({ family: 'Tiny', unicodeRange: 'U+41-42' }); // only A, B
    const { measure } = fakeMeasure({
      'normal 400 normal 64px "Tiny"': widthsA,
      '64px "p"': widthsA,
    });
    const out = matchFaces([f], [{ url: 'tiny.woff2', probeFamily: 'p' }], measure);
    expect(out.has(f)).toBe(false);
    expect(out.size).toBe(0);
  });

  it('quotes and escapes family names', async () => {
    const { matchFaces } = await freshModule();
    const f = face({ family: 'My "Odd" Font' });
    const { measure, calls } = fakeMeasure({
      'normal 400 normal 64px "My \\"Odd\\" Font"': widthsA,
      '64px "p"': widthsA,
    });
    const out = matchFaces([f], [{ url: 'odd', probeFamily: 'p' }], measure);
    expect(out.get(f)).toBe('odd');
    expect(calls[0]).toBe('normal 400 normal 64px "My \\"Odd\\" Font"');
  });
});

describe('canvasMeasurer', () => {
  it('returns the width when monospace and serif fallbacks agree, null when they differ', async () => {
    const { canvasMeasurer } = await freshModule();
    const ctx = {
      font: '',
      measureText(text: string) {
        // Glyph 'A' is in the font (same width either fallback); 'Z' falls back.
        if (text === 'A') return { width: 40 };
        return { width: this.font.endsWith(', monospace') ? 38 : 31 };
      },
    };
    const doc = {
      createElement: () => ({ getContext: () => ctx }),
    } as unknown as Document;
    const measure = canvasMeasurer(doc);
    expect(measure('64px "X"', 0x41)).toBe(40);
    expect(measure('64px "X"', 0x5a)).toBeNull();
  });

  it('returns null when no 2D context is available', async () => {
    const { canvasMeasurer } = await freshModule();
    const doc = { createElement: () => ({ getContext: () => null }) } as unknown as Document;
    expect(canvasMeasurer(doc)('64px "X"', 0x41)).toBeNull();
  });
});

describe('watchFontResources / fontResourceUrls', () => {
  let observers: Array<{ cb: (list: { getEntries(): Array<{ name: string }> }) => void; opts: unknown }>;
  let bufferedEntries: Array<{ name: string }>;

  beforeEach(() => {
    observers = [];
    bufferedEntries = [];
    class FakeObserver {
      cb: (list: { getEntries(): Array<{ name: string }> }) => void;
      constructor(cb: FakeObserver['cb']) {
        this.cb = cb;
      }
      observe(opts: unknown) {
        observers.push({ cb: this.cb, opts });
      }
      disconnect() {}
    }
    vi.stubGlobal('PerformanceObserver', FakeObserver);
    vi.spyOn(performance, 'getEntriesByType').mockImplementation(
      () => bufferedEntries as unknown as PerformanceEntryList,
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const emit = (...names: string[]) => {
    for (const o of observers) o.cb({ getEntries: () => names.map((name) => ({ name })) });
  };

  it('observes once, buffered, and records only font URLs', async () => {
    const { watchFontResources, fontResourceUrls } = await freshModule();
    watchFontResources();
    watchFontResources();
    expect(observers).toHaveLength(1);
    expect(observers[0].opts).toEqual({ type: 'resource', buffered: true });

    emit('https://a.test/app.js', 'https://a.test/f/one.woff2?v=1', 'https://a.test/style.css');
    emit('https://a.test/f/two.ttf', 'https://a.test/f/one.woff2?v=1');
    expect(fontResourceUrls()).toEqual(['https://a.test/f/one.woff2?v=1', 'https://a.test/f/two.ttf']);
  });

  it('merges getEntriesByType names, deduplicated, in first-seen order', async () => {
    const { watchFontResources, fontResourceUrls } = await freshModule();
    watchFontResources();
    emit('https://a.test/one.woff2');
    bufferedEntries = [
      { name: 'https://a.test/img.png' },
      { name: 'https://a.test/one.woff2' },
      { name: 'https://a.test/three.otf' },
    ];
    expect(fontResourceUrls()).toEqual(['https://a.test/one.woff2', 'https://a.test/three.otf']);
    expect(performance.getEntriesByType).toHaveBeenCalledWith('resource');
  });

  it('is a no-op without PerformanceObserver and never throws', async () => {
    vi.stubGlobal('PerformanceObserver', undefined);
    const { watchFontResources, fontResourceUrls } = await freshModule();
    expect(() => watchFontResources()).not.toThrow();
    bufferedEntries = [{ name: 'https://a.test/x.woff' }];
    expect(fontResourceUrls()).toEqual(['https://a.test/x.woff']);
  });

  it('swallows an observe() that throws', async () => {
    vi.stubGlobal(
      'PerformanceObserver',
      class {
        observe() {
          throw new TypeError('unsupported');
        }
      },
    );
    const { watchFontResources } = await freshModule();
    expect(() => watchFontResources()).not.toThrow();
  });
});
