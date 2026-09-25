#!/usr/bin/env node
/**
 * Builds a release bundle of The Session Manager Field Manual — the $19.99
 * digital product sold at bilko.run/manual.
 *
 *   source  : session-manager-operations/manual/   (this repo — authored + reviewed here)
 *   output  : <bilko>/data/manual/releases/<version>/   (committed into the Bilko repo)
 *
 * The output directory is deliberately NOT under Bilko's `dist/`, so the static
 * file plugin can never serve a paid chapter by guessed URL — every read goes
 * through the entitlement-checked routes in server/routes/manual.ts.
 *
 * Usage:
 *   node web/manual/build.mjs                 # build into the default Bilko checkout
 *   node web/manual/build.mjs --out <dir>     # build somewhere else (CI, dry run)
 *   node web/manual/build.mjs --check         # verify sources only, write nothing
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync, cpSync, statSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SOURCE = join(REPO, 'session-manager-operations', 'manual');
const DEFAULT_BILKO = resolve(REPO, '..', 'Bilko');

const argv = process.argv.slice(2);
const checkOnly = argv.includes('--check');
const outFlag = argv.indexOf('--out');
const outRoot = outFlag >= 0 ? resolve(argv[outFlag + 1]) : join(DEFAULT_BILKO, 'data', 'manual', 'releases');

function fail(msg) {
  console.error(`✗ ${msg}`);
  process.exitCode = 1;
  throw new Error(msg);
}

// ── Read + validate the source manifest ──────────────────────────────────────

const manualJsonPath = join(SOURCE, 'manual.json');
if (!existsSync(manualJsonPath)) fail(`no manual source at ${manualJsonPath}`);
const src = JSON.parse(readFileSync(manualJsonPath, 'utf-8'));

if (!/^\d+\.\d+\.\d+$/.test(src.version ?? '')) fail(`version must be MAJOR.MINOR.PATCH, got "${src.version}"`);
if (!Array.isArray(src.chapters) || src.chapters.length === 0) fail('manual.json declares no chapters');
if (!src.chapters.some(c => c.free)) {
  // Without a free chapter the sales page has nothing to show, and the paywall
  // becomes the entire product experience for a non-buyer.
  fail('at least one chapter must be marked "free" — it is the marketing sample');
}

const slugs = new Set();
for (const c of src.chapters) {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(c.slug ?? '')) fail(`bad chapter slug: ${JSON.stringify(c.slug)}`);
  if (slugs.has(c.slug)) fail(`duplicate chapter slug: ${c.slug}`);
  slugs.add(c.slug);
  if (!existsSync(join(SOURCE, 'chapters', c.file))) fail(`chapter ${c.slug} references missing file ${c.file}`);
}

// ── Compose the offline single-file edition ──────────────────────────────────

const chapterHtml = src.chapters.map(c => ({
  ...c,
  html: readFileSync(join(SOURCE, 'chapters', c.file), 'utf-8'),
}));

const OFFLINE_CSS = `
:root{--bg:#fff;--fg:#1a1a1a;--muted:#44464b;--line:#d8dbe0;--code-bg:#f2f3f5;
--accent:#0a6e46;--accent-bg:#eaf7f0;--tip-line:#1b6fc9;--tip-bg:#eef6ff;--warn-line:#b25e09;--warn-bg:#fff4e5}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:18px/1.7 system-ui,-apple-system,"Segoe UI",sans-serif}
.wrap{max-width:68ch;margin:0 auto;padding:48px 24px 96px}
h1{font-size:2em;line-height:1.25;margin:2.2em 0 .4em;color:#000;border-bottom:1px solid var(--line);padding-bottom:.3em}
h1:first-child{margin-top:0}
h2{font-size:1.4em;margin:1.8em 0 .5em;color:#000}h3{font-size:1.15em;margin:1.5em 0 .4em;color:#000}
p{margin:.9em 0}p.lede{font-size:1.15em;color:var(--muted)}
a{color:#0a5cb8}a:hover{color:#083f80}
kbd{display:inline-block;border:1px solid var(--line);border-bottom-width:2px;border-radius:4px;background:#f7f7f8;padding:.1em .5em;font:.85em ui-monospace,SFMono-Regular,Menlo,monospace}
code{background:var(--code-bg);padding:.15em .4em;border-radius:4px;font-size:.88em;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
pre{background:var(--code-bg);border:1px solid var(--line);border-radius:8px;padding:16px;overflow-x:auto}
pre code{background:none;padding:0}
table.manual-table{width:100%;border-collapse:collapse;margin:1.4em 0;font-size:.95em}
table.manual-table th,table.manual-table td{border:1px solid var(--line);padding:10px 12px;text-align:left;vertical-align:top}
table.manual-table th{background:var(--code-bg);color:#000}
aside.manual-analogy,aside.manual-tip,aside.manual-note,aside.manual-warning{margin:1.4em 0;padding:14px 18px;border-radius:0 8px 8px 0;border-left:4px solid var(--line)}
aside.manual-analogy strong,aside.manual-tip strong,aside.manual-note strong,aside.manual-warning strong{display:block;margin-bottom:.3em}
aside.manual-analogy{border-left-color:var(--accent);background:var(--accent-bg)}
aside.manual-tip{border-left-color:var(--tip-line);background:var(--tip-bg)}
aside.manual-note{border-left-color:#8a8d93;background:#f4f4f5}
aside.manual-warning{border-left-color:var(--warn-line);background:var(--warn-bg)}
ol.manual-steps{padding-left:1.4em}ol.manual-steps li{margin:.5em 0}
ol.manual-flow{list-style:none;display:flex;flex-wrap:wrap;margin:1.6em 0;padding:0}
ol.manual-flow li{flex:1 1 0;border:1px solid var(--line);border-radius:8px;padding:14px 16px;background:#fafbfc;position:relative;min-width:140px}
ol.manual-flow li+li{margin-left:28px}
ol.manual-flow li+li::before{content:"→";position:absolute;left:-26px;top:50%;transform:translateY(-50%);font-size:1.3em;color:var(--muted)}
@media (max-width:640px){
  ol.manual-flow{flex-direction:column}
  ol.manual-flow li+li{margin-left:0;margin-top:28px}
  ol.manual-flow li+li::before{content:"↓";left:50%;top:-24px;transform:translateX(-50%)}
}
dl.manual-glossary dt{font-weight:700;margin-top:1.1em}
dl.manual-glossary dd{margin:.2em 0 0}
div.manual-takeaways{margin:2em 0;padding:16px 20px;border:1px solid var(--line);border-radius:8px;background:#f7f9fa}
div.manual-takeaways h2{margin-top:0}
p.manual-next{margin-top:2.2em;padding-top:1em;border-top:1px solid var(--line);font-weight:600}
.manual-figure{margin:1.6em 0;border:1px solid var(--line);border-radius:8px;overflow:hidden;background:#fafbfc}
.manual-figure img{display:block;width:100%}
/* An uncaptured slot is a production note, not content — the reader sees no
   figure rather than a hatched "pending capture" box. Inert once
   npm run manual:figures swaps the frame for an <img>. Mirrored in Bilko's
   src/index.css. */
