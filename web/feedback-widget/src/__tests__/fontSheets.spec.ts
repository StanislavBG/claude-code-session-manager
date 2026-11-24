import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { resetFontFetchCacheForTests } from '../fontFetch';
import { coveredFamilies, declaredFontUrls, sheetFontCss } from '../fontSheets';
import { FONT_FACES, fontFaceCss, loadFonts, resetTokensForTests, widgetFontSheet } from '../ui/tokens';

// jsdom has constructable CSSStyleSheet but no document.adoptedStyleSheets; shim it so
// loadFonts takes its browser path.
beforeAll(() => {
  if (!('adoptedStyleSheets' in Document.prototype)) {
    const sheets = new WeakMap<Document, CSSStyleSheet[]>();
    Object.defineProperty(Document.prototype, 'adoptedStyleSheets', {
      configurable: true,
      get(this: Document) {
        return sheets.get(this) ?? [];
      },
      set(this: Document, v: CSSStyleSheet[]) {
        sheets.set(this, v);
      },
    });
  }
});

afterEach(() => {
  resetTokensForTests();
  resetFontFetchCacheForTests();
  document.adoptedStyleSheets = [];
  vi.unstubAllGlobals();
});

const BASE = 'https://page.example/app/index.html';
const WOFF2 = new Uint8Array([0x77, 0x4f, 0x46, 0x32, 1, 2, 3, 4]).buffer; // 'wOF2'…
const HTML = new TextEncoder().encode('<!doctype html>').buffer;

type SheetLike = { href: string | null; cssRules: CSSRuleList | unknown[] };

// jsdom's CSSOM drops the @font-face `src` descriptor (and a detached <style> gets no
// sheet), so sheets here are a tiny fake CSSOM that keeps descriptors the way browsers do.
interface FakeRule {
  type: number;
  cssText: string;
  style?: { getPropertyValue(name: string): string };
  cssRules?: FakeRule[];
}

