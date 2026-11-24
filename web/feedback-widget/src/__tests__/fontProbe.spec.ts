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

describe('apiFontCss', () => {
  /** A WOFF2-signed payload whose 5th byte identifies the file. */
  const fontBytes = (id: number) => new Uint8Array([0x77, 0x4f, 0x46, 0x32, id]).buffer;
  const fileId = (buf: ArrayBuffer) => new Uint8Array(buf)[4];

  type Desc = { weight?: string; style?: string; stretch?: string };
  type PageFace = {
    family: string;
    weight: string;
    style: string;
    stretch: string;
    unicodeRange: string;
    featureSettings: string;
    status: string;
  };

  let probesMade: FakeFontFace[];
  class FakeFontFace {
    family: string;
    bytes: ArrayBuffer;
    desc: Desc;
    status = 'unloaded';
    constructor(family: string, bytes: ArrayBuffer, desc: Desc = {}) {
      this.family = family;
      this.bytes = bytes;
      this.desc = desc;
      probesMade.push(this);
    }
    load() {
      this.status = 'loaded';
      return Promise.resolve(this);
    }
  }

  function fakeDoc(pageFaces: PageFace[]) {
    const members = new Set<unknown>(pageFaces);
    const fonts = {
      forEach(cb: (f: never) => void) {
        for (const f of [...members]) cb(f as never);
      },
      add: vi.fn((f: unknown) => members.add(f)),
      delete: vi.fn((f: unknown) => members.delete(f)),
      has: (f: unknown) => members.has(f),
      size: () => members.size,
    };
    return { doc: { fonts } as unknown as Document, fonts };
  }

  function pageFace(over: Partial<PageFace> & { family: string }): PageFace {
    return {
      weight: '400',
      style: 'normal',
      stretch: 'normal',
      unicodeRange: 'U+0-10FFFF',
      featureSettings: 'normal',
      status: 'loaded',
      ...over,
    };
  }

  let resourceNames: string[];
  beforeEach(() => {
    probesMade = [];
    resourceNames = [];
    vi.stubGlobal('FontFace', FakeFontFace);
    vi.spyOn(performance, 'getEntriesByType').mockImplementation(
      () => resourceNames.map((name) => ({ name })) as unknown as PerformanceEntryList,
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  /**
   * Measure: page fonts by CSS string; a probe draws `fileWidths[fileId](cp, desc)` but only
   * while registered in doc.fonts.
   */
  function probeMeasure(
    fonts: { has(f: unknown): boolean },
    page: Record<string, (cp: number) => number | null>,
    fileWidths: Record<number, (cp: number, desc: Desc) => number | null>,
  ) {
    return (font: string, cp: number): number | null => {
      if (page[font]) return page[font](cp);
      const m = /^64px "(__smfw_probe_\d+)"$/.exec(font);
      if (!m) return null;
      const probe = probesMade.find((p) => p.family === m[1]);
      if (!probe || !fonts.has(probe)) return null;
      const w = fileWidths[fileId(probe.bytes)];
      return w ? w(cp, probe.desc) : null;
    };
  }

  it('emits a rule with the face descriptors and a data URL, then removes the probes', async () => {
    const { apiFontCss } = await freshModule();
    const brand = pageFace({ family: '"Brand Sans"', weight: '700', style: 'italic', unicodeRange: 'U+0-FF' });
    const other = pageFace({ family: 'Unrelated' });
    const { doc, fonts } = fakeDoc([brand, other]);
    resourceNames = ['https://x.test/a.woff2', 'https://x.test/b.woff2', 'https://x.test/app.js'];
    const fetchBytes = vi.fn(async (url: string) => fontBytes(url.endsWith('a.woff2') ? 1 : 2));
    const measure = probeMeasure(fonts, { 'italic 700 normal 64px "Brand Sans"': widthsB }, { 1: widthsA, 2: widthsB });

    const out = await apiFontCss(new Set(['brand sans']), { doc, fetchBytes, measure });
    expect(fetchBytes.mock.calls.map((c) => c[0])).toEqual(['https://x.test/a.woff2', 'https://x.test/b.woff2']);
    expect(out.families).toEqual(new Set(['brand sans']));
    expect(out.cssText).toContain('font-family:"Brand Sans"');
    expect(out.cssText).toContain('font-weight:700');
    expect(out.cssText).toContain('font-style:italic');
    expect(out.cssText).toContain('unicode-range:U+0-FF');
    expect(out.cssText).toContain('src:url("data:font/woff2;base64,');
    expect(out.cssText.match(/@font-face/g)).toHaveLength(1);
    expect(probesMade.length).toBeGreaterThan(0);
    expect(probesMade.every((p) => p.family.startsWith('__smfw_probe_'))).toBe(true);
    for (const p of probesMade) expect(fonts.has(p)).toBe(false);
    expect(fonts.size()).toBe(2);

    // A second capture of the same page fetches and probes nothing new.
    fetchBytes.mockClear();
    const made = probesMade.length;
    const again = await apiFontCss(new Set(['brand sans']), { doc, fetchBytes, measure });
    expect(again.cssText).toBe(out.cssText);
    expect(fetchBytes).not.toHaveBeenCalled();
    expect(probesMade.length).toBe(made);
  });

  it('removes probes when measure throws, and never rejects', async () => {
    const { apiFontCss } = await freshModule();
    const { doc, fonts } = fakeDoc([pageFace({ family: 'Brand' })]);
    resourceNames = ['https://x.test/a.woff2'];
    const measure = () => {
      throw new Error('canvas exploded');
    };
    const out = await apiFontCss(new Set(['brand']), { doc, fetchBytes: async () => fontBytes(1), measure });
    expect(out.cssText).toBe('');
    expect(probesMade.length).toBeGreaterThan(0);
    for (const p of probesMade) expect(fonts.has(p)).toBe(false);
  });

  it('never fetches excluded URLs and skips a non-font payload', async () => {
    const { apiFontCss } = await freshModule();
    const { doc, fonts } = fakeDoc([pageFace({ family: 'Brand' })]);
    resourceNames = ['https://x.test/sheet.woff2', 'https://x.test/html.woff2', 'https://x.test/real.woff2'];
    const fetchBytes = vi.fn(async (url: string) =>
      url.includes('html') ? new TextEncoder().encode('<!doctype html>').buffer : fontBytes(3),
    );
    const measure = probeMeasure(fonts, { 'normal 400 normal 64px "Brand"': widthsC }, { 3: widthsC });
    const out = await apiFontCss(new Set(['brand']), {
      doc,
      fetchBytes,
      measure,
      exclude: new Set(['https://x.test/sheet.woff2']),
    });
    expect(fetchBytes.mock.calls.map((c) => c[0])).toEqual(['https://x.test/html.woff2', 'https://x.test/real.woff2']);
    expect(probesMade).toHaveLength(1);
    expect(fileId(probesMade[0].bytes)).toBe(3);
    expect(out.families).toEqual(new Set(['brand']));
  });

  it('returns early when the budget runs out', async () => {
    const { apiFontCss } = await freshModule();
    const { doc, fonts } = fakeDoc([pageFace({ family: 'Brand' })]);
    resourceNames = ['https://x.test/slow.woff2'];
    const fetchBytes = () => new Promise<ArrayBuffer | null>(() => {});
    const t0 = Date.now();
    const out = await apiFontCss(new Set(['brand']), { doc, fetchBytes, measure: () => 1, budgetMs: 30 });
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(out.cssText).toBe('');
    expect(out.families.size).toBe(0);
    expect(fonts.size()).toBe(1);
  });

  it('second pass with the face descriptors resolves a variable face the first pass missed', async () => {
    const { apiFontCss } = await freshModule();
    const heavy = pageFace({ family: 'Var', weight: '800' });
    const { doc, fonts } = fakeDoc([heavy]);
    resourceNames = ['https://x.test/other.woff2', 'https://x.test/var.woff2'];
    const fetchBytes = async (url: string) => fontBytes(url.includes('var') ? 5 : 6);
    // The variable file draws its 800 instance only when the probe face says weight 800.
    const measure = probeMeasure(
      fonts,
      { 'normal 800 normal 64px "Var"': widthsB },
      { 5: (cp, desc) => (desc.weight === '800' ? widthsB(cp) : widthsA(cp)), 6: widthsC },
    );
    const out = await apiFontCss(new Set(['var']), { doc, fetchBytes, measure });
    expect(out.families).toEqual(new Set(['var']));
    expect(out.cssText).toContain('font-weight:800');
    const second = probesMade.filter((p) => p.desc.weight === '800');
    expect(second.map((p) => fileId(p.bytes)).sort()).toEqual([5, 6]);
    expect(second.every((p) => p.desc.style === 'normal' && p.desc.stretch === 'normal')).toBe(true);
    for (const p of probesMade) expect(fonts.has(p)).toBe(false);
  });

  it('second pass probes every fetched file, including ones the first pass matched', async () => {
    const { apiFontCss } = await freshModule();
    const plain = pageFace({ family: 'Mix', weight: '400' });
    const heavy = pageFace({ family: 'Mix', weight: '900' });
    const { doc, fonts } = fakeDoc([plain, heavy]);
    resourceNames = ['https://x.test/static.woff2', 'https://x.test/var.woff2'];
    const fetchBytes = async (url: string) => fontBytes(url.includes('var') ? 5 : 7);
    const measure = probeMeasure(
      fonts,
      { 'normal 400 normal 64px "Mix"': widthsA, 'normal 900 normal 64px "Mix"': widthsB },
      { 7: widthsA, 5: (cp, desc) => (desc.weight === '900' ? widthsB(cp) : widthsC(cp)) },
    );
    const out = await apiFontCss(new Set(['mix']), { doc, fetchBytes, measure });
    expect(out.cssText.match(/@font-face/g)).toHaveLength(2);
    const second = probesMade.filter((p) => p.desc.weight === '900');
    expect(second.map((p) => fileId(p.bytes))).toEqual([7, 5]);
  });

  it('one variable file backing weights 400 and 700 embeds both faces, encoded once', async () => {
    const { apiFontCss } = await freshModule();
    const regular = pageFace({ family: 'One', weight: '400' });
    const bold = pageFace({ family: 'One', weight: '700' });
    const { doc, fonts } = fakeDoc([regular, bold]);
    resourceNames = ['https://x.test/one-var.woff2'];
    const fetchBytes = vi.fn(async () => fontBytes(8));
    // The file draws its 700 instance only when the probe face says weight 700.
    const measure = probeMeasure(
      fonts,
      { 'normal 400 normal 64px "One"': widthsA, 'normal 700 normal 64px "One"': widthsB },
      { 8: (cp, desc) => (desc.weight === '700' ? widthsB(cp) : widthsA(cp)) },
    );
    const btoaSpy = vi.spyOn(globalThis, 'btoa');
    const out = await apiFontCss(new Set(['one']), { doc, fetchBytes, measure });
    expect(fetchBytes).toHaveBeenCalledTimes(1);
    expect(btoaSpy).toHaveBeenCalledTimes(1);
    const rules = out.cssText.split('\n').filter((r) => r.includes('@font-face'));
    expect(rules).toHaveLength(2);
    expect(rules.some((r) => r.includes('font-weight:400'))).toBe(true);
    expect(rules.some((r) => r.includes('font-weight:700'))).toBe(true);
    const srcs = rules.map((r) => /src:url\("([^"]+)"\)/.exec(r)?.[1]);
    expect(srcs[0]).toMatch(/^data:font\/woff2;base64,/);
    expect(srcs[1]).toBe(srcs[0]);
    expect([...out.families]).toEqual(['one']);
    const second = probesMade.filter((p) => p.desc.weight === '700');
    expect(second.map((p) => fileId(p.bytes))).toEqual([8]);
    for (const p of probesMade) expect(fonts.has(p)).toBe(false);
  });

  it('fetches nothing with no requested families or no loaded API faces', async () => {
    const { apiFontCss } = await freshModule();
    resourceNames = ['https://x.test/a.woff2'];
    const fetchBytes = vi.fn(async () => fontBytes(1));
    const { doc } = fakeDoc([pageFace({ family: 'Brand' }), pageFace({ family: 'Late', status: 'loading' })]);
    expect((await apiFontCss(new Set(), { doc, fetchBytes, measure: () => 1 })).cssText).toBe('');
    expect((await apiFontCss(new Set(['late']), { doc, fetchBytes, measure: () => 1 })).cssText).toBe('');
    expect((await apiFontCss(new Set(['nope']), { doc, fetchBytes, measure: () => 1 })).cssText).toBe('');
    expect(fetchBytes).not.toHaveBeenCalled();
    expect(probesMade).toHaveLength(0);
  });
});
