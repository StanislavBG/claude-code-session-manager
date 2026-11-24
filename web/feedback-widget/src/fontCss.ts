// Pure helpers for embedding page fonts the screenshot rasteriser misses.
//
// modern-screenshot (4.7.0, embedWebFont) only embeds @font-face rules it can read from
// document.styleSheets. Fonts loaded with the FontFace API, from cross-origin no-CORS
// stylesheets or from document.adoptedStyleSheets render as system fonts, and text reflows.
// These helpers parse, normalise and write @font-face text so callers can fill that gap.
//
// No DOM access at import time; only fontFaceRulesFromCss touches a Document — the one passed in.

/** Unquoted CSS generic family keywords (never a downloadable face). Lowercase. */
const GENERIC_FAMILIES = new Set([
  'serif',
  'sans-serif',
  'monospace',
  'cursive',
  'fantasy',
  'system-ui',
  'ui-serif',
  'ui-sans-serif',
  'ui-monospace',
  'ui-rounded',
  'emoji',
  'math',
  'fangsong',
  '-apple-system',
  'blinkmacsystemfont',
]);

/** Trim, strip one pair of matching quotes, collapse inner whitespace, lowercase. */
export function normalizeFamily(name: string): string {
  let s = name.trim();
  if (s.length >= 2) {
    const q = s[0];
    if ((q === '"' || q === "'") && s[s.length - 1] === q) s = s.slice(1, -1);
  }
  return s.replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * Splits a (computed) font-family value on top-level commas, respecting quotes, and
 * normalises each name. Unquoted CSS generic families are dropped; a quoted name that
 * spells one ("serif") is a real family name and is kept.
 */
export function splitFamilyList(value: string): string[] {
  const parts: string[] = [];
  let cur = '';
  let quote: string | null = null;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (ch === '\\' && i + 1 < value.length) {
      cur += ch + value[++i];
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
    } else if (ch === ',') {
      parts.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  parts.push(cur);
  const out: string[] = [];
  for (const raw of parts) {
    const t = raw.trim();
    if (!t) continue;
    const quoted = t[0] === '"' || t[0] === "'";
    const name = normalizeFamily(t);
    if (!name) continue;
    if (!quoted && GENERIC_FAMILIES.has(name)) continue;
    out.push(name);
  }
  return out;
}

const MAX_CODE_POINT = 0x10ffff;

/**
 * Parses a unicode-range descriptor ('U+0-FF, U+131, U+4??'). Invalid tokens are skipped;
 * empty or wholly invalid input gives the full range [[0, 0x10FFFF]].
 */
export function parseUnicodeRange(value: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const token of value.split(',')) {
    const t = token.trim();
    let m = /^u\+([0-9a-f]{1,6})-([0-9a-f]{1,6})$/i.exec(t);
    let lo: number;
    let hi: number;
    if (m) {
      lo = parseInt(m[1], 16);
      hi = parseInt(m[2], 16);
    } else if ((m = /^u\+([0-9a-f?]{1,6})$/i.exec(t)) && /^[0-9a-f]*\?*$/i.test(m[1])) {
      lo = parseInt(m[1].replace(/\?/g, '0'), 16);
      hi = parseInt(m[1].replace(/\?/g, 'f'), 16);
    } else {
      continue;
    }
    if (lo > MAX_CODE_POINT) continue;
    hi = Math.min(hi, MAX_CODE_POINT);
    if (lo > hi) continue;
    out.push([lo, hi]);
  }
  return out.length ? out : [[0, MAX_CODE_POINT]];
}

/** True for code points that draw no glyph worth probing a font with. */
function unprintable(cp: number): boolean {
  return (
    cp <= 0x20 || // C0 controls + space
    (cp >= 0x7f && cp <= 0xa0) || // DEL, C1 controls, NBSP
    cp === 0xad || // soft hyphen
    (cp >= 0x300 && cp <= 0x36f) || // combining diacritical marks
    (cp >= 0xd800 && cp <= 0xdfff) || // surrogates
    (cp >= 0x200b && cp <= 0x200f) || // zero-width + direction marks
    (cp >= 0x2028 && cp <= 0x202f) || // separators, bidi embeddings, narrow NBSP
    (cp >= 0x2060 && cp <= 0x206f) || // invisible operators, bidi isolates
    (cp >= 0xfe00 && cp <= 0xfe0f) || // variation selectors
    cp === 0xfeff || // BOM / ZWNBSP
    (cp >= 0xfdd0 && cp <= 0xfdef) || // noncharacters
    (cp & 0xfffe) === 0xfffe // U+xFFFE / U+xFFFF noncharacters
  );
}

const PREFERRED: readonly number[] = (() => {
  const list: number[] = [];
  for (let c = 0x41; c <= 0x5a; c++) list.push(c); // A-Z
  for (let c = 0x61; c <= 0x7a; c++) list.push(c); // a-z
  for (let c = 0x30; c <= 0x39; c++) list.push(c); // 0-9
  return list;
})();

/**
 * Up to `max` printable code points inside `ranges`: A-Z a-z 0-9 first (in that order),
 * then the rest ascending.
 */
export function sampleCodePoints(ranges: Array<[number, number]>, max = 12): number[] {
  if (max <= 0) return [];
  const sorted = ranges
    .map(([lo, hi]): [number, number] => [Math.max(0, lo), Math.min(MAX_CODE_POINT, hi)])
    .filter(([lo, hi]) => lo <= hi)
    .sort((a, b) => a[0] - b[0]);
  const inRanges = (cp: number) => sorted.some(([lo, hi]) => cp >= lo && cp <= hi);
  const out: number[] = [];
  const seen = new Set<number>();
  for (const cp of PREFERRED) {
    if (out.length >= max) return out;
    if (inRanges(cp)) {
      out.push(cp);
      seen.add(cp);
    }
  }
  for (const [lo, hi] of sorted) {
    for (let cp = lo; cp <= hi; cp++) {
      if (out.length >= max) return out;
      if (cp >= 0xd800 && cp <= 0xdfff) {
        cp = 0xdfff; // skip the surrogate block in one step
        continue;
      }
      if (seen.has(cp) || unprintable(cp)) continue;
      out.push(cp);
      seen.add(cp);
    }
  }
  return out;
}

/** True when the URL's pathname ends in a font extension (query and hash ignored). */
export function isFontUrl(url: string): boolean {
  let path: string;
  try {
    path = new URL(url, 'http://font-url.invalid/').pathname;
  } catch {
    path = url.split(/[?#]/)[0];
  }
  return /\.(woff2|woff|ttf|otf|eot)$/i.test(path);
}

function magicMime(buf: ArrayBuffer): string | null {
  if (buf.byteLength < 4) return null;
  const b = new Uint8Array(buf, 0, 4);
  const tag = String.fromCharCode(b[0], b[1], b[2], b[3]);
  switch (tag) {
    case 'wOF2':
      return 'font/woff2';
    case 'wOFF':
      return 'font/woff';
    case '\x00\x01\x00\x00':
    case 'true':
      return 'font/ttf';
    case 'OTTO':
      return 'font/otf';
    case 'ttcf':
      return 'font/collection';
    default:
      return null;
  }
}

/** True when the first 4 bytes are a WOFF2, WOFF, TrueType, OpenType or collection signature. */
export function isFontBytes(buf: ArrayBuffer): boolean {
  return magicMime(buf) !== null;
}

const BASE64_CHUNK = 32768;

/** base64 data URL for `buf`, mime from its magic bytes (application/octet-stream if none). */
export function bytesToDataUrl(buf: ArrayBuffer): string {
  const mime = magicMime(buf) ?? 'application/octet-stream';
  const bytes = new Uint8Array(buf);
  const pieces: string[] = [];
  for (let i = 0; i < bytes.length; i += BASE64_CHUNK) {
    pieces.push(String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + BASE64_CHUNK))));
  }
  return `data:${mime};base64,${btoa(pieces.join(''))}`;
}