.manual-figure:has(.manual-figure__frame){display:none}
.manual-figure__frame{display:none}
figcaption{padding:12px 16px;color:var(--muted);font-size:.9em;display:flex;flex-wrap:wrap;gap:14px}
nav.toc{border:1px solid var(--line);border-radius:8px;padding:16px 24px;background:#fafbfc}
nav.toc h3{margin:1em 0 .3em}nav.toc h3:first-child{margin-top:0}
nav.toc ol{margin:.3em 0 1em;padding-left:1.4em}
@media print{
  body{font-size:12pt}
  .wrap{max-width:none;padding:0}
  a{color:inherit;text-decoration:none}
  aside.manual-analogy,aside.manual-tip,aside.manual-note,aside.manual-warning,
  ol.manual-flow,div.manual-takeaways,table.manual-table{break-inside:avoid;page-break-inside:avoid}
  section{break-before:page;page-break-before:always}
}
`.trim();

// Groups TOC entries by consecutive runs of the same `part`, preserving
// manifest order; a chapter with no `part` gets its own ungrouped, headingless run.
const tocGroups = [];
for (const c of chapterHtml) {
  const last = tocGroups[tocGroups.length - 1];
  if (last && last.part === (c.part ?? null)) last.chapters.push(c);
  else tocGroups.push({ part: c.part ?? null, chapters: [c] });
}
const tocHtml = tocGroups.map(g => `${g.part ? `<h3>${g.part}</h3>` : ''}<ol>${
  g.chapters.map(c => `<li><a href="#${c.slug}">${c.title}</a></li>`).join('')
}</ol>`).join('');

const offlineHtml = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${src.title} — v${src.version}</title>
<style>${OFFLINE_CSS}</style></head>
<body><div class="wrap">
<h1>${src.title}</h1>
<p class="lede">${src.summary}</p>
<p style="color:#44464b">Version ${src.version} · released ${src.releasedAt} · documents Session Manager v${src.documentsAppVersion}</p>
<nav class="toc"><strong>Contents</strong>${tocHtml}</nav>
${chapterHtml.map(c => `<section id="${c.slug}">${c.html}</section>`).join('\n')}
<hr style="border:0;border-top:1px solid #d8dbe0;margin:48px 0 24px"/>
<p style="color:#44464b;font-size:.85em">© Bilko.run · Your copy of ${src.title}. Updates for this
edition are free — re-download the latest at bilko.run/manual.</p>
</div></body></html>`;

if (checkOnly) {
  console.log(`✓ manual v${src.version}: ${src.chapters.length} chapters, sources valid (nothing written)`);
  process.exit(0);
}

// ── Render the offline HTML through headless chromium into a PDF ─────────────
// The offline edition already inlines all of its CSS, so printing it is the
// deterministic path to a paginated PDF with no separate stylesheet to keep
// in sync. Same content in → same content out; page count/layout only moves
// if the manual's own HTML/CSS changes.
async function renderPdf(html) {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle' });
    return await page.pdf({
      format: 'Letter',
      printBackground: true,
      margin: { top: '0.6in', bottom: '0.6in', left: '0.6in', right: '0.6in' },
    });
  } finally {
    await browser.close();
  }
}

