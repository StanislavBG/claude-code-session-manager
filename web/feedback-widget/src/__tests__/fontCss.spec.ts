// Pure font CSS helpers (fontCss.ts) that later capture PRDs use to embed page fonts.
import { describe, expect, it } from 'vitest';
import {
  bytesToDataUrl,
  fontFaceRule,
  fontFaceRulesFromCss,
  isFontBytes,
  isFontUrl,
  normalizeFamily,
  parseUnicodeRange,
  sampleCodePoints,
  splitFamilyList,
  unescapeCss,
  URL_RE,
} from '../fontCss';

const FULL: Array<[number, number]> = [[0, 0x10ffff]];

function bytes(...b: number[]): ArrayBuffer {
  const buf = new ArrayBuffer(Math.max(b.length, 8));
  new Uint8Array(buf).set(b);
  return buf;
}
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));

describe('normalizeFamily', () => {
  it('trims, strips one pair of matching quotes, collapses whitespace, lowercases', () => {
    expect(normalizeFamily('  "Inter  Tight" ')).toBe('inter tight');
    expect(normalizeFamily("'Source Serif 4'")).toBe('source serif 4');
    expect(normalizeFamily('Roboto\tMono')).toBe('roboto mono');
    expect(normalizeFamily('"Mismatched\'')).toBe('"mismatched\'');
    expect(normalizeFamily('""Double""')).toBe('"double"');
  });
});

describe('splitFamilyList', () => {
  it('splits on top-level commas, respects quotes, normalizes', () => {
    expect(splitFamilyList('"Foo, Bar", Baz Qux,\'Zed\'')).toEqual(['foo, bar', 'baz qux', 'zed']);
  });
  it('drops CSS generic families', () => {
    expect(
      splitFamilyList(
        'Inter, -apple-system, system-ui, sans-serif, serif, monospace, ui-monospace, emoji, BlinkMacSystemFont',
      ),
    ).toEqual(['inter']);
  });
  it('keeps a quoted name that spells a generic (it is a family name then)', () => {
    expect(splitFamilyList('"serif", serif')).toEqual(['serif']);
  });
  it('gives [] for empty input', () => {
    expect(splitFamilyList('')).toEqual([]);
    expect(splitFamilyList(' , ')).toEqual([]);
  });
});

describe('parseUnicodeRange', () => {
  it('parses single code points, ranges and wildcards', () => {
    expect(parseUnicodeRange('U+0-FF, U+131, U+4??')).toEqual([
      [0, 0xff],
      [0x131, 0x131],
      [0x400, 0x4ff],
    ]);
    expect(parseUnicodeRange('u+0460-052f')).toEqual([[0x460, 0x52f]]);
  });
  it('gives the full range for empty or invalid input', () => {
    expect(parseUnicodeRange('')).toEqual(FULL);
    expect(parseUnicodeRange('garbage')).toEqual(FULL);
    expect(parseUnicodeRange('U+FF-0')).toEqual(FULL);
  });
});

describe('sampleCodePoints', () => {
  it('puts A-Z a-z 0-9 first, then ascending, capped at max', () => {
    expect(sampleCodePoints([[0, 0xff]])).toEqual(ascii('ABCDEFGHIJKL'));
    const all = sampleCodePoints([[0, 0x7e]], 100);
    expect(all.slice(0, 62)).toEqual(
      ascii('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'),
    );
    expect(all.slice(62, 65)).toEqual(ascii('!"#'));
    expect(all).toHaveLength(94);
  });
  it('never yields controls, spaces, soft hyphen, surrogates or combining marks', () => {
    const got = sampleCodePoints(
      [
        [0, 0x20],
        [0x7f, 0xa0],
        [0xad, 0xad],
        [0x300, 0x36f],
        [0xd800, 0xdfff],
        [0x370, 0x372],
      ],
      50,
    );
    expect(got).toEqual([0x370, 0x371, 0x372]);
  });
  it('samples a wildcard range and honours max', () => {
    expect(sampleCodePoints(parseUnicodeRange('U+4??'), 3)).toEqual([0x400, 0x401, 0x402]);
    expect(sampleCodePoints(FULL, 0)).toEqual([]);
  });
});