/** A CSS double-quoted string; backslash, quote and line breaks escaped. */
function cssString(s: string): string {
  return `"${s
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\a ')
    .replace(/\r/g, '\\d ')
    .replace(/\f/g, '\\c ')}"`;
}

export interface FontFaceInput {
  family: string;
  weight?: string | number;
  style?: string;
  stretch?: string;
  unicodeRange?: string;
  featureSettings?: string;
}

function present(v: string | number | undefined, initial: RegExp): v is string | number {
  if (v === undefined || v === null) return false;
  const s = String(v).trim();
  return s !== '' && !initial.test(s);
}

const NORMAL = /^normal$/i;
const FULL_RANGE = /^u\+0{1,6}-10ffff$/i;

/**
 * One @font-face rule. Family and src url are double-quoted and escaped; descriptors that
 * are absent or equal their initial value (normal, U+0-10FFFF) are omitted.
 */
export function fontFaceRule(face: FontFaceInput, src: string): string {
  let css = `@font-face{font-family:${cssString(face.family)};src:url(${cssString(src)})`;
  if (present(face.weight, NORMAL)) css += `;font-weight:${String(face.weight).trim()}`;
  if (present(face.style, NORMAL)) css += `;font-style:${String(face.style).trim()}`;
  if (present(face.stretch, NORMAL)) css += `;font-stretch:${String(face.stretch).trim()}`;
  if (present(face.unicodeRange, FULL_RANGE)) css += `;unicode-range:${String(face.unicodeRange).trim()}`;
  if (present(face.featureSettings, NORMAL)) {
    css += `;font-feature-settings:${String(face.featureSettings).trim()}`;
  }
  return `${css}}`;
}

