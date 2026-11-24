// Design tokens for the feedback widget UI — handoff README §6 "Design tokens", verbatim.
// Every UI component styles itself from these constants (or the matching CSS custom
// properties baseSheet() declares on :host); no component hard-codes a colour, size,
// radius or easing.
//
// Strict-CSP rule (DESIGN_SPEC.md §"Decided changes" 3): styles go through constructed
// stylesheets (adoptedStyleSheets) only — never a `style` attribute or a <style>/<link>
// element. Fonts are self-hosted next to feedback.js (DESIGN_SPEC.md §"Decided changes" 2);
// no Google Fonts request is ever made from a customer's page.

/** Colour tokens, keyed by the handoff's token names. */
export const colors = {
  ink: '#1a1612',
  'ink-2': '#3a342b',
  'ink-3': '#5d5648',
  'ink-4': '#9c937f',
  paper: '#f5f0e6',
  'paper-2': '#ede6d6',
  'paper-3': '#e3dcc8',
  field: '#fcfaf5',
  rule: '#d4ccb8',
  'rule-strong': '#c9bfa9',
  accent: '#a83818',
  'accent-hover': '#8f2f14',
  amber: '#f4b942',
  'amber-hover': '#f7c766',
  green: '#2e5a3e',
  'green-text': '#d6e3d9',
  'on-accent': '#fff8ef',
} as const;

export type ColorToken = keyof typeof colors;

/** System fallbacks every stack ends in (taken from the handoff's own stacks). */
export const fallbacks = {
  serif: "Georgia,serif",
  sans: "-apple-system,'Helvetica Neue',Arial,sans-serif",
  mono: 'ui-monospace,monospace',
} as const;

/** Font stacks: headline serif, UI sans, mono for labels/IDs/keys/data. */
export const fonts = {
  serif: `'Source Serif 4',${fallbacks.serif}`,
  sans: `'Inter Tight',${fallbacks.sans}`,
  mono: `'JetBrains Mono',${fallbacks.mono}`,
} as const;

/** Type scale (px) and weights per role. */
export const type = {
  headline: { family: fonts.serif, sizes: [24, 22, 20], weights: [600] },
  ui: { family: fonts.sans, sizes: [15, 14, 13.5, 13, 12.5, 12], weights: [400, 500, 600, 700] },
  mono: { family: fonts.mono, sizes: [12, 11.5, 11, 10.5, 10], weights: [400, 500, 700] },
} as const;

/** Corner radii (px). */
export const radii = [3, 4, 5, 7, 8, 9, 10, 12, 14, 19, 26, 999] as const;

/** Motion: easings and durations (ms). */
export const motion = {
  ease: 'cubic-bezier(.2,.8,.2,1)',
  foldEase: 'cubic-bezier(.5,0,.75,0)',
  durations: [150, 200, 250, 280, 350, 400, 450, 500],
} as const;

// ---------------------------------------------------------------------------------------
// Base stylesheet for the shadow root.

/** CSS custom properties mirroring every token, declared on :host. */
export function tokenCustomProperties(): string {
  const decls: string[] = [];
  for (const [name, value] of Object.entries(colors)) decls.push(`--fw-${name}:${value}`);
  decls.push(`--fw-font-serif:${fonts.serif}`);
  decls.push(`--fw-font-sans:${fonts.sans}`);
  decls.push(`--fw-font-mono:${fonts.mono}`);
  decls.push(`--fw-ease:${motion.ease}`);
  decls.push(`--fw-ease-fold:${motion.foldEase}`);
  return decls.join(';');
}

/** Text of the base sheet: :host{all:initial} (+ token properties) and a local reset. */
export function baseCss(): string {
  return [
    `:host{all:initial;${tokenCustomProperties()}}`,
    `*,*::before,*::after{box-sizing:border-box;margin:0;padding:0;border:0 solid}`,
    `:host,button,input,textarea,select{font-family:${fonts.sans};font-size:14px;line-height:1.4;color:${colors.ink};-webkit-font-smoothing:antialiased}`,
    `button,input,textarea,select{font:inherit;color:inherit;background:none;appearance:none}`,
    `button{cursor:pointer}`,
    `img,svg{display:block;max-width:100%}`,
  ].join('\n');
}