describe('isFontUrl', () => {
  it('matches font extensions case-insensitively, ignoring query and hash', () => {
    expect(isFontUrl('https://x.test/a/b.woff2')).toBe(true);
    expect(isFontUrl('https://x.test/a/b.WOFF?v=3')).toBe(true);
    expect(isFontUrl('/f/x.ttf#frag')).toBe(true);
    expect(isFontUrl('x.otf')).toBe(true);
    expect(isFontUrl('x.eot?#iefix')).toBe(true);
    expect(isFontUrl('https://x.test/font.css')).toBe(false);
    expect(isFontUrl('https://x.test/a?f=b.woff2')).toBe(false);
    expect(isFontUrl('https://x.test/woff2')).toBe(false);
  });
});

describe('isFontBytes / bytesToDataUrl', () => {
  const cases: Array<[string, number[], string]> = [
    ['wOF2', ascii('wOF2'), 'font/woff2'],
    ['wOFF', ascii('wOFF'), 'font/woff'],
    ['00 01 00 00', [0, 1, 0, 0], 'font/ttf'],
    ['OTTO', ascii('OTTO'), 'font/otf'],
    ['true', ascii('true'), 'font/ttf'],
    ['ttcf', ascii('ttcf'), 'font/collection'],
  ];
  for (const [name, magic, mime] of cases) {
    it(`recognises ${name} as ${mime}`, () => {
      const buf = bytes(...magic, 1, 2, 3);
      expect(isFontBytes(buf)).toBe(true);
      const url = bytesToDataUrl(buf);
      expect(url.startsWith(`data:${mime};base64,`)).toBe(true);
      const decoded = atob(url.slice(url.indexOf(',') + 1));
      expect([...decoded].map((c) => c.charCodeAt(0))).toEqual([...new Uint8Array(buf)]);
    });
  }
  it('rejects a PNG signature and short buffers', () => {
    expect(isFontBytes(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a))).toBe(false);
    expect(isFontBytes(new Uint8Array(ascii('wOF')).buffer)).toBe(false);
    expect(isFontBytes(new ArrayBuffer(0))).toBe(false);
  });
  it('encodes a 1 MB buffer in chunks without overflowing the stack', () => {
    const big = new Uint8Array(1024 * 1024 + 7);
    big.set(ascii('wOF2'));
    for (let i = 4; i < big.length; i++) big[i] = (i * 31) & 0xff;
    const url = bytesToDataUrl(big.buffer);
    const b64 = url.slice(url.indexOf(',') + 1);
    expect(b64.length).toBe(Math.ceil(big.length / 3) * 4);
    const decoded = atob(b64);
    expect(decoded.length).toBe(big.length);
    for (const i of [0, 4, 32767, 32768, 32769, 65536, big.length - 1]) {
      expect(decoded.charCodeAt(i)).toBe(big[i]);
    }
  });
});

describe('fontFaceRule', () => {
  it('writes one rule with quoted, escaped family and src', () => {
    expect(
      fontFaceRule(
        {
          family: 'My "Odd" \\ Font',
          weight: '700',
          style: 'italic',
          stretch: '75%',
          unicodeRange: 'U+0-FF',
          featureSettings: '"liga" 0',
        },
        'data:font/woff2;base64,AAA"x',
      ),
    ).toBe(
      '@font-face{font-family:"My \\"Odd\\" \\\\ Font";src:url("data:font/woff2;base64,AAA\\"x");' +
        'font-weight:700;font-style:italic;font-stretch:75%;unicode-range:U+0-FF;' +
        'font-feature-settings:"liga" 0}',
    );
  });
  it('omits absent descriptors and ones equal to their initial value', () => {
    expect(
      fontFaceRule(
        {
          family: 'Inter',
          weight: 'normal',
          style: 'normal',
          stretch: 'normal',
          unicodeRange: 'U+0-10FFFF',
          featureSettings: 'normal',
        },
        'https://x.test/i.woff2',
      ),
    ).toBe('@font-face{font-family:"Inter";src:url("https://x.test/i.woff2")}');
    expect(fontFaceRule({ family: 'Inter' }, 'u.woff2')).toBe('@font-face{font-family:"Inter";src:url("u.woff2")}');
  });
  it('escapes newlines so the string cannot break out', () => {
    expect(fontFaceRule({ family: 'a\nb' }, 'x')).toBe('@font-face{font-family:"a\\a b";src:url("x")}');
  });
});