// ── Write the release bundle ─────────────────────────────────────────────────

async function main() {
  const outDir = join(outRoot, src.version);
  // Rebuild from scratch — a stale chapter left behind from a previous build of
  // the same version would ship silently.
  if (existsSync(outDir)) rmSync(outDir, { recursive: true });
  mkdirSync(outDir, { recursive: true });

  for (const c of chapterHtml) {
    writeFileSync(join(outDir, c.file), c.html, 'utf-8');
  }

  const figuresSrc = join(SOURCE, 'figures');
  if (existsSync(figuresSrc)) {
    cpSync(figuresSrc, join(outDir, 'figures'), { recursive: true });
  }

  const assets = [];
  for (const a0 of src.assets ?? []) {
    // Buyers always get the newest release, so a downloaded file whose name is
    // frozen at whatever version it was first declared under actively misleads
    // them. Declare `field-manual-{version}.pdf` and let the build fill it in.
    const a = { ...a0, file: a0.file.replaceAll('{version}', src.version) };
    if (a.id === 'offline-html') {
      writeFileSync(join(outDir, a.file), offlineHtml, 'utf-8');
    } else if (a.id === 'pdf') {
      writeFileSync(join(outDir, a.file), await renderPdf(offlineHtml));
    } else if (existsSync(join(SOURCE, 'assets', a.file))) {
      cpSync(join(SOURCE, 'assets', a.file), join(outDir, a.file));
    } else {
      // Declaring an asset the bundle doesn't contain hands buyers a broken
      // download button — refuse the build rather than ship it.
      fail(`asset "${a.id}" declares ${a.file} but no source exists at manual/assets/${a.file}`);
    }
    assets.push({
      id: a.id,
      label: a.label,
      file: a.file,
      mime: a.mime ?? 'application/octet-stream',
      bytes: statSync(join(outDir, a.file)).size,
    });
  }

  const manifest = {
    version: src.version,
    releasedAt: src.releasedAt,
    title: src.title,
    summary: src.summary,
    documentsAppVersion: src.documentsAppVersion,
    chapters: src.chapters.map(c => ({
      slug: c.slug, title: c.title, blurb: c.blurb,
      ...(c.free ? { free: true } : {}),
      ...(c.part ? { part: c.part } : {}),
      file: c.file,
      ...(c.figures ? { figures: c.figures } : {}),
    })),
    assets,
  };

  writeFileSync(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf-8');

  console.log(`✓ built manual v${src.version} → ${outDir}`);
  console.log(`  ${manifest.chapters.length} chapters (${manifest.chapters.filter(c => c.free).length} free), ${assets.length} downloadable asset(s)`);
  for (const a of assets) console.log(`  · ${a.id}: ${a.file} (${a.bytes} bytes)`);
}

main().catch(err => {
  console.error(`✗ ${err.message}`);
  process.exitCode = 1;
});