function splitDecls(body: string): string[] {
  const out: string[] = [];
  let cur = '';
  let depth = 0;
  let quote = '';
  for (const ch of body) {
    if (quote) {
      if (ch === quote) quote = '';
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (ch === ';' && depth === 0) {
      out.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out;
}

function fakeParse(css: string): FakeRule[] {
  const rules: FakeRule[] = [];
  let i = 0;
  while (i < css.length) {
    const open = css.indexOf('{', i);
    if (open < 0) break;
    const prelude = css.slice(i, open).trim();
    let depth = 1;
    let j = open + 1;
    while (j < css.length && depth > 0) {
      if (css[j] === '{') depth++;
      else if (css[j] === '}') depth--;
      j++;
    }
    const body = css.slice(open + 1, j - 1);
    if (/^@font-face$/i.test(prelude)) {
      const decls = new Map<string, string>();
      for (const d of splitDecls(body)) {
        const k = d.indexOf(':');
        if (k > 0) decls.set(d.slice(0, k).trim().toLowerCase(), d.slice(k + 1).trim());
      }
      const text = [...decls].map(([k, v]) => `${k}: ${v};`).join(' ');
      rules.push({
        type: 5,
        cssText: `@font-face { ${text} }`,
        style: { getPropertyValue: (n) => decls.get(n) ?? '' },
      });
    } else if (prelude.startsWith('@')) {
      rules.push({ type: 4, cssText: `${prelude} { ${body} }`, cssRules: fakeParse(body) });
    } else {
      rules.push({ type: 1, cssText: `${prelude} { ${body} }`, style: { getPropertyValue: () => '' } });
    }
    i = j;
  }
  return rules;
}

/** A readable sheet. */
function readable(css: string, href: string | null = null): SheetLike {
  return { href, cssRules: fakeParse(css) };
}

/** A cross-origin no-CORS sheet: cssRules throws SecurityError. */
function unreadable(href: string | null): SheetLike {
  return {
    href,
    get cssRules(): CSSRuleList {
      throw new DOMException('Cannot access rules', 'SecurityError');
    },
  };
}

/** An adopted (constructed) sheet. */
function adopted(css: string): SheetLike {
  return { href: null, cssRules: fakeParse(css) };
}

/** doc.implementation whose detached <style> parses with fakeParse. */
const parserImplementation = {
  createHTMLDocument() {
    return {
      head: { appendChild: (n: unknown) => n },
      createElement() {
        let text = '';
        return {
          set textContent(v: string) {
            text = v;
          },
          get sheet() {
            return { cssRules: fakeParse(text) };
          },
        };
      },
    };
  },
};

function fakeDoc(styleSheets: unknown[], adoptedStyleSheets: unknown[] = []): Document {
  return {
    styleSheets,
    adoptedStyleSheets,
    baseURI: BASE,
    implementation: parserImplementation,
  } as unknown as Document;
}

const fontBytes = async (url: string) => (url.includes('missing') ? null : WOFF2);

describe('coveredFamilies / declaredFontUrls', () => {
  it('collects url() faces from readable sheets, nested @media and @import, skipping unreadable ones', () => {
    const imported = readable(
      `@font-face{font-family:"Imported Face";src:url(imp.woff2)}`,
      'https://cdn.example/css/imp.css',
    );
    const importRule = { type: 3, cssText: '@import url(imp.css);', styleSheet: imported };
    const doc = fakeDoc([
      readable(
        `@font-face{font-family:'Top  Face';src:url("fonts/top.woff2") format("woff2")}
         @media screen{@supports (display:grid){@font-face{font-family:Nested;src:url(/n.woff)}}}
         @font-face{font-family:LocalOnly;src:local(Arial)}`,
      ),
      { href: null, cssRules: [importRule] },
      unreadable('https://fonts.example/css2?family=Lora'),
    ]);
    expect(coveredFamilies(doc)).toEqual(new Set(['top face', 'nested', 'imported face']));
    expect(declaredFontUrls(doc)).toEqual(
      new Set([
        'https://page.example/app/fonts/top.woff2',
        'https://page.example/n.woff',
        'https://cdn.example/css/imp.woff2',
      ]),
    );
  });
});

describe('sheetFontCss', () => {
  it('embeds faces from an adopted sheet as data URLs', async () => {
    const doc = fakeDoc([], [adopted(`@font-face{font-family:"Adopted";src:url(a.woff2);font-weight:700}`)]);
    const fetchBytes = vi.fn(fontBytes);
    const res = await sheetFontCss(new Set(['adopted']), { doc, fetchBytes });
    expect(fetchBytes).toHaveBeenCalledWith('https://page.example/app/a.woff2');
    expect(res.families).toEqual(new Set(['adopted']));
    expect(res.urls).toEqual(new Set(['https://page.example/app/a.woff2']));
    expect(res.cssText).toContain('data:font/woff2;base64,');
    expect(res.cssText).not.toContain('a.woff2');
    expect(res.cssText).toMatch(/font-weight:\s*700/);
  });

  it("excludes the widget's own font sheet (by identity)", async () => {
    loadFonts('https://cdn.example.com/w/feedback.js');
    const own = widgetFontSheet()!;
    expect(own).not.toBeNull();
    // Give the real sheet browser-like rules (jsdom drops src) so only identity can exclude it.
    const css = fontFaceCss('https://cdn.example.com/w/feedback.js');
    Object.defineProperty(own, 'cssRules', { configurable: true, get: () => fakeParse(css) });
    const families = new Set(FONT_FACES.map((f) => f.family));
    const fetchBytes = vi.fn(fontBytes);
    const res = await sheetFontCss(families, { doc: fakeDoc([], [own]), fetchBytes });
    expect(res.cssText).toBe('');
    expect(res.families.size).toBe(0);
    expect(fetchBytes).not.toHaveBeenCalled();
    // The same rules in any other adopted sheet are embedded.
    const copy = await sheetFontCss(families, { doc: fakeDoc([], [adopted(css)]), fetchBytes });
    expect(copy.families.size).toBeGreaterThan(0);
  });

  it('fetches an unreadable sheet by href and parses it against that href', async () => {
    const href = 'https://fonts.example/css2?family=Lora';
    const fetchText = vi.fn(async () => `@media all{@font-face{font-family:'Lora';src:url(/s/lora.woff2)}}`);
    const fetchBytes = vi.fn(fontBytes);
    const res = await sheetFontCss(new Set(['Lora']), {
      doc: fakeDoc([unreadable(href), unreadable(null), readable('@font-face{font-family:Lora;src:url(x.woff2)}')]),
      fetchText,
      fetchBytes,
    });
    expect(fetchText).toHaveBeenCalledTimes(1);
    expect(fetchText).toHaveBeenCalledWith(href);
    expect(fetchBytes).toHaveBeenCalledWith('https://fonts.example/s/lora.woff2');
    expect(res.families).toEqual(new Set(['lora']));
    expect(res.cssText).toContain('data:font/woff2;base64,');
  });

  it('drops a rule whose fonts fail to fetch, and never rejects on a failing fetcher', async () => {
    const doc = fakeDoc(
      [unreadable('https://x.example/broken.css')],
      [adopted(`@font-face{font-family:Gone;src:url(missing.woff2)}`)],
    );
    const res = await sheetFontCss(new Set(['gone', 'broken']), {
      doc,
      fetchText: async () => {
        throw new Error('network');
      },
      fetchBytes: fontBytes,
    });
    expect(res.cssText).toBe('');
    expect(res.families.size).toBe(0);
    expect(res.urls).toEqual(new Set(['https://page.example/app/missing.woff2']));
  });

  it('rejects a non-font payload', async () => {
    const doc = fakeDoc([], [adopted(`@font-face{font-family:Fake;src:url(f.woff2)}`)]);
    const res = await sheetFontCss(new Set(['fake']), { doc, fetchBytes: async () => HTML });
    expect(res.cssText).toBe('');
    expect(res.families.size).toBe(0);
  });

  it('ignores families outside the requested set', async () => {
    const doc = fakeDoc(
      [],
      [adopted(`@font-face{font-family:Wanted;src:url(w.woff2)} @font-face{font-family:Other;src:url(o.woff2)}`)],
    );
    const fetchBytes = vi.fn(fontBytes);
    const res = await sheetFontCss(new Set(['wanted']), { doc, fetchBytes });
    expect(res.families).toEqual(new Set(['wanted']));
    expect(fetchBytes).toHaveBeenCalledTimes(1);
    expect(fetchBytes).toHaveBeenCalledWith('https://page.example/app/w.woff2');
    expect(res.urls.has('https://page.example/app/o.woff2')).toBe(false);
  });

  it('default fetchers use cors/omit, cache per URL, and resolve null on failure', async () => {
    const fetchMock = vi.fn(async (url: string) =>
      url.endsWith('.css')
        ? new Response(`@font-face{font-family:Remote;src:url(r.woff2)}`)
        : url.endsWith('bad.woff2')
          ? Promise.reject(new TypeError('cors'))
          : new Response(WOFF2),
    );
    vi.stubGlobal('fetch', fetchMock);
    const doc = fakeDoc(
      [unreadable('https://r.example/f.css'), unreadable('https://r.example/f.css')],
      [adopted(`@font-face{font-family:Bad;src:url(bad.woff2)}`)],
    );
    const res = await sheetFontCss(new Set(['remote', 'bad']), { doc });
    expect(res.families).toEqual(new Set(['remote']));
    const cssCalls = fetchMock.mock.calls.filter(([u]) => u === 'https://r.example/f.css');
    expect(cssCalls).toHaveLength(1);
    for (const call of fetchMock.mock.calls) {
      const init = (call as unknown as [string, RequestInit])[1];
      expect(init).toMatchObject({ mode: 'cors', credentials: 'omit' });
      expect(init.signal).toBeInstanceOf(AbortSignal);
    }
    await sheetFontCss(new Set(['remote']), { doc });
    expect(fetchMock.mock.calls.filter(([u]) => u === 'https://r.example/f.css')).toHaveLength(1);
  });
});
