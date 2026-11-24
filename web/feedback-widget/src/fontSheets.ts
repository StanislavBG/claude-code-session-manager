// Stylesheet fonts the screenshot rasteriser cannot see.
//
// modern-screenshot 4.7.0 (embedWebFont) embeds @font-face rules from readable
// document.styleSheets — recursing into grouping rules and @import — and skips any sheet whose
// cssRules throws (a cross-origin no-CORS link, such as the standard Google Fonts one). It never
// reads document.adoptedStyleSheets. coveredFamilies/declaredFontUrls say what the library
// already embeds; sheetFontCss builds data-URL @font-face CSS for the rest.
//
// Read-only over the live page: no <style>/<link> element, no adoptedStyleSheets change
// (strict CSP, see capture.ts header). Parsing happens in a detached document (fontCss.ts).

import { URL_RE, bytesToDataUrl, fontFaceRulesFromCss, isFontBytes, normalizeFamily, unescapeCss } from './fontCss';
import { fetchBytesCached, fetchTextCached } from './fontFetch';
import { widgetFontSheet } from './ui/tokens';

const FONT_FACE_RULE = 5; // CSSRule.FONT_FACE_RULE — by number, works across realms.

type RuleLike = {
  type?: number;
  style?: CSSStyleDeclaration;
  cssText?: string;
  cssRules?: ArrayLike<RuleLike>;
  styleSheet?: SheetLike | null;
};
type SheetLike = { href?: string | null; cssRules?: ArrayLike<RuleLike> };

function readRules(sheet: SheetLike | null | undefined): ArrayLike<RuleLike> | null {
  if (!sheet) return null;
  try {
    return sheet.cssRules ?? null;
  } catch {
    return null; // cross-origin without CORS: SecurityError
  }
}

function urlsIn(text: string, base: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(URL_RE)) {
    const raw = unescapeCss(m[1] ?? m[2] ?? m[3] ?? '');
    if (!raw) continue;
    try {
      const abs = new URL(raw, base).href;
      if (!out.includes(abs)) out.push(abs);
    } catch {
      // unresolvable url() — ignore
    }
  }
  return out;
}

