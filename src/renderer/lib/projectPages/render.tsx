// Stage 0 renderer: turns a ProjectPageSummary + ProjectPagePicks into 3
// fully self-contained static HTML documents (inline CSS, locally-hosted
// fonts as base64 data: URIs, zero network calls, zero client-side JS).
// No live React recomposition inside the app — this is the pure function
// session-manager-operations/architecture/project-pages-pipeline.md's Stage 0
// section describes, precompiled by scripts/build-project-pages-renderer.mjs
// into scripts/render-project-pages/dist/renderer.cjs for the CLI to require.
//
// Fonts: only the Latin-subset woff2 for each family/weight actually used by
// the library is embedded (Geist 400-700, IBM Plex Mono 400/500/600,
// Newsreader 400-700 normal) — the saved bundle also ships cyrillic/greek/
// vietnamese subsets for the same families, which are dropped since every
// slot/variant in this library renders English copy only. This is a
// deliberate reduced-but-real embedding, not the "system fallback, no
// embedded font data" alternative the PRD allows — see fonts/ for the
// extracted files.
import { renderToStaticMarkup } from 'react-dom/server';
import { LENS_LIBRARY, LENS_ORDER } from './library';
import type { LensId } from './library';
import { PK } from './library/kit';
import { FONT_DATA } from './library/fontData';
import type { ProjectPageSummary, ProjectPagePicks } from './summaryType';

function fontFace(family: string, weight: string, filename: string): string {
  const base64 = FONT_DATA[filename];
  if (!base64) throw new Error(`Missing font data for ${filename} — rerun scripts/generate-project-pages-font-data.mjs`);
  return `@font-face{font-family:'${family}';font-style:normal;font-weight:${weight};font-display:swap;src:url(data:font/woff2;base64,${base64}) format('woff2');}`;
}

function buildFontFaces(): string {
  return [
    fontFace('Geist', '400 700', 'geist-400-700.woff2'),
    fontFace('IBM Plex Mono', '400', 'ibm-plex-mono-400.woff2'),
    fontFace('IBM Plex Mono', '500', 'ibm-plex-mono-500.woff2'),
    fontFace('IBM Plex Mono', '600', 'ibm-plex-mono-600.woff2'),
    fontFace('Newsreader', '400 700', 'newsreader-400-700.woff2'),
  ].join('\n');
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderLensBody(lensId: LensId, summary: ProjectPageSummary, picks: ProjectPagePicks): string {
  const lens = LENS_LIBRARY[lensId];
  const lensPicks = picks[lensId] ?? {};
  const fallbackPreset = lens.presets.find(p => p.id === 'v1') ?? lens.presets[0];
  const sections = lens.slots
    .map(slot => {
      const variantId = lensPicks[slot.id] ?? fallbackPreset?.pick[slot.id];
      if (variantId === undefined) {
        console.warn(`renderProjectPages: no pick and no preset v1 fallback for ${lensId}/${slot.id} — slot skipped`);
        return null;
      }
      const variant = slot.variants.find(v => v.id === variantId);
      if (!variant) {
        console.warn(`renderProjectPages: picked variant "${variantId}" not found for ${lensId}/${slot.id} — slot skipped`);
        return null;
      }
      const Component = variant.component;
      return renderToStaticMarkup(<Component summary={summary} />);
    })
    .filter((html): html is string => html !== null);
  return sections.join('\n');
}

function htmlDocument(title: string, description: string, bodyHtml: string, fontFaces: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeHtml(description)}" />
<style>
${fontFaces}
*{box-sizing:border-box}
html,body{margin:0;padding:0;background:${PK.paper};color:${PK.ink}}
body{font-family:${PK.sans}}
</style>
</head>
<body>
${bodyHtml}
</body>
</html>`;
}

export function renderProjectPages(
  summary: ProjectPageSummary,
  picks: ProjectPagePicks,
): { home: string; marketing: string; feature: string; architecture: string } {
  const fontFaces = buildFontFaces();
  const pages = {} as { home: string; marketing: string; feature: string; architecture: string };
  for (const lensId of LENS_ORDER) {
    const lens = LENS_LIBRARY[lensId];
    const body = renderLensBody(lensId, summary, picks);
    const title = `${summary.identity.name} — ${lens.label}`;
    pages[lensId] = htmlDocument(title, summary.identity.oneLine, body, fontFaces);
  }
  return pages;
}
