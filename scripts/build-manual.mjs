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
 *   node scripts/build-manual.mjs                 # build into the default Bilko checkout
 *   node scripts/build-manual.mjs --out <dir>     # build somewhere else (CI, dry run)
 *   node scripts/build-manual.mjs --check         # verify sources only, write nothing
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync, cpSync, statSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
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
:root{--bg:#0d0d0d;--fg:#e8e8e8;--muted:#9a9a9a;--line:#2a2a2a;--accent:#5fdf9f}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.7 system-ui,-apple-system,sans-serif}
.wrap{max-width:820px;margin:0 auto;padding:48px 24px 96px}
h1{font-size:2.1em;line-height:1.2;margin:2.5em 0 .4em;border-bottom:1px solid var(--line);padding-bottom:.3em}
h1:first-child{margin-top:0}
h2{font-size:1.35em;margin:2em 0 .5em}h3{font-size:1.1em;margin:1.6em 0 .4em}
p{margin:.9em 0}.lede{font-size:1.12em;color:#cfcfcf}
code{background:#191919;padding:.15em .4em;border-radius:4px;font-size:.9em}
pre{background:#111;border:1px solid var(--line);border-radius:8px;padding:16px;overflow-x:auto}
pre code{background:none;padding:0}
.manual-table{width:100%;border-collapse:collapse;margin:1.2em 0;font-size:.94em}
.manual-table th,.manual-table td{border:1px solid var(--line);padding:10px 12px;text-align:left;vertical-align:top}
.manual-table th{background:#161616;color:#fff}
.manual-note{border-left:3px solid var(--accent);background:#131a16;padding:12px 16px;border-radius:0 6px 6px 0}
.manual-incident{border:1px solid #4a3520;background:#1a1410;border-radius:8px;padding:4px 18px;margin:1.2em 0}
.manual-steps li{margin:.5em 0}
.manual-figure{margin:1.6em 0;border:1px solid var(--line);border-radius:8px;overflow:hidden;background:#111}
.manual-figure img{display:block;width:100%}
/* An uncaptured slot is a production note, not content — the reader sees no
   figure rather than a hatched "pending capture" box. Inert once
   npm run manual:figures swaps the frame for an <img>. Mirrored in Bilko's
   src/index.css. */
.manual-figure:has(.manual-figure__frame){display:none}
.manual-figure__frame{display:none}
figcaption{padding:12px 16px;color:var(--muted);font-size:.88em;display:flex;flex-wrap:wrap;gap:14px}
.callout{display:inline-flex;align-items:center;justify-content:center;width:1.5em;height:1.5em;border-radius:50%;background:var(--accent);color:#000;font-weight:700;font-size:.8em;margin-right:.4em}
.toc{border:1px solid var(--line);border-radius:8px;padding:16px 24px;background:#111}
a{color:#7fc4ff}
`.trim();

const offlineHtml = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${src.title} — v${src.version}</title>
<style>${OFFLINE_CSS}</style></head>
<body><div class="wrap">
<h1>${src.title}</h1>
<p class="lede">${src.summary}</p>
<p style="color:#9a9a9a">Version ${src.version} · released ${src.releasedAt} · documents Session Manager v${src.documentsAppVersion}</p>
<nav class="toc"><strong>Contents</strong><ol>${
  chapterHtml.map(c => `<li><a href="#${c.slug}">${c.title}</a></li>`).join('')
}</ol></nav>
${chapterHtml.map(c => `<section id="${c.slug}">${c.html}</section>`).join('\n')}
<hr style="border:0;border-top:1px solid #2a2a2a;margin:48px 0 24px"/>
<p style="color:#666;font-size:.85em">© Bilko.run · Your copy of ${src.title}. Updates for this
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