let baseSheetCache: CSSStyleSheet | null = null;

/** The one constructed base stylesheet, for a shadow root's adoptedStyleSheets. */
export function baseSheet(): CSSStyleSheet {
  if (!baseSheetCache) {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(baseCss());
    baseSheetCache = sheet;
  }
  return baseSheetCache;
}

// ---------------------------------------------------------------------------------------
// Self-hosted fonts. @font-face does not work inside shadow roots in Chromium, so the
// faces go on document.adoptedStyleSheets (never a <link>/<style> in <head>).

export interface FontFaceSpec {
  /** @fontsource package the woff2 comes from (devDependency). */
  pkg: string;
  family: string;
  weight: number;
  /** File name under the package's files/ folder and under dist/fonts/. */
  file: string;
}

function face(pkg: string, family: string, weight: number): FontFaceSpec {
  const slug = pkg.replace('@fontsource/', '');
  return { pkg, family, weight, file: `${slug}-latin-${weight}-normal.woff2` };
}

/** Every face the widget loads (latin subset only). vite.config.ts copies these files. */
export const FONT_FACES: readonly FontFaceSpec[] = [
  face('@fontsource/source-serif-4', 'Source Serif 4', 600),
  face('@fontsource/inter-tight', 'Inter Tight', 400),
  face('@fontsource/inter-tight', 'Inter Tight', 500),
  face('@fontsource/inter-tight', 'Inter Tight', 600),
  face('@fontsource/inter-tight', 'Inter Tight', 700),
  face('@fontsource/jetbrains-mono', 'JetBrains Mono', 400),
  face('@fontsource/jetbrains-mono', 'JetBrains Mono', 500),
  face('@fontsource/jetbrains-mono', 'JetBrains Mono', 700),
];

/** Folder (relative to feedback.js) the build copies the woff2 files into. */
export const FONTS_DIR = 'fonts/';

// Captured while the IIFE executes — document.currentScript is null afterwards.
const SCRIPT_SRC_AT_LOAD: string | undefined =
  typeof document !== 'undefined' && document.currentScript instanceof HTMLScriptElement
    ? document.currentScript.src || undefined
    : undefined;

/** src of the script that loaded the widget, else the document base. */
export function ownScriptSrc(): string {
  if (SCRIPT_SRC_AT_LOAD) return SCRIPT_SRC_AT_LOAD;
  const tag = document.querySelector<HTMLScriptElement>(
    'script[data-key][src], script[data-project][src]',
  );
  return tag?.src || document.baseURI;
}

/** @font-face rules for FONT_FACES, URLs resolved against `scriptSrc`. */
export function fontFaceCss(scriptSrc: string): string {
  const base = new URL(FONTS_DIR, scriptSrc);
  return FONT_FACES.map(
    (f) =>
      `@font-face{font-family:'${f.family}';font-style:normal;font-weight:${f.weight};` +
      `font-display:swap;src:url(${JSON.stringify(new URL(f.file, base).href)}) format('woff2')}`,
  ).join('\n');
}

let fontSheet: CSSStyleSheet | null = null;

/**
 * Adds the widget's @font-face rules to document.adoptedStyleSheets, once. Without
 * constructable stylesheets it does nothing (the stacks' system fallbacks apply) — it never
 * falls back to a <style> or <link> element (strict CSP).
 */
export function loadFonts(scriptSrc: string = ownScriptSrc()): void {
  if (typeof document === 'undefined' || typeof CSSStyleSheet !== 'function') return;
  if (!('adoptedStyleSheets' in document)) return;
  if (fontSheet && document.adoptedStyleSheets.includes(fontSheet)) return;
  try {
    if (!fontSheet) {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(fontFaceCss(scriptSrc));
      fontSheet = sheet;
    }
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, fontSheet];
  } catch {
    // Constructable stylesheets unusable — system fallbacks apply.
  }
}

/** Test hook: forget the cached sheets. */
export function resetTokensForTests(): void {
  fontSheet = null;
  baseSheetCache = null;
}