export interface ParsedFontFace {
  family: string;
  cssText: string;
  urls: string[];
}

export const URL_RE = /url\(\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|([^)"'\s]*))\s*\)/gi;
const FONT_FACE_RULE = 5; // CSSRule.FONT_FACE_RULE — compared by number, works across realms.

export function unescapeCss(s: string): string {
  return s.replace(/\\([0-9a-f]{1,6})\s?|\\(.)/gi, (_m, hex: string | undefined, ch: string | undefined) =>
    hex ? String.fromCodePoint(Math.min(parseInt(hex, 16), MAX_CODE_POINT)) : (ch ?? ''),
  );
}

function absolutize(cssText: string, baseUrl: string): { cssText: string; urls: string[] } {
  const urls: string[] = [];
  const out = cssText.replace(URL_RE, (whole, dq?: string, sq?: string, bare?: string) => {
    const raw = unescapeCss(dq ?? sq ?? bare ?? '');
    let abs: string;
    try {
      abs = new URL(raw, baseUrl).href;
    } catch {
      return whole;
    }
    if (!urls.includes(abs)) urls.push(abs);
    return `url(${cssString(abs)})`;
  });
  return { cssText: out, urls };
}

/**
 * Parses `cssText` through a <style> in a fresh doc.implementation.createHTMLDocument
 * (never the live page) and returns every @font-face rule — at any nesting depth — whose
 * src has a url(), each url() rewritten absolute against `baseUrl`.
 */
export function fontFaceRulesFromCss(
  cssText: string,
  baseUrl: string,
  doc: Document = document,
): ParsedFontFace[] {
  const tmp = doc.implementation.createHTMLDocument('');
  const style = tmp.createElement('style');
  style.textContent = cssText;
  tmp.head.appendChild(style);
  let rules: CSSRuleList | undefined;
  try {
    rules = style.sheet?.cssRules;
  } catch {
    return [];
  }
  const out: ParsedFontFace[] = [];
  const walk = (list: ArrayLike<CSSRule>) => {
    for (let i = 0; i < list.length; i++) {
      const rule = list[i];
      if (rule.type === FONT_FACE_RULE) {
        const decl = (rule as CSSFontFaceRule).style;
        const src = decl?.getPropertyValue('src') ?? '';
        if (!/url\(/i.test(src)) continue;
        const { cssText: text, urls } = absolutize(rule.cssText, baseUrl);
        out.push({ family: normalizeFamily(decl.getPropertyValue('font-family')), cssText: text, urls });
        continue;
      }
      const nested = (rule as Partial<CSSGroupingRule>).cssRules;
      if (nested) walk(nested);
    }
  };
  if (rules) walk(rules);
  return out;
}
