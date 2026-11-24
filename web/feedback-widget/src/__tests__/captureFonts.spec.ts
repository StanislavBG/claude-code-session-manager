// capture.ts font embedding: usedFamilies + extraFontCss (fontSheets/fontProbe mocked).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  coveredFamilies: vi.fn(() => new Set<string>()),
  declaredFontUrls: vi.fn(() => new Set<string>()),
  sheetFontCss: vi.fn(async () => ({ cssText: '', families: new Set<string>(), urls: new Set<string>() })),
  apiFontCss: vi.fn(async () => ({ cssText: '', families: new Set<string>() })),
}));

vi.mock('../fontSheets', () => ({
  coveredFamilies: mocks.coveredFamilies,
  declaredFontUrls: mocks.declaredFontUrls,
  sheetFontCss: mocks.sheetFontCss,
}));
vi.mock('../fontProbe', () => ({ apiFontCss: mocks.apiFontCss }));

import { FONT_BUDGET_MS, extraFontCss, resetFontWarningsForTests, usedFamilies } from '../capture';

function setFonts(families: string[]): void {
  const faces = families.map((family) => ({ family, status: 'loaded' }));
  Object.defineProperty(document, 'fonts', {
    configurable: true,
    value: { forEach: (cb: (f: unknown) => void) => faces.forEach(cb) },
  });
}

function el(tag: string, family: string, text?: string): HTMLElement {
  const e = document.createElement(tag);
  e.style.fontFamily = family;
  if (text) e.textContent = text;
  return e;
}

let warn: ReturnType<typeof vi.spyOn>;
let error: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  document.body.innerHTML = '';
  resetFontWarningsForTests();
  mocks.coveredFamilies.mockReset().mockReturnValue(new Set());
  mocks.declaredFontUrls.mockReset().mockReturnValue(new Set());
  mocks.sheetFontCss
    .mockReset()
    .mockResolvedValue({ cssText: '', families: new Set(), urls: new Set() });
  mocks.apiFontCss.mockReset().mockResolvedValue({ cssText: '', families: new Set() });
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  error = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  warn.mockRestore();
  error.mockRestore();
  delete (document as unknown as { fonts?: unknown }).fonts;
});

describe('usedFamilies', () => {
  it('collects text and form-control families, drops generics, skips the host subtree', () => {
    const host = document.createElement('div');
    host.appendChild(el('span', '"Widget Font", sans-serif', 'widget'));
    document.body.append(
      el('p', '"Mahjong Display", serif', 'Hello'),
      el('div', 'Ghost', '   '),
      el('input', 'Field Font'),
      el('button', 'monospace'),
      host,
    );
    const got = usedFamilies(document.body, host);
    expect(got.has('mahjong display')).toBe(true);
    expect(got.has('field font')).toBe(true);
    expect(got.has('widget font')).toBe(false);
    expect(got.has('ghost')).toBe(false);
    expect(got.has('serif')).toBe(false);
    expect(got.has('monospace')).toBe(false);
  });

  it('includes textarea and select', () => {
    document.body.append(el('textarea', 'Area Font'), el('select', 'Pick Font'));
    const got = usedFamilies(document.body, null);
    expect([...got].sort()).toEqual(['area font', 'pick font']);
  });
});

describe('extraFontCss', () => {
  beforeEach(() => {
    document.body.append(el('p', 'Alpha', 'a'), el('p', 'Beta', 'b'), el('p', 'Gamma', 'c'));
    setFonts(['Alpha', 'Beta', 'Gamma']);
  });

  it('exports a 3 s budget', () => {
    expect(FONT_BUDGET_MS).toBe(3000);
  });

  it('returns empty at once when every family is covered', async () => {
    mocks.coveredFamilies.mockReturnValue(new Set(['alpha', 'beta', 'gamma']));
    expect(await extraFontCss(null)).toEqual({ cssText: '', missing: [] });
    expect(mocks.sheetFontCss).not.toHaveBeenCalled();
    expect(mocks.apiFontCss).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it('ignores families with no face in document.fonts', async () => {
    setFonts(['Alpha']);
    mocks.coveredFamilies.mockReturnValue(new Set(['alpha']));
    expect(await extraFontCss(null)).toEqual({ cssText: '', missing: [] });
    expect(mocks.sheetFontCss).not.toHaveBeenCalled();
  });

  it('uses the sheet result before the API, passes the exclude set, lists missing', async () => {
    mocks.declaredFontUrls.mockReturnValue(new Set(['https://x/declared.woff2']));
    mocks.sheetFontCss.mockResolvedValue({
      cssText: '@font-face{font-family:"Alpha"}',
      families: new Set(['alpha']),
      urls: new Set(['https://x/alpha.woff2']),
    });
    mocks.apiFontCss.mockResolvedValue({ cssText: '@font-face{font-family:"Beta"}', families: new Set(['beta']) });
    const out = await extraFontCss(null);
    expect((mocks.sheetFontCss.mock.calls[0] as unknown as [Set<string>])[0]).toEqual(new Set(['alpha', 'beta', 'gamma']));
    const [fams, opts] = mocks.apiFontCss.mock.calls[0] as unknown as [Set<string>, { exclude: Set<string>; budgetMs: number }];
    expect(fams).toEqual(new Set(['beta', 'gamma']));
    expect(opts.exclude).toEqual(new Set(['https://x/declared.woff2', 'https://x/alpha.woff2']));
    expect(opts.budgetMs).toBeLessThanOrEqual(FONT_BUDGET_MS);
    expect(out.cssText).toBe('@font-face{font-family:"Alpha"}\n@font-face{font-family:"Beta"}');
    expect(out.missing).toEqual(['gamma']);
  });

  it('skips the API when the sheets resolve everything', async () => {
    mocks.sheetFontCss.mockResolvedValue({
      cssText: 'css',
      families: new Set(['alpha', 'beta', 'gamma']),
      urls: new Set(),
    });
    expect(await extraFontCss(null)).toEqual({ cssText: 'css', missing: [] });
    expect(mocks.apiFontCss).not.toHaveBeenCalled();
  });

  it('warns once per set of missing families, never console.error', async () => {
    await extraFontCss(null);
    await extraFontCss(null);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toBe(
      '[feedback-widget] screenshot fonts not embedded: alpha, beta, gamma. Declare them with @font-face in a stylesheet the page can read.',
    );
    setFonts(['Alpha']);
    await extraFontCss(null);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(error).not.toHaveBeenCalled();
  });

  it('still resolves when a dependency rejects or throws', async () => {
    mocks.sheetFontCss.mockRejectedValue(new Error('boom'));
    mocks.apiFontCss.mockRejectedValue(new Error('boom'));
    mocks.declaredFontUrls.mockImplementation(() => {
      throw new Error('boom');
    });
    expect(await extraFontCss(null)).toEqual({ cssText: '', missing: ['alpha', 'beta', 'gamma'] });
    mocks.coveredFamilies.mockImplementation(() => {
      throw new Error('boom');
    });
    await expect(extraFontCss(null)).resolves.toEqual({ cssText: '', missing: [] });
  });

  it('never exceeds the budget when a dependency hangs', async () => {
    mocks.sheetFontCss.mockReturnValue(new Promise(() => {}) as never);
    const t0 = Date.now();
    const out = await extraFontCss(null, 50);
    expect(Date.now() - t0).toBeLessThan(500);
    expect(out).toEqual({ cssText: '', missing: ['alpha', 'beta', 'gamma'] });
    expect(mocks.apiFontCss).not.toHaveBeenCalled();
  });
});