// jsdom keeps no `src` descriptor on CSSFontFaceRule and gives a createHTMLDocument
// <style> no sheet, so these tests pass a stand-in Document whose CSSOM serialises
// rules the way browsers do (descriptors kept, url() double-quoted).
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
      rules.push({ type: 4, cssText: `${prelude} { … }`, cssRules: fakeParse(body) });
    } else {
      rules.push({ type: 1, cssText: `${prelude} { ${body} }`, style: { getPropertyValue: () => '' } });
    }
    i = j;
  }
  return rules;
}

function fakeDoc(): { doc: Document; created: () => number } {
  let created = 0;
  const doc = {
    implementation: {
      createHTMLDocument() {
        created++;
        const head = { appendChild: (n: unknown) => n };
        return {
          head,
          createElement() {
            let text = '';
            return {
              set textContent(v: string) {
                text = v;
              },
              get textContent() {
                return text;
              },
              get sheet() {
                return { cssRules: fakeParse(text) };
              },
            };
          },
        };
      },
    },
  } as unknown as Document;
  return { doc, created: () => created };
}

describe('fontFaceRulesFromCss', () => {
  const css = `
    body { font-family: Foo; }
    @font-face { font-family: "Cross  Font"; src: url(../fonts/a.woff2) format("woff2"), url('b.woff') format("woff"); font-weight: 400; }
    @media (min-width: 1px) { @supports (display: grid) {
      @font-face { font-family: 'Nested'; src: url("/abs/n.ttf"), url(data:font/woff2;base64,AAAA); }
    } }
    @font-face { font-family: LocalOnly; src: local("Arial"); }
  `;

  it('returns only url()-backed font faces, rewritten absolute against baseUrl, recursing into groups', () => {
    const { doc, created } = fakeDoc();
    const out = fontFaceRulesFromCss(css, 'https://cdn.other.test/css/site.css', doc);
    expect(created()).toBe(1);
    expect(out.map((r) => r.family)).toEqual(['cross font', 'nested']);
    expect(out[0].urls).toEqual(['https://cdn.other.test/fonts/a.woff2', 'https://cdn.other.test/css/b.woff']);
    expect(out[0].cssText).toContain('url("https://cdn.other.test/fonts/a.woff2") format("woff2")');
    expect(out[0].cssText).toContain('url("https://cdn.other.test/css/b.woff")');
    expect(out[0].cssText).not.toContain('../fonts');
    expect(out[1].urls).toEqual(['https://cdn.other.test/abs/n.ttf', 'data:font/woff2;base64,AAAA']);
    expect(out[1].cssText).toContain('url("https://cdn.other.test/abs/n.ttf")');
  });

  it('gives [] when the CSS has no font faces or the parse document has no sheet', () => {
    const { doc } = fakeDoc();
    expect(fontFaceRulesFromCss('a { color: red }', 'https://x.test/', doc)).toEqual([]);
    // Real jsdom: createHTMLDocument <style> has no sheet → nothing, never a throw.
    expect(fontFaceRulesFromCss(css, 'https://x.test/', document)).toEqual([]);
  });
});

describe('URL_RE / unescapeCss', () => {
  it('match every url() quoting style and unescape CSS escapes', () => {
    const css = `src:url("a\\2e woff2"),url('b.woff'),url( c.ttf )`;
    const raws = Array.from(css.matchAll(URL_RE), (m) => unescapeCss(m[1] ?? m[2] ?? m[3] ?? ''));
    expect(raws).toEqual(['a.woff2', 'b.woff', 'c.ttf']);
    expect(unescapeCss('\\"x\\)')).toBe('"x)');
  });
});