/** Calls `visit(family, srcUrls)` for every url()-bearing @font-face in readable doc.styleSheets. */
function walkReadable(doc: Document, visit: (family: string, urls: string[]) => void): void {
  const seen = new Set<unknown>();
  const walk = (rules: ArrayLike<RuleLike>, base: string) => {
    for (let i = 0; i < rules.length; i++) {
      const rule = rules[i];
      if (!rule) continue;
      if (rule.type === FONT_FACE_RULE) {
        const src = rule.style?.getPropertyValue('src') ?? '';
        if (!/url\(/i.test(src)) continue;
        const family = normalizeFamily(rule.style?.getPropertyValue('font-family') ?? '');
        visit(family, urlsIn(src, base));
        continue;
      }
      if (rule.styleSheet) {
        const imported = rule.styleSheet;
        if (seen.has(imported)) continue;
        seen.add(imported);
        const inner = readRules(imported);
        if (inner) walk(inner, imported.href || base);
        continue;
      }
      let nested: ArrayLike<RuleLike> | undefined;
      try {
        nested = rule.cssRules;
      } catch {
        nested = undefined;
      }
      if (nested) walk(nested, base);
    }
  };
  let sheets: ArrayLike<SheetLike>;
  try {
    sheets = doc.styleSheets as unknown as ArrayLike<SheetLike>;
  } catch {
    return;
  }
  for (let i = 0; i < (sheets?.length ?? 0); i++) {
    const sheet = sheets[i];
    if (!sheet || seen.has(sheet)) continue;
    seen.add(sheet);
    const rules = readRules(sheet);
    if (rules) walk(rules, sheet.href || doc.baseURI);
  }
}

/** Normalised families of every url()-bearing @font-face modern-screenshot can read. */
export function coveredFamilies(doc: Document = document): Set<string> {
  const out = new Set<string>();
  walkReadable(doc, (family) => {
    if (family) out.add(family);
  });
  return out;
}

/** Absolute url() targets of those same readable @font-face rules. */
export function declaredFontUrls(doc: Document = document): Set<string> {
  const out = new Set<string>();
  walkReadable(doc, (_family, urls) => {
    for (const u of urls) out.add(u);
  });
  return out;
}

type Fetcher<T> = (url: string) => Promise<T | null>;

const defaultFetchText: Fetcher<string> = (url) => fetchTextCached(url);
const defaultFetchBytes: Fetcher<ArrayBuffer> = (url) => fetchBytesCached(url, 'omit');

function safe<T>(fn: Fetcher<T>): Fetcher<T> {
  return async (url) => {
    try {
      return (await fn(url)) ?? null;
    } catch {
      return null;
    }
  };
}

export interface SheetFontOptions {
  doc?: Document;
  fetchText?: (url: string) => Promise<string | null>;
  fetchBytes?: (url: string) => Promise<ArrayBuffer | null>;
}

export interface SheetFontResult {
  cssText: string;
  families: Set<string>;
  urls: Set<string>;
}

/**
 * Data-URL @font-face CSS for `families`, from the sheets modern-screenshot skips:
 * doc.adoptedStyleSheets (minus the widget's own) and unreadable doc.styleSheets with an href
 * (re-fetched as text). A rule keeps only if at least one url() fetched as font bytes.
 * Never rejects.
 */
export async function sheetFontCss(
  families: Set<string>,
  opts: SheetFontOptions = {},
): Promise<SheetFontResult> {
  const result: SheetFontResult = { cssText: '', families: new Set(), urls: new Set() };
  try {
    const doc = opts.doc ?? document;
    const fetchText = safe(opts.fetchText ?? defaultFetchText);
    const fetchBytesRaw = safe(opts.fetchBytes ?? defaultFetchBytes);
    const byteCalls = new Map<string, Promise<ArrayBuffer | null>>();
    const fetchBytes = (url: string) => {
      let p = byteCalls.get(url);
      if (!p) byteCalls.set(url, (p = fetchBytesRaw(url)));
      return p;
    };
    const wanted = new Set(Array.from(families, normalizeFamily));
    if (!wanted.size) return result;

    const parsed: Array<Promise<ReturnType<typeof fontFaceRulesFromCss>>> = [];

    const own = widgetFontSheet();
    let adopted: ArrayLike<SheetLike> = [];
    try {
      adopted = (doc.adoptedStyleSheets as unknown as ArrayLike<SheetLike>) ?? [];
    } catch {
      adopted = [];
    }
    for (let i = 0; i < adopted.length; i++) {
      const sheet = adopted[i];
      if (!sheet || sheet === (own as unknown)) continue;
      const rules = readRules(sheet);
      if (!rules) continue;
      const parts: string[] = [];
      for (let j = 0; j < rules.length; j++) {
        const t = rules[j]?.cssText;
        if (t) parts.push(t);
      }
      parsed.push(Promise.resolve(fontFaceRulesFromCss(parts.join('\n'), doc.baseURI, doc)));
    }

    let sheets: ArrayLike<SheetLike> = [];
    try {
      sheets = (doc.styleSheets as unknown as ArrayLike<SheetLike>) ?? [];
    } catch {
      sheets = [];
    }
    const hrefs = new Set<string>();
    for (let i = 0; i < sheets.length; i++) {
      const sheet = sheets[i];
      if (!sheet || readRules(sheet)) continue;
      const href = sheet.href;
      if (!href || hrefs.has(href)) continue;
      hrefs.add(href);
      parsed.push(
        fetchText(href).then((text) => (text ? fontFaceRulesFromCss(text, href, doc) : [])),
      );
    }

    const lists = await Promise.all(parsed.map((p) => p.catch(() => [])));
    const rules = lists.flat().filter((r) => wanted.has(r.family));

    const emitted = await Promise.all(
      rules.map(async (rule) => {
        for (const u of rule.urls) result.urls.add(u);
        const data = new Map<string, string>();
        await Promise.all(
          rule.urls.map(async (u) => {
            const bytes = await fetchBytes(u);
            if (bytes && isFontBytes(bytes)) data.set(u, bytesToDataUrl(bytes));
          }),
        );
        if (!data.size) return null;
        const css = rule.cssText.replace(URL_RE, (whole, dq?: string, sq?: string, bare?: string) => {
          const raw = unescapeCss(dq ?? sq ?? bare ?? '');
          const hit = data.get(raw);
          return hit ? `url("${hit}")` : whole;
        });
        return { family: rule.family, css };
      }),
    );

    const out: string[] = [];
    for (const e of emitted) {
      if (!e) continue;
      out.push(e.css);
      result.families.add(e.family);
    }
    result.cssText = out.join('\n');
    return result;
  } catch {
    return result;
  }
}
