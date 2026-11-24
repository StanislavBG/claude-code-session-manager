import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  FONT_FACES,
  baseCss,
  baseSheet,
  colors,
  fallbacks,
  fontFaceCss,
  fonts,
  loadFonts,
  motion,
  radii,
  resetTokensForTests,
  type,
} from '../ui/tokens';

const root = resolve(__dirname, '../..') + '/';

// jsdom has constructable CSSStyleSheet but no document.adoptedStyleSheets; shim the
// accessor so loadFonts takes its real (browser) path.
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
  document.adoptedStyleSheets = [];
  document.head.innerHTML = '';
});

describe('handoff §6 tokens', () => {
  it('colours match the table exactly', () => {
    expect(colors).toEqual({
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
    });
  });

  it('type scale and weights match', () => {
    expect(type.headline.sizes).toEqual([24, 22, 20]);
    expect(type.headline.weights).toEqual([600]);
    expect(type.ui.sizes).toEqual([15, 14, 13.5, 13, 12.5, 12]);
    expect(type.ui.weights).toEqual([400, 500, 600, 700]);
    expect(type.mono.sizes).toEqual([12, 11.5, 11, 10.5, 10]);
    expect(type.mono.weights).toEqual([400, 500, 700]);
  });

  it('radii and motion match', () => {
    expect(radii).toEqual([3, 4, 5, 7, 8, 9, 10, 12, 14, 19, 26, 999]);
    expect(motion.ease).toBe('cubic-bezier(.2,.8,.2,1)');
    expect(motion.foldEase).toBe('cubic-bezier(.5,0,.75,0)');
    expect(motion.durations).toEqual([150, 200, 250, 280, 350, 400, 450, 500]);
  });

  it('every font stack leads with its face and ends in the system fallbacks', () => {
    expect(fonts.serif.startsWith("'Source Serif 4',")).toBe(true);
    expect(fonts.serif.endsWith('Georgia,serif')).toBe(true);
    expect(fonts.sans.startsWith("'Inter Tight',")).toBe(true);
    expect(fonts.sans.endsWith(fallbacks.sans)).toBe(true);
    expect(fonts.sans.endsWith('sans-serif')).toBe(true);
    expect(fonts.mono.startsWith("'JetBrains Mono',")).toBe(true);
    expect(fonts.mono.endsWith('ui-monospace,monospace')).toBe(true);
    for (const t of Object.values(type)) expect(Object.values(fonts)).toContain(t.family);
  });
});

describe('baseSheet', () => {
  it('returns one constructed sheet with :host{all:initial} and a local reset', () => {
    const a = baseSheet();
    expect(a).toBeInstanceOf(CSSStyleSheet);
    expect(baseSheet()).toBe(a);
    expect(baseCss()).toMatch(/^:host\{all:initial;/);
    expect(baseCss()).toContain('*,*::before,*::after{box-sizing:border-box;margin:0;padding:0');
    expect(baseCss()).toContain(`--fw-accent:${colors.accent}`);
    expect(a.cssRules.length).toBeGreaterThan(1);
  });
});

describe('fonts', () => {
  it('lists exactly the handoff faces, all latin woff2 present in @fontsource', () => {
    expect(FONT_FACES.map((f) => `${f.family} ${f.weight}`)).toEqual([
      'Source Serif 4 600',
      'Inter Tight 400',
      'Inter Tight 500',
      'Inter Tight 600',
      'Inter Tight 700',
      'JetBrains Mono 400',
      'JetBrains Mono 500',
      'JetBrains Mono 700',
    ]);
    for (const f of FONT_FACES) {
      expect(f.file).toMatch(/-latin-\d00-normal\.woff2$/);
      expect(existsSync(`${root}node_modules/${f.pkg}/files/${f.file}`)).toBe(true);
    }
  });

  it('resolves font URLs against the script src, never Google Fonts', () => {
    const css = fontFaceCss('https://bilko.run/projects/session-manager/widget/v1/feedback.js');
    for (const f of FONT_FACES) {
      expect(css).toContain(
        `url("https://bilko.run/projects/session-manager/widget/v1/fonts/${f.file}")`,
      );
    }
    expect(css.match(/@font-face/g)).toHaveLength(FONT_FACES.length);
    expect(css).not.toMatch(/googleapis|gstatic/);
  });

  it('loadFonts adopts one sheet on the document, once, with no <link>/<style>', () => {
    loadFonts('https://cdn.example.com/w/feedback.js');
    loadFonts('https://cdn.example.com/w/feedback.js');
    loadFonts();
    expect(document.adoptedStyleSheets).toHaveLength(1);
    expect(document.querySelectorAll('link, style')).toHaveLength(0);
  });

  it('no Google Fonts URL anywhere in the widget source', () => {
    const src = readFileSync(`${root}src/ui/tokens.ts`, 'utf8');
    expect(src).not.toMatch(/fonts\.googleapis|fonts\.gstatic/);
  });
});
